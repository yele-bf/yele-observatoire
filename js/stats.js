// ─── Vue Statistiques : KPIs, graphiques, tableau avancé ─────────────────────
// Refonte validée (croquis v2, 11/11/2026) :
//   A - Normalisation ARCEP + fusion ONATEL→Moov Africa SA : TOUTES les
//       agrégations (graphe opérateurs, donut, tableau avancé) sont recalculées
//       côté client depuis les points normalisés de la carte, plutôt que
//       d'afficher les noms bruts renvoyés par /operators et /stats/advanced
//       (où « ONATEL (Office National…, PTT) » doublonnait Moov Africa SA).
//       Moyennes pondérées par test ; percentiles sur les débits bruts,
//       méthode « lower » (pos = q*(n-1), idx = plancher) — identique au
//       backend, vérifiée chiffre à chiffre.
//   B - Dates de l'axe temporel en français (« 7 nov. », pas « 2026-11-07 »).
//   C - Nombre de tests dans les libellés du graphe opérateurs.
//   D - Pastilles qualité sur les KPIs (mêmes seuils que le Comparatif).
//   E - État d'erreur PAR BLOC : « Données indisponibles · Réessayer » au lieu
//       d'un bloc muet quand le serveur dort.
//   F - Bordure du donut suit le thème (fond de la carte, pas blanc dur).
// KPIs étendus à 8 cartes : RSRP/RSRQ (base 4G/5G) et RSSI (base WiFi)
// affichés « — » tant que l'API ne diffuse pas le signal — l'infobulle
// l'explique, ce n'est pas une panne.
// Percentiles du débit : RETIRÉS du tableau (décision utilisateur), gardés
// dans l'infobulle du graphe opérateurs.
// Clic sur une tranche du donut → ouvre le Comparatif filtré sur la techno.

const Stats = (() => {
  let built = false;
  let timelineChart = null;
  let operatorsChart = null;
  let networkChart = null;
  let tlDays = 30;
  let opsData = [];   // agrégat par opérateur (graphe + tableau)
  let netsData = [];  // agrégat par technologie (donut + clic)

  // Copie du HTML initial des blocs (capturée au premier show) : un état
  // d'erreur remplace le contenu d'un bloc ; « Réessayer » le reconstruit.
  let baseline = null;

  const fontStack = "'Inter', system-ui, sans-serif";

  // Couleurs des graphiques dépendant du thème : le texte des axes suit la
  // variable CSS, les séries (données) gardent leurs couleurs propres.
  // Appelé avant chaque construction de graphe et à chaque bascule de thème.
  function themeChartDefaults() {
    Chart.defaults.font.family = fontStack;
    Chart.defaults.color = getCss('--text-soft') || '#5d6478';
  }

  // Bordure du donut (F) : la couleur du FOND DE LA CARTE qui l'entoure, pas
  // du blanc absolu — en thème sombre, un liseré blanc criait sur le fond.
  function donutBorderColor() {
    return getCss('--white') || '#ffffff';
  }

  // Rebuild des graphiques déjà construits quand le thème change (l'objet
  // Chart ne relit pas Chart.defaults après construction).
  document.addEventListener('yele-theme', () => {
    if (!built) return;
    themeChartDefaults();
    if (timelineChart) timelineChart.update();
    if (operatorsChart) operatorsChart.update();
    if (networkChart) {
      networkChart.data.datasets[0].borderColor = donutBorderColor();
      networkChart.update();
    }
  });

  // ── Formatage ──────────────────────────────────────────────────────────────

  // Nombre à 1 décimale, à la française (« 22,1 »).
  const fmt1 = (v) => (Math.round(v * 10) / 10).toLocaleString('fr-FR', { maximumFractionDigits: 1 });

  // « 2026-11-07 » → « 7 nov. » (axe) et « ven. 7 novembre » (infobulle).
  function frDayLabel(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y || !m || !d) return String(iso);
    return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }
  function frDayLong(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y || !m || !d) return String(iso);
    return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long' });
  }

  // ── Pastilles qualité (D) : seuils identiques au Comparatif ────────────────
  const dlLevel = (v) => (v >= 10 ? 3 : v >= 5 ? 2 : 1);
  const ulLevel = (v) => (v >= 5 ? 3 : v >= 1.5 ? 2 : 1);
  const pingLevel = (v) => (v <= 80 ? 3 : v <= 200 ? 2 : 1);
  const WORDS = { 3: 'Bon', 2: 'Moyen', 1: 'Dégradé' };

  function setPill(id, level) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = WORDS[level];
    el.className = `qv ${level >= 3 ? 'q-good' : level === 2 ? 'q-mid' : 'q-bad'}`;
    el.hidden = false;
  }

  // Signal non diffusé (KPIs + colonnes du tableau) : « — » assumé avec
  // infobulle, comme sur le Comparatif. Le texte est répliqué ici plutôt
  // qu'importé : quality.js est partagé, ces libellés sont propres à la vue.
  const SIGNAL_HINT = "Mesuré par l'app, pas encore diffusé par l'API (extension serveur à venir) - bientôt affiché ici";

  // ── Agrégation depuis les points normalisés (A) ────────────────────────────

  // Points de la carte déjà normalisés (MapView nettoie operator/networkType
  // pour toutes ses vues) ; repli : fetch + normalisation ici (lien profond).
  async function loadPoints() {
    let points = (typeof MapView !== 'undefined' && MapView.getPoints) ? MapView.getPoints() : [];
    if (!points.length) {
      points = (await API.mapPoints() || []).map((p) => ({
        ...p,
        operator: normalizeOperator(p.operator),
        networkType: normalizeNetwork(p.networkType),
      }));
    }
    return points;
  }

  // Percentile méthode « lower », identique au backend (vérifié 11/11).
  function pct(sorted, q) {
    if (!sorted.length) return 0;
    return sorted[Math.min(Math.floor(q * (sorted.length - 1)), sorted.length - 1)];
  }

  // Un agrégat par opérateur : moyennes pondérées + percentiles du débit ↓
  // (infobulle uniquement) + latence.
  function aggregateOperators(points) {
    const byOp = {};
    points.forEach((p) => {
      const a = byOp[p.operator || 'Inconnu'] = byOp[p.operator || 'Inconnu']
        || { n: 0, sDl: 0, sUl: 0, sPing: 0, dls: [] };
      a.n += 1;
      a.sDl += Number(p.download) || 0;
      a.sUl += Number(p.upload) || 0;
      a.sPing += Number(p.ping) || 0;
      a.dls.push(Number(p.download) || 0);
    });
    return Object.entries(byOp).map(([operator, a]) => {
      a.dls.sort((x, y) => x - y);
      return {
        operator, n: a.n,
        avgDl: a.sDl / a.n, avgUl: a.sUl / a.n, avgPing: a.sPing / a.n,
        p25: pct(a.dls, .25), p50: pct(a.dls, .5), p75: pct(a.dls, .75), p90: pct(a.dls, .9),
      };
    }).sort((x, y) => y.avgDl - x.avgDl);
  }

  // Un agrégat par technologie : effectif, part, débit moyen (donut).
  function aggregateNetworks(points) {
    const byNet = {};
    points.forEach((p) => {
      const a = byNet[p.networkType || 'Non précisé'] = byNet[p.networkType || 'Non précisé']
        || { n: 0, sDl: 0 };
      a.n += 1;
      a.sDl += Number(p.download) || 0;
    });
    return Object.entries(byNet)
      .map(([name, a]) => ({ name, n: a.n, avgDl: a.sDl / a.n }))
      .sort((x, y) => y.n - x.n);
  }

  // ── Chargements par bloc (chaque bloc gère SA panne, E) ─────────────────────

  async function loadSummary() {
    try {
      const s = await API.summary();
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('kpi-total', (s.totalTests ?? 0).toLocaleString('fr-FR'));
      set('kpi-today', (s.testsToday ?? 0).toLocaleString('fr-FR'));
      set('kpi-dl', fmt1(s.avgDownload ?? 0));
      set('kpi-ul', fmt1(s.avgUpload ?? 0));
      set('kpi-ping', String(Math.round(s.avgPing ?? 0)));
      setPill('kpi-dl-pill', dlLevel(s.avgDownload ?? 0));
      setPill('kpi-ul-pill', ulLevel(s.avgUpload ?? 0));
      setPill('kpi-ping-pill', pingLevel(s.avgPing ?? 0));
    } catch (e) {
      blockError('kpi-grid', e.message);
    }
  }

  async function loadTimeline(days) {
    const wrap = document.getElementById('tl-wrap');
    try {
      const data = (await API.timeline(days)) || [];
      if (timelineChart) timelineChart.destroy();
      timelineChart = new Chart(document.getElementById('chart-timeline'), {
        data: {
          // Libellés ISO (utiles pour trier/comparer) ; l'axe et l'infobulle
          // les traduisent en français (B).
          labels: data.map((p) => p.date),
          datasets: [
            {
              type: 'bar', label: 'Nombre de tests',
              data: data.map((p) => p.count),
              backgroundColor: 'rgba(14, 122, 74, .25)',
              borderRadius: 4, yAxisID: 'y',
            },
            {
              type: 'line', label: 'Débit ↓ moyen',
              data: data.map((p) => p.avgDownload),
              borderColor: '#0e7a4a', backgroundColor: '#0e7a4a',
              tension: .35, pointRadius: 2, yAxisID: 'y1',
            },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: { ticks: { callback(value) { return frDayLabel(this.getLabelForValue(value)); } } },
            y: { position: 'left', title: { display: true, text: 'Tests' }, beginAtZero: true },
            y1: { position: 'right', title: { display: true, text: 'Mbps' }, grid: { drawOnChartArea: false }, beginAtZero: true },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => frDayLong(items[0].label),
                label: (item) => item.datasetIndex === 0
                  ? `Tests : ${item.parsed.y.toLocaleString('fr-FR')}`
                  : `Débit ↓ moyen : ${fmt1(item.parsed.y)} Mb/s`,
              },
            },
          },
        },
      });
    } catch (e) {
      if (timelineChart) { timelineChart.destroy(); timelineChart = null; }
      blockError('tl-wrap', e.message);
    }
  }

  // Graphe opérateurs (A + C + percentiles en infobulle).
  async function loadOperatorsChart(points) {
    const wrap = document.getElementById('ops-wrap');
    try {
      opsData = aggregateOperators(points);
      if (operatorsChart) operatorsChart.destroy();
      operatorsChart = new Chart(document.getElementById('chart-operators'), {
        type: 'bar',
        data: {
          labels: opsData.map((o) => `${o.operator} (${o.n} test${o.n > 1 ? 's' : ''})`),
          datasets: [
            { label: 'Download moyen', data: opsData.map((o) => o.avgDl), backgroundColor: opsData.map((o) => operatorColor(o.operator)), borderRadius: 5 },
            { label: 'Envoi moyen', data: opsData.map((o) => o.avgUl), backgroundColor: 'rgba(28,28,60,.30)', borderRadius: 5 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          scales: { y: { beginAtZero: true, title: { display: true, text: 'Mb/s' } } },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => items[0].label,
                label: (item) => item.datasetIndex === 0
                  ? `Download moyen : ${fmt1(item.parsed.y)} Mb/s`
                  : `Envoi moyen : ${fmt1(item.parsed.y)} Mb/s`,
                // Latence + percentiles du débit ↓ (gardés sous le coude,
                // décision 11/11 : le tableau ne les affiche plus).
                footer: (items) => {
                  const o = opsData[items[0].dataIndex];
                  if (!o) return '';
                  return [
                    `Latence moyenne : ${Math.round(o.avgPing)} ms`,
                    '',
                    `Débit ↓ — P25 : ${fmt1(o.p25)} · Médiane : ${fmt1(o.p50)}`,
                    `P75 : ${fmt1(o.p75)} · P90 : ${fmt1(o.p90)} Mb/s`,
                  ];
                },
              },
            },
          },
        },
      });
    } catch (e) {
      if (operatorsChart) { operatorsChart.destroy(); operatorsChart = null; }
      blockError('ops-wrap', e.message);
    }
  }

  // Donut technologie (A + F + infobulle + clic → Comparatif filtré).
  async function loadNetworkChart(points) {
    const wrap = document.getElementById('net-wrap');
    try {
      netsData = aggregateNetworks(points);
      const total = points.length;
      const center = document.getElementById('net-total');
      if (center) center.textContent = total.toLocaleString('fr-FR');
      if (networkChart) networkChart.destroy();
      networkChart = new Chart(document.getElementById('chart-network'), {
        type: 'doughnut',
        data: {
          labels: netsData.map((t) => t.name),
          datasets: [{
            data: netsData.map((t) => t.n),
            backgroundColor: netsData.map((t) => networkColor(t.name)),
            borderWidth: 2, borderColor: donutBorderColor(), // F : suit le thème
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '62%',
          // Curseur main au survol des tranches (indice du clic-filtre).
          onHover: (evt, els) => {
            if (evt.native) evt.native.target.style.cursor = els.length ? 'pointer' : 'default';
          },
          plugins: {
            legend: { position: 'right' },
            tooltip: {
              callbacks: {
                title: (items) => netsData[items[0].dataIndex]?.name || '',
                label: (item) => {
                  const t = netsData[item.dataIndex];
                  const share = total ? Math.round((t.n / total) * 100) : 0;
                  return `Tests : ${t.n.toLocaleString('fr-FR')} (${share} %)`;
                },
                afterBody: (items) => {
                  const t = netsData[items[0].dataIndex];
                  return t ? ['', `Débit ↓ moyen : ${fmt1(t.avgDl)} Mb/s`, 'Clic : Comparatif filtré sur cette techno'] : [];
                },
              },
            },
          },
        },
      });
      // Clic sur une tranche : écouteur natif sur le canvas (l'option onClick
      // de Chart.js 4 ne reçoit pas fiablement les clics ; le mode « nearest »
      // interroge le graphe quel que soit l'origine de l'événement).
      const cv = document.getElementById('chart-network');
      cv.onclick = (evt) => {
        if (!networkChart) return;
        const els = networkChart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, false);
        if (els.length) openComparatif(netsData[els[0].index]);
      };
    } catch (e) {
      if (networkChart) { networkChart.destroy(); networkChart = null; }
      blockError('net-wrap', e.message);
    }
  }

  // Clic sur une tranche → le Comparatif s'ouvre pré-filtré : les filtres
  // mémorisés (MEM_KEY lu par Operators.restoreState) sont posés ici, puis la
  // vue est réinitialisée pour qu'elle les relise. WiFi → réseau Fixe ; les
  // technologies cellulaires → Mobile + chip techno ; le reste (« Non
  // précisé ») → Mobile sans chip, pour ne pas mener dans une impasse.
  function openComparatif(t) {
    if (!t || typeof Operators === 'undefined') return;
    const cellular = /^[2345]G$/.test(t.name);
    const netType = t.name === 'WiFi' ? 'fixe' : 'mobile';
    try {
      localStorage.setItem('yele-comparatif-filtres', JSON.stringify({
        netType, operator: '__all__', tech: cellular ? t.name : '',
        period: { grain: 'all', values: {} },
      }));
    } catch (e) { /* stockage indisponible : le filtre ne sera pas posé */ }
    Operators.reset();
    App.switchView('operators');
    App.toast(`Comparatif filtré sur ${t.name === 'WiFi' ? 'le Fixe (WiFi)' : t.name}`);
  }

  // Tableau avancé (A) : moyennes par opérateur, colonnes signal « — » tant
  // que l'API ne diffuse pas ; percentiles volontairement absents (11/11).
  function renderAdvanced(points) {
    const tbody = document.querySelector('#advanced-table tbody');
    try {
      if (!opsData.length) opsData = aggregateOperators(points);
      if (!opsData.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="color:var(--text-soft)">Aucune donnée disponible.</td></tr>';
        return;
      }
      tbody.innerHTML = opsData.map((o) => `
        <tr>
          <td><span class="op-dot" style="background:${operatorColor(o.operator)}"></span>
              <b style="color:var(--navy)">${escapeHtml(o.operator)}</b></td>
          <td class="num">${o.n.toLocaleString('fr-FR')}</td>
          <td class="num"><b>${fmt1(o.avgDl)}</b></td>
          <td class="num">${fmt1(o.avgUl)}</td>
          <td class="num"><span class="q-dash" title="${SIGNAL_HINT}">—</span></td>
          <td class="num"><span class="q-dash" title="${SIGNAL_HINT}">—</span></td>
          <td class="num"><span class="q-dash" title="${SIGNAL_HINT}">—</span></td>
          <td class="num">${Math.round(o.avgPing)} ms</td>
        </tr>`).join('');
    } catch (e) {
      tbody.innerHTML = '';
      blockError('adv-body', e.message);
    }
  }

  // ── États d'erreur par bloc (E) ─────────────────────────────────────────────

  // Remplace le contenu d'un bloc par « Données indisponibles · Réessayer ».
  // `adv-body` est un tbody : le message s'insère en ligne du tableau.
  function blockError(blockId, msg) {
    const box = (text) => `
      <div class="stats-err">Données indisponibles
        <small>${escapeHtml(text || '')}</small>
        <button type="button" class="stats-retry">Réessayer</button></div>`;
    if (blockId === 'adv-body') {
      document.querySelector('#advanced-table tbody').innerHTML =
        `<tr><td colspan="8">${box(msg)}</td></tr>`;
    } else {
      const el = document.getElementById(blockId);
      if (el) el.innerHTML = box(msg);
    }
    document.querySelectorAll('.stats-retry').forEach((b) =>
      b.addEventListener('click', () => rebuild()));
  }

  // Reconstruit tout après une erreur : les blocs reprennent leur HTML initial
  // (capturé au premier affichage) avant de repartir du serveur. reset() remet
  // le drapeau built à faux, sinon switchView('stats') repartirait prématurément.
  function rebuild() {
    if (!baseline) return;
    [
      ['kpi-grid', 'kpi-grid'],
      ['tl-wrap', 'tl-wrap'],
      ['ops-wrap', 'ops-wrap'],
      ['net-wrap', 'net-wrap'],
      ['adv-body', 'advanced-table'],
    ].forEach(([key, id]) => {
      if (key === 'adv-body') {
        document.querySelector('#advanced-table tbody').innerHTML = baseline[key];
      } else if (baseline[key] != null) {
        document.getElementById(id).innerHTML = baseline[key];
      }
    });
    reset();
    App.switchView('stats');
  }

  let togglesBound = false;
  function bindTimelineToggle() {
    // Les boutons de période vivent dans le HTML statique (hors des blocs
    // reconstruits) : on ne les lie qu'une fois, sinon chaque reconstruction
    // empilerait un écouteur de plus (appelé aussi à chaque show après reset).
    if (togglesBound) return;
    togglesBound = true;
    document.querySelectorAll('#timeline-days .toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#timeline-days .toggle').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        tlDays = parseInt(btn.dataset.days, 10);
        loadTimeline(tlDays);
      });
    });
  }

  async function show() {
    if (built) return;
    built = true;
    themeChartDefaults();

    // Copie du HTML initial des blocs, pour la sortie d'état d'erreur.
    if (!baseline) {
      baseline = {
        'kpi-grid': document.getElementById('kpi-grid')?.innerHTML || '',
        'tl-wrap': document.getElementById('tl-wrap')?.innerHTML || '',
        'ops-wrap': document.getElementById('ops-wrap')?.innerHTML || '',
        'net-wrap': document.getElementById('net-wrap')?.innerHTML || '',
        'adv-body': document.querySelector('#advanced-table tbody')?.innerHTML || '',
      };
    }

    loadSummary();
    loadTimeline(tlDays);
    bindTimelineToggle();

    // Un seul fetch de points nourrit trois blocs ; une panne le marque
    // distinctement sur chacun (E), les KPIs et l'évolution restent lisibles.
    let points = [];
    try {
      points = await loadPoints();
    } catch (e) {
      blockError('ops-wrap', e.message);
      blockError('net-wrap', e.message);
      blockError('adv-body', e.message);
      return;
    }
    await Promise.allSettled([
      loadOperatorsChart(points),
      loadNetworkChart(points),
    ]);
    renderAdvanced(points);
  }

  /// Oblige la vue à tout recalculer au prochain affichage. Les graphiques
  /// existants sont détruits par les loaders avant d'être reconstruits.
  function reset() {
    built = false;
  }
  return { show, reset };
})();
