// ─── Configuration du backend ────────────────────────────────────────────────
// Production : backend Go hébergé sur Render (yele-bf/mobiletest).
// Le service IA est appelé via le proxy du backend (/api/ai/*), jamais en
// direct (le service IA n'expose pas de CORS pour les navigateurs).
// En développement local, utiliser http://localhost:8989
//
// Le cadrage de la carte n'est plus réglable ici : elle se cale sur le contour
// du Burkina Faso défini dans js/burkina.js.
const CONFIG = {
  API_BASE_URL: 'https://yele-backend.onrender.com',
};
