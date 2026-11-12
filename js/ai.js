// ─── Vue Analyse IA : anomalies détectées + prévision de qualité ─────────────
// Consomme le micro-service IA via le proxy du backend : /api/ai/*
// Le service (Render gratuit) s'endort après inactivité : chaque appel passe
// par getJson(), qui retente automatiquement sur 429/5xx ou coupure réseau.

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

  async function show() {
    if (built) return;
    built = true;
    // Message d'attente pendant le réveil éventuel du service.
    const wrap = document.querySelector('#chart-forecast')?.closest('.chart-wrap');
    if (wrap) {
      wrap.innerHTML = '<div style="display:flex;height:100%;align-items:center;'
        + 'justify-content:center;text-align:center;color:#5d6478;font-size:13px;'
        + 'padding:0 20px;line-height:1.5">Chargement du service IA…<br>'
        + '<span style="color:#9aa3b2">(le premier appel peut prendre jusqu\'à 1 min)</span></div>';
    }
    await loadHealth();
    loadAnomalies();
  }

  // ── État du service + liste des opérateurs pour la prévision ───────────────

  async function loadHealth() {
    try {
      const h = await getJson('/health');
      const sel = document.getElementById('ai-forecast-operator');
      sel.innerHTML = '';
      // Libellés affichés conformes au référentiel ARCEP (les opérateurs
      // viennent de la base, avec d'anciens noms : « ONATEL / Telmob »,
      // « Orange Burkina Faso ») ; la VALEUR reste le libellé brut que le
      // service attend dans /forecast.
      const seen = new Set();
      (h.operators || []).forEach((op) => {
        const label = normalizeOperator(op);
        if (seen.has(label)) return;
        seen.add(label);
        sel.add(new Option(label, op));
      });
      sel.addEventListener('change', () => loadForecast(sel.value));
      if (h.mlReady && sel.value) loadForecast(sel.value);
      else if (!h.mlReady) {
        // Modèle pas encore entraînable : on le dit au lieu de laisser le
        // message d'attente à l'infini.
        const wrap = document.querySelector('#chart-forecast')?.closest('.chart-wrap');
        if (wrap) {
          wrap.innerHTML = '<div style="display:flex;height:100%;align-items:center;'
            + 'justify-content:center;text-align:center;color:#9aa3b2;font-size:13px;'
            + 'padding:0 20px;line-height:1.5">Pas assez de mesures pour entraîner les modèles'
            + ` (${h.samples ?? 0} sur ${h.minSamplesForMl ?? 50} requis).<br>`
            + 'Les prochains tests APK complèteront la prévision.</div>';
        }
      }
    } catch (e) {
      // État vide clair plutôt qu'un grand cadre blanc. L'hébergement gratuit
      // endort le service : un échec est presque toujours un réveil raté, pas
      // une absence de déploiement.
      const wrap = document.querySelector('#chart-forecast')?.closest('.chart-wrap');
      if (wrap) {
        wrap.innerHTML = '<div style="display:flex;height:100%;align-items:center;'
          + 'justify-content:center;text-align:center;color:#9aa3b2;font-size:13px;'
          + 'padding:0 20px;line-height:1.5">Le service IA ne répond pas pour le moment.<br>'
          + '<span style="color:#9aa3b2">Hébergement gratuit : il s\'endort après quelques minutes '
          + 'd\'inactivité et peut mettre 1 à 2 min à se réveiller — '
          + 'revenez sur cette page dans un instant.</span></div>';
      }
    }
  }

  // ── Tableau des anomalies ───────────────────────────────────────────────────

  function severityColor(s) {
    if (s >= 70) return '#dc2626';
    if (s >= 40) return '#ea580c';
    return '#ca8a04';
  }

  async function loadAnomalies() {
    const tbody = document.querySelector('#ai-anomalies-table tbody');
    tbody.innerHTML = '<tr><td colspan="7" style="color:#5d6478">Analyse en cours…</td></tr>';
    let data;
    try {
      data = await getJson('/anomalies?days=30&limit=100');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" style="color:#e0492f">Erreur : ${escapeHtml(e.message)} — le service IA se réveille peut-être, revenez dans un instant.</td></tr>`;
      // Les deux cartes restent à « · » tant qu'aucune réponse : on les passe
      // à « — » pour ne pas laisser croire à un chargement en cours.
      document.getElementById('ai-analyzed').textContent = '—';
      document.getElementById('ai-anomaly-count').textContent = '—';
      return;
    }

    document.getElementById('ai-analyzed').textContent =
      (data.analyzed ?? 0).toLocaleString('fr-FR');
    document.getElementById('ai-anomaly-count').textContent =
      (data.anomalies?.length ?? 0).toLocaleString('fr-FR');

    if (!data.anomalies?.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="color:#5d6478">Aucune anomalie détectée sur la période. ✓</td></tr>';
      return;
    }

    // Décimales à la française (« 2,17 »), comme sur les autres vues.
    const fr1 = (v) => (v == null || v === ''
      ? '·'
      : Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 1 }));
    // Libellés ARCEP : la base contient d'anciens noms (« ONATEL / Telmob »,
    // « Orange Burkina Faso »), on affiche le libellé du référentiel.
    const opLabel = (op) => normalizeOperator(op || 'Inconnu');

    tbody.innerHTML = data.anomalies.map((a) => {
      const date = a.timestamp
        ? new Date(a.timestamp).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '·';
      const net = a.networkType
        ? `<span class="net-badge" style="background:${networkColor(a.networkType)}">${escapeHtml(a.networkType)}</span>` : '·';
      const color = severityColor(a.severity);
      const op = opLabel(a.operator);
      return `
        <tr>
          <td>${date}</td>
          <td><b style="color:${operatorColor(op)}">${escapeHtml(op)}</b></td>
          <td>${net}</td>
          <td><b>${escapeHtml(fr1(a.download))}</b></td>
          <td>${escapeHtml(fr1(a.ping))} ms</td>
          <td><span class="q-pill" style="background:${color}22;color:${color}"><i style="background:${color}"></i>${a.severity}/100</span></td>
          <td style="max-width:420px">${(a.reasons || []).map(escapeHtml).join('<br>')}</td>
        </tr>`;
    }).join('');
  }

  // ── Courbe de prévision ─────────────────────────────────────────────────────

  async function loadForecast(operator) {
    if (!operator) return;
    let data;
    try {
      data = await getJson(`/forecast?operator=${encodeURIComponent(operator)}&hours=48`);
    } catch {
      return;
    }
    const points = data.forecast || [];
    if (!points.length) return;

    const labels = points.map((p) =>
      new Date(p.time).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit' }));
    // Légende avec le libellé ARCEP (la valeur brute vient de la base).
    const opShown = normalizeOperator(operator || 'Inconnu');

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
          label: `Débit ↓ prédit (Mb/s) pour ${opShown}`,
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

  return { show };
})();
