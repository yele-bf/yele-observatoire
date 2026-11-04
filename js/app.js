// ─── Application : navigation entre vues, recherche d'adresse, notifications ─

const App = (() => {
  // ── Navigation entre vues ───────────────────────────────────────────────────

  function switchView(name) {
    currentView = name;
    document.querySelectorAll('.topnav-item').forEach((b) =>
      b.classList.toggle('active', b.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) =>
      v.classList.toggle('active', v.id === 'view-' + name));

    if (name === 'map') MapView.invalidate();
    if (name === 'operators') Operators.show();
    if (name === 'stats') Stats.show();
    if (name === 'history') History.show();
    if (name === 'forecast') Forecast.show();
    if (name === 'ai') AIView.show();
  }

  // ── Recherche d'adresse (géocodage) ─────────────────────────────────────────

  function bindSearch() {
    const input = document.getElementById('search-input');
    const resultsBox = document.getElementById('search-results');
    let debounce = null;

    input.addEventListener('input', () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      if (q.length < 3) { resultsBox.classList.remove('open'); return; }
      debounce = setTimeout(async () => {
        const results = await API.geocode(q);
        if (!results.length) {
          resultsBox.innerHTML = '<div class="search-result">Aucun résultat</div>';
        } else {
          resultsBox.innerHTML = results.map((r) => `
            <div class="search-result" data-lat="${escapeHtml(r.lat)}" data-lon="${escapeHtml(r.lon)}">
              ${escapeHtml(r.display_name.split(',')[0])}
              <small>${escapeHtml(r.display_name)}</small>
            </div>`).join('');
          resultsBox.querySelectorAll('.search-result[data-lat]').forEach((el) => {
            el.addEventListener('click', () => {
              const name = el.textContent.trim().split('\n')[0];
              const lat = parseFloat(el.dataset.lat);
              const lng = parseFloat(el.dataset.lon);
              // Hors Burkina : rien à montrer sur une carte bornée au pays.
              if (!MapView.isInsideCountry(lat, lng)) {
                toast('Ce lieu est hors du Burkina Faso : la carte ne couvre '
                  + 'que le pays.');
                return;
              }
              // La vue doit être basculée AVANT de poser le repère. Tant que la
              // carte est masquée, son conteneur est de taille nulle : Leaflet
              // ne sait ni la centrer ni y dessiner, et le repère n'apparaît
              // pas. C'est l'ordre déjà utilisé depuis l'historique et la vue
              // Opérateurs, où le repère fonctionne.
              switchView('map');
              MapView.showMeasurement(lat, lng, name, 13);
              resultsBox.classList.remove('open');
              input.value = name;
            });
          });
        }
        resultsBox.classList.add('open');
      }, 400);
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.searchbox')) resultsBox.classList.remove('open');
    });
  }

  // ── Fraîcheur des données (ISS-08) ──────────────────────────────────────────
  // Les mesures mettaient du temps à apparaître : le cache de l'API n'expirait
  // jamais, si bien qu'un onglet ouvert restait figé sur son premier
  // chargement. Le cache expire désormais, et la vue affichée se réactualise
  // d'elle-même à la cadence de CONFIG.REFRESH_SECONDS.

  let refreshing = false;
  let currentView = 'map';

  /// Recharge la vue affichée en repartant du serveur.
  async function refresh({ silent = false } = {}) {
    // Un rafraîchissement peut durer une minute si le serveur sort de veille :
    // sans ce garde-fou, les appels automatiques s'empileraient.
    if (refreshing) return;
    refreshing = true;
    try {
      API.invalidate();
      await MapView.reload();
      // Les autres vues se reconstruisent à partir des points de la carte :
      // on les réinitialise pour qu'elles les relisent au prochain affichage.
      Operators.reset();
      Stats.reset();
      History.reload();
      if (currentView === 'operators') Operators.show();
      if (currentView === 'stats') Stats.show();
      if (!silent) toast('Données actualisées.');
    } catch (e) {
      if (!silent) toast('Actualisation impossible : ' + e.message);
    } finally {
      refreshing = false;
    }
  }

  function startAutoRefresh() {
    const period = (CONFIG.REFRESH_SECONDS || 60) * 1000;
    setInterval(() => {
      // Inutile de solliciter le serveur pour un onglet que personne ne
      // regarde : le navigateur suspend d'ailleurs les minuteurs en arrière-plan.
      if (document.hidden) return;
      refresh({ silent: true });
    }, period);
  }

  // ── Bannière "bientôt disponible" & toast ───────────────────────────────────

  let bannerTimer = null;
  function showSoonBanner(title, text) {
    const banner = document.getElementById('soon-banner');
    document.getElementById('soon-banner-title').textContent = title + ' : bientôt disponible';
    document.getElementById('soon-banner-text').textContent = text;
    banner.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => banner.classList.remove('show'), 6000);
  }

  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
  }

  // ── Thème clair / sombre ─────────────────────────────────────────────────
  // L'attribut data-theme est posé avant rendu par le script inline du <head>
  // (anti-flash). Ici : la bascule au clic, la mémorisation, et la mise à jour
  // des éléments dont la couleur ne suit pas les variables CSS (tuiles de la
  // carte, graphiques Chart.js déjà construits).
  function initTheme() {
    const btn = document.getElementById('theme-toggle');
    // Garde défensive : si le bouton est absent du fichier index.html
    // (rétrocompatibilité), l'application doit continuer de fonctionner sans
    // bascule de thème — et non planter à init() (cf. incident du 03/11).
    if (!btn) return;
    btn.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('yele-theme', next); } catch (e) { /* stockage indisponible : tant pis, la bascule tient à la page */ }
      syncThemeTitle();
      // Prévenir les modules déjà rendus (carte, graphiques) que les couleurs
      // de fond ont changé sous leurs pieds.
      document.dispatchEvent(new CustomEvent('yele-theme', { detail: next }));
    });
    syncThemeTitle();
  }
  function syncThemeTitle() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    btn.title = dark ? 'Passer en thème clair' : 'Passer en thème sombre';
  }

  // ── Initialisation ──────────────────────────────────────────────────────────

  function init() {
    initTheme();
    document.querySelectorAll('.topnav-item').forEach((btn) =>
      btn.addEventListener('click', () => switchView(btn.dataset.view)));
    document.getElementById('soon-banner-close').addEventListener('click', () =>
      document.getElementById('soon-banner').classList.remove('show'));

    bindSearch();
    MapView.init();
    startAutoRefresh();

    // Liens profonds : ?view=stats ouvre une vue, ?usage=streaming sélectionne un usage
    const params = new URLSearchParams(location.search);
    const requested = params.get('view');
    if (requested && document.getElementById('view-' + requested)) switchView(requested);
    const usage = params.get('usage');
    if (usage) document.querySelector(`.usage-tab[data-usage="${usage}"]`)?.click();
  }

  document.addEventListener('DOMContentLoaded', init);

  return { toast, showSoonBanner, switchView };
})();
