// ─── Vue Carte : carte plein écran style ARCEP ───────────────────────────────

const MapView = (() => {
  let map = null;
  let markersLayer = null;
  let heatLayer = null;
  let allPoints = [];
  let countryBounds = null;

  const state = {
    // Flux façon nPerf inversé (demande 10/11) : 1) on choisit le RÉSEAU
    // (mobile/fixe), 2) l'OPÉRATEUR — par défaut « Tous les opérateurs »
    // (la carte affiche d'emblée tout le réseau, comme sur l'app), 3) le
    // type de carte (débit/latence/…, l'équivalent nPerf de coverage/
    // bitrate). La technologie et la période affinent ensuite.
    netType: 'mobile',      // mobile | fixe
    operator: '__all__',    // '__all__' = tous les opérateurs | nom canonique
    mapType: 'global',      // global | coverage | dl | ul | ping | streaming | browsing : ce que la couleur montre
    tech: '',               // '' = toutes (mobile uniquement)
    mode: 'points',        // points | heatmap : les points de test sont le mode
                           // par défaut — c'est la vue d'ensemble lisible ; la
                           // chaleur reste un choix explicite (le HTML coche
                           // d'ailleurs « Points de test » au chargement).
    base: 'plan',           // plan | satellite
    // Lieu (quartier dérivé des libellés géocodés) : '' = tous. La liste se
    // remplit au fil des tests, comme les FAI.
    lieu: '',
    // Période : grain = filtre AFFICHÉ (sert aussi de granularité à la
    // ventilation des popups) ; values = filtres de période ACTIFS, cumulables
    // et indépendants du grain affiché — clé = grain
    // ('year'|'month'|'week'|'day'|'hour'), valeur = clé du point
    // ('YYYY' / 'YYYY-MM' / 'YYYY-MM-DD' / 0-23). Choisir 2025 restreint
    // ainsi les mois proposés à 2025, choisir janvier restreint les semaines
    // à janvier — et le filtre de niveau supérieur reste actif (badges).
    period: { grain: 'all', values: {} },
  };

  // Raccourci : le type de carte actif correspond-il à un usage existant ?
  // global combine débit ↓ + ↑ + latence + streaming + navigation (voir
  // USAGES.global) ; dl utilise le référentiel du réseau choisi (D1-D4 ARCEP
  // en mobile, THD en fixe) ; ul/ping/streaming/browsing mappent direct.
  function usageForMapType() {
    const map = { global: 'global', dl: debitUsageKey(state.netType), ul: 'debitMontant', ping: 'ping', streaming: 'streaming', browsing: 'browsing' };
    return map[state.mapType] || debitUsageKey(state.netType);
  }
  // Carte de COUVERTURE (façon nPerf « Network coverage ») : la couleur
  // indique la MEILLEURE technologie testée dans la zone — 2G bleu, 3G vert,
  // 4G orange, 5G violet (palette nPerf). C'est une carte de PRÉSENCE (« ici,
  // tu capteras de la 4G »), pas de qualité (c'est le rôle des autres cartes).
  // Symbole antenne reseau pour la legende (SVG inline).
  const ANTENNA_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 11v10"/><circle cx="12" cy="9" r="2" fill="currentColor" stroke="none"/><path d="M8.5 6a5 5 0 0 1 7 0"/><path d="M6 3.5a8.5 8.5 0 0 1 12 0"/></svg>';
  const ANTENNA_SVG_SM = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 12v9"/><circle cx="12" cy="10" r="1.8" fill="currentColor" stroke="none"/><path d="M8.5 7a5 5 0 0 1 7 0"/><path d="M6 4.5a8.5 8.5 0 0 1 12 0"/></svg>';

  const TECH_RANK = { '5G': 5, '4G': 4, '3G': 3, '2G': 2 };
  // Palette de couverture = LOGIQUE DES DÉBITS (décision utilisateur) :
  // chaque technologie porte la couleur de la classe de débit qu'elle
  // représente, EXACTEMENT les mêmes teintes que la légende de qualité —
  //   2G  = Lent         (rouge  --q1)
  //   3G  = Moyen        (orange --q2)
  //   4G  = Rapide       (vert clair --q3)
  //   4G+ = Très rapide  (vert  --q4)  → app mobile uniquement
  // EXCEPTION (décision utilisateur) : la 5G est BLEUE (bleu ciel #2f6bff —
  // la première teinte #1d4ed8 était trop sombre, « la 5G n'est pas
  // visible »). Elle partageait aussi le vert foncé de la 4G+ — sur l'app
  // mobile, impossible de distinguer une zone 5G d'une zone 4G+. Le bleu
  // lève l'ambiguïté sans casser la lecture « plus c'est vert, plus c'est
  // rapide » des classes 2G → 4G+.
  const COVERAGE_COLORS = {
    '5G': '#2f6bff',
    '4G': getCss('--q3') || '#7ac143',
    '3G': getCss('--q2') || '#f5a623',
    '2G': getCss('--q1') || '#e0464b',
  };
  // Technologie DOMINANTE parmi des points (null si aucun test cellulaire).
  // RÈGLE (choix utilisateur du 06/10/2026) : la plus FRÉQUENTE, pas la
  // meilleure — 10 tests 3G + 1 test 4G s'affichent orange 3G, car la zone
  // est vécue majoritairement en 3G. Égalité départagée par le rang (2G < 3G
  // < 4G < 5G) : à nombre égal, la techno supérieure gagne.
  // Ne lit que networkType (2G…4G+) : cellularTech est la techno de la SIM,
  // présente même quand le test passe par le WiFi d'un autre réseau — il ne
  // faut pas la compter comme couverture cellulaire.
  function bestTechOf(points) {
    const counts = {};
    let topTech = null;
    let topCount = 0;
    points.forEach((p) => {
      const t = p.networkType || '';
      if (!TECH_RANK[t]) return;
      counts[t] = (counts[t] || 0) + 1;
      if (counts[t] > topCount || (counts[t] === topCount && TECH_RANK[t] > TECH_RANK[topTech])) {
        topTech = t;
        topCount = counts[t];
      }
    });
    return topTech;
  }
  // Un test est-il passé par le réseau MOBILE de l'appareil ? Source unique :
  // networkType normalisé ('WiFi'/'Non précisé' = fixe ; 2G-5G = mobile). On
  // ne regarde NI operator (FAI déduit de l'IP : un mobile peut sortir par un
  // FAI fixe et réciproque — le WiFi Orange d'un box sort sous « Orange »),
  // NI cellularTech/simOperator (techno et opérateur de la SIM, renseignés
  // même quand le test passe par le WiFi d'un autre réseau).
  function isCellularTest(p) {
    return /^[2345]G\+?$/.test(String(p.networkType || '').trim());
  }
  // Couleur de la carte de couverture : la technologie DOMINANTE de la zone
  // (la plus fréquente — choix utilisateur 06/10/2026, voir bestTechOf).
  // Retourne null quand aucune technologie cellulaire n'est identifiée — la
  // zone n'est alors PAS peinte (demande : affichage « Échec » retiré), au
  // même titre qu'un lieu non testé.
  function coverageColor(points) {
    const t = bestTechOf(points);
    return t ? COVERAGE_COLORS[t] : null;
  }
  // La métrique brute affichée dans la légende / les popups selon mapType.
  // VILLE d'un point : le géocodage inverse ne documente pas tous les
  // quartiers — certains libellés n'ont que « ville, pays ». On prend donc la
  // ville (l'avant-dernier segment en général : « Patte d'Oie, Ouagadougou,
  // Burkina Faso » → « Ouagadougou »), avec repli sur le premier segment
  // quand le libellé n'a que deux parties.
  function villeOf(p) {
    const loc = String(p.location || '').trim();
    if (!loc) return '';
    const parts = loc.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return '';
    // « quartier, ville, pays » → ville ; « ville, pays » → ville.
    return parts.length >= 3 ? parts[parts.length - 2] : parts[0];
  }
  // Repli : premier segment (quartier quand il est documenté) — utilisé pour
  // affiner le libellé des zones sur la carte.
  function quartierOf(p) {
    const loc = String(p.location || '').trim();
    if (!loc) return '';
    return loc.split(',')[0].trim();
  }

  function metricOf(p) {
    // Navigation = temps de chargement moyen (browsingAvgLoadMs, ms) — la
    // couleur de la carte lit ce champ ; l'affichage convertit en secondes.
    return { dl: p.download, ul: p.upload, ping: p.ping, streaming: p.streamingScore, browsing: p.browsingAvgLoadMs }[state.mapType];
  }
  function metricUnit() {
    return { dl: 'Mbps', ul: 'Mbps', ping: 'ms', streaming: 'pts', browsing: 's' }[state.mapType];
  }

  // Rayon de regroupement, exprimé en PIXELS écran et non en mètres : le
  // regroupement suit donc le zoom. Il reste supérieur au diamètre maximal
  // d'un rond (24 px), ce qui garantit que deux ronds ne se chevauchent
  // jamais — des points plus petits permettent un regroupement plus fin et
  // donc davantage de zones distinctes malgré beaucoup de tests.
  const CLUSTER_PX = 34;

  // Tous les ronds ont la même couleur : la carte indique où des mesures ont
  // été faites, pas un jugement de qualité (celui-ci reste dans le popup).
  // THÉMATIQUE (--navy) et non codée en dur : #1c1c3c (bleu nuit) en thème
  // clair, presque blanc en thème sombre. Avant ce correctif, les zones du
  // mode Fixe restaient bleu nuit sur les tuiles assombries — invisibles,
  // donc leurs popups devenaient inaccessibles (plainte du 07/10). getCss
  // (quality.js) est chargé avant map.js.
  function markerColor() {
    return getCss('--navy') || '#1c1c3c';
  }

  const WEEKDAYS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

  // Rectangle couvrant toute la Terre, sens horaire. Associé au contour du
  // Burkina en second anneau, il donne un polygone « troué » : tout est peint
  // SAUF le pays. Les latitudes s'arrêtent à ±85° (limite de la projection
  // Web Mercator, au-delà de laquelle la projection diverge).
  const WORLD_RING = [[-85, -180], [-85, 180], [85, 180], [85, -180]];

  // Couleur du masque : celle du fond de page, pour que l'extérieur du pays se
  // lise comme du vide et non comme une mer ou un territoire non renseigné.
  // Lue à la demande (et non une fois pour toutes) : le thème clair/sombre
  // change var(--bg) en cours de route.
  const maskColor = () => getCss('--bg') || '#f4f6fa';
  let maskPolygon = null;      // polygone « troué » recouvrant les voisins
  let borderLine = null;       // frontière redessinée par-dessus

  const baseLayers = {
    // Fond de plan : style HOT d'OpenStreetMap France (gratuit, SANS clé
    // d'API, libellés en FRANÇAIS — « je vois toujours des termes en anglais
    // sur les cartes » : c'étaient les tuiles, pas l'interface).
    // Historique : CARTO Positron (clair, épuré) est devenu payant — tuile
    // blanche « API key required » (vérifié : 2049 octets) ; remplacé par
    // Esri World Street Map, dont les libellés (régions, parcs, services)
    // sont en anglais. Le style HOT (l'habillage humanitaire d'OSM, très
    // utilisé en Afrique de l'Ouest) donne la même lisibilité avec des noms
    // en français. ATTENTION : {z}/{x}/{y} standard ici (contrairement aux
    // tuiles Esri qui écrivent {z}/{y}/{x}).
    // Plan : tuiles officielles OSM (tile.openstreetmap.org). L'ancien
    // style HOT d'OSM France renvoyait souvent des 429 (rate-limit) :
    // carrés GRIS à l'écran (demande du 08/10 « pourquoi la carte s'affiche
    // souvent ainsi »). Les tuiles standard portent les mêmes libellés
    // locaux (français) que le style HOT — les noms viennent des données
    // OSM, pas du style. La classe .tiles-plan permet au thème sombre
    // d'inverser ces tuiles claires ; le satellite reste intact.
    plan: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 19,
      className: 'tiles-plan',
    }),
    // Satellite : imagerie Esri SEULE. Les repères Esri (couche
    // World_Boundaries_and_Places) sont RETIRÉS (décision du 07/10) : ils
    // étiquetaient les régions en ANGLAIS (« North », « Western », « Center »
    // — « c'est ça j'ai dis de mettre en français »). L'imagerie ne nomme
    // rien : ce sont les étiquettes FRANÇAISES dessinées par le dashboard
    // (FR_LABELS, cf. syncFrLabels) qui rendent le satellite lisible. Les
    // tuiles de fond ne doivent surtout pas recevoir le filtre inversé du
    // thème sombre (classe .tiles-plan réservée au plan).
    satellite: L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: '© Esri · Maxar · Earthstar Geographics', maxZoom: 19,
      }),
    ]),
  };

  // ── Étiquettes françaises du fond satellite ───────────────────────────────
  // Le dashboard dessine SES étiquettes (régions + villes, en FRANÇAIS)
  // par-dessus l'imagerie. Elles ne s'affichent QUE sur le satellite : le
  // fond Plan (style HOT d'OSM France) porte déjà ses libellés OSM — les
  // doublons seraient brouillons. Non interactives : les clics traversent
  // vers les zones de mesure. Le pane dédié (450) les garde sous les ronds
  // de zones (600) mais au-dessus du masque des pays voisins (400).
  const FR_LABELS = [
    // Les 13 régions : nom + centre approximatif (le label région est
    // décalé du chef-lieu quand les deux coexisteraient au même point).
    ['Boucle du Mouhoun', 12.30, -3.55, 'region'],
    ['Cascades', 10.40, -4.60, 'region'],
    ['Centre', 12.60, -1.25, 'region'],
    ['Centre-Est', 11.65, -0.45, 'region'],
    ['Centre-Nord', 13.30, -1.15, 'region'],
    ['Centre-Ouest', 12.30, -2.62, 'region'],
    ['Centre-Sud', 11.55, -1.20, 'region'],
    ['Est', 12.10, 0.75, 'region'],
    ['Hauts-Bassins', 11.45, -4.12, 'region'],
    ['Nord', 14.00, -2.30, 'region'],
    ['Plateau-Central', 12.65, -0.85, 'region'],
    ['Sahel', 14.45, -0.30, 'region'],
    ['Sud-Ouest', 10.75, -3.05, 'region'],
    // Villes (chefs-lieux de régions).
    ['Ouagadougou', 12.37, -1.52, 'city'],
    ['Bobo-Dioulasso', 11.18, -4.30, 'city'],
    ['Koudougou', 12.25, -2.40, 'city'],
    ['Dédougou', 12.46, -3.46, 'city'],
    ['Ouahigouya', 13.58, -2.42, 'city'],
    ['Banfora', 10.63, -4.77, 'city'],
    ['Kaya', 13.09, -1.08, 'city'],
    ['Tenkodogo', 11.78, -0.37, 'city'],
    ["Fada N'Gourma", 12.06, 0.35, 'city'],
    ['Dori', 14.03, -0.03, 'city'],
    ['Gaoua', 10.32, -3.19, 'city'],
    // Villes secondaires (08/10 : « des détails dans les villes manquent »).
    // Les 8 communes où des tests existent (zones rurales de demo_data) et
    // 2 chefs-lieux déjà listés, requalifiés « town » : plus petits que les
    // grandes villes pour garder la hiérarchie visuelle. Sans elles, le
    // satellite ne nommait rien entre les chefs-lieux — Rollo, Sabou, Léo,
    // Pô… étaient invisibles alors que leurs mesures s'affichent.
    ['Ziniaré', 12.58, -1.28, 'town'],
    ['Manga', 11.66, -1.10, 'town'],
    ['Yako', 12.96, -2.26, 'town'],
    ['Rollo', 12.48, -2.38, 'town'],
    ['Réo', 12.32, -2.47, 'town'],
    ['Sabou', 12.05, -2.22, 'town'],
    ['Léo', 11.10, -2.10, 'town'],
    ['Pô', 11.17, -1.15, 'town'],
    ['Nouna', 12.73, -3.87, 'town'],
  ];
  let labelLayer = null;
  function buildFrLabels() {
    const pane = map.createPane('frLabels');
    pane.style.zIndex = 450;
    pane.style.pointerEvents = 'none'; // jamais au-dessus des zones
    labelLayer = L.layerGroup(FR_LABELS.map(([name, lat, lng, kind]) =>
      L.marker([lat, lng], {
        pane: 'frLabels', interactive: false, keyboard: false,
        icon: L.divIcon({
          className: '', iconSize: [0, 0],
          html: `<div class="fr-label${kind === 'region' ? ' fr-label--region' : kind === 'town' ? ' fr-label--town' : ''}">${escapeHtml(name)}</div>`,
        }),
      })));
  }
  function syncFrLabels() {
    if (!labelLayer) return;
    if (state.base === 'satellite') labelLayer.addTo(map);
    else map.removeLayer(labelLayer);
  }

  // ── Initialisation ──────────────────────────────────────────────────────────

  function init() {
    // La carte ne montre que le Burkina Faso. `maxBounds` + une viscosité de 1
    // rendent la sortie du cadre impossible : le déplacement bute sur la
    // frontière au lieu de dériver vers les pays voisins. Le cadre est
    // légèrement élargi (pad) pour que le bord du pays ne colle pas à l'écran.
    countryBounds = L.latLngBounds(BURKINA_BOUNDS);
    map = L.map('main-map', {
      zoomControl: false,
      maxBounds: countryBounds.pad(0.06),
      maxBoundsViscosity: 1,
      // Zoom FIN (demande du 08/10 : « on n'arrive pas à zoomer sur les
      // détails des villes »). Par défaut, un cran de molette = un niveau
      // ENTIER (7 → 8 → 9) : entre le pays entier et la ville, le saut est
      // trop brutal et le réglage semble bloqué. zoomSnap 0.25 autorise les
      // niveaux intermédiaires, zoomDelta 0.5 affine les boutons +/− (2 pas
      // par niveau) et wheelPxPerZoomLevel 180 réduit la sensibilité de la
      // molette (180 px de défilement par cran au lieu de 60) — on zoome
      // progressivement au lieu de sauter.
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 180,
    }).fitBounds(countryBounds);

    // Le pays entier tenant à l'écran au zoom courant, aucun dézoom au-delà
    // n'apporterait d'information : on en fait le plancher.
    map.setMinZoom(map.getZoom());

    L.control.zoom({ position: 'bottomright' }).addTo(map);
    baseLayers.plan.addTo(map);
    buildFrLabels();
    syncFrLabels(); // aucune au démarrage (plan) : seulement sur satellite
    addCountryMask();
    markersLayer = L.layerGroup().addTo(map);
    buildLegend();

    // Le regroupement dépend du zoom : il faut le recalculer à chaque niveau.
    map.on('zoomend', render);

    bindControls();
    loadData();

    // Bascule clair/sombre : le masque pays et la frontière sont peints en
    // canvas/SVG Leaflet avec la couleur CSS du moment — il faut les repeindre
    // explicitement quand le thème change. Les popups fermés reprendront la
    // bonne palette à leur prochaine ouverture.
    document.addEventListener('yele-theme', () => {
      if (maskPolygon) maskPolygon.setStyle({ fillColor: maskColor() });
      if (borderLine) borderLine.setStyle({ color: getCss('--green') || '#0e7a4a' });
      // Les ronds de zone et la chaleur du mode Fixe portent la couleur
      // marqueur thématique : re-render pour les re-teindre au changement
      // de thème (sinon ils restaient bleu nuit sur la carte assombrie).
      render();
    });
  }

  // Masque les pays voisins. Le fond de carte (OpenStreetMap ou satellite) est
  // servi par tuiles carrées : impossible de n'en demander que le Burkina. On
  // le recouvre donc d'un polygone plein percé à la forme du pays.
  //
  // `interactive: false` est indispensable : sans lui, le masque intercepterait
  // les clics et les popups des points de test ne s'ouvriraient plus. Le
  // polygone vit dans l'overlayPane, donc au-dessus des tuiles mais en dessous
  // des marqueurs (markerPane) — l'ordre voulu.
  function addCountryMask() {
    maskPolygon = L.polygon([WORLD_RING, BURKINA_OUTLINE], {
      fillColor: maskColor(), fillOpacity: 1, fillRule: 'evenodd',
      stroke: false, interactive: false,
    }).addTo(map);

    // Frontière redessinée par-dessus : le bord du masque seul serait crénelé.
    borderLine = L.polygon(BURKINA_OUTLINE, {
      color: getCss('--green') || '#0e7a4a', weight: 1.5, opacity: .85,
      fill: false, interactive: false,
    }).addTo(map);
  }

  // ── Légende des couleurs de qualité (façon nPerf) ──────────────────────────
  // Petit panneau en bas à gauche : les 4 niveaux de l'usage courant avec
  // leurs seuils. Se met à jour au changement d'usage.
  function buildLegend() {
    // En bas a DROITE : a gauche, le panneau de filtres la recouvrait.
    const legend = L.control({ position: 'bottomright' });
    legend.onAdd = () => {
      const div = L.DomUtil.create('div', 'map-legend');
      div.id = 'map-legend';
      return div;
    };
    legend.addTo(map);
    updateLegend();
  }

  function updateLegend() {
    // Carte de couverture : mobile seulement (comme la couverture chez
    // nPerf). En fixe, la légende THD s'affiche pour Débit ↓ et Global.
    const mobile = state.netType === 'mobile';
    const el = document.getElementById('map-legend');
    if (!el) return;
    if (state.netType === 'fixe' && state.mapType === 'coverage') {
      el.style.display = 'none';
      updateMaptypeHint();
      return;
    }
    el.style.display = '';
    if (state.mapType === 'coverage') {
      // Légende couverture : les 4 badges techno toujours affichés (la
      // légende enseigne le code couleur, même sans données). « Échec » et
      // « 4G+ » ont été retirés à la demande : 4G+ est classé en 4G, et une
      // zone sans technologie identifiée n'est simplement pas peinte.
      const hints = { '2G': 'appels + SMS', '3G': 'internet lent', '4G': 'internet rapide', '5G': 'très rapide' };
      // Niveaux de coloration des barres : 2G éclaire 1 barre, 3G en éclaire 2…
      const barsLit = { '2G': 1, '3G': 2, '4G': 3, '5G': 4 };
      const badge = (t, color, lit, label, title) => `
        <div class="cov-badge" style="color:${color}" title="${title || (t ? t + ' : ' + (hints[t] || '') : '')}">
          <span class="cov-badge-circle">
            ${[1,2,3,4].map((n) => `<i${n <= lit ? '' : ' class="off"'}></i>`).join('')}
          </span>
          <span>${label || t}</span>
        </div>`;
      const techBadges = Object.keys(TECH_RANK).sort((a, b) => TECH_RANK[a] - TECH_RANK[b])
        .map((t) => badge(t, COVERAGE_COLORS[t], barsLit[t])).join('');
      const antenna = '<span class="legend-antenna">' + ANTENNA_SVG + '</span>';
      el.innerHTML = '<div class="legend-title">' + antenna + ' Couverture mobile</div>'
        + '<div class="legend-sub">Couleur de la zone = technologie la plus fréquente</div>'
        + `<div class="legend-techs">${techBadges}</div>`;
      updateMaptypeHint();
      return;
    }
    // Réseau FIXE : la légende standard des niveaux s'affiche aussi, comme
    // sur l'onglet Couverture de l'app (demande 10/11 — elle remplace la
    // décision du 07/10 « aucun seuil de qualité en fixe », qui laissait la
    // légende muette) : les fourchettes servent de lecture des mesures.
    const usage = USAGES[usageForMapType()];
    const rows = [...usage.levels].reverse().map((l) => `
      <div class="legend-row">
        <span class="legend-dot" style="background:${qualityColor(l.level)}"></span>
        <span class="legend-label">${escapeHtml(l.label)}</span>
        <span class="legend-hint">${escapeHtml(l.hint)}</span>
      </div>`).join('');
    el.innerHTML = `<div class="legend-title">${escapeHtml(usage.legendTitle)}</div>${rows}`;
    updateMaptypeHint();
  }

  // Bandeau d'attente : le premier appel peut être long si le backend
  // (offre gratuite Render) sort de veille. Sans ce retour visuel, la carte
  // reste vide sans explication pendant une minute.
  function setLoadingBanner(html) {
    let el = document.getElementById('map-loading');
    if (!html) { el?.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'map-loading';
      el.className = 'map-loading';
      document.getElementById('main-map').appendChild(el);
    }
    el.innerHTML = html;
  }

  async function loadData() {
    setLoadingBanner('Chargement des points de test…<small>Le serveur peut mettre '
      + 'jusqu\'à une minute à sortir de veille.</small>');
    try {
      // Normalisation à la source : les vues Opérateurs, Statistiques et
      // Historique lisent toutes getPoints(). En nettoyant ici, elles héritent
      // de la correction sans que la logique soit dupliquée quatre fois.
      allPoints = (await API.mapPoints() || []).map((p) => ({
        ...p,
        operator: normalizeOperator(p.operator),
        networkType: normalizeNetwork(p.networkType),
      }));
      setLoadingBanner('');
    } catch (e) {
      allPoints = [];
      setLoadingBanner(`<b>Données indisponibles</b><small>${escapeHtml(e.message)}</small>`
        + '<button type="button" id="map-retry" class="btn-primary">Réessayer</button>');
      document.getElementById('map-retry')?.addEventListener('click', loadData);
    }
    buildOperatorSelect();
    buildTechChips();
    updateTechVisibility();
    updateCoverageVisibility();
    buildLieuSelect();
    render();
  }

  // ── Filtres ─────────────────────────────────────────────────────────────────

  function filteredPoints(skipPeriodGrain = null) {
    // « Tous les opérateurs / Tous les fournisseurs » (__all__) : tous les
    // tests du réseau en cours (cellulaires en mobile, non cellulaires en
    // fixe), filtres technologie / lieu / période appliqués comme les autres.
    // Façon nPerf inversée : plus de voile « Choisissez un opérateur »,
    // la carte affiche d'emblée tout le réseau (demande 10/11).
    const mobileMode = state.netType === 'mobile';
    const allIsps = state.operator === '__all__';
    if (allIsps) {
      return allPoints.filter((p) => {
        if (mobileMode ? !isCellularTest(p) : isCellularTest(p)) return false;
        if (mobileMode && state.tech) {
          const t = p.networkType || NETWORK_UNKNOWN;
          if (t !== state.tech) return false;
        }
        if (state.lieu && villeOf(p) !== state.lieu) return false;
        return timeMatch(p, skipPeriodGrain);
      });
    }
    // Sans opérateur précis sélectionné (jamais le cas par défaut depuis le
    // 10/11), la carte n'affiche rien — garde sémantique conservée.
    if (!state.operator) return [];
    return allPoints.filter((p) => {
      const op = p.operator || 'Inconnu';
      if (op !== state.operator) return false;
      if (mobileMode) {
        // Mobile : seuls les tests sur réseau cellulaire (2G-5G) comptent,
        // filtrés ensuite par technologie choisie.
        const t = p.networkType || NETWORK_UNKNOWN;
        if (!isCellularTest(p)) return false;
        if (state.tech && t !== state.tech) return false;
      } else if (isCellularTest(p)) {
        // Fixe : réciproque — un opérateur précis n'affiche que ses tests NON
        // cellulaires. Sans ce garde, la carte dessinait AUSSI ses tests
        // mobiles (Orange : liste « (78) » mais 502 ronds dessinés) et les
        // popups marquaient « Réseau mobile » en plein mode Fixe.
        return false;
      }
      if (state.lieu && villeOf(p) !== state.lieu) return false;
      return timeMatch(p, skipPeriodGrain);
    });
  }

  // ── Période (heure / jour / semaine) ────────────────────────────────────────

  // parseTs / weekStartKey / weekLabel sont partagés avec la vue Opérateurs
  // et définis dans quality.js.

  // Renvoie la « valeur » d'un point pour un grain donné (ou null si date invalide).
  function grainValue(p, grain) {
    const d = parseTs(p.timestamp);
    if (isNaN(d)) return null;
    if (grain === 'hour') return d.getHours();
    if (grain === 'day') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (grain === 'week') return weekStartKey(d); // clé = lundi de la semaine
    if (grain === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (grain === 'year') return String(d.getFullYear());
    return null;
  }

  function grainValueLabel(grain, value) {
    if (grain === 'hour') return `${value}h`;
    if (grain === 'day') {
      const [y, m, d] = String(value).split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    }
    if (grain === 'week') return weekLabel(value); // « Sem. du JJ/MM »
    if (grain === 'month') {
      const [y, m] = String(value).split('-').map(Number);
      return new Date(y, m - 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    }
    return String(value);
  }

  // Filtre un point selon les périodes ACTIVES (cumulées : année + mois +
  // semaine…). `skipGrain` sert uniquement à calculer les options d'un select :
  // on ignore alors le filtre de ce grain-là, sinon le select se
  // réserverait ses propres valeurs.
  function timeMatch(p, skipGrain = null) {
    const values = state.period.values || {};
    for (const g of Object.keys(values)) {
      if (g === skipGrain) continue;
      const v = grainValue(p, g);
      if (v == null || String(v) !== String(values[g])) return false;
    }
    return true;
  }

  // Remplit le menu déroulant des opérateurs selon le type de réseau choisi.
  // Mobile : liste FIXE (les 3 opérateurs burkinabè — toujours proposés, même
  // sans données, comme chez nPerf) ; Fixe : liste DYNAMIQUE construite depuis
  // les tests reçus (les FAI se révèlent eux-mêmes).
  function buildOperatorSelect() {
    const sel = document.getElementById('operator-select');
    const previous = state.operator;
    const counts = {};
    allPoints.forEach((p) => {
      const op = p.operator || 'Inconnu';
      const isCellular = isCellularTest(p);
      if (state.netType === 'mobile' ? isCellular : !isCellular) {
        counts[op] = (counts[op] || 0) + 1;
      }
    });

    let entries;
    if (state.netType === 'mobile') {
      // Les 3 opérateurs mobiles TOUJOURS proposés (référentiel ARCEP, mêmes
      // libellés que l'app : Orange BF SA / Telecel Faso SA / Moov Africa SA),
      // avec leur compte — « (aucun test) » quand la base n'en a pas encore.
      entries = MOBILE_OPERATORS.map((op) => ({ op, n: counts[op] || 0 }));
      // Un opérateur cellulaire non canonique présent en base (autre libellé)
      // est proposé en plus, dynamiquement.
      Object.keys(counts)
        .filter((op) => !MOBILE_OPERATORS.includes(op) && /G$/.test(op) === false && op !== 'Inconnu')
        .filter((op) => allPoints.some((q) => (q.operator || '') === op && isCellularTest(q)))
        .forEach((op) => entries.push({ op, n: counts[op] }));
    } else {
      // FAI : dynamique, tout ce qui apparaît dans les tests non cellulaires.
      entries = Object.keys(counts).sort((a, b) => counts[b] - counts[a])
        .map((op) => ({ op, n: counts[op] }));
    }

    const header = state.netType === 'fixe'
      ? `<option value="__all__">Tous les fournisseurs</option>`
      // Demande 10/11 : « Tous les opérateurs » par défaut — tous les tests
      // cellulaires s'affichent sans choisir d'opérateur (comme sur l'app).
      : `<option value="__all__">Tous les opérateurs</option>`;
    // Le réseau (mobile/fixe) est porté par le SÉLECTEUR Mobile/Fixe :
    // le libellé de l'option reste propre (« Orange BF SA (424) »), sans
    // suffixe « (mobile) » / « (fixe) » (demande 08/10 : retiré du dashboard).
    // Les 3 opérateurs mobiles affichent leur libellé canonique complet
    // (identique à l'app) ; seule la liste dynamique des FAI est écourtée.
    sel.innerHTML = header
      + entries.map((e) => {
        const canonical = MOBILE_OPERATORS.includes(e.op) || state.netType === 'mobile';
        const short = e.op === 'Inconnu' ? 'Inconnu'
          : canonical ? e.op : operatorShortLabel(e.op);
        return `<option value="${escapeHtml(e.op)}">${escapeHtml(short)}${e.n ? ` (${e.n})` : ' (aucun test)'}</option>`;
      }).join('');
    // Conserve la sélection si elle existe encore dans la nouvelle liste.
    const keep = entries.some((e) => e.op === previous)
      || previous === '__all__';
    sel.value = keep ? previous : '__all__';
    state.operator = sel.value;
  }  // Le bouton « Couverture » n'a de sens qu'en réseau mobile (chez nPerf,
  // la couverture est une notion cellulaire). En Fixe : caché.
  function updateCoverageVisibility() {
    // Couverture : mobile seulement. Streaming/Navigation : mobile ET fixe —
    // ce sont des scores MESURÉS (fluidité vidéo, temps de chargement des
    // pages) qui décrivent l'expérience vécue indépendamment du forfait :
    // ils sont donc proposés et colorés par niveau dans les deux réseaux
    // (demande : « côté fixe ajouter streaming et navigation »).
    const mobile = state.netType === 'mobile';
    // Bloc Couverture COMPLET (libellé + bouton) : n'existe qu'en mobile.
    const covOnly = document.getElementById('coverage-only');
    if (covOnly) covOnly.style.display = mobile ? '' : 'none';

    document.getElementById('mt-coverage').style.display = mobile ? '' : 'none';
    // La carte de chaleur n'est proposée qu'en mobile (les agrégats de
    // densité en fixe n'apportaient rien) : bouton masqué et mode forcé sur
    // « Points de test ».
    document.querySelector('#display-mode .toggle[data-mode="heatmap"]').style.display = mobile ? '' : 'none';
    if (!mobile && state.mode === 'heatmap') {
      state.mode = 'points';
      document.querySelectorAll('#display-mode .toggle').forEach((b) =>
        b.classList.toggle('active', b.dataset.mode === 'points'));
    }
    // Le Global reste visible en fixe : sa popup réunit les 5 mesures de la
    // zone (download, upload, latence, streaming, navigation).
    // En passant au réseau Fixe, seule la carte de COUVERTURE perd son sens :
    // on retombe sur Download. Streaming et Navigation restent valables.
    const lostActive = state.mapType === 'coverage' && !mobile;
    if (lostActive) {
      state.mapType = 'dl';
      document.querySelectorAll('#maptype-block .toggle[data-mt]').forEach((b) =>
        b.classList.toggle('active', b.dataset.mt === 'dl'));
    }
  }

  // Texte d'aide sous les boutons de carte : décrit CE QUE MONTRE la carte
  // active. Appelé à chaque changement de type de carte (via updateLegend),
  // sinon la description reste celle de la carte précédente.
  function updateMaptypeHint() {
    const el = document.getElementById('maptype-hint');
    if (!el) return;
    el.textContent =
      state.mapType === 'coverage'
        ? 'Couleur = technologie la plus fréquente dans la zone (2G → 5G).'          : state.mapType === 'global'
            ? (state.netType === 'fixe'
                ? 'Réunit toutes les mesures de la zone : download, upload, latence, streaming, navigation.'
                : 'Combine download, upload, latence, streaming et navigation en un score unique.')
          : state.mapType === 'dl'
            ? (state.netType === 'fixe'
                ? 'Points de mesure du téléchargement (aucun seuil de qualité en fixe).'
                : 'La couleur montre la rapidité du téléchargement.')
            : state.mapType === 'ul'
              ? (state.netType === 'fixe'
                  ? 'Points de mesure de l’envoi (upload), aucun seuil de qualité en fixe.'
                  : 'La couleur montre la rapidité de l’envoi (upload).')
              : state.mapType === 'ping'
                ? (state.netType === 'fixe'
                    ? 'Points de mesure de la latence (aucun seuil de qualité en fixe).'
                    : 'La couleur montre la réactivité (temps de réponse).')
                : state.mapType === 'streaming'
                  ? (state.netType === 'fixe'
                      ? 'Points de mesure du streaming (aucun seuil de qualité en fixe).'
                      : 'La couleur montre la fluidité de la vidéo.')
                  : (state.netType === 'fixe'
                      ? 'Points de mesure de la navigation (aucun seuil de qualité en fixe).'
                      : 'La couleur montre la vitesse de chargement des pages.');
  }

  // Menu des lieux (villes) : dérivé des libellés géocodés des tests de
  // l'opérateur courant — la liste se construit dynamiquement avec les tests.
  // Le filtre par VILLE (et non quartier) : tous les quartiers ne sont pas
  // documentés par le géocodage, la ville est toujours fiable.
  function buildLieuSelect() {
    const sel = document.getElementById('lieu-select');
    if (!sel) return;
    const counts = {};
    filteredPoints().forEach((p) => {
      const v = villeOf(p);
      if (v) counts[v] = (counts[v] || 0) + 1;
    });
    const villes = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const total = filteredPoints().length;
    sel.innerHTML = `<option value="">Toutes (${total})</option>`
      + villes.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)} (${counts[v]})</option>`).join('');
    const keep = villes.includes(state.lieu);
    sel.value = keep ? state.lieu : '';
    state.lieu = sel.value;
  }

  // Le bloc Technologie n'apparaît qu'en mode MOBILE avec un opérateur choisi ;
  // un message remplace les puces quand l'opérateur n'a aucun test cellulaire.
  function updateTechVisibility() {
    const block = document.getElementById('mobile-only');
    const show = state.netType === 'mobile' && !!state.operator;
    block.style.display = show ? '' : 'none';
    const hint = document.getElementById('tech-empty-hint');
    if (hint) hint.remove();
    if (show && !document.querySelector('#tech-chips .chip[data-tech]:not([data-tech=""])')) {
      const el = document.createElement('div');
      el.id = 'tech-empty-hint';
      el.className = 'metric-hint';
      el.textContent = 'Aucun test cellulaire pour cet opérateur pour le moment.';
      block.appendChild(el);
    }
  }

  function buildTechChips() {
    // Ce filtre n'appartient qu'au réseau MOBILE : seules les générations
    // cellulaires (2G-5G) y figurent, comptées sur les tests cellulaires.
    // Le Wi-Fi et les liens non radio sont l'affaire du mode « Fixe ».
    const counts = {};
    let cellularTotal = 0;
    // Flux nPerf : les technos affichées sont celles DE L'OPÉRATEUR choisi
    // (comptées sur ses tests à lui). Sans opérateur, le bloc reste vide.
    if (state.operator && state.operator !== '__all__') {
      allPoints.forEach((p) => {
        if ((p.operator || 'Inconnu') !== state.operator) return;
        const t = p.networkType || NETWORK_UNKNOWN;
        if (!isCellularTest(p)) return;
        counts[t] = (counts[t] || 0) + 1;
        cellularTotal++;
      });
    }
    const ORDER = ['5G', '4G', '3G', '2G'];
    const techs = Object.keys(counts)
      .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

    const box = document.getElementById('tech-chips');
    box.innerHTML = `<button class="chip active" data-tech="">Toutes<b>${cellularTotal}</b></button>`;
    techs.forEach((t) => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.dataset.tech = t;
      // Puce de FILTRE volontairement NEUTRE (décision utilisateur du
      // 06/10 soir) : rond et libellé noirs. Les couleurs par techno (5G
      // bleu, 4G vert…) restent réservées à la carte de COUVERTURE et à ses
      // badges : un « 5G » bleu dans le filtre laissait croire que les zones
      // 5G seraient bleues, alors qu'en qualité la couleur suit le NIVEAU
      // (rouge/orange/vert/bleu selon les chiffres).
      chip.innerHTML = `<span class="chip-dot chip-dot--neutral"></span>`
        + `<span class="chip-label">${escapeHtml(t)}</span>`
        + `<b>${counts[t]}</b>`;
      box.appendChild(chip);
    });

    box.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        box.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        state.tech = chip.dataset.tech;
        populatePeriodValues();
        render();
      });
    });

    // « Non précisé » est un regroupement d'affichage : aucune mesure ne porte
    // ce libellé en base, le proposer au filtre serveur ne ramènerait rien.
    History.setNetworks(techs.filter((t) => t !== NETWORK_UNKNOWN));
  }

  // ── Rendu ───────────────────────────────────────────────────────────────────

  function render() {
    markersLayer.clearLayers();
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }

    // Façon nPerf inversée (demande 10/11) : la carte démarre sur « Tous les
    // opérateurs » — aucun voile par défaut. Ce garde-fou ne s'affiche que si
    // aucune sélection n'existe (état interne jamais naturel).
    let overlay = document.getElementById('map-operator-overlay');
    if (!state.operator) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'map-operator-overlay';
        overlay.className = 'map-operator-overlay';
        overlay.innerHTML = '<b>Choisissez un opérateur</b>'
          + '<small>Sélectionnez un opérateur dans le panneau pour afficher ses mesures.</small>';
        document.getElementById('main-map').appendChild(overlay);
      }
      return;
    }
    if (overlay) overlay.remove();

    const points = filteredPoints();

    if (state.mode === 'heatmap' && state.netType === 'fixe') {
      // Chaleur FIXE : densité de mesures uniquement, sémantique correcte de
      // leaflet.heat (tous les points intensité 1 → une seule couleur, c'est
      // le but : aucun seuil de qualité en fixe).
      const heatData = points
        .filter((p) => p.lat && p.lng)
        .map((p) => [p.lat, p.lng, 1]);
      heatLayer = L.heatLayer(heatData, {
        // minOpacity explicite : la tache la plus faible reste visible.
        radius: 38, blur: 30, maxZoom: 15, minOpacity: 0.5,
        gradient: { 1: markerColor() },
      }).addTo(map);
    } else if (state.mode === 'heatmap' && state.netType === 'mobile') {
      // Chaleur MOBILE (couverture OU qualité) : peinture par ZONES, la
      // même mécanique quel que soit l'usage. La canvas de leaflet.heat est
      // incompatible avec une lecture par niveau : son alpha dépend du zoom
      // courant (f = 2^(zoom − maxZoom) dans _redraw, mesuré in situ : zoom
      // 7, maxZoom 15 → chaque point ne pèse que ~0,004, écrasé par
      // minOpacity), donc à l'échelle nationale le dégradé --q1..--q4 de la
      // chaleur qualité ne rendait QUE ses teintes basses — une seule couleur
      // à l'écran (constat de l'utilisatrice, 07/10). Les zones colorées par
      // couleur de la légende (techno en couverture, niveau en qualité)
      // restent correctes à tout zoom.
      heatLayer = L.layerGroup().addTo(map);
      buildZones(points).forEach((zone) => {
        const color = state.mapType === 'coverage'
          ? coverageColor(zone.points)                                  // couverture : techno dominante
          : qualityColor(zoneLevel(zone, usageForMapType()));           // qualité : niveau de l'usage
        if (!color) return; // zone sans technologie : non peinte
        // Teintes plus opaques : les taches de couverture devaient être
        // visibles d'un coup d'œil (demande de lisibilité).
        L.circleMarker([zone.lat, zone.lng], {
          radius: 24, stroke: false,
          fillColor: color, fillOpacity: 0.55,
        }).addTo(heatLayer);
        L.circleMarker([zone.lat, zone.lng], {
          radius: 11, stroke: false,
          fillColor: color, fillOpacity: 0.75,
        }).addTo(heatLayer);
      });
    } else {
      // Affichage par zones : les tests proches (≈ 10 m) sont regroupés en un
      // seul rond qui montre la moyenne de la zone.
      const covMode = state.mapType === 'coverage';
      buildZones(points).forEach((zone) => {
        // Couleur du rond = couleur de la LÉGENDE, comme nPerf :
        //  • Couverture  → couleur de la techno dominante de la zone ;
        //  • Qualité (mobile) → couleur du NIVEAU de l'usage courant (les
        //    mêmes pastilles que la légende). La 5G n'y joue aucun rôle :
        //    règle « techno = bleu uniquement en couverture » (revert du
        //    06/10 soir, décision utilisateur). La lecture qualité reste
        //    dans la popup (verdict + mesures).
        //  • Fixe → couleur uniforme pour TOUS les usages (décision du 07/10 :
        //    streaming et navigation comme les autres — aucun seuil en fixe,
        //    simplement des points de mesure ; la lecture reste au popup).
        let color;
        if (covMode) color = coverageColor(zone.points);
        else if (state.netType === 'fixe') color = markerColor();
        else color = qualityColor(zoneLevel(zone, usageForMapType()));
        if (covMode && !color) return; // zone sans technologie : non peinte
        const marker = L.marker([zone.lat, zone.lng], { icon: zoneIcon(zone.count, color) });
        marker.bindPopup(covMode
          ? zoneCoveragePopupHtml(zone)
          : zonePopupHtml(zone, zoneLevel(zone, usageForMapType())), { minWidth: 240 });
        markersLayer.addLayer(marker);
      });
    }
  }

  // ── Regroupement des tests en zones (rayon fixe à l'écran) ──────────────────

  // Regroupe les tests trop proches pour être distingués au zoom courant.
  // Le rond est ancré sur le point « graine » du groupe et non sur le
  // barycentre : par construction, deux graines sont distantes d'au moins
  // CLUSTER_PX pixels, ce qui interdit tout chevauchement. En zoomant, les
  // groupes se scindent d'eux-mêmes et le détail réapparaît.
  function buildZones(points) {
    const zoom = map.getZoom();
    const proj = points
      .filter((p) => p.lat && p.lng)
      .map((p) => ({ p, xy: map.project([p.lat, p.lng], zoom) }));

    // Tri nord → sud : rend le résultat stable d'un rendu à l'autre et permet
    // d'arrêter la recherche dès que l'écart vertical dépasse le rayon.
    proj.sort((a, b) => a.xy.y - b.xy.y || a.xy.x - b.xy.x);

    const taken = new Array(proj.length).fill(false);
    const zones = [];

    for (let i = 0; i < proj.length; i++) {
      if (taken[i]) continue;
      taken[i] = true;
      const seed = proj[i];
      const group = [seed.p];

      for (let j = i + 1; j < proj.length; j++) {
        const dy = proj[j].xy.y - seed.xy.y;
        if (dy > CLUSTER_PX) break; // trié par y : plus rien ne peut correspondre
        if (taken[j]) continue;
        const dx = proj[j].xy.x - seed.xy.x;
        if (dx * dx + dy * dy <= CLUSTER_PX * CLUSTER_PX) {
          taken[j] = true;
          group.push(proj[j].p);
        }
      }

      zones.push(makeZone(seed.p, group));
    }
    return zones;
  }

  function makeZone(seed, pts) {
    const n = pts.length;
    // (le `sum` historique est remplacé par avgPos ci-dessous : les moyennes
    // ne comptent que les mesures présentes — 0 = test non effectué.)
    // Nom de la zone = lieu le plus fréquent parmi ses tests.
    const locCounts = {};
    pts.forEach((p) => { if (p.location) locCounts[p.location] = (locCounts[p.location] || 0) + 1; });
    const name = Object.keys(locCounts).sort((a, b) => locCounts[b] - locCounts[a])[0] || 'Zone de test';
    // Serveurs distincts ayant servi les tests de la zone (affiché dans le
    // popup ; les anciens enregistrements n'ont pas ce champ — on filtre). 
    const servers = [...new Set(pts.map((p) => p.server).filter((s) => s))];
    // Moyennes calculées sur les points OÙ la mesure existe (> 0) : la
    // convention du projet est « 0 = test non effectué » — compter ces zéros
    // DILUAIT les moyennes de zone (un upload absent faisait baisser l'upload
    // moyen). null = aucune mesure : la popup affiche '·' au lieu d'un faux 0.
    const avgPos = (fn) => {
      const vals = pts.map(fn).filter((v) => v > 0);
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    };
    return {
      lat: seed.lat,
      lng: seed.lng,
      count: n,
      name,
      points: pts,
      servers,
      avgDl: avgPos((p) => p.download),
      avgUl: avgPos((p) => p.upload),
      avgPing: avgPos((p) => p.ping),
    };
  }

  // Niveau de qualité d'une zone : moyenne des niveaux de ses points (et non
  // la moyenne de la métrique brute — un score global ne se moyenne pas).
  function zoneLevel(zone, usageKey) {
    const usage = USAGES[usageKey];
    if (!usage || !usage.available) return 0;
    const dk = debitUsageKey(state.netType);
    const vals = zone.points.map((p) => qualityLevel(p, usageKey, dk)).filter((v) => v > 0);
    if (!vals.length) return 0;
    return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) || 1;
  }

  // Rond de zone : POINTS PETITS façon nPerf (base 13 px, plafond 28 px) —
  // assez visibles pour être touchés, assez petits pour distinguer les zones
  // proches même avec beaucoup de tests.
  // Le nombre de tests s'affiche au centre dès qu'il est assez grand pour
  // rester lisible (≥ 5 tests).
  function zoneIcon(count, color = markerColor()) {
    const size = Math.round(Math.min(28, 13 + Math.log2(count + 1) * 2.2));
    const showCount = count >= 5;
    const fontSize = Math.max(8, Math.floor(size * 0.42));
    return L.divIcon({
      className: 'yele-zone-marker',
      html: `<div class="yele-zone" style="width:${size}px;height:${size}px;background:${color};font-size:${fontSize}px">${showCount ? count : ''}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2],
    });
  }

  // Ventilation d'une mesure d'une zone selon un grain (heure / jour / semaine).
  // `metric` = clé de la mesure à ventiler (download par défaut ; en fixe on
  // suit le type de carte cliqué : download / upload / ping).
  // Retourne { grain, rows: [{ key, label, avg, count }] } triées.
  function zoneBreakdown(zone, grain, metric = 'download') {
    const g = grain === 'all' ? 'day' : grain; // par défaut, on ventile par jour
    const groups = {};
    zone.points.forEach((p) => {
      const v = grainValue(p, g);
      if (v == null) return;
      (groups[v] = groups[v] || []).push(p);
    });
    const rows = Object.keys(groups).map((k) => {
      const pts = groups[k];
      // Moyenne sur les points OÙ la métrique existe (> 0) : la convention
      // du projet est « 0 = test non effectué » — le compter tirait la
      // ventilation vers le bas (« 0 pts streaming » se lisait comme un
      // échec). Aucune mesure dans le groupe → ligne masquée (rien à dire).
      const measured = pts.filter((p) => (p[metric] || 0) > 0);
      if (!measured.length) return null;
      return {
        key: k,
        label: grainValueLabel(g, g === 'hour' ? Number(k) : k),
        avg: measured.reduce((s, p) => s + p[metric], 0) / measured.length,
        count: pts.length,
      };
    }).filter(Boolean);
    // Tri : chronologique pour heure/semaine, ordre Lun→Dim pour le jour.
    if (g === 'hour') rows.sort((a, b) => Number(a.key) - Number(b.key));
    else if (g === 'weekday') rows.sort((a, b) => ((Number(a.key) + 6) % 7) - ((Number(b.key) + 6) % 7));
    else rows.sort((a, b) => (a.key < b.key ? -1 : 1));
    return { grain: g, rows };
  }

  function zonePopupHtml(zone, lvl) {
    const grainNames = { hour: 'heure', day: 'jour', week: 'semaine', month: 'mois', year: 'année' };
    // Distinction fixe / mobile dans la zone : le badge réseau indique ce qui
    // a été testé. On se base sur networkType seul (voir isCellularTest) :
    // « operator » est un FAI déduit de l'IP et cellularTech/simOperator
    // décrivent la SIM, tous deux présents même quand le test passe par le
    // WiFi — les compter transformerait un test WiFi en « mobile ».
    const cellCount = zone.points.filter(isCellularTest).length;
    const fixeCount = zone.points.length - cellCount;
    // Badges SANS fond inline (décision du 07/10) : en thème sombre, l'ardoise
    // #334155 se fondait dans le popup et le texte blanc « se cachait » — le
    // nombre de tests passe en NOIR sur fond clair (classe CSS .popup-net),
    // lisible sur les deux thèmes. Seul « Réseau mobile » garde son bleu 5G.
    let netBadge;
    if (cellCount && fixeCount) {
      netBadge = `<span class="popup-net">${fixeCount} fixe · ${cellCount} mobile</span>`;
    } else if (fixeCount) {
      netBadge = '<span class="popup-net">Réseau fixe (WiFi)</span>';
    } else {
      // Toutes cellulaires : la techno dominante est déjà dans le titre en
      // couverture ; on affiche « réseau mobile » sinon rien.
      netBadge = state.netType === 'mobile'
        ? '<span class="popup-net popup-net--mobile">Réseau mobile</span>'
        : `<span class="popup-net">${zone.count} test${zone.count > 1 ? 's' : ''}</span>`;
    }
    const fixe = state.netType === 'fixe';
    // La ventilation temporelle suit la MÉTRIQUE DE LA CARTE ACTIVE (mobile
    // compris) : en mode Latence on ventile des millisecondes, en Streaming
    // des scores — on ne parle jamais de « débit » hors des cartes de débit.
    // Navigation = temps de chargement (browsingAvgLoadMs), affiché en
    // SECONDES comme la légende (les ms bruts n'étaient pas lisibles).
    const ventMetric = {
      dl: 'download', ul: 'upload', ping: 'ping',
      streaming: 'streamingScore', browsing: 'browsingAvgLoadMs',
    }[state.mapType] || 'download';
    const ventFmt = {
      download: (v) => v.toFixed(1),
      upload: (v) => v.toFixed(1),
      ping: (v) => String(Math.round(v)),
      streamingScore: (v) => v.toFixed(0),
      browsingAvgLoadMs: (v) => `${(v / 1000).toFixed(1)} s`,
    }[ventMetric] || ((v) => v.toFixed(1));
    const bd = zoneBreakdown(zone, state.period.grain, ventMetric);
    const maxAvg = Math.max(...bd.rows.map((r) => r.avg), 1);
    const breakdownRows = bd.rows.map((r) => `
      <div class="zbd-row">
        <span class="zbd-label">${escapeHtml(r.label)}</span>
        <span class="zbd-track"><i style="width:${(r.avg / maxAvg) * 100}%"></i></span>
        <span class="zbd-val">${ventFmt(r.avg)}<small> · ${r.count}×</small></span>
      </div>`).join('');

    // En fixe : PAS de verdict de qualité et PAS de mention « très haut débit »
    // — le débit observé dépend du forfait souscrit, on n'a pas à dire si la
    // connexion est bonne ou pas. Seules les mesures brutes s'affichent.
    // En mobile, le verdict (niveau de l'usage courant) reste affiché.
    // Verdict de qualité affiché quand la carte A des niveaux : tout le
    // mobile, et en fixe uniquement streaming/navigation (dl/ul/ping en fixe
    // n'affichent aucun jugement — le débit dépend du forfait souscrit).
    const hasLevels = !fixe || ['streaming', 'browsing'].includes(state.mapType);
    const qualityLine = state.mapType === 'coverage'
      ? '<div class="popup-quality">Zone couverte par des tests <small style="color:var(--text-soft,#5d6478)">(carte de couverture)</small></div>'
      : !hasLevels
        ? ''
        : `<div class="popup-quality">
            ${qualityLabel(lvl, usageForMapType())} <small style="color:var(--text-soft,#5d6478)">(${state.mapType === 'global' ? 'score global de la zone' : 'moyenne de la zone'})</small>
          </div>`;
    // ── Bloc de mesures : CHAQUE popup n'affiche que SES données ──
    // Clic sur Download → le download seul ; Upload → l'upload seul ;
    // Latence → la latence seule ; Streaming → le score streaming seul ;
    // Navigation → le temps de chargement moyen, en SECONDES (lisible —
    // les ms bruts étaient incompréhensibles, demande explicite). Le Global
    // reste le seul rassembleur : les 5 composantes du score (débit ↓, ↑,
    // latence, streaming, navigation) en mobile COMME en fixe.
    let metricsHtml;
    let bdTitle;
    let showBreakdown = true;
    // Moyenne d'un champ sur les points où il est mesuré (> 0), '·' sinon
    // (convention du projet : 0 = test non effectué, jamais un mauvais score).
    const avgOf = (field) => {
      const vals = zone.points.map((p) => p[field]).filter((v) => v > 0);
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    };
    // Formatage : '·' quand aucune mesure ; navigation convertie en secondes.
    const fmt1 = (v) => (v == null ? '·' : v.toFixed(1));
    const fmtInt = (v) => (v == null ? '·' : String(Math.round(v)));
    const fmtSec = (v) => (v == null ? '·' : `${(v / 1000).toFixed(1)} s`);
    const mt = state.mapType;
    if (mt === 'global') {
      if (fixe) {
        metricsHtml = `
          <div class="popup-metric"><b>${fmt1(zone.avgDl)}</b><span>Mbps download</span></div>
          <div class="popup-metric"><b>${fmt1(zone.avgUl)}</b><span>Mbps upload</span></div>
          <div class="popup-metric"><b>${fmtInt(zone.avgPing)}</b><span>ms latence</span></div>
          <div class="popup-metric"><b>${fmtInt(avgOf('streamingScore'))}</b><span>pts streaming</span></div>
          <div class="popup-metric"><b>${fmtSec(avgOf('browsingAvgLoadMs'))}</b><span>s navigation</span></div>`;
        showBreakdown = false; // Global fixe : pas de « Download moyen par jour »
      } else {
        // Les 5 composantes du score global (décision utilisateur), streaming
        // et navigation comprises — elles étaient absentes du popup.
        metricsHtml = `
          <div class="popup-metric"><b>${fmt1(zone.avgDl)}</b><span>Mbps ↓ moy.</span></div>
          <div class="popup-metric"><b>${fmt1(zone.avgUl)}</b><span>Mbps ↑ moy.</span></div>
          <div class="popup-metric"><b>${fmtInt(zone.avgPing)}</b><span>ms moy.</span></div>
          <div class="popup-metric"><b>${fmtInt(avgOf('streamingScore'))}</b><span>pts streaming</span></div>
          <div class="popup-metric"><b>${fmtSec(avgOf('browsingAvgLoadMs'))}</b><span>s navigation</span></div>`;
        bdTitle = 'Débit ↓ moyen par';
      }
    } else if (mt === 'dl') {
      metricsHtml = fixe
        ? `<div class="popup-metric"><b>${fmt1(zone.avgDl)}</b><span>Mbps download moyen</span></div>`
        : `<div class="popup-metric"><b>${fmt1(zone.avgDl)}</b><span>Mbps ↓ moy.</span></div>`;
      bdTitle = fixe ? 'Download moyen par' : 'Débit ↓ moyen par';
    } else if (mt === 'ul') {
      metricsHtml = fixe
        ? `<div class="popup-metric"><b>${fmt1(zone.avgUl)}</b><span>Mbps upload moyen</span></div>`
        : `<div class="popup-metric"><b>${fmt1(zone.avgUl)}</b><span>Mbps ↑ moy.</span></div>`;
      bdTitle = fixe ? 'Upload moyen par' : 'Débit ↑ moyen par';
    } else if (mt === 'ping') {
      metricsHtml = `<div class="popup-metric"><b>${fmtInt(zone.avgPing)}</b><span>ms latence moyenne</span></div>`;
      bdTitle = 'Latence moyenne par';
    } else if (mt === 'streaming') {
      metricsHtml = `<div class="popup-metric"><b>${fmtInt(avgOf('streamingScore'))}</b><span>pts streaming</span></div>`;
      bdTitle = 'Score streaming moyen par';
    } else if (mt === 'browsing') {
      metricsHtml = `<div class="popup-metric"><b>${fmtSec(avgOf('browsingAvgLoadMs'))}</b><span>s navigation (chargement moy.)</span></div>`;
      bdTitle = 'Temps de chargement moyen par';
    }
    return `
      <div class="popup-yele">
        <div class="popup-op">
          <b>${escapeHtml(zone.name)}</b>
          ${netBadge}
        </div>
        ${qualityLine}
        <div class="popup-metrics">${metricsHtml}
        </div>
        ${zone.servers && zone.servers.length ? `<div class="popup-server"><small>Serveur : ${escapeHtml(zone.servers.map((s) => s.replace(/^https?:\/\//, '').replace(/\/$/, '')).join(', '))}</small></div>` : ''}
        ${showBreakdown ? `<div class="zbd-title">${bdTitle} ${grainNames[bd.grain]}</div>
        <div class="zbd">${breakdownRows || '<div class="zbd-empty">Données horodatées indisponibles.</div>'}</div>` : ''}
      </div>`;
  }

  // Popup en mode couverture : liste les technologies observées dans la zone
  // (une ligne par techno, avec le nombre de tests) et désigne la meilleure.
  function zoneCoveragePopupHtml(zone) {
    const counts = {};
    zone.points.forEach((p) => {
      const t = p.networkType || NETWORK_UNKNOWN;
      if (TECH_RANK[t]) counts[t] = (counts[t] || 0) + 1;
    });
    const best = bestTechOf(zone.points);
    const rows = Object.keys(TECH_RANK).sort((a, b) => TECH_RANK[b] - TECH_RANK[a])
      .filter((t) => counts[t])
      .map((t) => `
        <div class="cov-row">
          <span class="legend-dot" style="background:${COVERAGE_COLORS[t]}"></span>
          <span class="cov-label">${t}</span>
          <b>${counts[t]}</b><small> test${counts[t] > 1 ? 's' : ''}</small>
        </div>`).join('');
    return `
      <div class="popup-yele">
        <div class="popup-op">
          <b>${escapeHtml(zone.name)}</b>
          <span class="popup-net" style="background:${best ? COVERAGE_COLORS[best] : '#334155'}">
            ${best ? 'Couverture ' + best : 'Tests'}
          </span>
        </div>
        <div class="popup-quality">Technologies observées dans la zone</div>
        ${rows || '<div class="zbd-empty">Aucune technologie cellulaire identifiée.</div>'}
      </div>`;
  }

  // ── Contrôles ───────────────────────────────────────────────────────────────

  function bindControls() {
    // ── Flux façon nPerf ────────────────────────────────────────────────────
    // 1) Type de réseau (mobile / fixe) : recharge la liste d'opérateurs.
    document.querySelectorAll('#net-type .toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#net-type .toggle').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.netType = btn.dataset.net;
        buildOperatorSelect();
        updateTechVisibility();
        updateCoverageVisibility();
        updateLegend();
        render();
      });
    });

    // 2) Opérateur (obligatoire) : sans choix, la carte reste vide.
    document.getElementById('operator-select').addEventListener('change', (e) => {
      state.operator = e.target.value;
      state.tech = '';
      state.lieu = '';
      buildTechChips();
      updateTechVisibility();
      buildLieuSelect();
      populatePeriodValues();
      render();
    });

    // 3) Type de carte (l'équivalent nPerf coverage / bitrate) : ce que la
    // couleur montre — débit ↓, débit ↑, latence, streaming, navigation.
    // Sélecteur `#maptype-block .toggle[data-mt]` : il couvre les DEUX
    // groupes (qualité + Couverture séparée), sinon le bouton Couverture
    // restait sans handler au clic (demande : « j'arrive pas à cliquer »).
    document.querySelectorAll('#maptype-block .toggle[data-mt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#maptype-block .toggle[data-mt]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.mapType = btn.dataset.mt;
        updateLegend();
        render();
      });
    });

    // Mode d'affichage points / heatmap
    document.querySelectorAll('#display-mode .toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#display-mode .toggle').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.mode = btn.dataset.mode;
        render();
      });
    });

    // Fond de plan
    document.querySelectorAll('#basemap-mode .toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#basemap-mode .toggle').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        map.removeLayer(baseLayers[state.base]);
        state.base = btn.dataset.base;
        baseLayers[state.base].addTo(map);
        syncFrLabels(); // étiquettes FR : seulement sur le satellite
      });
    });

    // Période (grain heure / jour / semaine)
    bindPeriod();

    // Bouton « Réinitialiser les filtres » : ramène le panneau à l'état du
    // démarrage (mobile, pas d'opérateur — donc voile « Choisissez un
    // opérateur », Global, lieu et période effacés). Le DOM est remis d'équerre
    // par les mêmes fonctions de construction que les changements manuels :
    // aucun état fantôme entre le JS et les boutons.
    document.getElementById('reset-filters').addEventListener('click', resetFilters);

    // Filtre Lieu (quartier)
    document.getElementById('lieu-select').addEventListener('change', (e) => {
      state.lieu = e.target.value;
      render();
    });

    // Repli du panneau de filtres, pour dégager la carte.
    const panel = document.getElementById('control-panel');
    const toggle = document.getElementById('panel-toggle');
    toggle.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.title = collapsed ? 'Afficher les filtres' : 'Replier les filtres';
    });

    // Géolocalisation du navigateur — interrupteur (identique à l'app,
    // revue du 10/11) : 1er appui → localise, place le pin et recentre
    // (le libellé devient « Masquer mon point ») ; appui suivant → le pin
    // disparaît (la carte ne bouge pas) ; re-appui → nouvelle position.
    locateFlag = false;
    updateLocateLabel();
    document.getElementById('locate-btn').addEventListener('click', () => {
      if (locateFlag) {
        clearPin();
        locateFlag = false;
        updateLocateLabel();
        return;
      }
      if (!navigator.geolocation) return App.toast('Géolocalisation non disponible');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude, accuracy } = pos.coords;
          if (!flyTo(latitude, longitude, 14)) return;
          dropPin(latitude, longitude, 'Votre position', { accuracy });
          locateFlag = true;
          updateLocateLabel();
        },
        // Géolocalisation : déplace la carte ET pose un pin (notre version,
        // avec cercle de précision). Repli (apport de l'équipe, fusion IMP-10):
        // si le GPS natif échoue (autorisations, fournisseur réseau absent sur
        // un PC), on tente la position IP via ipinfo.io avant le toast ; le
        // pin IP est masqué par le même interrupteur.
        () => locateByIp(),
        // Sans ces options, le navigateur peut renvoyer une position mise en
        // cache depuis des heures : on veut celle d'ici et maintenant.
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  // Libellé du bouton de localisation : suit l'état de l'interrupteur.
  function updateLocateLabel() {
    const btn = document.getElementById('locate-btn');
    if (!btn) return;
    const span = btn.querySelector('span');
    if (span) span.textContent = locateFlag ? 'Masquer mon point' : 'Localisez-moi';
    btn.title = locateFlag ? 'Masquer mon point sur la carte' : 'Afficher ma position sur la carte';
    btn.classList.toggle('locate-active', locateFlag);
  }

  // Remet tous les filtres dans leur état d'origine, panneau compris.
  function resetFilters() {
    state.netType = 'mobile';
    state.operator = '__all__';
    state.mapType = 'global';
    state.tech = '';
    state.lieu = '';
    state.period = { grain: 'all', values: {} };

    // Boutons : un seul actif par groupe, celui des valeurs ci-dessus.
    const activate = (groupSel, attr, val) =>
      document.querySelectorAll(`${groupSel} .toggle`).forEach((b) =>
        b.classList.toggle('active', b.dataset[attr] === val));
    activate('#net-type', 'net', 'mobile');
    activate('#maptype-block', 'mt', 'global');
    activate('#period-grain', 'grain', 'all');

    // Listes reconstruites et éléments dépendants réaffichés/masqués, comme
    // après un changement manuel de réseau.
    buildOperatorSelect();   // remet « Tous les opérateurs »
    buildTechChips();
    buildLieuSelect();
    populatePeriodValues();  // masque le select de valeur (grain = all)
    updateTechVisibility();
    updateCoverageVisibility();
    updateLegend();
    render();
    if (typeof App !== 'undefined' && App.toast) App.toast('Filtres réinitialisés');
  }

  function bindPeriod() {
    document.querySelectorAll('#period-grain .toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#period-grain .toggle').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.period.grain = btn.dataset.grain;
        // « Tout » = aucun filtre de période. Les autres grains CONSERVENT
        // les filtres déjà posés : changer de niveau ne vide plus la période
        // (demande : « le filtre reste ensuite »).
        if (btn.dataset.grain === 'all') state.period.values = {};
        populatePeriodValues();
        render();
      });
    });
    document.getElementById('period-value').addEventListener('change', (e) => {
      const g = state.period.grain;
      const CHILDREN = { year: ['month', 'week', 'day', 'hour'], month: ['week', 'day', 'hour'], week: ['day', 'hour'], day: ['hour'], hour: [] };
      if (e.target.value === '') {
        delete state.period.values[g];
      } else {
        state.period.values[g] = e.target.value;
        // Remonter d'un niveau purge les filtres PLUS FINS incompatibles :
        // choisir 2025 ne peut pas laisser un mois de 2024 actif (sinon
        // l'intersection serait vide et la carte blanche sans explication).
        (CHILDREN[g] || []).forEach((c) => delete state.period.values[c]);
      }
      populatePeriodValues(); // les niveaux enfants se resserrent immédiatement
      render();
    });
  }

  // Remplit le <select> des valeurs disponibles selon le grain choisi.
  function populatePeriodValues() {
    const sel = document.getElementById('period-value');
    const grain = state.period.grain;
    renderPeriodBadges();
    if (grain === 'all') { sel.style.display = 'none'; return; }

    // Valeurs réellement présentes dans les données de l'opérateur courant,
    // en respectant TOUS les filtres de période actifs SAUF celui du grain
    // affiché : année 2025 sélectionnée → le select « Mois » ne propose que
    // les mois de 2025 ; mois de janvier → « Semaines » ne propose que les
    // semaines de janvier (cascade demandée).
    const base = filteredPoints(grain);
    const values = [...new Set(base.map((p) => grainValue(p, grain)).filter((v) => v != null))];
    if (grain === 'hour') values.sort((a, b) => a - b);
    else values.sort((a, b) => (a > b ? -1 : 1)); // jours/mois/années : plus récents d'abord

    const allLabel = { hour: 'Toutes les heures', day: 'Tous les jours', week: 'Toutes les semaines', month: 'Tous les mois', year: 'Toutes les années' }[grain];
    sel.innerHTML = `<option value="">${allLabel}</option>`
      + values.map((v) => `<option value="${v}">${grainValueLabel(grain, v)}</option>`).join('');
    // Conserve la sélection si elle est toujours disponible ; sinon le filtre de
    // ce grain saute (mais les filtres des autres grains sont conservés).
    const current = state.period.values[grain] ?? null;
    const keep = current != null && values.map(String).includes(String(current));
    if (current != null && !keep) delete state.period.values[grain];
    sel.value = keep ? String(current) : '';
    sel.style.display = '';
  }

  // Réglette des filtres de période ACTIFS, cumulés et retirables un par un :
  // on voit « Année : 2025 × » même quand le select affiche les mois.
  function renderPeriodBadges() {
    const box = document.getElementById('period-badges');
    if (!box) return;
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
      render();
    }));
  }

  // ── Repère ponctuel ─────────────────────────────────────────────────────────
  // Sert à deux usages : « Ma position » (ISS-11), qui ne posait aucun marqueur
  // et laissait l'utilisateur sans repère, et le renvoi depuis l'historique
  // (IMP-07), où l'on doit distinguer la mesure choisie de toutes les autres.

  let pinLayer = null;
  // État de l'interrupteur « Localisez-moi » : true tant que le pin de
  // position courant attend d'être masqué par un nouvel appui (comme l'app).
  let locateFlag = false;

  /// Pose un repère et l'accompagne d'une bulle. Le précédent est retiré : on
  /// ne veut qu'un seul repère à la fois, sinon la carte se couvre de marques
  /// au fil des recherches.
  function dropPin(lat, lng, label, { accuracy = null } = {}) {
    clearPin();
    pinLayer = L.layerGroup().addTo(map);

    // Cercle de précision : une position à 2 km près ne doit pas se lire comme
    // un point exact.
    if (accuracy && accuracy > 30) {
      L.circle([lat, lng], {
        radius: accuracy, color: '#1d4ed8', weight: 1,
        fillColor: '#1d4ed8', fillOpacity: .10, interactive: false,
      }).addTo(pinLayer);
    }

    L.marker([lat, lng], {
      icon: L.divIcon({
        className: 'yele-pin-marker',
        html: '<div class="yele-pin"></div>',
        iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -12],
      }),
      zIndexOffset: 1000, // toujours au-dessus des ronds de mesure
    }).addTo(pinLayer).bindPopup(label).openPopup();
  }

  function clearPin() {
    if (pinLayer) { map.removeLayer(pinLayer); pinLayer = null; }
  }

  // Repli : géo-localisation par IP (précision ville), quand le GPS natif
  // échoue (PC sans GPS, fournisseur réseau indisponible). Apport de l'équipe,
  // intégré lors de la fusion IMP-10 : évite le message « Position
  // introuvable » et place le même pin que le GPS, via décision dropPin.
  function locateByIp() {
    fetch('https://ipinfo.io/json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((data) => {
        const loc = String(data.loc || '').split(',');
        const lat = parseFloat(loc[0]);
        const lng = parseFloat(loc[1]);
        if (!isFinite(lat) || !isFinite(lng)) throw new Error('position IP invalide');
        if (!isInsideCountry(lat, lng)) {
          App.toast('Position hors du Burkina Faso — repère impossible.');
          return;
        }
        flyTo(lat, lng, 13);
        dropPin(lat, lng, 'Votre position (géo-localisation IP)');
        locateFlag = true;
        updateLocateLabel();
      })
      .catch(() => App.toast('Position introuvable : vérifiez les autorisations'));
  }

  /// Vrai si le point tombe dans le territoire couvert par la carte.
  /// Permet de décider de basculer sur la carte AVANT de le faire.
  function isInsideCountry(lat, lng) {
    return !!countryBounds && countryBounds.contains([lat, lng]);
  }

  /// Centre la carte sur un point et l'y désigne par un repère.
  ///
  /// Utilisé par les trois renvois vers la carte : une mesure de l'historique,
  /// un lieu de la vue Opérateurs (IMP-07) et une localité trouvée par la
  /// recherche. Le zoom est plus large pour une localité — on veut voir la
  /// ville — que pour une mesure ponctuelle.
  function showMeasurement(lat, lng, label, zoom = 15) {
    if (!flyTo(lat, lng, zoom)) return false;
    dropPin(lat, lng, label);
    // Tout pin (recherche, historique, lieu de la vue Opérateurs) doit rester
    // masquable : on arme l'interrupteur « Localisez-moi », dont l'appui
    // suivant fait disparaître ce repère (demande du 10/11 — la protection
    // « renvois non pris en sandwich » masquait justement le pin de
    // recherche à l'utilisateur).
    locateFlag = true;
    updateLocateLabel();
    return true;
  }

  // La carte étant bornée au Burkina, viser un point extérieur ne produirait
  // qu'un recadrage silencieux sur la frontière la plus proche. On le dit.
  function flyTo(lat, lng, zoom = 13) {
    if (!map) return false;
    if (!countryBounds.contains([lat, lng])) {
      App.toast('Ce lieu est hors du Burkina Faso : la carte ne couvre que le pays.');
      return false;
    }
    map.flyTo([lat, lng], zoom);
    return true;
  }

  function invalidate() {
    if (map) setTimeout(() => map.invalidateSize(), 60);
  }

  /// Recharge les points depuis le serveur (actualisation manuelle ou
  /// automatique). Le cache de l'API doit avoir été vidé au préalable.
  function reload() {
    return loadData();
  }

  return {
    init, flyTo, invalidate, reload, dropPin, clearPin, showMeasurement,
    isInsideCountry,
    getPoints: () => allPoints,
  };
})();
