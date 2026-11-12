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
  let tlRows = [];    // série temporelle courante (période affichée) — exports
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

  // Total au centre du donut, dessiné AU CENTRE DE L'ANNEAU (plugin Chart.js).
  // Une superposition HTML serait centrée sur tout le bloc, légende comprise :
  // le chiffre paraissait décalé dès que la légende n'était pas symétrique.
  // Les couleurs lisent les variables CSS à chaque tracé : elles suivent le
  // thème sans intervention.
  const centerTextPlugin = {
    id: 'statsCenterText',
    afterDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      if (!meta.data.length) return;
      const el = meta.data[0];
      const total = chart.data.datasets[0].data.reduce((s, v) => s + v, 0);
      const ctx = chart.ctx;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = getCss('--navy') || '#1d2233';
      ctx.font = `800 22px ${fontStack}`;
      ctx.fillText(total.toLocaleString('fr-FR'), el.x, el.y - 8);
      ctx.fillStyle = getCss('--text-soft') || '#5d6478';
      ctx.font = `500 10.5px ${fontStack}`;
      ctx.fillText('tests géolocalisés', el.x, el.y + 12);
      ctx.restore();
    },
  };

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

  // Signal (KPIs + colonnes du tableau) : « — » tant qu'aucun test ne porte
  // la valeur, avec infobulle qui explique le tiret (pas une panne côté
  // page). ISS-01 : l'API diffuse désormais rsrp/rsrq/rssi consolidés, les
  // moyennes se remplissent donc toutes seules avec les nouveaux tests.
  const SIGNAL_HINT = "L'app mesure cette valeur ; « — » tant qu'aucun test géolocalisé ne l'a transmise";

  // ── KPIs signal (RSRP / RSRQ / RSSI) ────────────────────────────────────────
  // Moyennes calculées sur les tests géolocalisés qui PORTENT la valeur
  // (l'API ne fournit pas ces moyennes dans /summary). RSRP : repli sur
  // signalDbm des tests cellulaires (l'ancienne voie de diffusion), comme
  // dans l'Historique. Sans valeur mesurée, la carte garde son « — ».
  function renderSignalKpis(points) {
    const mean = (keep) => {
      const vals = points.map(keep).filter((v) => v != null);
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    };
    const isCell = (p) => /^[2345]G\+?$/.test(String(p.networkType || '').trim());
    const rsrp = mean((p) => {
      if (p.rsrp != null) return Number(p.rsrp);
      return isCell(p) && Number(p.signalDbm) ? Number(p.signalDbm) : null;
    });
    const rsrq = mean((p) => (p.rsrq != null ? Number(p.rsrq) : null));
    const rssi = mean((p) => (p.rssi != null ? Number(p.rssi) : null));

    [['kpi-rsrp', rsrp], ['kpi-rsrq', rsrq], ['kpi-rssi', rssi]].forEach(([id, v]) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (v == null) {
        el.textContent = '—';
        el.classList.add('q-dash');
      } else {
        el.textContent = String(Math.round(v));
        el.classList.remove('q-dash');
      }
    });
  }

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

  // Un agrégat par opérateur : moyennes pondérées par test + latence.
  // (Les percentiles du débit ont été retirés du tableau ET de l'infobulle,
  // décision du 11/11.) Signal ISS-01 : moyennes des tests qui portent la
  // valeur, null si aucun — « — » à l'écran, jamais un zéro trompeur.
  function aggregateOperators(points) {
    const byOp = {};
    points.forEach((p) => {
      const a = byOp[p.operator || 'Inconnu'] = byOp[p.operator || 'Inconnu']
        || { n: 0, sDl: 0, sUl: 0, sPing: 0, rsrp: [], rsrq: [], rssi: [] };
      a.n += 1;
      a.sDl += Number(p.download) || 0;
      a.sUl += Number(p.upload) || 0;
      a.sPing += Number(p.ping) || 0;
      if (p.rsrp != null) a.rsrp.push(Number(p.rsrp));
      else if (/^[2345]G\+?$/.test(String(p.networkType || '').trim()) && Number(p.signalDbm)) a.rsrp.push(Number(p.signalDbm));
      if (p.rsrq != null) a.rsrq.push(Number(p.rsrq));
      if (p.rssi != null) a.rssi.push(Number(p.rssi));
    });
    const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
    return Object.entries(byOp).map(([operator, a]) => ({
      operator, n: a.n,
      avgDl: a.sDl / a.n, avgUl: a.sUl / a.n, avgPing: a.sPing / a.n,
      avgRsrp: mean(a.rsrp), avgRsrq: mean(a.rsrq), avgRssi: mean(a.rssi),
    })).sort((x, y) => y.avgDl - x.avgDl);
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
      tlRows = data;
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
                // Latence du groupe (les percentiles ne sont plus affichés,
                // décision du 11/11 : ni tableau ni infobulle).
                footer: (items) => {
                  const o = opsData[items[0].dataIndex];
                  return o ? [`Latence moyenne : ${Math.round(o.avgPing)} ms`] : '';
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
      if (networkChart) networkChart.destroy();
      networkChart = new Chart(document.getElementById('chart-network'), {
        type: 'doughnut',
        plugins: [centerTextPlugin],
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
                  const grand = netsData.reduce((s, x) => s + x.n, 0);
                  const share = grand ? Math.round((t.n / grand) * 100) : 0;
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
      // useFinalPosition = true : même pendant l'animation d'apparition (ou
      // si elle est gelée par un onglet en arrière-plan), le clic atteint la
      // tranche à sa position finale.
      const cv = document.getElementById('chart-network');
      cv.onclick = (evt) => {
        if (!networkChart) return;
        const els = networkChart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, true);
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

  // Tableau avancé (A) : moyennes par opérateur, colonnes signal réelles
  // (ISS-01) avec repli « — » ; percentiles volontairement absents (11/11).
  function renderAdvanced(points) {
    const tbody = document.querySelector('#advanced-table tbody');
    try {
      if (!opsData.length) opsData = aggregateOperators(points);
      if (!opsData.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="color:var(--text-soft)">Aucune donnée disponible.</td></tr>';
        return;
      }
      tbody.innerHTML = opsData.map((o) => {
        const sig = (v) => v == null
          ? `<span class="q-dash" title="${SIGNAL_HINT}">—</span>`
          : `<span title="Moyenne des tests qui portent la valeur">${Math.round(v)}</span>`;
        return `
        <tr>
          <td><span class="op-dot" style="background:${operatorColor(o.operator)}"></span>
              <b style="color:var(--navy)">${escapeHtml(o.operator)}</b></td>
          <td class="num">${o.n.toLocaleString('fr-FR')}</td>
          <td class="num"><b>${fmt1(o.avgDl)}</b></td>
          <td class="num">${fmt1(o.avgUl)}</td>
          <td class="num">${sig(o.avgRsrp)}</td>
          <td class="num">${sig(o.avgRsrq)}</td>
          <td class="num">${sig(o.avgRssi)}</td>
          <td class="num">${Math.round(o.avgPing)} ms</td>
        </tr>`;
      }).join('');
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
    renderSignalKpis(points);
    renderAdvanced(points);
  }

  /// Oblige la vue à tout recalculer au prochain affichage. Les graphiques
  /// existants sont détruits par les loaders avant d'être reconstruits.
  function reset() {
    built = false;
  }

  // ── Exports CSV / XLSX / PNG (validé 11/11 : un jeu par bloc) ───────────────
  // Les mécaniques sont celles du Comparatif : CSV BOM + point-virgule,
  // XLSX = zip de XML écrit à la main, PNG = tableau redessiné en 2x.
  // Chaque bloc exporte SES données, dans la période/vue affichée.

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Archive ZIP minimale (entrées stockées, CRC32, répertoire central, EOCD) :
  // un .xlsx est un zip de XML — pas besoin de librairie.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zipStore(entries) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const [name, content] of entries) {
      const nameBytes = enc.encode(name);
      const data = enc.encode(content);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true);
      local.setUint16(10, 0, true);
      local.setUint16(12, 0, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), nameBytes, data);
      central.push({ nameBytes, crc, size: data.length, offset });
      offset += 30 + nameBytes.length + data.length;
    }
    const centralStart = offset;
    let centralSize = 0;
    for (const e of central) {
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint32(16, e.crc, true);
      cd.setUint32(20, e.size, true);
      cd.setUint32(24, e.size, true);
      cd.setUint16(28, e.nameBytes.length, true);
      cd.setUint32(42, e.offset, true);
      chunks.push(new Uint8Array(cd.buffer), e.nameBytes);
      centralSize += 46 + e.nameBytes.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, central.length, true);
    end.setUint16(10, central.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, centralStart, true);
    chunks.push(new Uint8Array(end.buffer));
    return new Blob(chunks, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // Tableau redessiné sur canvas (2x pour la netteté), comme une capture de
  // rapport — même rendu que l'export PNG du Comparatif.
  function pngBlob(title, cols, lines) {
    const S = 2;
    const colW = 150;
    const W = 40 + cols.length * colW;
    const rowH = 30, headH = 40, titleH = 54;
    const H = titleH + headH + Math.max(lines.length, 1) * rowH + 24;
    const cv = document.createElement('canvas');
    cv.width = W * S;
    cv.height = H * S;
    const cx = cv.getContext('2d');
    cx.scale(S, S);
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, W, H);
    cx.fillStyle = '#1d2233';
    cx.font = 'bold 18px "Segoe UI", sans-serif';
    cx.fillText(`${title} — ${new Date().toLocaleDateString('fr-FR')}`, 20, 34);
    cx.fillStyle = '#f4f6f8';
    cx.fillRect(0, titleH, W, headH);
    cx.fillStyle = '#5d6478';
    cx.font = 'bold 11px "Segoe UI", sans-serif';
    cols.forEach((c, i) => cx.fillText(c.toUpperCase(), 20 + i * colW, titleH + 25));
    cx.strokeStyle = '#dfe3ea';
    cx.beginPath();
    cx.moveTo(0, titleH + headH);
    cx.lineTo(W, titleH + headH);
    cx.stroke();
    cx.font = '12px "Segoe UI", sans-serif';
    lines.forEach((r, ri) => {
      const y = titleH + headH + ri * rowH;
      if (ri % 2) { cx.fillStyle = '#fafbfd'; cx.fillRect(0, y, W, rowH); }
      cx.fillStyle = '#2a3042';
      r.forEach((v, i) => {
        const text = v == null ? '—'
          : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ','))
          : String(v);
        cx.fillText(text.slice(0, 24), 20 + i * colW, y + 19);
      });
    });
    return new Promise((resolve) => cv.toBlob((b) => resolve(b), 'image/png'));
  }

  // Jeu de données de chaque bloc, tel qu'affiché à l'écran (null = vide).
  function blockDataset(block) {
    if (block === 'evolution') {
      return tlRows.length
        ? { cols: ['Date', 'Tests', 'Débit moyen (Mb/s)'], rows: tlRows.map((p) => [p.date, p.count, p.avgDownload]) }
        : null;
    }
    if (block === 'operateurs') {
      return opsData.length
        ? { cols: ['Opérateur', 'Tests', 'Download moyen (Mb/s)', 'Envoi moyen (Mb/s)', 'Latence moyenne (ms)'],
            rows: opsData.map((o) => [o.operator, o.n, o.avgDl, o.avgUl, Math.round(o.avgPing)]) }
        : null;
    }
    if (block === 'technologies') {
      const grand = netsData.reduce((s, t) => s + t.n, 0);
      return grand
        ? { cols: ['Technologie', 'Tests', 'Part (%)', 'Débit moyen (Mb/s)'],
            rows: netsData.map((t) => [t.name, t.n, Math.round((t.n / grand) * 100), t.avgDl]) }
        : null;
    }
    if (block === 'avance') {
      // Signal réel (ISS-01) ; null = aucun test ne porte la valeur, exporté
      // « — » comme à l'écran.
      return opsData.length
        ? { cols: ['Mobiles / FAI', 'Tests', 'Download moyen (Mb/s)', 'Envoi moyen (Mb/s)', 'RSRP moyen (dBm)', 'RSRQ moyen (dB)', 'RSSI moyen (dBm)', 'Latence moyenne (ms)'],
            rows: opsData.map((o) => [o.operator, o.n, o.avgDl, o.avgUl, o.avgRsrp, o.avgRsrq, o.avgRssi, Math.round(o.avgPing)]) }
        : null;
    }
    return null;
  }

  const BLOCK_LABELS = {
    evolution: 'Évolution des tests', operateurs: 'Débit par opérateur',
    technologies: 'Répartition par technologie', avance: 'Statistiques avancées',
  };

  function exportFileNames(block, ext) {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `statistiques-${block}-${day}.${ext}`;
  }

  async function exportBlock(block, format) {
    const ds = blockDataset(block);
    if (!ds) { App.toast('Aucune donnée à exporter pour ce bloc.'); return; }
    const fmt = (v) => v == null ? '—'
      : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ','))
      : String(v);
    if (format === 'csv') {
      // BOM UTF-8 + point-virgule : s'ouvre proprement dans Excel FR/LibreOffice.
      const csv = '\uFEFF' + [ds.cols.join(';')]
        .concat(ds.rows.map((r) => r.map(fmt).join(';')))
        .join('\r\n');
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), exportFileNames(block, 'csv'));
    } else if (format === 'xlsx') {
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const cell = (v, r, c) => {
        if (v == null) return `<c r="${r}${c}" t="inlineStr"><is><t>—</t></is></c>`;
        if (typeof v === 'number') return `<c r="${r}${c}" t="n"><v>${v}</v></c>`;
        return `<c r="${r}${c}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      };
      const sheetRows = [ds.cols.map((c, i) => cell(c, 1, i + 1)).join('')]
        .concat(ds.rows.map((r, ri) => r.map((v, i) => cell(v, ri + 2, i + 1)).join('')))
        .map((cells, ri) => `<row r="${ri + 1}">${cells}</row>`).join('');
      const parts = [
        ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          + '<Default Extension="xml" ContentType="application/xml"/>'
          + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
          + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
          + '</Types>'],
        ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
          + '</Relationships>'],
        ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
          + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
          + `<sheets><sheet name="Statistiques" sheetId="1" r:id="rId1"/></sheets></workbook>`],
        ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
          + '</Relationships>'],
        ['xl/worksheets/sheet1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`],
      ];
      downloadBlob(zipStore(parts), exportFileNames(block, 'xlsx'));
    } else {
      const blob = await pngBlob(`Yélé — Statistiques — ${BLOCK_LABELS[block]}`, ds.cols, ds.rows);
      if (blob) downloadBlob(blob, exportFileNames(block, 'png'));
    }
    App.toast(`${ds.rows.length.toLocaleString('fr-FR')} ligne${ds.rows.length > 1 ? 's' : ''} exportée${ds.rows.length > 1 ? 's' : ''} (CSV · XLSX · PNG).`);
  }

  // Les boutons d'export sont dans le HTML statique : liaison unique.
  [['evolution', 'st-tl'], ['operateurs', 'st-ops'], ['technologies', 'st-net'], ['avance', 'st-adv']]
    .forEach(([block, prefix]) => {
      ['csv', 'xlsx', 'png'].forEach((fmt) => {
        const btn = document.getElementById(`${prefix}-export-${fmt}`);
        if (btn) btn.addEventListener('click', () => exportBlock(block, fmt));
      });
    });
  return { show, reset };
})();
