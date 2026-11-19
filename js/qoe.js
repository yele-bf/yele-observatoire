// ─── Vue Qualité perçue : ce que les utilisateurs déclarent ──────────────────
// Dashboard validé (croquis du 19/11/2026) : 6 blocs —
//   1. KPIs (réponses, part des tests évalués, note vitesse, satisfaits,
//      coupures vidéo) ;
//   2. Ressenti vs mesure (satisfaction /5 et débit médian par opérateur) ;
//   3. Note vitesse × débit mesuré (nuage de points) ;
//   4. Satisfaction globale (barre empilée 5 niveaux) ;
//   5. Profil des répondants (âge, genre, ancienneté) ;
//   6. Qualité perçue par opérateur + améliorations prioritaires.
// Les commentaires libres ne sortent JAMAIS du backend (`json:"-"`) : rien
// ici ne les affiche, et aucune vue ne les reçoit.
// Seuil : le backend masque les agrégats sous 10 réponses (`minSample`).

const QoeView = (() => {
  let bound = false;
  let loading = false;
  let loaded = false;
  let stats = null;
  let scatterChart = null;
  let scatterPoints = [];
  let requestSeq = 0;

  const state = {
    reseau: 'mobile',  // mobile | fixe
    operator: '',      // '' = tous
    tech: '',          // '' = toutes (mobile uniquement)
    period: 'all',     // all | hour | day | week | month | year
  };

  // Opérateurs connus par réseau : on part du référentiel ARCEP (mêmes
  // libellés que l'app) et on complète avec ceux réellement présents en base.
  const knownOperators = {
    mobile: [...MOBILE_OPERATORS],
    fixe: ['Orange BF SA', 'Moov Africa SA', 'Canal Box'],
  };

  const PERIODS = {
    all: 'Tout', hour: 'Heure', day: 'Jours',
    week: 'Semaines', month: 'Mois', year: 'Années',
  };

  const NETWORKS = { mobile: 'Mobile', fixe: 'Fixe' };

  // ── Formatage ──────────────────────────────────────────────────────────────

  const fmtInt = (v) => Number(v || 0).toLocaleString('fr-FR');
  const fmt1 = (v) => Number(v || 0).toLocaleString('fr-FR', {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  });
  const fmtPct = (v) => `${fmt1(v)} %`;

  // Couleur d'une satisfaction moyenne (sur 5), même logique que la carte.
  function satisfactionColor(avg) {
    if (!avg) return getCss('--q0') || '#9aa1b1';
    if (avg >= 4.5) return qoeColor('very_satisfied');
    if (avg >= 3.5) return qoeColor('satisfied');
    if (avg >= 2.5) return qoeColor('neutral');
    if (avg >= 1.5) return qoeColor('unsatisfied');
    return qoeColor('very_unsatisfied');
  }

  // ── Profil : libellés et ordre des réponses du XLSForm ────────────────────

  const PROFILE_GROUPS = [
    {
      key: 'age',
      title: "Tranche d'âge",
      order: ['moins_20', '20_40', 'plus_40'],
      labels: { moins_20: 'Moins de 20 ans', '20_40': '20 à 40 ans', plus_40: 'Plus de 40 ans' },
    },
    {
      key: 'genre',
      title: 'Genre',
      order: ['masculin', 'feminin'],
      labels: { masculin: 'Masculin', feminin: 'Féminin' },
    },
    {
      key: 'anciennete',
      title: "Ancienneté chez l'opérateur",
      order: ['moins_6_mois', '1_5_ans', 'plus_5_ans'],
      labels: {
        moins_6_mois: 'Moins de 6 mois',
        '1_5_ans': '1 à 5 ans',
        plus_5_ans: 'Plus de 5 ans',
      },
    },
  ];

  // ── Améliorations : libellés exacts du questionnaire ──────────────────────

  const IMPROVEMENT_LABELS = {
    baisser_prix: 'Baisser le prix des forfaits Internet',
    pluie_vent: 'Éviter les coupures du réseau pendant la pluie ou le vent',
    coupures_electricite: "Garder le réseau disponible pendant les coupures d'électricité",
    gestion_data: 'Éviter que les mégas Internet finissent trop vite',
    indoor: "Améliorer le réseau à l'intérieur des maisons et bureaux",
    heures_pointe: "Rendre l'Internet plus rapide aux heures de pointe, surtout le soir",
    evenements_fetes: 'Améliorer le réseau pendant les grands événements et fêtes',
    deplacement: 'Éviter les coupures Internet lors des déplacements',
    zones_rurales: 'Étendre le réseau mobile dans les zones rurales',
    reduire_delais_installation: "Réduire les délais d'installation et de raccordement",
    reparer_pannes_rapidement: 'Réparer plus rapidement les pannes',
    etendre_fibre: 'Étendre la fibre dans plus de quartiers et de villes',
    autre: 'Autre amélioration à préciser',
  };

  // ── Filtres ────────────────────────────────────────────────────────────────

  function buildOperatorSelect() {
    const sel = document.getElementById('qoe-operator');
    if (!sel) return;
    const ops = knownOperators[state.reseau];
    if (state.operator && !ops.includes(state.operator)) ops.push(state.operator);
    const allLabel = state.reseau === 'mobile' ? 'Tous les opérateurs' : 'Tous les fournisseurs';
    sel.innerHTML = `<option value="">${allLabel}</option>`
      + ops.map((op) => `<option value="${escapeHtml(op)}">${escapeHtml(op)}</option>`).join('');
    if (!ops.includes(state.operator)) state.operator = '';
    sel.value = state.operator;
  }

  function mergeOperators(byOperator) {
    (byOperator || []).forEach((o) => {
      const name = String(o.operator || '').trim();
      if (!name || name === 'Inconnu') return;
      const list = knownOperators[state.reseau];
      if (!list.includes(name)) list.push(name);
    });
  }

  function syncFilters() {
    document.querySelectorAll('#qoe-net-type .toggle').forEach((b) =>
      b.classList.toggle('active', b.dataset.net === state.reseau));
    document.querySelectorAll('#qoe-period .toggle').forEach((b) =>
      b.classList.toggle('active', b.dataset.period === state.period));
    // La technologie ne veut rien dire en fixe (Wi-Fi / fibre).
    const techZone = document.getElementById('qoe-tech-zone');
    if (techZone) techZone.hidden = state.reseau !== 'mobile';
    buildOperatorSelect();
  }

  // ── Chargement ─────────────────────────────────────────────────────────────

  function setStatus(html) {
    const el = document.getElementById('qoe-status');
    if (el) el.innerHTML = html;
  }

  async function load() {
    // Une requête par frappe de filtre au maximum : la précédente est ignorée
    // à son retour (requestSeq), sans bloquer l'interface.
    const seq = ++requestSeq;
    loading = true;
    setStatus('<span class="qoe-loading">Chargement des réponses…</span>');
    try {
      const data = await API.qoe({
        reseau: state.reseau,
        operator: state.operator,
        tech: state.reseau === 'mobile' ? state.tech : '',
        period: state.period,
      });
      if (seq !== requestSeq) return;
      stats = data || {};
      mergeOperators(stats.byOperator);
      buildOperatorSelect();
      render();
      loaded = true;
    } catch (e) {
      if (seq !== requestSeq) return;
      stats = null;
      setStatus(`<span class="qoe-error">Données indisponibles : ${escapeHtml(e.message)}</span>`
        + '<button class="btn-ghost qoe-retry" id="qoe-retry" type="button">Réessayer</button>');
    } finally {
      if (seq === requestSeq) loading = false;
    }
  }

  // ── Rendu ──────────────────────────────────────────────────────────────────

  function render() {
    const s = stats || {};
    const responses = Number(s.responses || 0);
    const minSample = Number(s.minSample || 10);
    const testsTotal = Number(s.testsTotal || 0);

    // Statut : base de calcul lisible, jamais un chiffre sans contexte.
    const parts = [
      `<b>${fmtInt(responses)}</b> réponse${responses > 1 ? 's' : ''}`,
      `réseau ${NETWORKS[state.reseau] || state.reseau}`,
      `période : ${PERIODS[state.period] || state.period}`,
    ];
    if (testsTotal > 0) parts.push(`${fmt1(100 * responses / testsTotal)} % des tests de la période`);
    setStatus(parts.join(' · '));

    // KPIs.
    document.getElementById('qoe-kpi-responses').textContent = fmtInt(responses);
    document.getElementById('qoe-kpi-rate').textContent =
      testsTotal > 0 ? fmtPct(100 * responses / testsTotal) : '—';
    document.getElementById('qoe-kpi-rating').textContent =
      s.avgRating > 0 ? `${fmt1(s.avgRating)} / 5` : '—';
    document.getElementById('qoe-kpi-satisfied').textContent =
      responses > 0 ? fmtPct(s.satisfiedPct) : '—';
    document.getElementById('qoe-kpi-cuts').textContent =
      s.videoAnswered > 0 ? fmtPct(s.videoCutsPct) : '—';

    const body = document.getElementById('qoe-body');
    const empty = document.getElementById('qoe-empty');
    const enough = responses >= minSample;

    if (!enough) {
      if (body) body.hidden = true;
      if (empty) {
        empty.hidden = false;
        const text = responses === 0
          ? 'Aucune réponse pour ces filtres. Les évaluations arrivent avec les tests de l\'application.'
          : `${fmtInt(responses)} réponse${responses > 1 ? 's' : ''} pour l'instant : le seuil de publication est de ${minSample}.`;
        document.getElementById('qoe-empty-text').textContent = text;
      }
      if (scatterChart) { scatterChart.destroy(); scatterChart = null; }
      return;
    }

    if (body) body.hidden = false;
    if (empty) empty.hidden = true;

    renderBars(s.byOperator || []);
    renderScatter(s.points || []);
    renderSatisfaction(s);
    renderProfile(s.profile || {});
    renderOperatorTable(s.byOperator || []);
    renderImprovements(s);
  }

  // ── Bloc 2 : ressenti vs mesure ────────────────────────────────────────────

  function renderBars(byOperator) {
    const wrap = document.getElementById('qoe-bars');
    if (!wrap) return;
    if (!byOperator.length) {
      wrap.innerHTML = '<p class="qoe-empty-inline">Aucun opérateur n\'atteint le seuil de 10 réponses.</p>';
      return;
    }
    const maxDl = Math.max(...byOperator.map((o) => Number(o.medianDownload) || 0), 1);
    wrap.innerHTML = byOperator.map((o) => {
      const sat = Number(o.avgSatisfaction) || 0;
      const dl = Number(o.medianDownload) || 0;
      return `
        <div class="qoe-gcol">
          <div class="qoe-bar-pair">
            <div class="qoe-bar" style="height:${Math.max(2, sat / 5 * 100)}%;background:${satisfactionColor(sat)}"
                 title="Satisfaction moyenne : ${fmt1(sat)} / 5">
              <span>${sat > 0 ? `${fmt1(sat)}/5` : '·'}</span>
            </div>
            <div class="qoe-bar qoe-bar-dl" style="height:${Math.max(2, dl / maxDl * 100)}%"
                 title="Débit médian mesuré : ${fmt1(dl)} Mb/s">
              <span>${dl > 0 ? fmt1(dl) : '·'}</span>
            </div>
          </div>
          <div class="qoe-gname">
            <i class="qoe-dot" style="background:${operatorColor(o.operator)}"></i>
            ${escapeHtml(o.operator)}
          </div>
        </div>`;
    }).join('');
  }

  // ── Bloc 3 : nuage note × débit ────────────────────────────────────────────

  function renderScatter(points) {
    const canvas = document.getElementById('qoe-scatter');
    const sub = document.getElementById('qoe-scatter-sub');
    if (!canvas) return;
    scatterPoints = points;
    if (sub) {
      sub.textContent = points.length
        ? `Chaque point = une réponse avec sa mesure (${fmtInt(points.length)} points).`
        : 'Aucune réponse ne porte à la fois une note et un débit mesuré.';
    }
    if (scatterChart) { scatterChart.destroy(); scatterChart = null; }
    if (!points.length) return;

    if (typeof Chart === 'undefined') return;
    Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
    Chart.defaults.color = getCss('--text-soft') || '#5d6478';

    scatterChart = new Chart(canvas, {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Réponses',
          data: points.map((p) => ({
            x: Number(p.download) || 0,
            y: Number(p.rating) || 0,
            op: p.operator || '',
          })),
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBorderWidth: 0,
          backgroundColor: points.map((p) => operatorColor(p.operator)),
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const r = ctx.raw || {};
                return `${r.op ? r.op + ' · ' : ''}${fmt1(r.x)} Mb/s · note ${r.y}/5`;
              },
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            title: { display: true, text: 'Débit mesuré (Mb/s)' },
          },
          y: {
            min: 0.5,
            max: 5.5,
            ticks: { stepSize: 1 },
            title: { display: true, text: 'Note déclarée (1→5)' },
          },
        },
      },
    });
  }

  // ── Bloc 4 : satisfaction globale ──────────────────────────────────────────

  function renderSatisfaction(s) {
    const stack = document.getElementById('qoe-sat-stack');
    const legend = document.getElementById('qoe-sat-legend');
    const sub = document.getElementById('qoe-sat-sub');
    const responses = Number(s.responses || 0);
    if (sub) {
      sub.innerHTML = '« Globalement, comment évaluez-vous la qualité du réseau de votre opérateur ? »'
        + ` — <b>${fmtInt(responses)} réponse${responses > 1 ? 's' : ''}</b>`;
    }
    const counts = s.satisfaction || {};
    if (!stack) return;
    const rows = QOE_SATISFACTION_ORDER.map((code) => {
      const n = Number(counts[code] || 0);
      const pct = responses > 0 ? n / responses * 100 : 0;
      return `
        <div class="qoe-stack-seg" style="width:${pct}%;background:${qoeColor(code)}"
             title="${escapeHtml(qoeSatisfactionLabel(code))} : ${fmtInt(n)} (${fmt1(pct)} %)">
          ${pct >= 8 ? `${fmt1(pct)} %` : ''}
        </div>`;
    }).join('');
    stack.innerHTML = rows || '<div class="qoe-stack-empty">Aucune réponse</div>';

    if (legend) {
      legend.innerHTML = QOE_SATISFACTION_ORDER.map((code) => {
        const n = Number(counts[code] || 0);
        const pct = responses > 0 ? n / responses * 100 : 0;
        return `<span><i class="qoe-swatch" style="background:${qoeColor(code)}"></i>`
          + `${escapeHtml(qoeSatisfactionLabel(code))} <b>${fmt1(pct)} %</b></span>`;
      }).join('');
    }
  }

  // ── Bloc 5 : profil des répondants ────────────────────────────────────────

  function renderProfile(profile) {
    const wrap = document.getElementById('qoe-profile');
    if (!wrap) return;
    wrap.innerHTML = PROFILE_GROUPS.map((group) => {
      const values = profile[group.key] || {};
      const total = group.order.reduce((sum, key) => sum + Number(values[key] || 0), 0);
      const lines = group.order.map((key) => {
        const n = Number(values[key] || 0);
        const pct = total > 0 ? n / total * 100 : 0;
        return `
          <div class="qoe-pline">
            <span class="qoe-plabel">${escapeHtml(group.labels[key] || key)}</span>
            <span class="qoe-ptrack"><i style="width:${pct}%"></i></span>
            <span class="qoe-pct">${total > 0 ? fmtPct(pct) : '—'}</span>
          </div>`;
      }).join('');
      return `
        <div class="qoe-profile-block">
          <div class="qoe-profile-title">${escapeHtml(group.title)}</div>
          ${lines}
        </div>`;
    }).join('');
  }

  // ── Bloc 6 : tableau par opérateur ─────────────────────────────────────────

  function renderOperatorTable(byOperator) {
    const tbody = document.querySelector('#qoe-op-table tbody');
    if (!tbody) return;
    if (!byOperator.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="qoe-empty-inline">'
        + 'Aucun opérateur n\'atteint le seuil de 10 réponses pour ces filtres.</td></tr>';
      return;
    }
    tbody.innerHTML = byOperator.map((o) => `
      <tr>
        <td><span class="op-dot" style="background:${operatorColor(o.operator)}"></span>${escapeHtml(o.operator)}</td>
        <td class="num"><b>${fmtInt(o.responses)}</b></td>
        <td class="num">${o.avgSatisfaction > 0 ? `${fmt1(o.avgSatisfaction)} / 5` : '—'}</td>
        <td class="num">${fmtPct(o.unsatisfiedPct)}</td>
        <td class="num">${o.avgRating > 0 ? `${fmt1(o.avgRating)} / 5` : '—'}</td>
        <td class="num">${fmtPct(o.pagesOftenPct)}</td>
        <td class="num">${fmtPct(o.videoCutsPct)}</td>
        <td class="num">${o.medianDownload > 0 ? `${fmt1(o.medianDownload)} Mb/s` : '—'}</td>
      </tr>`).join('');
  }

  // ── Bloc 6 bis : améliorations prioritaires ────────────────────────────────

  function improvementRows(items) {
    const visible = (items || []).filter((it) => it.key && it.key !== 'aucune_reponse');
    if (!visible.length) {
      return '<p class="qoe-empty-inline">Aucune réponse sur ce réseau.</p>';
    }
    return visible.map((it) => {
      const label = IMPROVEMENT_LABELS[it.key] || it.key;
      const pct = Number(it.pct) || 0;
      return `
        <div class="qoe-amel">
          <div class="qoe-amel-lab">
            <span>${escapeHtml(label)}</span><b>${fmtPct(pct)}</b>
          </div>
          <div class="qoe-ptrack"><i style="width:${Math.min(100, pct)}%"></i></div>
        </div>`;
    }).join('');
  }

  function renderImprovements(s) {
    const mobile = document.getElementById('qoe-improve-mobile');
    const fixe = document.getElementById('qoe-improve-fixe');
    const mobileN = document.getElementById('qoe-improve-mobile-n');
    const fixeN = document.getElementById('qoe-improve-fixe-n');
    if (mobile) mobile.innerHTML = improvementRows(s.ameliorationsMobile);
    if (fixe) fixe.innerHTML = improvementRows(s.ameliorationsFixe);
    if (mobileN) mobileN.textContent = s.ameliorationsMobileN > 0
      ? `· ${fmtInt(s.ameliorationsMobileN)} répondant${s.ameliorationsMobileN > 1 ? 's' : ''}` : '';
    if (fixeN) fixeN.textContent = s.ameliorationsFixeN > 0
      ? `· ${fmtInt(s.ameliorationsFixeN)} répondant${s.ameliorationsFixeN > 1 ? 's' : ''}` : '';
  }

  // ── Liaisons ───────────────────────────────────────────────────────────────

  function bind() {
    if (bound) return;
    bound = true;

    document.querySelectorAll('#qoe-net-type .toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.reseau = btn.dataset.net === 'fixe' ? 'fixe' : 'mobile';
        state.tech = '';
        const tech = document.getElementById('qoe-tech');
        if (tech) tech.value = '';
        syncFilters();
        load();
      });
    });

    const operator = document.getElementById('qoe-operator');
    if (operator) {
      operator.addEventListener('change', () => {
        state.operator = operator.value;
        load();
      });
    }

    const tech = document.getElementById('qoe-tech');
    if (tech) {
      tech.addEventListener('change', () => {
        state.tech = tech.value;
        load();
      });
    }

    document.querySelectorAll('#qoe-period .toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.period = btn.dataset.period || 'all';
        syncFilters();
        load();
      });
    });

    const apply = document.getElementById('qoe-apply');
    if (apply) apply.addEventListener('click', () => load());

    const reset = document.getElementById('qoe-reset');
    if (reset) {
      reset.addEventListener('click', () => {
        state.operator = '';
        state.tech = '';
        state.period = 'all';
        const tech = document.getElementById('qoe-tech');
        if (tech) tech.value = '';
        syncFilters();
        load();
      });
    }

    // Bouton « Réessayer » inséré dans le statut d'erreur.
    const status = document.getElementById('qoe-status');
    if (status) {
      status.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'qoe-retry') load();
      });
    }

    // Le nuage suit le thème (Chart.js ne relit pas ses couleurs par défaut).
    document.addEventListener('yele-theme', () => {
      if (!built()) return;
      if (scatterChart) renderScatter(scatterPoints);
    });
  }

  function built() {
    return !!document.getElementById('view-qoe');
  }

  function show() {
    bind();
    syncFilters();
    if (!loaded && !loading) load();
  }

  /// Réinitialise pour le rafraîchissement global (API.invalidate() a déjà
  /// vidé le cache) : le prochain affichage repartira du serveur.
  function reload() {
    loaded = false;
  }

  return { show, reload };
})();
