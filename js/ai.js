// ─── Vue Analyse IA : anomalies détectées + prévision de qualité ─────────────
// Consomme le micro-service IA via le proxy du backend : /api/ai/*
// Le service (Render gratuit) s'endort après inactivité : chaque appel passe
// par getJson(), qui retente automatiquement sur 429/5xx ou coupure réseau.
//
// Refonte du 13/11 (validée) :
//   - analyse MOBILE STRICTEMENT (le service ne renvoie que du 2G/3G/4G/5G) ;
//   - carte de filtres Opérateur → Technologie → Période → Réinitialiser qui
//     pilote le graphe de prévision ET le tableau en même temps ;
//   - tableau 13 colonnes, lignes d'anomalie cliquables → carte ;
//   - exports CSV / XLSX (tableau) et PNG (graphe de prévision).

const AIView = (() => {
  let built = false;
  let forecastChart = null;

  const BASE = CONFIG.API_BASE_URL + '/api/ai';

  // Le service IA tourne sur un hébergement gratuit (Render) : il s'endort
  // après quelques minutes d'inactivité, met 1 à 2 min à se réveiller, et
  // l'arête Render bride parfois les premières requêtes (HTTP 429). On
  // retente donc automatiquement au lieu d'afficher une erreur immédiate.
  const RETRY_DELAYS_MS = [6000, 12000];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getJson(path) {
    // 120 s par tentative : le service gratuit peut mettre ~60-90 s à se
    // réveiller au premier appel. En dessous, le chargement échouait.
    let lastErr = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const res = await fetch(BASE + path, { signal: AbortSignal.timeout(120_000) });
        if (res.ok) return res.json();
        const err = new Error(`HTTP ${res.status} sur ${path}`);
        err.retriable = res.status === 429 || res.status >= 500;
        throw err;
      } catch (e) {
        lastErr = e;
        // Réseau coupé ou délai dépassé (TypeError/AbortError) : ça peut
        // n'être que le réveil du service, on retente aussi.
        if (e.name === 'TypeError' || e.name === 'AbortError') e.retriable = true;
        if (attempt === RETRY_DELAYS_MS.length || !e.retriable) break;
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
    throw lastErr;
  }

  // ── État des filtres (une seule source, pour le graphe ET le tableau) ──────

  const state = { op: '__all__', tech: '', days: 30 };
  let ops = [];          // [{ value (brut pour l'API), label (ARCEP) }]
  let allAnomalies = []; // dernière réponse du service, non filtrée
  let healthError = false;

  function daysParam() {
    return state.days > 0 ? state.days : 365; // « Tout » : fenêtre maximale
  }
  function daysLabel() {
    return { 7: '7 j', 30: '30 j', 90: '90 j', 0: 'tout' }[state.days];
  }

  // Opérateur effectif du graphe : « Tous » → le premier de la liste
  // (la prévision porte sur UN opérateur, pas sur leur somme).
  function forecastOperator() {
    if (state.op !== '__all__') return state.op;
    return ops.length ? ops[0].value : '';
  }

  async function show() {
    if (built) return;
    built = true;
    // Message d'attente pendant le réveil éventuel du service.
    const wrap = document.querySelector('#chart-forecast')?.closest('.chart-wrap');
    if (wrap) setChartMessage('Chargement du service IA…<br>'
      + '<span style="color:#9aa3b2">(le premier appel peut prendre jusqu\'à 1 min)</span>');
    bindEvents();
    await loadHealth();
    loadAnomalies();
  }

  function setChartMessage(html) {
    const wrap = document.querySelector('#view-ai .chart-wrap');
    if (!wrap) return;
    wrap.innerHTML = `<div style="display:flex;height:100%;align-items:center;`
      + `justify-content:center;text-align:center;color:#5d6478;font-size:13px;`
      + `padding:0 20px;line-height:1.5">${html}</div>`;
  }

  // ── Carte de filtres ────────────────────────────────────────────────────────

  function bindEvents() {
    document.getElementById('ai-op-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.op = chip.dataset.op;
      refreshChips();
      renderTable();
      loadForecast();
    });

    document.getElementById('ai-tech-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.tech = chip.dataset.tech;
      refreshChips();
      renderTable();
      loadForecast();
    });

    document.getElementById('ai-period').addEventListener('click', (e) => {
      const btn = e.target.closest('.toggle');
      if (!btn) return;
      state.days = Number(btn.dataset.days);
      document.querySelectorAll('#ai-period .toggle').forEach((b) =>
        b.classList.toggle('active', b === btn));
      // Le KPI suit la période affichée dans son libellé.
      document.getElementById('ai-analyzed-label').textContent =
        `Mesures analysées (${daysLabel()})`;
      loadAnomalies();
    });

    document.getElementById('ai-reset').addEventListener('click', () => {
      state.op = '__all__';
      state.tech = '';
      state.days = 30;
      refreshChips();
      document.querySelectorAll('#ai-period .toggle').forEach((b) =>
        b.classList.toggle('active', b.dataset.days === '30'));
      document.getElementById('ai-analyzed-label').textContent =
        'Mesures analysées (30 j)';
      loadAnomalies();
      loadForecast();
    });

    // Ligne cliquable → carte (délégation : les lignes sont recréées à chaque
    // rendu). Même mécanique que l'Historique depuis le 12/11.
    document.querySelector('#ai-anomalies-table tbody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr.ai-row-geo');
      if (!tr) return;
      App.switchView('map');
      MapView.showMeasurement(
        parseFloat(tr.dataset.lat),
        parseFloat(tr.dataset.lng),
        tr.dataset.place || '',
      );
    });

    ['csv', 'xlsx', 'png'].forEach((fmt) => {
      document.getElementById(`ai-export-${fmt}`)
        .addEventListener('click', () => exportAs(fmt));
    });
  }

  function buildTechChips() {
    document.getElementById('ai-tech-chips').innerHTML =
      `<button class="chip${state.tech ? '' : ' active'}" data-tech="">Toutes</button>`
      + ['2G', '3G', '4G', '5G'].map((t) =>
        `<button class="chip${state.tech === t ? ' active' : ''}" data-tech="${t}">${t}</button>`).join('');
  }

  function refreshChips() {
    document.getElementById('ai-op-chips').innerHTML =
      `<button class="chip${state.op === '__all__' ? ' active' : ''}" data-op="__all__">Tous</button>`
      + ops.map((o) =>
        `<button class="chip${state.op === o.value ? ' active' : ''}" data-op="${escapeHtml(o.value)}">${escapeHtml(o.label)}</button>`).join('');
    buildTechChips();
  }

  // ── État du service + liste des opérateurs pour les chips ──────────────────

  async function loadHealth() {
    try {
      const h = await getJson('/health');
      // Libellés affichés conformes au référentiel ARCEP (le service les
      // renvoie déjà canoniques depuis le 13/11 ; on normalise par prudence).
      const seen = new Set();
      ops = [];
      (h.operators || []).forEach((op) => {
        const label = normalizeOperator(op);
        if (seen.has(label)) return;
        seen.add(label);
        ops.push({ value: op, label });
      });
      refreshChips();
      if (h.mlReady) loadForecast();
      else {
        // Modèle pas encore entraînable : on le dit au lieu de laisser le
        // message d'attente à l'infini.
        setChartMessage('Pas assez de mesures pour entraîner les modèles'
          + ` (${h.samples ?? 0} sur ${h.minSamplesForMl ?? 50} requis).<br>`
          + 'Les prochains tests APK complèteront la prévision.');
        document.getElementById('ai-forecast-info').textContent = 'Modèle en attente de mesures';
      }
    } catch {
      // État vide clair plutôt qu'un grand cadre blanc. L'hébergement gratuit
      // endort le service : un échec est presque toujours un réveil raté, pas
      // une absence de déploiement.
      healthError = true;
      setChartMessage('Le service IA ne répond pas pour le moment.<br>'
        + '<span style="color:#9aa3b2">Hébergement gratuit : il s\'endort après quelques minutes '
        + 'd\'inactivité et peut mettre 1 à 2 min à se réveiller — '
        + 'revenez sur cette page dans un instant.</span>');
    }
  }

  // ── Tableau des anomalies (13 colonnes, lignes cliquables) ─────────────────

  function severityColor(s) {
    if (s >= 70) return '#dc2626';
    if (s >= 40) return '#ea580c';
    return '#ca8a04';
  }

  async function loadAnomalies() {
    const tbody = document.querySelector('#ai-anomalies-table tbody');
    tbody.innerHTML = `<tr><td colspan="13" style="color:#5d6478">Analyse en cours…</td></tr>`;
    let data;
    try {
      data = await getJson(`/anomalies?days=${daysParam()}&limit=200`);
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="13" style="color:#e0492f">Erreur : ${escapeHtml(e.message)} — le service IA se réveille peut-être, revenez dans un instant.</td></tr>`;
      document.getElementById('ai-analyzed').textContent = '—';
      document.getElementById('ai-anomaly-count').textContent = '—';
      document.getElementById('ai-table-info').textContent = 'Service indisponible';
      return;
    }

    allAnomalies = data.anomalies || [];
    document.getElementById('ai-analyzed').textContent =
      (data.analyzed ?? 0).toLocaleString('fr-FR');
    renderTable();
  }

  // Filtres Opérateur et Technologie appliqués côté client (la période est
  // déjà côté service via days) : le graphe et le tableau restent synchro
  // sans rappeler le service à chaque clic.
  function filteredAnomalies() {
    const opLabel = state.op === '__all__' ? null
      : (ops.find((o) => o.value === state.op) || {}).label;
    return allAnomalies.filter((a) => {
      if (opLabel && normalizeOperator(a.operator) !== opLabel) return false;
      if (state.tech && String(a.tech || a.networkType || '').toUpperCase() !== state.tech) return false;
      return true;
    });
  }

  function renderTable() {
    const tbody = document.querySelector('#ai-anomalies-table tbody');
    const rows = filteredAnomalies();

    document.getElementById('ai-anomaly-count').textContent =
      rows.length.toLocaleString('fr-FR');
    document.getElementById('ai-table-info').textContent =
      `${rows.length.toLocaleString('fr-FR')} anomalie${rows.length > 1 ? 's' : ''}`
      + ` affichée${rows.length > 1 ? 's' : ''} — cliquez une ligne pour la carte`;

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="13" style="color:#5d6478">Aucune anomalie détectée sur la période. ✓</td></tr>';
      return;
    }

    // Décimales à la française (« 2,17 »), comme sur les autres vues.
    const fr1 = (v) => (v == null || v === ''
      ? '·'
      : Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 1 }));
    const int0 = (v) => (v == null || v === '' ? '·' : Number(v).toLocaleString('fr-FR'));
    // Libellés ARCEP : le service les renvoie déjà canoniques, on normalise
    // par prudence (anciennes données en cache, service non à jour…).
    const opLabel = (op) => normalizeOperator(op || 'Inconnu');

    tbody.innerHTML = rows.map((a) => {
      const date = a.timestamp
        ? new Date(a.timestamp).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '·';
      const tech = a.tech || a.networkType || '';
      const net = tech
        ? `<span class="net-badge" style="background:${networkColor(tech)}">${escapeHtml(tech)}</span>` : '·';
      const color = severityColor(a.severity);
      const op = opLabel(a.operator);
      const geo = a.lat != null && a.lng != null
        ? `ai-row-geo" data-lat="${a.lat}" data-lng="${a.lng}" data-place="${escapeHtml(a.location || '')}`
        : '';
      return `
        <tr class="${geo}">
          <td>${date}</td>
          <td><b style="color:${operatorColor(op)}">${escapeHtml(op)}</b></td>
          <td>${net}</td>
          <td>${escapeHtml(fr1(a.upload))}</td>
          <td><b>${escapeHtml(fr1(a.download))}</b></td>
          <td>${escapeHtml(fr1(a.ping))}${a.ping != null ? ' ms' : ''}</td>
          <td>${escapeHtml(fr1(a.jitter))}${a.jitter != null ? ' ms' : ''}</td>
          <td>${escapeHtml(int0(a.rsrp))}</td>
          <td>${escapeHtml(int0(a.rsrq))}</td>
          <td>${escapeHtml(a.device || '·')}</td>
          <td>${escapeHtml(formatPlace(a.location) || '·')}</td>
          <td><span class="q-pill" style="background:${color}22;color:${color}"><i style="background:${color}"></i>${a.severity}/100</span></td>
          <td style="max-width:420px">${(a.reasons || []).map(escapeHtml).join('<br>')}</td>
        </tr>`;
    }).join('');

    // Colonnes figées (13/11) : le décalage suit la largeur réelle de la Date.
    freezeFirstColumns(document.getElementById('ai-anomalies-table'));
  }

  // ── Courbe de prévision (pilotée par les chips) ─────────────────────────────

  async function loadForecast() {
    const operator = forecastOperator();
    if (!operator) return;
    const info = document.getElementById('ai-forecast-info');
    let data;
    try {
      const techno = state.tech ? `&network_type=${encodeURIComponent(state.tech)}` : '';
      data = await getJson(`/forecast?operator=${encodeURIComponent(operator)}&hours=48${techno}`);
    } catch {
      return;
    }
    const points = data.forecast || [];
    // Libellés ARCEP (la valeur brute vient de la base).
    const opShown = normalizeOperator(operator);
    const techShown = state.tech || 'toutes technologies';
    info.textContent = `${opShown} · ${techShown}`;

    if (!points.length) {
      setChartMessage(`Aucune prévision disponible pour ${escapeHtml(opShown)}`
        + (state.tech ? ` en ${escapeHtml(state.tech)}` : '')
        + '.<br><span style="color:#9aa3b2">Le modèle attend davantage de mesures pour ce contexte.</span>');
      return;
    }

    const labels = points.map((p) =>
      new Date(p.time).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit' }));

    // Le canvas a pu être remplacé par un message de chargement : on le rétablit.
    const wrap = document.querySelector('#view-ai .chart-wrap');
    let canvas = document.getElementById('chart-forecast');
    if (!canvas && wrap) {
      wrap.innerHTML = '<canvas id="chart-forecast"></canvas>';
      canvas = document.getElementById('chart-forecast');
    }
    if (forecastChart) forecastChart.destroy();
    forecastChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: `Débit ↓ prédit (Mb/s) — ${opShown} · ${techShown}`,
          data: points.map((p) => p.predictedDownload),
          borderColor: '#0e7a4a',
          backgroundColor: 'rgba(14, 122, 74, .12)',
          fill: true, tension: .35, pointRadius: 0,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Mb/s' } } },
      },
    });
  }

  // ── Exports CSV / XLSX / PNG (machinerie de l'Historique) ───────────────────
  // CSV et XLSX exportent la VUE COURANTE (toutes les anomalies filtrées, pas
  // une page) ; la PNG capture le graphe de prévision, comme l'export des
  // Statistiques capture son tableau.

  function dataset() {
    return {
      cols: ['Date', 'Opérateur', 'Techno', 'Envoi (Mb/s)', 'Tél. (Mb/s)',
        'Latence (ms)', 'Jitter (ms)', 'RSRP (dBm)', 'RSRQ (dB)', 'Appareil',
        'Lieu', 'Sévérité', 'Raisons'],
      rows: filteredAnomalies().map((a) => [
        a.timestamp ? new Date(a.timestamp).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '',
        normalizeOperator(a.operator || 'Inconnu'),
        a.tech || a.networkType || '',
        a.upload,
        a.download,
        a.ping,
        a.jitter,
        a.rsrp,
        a.rsrq,
        a.device || '',
        formatPlace(a.location) || '·',
        `${a.severity}/100`,
        (a.reasons || []).join(' | '),
      ]),
    };
  }

  function exportFileNames(ext) {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `analyse-ia-${day}.${ext}`;
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
      cd.setUint16(12, 0, true);
      cd.setUint32(16, e.crc, true);
      cd.setUint32(20, e.size, true);
      cd.setUint32(24, e.size, true);
      cd.setUint16(28, e.nameBytes.length, true);
      cd.setUint16(30, 0, true);
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

  // La PNG capture le graphe de prévision affiché (canvas Chart.js), à la
  // demande du 13/11 — pas un rendu du tableau.
  function chartPngBlob() {
    if (!forecastChart) return Promise.resolve(null);
    const dataUrl = forecastChart.toBase64Image('image/png', 1);
    const bin = atob(dataUrl.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return Promise.resolve(new Blob([bytes], { type: 'image/png' }));
  }

  async function exportAs(format) {
    if (format === 'png') {
      const blob = await chartPngBlob();
      if (!blob) { App.toast('La prévision n\'est pas affichée : rien à exporter en PNG.'); return; }
      downloadBlob(blob, exportFileNames('png'));
      App.toast('Graphe de prévision exporté (PNG).');
      return;
    }

    const ds = dataset();
    if (!ds.rows.length) { App.toast('Aucune anomalie à exporter pour ces filtres.'); return; }
    const fmt = (v) => v == null || v === '' ? '—'
      : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1).replace('.', ','))
      : String(v);
    if (format === 'csv') {
      // BOM UTF-8 + point-virgule : s'ouvre proprement dans Excel FR/LibreOffice.
      const csv = '\uFEFF' + [ds.cols.join(';')]
        .concat(ds.rows.map((r) => r.map(fmt).join(';')))
        .join('\r\n');
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), exportFileNames('csv'));
    } else {
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // Cellule : nombre en type natif, texte en inlineStr, null = « — ».
      const cell = (v, r, c) => {
        if (v == null || v === '') return `<c r="${r}${c}" t="inlineStr"><is><t>—</t></is></c>`;
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
          + `<sheets><sheet name="Analyse IA" sheetId="1" r:id="rId1"/></sheets></workbook>`],
        ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
          + '</Relationships>'],
        ['xl/worksheets/sheet1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`],
      ];
      downloadBlob(zipStore(parts), exportFileNames('xlsx'));
    }
    App.toast(`${ds.rows.length.toLocaleString('fr-FR')} anomalie${ds.rows.length > 1 ? 's' : ''} exportée${ds.rows.length > 1 ? 's' : ''} (${format.toUpperCase()}).`);
  }

  return { show };
})();
