// ─── Vue Historique : tableau paginé avec filtres ────────────────────────────

const History = (() => {
  const state = { page: 1, limit: 20, total: 0 };
  let loadedOnce = false;

  function show() {
    if (!loadedOnce) {
      loadedOnce = true;
      bind();
      load();
    }
  }

  // Remplit les <select> avec les valeurs trouvées dans les données carte
  // `operators` : [{ value, label }] — `value` est le terme envoyé au backend
  // (nom brut, correspondance partielle), `label` le nom canonique affiché.
  function setOperators(operators) {
    const sel = document.getElementById('hf-operator');
    sel.length = 1;
    operators.forEach((op) => sel.add(new Option(op.label, op.value)));
  }

  function setNetworks(networks) {
    const sel = document.getElementById('hf-network');
    sel.length = 1;
    networks.forEach((n) => sel.add(new Option(n, n)));
  }

  /// Filtres actuellement saisis. Partagés entre l'affichage paginé et
  /// l'export, pour qu'ils portent exactement sur le même jeu de mesures.
  function currentFilters() {
    return {
      operator: document.getElementById('hf-operator').value,
      network: document.getElementById('hf-network').value,
      from: document.getElementById('hf-from').value,
      to: document.getElementById('hf-to').value,
    };
  }

  async function load() {
    const tbody = document.querySelector('#history-table tbody');
    tbody.innerHTML = '<tr><td colspan="17" style="color:#5d6478">Chargement…</td></tr>';

    let page;
    try {
      page = await API.results({
        page: state.page,
        limit: state.limit,
        ...currentFilters(),
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="17" style="color:#e0492f">Erreur : ${e.message}</td></tr>`;
      return;
    }

    state.total = page.total || 0;
    const rows = page.data || [];

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="17" style="color:#5d6478">Aucun résultat pour ces filtres.</td></tr>';
    } else {
      tbody.innerHTML = rows.map((r) => {
        const dl = parseFloat(r.download);
        const lvl = qualityLevel({ download: dl }, 'debit');
        const date = r.timestamp ? new Date(r.timestamp).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '·';
        const tech = normalizeNetwork(r.networkType);
        const net = tech === NETWORK_UNKNOWN
          ? '·'
          : `<span class="net-badge" style="background:${networkColor(tech)}">${escapeHtml(tech)}</span>`;
        const streaming = r.streamingScore > 0
          ? escapeHtml(`${r.streamingMaxResolution || ''} ${Math.round(r.streamingScore)}/100`.trim()) : '·';
        const browsing = r.browsingAvgLoadMs > 0
          ? `${(r.browsingAvgLoadMs / 1000).toFixed(1)} s` : '·';
        const mobile = [r.cellularTech, r.simOperator].filter(Boolean).map(escapeHtml).join(' · ') || '·';
        // RSRP et RSRQ ne sont définis qu'en 4G/5G. Ailleurs — 2G, 3G, Wi-Fi —
        // le backend renvoie null : on affiche un tiret, jamais un zéro, qui
        // laisserait croire à un signal nul mesuré.
        const signal = signalCell(r);
        return `
          <tr>
            <td>${date}</td>
            <td><b style="color:${operatorColor(normalizeOperator(r.operator))}" title="${escapeHtml(r.operator || '')}">${escapeHtml(normalizeOperator(r.operator))}</b></td>
            <td>${mobile}</td>
            <td>${net}</td>
            <td class="hist-signal">${signal}</td>
            <td><b>${escapeHtml(r.download || '·')}</b></td>
            <td>${r.downloadPeakSpeed > 0 ? escapeHtml(Number(r.downloadPeakSpeed).toFixed(2)) : '·'}</td>
            <td>${escapeHtml(r.upload || '·')}</td>
            <td>${r.uploadPeakSpeed > 0 ? escapeHtml(Number(r.uploadPeakSpeed).toFixed(2)) : '·'}</td>
            <td>${escapeHtml(r.ping || '·')} ms</td>
            <td>${r.pingMin > 0 ? escapeHtml(Math.round(r.pingMin).toString()) : '·'}</td>
            <td>${escapeHtml(r.jitter || '·')} ms</td>
            <td>${streaming}</td>
            <td>${browsing}</td>
            <td class="hist-geo">${placeCell(r)}</td>
            <td>${escapeHtml(r.deviceModel || '·')}</td>
            <td><span class="q-pill" style="background:${qualityColor(lvl)}22;color:${qualityColor(lvl)}"><i style="background:${qualityColor(lvl)}"></i>${qualityLabel(lvl)}</span></td>
          </tr>`;
      }).join('');
    }

    const pages = Math.max(1, Math.ceil(state.total / state.limit));
    document.getElementById('hp-info').textContent = `Page ${state.page} / ${pages} · ${state.total.toLocaleString('fr-FR')} tests`;
    document.getElementById('hp-prev').disabled = state.page <= 1;
    document.getElementById('hp-next').disabled = state.page >= pages;
  }

  /// Cellule « Signal » : RSRP et RSRQ (ISS-01).
  ///
  /// Le backend les renvoie à `null` hors 4G/5G, et pour toutes les mesures
  /// antérieures à leur mise en service. Un tiret dit « non mesurable » ;
  /// un zéro dirait « mesuré à zéro », ce qui serait faux.
  function signalCell(r) {
    // ISS-03 : la radio reste accrochée à sa cellule 4G/5G même pendant un test
    // passé en Wi-Fi, si bien que RSRP et RSRQ sont renseignés. Ces valeurs
    // décrivent alors le réseau mobile, PAS ce que le test a mesuré. Les
    // afficher ici reviendrait à présenter des informations mobiles comme
    // celles du test — la même faute que l'application mobile évite déjà.
    if (normalizeNetwork(r.networkType) === 'WiFi') {
      return '<span class="geo-none" title="Test effectué en Wi-Fi : les '
        + 'mesures radio décrivent le réseau mobile, pas ce test">·</span>';
    }
    const parts = [];
    if (r.rsrp != null) parts.push(`${r.rsrp} dBm`);
    if (r.rsrq != null) parts.push(`${r.rsrq} dB`);
    if (!parts.length) return '<span class="geo-none">·</span>';
    return `<span title="RSRP : puissance du signal de référence
RSRQ : qualité du signal de référence">${escapeHtml(parts.join(' · '))}</span>`;
  }

  // ── Renvoi vers la carte (IMP-07) ───────────────────────────────────────────

  /// Cellule « Lieu ». Cliquable quand la mesure est géolocalisée : sélectionner
  /// une ligne de l'historique n'ouvrait jusqu'ici aucune vue cartographique.
  function placeCell(r) {
    const place = cleanPlace(r.location || r.city || '') || '·';
    const lat = Number(r.latitude);
    const lng = Number(r.longitude);
    if (!lat || !lng) return `<span class="geo-none">${escapeHtml(place)}</span>`;
    return `<button class="geo-link" data-lat="${lat}" data-lng="${lng}"
      title="${escapeHtml(place)}, ${lat.toFixed(4)}, ${lng.toFixed(4)}
Cliquer pour voir sur la carte">${escapeHtml(place)}</button>`;
  }

  // ── Export des mesures filtrées (IMP-13) ────────────────────────────────────

  /// Colonnes exportées, dans l'ordre. Choix explicite plutôt que l'objet brut :
  /// l'export sert aux livrables ARCEP et à la campagne comparative nPerf, son
  /// format ne doit pas bouger au gré des champs ajoutés côté serveur.
  const EXPORT_COLUMNS = [
    'timestamp', 'operator', 'simOperator', 'networkType', 'cellularTech',
    'download', 'upload', 'ping', 'jitter',
    'rsrp', 'rsrq', 'simSlot',
    'streamingScore', 'streamingMaxResolution',
    'browsingAvgLoadMs', 'browsingSuccessRate',
    'latitude', 'longitude', 'location', 'city', 'country',
    'deviceModel', 'qoeRating', 'measurementType',
  ];

  /// Récupère TOUTES les mesures correspondant aux filtres courants, et pas
  /// seulement la page affichée : le critère parle des « mesures filtrées ».
  async function fetchAllFiltered() {
    const filters = currentFilters();
    const pageSize = 500;
    const rows = [];
    let page = 1;
    let total = Infinity;
    while (rows.length < total) {
      const res = await API.results({ ...filters, page, limit: pageSize });
      total = res.total || 0;
      const batch = res.data || [];
      if (!batch.length) break; // garde-fou : évite une boucle sans fin
      rows.push(...batch);
      page++;
    }
    return rows;
  }

  function toCsv(rows) {
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      // Guillemets doublés et champ encadré dès qu'il contient un séparateur,
      // sans quoi un nom d'opérateur à virgule décalerait toute la ligne.
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [EXPORT_COLUMNS.join(';')];
    rows.forEach((r) => lines.push(EXPORT_COLUMNS.map((c) => esc(r[c])).join(';')));
    // Point-virgule et BOM UTF-8 : c'est ce qu'attend Excel en configuration
    // française, sinon les accents sont illisibles et tout tient en une colonne.
    return '﻿' + lines.join('\r\n');
  }

  function download(content, filename, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Libère la mémoire : un export de plusieurs milliers de lignes n'a pas à
    // rester retenu par le document.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportAs(format) {
    const btn = document.getElementById(format === 'csv' ? 'hf-csv' : 'hf-json');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Export…';
    try {
      const rows = await fetchAllFiltered();
      if (!rows.length) { App.toast('Aucune mesure à exporter.'); return; }
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === 'csv') {
        download(toCsv(rows), `yele-mesures-${stamp}.csv`, 'text/csv;charset=utf-8');
      } else {
        const slim = rows.map((r) => Object.fromEntries(
          EXPORT_COLUMNS.map((c) => [c, r[c] ?? null])));
        download(JSON.stringify(slim, null, 2),
          `yele-mesures-${stamp}.json`, 'application/json');
      }
      App.toast(`${rows.length} mesure${rows.length > 1 ? 's' : ''} exportée${rows.length > 1 ? 's' : ''}.`);
    } catch (e) {
      App.toast('Export impossible : ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  function bind() {
    // Délégation : le renvoi vers la carte depuis une ligne de l'historique.
    document.querySelector('#history-table tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('.geo-link');
      if (!btn) return;
      const lat = parseFloat(btn.dataset.lat);
      const lng = parseFloat(btn.dataset.lng);
      App.switchView('map');
      MapView.showMeasurement(lat, lng, btn.textContent.trim());
    });

    document.getElementById('hf-csv').addEventListener('click', () => exportAs('csv'));
    document.getElementById('hf-json').addEventListener('click', () => exportAs('json'));

    document.getElementById('hf-apply').addEventListener('click', () => { state.page = 1; load(); });
    document.getElementById('hf-reset').addEventListener('click', () => {
      ['hf-operator', 'hf-network', 'hf-from', 'hf-to'].forEach((id) => { document.getElementById(id).value = ''; });
      state.page = 1;
      load();
    });
    document.getElementById('hp-prev').addEventListener('click', () => { state.page--; load(); });
    document.getElementById('hp-next').addEventListener('click', () => { state.page++; load(); });
  }

  /// Recharge la page courante, en conservant filtres et pagination.
  /// Sans effet tant que la vue n'a jamais été ouverte.
  function reload() {
    if (loadedOnce) load();
  }

  return { show, setOperators, setNetworks, reload };
})();
