// ─── Vue Prévision : qualité attendue point par point à Ouagadougou ──────────
// Modèle tiré de l'étude « Impact de la météo, du relief, de la fréquence et de
// la population sur les réseaux mobiles » :
//   débit prévu = capacité du lieu × facteur de charge (heure) × facteur météo
// - capacité du lieu : mesures mobiles Yélé voisines, ramenées à une heure
//   « neutre » (on retire l'effet de l'heure où chaque test a été fait) ;
// - charge : la population connectée fait varier le débit par utilisateur
//   (débit ≈ capacité de la cellule / nombre d'utilisateurs actifs) ; profil
//   horaire a priori (pointes midi et soir) corrigé par les mesures ;
// - météo (Open-Meteo, sans clé) : la pluie n'affecte pas les fréquences
//   mobiles (< 6 GHz) mais dégrade les faisceaux hertziens de collecte
//   (tableau 20 de l'étude), les orages coupent des sites (alimentation),
//   la chaleur fait surchauffer les équipements.

const Forecast = (() => {
  const OUAGA = { lat: 12.3714, lng: -1.5197 };
  const OUAGA_BOUNDS = [[12.25, -1.65], [12.48, -1.40]];
  const CITY_VIEW = [[12.31, -1.58], [12.43, -1.45]];
  const CELL_DEG = 0.0025;          // ≈ 275 m : taille d'un « point » de prévision
  const NEIGHBOR_SIGMA_M = 400;     // portée de l'influence d'une mesure
  const NEIGHBOR_MAX_M = 1200;
  const HOURS = 48;
  const WEATHER_TTL_MS = 30 * 60 * 1000;

  // Couleurs identiques à la couche « Débit » de la carte principale.
  const SPEED_CLASSES = [
    { max: 3, color: '#d7191c', label: '< 3 Mb/s' },
    { max: 8, color: '#fdae61', label: '3 – 8' },
    { max: 30, color: '#a6d96a', label: '8 – 30' },
    { max: 100, color: '#1a9641', label: '30 – 100' },
    { max: Infinity, color: '#0b5d2c', label: '> 100 Mb/s' },
  ];
  const speedClass = (dl) => SPEED_CLASSES.find((c) => dl < c.max) || SPEED_CLASSES[0];

  // Profil de charge a priori (1 = charge moyenne). Nuit peu chargée, pointes
  // à midi et en soirée, quand la population connectée est la plus nombreuse.
  const PRIOR_LOAD = [1.25, 1.3, 1.3, 1.3, 1.25, 1.2, 1.1, 1.0, 0.95, 0.95, 0.95, 0.9,
    0.85, 0.85, 0.9, 0.95, 0.95, 0.9, 0.8, 0.75, 0.75, 0.8, 0.9, 1.05];
  const PRIOR_WEIGHT = 30; // nombre de mesures « virtuelles » données au profil a priori

  // Pluie → perte de capacité d'un faisceau hertzien (tableau 20, 20 GHz, 5 km).
  const RAIN_STEPS = [
    { max: 58, loss: 0 }, { max: 77, loss: 0.2 }, { max: 96, loss: 0.4 },
    { max: 113, loss: 0.6 }, { max: 133, loss: 0.8 }, { max: Infinity, loss: 1 },
  ];
  const MICROWAVE_SHARE = 0.5; // part supposée des sites collectés par faisceau hertzien
  const PEAK_TO_HOURLY = 3;    // une averse sahélienne culmine ≈ 3× son cumul horaire
  const STORM_FACTOR = 0.85;   // coupures d'alimentation pendant les orages
  const HEAT_C = 40;
  const HEAT_FACTOR = 0.95;

  const state = { operator: '', tech: '', hour: 0, inited: false };
  let map = null;
  let layer = null;
  let samples = [];     // mesures mobiles de Ouaga, normalisées
  let loadByHour = PRIOR_LOAD.slice();
  let weather = null;   // { times[], rain[], code[], temp[], fetchedAt }

  // ── Données ────────────────────────────────────────────────────────────────

  const MOBILE_TECH = /^(2G|3G|4G|5G|MOBILE)$/i;

  function mobileOperator(p) {
    // Libellés conformes à l'app (référentiel ARCEP, demande du 10/11).
    const pick = (s) => {
      s = (s || '').toLowerCase();
      if (/orange|61302/.test(s)) return 'Orange BF SA';
      if (/telecel|61303/.test(s)) return 'Telecel Faso SA';
      if (/moov|onatel|telmob|61301/.test(s)) return 'Moov Africa SA';
      return null;
    };
    return pick(p.simOperator) || pick(p.operator);
  }

  function techOf(p) {
    const t = (p.cellularTech || p.networkType || '').toUpperCase();
    return /^[2-5]G$/.test(t) ? t : '';
  }

  function inOuaga(p) {
    return p.lat >= OUAGA_BOUNDS[0][0] && p.lat <= OUAGA_BOUNDS[1][0] &&
      p.lng >= OUAGA_BOUNDS[0][1] && p.lng <= OUAGA_BOUNDS[1][1];
  }

  // Facteur de charge par heure : profil a priori corrigé par les mesures.
  // Les mesures de chaque heure sont comparées à la médiane globale ; le
  // poids du profil a priori l'emporte quand une heure compte peu de tests.
  function buildLoadProfile(points) {
    const all = points.map((p) => p.download).sort((a, b) => a - b);
    const globalMedian = median(all);
    const byHour = Array.from({ length: 24 }, () => []);
    points.forEach((p) => byHour[p.hour].push(p.download));
    const raw = byHour.map((vals, h) => {
      if (!vals.length || !globalMedian) return PRIOR_LOAD[h];
      const emp = Math.min(1.8, Math.max(0.4, median(vals.sort((a, b) => a - b)) / globalMedian));
      return (vals.length * emp + PRIOR_WEIGHT * PRIOR_LOAD[h]) / (vals.length + PRIOR_WEIGHT);
    });
    // Lissage sur 3 heures, puis moyenne ramenée à 1.
    const smooth = raw.map((v, h) => (raw[(h + 23) % 24] + 2 * v + raw[(h + 1) % 24]) / 4);
    const mean = smooth.reduce((s, v) => s + v, 0) / 24;
    return smooth.map((v) => v / mean);
  }

  async function loadSamples() {
    const points = await API.mapPoints();
    const mobile = points
      .filter((p) => p.lat && p.lng && inOuaga(p) && MOBILE_TECH.test(p.networkType || '') && p.download > 0)
      .map((p) => {
        const d = parseTs(p.timestamp);
        return {
          lat: p.lat, lng: p.lng,
          operator: mobileOperator(p),
          tech: techOf(p),
          download: p.download,
          upload: p.upload > 0 ? p.upload : null,
          ping: p.ping > 0 ? p.ping : null,
          hour: isNaN(d) ? 12 : d.getHours(),
        };
      });
    loadByHour = buildLoadProfile(mobile);
    // Valeurs « heure neutre » : on retire l'effet de charge de l'heure du test.
    mobile.forEach((s) => {
      const f = loadByHour[s.hour];
      s.dlN = s.download / f;
      s.ulN = s.upload != null ? s.upload / f : null;
      s.pingN = s.ping != null ? s.ping * f : null;
    });
    samples = mobile;
  }

  async function loadWeather() {
    if (weather && Date.now() - weather.fetchedAt < WEATHER_TTL_MS) return;
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + OUAGA.lat +
      '&longitude=' + OUAGA.lng +
      '&hourly=precipitation,weather_code,temperature_2m&forecast_days=3&timezone=Africa%2FOuagadougou';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      // Ouagadougou est à UTC+0 : l'heure locale est l'heure UTC.
      const nowKey = new Date().toISOString().slice(0, 13);
      let start = j.hourly.time.findIndex((t) => t.slice(0, 13) >= nowKey);
      if (start < 0) start = 0;
      const cut = (arr) => arr.slice(start, start + HOURS);
      weather = {
        times: cut(j.hourly.time), rain: cut(j.hourly.precipitation),
        code: cut(j.hourly.weather_code), temp: cut(j.hourly.temperature_2m),
        fetchedAt: Date.now(),
      };
    } catch (e) {
      console.warn('Open-Meteo indisponible', e);
      const t0 = new Date(); t0.setUTCMinutes(0, 0, 0);
      weather = {
        times: Array.from({ length: HOURS }, (_, i) =>
          new Date(t0.getTime() + i * 3600e3).toISOString().slice(0, 16)),
        rain: [], code: [], temp: [], fetchedAt: Date.now(), failed: true,
      };
    }
  }

  // ── Modèle ─────────────────────────────────────────────────────────────────

  function weatherAt(i) {
    const rain = weather.rain[i] || 0;
    const code = weather.code[i] || 0;
    const temp = weather.temp[i];
    const peak = rain * PEAK_TO_HOURLY;
    const loss = RAIN_STEPS.find((s) => peak < s.max).loss;
    const rainFactor = 1 - MICROWAVE_SHARE * loss;
    const storm = code >= 95;
    const heat = temp != null && temp > HEAT_C;
    const factor = rainFactor * (storm ? STORM_FACTOR : 1) * (heat ? HEAT_FACTOR : 1);
    return { rain, peak, code, temp, storm, heat, rainFactor, factor };
  }

  function hourOf(i) {
    return +weather.times[i].slice(11, 13);
  }

  function filtered() {
    return samples.filter((s) =>
      (!state.operator || s.operator === state.operator) &&
      (!state.tech || s.tech === state.tech));
  }

  const toRad = (d) => (d * Math.PI) / 180;
  function distM(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng) * Math.cos(toRad((a.lat + b.lat) / 2));
    return 6371000 * Math.sqrt(dLat * dLat + dLng * dLng);
  }

  // Capacité d'un lieu : moyenne géométrique pondérée (noyau gaussien) des
  // mesures voisines, en valeurs « heure neutre ».
  function capacityAt(pos, pool) {
    let w = 0; let lDl = 0; let wUl = 0; let lUl = 0; let wPing = 0; let sPing = 0;
    let n = 0; let nNear = 0; let nearest = Infinity;
    pool.forEach((s) => {
      const d = distM(pos, s);
      if (d > NEIGHBOR_MAX_M) return;
      const k = Math.exp(-(d * d) / (2 * NEIGHBOR_SIGMA_M * NEIGHBOR_SIGMA_M));
      n += 1; if (d <= 300) nNear += 1; nearest = Math.min(nearest, d);
      w += k; lDl += k * Math.log(s.dlN);
      if (s.ulN) { wUl += k; lUl += k * Math.log(s.ulN); }
      if (s.pingN) { wPing += k; sPing += k * s.pingN; }
    });
    if (!n || w < 1e-6) return null;
    return {
      dl: Math.exp(lDl / w),
      ul: wUl ? Math.exp(lUl / wUl) : null,
      ping: wPing ? sPing / wPing : null,
      n, nNear, nearest,
      confidence: nNear >= 5 ? 'Élevée' : nNear >= 2 || n >= 5 ? 'Moyenne' : 'Faible',
    };
  }

  function predict(cap, i) {
    const load = loadByHour[hourOf(i)];
    const met = weatherAt(i);
    const f = load * met.factor;
    return {
      dl: cap.dl * f,
      ul: cap.ul != null ? cap.ul * f : null,
      ping: cap.ping != null ? cap.ping / load : null,
      load, met,
    };
  }

  // ── Rendu ──────────────────────────────────────────────────────────────────

  const fmt = (v, d = 1) => (v == null ? '—' : v.toLocaleString('fr-FR', { maximumFractionDigits: d }));
  const DAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  function timeLabel(i) {
    const t = weather.times[i];
    const d = new Date(t + ':00Z');
    return DAYS[d.getUTCDay()] + ' ' + t.slice(8, 10) + '/' + t.slice(5, 7) + ' · ' + t.slice(11, 13) + ' h';
  }

  function loadLabel(load) {
    if (load >= 1.15) return 'réseau peu chargé';
    if (load >= 0.95) return 'charge moyenne';
    if (load >= 0.82) return 'réseau chargé';
    return 'heure de pointe';
  }

  function weatherText(met) {
    if (weather.failed) return 'Météo indisponible (non prise en compte)';
    const parts = [];
    parts.push(met.rain > 0 ? 'pluie ' + fmt(met.rain) + ' mm/h' : 'pas de pluie');
    if (met.temp != null) parts.push(fmt(met.temp, 0) + ' °C');
    if (met.storm) parts.push('orage');
    return parts.join(' · ');
  }

  function sparkline(cap) {
    const W = 240; const H = 56; const pad = 4;
    const vals = weather.times.map((_, i) => predict(cap, i).dl);
    const max = Math.max(...vals, 2.5);
    const x = (i) => pad + (i * (W - 2 * pad)) / (vals.length - 1);
    const y = (v) => H - pad - (v / max) * (H - 2 * pad);
    const pts = vals.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    const cur = state.hour;
    return `<svg class="fc-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      <line x1="${pad}" x2="${W - pad}" y1="${y(2)}" y2="${y(2)}" class="fc-spark-arcep"/>
      <polyline points="${pts}" class="fc-spark-line"/>
      <circle cx="${x(cur)}" cy="${y(vals[cur])}" r="3.5" class="fc-spark-dot"/>
    </svg>
    <div class="fc-spark-legend"><span>maintenant</span><span>pointillé : seuil ARCEP 4G (2 Mb/s)</span><span>+48 h</span></div>`;
  }

  function popupHtml(cap, title) {
    const p = predict(cap, state.hour);
    const arcep = p.dl > 2 && (p.ul == null || p.ul > 1);
    const met = p.met;
    const warn = [];
    if (met.storm) warn.push('Orage annoncé : risque de coupure de sites (alimentation électrique).');
    if (met.rainFactor < 1) warn.push('Forte pluie : faisceaux hertziens de collecte dégradés.');
    if (met.heat) warn.push('Plus de ' + HEAT_C + ' °C : risque de surchauffe des équipements.');
    return `<div class="fc-popup">
      <div class="fc-popup-title">${escapeHtml(title)}</div>
      <div class="fc-popup-when">${timeLabel(state.hour)}</div>
      <div class="fc-popup-main" style="color:${speedClass(p.dl).color}">${fmt(p.dl)} <small>Mb/s attendus</small></div>
      <div class="fc-popup-row">Envoi ${fmt(p.ul)} Mb/s · Latence ${fmt(p.ping, 0)} ms</div>
      <div class="fc-popup-row ${arcep ? 'ok' : 'ko'}">${arcep ? 'Conforme' : 'Sous'} le seuil ARCEP 4G (2 / 1 Mb/s)</div>
      ${sparkline(cap)}
      <table class="fc-factors">
        <tr><td>Capacité mesurée</td><td>${fmt(cap.dl)} Mb/s</td></tr>
        <tr><td>Charge (${loadLabel(p.load)})</td><td>× ${fmt(p.load, 2)}</td></tr>
        <tr><td>Météo (${weatherText(met)})</td><td>× ${fmt(met.factor, 2)}</td></tr>
        <tr><td>Fiabilité</td><td>${cap.confidence} · ${cap.n} mesure${cap.n > 1 ? 's' : ''}</td></tr>
      </table>
      ${warn.map((w) => `<div class="fc-warn">${w}</div>`).join('')}
    </div>`;
  }

  function render() {
    if (!map) return;
    layer.clearLayers();
    const pool = filtered();
    const cells = new Map();
    pool.forEach((s) => {
      const key = Math.floor(s.lat / CELL_DEG) + ':' + Math.floor(s.lng / CELL_DEG);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(s);
    });
    let ok = 0;
    cells.forEach((list, key) => {
      const [a, b] = key.split(':').map(Number);
      const center = { lat: (a + 0.5) * CELL_DEG, lng: (b + 0.5) * CELL_DEG };
      const cap = capacityAt(center, pool);
      if (!cap) return;
      const p = predict(cap, state.hour);
      if (p.dl > 2) ok += 1;
      const c = speedClass(p.dl);
      L.circleMarker([center.lat, center.lng], {
        radius: 9 + Math.min(list.length, 12) * 0.5,
        color: c.color, weight: cap.confidence === 'Faible' ? 1 : 2,
        dashArray: cap.confidence === 'Faible' ? '4 4' : null,
        fillColor: c.color, fillOpacity: cap.confidence === 'Élevée' ? 0.85 : 0.6,
      }).bindPopup(() => popupHtml(cap, list.length + ' mesure' + (list.length > 1 ? 's' : '') + ' dans ce carré'), { maxWidth: 280 })
        .addTo(layer);
    });
    renderSummary(cells.size, ok);
  }

  function renderSummary(nCells, nOk) {
    const met = weatherAt(state.hour);
    document.getElementById('fc-time').textContent = timeLabel(state.hour);
    document.getElementById('fc-weather').innerHTML =
      escapeHtml(weatherText(met)) + '<br>Charge : ' + loadLabel(loadByHour[hourOf(state.hour)]) +
      (met.storm ? '<br><b class="fc-alert">Orage : risque de coupures</b>' : '');
    document.getElementById('fc-count').textContent = nCells
      ? nOk + ' point' + (nOk > 1 ? 's' : '') + ' sur ' + nCells + ' au-dessus de 2 Mb/s'
      : 'Aucune mesure pour ce filtre';
  }

  function buildChips(boxId, values, key) {
    const box = document.getElementById(boxId);
    box.innerHTML = '';
    [['', 'Tous']].concat(values.map((v) => (Array.isArray(v) ? v : [v, v]))).forEach(([val, label]) => {
      const b = document.createElement('button');
      b.className = 'chip' + (state[key] === val ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        state[key] = val;
        box.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === b));
        render();
      });
      box.appendChild(b);
    });
  }

  function initMap() {
    map = L.map('forecast-map', { zoomControl: false, minZoom: 11, maxBounds: [[12.15, -1.8], [12.6, -1.25]] })
      .setView([OUAGA.lat, OUAGA.lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 18,
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    layer = L.layerGroup().addTo(map);
    // Prévision en n'importe quel lieu : clic sur la carte.
    map.on('click', (e) => {
      const cap = capacityAt({ lat: e.latlng.lat, lng: e.latlng.lng }, filtered());
      const html = cap ? popupHtml(cap, 'Lieu choisi')
        : '<div class="fc-popup"><b>Pas de mesure à moins de 1,2 km.</b><br>La prévision a besoin de tests Yélé à proximité.</div>';
      L.popup({ maxWidth: 280 }).setLatLng(e.latlng).setContent(html).openOn(map);
    });
  }

  async function show() {
    if (!state.inited) {
      state.inited = true;
      initMap();
      const slider = document.getElementById('fc-hour');
      slider.addEventListener('input', () => { state.hour = +slider.value; render(); });
      const loading = document.getElementById('fc-loading');
      loading.style.display = 'block';
      try {
        await Promise.all([loadSamples(), loadWeather()]);
        slider.max = weather.times.length - 1;
        buildChips('fc-operators', ['Orange BF SA', 'Telecel Faso SA', 'Moov Africa SA'], 'operator');
        buildChips('fc-techs', ['4G', '3G', '2G'], 'tech');
        document.getElementById('fc-samples').textContent = samples.length;
        loading.style.display = 'none';
        render();
      } catch (e) {
        loading.innerHTML = 'Impossible de charger les mesures.<small>' + escapeHtml(e.message) + '</small>';
      }
    } else {
      await loadWeather();
      render();
    }
    setTimeout(() => {
      if (!map) return;
      map.invalidateSize();
      // Premier affichage : la carte était cachée à sa création, on cadre la ville maintenant.
      if (!state.framed) { state.framed = true; map.fitBounds(CITY_VIEW); }
    }, 50);
  }

  function median(sorted) {
    if (!sorted.length) return 0;
    const m = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  }

  return { show };
})();
