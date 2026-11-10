// ─── Vue Opérateurs : tableau comparatif période × opérateur × lieu ──────────
// Agrège côté client les points de /api/dashboard/map. Chaque ligne regroupe
// les tests d'un opérateur, sur une période (jour / semaine / tout) et en un
// lieu donné, et affiche les débits moyens mesurés.

const Operators = (() => {
  const PAGE_STEP = 100;

  let built = false;
  let points = [];
  let rows = [];            // lignes agrégées, avant tri
  let shown = PAGE_STEP;    // nombre de lignes affichées

  const state = {
    grain: 'day',           // day | week | all
    operator: '',           // '' = tous
    tech: '',               // '' = toutes
    sort: 'periodKey',
    dir: 'desc',
  };

  // Colonnes triables : clé de tri + type (texte ou nombre).
  const SORTABLE = {
    periodKey: 'text', operator: 'text', count: 'num',
    avgDl: 'num', avgUl: 'num', avgPing: 'num', location: 'text',
  };

  // ── Chargement ──────────────────────────────────────────────────────────────

  async function show() {
    if (built) return;
    built = true;

    const tbody = document.querySelector('#operators-table tbody');
    tbody.innerHTML = '<tr><td colspan="8" style="color:#5d6478">Chargement…</td></tr>';

    points = MapView.getPoints();
    if (!points.length) {
      // Repli : la carte n'a pas encore chargé (lien profond ?view=operators).
      // Il faut normaliser ici aussi, sans quoi les noms abîmés réapparaissent
      // — ONATEL scindé en deux, technologies parasites.
      try {
        points = (await API.mapPoints() || []).map((p) => ({
          ...p,
          operator: normalizeOperator(p.operator),
          networkType: normalizeNetwork(p.networkType),
        }));
      } catch (e) {
        tbody.innerHTML = `<tr><td colspan="8" style="color:#e0492f">Erreur : ${escapeHtml(e.message)}</td></tr>`;
        return;
      }
    }

    buildFilters();
    bind();
    refresh();
  }

  // ── Filtres ─────────────────────────────────────────────────────────────────

  function buildFilters() {
    const operators = [...new Set(points.map((p) => p.operator || 'Inconnu'))].sort();
    const opSel = document.getElementById('op-filter-operator');
    opSel.length = 1;
    operators.forEach((o) => opSel.add(new Option(o, o)));

    const techs = [...new Set(points.map((p) => p.networkType).filter(Boolean))].sort();
    const techSel = document.getElementById('op-filter-tech');
    techSel.length = 1;
    techs.forEach((t) => techSel.add(new Option(t, t)));
  }

  function filtered() {
    return points.filter((p) =>
      (!state.operator || (p.operator || 'Inconnu') === state.operator) &&
      (!state.tech || p.networkType === state.tech));
  }

  // ── Agrégation ──────────────────────────────────────────────────────────────

  // Clé + libellé de la période d'un point selon la granularité choisie.
  function periodOf(p) {
    if (state.grain === 'all') return { key: '', label: 'Toutes dates' };
    const d = parseTs(p.timestamp);
    if (isNaN(d)) return { key: '', label: 'Date inconnue' };
    if (state.grain === 'week') {
      const key = weekStartKey(d);
      return { key, label: weekLabel(key) };
    }
    return {
      key: dayKey(d),
      label: d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }),
    };
  }

  // Une ligne = (période, opérateur, lieu). Les tests sans `location` sont
  // regroupés sous « Lieu non précisé » plutôt que d'être écartés.
  function aggregate() {
    const groups = {};
    filtered().forEach((p) => {
      const period = periodOf(p);
      const operator = p.operator || 'Inconnu';
      const location = p.location || 'Lieu non précisé';
      const key = `${period.key}|${operator}|${location}`;
      (groups[key] = groups[key] || { period, operator, location, pts: [] }).pts.push(p);
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

      return {
        periodKey: g.period.key,
        periodLabel: g.period.label,
        operator: g.operator,
        location: g.location,
        count: n,
        avgDl: mean((p) => p.download),
        avgUl: mean((p) => p.upload),
        avgPing: mean((p) => p.ping),
        tech,
        // Centre géographique des tests du groupe, pour le renvoi vers la carte.
        lat: geo.length ? geo.reduce((s, p) => s + p.lat, 0) / geo.length : null,
        lng: geo.length ? geo.reduce((s, p) => s + p.lng, 0) / geo.length : null,
      };
    });
  }

  function sortRows(list) {
    const type = SORTABLE[state.sort] || 'num';
    const sign = state.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = a[state.sort];
      const vb = b[state.sort];
      const cmp = type === 'text'
        ? String(va).localeCompare(String(vb), 'fr')
        : (Number(va) || 0) - (Number(vb) || 0);
      // Départage par débit décroissant pour que les ex æquo restent lisibles.
      return cmp !== 0 ? cmp * sign : b.avgDl - a.avgDl;
    });
  }

  // ── Rendu ───────────────────────────────────────────────────────────────────

  function refresh() {
    rows = aggregate();
    shown = PAGE_STEP;
    renderCompare();
    renderTable();
  }

  // ── Résumé grand public : une carte par opérateur ───────────────────────────
  // La réponse à la question « quel réseau marche le mieux ? » : les cartes,
  // triées du plus rapide au plus lent, proviennent des MÊMES filtres que le
  // tableau (opérateur, technologie, mais toutes périodes et tous lieux : des
  // moyennes par jour seraient illisibles).
  function renderCompare() {
    const pts = filtered();
    const byOp = {};
    pts.forEach((p) => {
      const acc = byOp[p.operator || 'Inconnu']
        = byOp[p.operator || 'Inconnu'] || { sumDl: 0, sumPing: 0, count: 0 };
      acc.sumDl += Number(p.download) || 0;
      acc.sumPing += Number(p.ping) || 0;
      acc.count += 1;
    });

    const cards = Object.entries(byOp)
      .map(([operator, a]) => ({
        operator,
        avgDl: a.sumDl / a.count,
        avgPing: a.sumPing / a.count,
        count: a.count,
      }))
      .sort((a, b) => b.avgDl - a.avgDl);

    const wrap = document.getElementById('op-compare');
    if (!cards.length) {
      wrap.innerHTML = '<div class="op-card-empty">Aucune mesure pour ces filtres.</div>';
    } else {
      const maxDl = Math.max(...cards.map((c) => c.avgDl), 1);
      wrap.innerHTML = cards.map((c, i) => {
        const lvl = qualityLevel({ download: c.avgDl }, 'debit');
        return `
          <div class="op-card${i === 0 && cards.length > 1 ? ' op-card-best' : ''}">
            ${i === 0 && cards.length > 1 ? '<div class="op-best-badge">Réseau le plus rapide (débit moyen ↓)</div>' : ''}
            <div class="op-card-name">
              <span class="op-dot" style="background:${operatorColor(c.operator)}"></span>
              <span>${escapeHtml(c.operator)}</span>
            </div>
            <div class="op-card-dl"><b>${c.avgDl.toFixed(1)}</b><small>Mb/s</small></div>
            <div class="op-bar"><span class="op-bar-fill" style="width:${(c.avgDl / maxDl) * 100}%;background:${qualityColor(lvl)}"></span></div>
            <div class="op-card-stats">
              <div><b>${Math.round(c.avgPing)} ms</b><small>Réactivité</small></div>
              <div><b>${c.count.toLocaleString('fr-FR')}</b><small>Tests</small></div>
            </div>
          </div>`;
      }).join('');
    }

    // Sous-titre : la fenêtre réelle couverte par les tests affichés (« Tests
    // des 8 derniers jours »), en tonnes grand public plutôt qu'un total brut.
    document.getElementById('op-compare-sub').textContent = spanLabel(pts);
  }

  // Nombre de jours distincts couverts par les tests affichés.
  function spanLabel(pts) {
    if (!pts.length) return 'Aucun test sur la période';
    const tests = `${pts.length.toLocaleString('fr-FR')} tests`;
    const dates = pts.map((p) => parseTs(p.timestamp)).filter((d) => !isNaN(d.getTime()));
    if (!dates.length) return tests;
    const n = new Set(dates.map(dayKey)).size;
    if (n === 1) return `${tests} du jour`;
    // Fenêtre glissante plausible : on borne le libellé aux longues historicités.
    const spanDays = Math.round((Date.now() - Math.min(...dates.map((d) => d.getTime()))) / 86400000) + 1;
    if (spanDays > 60) return `${tests} · toutes dates (${n} jours de mesure)`;
    return `${tests} des ${spanDays} derniers jours`;
  }

  function renderTable() {
    const tbody = document.querySelector('#operators-table tbody');
    const sorted = sortRows(rows);
    const visible = sorted.slice(0, shown);

    if (!visible.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="color:#5d6478">Aucune mesure pour ces filtres.</td></tr>';
      document.getElementById('op-more-wrap').style.display = 'none';
      return;
    }

    // Échelle des barres de débit : le maximum de la page affichée.
    const maxDl = Math.max(...visible.map((r) => r.avgDl), 1);

    // Séparation visuelle par période : une ligne allégée avant le premier
    // groupe de chaque jour/semaine. Seulement quand le tri porte sur la
    // période — dans les autres tris, les périodes sont mélangées et une
    // séparation mentirait.
    const byPeriod = state.sort === 'periodKey';

    tbody.innerHTML = visible.map((r, i) => {
      const lvl = qualityLevel({ download: r.avgDl }, 'debit');
      const net = r.tech
        ? `<span class="net-badge" style="background:${networkColor(r.tech)}">${escapeHtml(r.tech)}</span>` : '·';
      const place = cleanPlace(r.location) || r.location;
      const geo = r.lat != null
        ? `<button class="geo-link" data-lat="${r.lat}" data-lng="${r.lng}"
             title="${escapeHtml(place)}, ${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}
Cliquer pour voir sur la carte">${escapeHtml(place)}</button>`
        : `<span class="geo-none" title="${escapeHtml(place)}">${escapeHtml(place)}</span>`;

      const sep = byPeriod && (i === 0 || visible[i - 1].periodLabel !== r.periodLabel)
        ? `<tr class="op-period-row"><td colspan="8">${escapeHtml(r.periodLabel)}</td></tr>`
        : '';

      return `
        ${sep}
        <tr>
          <td class="op-period">${escapeHtml(r.periodLabel)}</td>
          <td class="op-name">
            <span class="op-dot" style="background:${operatorColor(r.operator)}"></span>
            <span>${escapeHtml(r.operator)}</span>
          </td>
          <td class="num">${r.count}</td>
          <td class="op-dl">
            <b>${r.avgDl.toFixed(1)}</b>
            <div class="op-bar">
              <span class="op-bar-fill" style="width:${(r.avgDl / maxDl) * 100}%;background:${qualityColor(lvl)}"></span>
            </div>
          </td>
          <td class="num">${r.avgUl.toFixed(1)}</td>
          <td class="num">${Math.round(r.avgPing)} ms</td>
          <td>${net}</td>
          <td class="op-geo">${geo}</td>
        </tr>`;
    }).join('');

    // En-têtes : indicateur de tri sur la colonne active.
    document.querySelectorAll('#operators-table th[data-sort]').forEach((th) => {
      const active = th.dataset.sort === state.sort;
      th.classList.toggle('sorted', active);
      th.dataset.dir = active ? state.dir : '';
    });

    const moreWrap = document.getElementById('op-more-wrap');
    moreWrap.style.display = sorted.length > shown ? '' : 'none';
    document.getElementById('op-more-info').textContent =
      `${visible.length} ligne${visible.length > 1 ? 's' : ''} sur ${sorted.length}`;
  }

  // ── Interactions ────────────────────────────────────────────────────────────

  function bind() {
    document.querySelectorAll('#op-grain .toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#op-grain .toggle').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.grain = btn.dataset.grain;
        refresh();
      });
    });

    document.getElementById('op-filter-operator').addEventListener('change', (e) => {
      state.operator = e.target.value;
      refresh();
    });
    document.getElementById('op-filter-tech').addEventListener('change', (e) => {
      state.tech = e.target.value;
      refresh();
    });

    // Tri par clic sur l'en-tête ; deuxième clic inverse le sens.
    document.querySelectorAll('#operators-table th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (state.sort === key) {
          state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sort = key;
          // Texte : A→Z d'abord. Nombres : plus grand d'abord.
          state.dir = SORTABLE[key] === 'text' ? 'asc' : 'desc';
        }
        shown = PAGE_STEP;
        renderTable();
      });
    });

    document.getElementById('op-more').addEventListener('click', () => {
      shown += PAGE_STEP;
      renderTable();
    });

    // Délégation : le bouton de localisation renvoie à la carte, centrée
    // sur le barycentre des tests de la ligne.
    document.querySelector('#operators-table tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('.geo-link');
      if (!btn) return;
      App.switchView('map');
      // Repère explicite : centrer la carte ne suffit pas à désigner le lieu
      // parmi les ronds de mesure voisins.
      MapView.showMeasurement(
        parseFloat(btn.dataset.lat),
        parseFloat(btn.dataset.lng),
        btn.querySelector('span')?.textContent.trim() || btn.textContent.trim(),
      );
    });
  }

  /// Oblige la vue à tout relire au prochain affichage.
  function reset() {
    built = false;
  }

  return { show, reset };
})();
