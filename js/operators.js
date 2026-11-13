// ─── Vue Comparatif (ex « Opérateurs ») ─────────────────────────────────────
// Page grand public « quel réseau est le plus rapide, où, et quand ? ».
// Filtres validés (croquis v4, 11/11/2026) :
//   - Réseau Mobile/Fixe : Mobile = les 3 opérateurs ARCEP + chips techno
//     (Toutes/2G/3G/4G/5G, pas de WiFi) ; Fixe = FAI dynamiques, techno masquée ;
//   - Période Carte-style : grain (Tout/Heures/…/Années) + valeur + badges
//     cumulables retirables, cascade CHILDREN qui purge les grains fins ;
//   - La période est un FILTRE (comme sur la carte), jamais un regroupement :
//     le tableau regroupe par jour (× opérateur × lieu), et par heure quand le
//     grain « Heures » est choisi ;
//   - Colonnes avec mesures signal (RSRP/RSRQ en mobile, RSSI en fixe) :
//     moyennes des tests du groupe portant la valeur (ISS-01 : l'API
//     diffuse rsrp/rsrq/rssi consolidés), « — » tant qu'aucun test du
//     groupe ne l'a mesurée ;
//   - Ligne dépliable : les tests bruts du groupe (heure, débits, latence).
// Agrège côté client les points de /api/dashboard/map (Map.getPoints()).

const Operators = (() => {
  const PAGE_STEP = 100;
  // Mémorisation des filtres (extra validé) : l'utilisateur retrouve sa
  // sélection à la prochaine visite. Toute défaillance du stockage reste
  // silencieuse : la page fonctionne sans mémoire.
  const MEM_KEY = 'yele-comparatif-filtres';

  let built = false;
  let points = [];
  let rows = [];            // lignes agrégées, triées
  let shown = PAGE_STEP;    // nombre de lignes affichées
  let expandedKey = null;   // groupe dont les tests bruts sont dépliés

  const state = {
    netType: 'mobile',      // mobile | fixe
    operator: '__all__',    // '__all__' = tous (défaut, comme la carte)
    tech: '',               // '' = toutes (chips, mobile seulement)
    period: { grain: 'all', values: {} },
  };

  // Cascade des grains : choisir une valeur à un niveau purge les grains PLUS
  // FINS (choisir 2025 ne peut pas laisser un mois de 2024 actif). Identique
  // à la carte (map.js).
  const CHILDREN = {
    year: ['month', 'week', 'day', 'hour'],
    month: ['week', 'day', 'hour'],
    week: ['day', 'hour'],
    day: ['hour'],
    hour: [],
  };

  // ── Classification et dates ────────────────────────────────────────────────
  // Réplique locale de isCellularTest (map.js) : la carte est une IIFE, la
  // fonction n'est pas exportée — et le critère est une ligne stable.
  function isCellularTest(p) {
    return /^[2345]G\+?$/.test(String(p.networkType || '').trim());
  }

  // Valeur brute d'un point pour un grain donné (null si date invalide).
  function grainValue(p, grain) {
    const d = parseTs(p.timestamp);
    if (isNaN(d)) return null;
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

  // Un point passe-t-il TOUS les filtres de période actifs (cumulés) ?
  // `skipGrain` sert à lister les options d'un select sans s'auto-filtrer.
  function timeMatch(p, skipGrain = null) {
    const values = state.period.values || {};
    for (const g of Object.keys(values)) {
      if (g === skipGrain) continue;
      const v = grainValue(p, g);
      if (v == null || String(v) !== String(values[g])) return false;
    }
    return true;
  }

  // ── Chargement ─────────────────────────────────────────────────────────────

  async function show() {
    if (built) return;
    built = true;

    const tbody = document.querySelector('#operators-table tbody');
    tbody.innerHTML = '<tr><td colspan="9" class="op-empty">Chargement…</td></tr>';

    points = MapView.getPoints();
    if (!points.length) {
      // Repli : la carte n'a pas encore chargé (lien profond ?view=operators).
      try {
        points = (await API.mapPoints() || []).map((p) => ({
          ...p,
          operator: normalizeOperator(p.operator),
          networkType: normalizeNetwork(p.networkType),
        }));
      } catch (e) {
        tbody.innerHTML = `<tr><td colspan="9" class="op-empty">Erreur : ${escapeHtml(e.message)}</td></tr>`;
        return;
      }
    }

    // Les filtres mémorisés sont restaurés AVANT la construction des listes.
    restoreState();
    buildFilters();
    bind();
    refresh();
  }

  // ── Filtres ────────────────────────────────────────────────────────────────

  function buildFilters() {
    buildOperatorSelect();
    buildTechChips();
    updateTechVisibility();
    syncToggles();
    populatePeriodValues();
  }

  // Boutons actifs (réseau et grain de période) alignés sur l'état — utile au
  // démarrage quand les filtres ont été restaurés de la mémoire.
  function syncToggles() {
    document.querySelectorAll('#op-net-type .toggle').forEach((b) =>
      b.classList.toggle('active', b.dataset.net === state.netType));
    document.querySelectorAll('#op-period-grain .toggle').forEach((b) =>
      b.classList.toggle('active', b.dataset.grain === state.period.grain));
  }

  // ── Mémorisation des filtres (extra validé) ────────────────────────────────

  function saveState() {
    try {
      localStorage.setItem(MEM_KEY, JSON.stringify({
        netType: state.netType,
        operator: state.operator,
        tech: state.tech,
        period: state.period,
      }));
    } catch (e) { /* stockage indisponible : pas bloquant */ }
  }

  function restoreState() {
    try {
      const s = JSON.parse(localStorage.getItem(MEM_KEY));
      if (!s) return;
      if (s.netType === 'mobile' || s.netType === 'fixe') state.netType = s.netType;
      if (typeof s.operator === 'string' && s.operator) state.operator = s.operator;
      if (typeof s.tech === 'string') state.tech = s.tech;
      if (s.period && typeof s.period === 'object') {
        state.period = { grain: s.period.grain || 'all', values: s.period.values || {} };
      }
    } catch (e) { /* état corrompu : défauts */ }
  }

  function filtered(skipGrain = null) {
    const mobile = state.netType === 'mobile';
    return points.filter((p) => {
      // Mobile = tests cellulaires (2G-5G), Fixe = le reste (WiFi…).
      if (mobile ? !isCellularTest(p) : isCellularTest(p)) return false;
      if (state.operator !== '__all__' && (p.operator || 'Inconnu') !== state.operator) return false;
      if (mobile && state.tech && (p.networkType || '') !== state.tech) return false;
      return timeMatch(p, skipGrain);
    });
  }

  // Sélecteur d'opérateur / FAI, fidèle à la carte : Mobile = liste FIXE des
  // 3 opérateurs ARCEP (toujours proposés, compte « (aucun test) ») + any
  // opérateur cellulaire non canonique présent en base ; Fixe = liste
  // DYNAMIQUE des FAI vus dans les tests non cellulaires.
  function buildOperatorSelect() {
    const sel = document.getElementById('op-filter-operator');
    const counts = {};
    points.forEach((p) => {
      if (state.netType === 'mobile' ? isCellularTest(p) : !isCellularTest(p)) {
        const op = p.operator || 'Inconnu';
        counts[op] = (counts[op] || 0) + 1;
      }
    });

    let entries;
    if (state.netType === 'mobile') {
      entries = MOBILE_OPERATORS.map((op) => ({ op, n: counts[op] || 0 }));
      Object.keys(counts)
        .filter((op) => !MOBILE_OPERATORS.includes(op) && op !== 'Inconnu')
        .filter((op) => points.some((q) => (q.operator || '') === op && isCellularTest(q)))
        .forEach((op) => entries.push({ op, n: counts[op] }));
    } else {
      entries = Object.keys(counts).sort((a, b) => counts[b] - counts[a])
        .map((op) => ({ op, n: counts[op] }));
    }

    const header = state.netType === 'fixe'
      ? `<option value="__all__">Tous les fournisseurs</option>`
      : `<option value="__all__">Tous les opérateurs</option>`;
    sel.innerHTML = header + entries.map((e) => {
      const canonical = MOBILE_OPERATORS.includes(e.op) || state.netType === 'mobile';
      const short = e.op === 'Inconnu' ? 'Inconnu' : canonical ? e.op : operatorShortLabel(e.op);
      return `<option value="${escapeHtml(e.op)}">${escapeHtml(short)}${e.n ? ` (${e.n})` : ' (aucun test)'}</option>`;
    }).join('');
    // Un opérateur mémorisé qui n'existe plus dans la liste repart de « tous ».
    if (state.operator !== '__all__' && !entries.some((e) => e.op === state.operator)) {
      state.operator = '__all__';
    }
    sel.value = state.operator;
  }

  // Chips techno : Mobile seulement (Toutes/2G/3G/4G/5G — pas de WiFi, les
  // tests WiFi relèvent du réseau Fixe). Masqué en Fixe (croquis v1).
  function buildTechChips() {
    const chips = document.getElementById('op-tech-chips');
    const techs = ['Toutes', '2G', '3G', '4G', '5G'];
    chips.innerHTML = techs.map((t) =>
      `<button class="chip${t === 'Toutes' ? ' active' : ''}" data-tech="${t === 'Toutes' ? '' : t}">${t}</button>`).join('');
    // La chip active suit l'état (restauré de la mémoire au démarrage).
    chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.tech === state.tech));
    chips.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        state.tech = chip.dataset.tech;
        refresh();
      });
    });
  }

  function updateTechVisibility() {
    document.getElementById('op-tech-zone').style.display = state.netType === 'mobile' ? '' : 'none';
  }

  // ── Période (grain + valeur + badges cumulables) ───────────────────────────
  // Mêmes mécaniques que la carte : les options du select de valeur ne
  // proposent que ce que les AUTRES filtres de période laissent ouvert
  // (cascade), et chaque filtre actif reste visible en badge retirable.

  function populatePeriodValues() {
    const sel = document.getElementById('op-period-value');
    const grain = state.period.grain;
    renderPeriodBadges();
    if (grain === 'all') { sel.style.display = 'none'; return; }

    const base = filtered(grain);
    const values = [...new Set(base.map((p) => grainValue(p, grain)).filter((v) => v != null))];
    if (grain === 'hour') values.sort((a, b) => a - b);
    else values.sort((a, b) => (a > b ? -1 : 1)); // plus récents d'abord

    const allLabel = {
      hour: 'Toutes les heures', day: 'Tous les jours', week: 'Toutes les semaines',
      month: 'Tous les mois', year: 'Toutes les années',
    }[grain];
    sel.innerHTML = `<option value="">${allLabel}</option>`
      + values.map((v) => `<option value="${v}">${grainValueLabel(grain, v)}</option>`).join('');
    // Conserve la sélection si elle reste disponible ; sinon ce grain saute
    // (les filtres des autres grains sont conservés).
    const current = state.period.values[grain] ?? null;
    const keep = current != null && values.map(String).includes(String(current));
    if (current != null && !keep) delete state.period.values[grain];
    sel.value = keep ? String(current) : '';
    sel.style.display = '';
  }

  function renderPeriodBadges() {
    const box = document.getElementById('op-period-badges');
    const names = { year: 'Année', month: 'Mois', week: 'Semaine', day: 'Jour', hour: 'Heure' };
    const values = state.period.values || {};
    const entries = Object.keys(values).filter((g) => values[g] != null);
    box.hidden = entries.length === 0;
    box.innerHTML = entries.map((g) =>
      `<span class="period-badge">${names[g]} : ${escapeHtml(grainValueLabel(g, values[g]))}<span class="x" data-g="${g}" title="Retirer ce filtre">×</span></span>`
    ).join('');
    box.querySelectorAll('.x').forEach((x) => x.addEventListener('click', () => {
      delete state.period.values[x.dataset.g];
      populatePeriodValues();
      refresh();
    }));
  }

  function resetFilters() {
    state.netType = 'mobile';
    state.operator = '__all__';
    state.tech = '';
    state.period = { grain: 'all', values: {} };
    expandedKey = null;
    // La mémoire suit : un reset ne doit pas ressusciter les filtres au
    // prochain chargement.
    try { localStorage.removeItem(MEM_KEY); } catch (e) { /* pas bloquant */ }

    const activate = (groupSel, attr, val) =>
      document.querySelectorAll(`${groupSel} .toggle`).forEach((b) =>
        b.classList.toggle('active', b.dataset[attr] === val));
    activate('#op-net-type', 'net', 'mobile');
    activate('#op-period-grain', 'grain', 'all');

    buildOperatorSelect();
    buildTechChips();
    updateTechVisibility();
    populatePeriodValues();
    refresh();
    if (typeof App !== 'undefined' && App.toast) App.toast('Filtres réinitialisés');
  }

  // ── Agrégation ─────────────────────────────────────────────────────────────

  // Une ligne = jour × opérateur × lieu (× heure quand le grain « Heures » est
  // choisi). La période reste un FILTRE : semaines/mois/années ne changent pas
  // le regroupement, seulement ce qui est comparé. Les tests sans `location`
  // sont regroupés sous « Lieu non précisé » plutôt qu'écartés.
  function aggregate() {
    const byHour = state.period.grain === 'hour';
    const groups = {};
    filtered().forEach((p) => {
      const operator = p.operator || 'Inconnu';
      const location = p.location || 'Lieu non précisé';
      let hour = null;
      if (byHour) {
        const d = parseTs(p.timestamp);
        hour = isNaN(d) ? null : d.getHours();
      }
      const key = `${hour == null ? '' : hour + 'h|'}${dayKeyFrom(p)}|${operator}|${location}`;
      (groups[key] = groups[key] || { hour, dateKey: dayKeyFrom(p), operator, location, pts: [] }).pts.push(p);
    });

    return Object.values(groups).map((g) => {
      const n = g.pts.length;
      const mean = (fn) => g.pts.reduce((s, p) => s + (Number(fn(p)) || 0), 0) / n;
      const geo = g.pts.filter((p) => p.lat && p.lng);

      // Technologie la plus représentée dans le groupe.
      const techCounts = {};
      g.pts.forEach((p) => {
        const t = p.networkType || '';
        if (t) techCounts[t] = (techCounts[t] || 0) + 1;
      });
      const tech = Object.keys(techCounts).sort((a, b) => techCounts[b] - techCounts[a])[0] || '';

      // Signal détaillé (ISS-01 : l'API diffuse rsrp/rsrq/rssi consolidés).
      // Moyennes sur les seuls tests qui ONT la valeur ; null = aucun —
      // l'écran affiche « — », jamais un zéro qui dirait « signal nul ».
      const meanSignal = (k) => {
        const vals = g.pts.map((p) => (p[k] == null ? null : Number(p[k])))
          .filter((v) => v != null);
        return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      };

      return {
        hour: g.hour,
        dateKey: g.dateKey,
        dateLabel: g.hour != null ? `${g.hour} h` : dayLabel(g.dateKey),
        operator: g.operator,
        location: g.location,
        pts: g.pts,
        count: n,
        avgDl: mean((p) => p.download),
        avgUl: mean((p) => p.upload),
        avgPing: mean((p) => p.ping),
        avgRsrp: meanSignal('rsrp'),
        avgRsrq: meanSignal('rsrq'),
        avgRssi: meanSignal('rssi'),
        tech,
        lat: geo.length ? geo.reduce((s, p) => s + p.lat, 0) / geo.length : null,
        lng: geo.length ? geo.reduce((s, p) => s + p.lng, 0) / geo.length : null,
      };
    }).sort((a, b) => {
      // Plus récents d'abord, puis opérateur (lisibilité d'un comparatif).
      const d = b.dateKey.localeCompare(a.dateKey) || (b.hour ?? 0) - (a.hour ?? 0);
      return d !== 0 ? d : a.operator.localeCompare(b.operator, 'fr');
    });
  }

  // Clé de jour d'un point (grâce à parseTs ; '' si date inconnue).
  function dayKeyFrom(p) {
    const d = parseTs(p.timestamp);
    return isNaN(d) ? '' : dayKey(d);
  }

  function dayLabel(key) {
    if (!key) return 'Date inconnue';
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  // ── Résumé grand public : classement des 3 premiers + classement global ────
  // Croquis validé le 11/11 (cartes + rang en coin, global complet) ; affiné
  // le 12/11 : le comparatif se fait PAR CATÉGORIE — les opérateurs MOBILES
  // entre eux (les 3 opérateurs ARCEP sont TOUJOURS listés, même sans test
  // sous les filtres courants : carte grisée « Aucun test ») et les
  // fournisseurs FIXES entre eux (les FAI vus dans les tests non cellulaires).
  // Tri sur le débit moyen ↓, mêmes filtres que le tableau — moyennes
  // pondérées par test ; les opérateurs sans test passent après ceux qui en
  // ont, dans l'ordre du palmarès.
  const RANKS = ['', '1ᵉʳ', '2ᵉ', '3ᵉ', '4ᵉ', '5ᵉ', '6ᵉ', '7ᵉ', '8ᵉ'];
  const rankLabel = (i) => RANKS[i + 1] || (i + 1) + 'ᵉ';

  function renderCompare() {
    const pts = filtered();
    const mobile = state.netType === 'mobile';

    // Palmarès de la catégorie courante (indépendant des filtres de période :
    // un opérateur reste listé même si la période le vide de ses tests).
    const pool = points.filter((p) =>
      state.netType === 'mobile' ? isCellularTest(p) : !isCellularTest(p));
    let roster;
    if (state.operator !== '__all__') {
      // Un opérateur précisément filtré : les autres sortent du palmarès.
      roster = [state.operator];
    } else if (state.netType === 'mobile') {
      const seen = [...new Set(pool.map((p) => p.operator || 'Inconnu'))];
      roster = [...MOBILE_OPERATORS,
        ...seen.filter((op) => !MOBILE_OPERATORS.includes(op) && op !== 'Inconnu')];
    } else {
      // Fixe : les FAI vus dans les tests non cellulaires, les plus testés
      // d'abord (même ordre que le select de filtre).
      const counts = {};
      pool.forEach((p) => {
        const op = p.operator || 'Inconnu';
        counts[op] = (counts[op] || 0) + 1;
      });
      roster = Object.keys(counts).sort((a, b) =>
        counts[b] - counts[a] || a.localeCompare(b, 'fr'));
    }

    const stats = {};
    pts.forEach((p) => {
      const acc = stats[p.operator || 'Inconnu']
        = stats[p.operator || 'Inconnu'] || { sumDl: 0, sumUl: 0, sumPing: 0, count: 0, rsrp: [], rsrq: [], rssi: [] };
      acc.sumDl += Number(p.download) || 0;
      acc.sumUl += Number(p.upload) || 0;
      acc.sumPing += Number(p.ping) || 0;
      // Signal détaillé (ISS-01) : moyennes sur les seuls tests qui ONT la
      // valeur ; null = aucun — « — » à l'écran, jamais un zéro trompeur.
      if (p.rsrp != null) acc.rsrp.push(Number(p.rsrp));
      if (p.rsrq != null) acc.rsrq.push(Number(p.rsrq));
      if (p.rssi != null) acc.rssi.push(Number(p.rssi));
      acc.count += 1;
    });

    const meanOf = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    const cards = roster.map((operator) => {
      const a = stats[operator];
      return a
        ? { operator,
            avgDl: a.sumDl / a.count, avgUl: a.sumUl / a.count,
            avgPing: a.sumPing / a.count,
            avgRsrp: meanOf(a.rsrp), avgRsrq: meanOf(a.rsrq), avgRssi: meanOf(a.rssi),
            count: a.count }
        : { operator, avgDl: null, avgUl: null, avgPing: null,
            avgRsrp: null, avgRsrq: null, avgRssi: null, count: 0 };
    }).sort((a, b) => (b.avgDl ?? -1) - (a.avgDl ?? -1));

    const wrap = document.getElementById('op-compare');
    const globalBox = document.getElementById('op-global');
    const globalTitle = document.querySelector('.op-global-title');
    if (!cards.length) {
      wrap.innerHTML = '<div class="op-card-empty">Aucune mesure pour ces filtres.</div>';
      globalBox.hidden = true;
      if (globalTitle) globalTitle.style.display = 'none';
    } else {
      const maxDl = Math.max(...cards.map((c) => c.avgDl || 0), 1);
      // Décimales à la française (« 22,1 »), comme sur la vue Statistiques.
      const fr1 = (v) => v.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      // Signal arrondi, « — » tant qu'aucun test de l'opérateur ne l'a mesurée.
      const sigI = (v) => (v == null ? '—' : Math.round(v).toLocaleString('fr-FR'));
      // Podium : les 3 premiers, même carte qu'aujourd'hui + rang en coin ;
      // un opérateur sans test est grisé, « Aucun test » à la place des valeurs.
      wrap.innerHTML = cards.slice(0, 3).map((c, i) => {
        const vide = c.avgDl == null;
        const lvl = vide ? 1 : qualityLevel({ download: c.avgDl }, 'debit');
        return `
          <div class="op-card${i === 0 && cards.length > 1 && !vide ? ' op-card-best' : ''}${vide ? ' op-card-none' : ''}">
            <div class="op-rank">${rankLabel(i)}</div>
            <div class="op-card-name">
              <span class="op-dot" style="background:${operatorColor(c.operator)}"></span>
              <span>${escapeHtml(c.operator)}</span>
            </div>
            <div class="op-card-dl">${vide
              ? '<div class="op-card-none-txt">Aucun test</div>'
              : `<b>${fr1(c.avgDl)}</b><small>Mb/s</small>`}</div>
            <div class="op-bar">${vide ? '' : `<span class="op-bar-fill" style="width:${(c.avgDl / maxDl) * 100}%;background:${qualityColor(lvl)}"></span>`}</div>
            <div class="op-card-stats">${vide ? '' : (mobile
              ? `<div><b>${fr1(c.avgUl)}</b><small>Envoi (Mb/s)</small></div>
                 <div><b>${sigI(c.avgRsrp)}</b><small>RSRP (dBm)</small></div>
                 <div><b>${sigI(c.avgRsrq)}</b><small>RSRQ (dB)</small></div>
                 <div><b>${Math.round(c.avgPing)} ms</b><small>Latence</small></div>
                 <div><b>${c.count.toLocaleString('fr-FR')}</b><small>Tests</small></div>`
              : `<div><b>${fr1(c.avgUl)}</b><small>Envoi (Mb/s)</small></div>
                 <div><b>${sigI(c.avgRssi)}</b><small>RSSI (dBm)</small></div>
                 <div><b>${Math.round(c.avgPing)} ms</b><small>Latence</small></div>
                 <div><b>${c.count.toLocaleString('fr-FR')}</b><small>Tests</small></div>`)}</div>
          </div>`;
      }).join('');

      // Classement global : tous les opérateurs de la catégorie, du 1ᵉʳ au
      // dernier (les rangs 4ᵉ, 5ᵉ… existent dès qu'il y a plus de 3 acteurs).
      // Colonnes enrichies (demande du 13/11) : Envoi + signal — RSRP/RSRQ
      // en mobile, RSSI en fixe (mêmes règles que le tableau ci-dessous).
      globalBox.hidden = false;
      if (globalTitle) globalTitle.style.display = '';
      const sigHead = mobile
        ? '<span class="op-global-sig">RSRP (dBm)</span><span class="op-global-rq">RSRQ (dB)</span>'
        : '<span class="op-global-sig">RSSI (dBm)</span>';
      globalBox.innerHTML = `
        <div class="op-global-head"><span class="op-global-rank">Rang</span><span class="op-global-name">${mobile ? 'Opérateur' : 'FAI'}</span><span class="op-global-num">Tél. (Mb/s)</span><span class="op-global-ul">Envoi (Mb/s)</span>${sigHead}<span class="op-global-ms">Latence (ms)</span><span class="op-global-count">Tests</span></div>`
        + cards.map((c, i) => {
          const vide = c.avgDl == null;
          return `
          <div class="op-global-row${i < 3 && !vide ? ' top' : ''}${vide ? ' off' : ''}">
            <span class="op-global-rank">${rankLabel(i)}</span>
            <span class="op-global-name">
              <span class="op-dot" style="background:${operatorColor(c.operator)}"></span>${escapeHtml(c.operator)}${i === 0 && !vide ? '<span class="op-global-medal">Le plus rapide ↓</span>' : ''}
            </span>
            <span class="op-global-num">${vide ? '<small>Aucun test</small>' : `<b>${fr1(c.avgDl)}</b> <small>Mb/s</small>`}</span>
            <span class="op-global-ul">${vide ? '·' : fr1(c.avgUl)}</span>
            ${mobile
              ? `<span class="op-global-sig">${vide ? '·' : sigI(c.avgRsrp)}</span><span class="op-global-rq">${vide ? '·' : sigI(c.avgRsrq)}</span>`
              : `<span class="op-global-sig">${vide ? '·' : sigI(c.avgRssi)}</span>`}
            <span class="op-global-ms">${vide ? '·' : Math.round(c.avgPing)}</span>
            <span class="op-global-count">${vide ? '0' : c.count.toLocaleString('fr-FR')}</span>
          </div>`;
        }).join('');
    }

    // La mention de catégorie rappelle que mobile et fixe ne se comparent
    // jamais entre eux (demande du 12/11).
    const cat = state.netType === 'mobile'
      ? 'comparaison entre opérateurs MOBILES uniquement'
      : 'comparaison entre fournisseurs FIXES uniquement';
    document.getElementById('op-compare-sub').textContent = `${spanLabel(pts)} · ${cat}`;
  }

  // Nombre de jours distincts couverts par les tests affichés.
  function spanLabel(pts) {
    if (!pts.length) return 'Aucun test sur la période';
    const tests = `${pts.length.toLocaleString('fr-FR')} tests`;
    const dates = pts.map((p) => parseTs(p.timestamp)).filter((d) => !isNaN(d.getTime()));
    if (!dates.length) return tests;
    const n = new Set(dates.map(dayKey)).size;
    if (n === 1) return `${tests} du jour`;
    const spanDays = Math.round((Date.now() - Math.min(...dates.map((d) => d.getTime()))) / 86400000) + 1;
    if (spanDays > 60) return `${tests} · toutes dates (${n} jours de mesure)`;
    return `${tests} des ${spanDays} derniers jours`;
  }

  // ── Tableau ────────────────────────────────────────────────────────────────

  // Seuils des pastilles qualité (croquis validé A+B+C+E+D) :
  // vert = Bon · orange = Moyen/Limitée · rouge = Lent/Dégradé.
  const dlLevel = (v) => (v >= 10 ? 3 : v >= 5 ? 2 : 1);
  const ulLevel = (v) => (v >= 5 ? 3 : v >= 1.5 ? 2 : 1);
  const pingLevel = (v) => (v <= 80 ? 3 : v <= 200 ? 2 : 1);
  const WORDS = {
    dl: { 3: 'Bon', 2: 'Moyen', 1: 'Lent' },
    ping: { 3: 'Bon', 2: 'Limitée', 1: 'Dégradé' },
  };

  function pill(value, level, words) {
    const cls = level >= 3 ? 'q-good' : level === 2 ? 'q-mid' : 'q-bad';
    return `<span class="qv ${cls}">${value}<span class="qtag">${words[level]}</span></span>`;
  }

  // Colonnes signal (ISS-01 : l'API diffuse rsrp/rsrq/rssi consolidés) : la
  // moyenne du groupe s'affiche dès qu'UN test du groupe a la valeur ; « — »
  // sinon, avec infobulle qui explique le tiret (pas une panne côté page).
  const SIGNAL_HINT = "L'app mesure cette valeur ; « — » tant qu'aucun test de la ligne ne l'a transmise";
  const N_A_HINT = 'Non applicable : RSRP/RSRQ sont des métriques 4G/5G';

  function renderTable() {
    const thead = document.querySelector('#operators-table thead');
    const tbody = document.querySelector('#operators-table tbody');
    const mobile = state.netType === 'mobile';
    // Colonne « Lieu » retirée (demande du 12/11) : le comparatif se lit
    // opérateur par opérateur, la carte reste accessible depuis la vue Carte.
    const ncols = mobile ? 9 : 8;

    thead.innerHTML = `<tr>
      <th>Date</th>
      <th>${mobile ? 'Opérateur' : 'FAI'}</th>
      <th title="Technologie la plus représentée dans le groupe.">Techno</th>
      <th class="num">Tests</th>
      <th class="num" title="Vitesse de réception moyenne. Plus haut = mieux.">Tél. (Mb/s)</th>
      <th class="num" title="Vitesse d'émission moyenne. Plus haut = mieux.">Envoi (Mb/s)</th>
      ${mobile
        ? `<th class="num" title="Puissance du signal 4G/5G (dBm). Plus proche de 0 = mieux. Affiché « — » sur 2G/3G.">RSRP (dBm)</th>
           <th class="num" title="Qualité du signal 4G/5G (dB). Plus proche de 0 = mieux. Affiché « — » sur 2G/3G.">RSRQ (dB)</th>`
        : `<th class="num" title="Puissance du signal WiFi (dBm). Plus proche de 0 = mieux.">RSSI (dBm)</th>`}
      <th class="num" title="Temps de réponse du réseau. Plus bas = mieux.">Latence (ms)</th>
    </tr>`;

    const sorted = rows;
    const visible = sorted.slice(0, shown);

    // Contexte de filtres, affiché dans le bandeau et dans l'état vide.
    const bits = [];
    if (state.netType === 'fixe') bits.push('Fixe');
    if (state.operator !== '__all__') bits.push(state.operator);
    if (state.tech) bits.push(state.tech);
    Object.keys(state.period.values || {}).forEach((g) =>
      bits.push(`${{ year: 'Année', month: 'Mois', week: 'Semaine', day: 'Jour', hour: 'Heure' }[g]} : ${grainValueLabel(g, state.period.values[g])}`));
    document.getElementById('op-table-info').textContent =
      `${visible.length} groupe${visible.length > 1 ? 's' : ''} comparé${visible.length > 1 ? 's' : ''}`
      + (bits.length ? ` - filtres : ${bits.join(', ')}` : '');

    if (!visible.length) {
      // État vide guidé (extra validé) : on explique le vide et on propose
      // la sortie en un clic, plutôt qu'un « aucune donnée » sec.
      tbody.innerHTML = `<tr><td colspan="${ncols}" class="op-empty op-empty-guided">
        Aucune mesure pour ces filtres${bits.length ? ` (${escapeHtml(bits.join(', '))})` : ''}.<br>
        <button class="btn-primary reset-btn" id="op-empty-reset" type="button">Réinitialiser les filtres</button></td></tr>`;
      document.getElementById('op-more-wrap').style.display = 'none';
      return;
    }

    tbody.innerHTML = visible.map((r) => {
      const key = `${r.dateKey}|${r.hour ?? ''}|${r.operator}|${r.location}`;
      const dateCell = `<td class="num op-date">${escapeHtml(r.dateLabel)}</td>`;
      const opCell = `<td class="op-name">
        <span class="op-dot" style="background:${operatorColor(r.operator)}"></span>
        <span>${escapeHtml(r.operator)}</span></td>`;
      const techCell = r.tech
        ? `<td><span class="net-badge" style="background:${networkColor(r.tech)}">${escapeHtml(r.tech)}</span></td>`
        : '<td><span class="geo-none">Non précisé</span></td>';
      const dlCell = `<td class="num">${pill(r.avgDl.toFixed(1), dlLevel(r.avgDl), WORDS.dl)}</td>`;
      const ulCell = `<td class="num">${pill(r.avgUl.toFixed(1), ulLevel(r.avgUl), WORDS.dl)}</td>`;
      // En mobile, « — » a deux sens : métrique non applicable (2G/3G) ou
      // aucun test du groupe ne l'a mesurée ; en fixe, même logique pour le
      // RSSI (les tests WiFi récents la portent).
      const signalHint = (t) => (t && /^[23]G$/.test(t) ? N_A_HINT : SIGNAL_HINT);
      const sig = (v, hint) => v == null
        ? `<span class="q-dash" title="${hint}">—</span>`
        : `<span title="${hint}">${Math.round(v)}</span>`;
      const signalCell = mobile
        ? `<td class="num">${sig(r.avgRsrp, signalHint(r.tech))}</td>
           <td class="num">${sig(r.avgRsrq, signalHint(r.tech))}</td>`
        : `<td class="num">${sig(r.avgRssi, SIGNAL_HINT)}</td>`;
      const pingCell = `<td class="num">${pill(`${Math.round(r.avgPing)} ms`, pingLevel(r.avgPing), WORDS.ping)}</td>`;

      const open = expandedKey === key;
      const rawRow = open
        ? `<tr class="op-raw"><td colspan="${ncols}">
            <div class="op-raw-list">
              <span class="op-raw-title">Tests du groupe :</span>
              ${r.pts.slice(0, 24).map((t) => {
                const d = parseTs(t.timestamp);
                const h = isNaN(d) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                return `<span class="op-raw-item"><b>${h}</b> &darr; ${(Number(t.download) || 0).toFixed(1)} · &uarr; ${(Number(t.upload) || 0).toFixed(1)} Mb/s · ${Math.round(Number(t.ping) || 0)} ms</span>`;
              }).join('')}
              ${r.pts.length > 24 ? `<span class="op-raw-item">… et ${r.pts.length - 24} autres</span>` : ''}
            </div>
          </td></tr>`
        : '';

      return `<tr class="op-row" data-key="${escapeHtml(key)}" title="Cliquer pour ${open ? 'replier' : 'déplier'} les tests bruts">
        ${dateCell}${opCell}${techCell}
        <td class="num">${r.count}</td>
        ${dlCell}${ulCell}${signalCell}${pingCell}
      </tr>${rawRow}`;
    }).join('');

    const moreWrap = document.getElementById('op-more-wrap');
    moreWrap.style.display = sorted.length > shown ? '' : 'none';
    document.getElementById('op-more-info').textContent =
      `${visible.length} ligne${visible.length > 1 ? 's' : ''} sur ${sorted.length}`;
    // Colonnes figées (13/11) : le décalage suit la largeur réelle de la Date.
    freezeFirstColumns(document.getElementById('operators-table'));
  }

  // ── Interactions ───────────────────────────────────────────────────────────

  function bind() {
    // Réseau Mobile / Fixe.
    document.querySelectorAll('#op-net-type .toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#op-net-type .toggle').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.netType = btn.dataset.net;
        state.operator = '__all__'; // changer de réseau repart de « tous »
        state.tech = '';
        expandedKey = null;
        buildOperatorSelect();
        buildTechChips();
        updateTechVisibility();
        populatePeriodValues();
        refresh();
      });
    });

    document.getElementById('op-filter-operator').addEventListener('change', (e) => {
      state.operator = e.target.value || '__all__';
      refresh();
    });

    // Période : grain, valeur, badges (mêmes mécaniques que la carte).
    document.querySelectorAll('#op-period-grain .toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#op-period-grain .toggle').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.period.grain = btn.dataset.grain;
        // « Tout » = aucun filtre de période ; les autres grains CONSERVENT
        // les filtres déjà posés (comportement demandé sur la carte).
        if (btn.dataset.grain === 'all') state.period.values = {};
        populatePeriodValues();
        refresh();
      });
    });
    document.getElementById('op-period-value').addEventListener('change', (e) => {
      const g = state.period.grain;
      if (e.target.value === '') {
        delete state.period.values[g];
      } else {
        state.period.values[g] = e.target.value;
        // Remonter d'un niveau purge les grains plus fins (cascade).
        (CHILDREN[g] || []).forEach((c) => delete state.period.values[c]);
      }
      populatePeriodValues();
      refresh();
    });

    document.getElementById('op-reset').addEventListener('click', resetFilters);

    // Un clic déplie/replie les tests bruts du groupe (délégation : les
    // lignes sont recréées à chaque rendu). Colonne « Lieu » retirée le
    // 12/11 : plus de renvoi carte depuis ce tableau.
    document.querySelector('#operators-table tbody').addEventListener('click', (e) => {
      // Bouton de sortie de l'état vide : mêmes effets que le reset du haut.
      if (e.target.closest('#op-empty-reset')) { resetFilters(); return; }
      const tr = e.target.closest('tr.op-row');
      if (!tr) return;
      expandedKey = expandedKey === tr.dataset.key ? null : tr.dataset.key;
      renderTable();
    });

    document.getElementById('op-more').addEventListener('click', () => {
      shown += PAGE_STEP;
      renderTable();
    });
  }

  // ── Exports CSV / XLSX / PNG (extra validé) ────────────────────────────────
  // Les trois formats exportent la MÊME vue : les groupes comparés sous les
  // filtres courants (pas seulement les 100 premières lignes affichées).

  function exportRows() {
    const mobile = state.netType === 'mobile';
    const cols = mobile
      ? ['Date', 'Opérateur', 'Techno', 'Tests', 'Download (Mb/s)', 'Upload (Mb/s)', 'RSRP (dBm)', 'RSRQ (dB)', 'Latence (ms)']
      : ['Date', 'FAI', 'Techno', 'Tests', 'Download (Mb/s)', 'Upload (Mb/s)', 'RSSI (dBm)', 'Latence (ms)'];
    const line = (r) => mobile
      ? [r.dateLabel, r.operator, r.tech, r.count, r.avgDl, r.avgUl, r.avgRsrp, r.avgRsrq, Math.round(r.avgPing)]
      : [r.dateLabel, r.operator, r.tech, r.count, r.avgDl, r.avgUl, r.avgRssi, Math.round(r.avgPing)];
    // null = aucun test du groupe n'a mesuré la valeur : exporté « — » comme à l'écran.
    return { mobile, cols, rows: rows.map(line) };
  }

  function exportFileNames(ext) {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `comparatif-${state.netType}-${day}.${ext}`;
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  document.getElementById('op-export-csv').addEventListener('click', () => {
    const { cols, rows: lines } = exportRows();
    // BOM UTF-8 + point-virgule : s'ouvre proprement dans Excel FR/LibreOffice.
    const fmt = (v) => v == null ? '—'
      : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ','))
      : String(v);
    const csv = '\uFEFF' + [cols.join(';')]
      .concat(lines.map((r) => r.map(fmt).join(';')))
      .join('\r\n');
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), exportFileNames('csv'));
  });

  // ── XLSX : vrai classeur, généré sans librairie ────────────────────────────
  // Un .xlsx est un zip de XML. On écrit l'archive à la main : CRC32 + entrées
  // « stored » (sans compression) suffisent pour un fichier valide et restent
  // lisibles par Excel/LibreOffice, comme les PDF de l'app sans dépendance.

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

  // Archive ZIP minimale (entrées stockées, répertoire central, EOCD).
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
      local.setUint32(0, 0x04034b50, true);   // signature
      local.setUint16(4, 20, true);           // version requise
      local.setUint16(6, 0x0800, true);       // drapeau UTF-8
      local.setUint16(8, 0, true);            // méthode : stored
      local.setUint16(10, 0, true);           // heure (pas nécessaire)
      local.setUint16(12, 0, true);           // date
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true); // taille compressée
      local.setUint32(22, data.length, true); // taille réelle
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);           // nom extra
      chunks.push(new Uint8Array(local.buffer), nameBytes, data);
      central.push({ nameBytes, crc, size: data.length, offset });
      offset += 30 + nameBytes.length + data.length;
    }
    const centralStart = offset;
    let centralSize = 0;
    for (const e of central) {
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);      // signature
      cd.setUint16(4, 20, true);              // version d'écriture
      cd.setUint16(6, 20, true);              // version requise
      cd.setUint16(8, 0x0800, true);          // UTF-8
      cd.setUint32(16, e.crc, true);
      cd.setUint32(20, e.size, true);
      cd.setUint32(24, e.size, true);
      cd.setUint16(28, e.nameBytes.length, true);
      cd.setUint32(42, e.offset, true);       // position de l'entrée locale
      chunks.push(new Uint8Array(cd.buffer), e.nameBytes);
      centralSize += 46 + e.nameBytes.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);       // signature EOCD
    end.setUint16(8, central.length, true);   // nb d'entrées
    end.setUint16(10, central.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, centralStart, true);
    chunks.push(new Uint8Array(end.buffer));
    return new Blob(chunks, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  document.getElementById('op-export-xlsx').addEventListener('click', () => {
    const { cols, rows: lines } = exportRows();
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Cellule : nombre en type natif, texte en inlineStr, null = « — ».
    const cell = (v, r, c) => {
      if (v == null) return `<c r="${r}${c}" t="inlineStr"><is><t>—</t></is></c>`;
      if (typeof v === 'number') return `<c r="${r}${c}" t="n"><v>${v}</v></c>`;
      return `<c r="${r}${c}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    };
    const sheetRows = [cols.map((c, i) => cell(c, 1, i + 1)).join('')]
      .concat(lines.map((r, ri) => r.map((v, i) => cell(v, ri + 2, i + 1)).join('')))
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
        + `<sheets><sheet name="Comparatif" sheetId="1" r:id="rId1"/></sheets></workbook>`],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        + '</Relationships>'],
      ['xl/worksheets/sheet1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`],
    ];
    downloadBlob(zipStore(parts), exportFileNames('xlsx'));
  });

  document.getElementById('op-export-png').addEventListener('click', () => {
    const { cols, rows: lines } = exportRows();
    // Image en 2x pour rester nette sur écran HiDPI.
    const S = 2;
    const colW = 150;                       // largeur de colonne (px logiques)
    const W = 40 + cols.length * colW;
    const rowH = 30, headH = 40, titleH = 54;
    const H = titleH + headH + lines.length * rowH + 24;
    const cv = document.createElement('canvas');
    cv.width = W * S;
    cv.height = H * S;
    const cx = cv.getContext('2d');
    cx.scale(S, S);
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, W, H);
    // Titre + date, comme une capture de rapport.
    cx.fillStyle = '#1d2233';
    cx.font = 'bold 18px "Segoe UI", sans-serif';
    const d = new Date();
    cx.fillText(`Yélé — Comparatif (${state.netType === 'mobile' ? 'mobile' : 'fixe'}) — ${d.toLocaleDateString('fr-FR')}`, 20, 34);
    // Bande d'en-têtes.
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
    // Lignes, zébrées pour suivre l'œil.
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
    cv.toBlob((b) => b && downloadBlob(b, exportFileNames('png')), 'image/png');
  });

  function refresh() {
    rows = aggregate();
    shown = PAGE_STEP;
    renderCompare();
    renderTable();
    saveState(); // un seul point de sortie : chaque changement de filtre passe ici
  }

  /// Oblige la vue à tout relire au prochain affichage.
  function reset() {
    built = false;
  }

  return { show, reset };
})();
