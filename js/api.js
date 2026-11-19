// ─── Client API du backend Yélé (speedtest-go + MongoDB) ────────────────────

const API = (() => {
  const BASE = CONFIG.API_BASE_URL;

  // Cache À DURÉE LIMITÉE. Il ne portait auparavant aucune expiration : une
  // fois la carte chargée, le tableau de bord ne réinterrogeait plus jamais le
  // serveur, et un onglet laissé ouvert affichait indéfiniment l'état du
  // premier chargement. C'est la cause principale du délai d'apparition des
  // mesures constaté par les agents.
  const cache = {};        // path -> { data, at }

  // 120 s : sur l'offre gratuite Render, le service s'endort après 15 min et met
  // ~60-90 s à se réveiller. Pendant ce réveil, Render renvoie sa propre page
  // d'erreur 502/503, sans les en-têtes CORS du backend Go — le navigateur
  // signale alors une « erreur CORS » trompeuse. D'où le timeout long + les
  // tentatives successives ci-dessous.
  const TIMEOUT_MS = 120_000;
  const RETRIES = 2;

  // Durée de validité d'une réponse en cache.
  const CACHE_TTL_MS = (CONFIG.REFRESH_SECONDS || 60) * 1000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function get(path, { useCache = true } = {}) {
    const hit = cache[path];
    if (useCache && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

    let lastError;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (attempt > 0) await sleep(2000 * attempt); // 2 s puis 4 s
      try {
        const res = await fetch(BASE + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        // 502/503 = backend encore en cours de réveil : on retente.
        if (res.status === 502 || res.status === 503) {
          lastError = new Error(`Serveur indisponible (HTTP ${res.status})`);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} sur ${path}`);
        const data = await res.json();
        if (useCache) cache[path] = { data, at: Date.now() };
        return data;
      } catch (e) {
        // Erreur réseau ou timeout (réveil du service) : on retente.
        // Les autres erreurs (HTTP 4xx, JSON invalide) ne sont pas transitoires.
        if (e.name !== 'TypeError' && e.name !== 'TimeoutError' && e.name !== 'AbortError') throw e;
        lastError = e;
      }
    }
    throw new Error(
      'Le serveur ne répond pas. S\'il était en veille, il peut mettre '
      + 'jusqu\'à une minute à redémarrer : réessayez dans un instant. '
      + `(${lastError?.message || 'échec réseau'})`
    );
  }

  return {
    /// Vide le cache : le prochain appel repart du serveur. Utilisé par le
    /// bouton d'actualisation et par le rafraîchissement automatique.
    invalidate() {
      Object.keys(cache).forEach((k) => delete cache[k]);
    },

    // KPIs globaux : { totalTests, avgDownload, avgUpload, avgPing, testsToday }
    summary: () => get('/api/dashboard/summary'),

    // Points géolocalisés : [{ lat, lng, operator, networkType, download, upload, ping, location, timestamp }]
    mapPoints: () => get('/api/dashboard/map'),

    // Couche « Qualité perçue » : uniquement les tests évalués, avec le détail
    // des réponses (satisfaction, note, coupures vidéo…).
    qoeMap: () => get('/api/dashboard/map?usage=qoe'),

    // Agrégats « Qualité perçue » : satisfaction, profil, améliorations.
    // { reseau, operator, tech, period } — period = hour|day|week|month|year|all.
    qoe: ({ reseau = '', operator = '', tech = '', period = '', from = '', to = '' } = {}) => {
      const params = new URLSearchParams();
      if (reseau) params.set('reseau', reseau);
      if (operator) params.set('operator', operator);
      if (tech) params.set('tech', tech);
      if (period) params.set('period', period);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      return get(`/api/dashboard/qoe?${params}`, { useCache: false });
    },

    // Heatmap : [{ lat, lng, intensity, download }]
    heatmap: () => get('/api/dashboard/heatmap'),

    // Stats par opérateur : [{ operator, count, avgDownload, avgUpload, avgPing }]
    operators: () => get('/api/dashboard/operators'),

    // Percentiles : [{ operator, count, avgDownload, p25Download, p50Download, p75Download, p90Download, avgUpload, avgPing, p50Ping }]
    advancedStats: () => get('/api/dashboard/stats/advanced'),

    // Série temporelle : [{ date, count, avgDownload }]
    timeline: (days = 30) => get(`/api/dashboard/timeline?days=${days}`),

    // Résultats paginés : { data: [...], total, page, limit }
    results: ({ page = 1, limit = 20, operator = '', network = '', from = '', to = '' } = {}) => {
      const params = new URLSearchParams({ page, limit });
      if (operator) params.set('operator', operator);
      if (network) params.set('network', network);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      return get(`/api/dashboard/results?${params}`, { useCache: false });
    },

    // Géocodage d'adresse (OpenStreetMap Nominatim).
    // `countrycodes=bf` restreint les résultats au Burkina Faso : la carte ne
    // couvrant que le pays, proposer une adresse étrangère mènerait à une
    // impasse.
    async geocode(query) {
      const url = 'https://nominatim.openstreetmap.org/search?format=json&countrycodes=bf&limit=5&q='
        + encodeURIComponent(query);
      const res = await fetch(url, { headers: { 'Accept-Language': 'fr' } });
      if (!res.ok) return [];
      return res.json();
    },
  };
})();
