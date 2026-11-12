// ─── Vue Historique : tous les tests remontés, filtres à la Comparatif ──────
// Refonte validée par croquis le 11/11/2026 :
//   - Filtres identiques au Comparatif : réseau Mobile/Fixe (interrupteurs),
//     fournisseur dynamique par réseau, chips techno (mobile seulement),
//     période grain + valeur + badges cumulables (cascade des grains) ;
//   - Colonnes dédiées : Mobile = Date · Mobile · Technologie · RSRP · RSRQ ·
//     ↓ Moyen · ↑ Moyen · Latence · Jitter · Streaming · Nav. web · Appareil ·
//     Lieu · Qualité ; Fixe = Date · Fixe · RSSI · ↓ · ↑ · Latence · Jitter ·
//     Streaming · Nav. web · Appareil · Lieu · Qualité ;
//   - Les filtres s'appliquent CÔTÉ CLIENT sur tous les tests (/results),
//     triés par date décroissante, 20 par page (« Afficher plus ») ;
//   - Exports CSV / XLSX / PNG de la vue filtrée (machinerie des Statistiques) ;
//   - « Lieu » cliquable : renvoie à la mesure sur la carte (IMP-07).
// RSRP (mobile) et RSRQ/RSSI (ISS-01) sont diffusés par l'API : la valeur
// s'affiche dès qu'un test la porte, « — » avec infobulle sinon.

const History = (() => {
  const PAGE_STEP = 20;

  let built = false;      // données chargées au moins une fois
  let bound = false;      // écouteurs posés (éléments statiques : une seule fois)
  let all = [];           // tous les tests, normalisés
  let shown = PAGE_STEP;  // nombre de lignes affichées

  const state = {
    netType: 'mobile',    // mobile | fixe
    supplier: '__all__',  // '__all__' = tous les fournisseurs
    tech: '',             // '' = toutes (chips, mobile seulement)
    period: { grain: 'all', values: {} },  // grain -> [valeurs] (cumulables)
  };

  // Cascade des grains : poser un filtre grossier purge les grains plus fins
  // (choisir 2025 ne peut pas laisser un mois de 2024 actif). Identique à la
  // carte (map.js) et au Comparatif (operators.js).
  const CHILDREN = {
    year: ['month', 'week', 'day', 'hour'],
    month: ['week', 'day', 'hour'],
    week: ['day', 'hour'],
    day: ['hour'],
    hour: [],
  };

  // ── Normalisation des tests ────────────────────────────────────────────────
  // Réplique locale de isCellularTest (map.js, operators.js) : Mobile = tests
  // cellulaires (2G à 5G), Fixe = le reste (WiFi…).
  function isCellularTest(p) {
    return /^[2345]G\+?$/.test(String(p.networkType || '').trim());
  }

  // Chaque test est normalisé UNE fois au chargement : la vue filtre et
  // affiche ensuite des champs prêts à l'emploi.
  function normalizeRow(r) {
    const d = parseTs(r.timestamp);
    // RSRP : l'app le mesure déjà (signalDbm des tests 4G/5G) ; l'API
    // renverra son propre champ `rsrp` dès l'extension serveur — on le
    // préfère alors. Un 0WiFi signifie « non applicable », pas « nul ».
    const rsrp = r.rsrp != null ? r.rsrp
      : (isCellularTest(r) && Number(r.signalDbm) ? Number(r.signalDbm) : null);
    return {
      op: normalizeOperator(r.operator) || 'Inconnu',
      tech: normalizeNetwork(r.networkType),
      isCell: isCellularTest(r),
      ts: r.timestamp || '',
      date: isNaN(d) ? null : d,
      dl: Number(r.download),
      ul: Number(r.upload),
      ping: Number(r.ping),
      jitter: Number(r.jitter),
      str: Number(r.streamingScore) || 0,
      nav: Number(r.browsingScore) || Number(r.browsingSuccessRate) || 0,
      rsrp,
      rsrq: r.rsrq != null ? r.rsrq : null,
      rssi: r.rssi != null ? r.rssi : null,
      device: r.deviceModel || '',
      location: r.location || r.city || '',
      lat: Number(r.latitude) || null,
      lng: Number(r.longitude) || null,
      qoe: Number(r.qoeRating) || 0,
    };
  }

  // ── Chargement ─────────────────────────────────────────────────────────────

  async function show() {
    if (!bound) { bound = true; bind(); }
    if (built) return;
    built = true;
    await load();
  }

  // Récupère TOUS les tests (pages de 500) : les filtres s'appliquent ensuite
  // côté client, comme sur la carte et le Comparatif.
  async function fetchAll() {
    const pageSize = 500;
    const rows = [];
    let page = 1;
    let total = Infinity;
    while (rows.length < total) {
      const res = await API.results({ page, limit: pageSize });
      total = res.total || 0;
      const batch = res.data || [];
      if (!batch.length) break; // garde-fou : évite une boucle sans fin
      rows.push(...batch.map(normalizeRow));
      page++;
    }
    return rows;
  }

  async function load() {
    const tbody = document.querySelector('#history-table tbody');
    tbody.innerHTML = `<tr><td colspan="${cols().length}" class="op-empty">Chargement…</td></tr>`;
    try {
      all = await fetchAll();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="${cols().length}" class="op-empty">Erreur : ${escapeHtml(e.message)}</td></tr>`;
      return;
    }
    refresh();
  }

  // ── Filtres ────────────────────────────────────────────────────────────────

  // Valeur d'un test pour un grain de période donné (null si date invalide).
  function grainValue(r, grain) {
    if (!r.date) return null;
    const d = r.date;
    if (grain === 'hour') return d.getHours();
    if (grain === 'day') return dayKey(d);
    if (grain === 'week') return weekStartKey(d);
    if (grain === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (grain === 'year') return String(d.getFullYear());
    return null;
  }

  function grainValueLabel(grain, value) {
    if (grain === 'hour') return `${value} h`;
    if (grain === 'day') {
      const [y, m, d] = String(value).split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    }
    if (grain === 'week') return weekLabel(value);
    if (grain === 'month') {
      const [y, m] = String(value).split('-').map(Number);
      return new Date(y, m - 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    }
    return String(value);
  }

  // Tests passant TOUS les filtres actifs (badges cumulés = ET logique).
  // `skipGrain` sert à lister les options d'un select sans s'auto-filtrer.
  function filtered(skipGrain = null) {
    const mobile = state.netType === 'mobile';
    const values = state.period.values || {};
    return all.filter((r) => {
      if (mobile ? !r.isCell : r.isCell) return false;
      if (state.supplier !== '__all__' && r.op !== state.supplier) return false;
      if (mobile && state.tech && r.tech !== state.tech) return false;
      for (const g of Object.keys(values)) {
        if (g === skipGrain) continue;
        const list = values[g] || [];
        if (!list.length) continue;
        const v = grainValue(r, g);
        if (v == null || !list.map(String).includes(String(v))) return false;
      }
      return true;
    }).sort((a, b) => String(b.ts).localeCompare(String(a.ts))); // date décroissante
  }

  // ── Construction des filtres ───────────────────────────────────────────────

  // Fournisseurs DYNAMIQUES par réseau (croquis validé) : la liste ne montre
  // que les opérateurs réellement présents dans les tests du réseau choisi.
  function buildSupplierSelect() {
    const sel = document.getElementById('hi-filter-supplier');
    const counts = {};
    all.forEach((r) => {
      if (state.netType === 'mobile' ? r.isCell : !r.isCell) {
        counts[r.op] = (counts[r.op] || 0) + 1;
      }
    });
    const entries = Object.keys(counts)
      .sort((a, b) => counts[b] - counts[a] || a.localeCompare(b, 'fr'));
    sel.innerHTML = `<option value="__all__">Tous les fournisseurs</option>`
      + entries.map((op) =>
        `<option value="${escapeHtml(op)}">${escapeHtml(op)} (${counts[op]})</option>`).join('');
    // Un fournisseur mémorisé qui disparaît de la liste repart de « tous ».
    if (state.supplier !== '__all__' && !entries.includes(state.supplier)) {
      state.supplier = '__all__';
    }
    sel.value = state.supplier;
  }

  // Chips techno : TOUJOURS Toutes + 2G/3G/4G/5G (demande du 12/11) — la
  // série complète reste visible même si aucun test de la période n'a une
  // techno donnée ; la sélection aboutit alors à l'état vide guidé.
  function buildTechChips() {
    const box = document.getElementById('hi-tech-chips');
    const techs = ['2G', '3G', '4G', '5G'];
    box.innerHTML = `<button class="chip${state.tech ? '' : ' active'}" data-tech="">Toutes</button>`
      + techs.map((t) =>
        `<button class="chip${state.tech === t ? ' active' : ''}" data-tech="${t}">${t}</button>`).join('');
  }

  function updateTechVisibility() {
    document.getElementById('hi-tech-zone').style.display = state.netType === 'mobile' ? '' : 'none';
  }

  // ── Période (grain + valeur + badges cumulables) ───────────────────────────
  // Mêmes mécaniques que la carte et le Comparatif : les options du select ne
  // proposent que ce que les AUTRES filtres de période laissent ouvert
  // (cascade), et chaque filtre actif reste visible en badge retirable.

  function populatePeriodValues() {
    const sel = document.getElementById('hi-period-value');
    const grain = state.period.grain;
    if (grain === 'all') { sel.style.display = 'none'; return; }

    const base = filtered(grain);
    const values = [...new Set(base.map((r) => grainValue(r, grain)).filter((v) => v != null))];
    if (grain === 'hour') values.sort((a, b) => a - b);
    else values.sort((a, b) => (a > b ? -1 : 1)); // plus récents d'abord

    const allLabel = {
      hour: 'Toutes les heures', day: 'Tous les jours', week: 'Toutes les semaines',
      month: 'Tous les mois', year: 'Toutes les années',
    }[grain];
    sel.innerHTML = `<option value="">${allLabel}</option>`
      + values.map((v) => `<option value="${v}">${grainValueLabel(grain, v)}</option>`).join('');
    sel.dataset.grain = grain;
    sel.style.display = '';
  }

  function renderPeriodBadges() {
    const box = document.getElementById('hi-period-badges');
    const names = { year: 'Année', month: 'Mois', week: 'Semaine', day: 'Jour', hour: 'Heure' };
    const values = state.period.values || {};
    const entries = Object.keys(values).filter((g) => (values[g] || []).length);
    box.hidden = entries.length === 0;
    box.innerHTML = entries.map((g) => (values[g] || []).map((v) =>
      `<span class="period-badge">${names[g]} : ${escapeHtml(grainValueLabel(g, v))}<span class="x" data-g="${g}" data-v="${v}" title="Retirer ce filtre">×</span></span>`
    ).join('')).join('');
  }

  function resetFilters() {
    state.netType = 'mobile';
    state.supplier = '__all__';
    state.tech = '';
    state.period = { grain: 'all', values: {} };
    shown = PAGE_STEP;
    document.querySelectorAll('#hi-net-type .toggle').forEach((b) =>
      b.classList.toggle('active', b.dataset.net === 'mobile'));
    document.querySelectorAll('#hi-period-grain .toggle').forEach((b) =>
      b.classList.toggle('active', b.dataset.grain === 'all'));
    refresh();
    if (typeof App !== 'undefined' && App.toast) App.toast('Filtres réinitialisés');
  }

  // ── Colonnes (croquis validé le 11/11) ─────────────────────────────────────
  // « — » a deux sens, toujours expliqué en infobulle : métrique non
  // applicable (RSRP/RSRQ sur 2G/3G) ou aucun test de la ligne ne l'a
  // mesurée (RSRQ, RSSI, non-tests Streaming / Nav. web).

  const SIGNAL_HINT = "L'app mesure cette valeur ; « — » tant qu'aucun test de la ligne ne l'a transmise";
  const N_A_HINT = 'Non applicable : RSRP/RSRQ sont des métriques 4G/5G';
  const NOT_TESTED_HINT = 'Non testé pendant cette session';

  const fr1 = (v) => v.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const dash = (hint) => `<span class="q-dash" title="${hint}">—</span>`;
  const signalHint = (r) => (r.tech && /^[23]G$/.test(r.tech) ? N_A_HINT : SIGNAL_HINT);

  const fmtTs = (r) => {
    if (!r.date) return '<span class="geo-none">·</span>';
    return `<b>${r.date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })}</b> <small>${r.date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</small>`;
  };

  const opCell = (r) =>
    `<span class="op-dot" style="background:${operatorColor(r.op)}"></span>${escapeHtml(r.op)}`;

  const techCell = (r) => r.tech
    ? `<span class="net-badge" style="background:${networkColor(r.tech)}">${escapeHtml(r.tech)}</span>`
    : '<span class="geo-none">·</span>';

  const qCell = (qoe) => {
    if (!qoe) return dash(NOT_TESTED_HINT);
    const cls = qoe >= 3 ? 'q-good' : 'q-mid';
    const word = qoe >= 3 ? 'Bonne' : 'Limitée';
    return `<span class="qv ${cls}">${word}<span class="qtag">niveau ${qoe}</span></span>`;
  };

  // Cellule « Lieu ». Le lieu reste affiché ; la LIGNE entière est cliquable
  // (demande du 12/11) : un clic n'importe où dessus ouvre la carte centrée
  // sur la mesure (IMP-07), pas seulement la colonne Lieu.
  function placeCell(r) {
    const place = cleanPlace(r.location) || '·';
    return `<span class="geo-none" title="${escapeHtml(place)}">${escapeHtml(place)}</span>`;
  }

  const COLS_MOBILE = [
    { label: 'Date', html: fmtTs, text: (r) => r.date ? r.date.toLocaleString('fr-FR') : '' },
    { label: 'Mobile', html: opCell, text: (r) => r.op },
    { label: 'Technologie', html: techCell, text: (r) => r.tech },
    { label: 'RSRP (dBm)', num: true, title: 'Puissance du signal 4G/5G. Plus proche de 0 = mieux.',
      html: (r) => r.rsrp != null ? Math.round(r.rsrp) : dash(signalHint(r)),
      text: (r) => r.rsrp != null ? Math.round(r.rsrp) : '—' },
    { label: 'RSRQ (dB)', num: true, title: 'Qualité du signal 4G/5G. Plus proche de 0 = mieux.',
      html: (r) => r.rsrq != null ? Math.round(r.rsrq) : dash(signalHint(r)),
      text: (r) => r.rsrq != null ? Math.round(r.rsrq) : '—' },
    { label: '↓ Moyen (Mb/s)', num: true, title: 'Vitesse de réception. Plus haut = mieux.',
      html: (r) => isFinite(r.dl) ? fr1(r.dl) : '—', text: (r) => isFinite(r.dl) ? fr1(r.dl) : '—' },
    { label: '↑ Moyen (Mb/s)', num: true, title: 'Vitesse d\'émission. Plus haut = mieux.',
      html: (r) => isFinite(r.ul) ? fr1(r.ul) : '—', text: (r) => isFinite(r.ul) ? fr1(r.ul) : '—' },
    { label: 'Latence (ms)', num: true, title: 'Temps de réponse du réseau. Plus bas = mieux.',
      html: (r) => isFinite(r.ping) ? Math.round(r.ping) : '—',
      text: (r) => isFinite(r.ping) ? Math.round(r.ping) : '—' },
    { label: 'Jitter (ms)', num: true, title: 'Variation de la latence. Plus bas = mieux.',
      html: (r) => isFinite(r.jitter) ? fr1(r.jitter) : '—',
      text: (r) => isFinite(r.jitter) ? fr1(r.jitter) : '—' },
    { label: 'Streaming', num: true, title: 'Score d\'expérience streaming (0-100).',
      html: (r) => r.str > 0 ? `${fr1(r.str)} %` : dash(NOT_TESTED_HINT),
      text: (r) => r.str > 0 ? fr1(r.str) : '—' },
    { label: 'Nav. web', num: true, title: 'Score d\'expérience navigation web (0-100).',
      html: (r) => r.nav > 0 ? `${fr1(r.nav)} %` : dash(NOT_TESTED_HINT),
      text: (r) => r.nav > 0 ? fr1(r.nav) : '—' },
    { label: 'Appareil', html: (r) => escapeHtml(r.device) || '—', text: (r) => r.device || '—' },
    { label: 'Lieu', html: placeCell, text: (r) => cleanPlace(r.location) || '·' },
    { label: 'Qualité', html: (r) => qCell(r.qoe), text: (r) => r.qoe ? (r.qoe >= 3 ? 'Bonne' : 'Limitée') : '—' },
  ];

  const COLS_FIXE = [
    { label: 'Date', html: fmtTs, text: (r) => r.date ? r.date.toLocaleString('fr-FR') : '' },
    { label: 'Fixe', html: opCell, text: (r) => r.op },
    { label: 'RSSI (dBm)', num: true, title: 'Puissance du signal WiFi. Plus proche de 0 = mieux.',
      html: (r) => r.rssi != null ? Math.round(r.rssi) : dash(SIGNAL_HINT),
      text: (r) => r.rssi != null ? Math.round(r.rssi) : '—' },
    { label: '↓ Moyen (Mb/s)', num: true, title: 'Vitesse de réception. Plus haut = mieux.',
      html: (r) => isFinite(r.dl) ? fr1(r.dl) : '—', text: (r) => isFinite(r.dl) ? fr1(r.dl) : '—' },
    { label: '↑ Moyen (Mb/s)', num: true, title: 'Vitesse d\'émission. Plus haut = mieux.',
      html: (r) => isFinite(r.ul) ? fr1(r.ul) : '—', text: (r) => isFinite(r.ul) ? fr1(r.ul) : '—' },
    { label: 'Latence (ms)', num: true, title: 'Temps de réponse du réseau. Plus bas = mieux.',
      html: (r) => isFinite(r.ping) ? Math.round(r.ping) : '—',
      text: (r) => isFinite(r.ping) ? Math.round(r.ping) : '—' },
    { label: 'Jitter (ms)', num: true, title: 'Variation de la latence. Plus bas = mieux.',
      html: (r) => isFinite(r.jitter) ? fr1(r.jitter) : '—',
      text: (r) => isFinite(r.jitter) ? fr1(r.jitter) : '—' },
    { label: 'Streaming', num: true, title: 'Score d\'expérience streaming (0-100).',
      html: (r) => r.str > 0 ? `${fr1(r.str)} %` : dash(NOT_TESTED_HINT),
      text: (r) => r.str > 0 ? fr1(r.str) : '—' },
    { label: 'Nav. web', num: true, title: 'Score d\'expérience navigation web (0-100).',
      html: (r) => r.nav > 0 ? `${fr1(r.nav)} %` : dash(NOT_TESTED_HINT),
      text: (r) => r.nav > 0 ? fr1(r.nav) : '—' },
    { label: 'Appareil', html: (r) => escapeHtml(r.device) || '—', text: (r) => r.device || '—' },
    { label: 'Lieu', html: placeCell, text: (r) => cleanPlace(r.location) || '·' },
    { label: 'Qualité', html: (r) => qCell(r.qoe), text: (r) => r.qoe ? (r.qoe >= 3 ? 'Bonne' : 'Limitée') : '—' },
  ];

  const cols = () => (state.netType === 'mobile' ? COLS_MOBILE : COLS_FIXE);

  // ── Rendu ──────────────────────────────────────────────────────────────────

  function render() {
    const thead = document.querySelector('#history-table thead');
    const tbody = document.querySelector('#history-table tbody');
    const cs = cols();
    const list = filtered();
    const visible = list.slice(0, shown);

    thead.innerHTML = '<tr>' + cs.map((c) =>
      `<th${c.num ? ' class="num"' : ''}${c.title ? ` title="${c.title}"` : ''}>${c.label}</th>`
    ).join('') + '</tr>';

    if (!visible.length) {
      tbody.innerHTML = `<tr><td colspan="${cs.length}" class="op-empty">Aucun test pour ces filtres.</td></tr>`;
    } else {
      tbody.innerHTML = visible.map((r) => {
        // Ligne cliquable quand la mesure est géolocalisée : ouvre la carte
        // centrée sur le point (demande du 12/11).
        const geo = r.lat && r.lng
          ? ` class="hi-row-geo" data-lat="${r.lat}" data-lng="${r.lng}"
              data-place="${escapeHtml(cleanPlace(r.location) || '')}"
              title="Cliquer la ligne pour voir la mesure sur la carte"`
          : '';
        return '<tr' + geo + '>'
          + cs.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.html(r)}</td>`).join('')
          + '</tr>';
      }).join('');
    }

    const n = list.length;
    document.getElementById('hi-table-info').textContent =
      `${n.toLocaleString('fr-FR')} test${n > 1 ? 's' : ''} affiché${n > 1 ? 's' : ''}`
      + ` sur ${all.length.toLocaleString('fr-FR')} — trié par date décroissante`;
    const moreWrap = document.getElementById('hi-more-wrap');
    moreWrap.style.display = n > shown ? '' : 'none';
    document.getElementById('hi-more-info').textContent =
      `${visible.length.toLocaleString('fr-FR')} sur ${n.toLocaleString('fr-FR')}`;

    updateTechVisibility();
    renderPeriodBadges();
  }

  function refresh() {
    shown = PAGE_STEP;
    buildSupplierSelect();
    buildTechChips();
    populatePeriodValues();
    render();
  }

  // ── Interactions ───────────────────────────────────────────────────────────
  // Posées une seule fois : les éléments ciblés sont statiques, les parties
  // reconstruites (chips, badges) passent par la délégation.

  function bind() {
    // Réseau Mobile / Fixe : changer de réseau repart sur « tous », la liste
    // des fournisseurs change, la techno est masquée en Fixe.
    document.querySelectorAll('#hi-net-type .toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#hi-net-type .toggle').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.netType = btn.dataset.net;
        state.supplier = '__all__';
        state.tech = '';
        refresh();
      });
    });

    document.getElementById('hi-filter-supplier').addEventListener('change', (e) => {
      state.supplier = e.target.value || '__all__';
      refresh();
    });

    // Chips techno (délégation : reconstruites à chaque refresh).
    document.getElementById('hi-tech-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.tech = chip.dataset.tech;
      refresh();
    });

    // Période : grain, valeur, badges (mêmes mécaniques que la carte).
    document.querySelectorAll('#hi-period-grain .toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#hi-period-grain .toggle').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.period.grain = btn.dataset.grain;
        // « Tout » = aucun filtre de période ; les autres grains CONSERVENT
        // les filtres déjà posés (comportement demandé sur la carte).
        if (btn.dataset.grain === 'all') state.period.values = {};
        refresh();
      });
    });

    document.getElementById('hi-period-value').addEventListener('change', (e) => {
      const g = e.target.dataset.grain;
      if (e.target.value) {
        // Badges CUMULABLES : plusieurs valeurs d'un même grain s'ajoutent.
        const list = state.period.values[g] = state.period.values[g] || [];
        if (!list.includes(e.target.value)) list.push(e.target.value);
        // Remonter d'un niveau purge les grains plus fins (cascade).
        (CHILDREN[g] || []).forEach((c) => delete state.period.values[c]);
        e.target.value = '';
      }
      refresh();
    });

    document.getElementById('hi-period-badges').addEventListener('click', (e) => {
      const x = e.target.closest('.x');
      if (!x) return;
      const list = state.period.values[x.dataset.g] || [];
      const i = list.indexOf(x.dataset.v);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) delete state.period.values[x.dataset.g];
      refresh();
    });

    document.getElementById('hi-reset').addEventListener('click', resetFilters);
    document.getElementById('hi-more').addEventListener('click', () => {
      shown += PAGE_STEP;
      render();
    });

    // Ligne cliquable → carte (délégation : les lignes sont recréées à chaque
    // rendu). Toute la ligne ouvre la mesure sur la carte, plus seulement la
    // colonne Lieu (demande du 12/11).
    document.querySelector('#history-table tbody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr.hi-row-geo');
      if (!tr) return;
      App.switchView('map');
      MapView.showMeasurement(
        parseFloat(tr.dataset.lat),
        parseFloat(tr.dataset.lng),
        tr.dataset.place || '',
      );
    });

    ['csv', 'xlsx', 'png'].forEach((fmt) => {
      document.getElementById(`hi-export-${fmt}`)
        .addEventListener('click', () => exportAs(fmt));
    });
  }

  // ── Exports CSV / XLSX / PNG (machinerie des Statistiques) ──────────────────
  // Les trois formats exportent la MÊME vue : tous les tests filtrés, pas
  // seulement la page affichée.

  function dataset() {
    const cs = cols();
    return {
      cols: cs.map((c) => c.label),
      rows: filtered().map((r) => cs.map((c) => c.text(r))),
    };
  }

  function exportFileNames(ext) {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `historique-${state.netType}-${day}.${ext}`;
  }

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
  // rapport — même rendu que les exports PNG du Comparatif et des Statistiques.
  function pngBlob(title, colsLabels, lines) {
    const S = 2;
    const colW = 150;
    const W = 40 + colsLabels.length * colW;
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
    colsLabels.forEach((c, i) => cx.fillText(c.toUpperCase(), 20 + i * colW, titleH + 25));
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

  async function exportAs(format) {
    const ds = dataset();
    if (!ds.rows.length) { App.toast('Aucun test à exporter pour ces filtres.'); return; }
    const fmt = (v) => v == null ? '—'
      : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ','))
      : String(v);
    if (format === 'csv') {
      // BOM UTF-8 + point-virgule : s'ouvre proprement dans Excel FR/LibreOffice.
      const csv = '\uFEFF' + [ds.cols.join(';')]
        .concat(ds.rows.map((r) => r.map(fmt).join(';')))
        .join('\r\n');
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), exportFileNames('csv'));
    } else if (format === 'xlsx') {
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // Cellule : nombre en type natif, texte en inlineStr, null = « — ».
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
          + `<sheets><sheet name="Historique" sheetId="1" r:id="rId1"/></sheets></workbook>`],
        ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
          + '</Relationships>'],
        ['xl/worksheets/sheet1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`],
      ];
      downloadBlob(zipStore(parts), exportFileNames('xlsx'));
    } else {
      const blob = await pngBlob(
        `Yélé — Historique (${state.netType === 'mobile' ? 'mobile' : 'fixe'})`,
        ds.cols, ds.rows,
      );
      if (blob) downloadBlob(blob, exportFileNames('png'));
    }
    App.toast(`${ds.rows.length.toLocaleString('fr-FR')} test${ds.rows.length > 1 ? 's' : ''} exporté${ds.rows.length > 1 ? 's' : ''} (CSV · XLSX · PNG).`);
  }

  /// Oblige la vue à tout relire au prochain affichage (nouvelles données).
  function reload() {
    if (!built) return;
    built = false;
    show();
  }

  return { show, reload };
})();
