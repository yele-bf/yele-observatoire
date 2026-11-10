
// Niveau 4 = le MEILLEUR niveau de chaque indicateur : harmonisé en BLEU
// (même teinte que la 5G, #2f6bff — décision du 06/10 soir). La légende de
// chaque usage affiche donc son niveau 4 en bleu : « Expérience très bonne »
// (global) · « Très rapide » (débits) · « Réactivité excellente » (ping) ·
// « Streaming fluide » · « Navigation très fluide ». Posé en dur ici (et NON
// sur --q4) pour que le dégradé de densité de la couverture (map.js) garde
// son vert foncé. Les niveaux 1-3 restent rouges/orange/verts.
const QUALITY_COLORS = {
  4: '#2f6bff',      // très bonne → BLEU (niveau 4 harmonisé, voir ci-dessus)
  3: getCss('--q3'), // bonne
  2: getCss('--q2'), // limitée
  1: getCss('--q1'), // très limitée
  0: getCss('--q0'), // indisponible
};

function getCss(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Échappe toute valeur avant insertion en innerHTML (protection XSS stocké :
// operator/deviceModel/location/simOperator viennent de la télémétrie).
function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Dates ───────────────────────────────────────────────────────────────────
// Partagées entre la carte et la vue Opérateurs.

// Les dates du backend arrivent en "JJ/MM/AAAA HH:MM". new Date() les lirait
// à l'américaine (mois/jour inversés) → semaines fausses. On les parse ici.
function parseTs(s) {
  if (s instanceof Date) return s;
  if (typeof s === 'string') {
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
  }
  return new Date(s); // repli : format ISO
}

// Clé de jour triable : YYYY-MM-DD.
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Clé de semaine = date (YYYY-MM-DD) du lundi de la semaine du point.
function weekStartKey(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const isoDay = (x.getDay() + 6) % 7; // 0 = lundi
  x.setDate(x.getDate() - isoDay);
  return dayKey(x);
}

function weekLabel(key) {
  const [, m, d] = key.split('-');
  return `Sem. du ${d}/${m}`;
}

const USAGES = {
  // Débit descendant : échelle simple en tranches de Mb/s, lisible par
  // tous. Les bornes reprennent discrètement les planchers officiels
  // (mobile) et le seuil THD 30 Mb/s (fixe) — sans jargon réglementaire à
  // l'écran, la justification reste dans les docs du projet.
  debit: {
    label: 'Speedtest',
    legendTitle: 'Débit descendant',
    available: true,
    unit: 'Mbps',
    metric: (p) => p.download,
    levels: [
      { level: 4, label: 'Très rapide', hint: '≥ 30 Mbps',  test: (v) => v >= 30 },      { level: 3, label: 'Rapide',      hint: '10 à 30 Mbps',  test: (v) => v >= 10 },
      { level: 2, label: 'Moyen',       hint: '5 à 10 Mbps',  test: (v) => v >= 5 },
      { level: 1, label: 'Lent',        hint: '0 à 5 Mbps',   test: () => true },
    ],
  },
  // Débit FIXE : mêmes tranches que le mobile (échelle unique, plus simple
  // à lire) — le seuil THD 30 Mb/s tombe naturellement sur la borne haute.
  debitFixe: {
    label: 'Speedtest',
    legendTitle: 'Débit descendant',
    available: true,
    unit: 'Mbps',
    metric: (p) => p.download,
    levels: [
      { level: 4, label: 'Très rapide', hint: '≥ 30 Mbps',  test: (v) => v >= 30 },      { level: 3, label: 'Rapide',      hint: '10 à 30 Mbps', test: (v) => v >= 10 },
      { level: 2, label: 'Moyen',       hint: '5 à 10 Mbps', test: (v) => v >= 5 },
      { level: 1, label: 'Lent',        hint: '0 à 5 Mbps', test: () => true },
    ],
  },
  // Débit montant : tranches adaptées à l'upload, toujours plus faible que
  // le download (3 à 10 fois sur réseau mobile). Appliquer la même échelle
  // qu'en descente classerait « lent » des uploads très corrects.
  // Repères : visio 1,5 Mbps, partage de connexion, envoi de fichiers.
  debitMontant: {
    label: 'Débit ↑',
    legendTitle: 'Débit montant',
    available: true,
    unit: 'Mbps',
    metric: (p) => p.upload,
    levels: [
      { level: 4, label: 'Très rapide', hint: '≥ 10 Mbps',  test: (v) => v >= 10 },      { level: 3, label: 'Rapide', hint: '5 à 10 Mbps', test: (v) => v >= 5 },
      { level: 2, label: 'Moyen',  hint: '1,5 à 5 Mbps', test: (v) => v >= 1.5 },
      { level: 1, label: 'Lent',   hint: '0 à 1,5 Mbps', test: () => true },
    ],
  },
  // Usage « Global » (bouton de carte) : combine débit descendant, débit
  // montant, latence, streaming et navigation en un seul jugement — ce que
  // vit réellement l'utilisateur (expérience réseau + usage). Moyenne des 5
  // niveaux (décision utilisateur) ; la légende n'est jamais affichée (le
  // score est calculé dans qualityLevel, cas dédié « global »).
  global: {
    label: 'Global',
    legendTitle: 'Score global : débit ↓ + ↑ + latence + streaming + navigation',
    available: true,
    unit: '',
    metric: null,
    levels: [
      { level: 4, label: 'Expérience très bonne',  hint: 'tous les indicateurs au top' },
      { level: 3, label: 'Expérience bonne',       hint: 'globalement fluide' },
      { level: 2, label: 'Expérience limitée',     hint: 'des lenteurs perceptibles' },
      { level: 1, label: 'Expérience dégradée',    hint: 'globalement lent' },
    ],
  },
  ping: {
    label: 'Latence',
    legendTitle: 'Latence',
    available: true,
    unit: 'ms',
    metric: (p) => (p.ping > 0 ? p.ping : null),
    // Inversé comme la navigation : plus court = meilleur
    levels: [
      { level: 4, label: 'Réactivité excellente', hint: '< 30 ms',  test: (v) => v < 30 },
      { level: 3, label: 'Réactivité bonne',      hint: '30 à 80 ms',  test: (v) => v < 80 },
      { level: 2, label: 'Réactivité limitée',    hint: '80 à 200 ms', test: (v) => v < 200 },
      { level: 1, label: 'Réactivité faible',     hint: '> 200 ms',    test: () => true },
    ],
  },
  streaming: {
    label: 'Streaming vidéo',
    legendTitle: 'Streaming vidéo',
    available: true,
    unit: 'pts',
    // streamingScore = 0 signifie « test non effectué » → niveau 0 (gris)
    metric: (p) => (p.streamingScore > 0 ? p.streamingScore : null),
    levels: [
      { level: 4, label: 'Streaming fluide',    hint: 'score ≥ 80', test: (v) => v >= 80 },
      { level: 3, label: 'Bon streaming',       hint: 'score 60 à 80', test: (v) => v >= 60 },
      { level: 2, label: 'Streaming limité',    hint: 'score 40 à 60', test: (v) => v >= 40 },
      { level: 1, label: 'Streaming difficile', hint: 'score < 40', test: () => true },
    ],
  },
  browsing: {
    label: 'Navigation web',
    legendTitle: 'Navigation web',
    available: true,
    unit: 'ms',
    // browsingAvgLoadMs = 0 signifie « test non effectué » → niveau 0 (gris)
    metric: (p) => (p.browsingAvgLoadMs > 0 ? p.browsingAvgLoadMs : null),
    // Inversé : plus le temps de chargement est court, meilleur c'est
    levels: [
      { level: 4, label: 'Navigation très fluide', hint: '< 2 s',    test: (v) => v < 2000 },
      { level: 3, label: 'Navigation fluide',      hint: '2 à 5 s',  test: (v) => v < 5000 },
      { level: 2, label: 'Navigation lente',       hint: '5 à 10 s', test: (v) => v < 10000 },
      { level: 1, label: 'Navigation très lente',  hint: '> 10 s',   test: () => true },
    ],
  },
};

// Référentiel du débit descendant selon le type de réseau choisi : profils
// D1-D4 ARCEP en mobile, repères THD (≥ 30 Mbps) en fixe.
function debitUsageKey(netType) {
  return netType === 'fixe' ? 'debitFixe' : 'debit';
}

// Retourne le niveau (1-4) d'un point pour l'usage donné, 0 si indisponible.
function qualityLevel(point, usageKey, debitKey) {
  const usage = USAGES[usageKey];
  if (!usage || !usage.available) return 0;
  // Usage « global » : chaque indicateur (débit ↓, latence, streaming,
  // navigation) est noté séparément puis moyenné — aucun ne peut masquer les
  // autres. Mesures absentes (0) ignorées : un test sans streaming reste noté
  // sur débit + latence + navigation. Le référentiel du débit descendant
  // dépend du réseau (mobile/fixe) : il est passé en paramètre par la carte.
  if (usageKey === 'global') {
    // Les 5 composantes du score global (décision utilisateur) : débit ↓,
    // débit ↑, latence, streaming, navigation — chacune notée séparément
    // puis moyennée, aucune ne peut masquer les autres.
    const dl = qualityLevel(point, debitKey);
    const up = qualityLevel(point, 'debitMontant');
    const pg = qualityLevel(point, 'ping');
    const st = qualityLevel(point, 'streaming');
    const br = qualityLevel(point, 'browsing');
    const parts = [dl, up, pg, st, br].filter((v) => v > 0); // 0 = mesure absente
    if (!parts.length) return 0;
    return Math.round(parts.reduce((s, v) => s + v, 0) / parts.length) || 1;
  }
  const value = usage.metric(point);
  if (value == null || isNaN(value)) return 0;
  for (const l of usage.levels) {
    if (l.test(value)) return l.level;
  }
  return 1;
}

function qualityColor(level) {
  return QUALITY_COLORS[level] || QUALITY_COLORS[0];
}

function qualityLabel(level, usageKey) {
  const usage = USAGES[usageKey || 'debit'];
  if (!usage || !usage.levels) return 'Indisponible';
  const found = usage.levels.find((l) => l.level === level);
  return found ? found.label : 'Indisponible';
}

// ─── Couleurs technologies réseau ────────────────────────────────────────────
// PALETTE UNIQUE du projet : ces couleurs sont EXACTEMENT celles de la
// légende de la carte de couverture (COVERAGE_COLORS de map.js) et celles de
// l'application mobile (YeleColors).
//
// RÈGLE : les technologies suivent la LOGIQUE DES DÉBITS — même teinte que la
// classe de débit correspondante :
//   2G = Lent (rouge --q1) · 3G = Moyen (orange --q2) ·
//   4G = Rapide (vert clair --q3) · 4G+ = Très rapide (vert --q4, app mobile)
// EXCEPTION (décision utilisateur) : la 5G est BLEUE — elle partageait le vert
// foncé de la 4G+ et était impossible à distinguer sur la carte de couverture.
// Le WiFi, lui, n'est pas une génération ni une classe de débit : couleur
// neutre (ardoise).

const NETWORK_COLORS = {
  '5G': '#2f6bff',   // bleu ciel : distingue la 5G du vert 4G/4G+ (décision utilisateur) — éclaircie le 06/10 : la première teinte n'était pas assez visible
  '4G+': '#7ac143',  // normalisé en 4G par la carte, mais variants bruts possibles (Ia/opérateurs) : même vert que 4G
  '4G': '#7ac143',   // = rapide (q3)
  '3G': '#f5a623',   // = moyen (q2)
  '2G': '#e0464b',   // = lent (q1)
  'WIFI': '#475569', // neutre : lier, pas une techno de données
  'WI-FI': '#475569',
  'LTE': '#7ac143',  // alias 4G
};

function networkColor(n) {
  if (!n) return '#94a3b8';
  return NETWORK_COLORS[String(n).toUpperCase()] || '#94a3b8';
}

// ─── Normalisation des technologies ──────────────────────────────────────────
// Le champ networkType mélange deux notions : la technologie radio (2G…5G) et,
// quand elle n'a pas pu être lue, le simple type de lien ("Mobile", "Web",
// "Web Connection"). Affichées telles quelles, ces valeurs apparaissent comme
// autant de technologies distinctes — d'où les doublons « Web » / « Web
// Connection » dans le panneau de filtres.
//
// Tout ce qui ne désigne pas une génération radio est donc regroupé sous un
// libellé unique : l'information « technologie inconnue » est réelle, elle ne
// doit pas se démultiplier.
const NETWORK_UNKNOWN = 'Non précisé';

function normalizeNetwork(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return NETWORK_UNKNOWN;
  if (raw === 'WIFI' || raw === 'WI-FI') return 'WiFi';
  const gen = raw.match(/\b([2345])\s*G\b/); // 4G, 4G+, LTE 4G…
  if (gen) return `${gen[1]}G`;
  if (raw === 'LTE') return '4G';
  // "MOBILE", "WEB", "WEB CONNECTION", "ETHERNET"… : pas une technologie radio.
  return NETWORK_UNKNOWN;
}

// ─── Normalisation des opérateurs ────────────────────────────────────────────
// Le champ `operator` est le fournisseur d'accès déduit de l'adresse IP, et il
// arrive abîmé : le nom est parfois coupé sur sa virgule interne côté collecte.
// « ONATEL (Office National des Telecommunications, PTT) » se retrouve ainsi
// scindé en deux opérateurs distincts dans toutes les statistiques.
//
// On rattache donc chaque nom à une entrée canonique, reconnue par un motif.
// L'ordre compte : le premier motif qui correspond gagne.
// `query` est le terme envoyé au backend par la vue Historique, qui filtre
// côté serveur sur le nom BRUT stocké en base. Il ne peut donc pas être le nom
// canonique — « ONATEL / Telmob » ne figure nulle part en base et ne ramènerait
// rien. Le backend faisant une correspondance partielle, un fragment distinctif
// du nom réel suffit. Chaque terme ci-dessous a été vérifié contre l'API :
// « ARCEP » est le contre-exemple qui impose ce champ, le nom brut de
// l'autorité ne contenant pas son propre sigle.
// Les trois opérateurs mobiles du Burkina Faso (liste fixe, référentiel
// ARCEP, libellés conformes à l'app mobile — revue du 10/11). Tout
// opérateur n'appartenant pas à cette liste est considéré comme un
// fournisseur d'accès fixe (FAI) et va dans la section dédiée du panneau.
const MOBILE_OPERATORS = ['Orange BF SA', 'Telecel Faso SA', 'Moov Africa SA'];

function isMobileOperator(name) {
  return MOBILE_OPERATORS.some((m) => String(name || '').toLowerCase().includes(m.toLowerCase().split(' ')[0]));
}

// `query` est le terme envoyé au backend par la vue Historique, qui filtre
// côté serveur sur le nom BRUT stocké en base. Il ne peut donc pas être le
// nom canonique — un fragment distinctif du nom réel suffit (cf. ARCEP).
// `short` reprend le nom canonique complet : les libellés d'opérateur
// affichés (sélecteur carte, vue Opérateurs, historique) sont les mêmes
// que ceux de l'app (demande 10/11).
const OPERATOR_RULES = [
  { test: /onatel|telmob|moov/i,          name: 'Moov Africa SA',      short: 'Moov Africa SA', query: 'Moov' },
  { test: /orange/i,                      name: 'Orange BF SA',        short: 'Orange BF SA',   query: 'Orange' },
  { test: /telecel/i,                     name: 'Telecel Faso SA',     short: 'Telecel Faso SA', query: 'TELECEL' },
  { test: /anptic|promotion des tic/i,    name: 'ANPTIC',              short: 'ANPTIC',  query: 'ANPTIC' },
  { test: /regulation des communications|arcep/i, name: 'ARCEP',       short: 'ARCEP',   query: 'Regulation' },
  { test: /\bgva\b/i,                     name: 'GVA',                 short: 'GVA',     query: 'GVA' },
];

// Nettoie un libellé de lieu.
//
// Le géocodage inverse répète souvent le même segment : « 1200 Logements,
// 1200 Logements, Ouagadougou, Burkina Faso », ou « Kalgodin, Kalgodin,
// Ouagadougou ». On ne garde que la première occurrence de chaque segment, ce
// qui raccourcit le libellé sans rien perdre.
function cleanPlace(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const seen = new Set();
  const parts = raw.split(',')
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      const key = s.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return parts.join(', ');
}

// Terme de recherche correspondant à un nom d'opérateur, pour le filtre serveur.
function operatorQuery(value) {
  const raw = String(value || '').trim();
  const rule = OPERATOR_RULES.find((r) => r.test.test(raw));
  return rule ? rule.query : raw;
}

function normalizeOperator(value) {
  // Les libellés d'opérateur déduits de l'IP arrivent parfois entourés de
  // guillemets parasites (« private IPv4 access" ») : on les retire avant
  // toute chose, sinon chaque variante de quoting crée un FAI distinct.
  const raw = String(value || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
  if (!raw) return 'Inconnu';
  const rule = OPERATOR_RULES.find((r) => r.test.test(raw));
  return rule ? rule.name : raw;
}

// Libellé court, pour les pastilles du panneau : les noms de FAI complets
// dépassent 60 caractères et passeraient à la ligne. Le nom entier reste
// accessible en infobulle.
function operatorShortLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'Inconnu';
  const rule = OPERATOR_RULES.find((r) => r.test.test(raw));
  if (rule) return rule.short;
  // Repli : on garde ce qui précède la première parenthèse, tronqué.
  const head = raw.split('(')[0].trim() || raw;
  return head.length > 18 ? `${head.slice(0, 17)}…` : head;
}

// ─── Couleurs opérateurs (attribuées dynamiquement, stables par nom) ────────

const OPERATOR_PALETTE = ['#0e7a4a', '#1d4ed8', '#ea580c', '#7c3aed', '#be185d', '#0891b2', '#ca8a04', '#475569'];
const operatorColorCache = {};

function operatorColor(name) {
  const key = (name || 'Inconnu').trim();
  if (!operatorColorCache[key]) {
    const idx = Object.keys(operatorColorCache).length % OPERATOR_PALETTE.length;
    operatorColorCache[key] = OPERATOR_PALETTE[idx];
  }
  return operatorColorCache[key];
}
