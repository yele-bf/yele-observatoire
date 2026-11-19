# Registre des révisions — `yele-bf/<DÉPÔT>`

> Une ligne par contribution **mergée** (CONTRIBUTING §5). Le hash de commit est
> complété **après** le merge. Vocabulaire de statut : `À faire | En cours |
> Transmis | Validé | Rejeté | À re-vérifier`.

| Date | Sous-ID (V14) | Type | Agent | Owner (classeur) | Branche / PR | Commit | Validation | Statut |
|---|---|---|---|---|---|---|---|---|
| 2026-10-28 | IMP-10 | feat | ZOUNGRANA Wendkuni Brice Yannick | SAWADOGO Wend-kuni Cédric / KOUNANGA Benoit / ZOUNGRANA Wendkuni Brice Yannick / OUEDRAOGO AZIZ | `imp/IMP-10-cartes-debit-5g` | _après merge_ | Dashboard local | En cours |
| 2026-10-30 | IMP-15 | feat | SANOU Zossoun Aristide Daouda | SANOU Zossoun Aristide Daouda | `imp/IMP-15-prevision-reseau` (PR #13) | `e65a913` | Dashboard local (Chrome) le 30/10/2026 : 90 points de prévision sur Ouagadougou, curseur 48 h, filtres, infobulle avec facteurs et seuil ARCEP ; `docs/preuves/IMP-15/`. Captures prises avec une autre instance du backend (`config.js` suspendu) : reproductibilité à refaire quand `mobiletest-j0c6` sera rétabli. Critère « bilans de liaison UIT-R » non couvert : critère reformulé acté en review de la PR #13 ; pas d'item de suivi ouvert (approche A seule). | Validé |
| 2026-10-30 | ISS-06 | fix | Wangraoua Aicha Bénédicte Flore Myriam | Wangraoua Aicha Bénédicte Flore Myriam | `iss/ISS-06-min-moy-max-debit-latence-dashboard` | `5dba6c2` | Dashboard local : colonnes crête download/upload et ping min dans l'historique | En cours |
| 2026-11-19 | IMP-10 | feat | Codebuff (assistant) | SAWADOGO Wend-kuni Cédric / KOUNANGA Benoit / ZOUNGRANA Wendkuni Brice Yannick / OUEDRAOGO AZIZ | `feat/qoe-qualite-percue` (PR #35) | `a3f340e` (fusion squash) | Panneau de qualité perçue sur la carte du dashboard (`js/qoe.js`), légende, bouton `data-mt="qoe"` et filtre par note (`js/map.js`), état et appels (`js/api.js`, `js/app.js`) ; `node --check` sur les 5 fichiers JS avant merge, publié sur GitHub Pages | Validé |

## Nomenclature V14 vs V11 vs V4 (à lire avant de citer un Sous-ID)

- **V14 (19/10/2026) = V11 + IMP-14** (conditions d'utilisation au premier lancement, P3, `mobilefront`) **+ IMP-15** (prévision de la qualité réseau, P1, `New_web`) : 27 items.

- **Baromètre de comparaison = IMP-09 en V11** (il s'appelait **IMP-11 en V4**).
  Deux commits déjà poussés portent l'ancien libellé et doivent être référencés
  comme **IMP-09** : `16d2a89` (mobilefront), `836b4cf` (mobiletest).
- **IMP-11 en V11 = export CSV/JSON** des mesures depuis le dashboard ou l'API :
  **pas encore implémenté** (périmètre `mobiletest` + `New_web`). Ne jamais
  citer `IMP-11` pour le baromètre.

## État connu au 14/10/2026 (audit des commits déjà poussés)

Cette section est documentaire : elle reflète l'historique **antérieur** à la
mise en place du garde-fou, dont les commits ne respectent pas encore le §2.

| Sous-ID | Commits poussés | Validation | Statut |
|---|---|---|---|
| IMP-09 | `16d2a89` (mobilefront), `836b4cf` (mobiletest) — libellé « IMP-11 » au moment du commit | Local (écran résultat + base) | Validé |
| IMP-04 | `f9c2f0e` | APK réel | Validé |
| IMP-08 | `1f6f62a` | APK réel | Validé |
| IMP-13 | `fb7cccd`, `7f81eac` | APK réel | Validé |
| ISS-09 | `1a889e3` | APK (GPS off) | Validé |
| ISS-12 | `709dd26` | Chrome + APK | Validé |

## Suivi des 27 items V14 (tableau d'avancement — **ne vaut pas preuve de contribution**, §5)

> **ISS-08 déclassé le 27/10/2026** — l'item n'est plus suivi : la solution
> YELE déjà portée par les quatre dépôts couvre mieux l'objectif. Décision
> d'équipe après démonstration de l'implémentation en local ; le classeur V14
> reste inchangé.

| Sous-ID | Intitulé (V14) | Owner (classeur) | Statut classeur |
|---|---|---|---|
| IMP-01 | Consommation data — P3 | COMPAORE Bobodo Kévin Aymar | Valide |
| IMP-04 | Permissions — P3 | COMPAORE Bobodo Kévin Aymar | Valide |
| IMP-08 | Consommation data — P3 | COMPAORE Bobodo Kévin Aymar | Valide |
| IMP-13 | Identification appareil — P3 | COMPAORE Bobodo Kévin Aymar | Valide |
| IMP-02 | Paramètres — P3 | NANA Amoin Agnès / Cissé Aboubacar Sidiki | Valide |
| IMP-14 | Condition d'utilisation — P3 | SANOU Zossoun Aristide Daouda | Valide |
| IMP-15 | Prevision reseau — P1 | SANOU Zossoun Aristide Daouda | Valide |
| IMP-03 | Compte utilisateur — P3 | SANOU Zossoun Aristide Daouda / SANNA Abdoul Salam | Valide |
| IMP-09 | Comparaison — P3 | SANOU Zossoun Aristide Daouda / SANNA Abdoul Salam | Valide |
| IMP-10 | Dashboard / Carte — P3 | SAWADOGO Wend-kuni Cédric / KOUNANGA Benoit / ZOUNGRANA Wendkuni Brice Yannick / OUEDRAOGO AZIZ | Valide |
| ISS-08 | Synchronisation — P2 | BAMBA Seydou / NANEMA Wendinkonté Dimitri Judicaël | **Déclassé** (27/10) |
| IMP-11 | Données / Export — P2 | COMPAORE Bobodo Kévin Aymar | Valide |
| ISS-09 | GPS — P2 | COMPAORE Bobodo Kévin Aymar | Valide |
| ISS-11 | Dashboard / Carte — P2 | COMPAORE Bobodo Kévin Aymar | Valide |
| ISS-12 | Paramètres — P2 | COMPAORE Bobodo Kévin Aymar | Valide |
| IMP-06 | Référentiel ARCEP — P2 | NIKIEMA Abdoul Fatahou / NONGUIERMA WENDINSOO LEONEL | Valide |
| IMP-07 | Débit / Latence — P2 | SANOU Zossoun Aristide Daouda / TRAORE Oumou Kal / Ilboudo Wendpagnagdé Elsa Fleur | Valide |
| ISS-07 | Streaming — P2 | SAWADOGO Hassan Achraf Ammar | Valide |
| ISS-10 | Historique — P2 | SAWADOGO Hassan Achraf Ammar | Valide |
| IMP-05 | Échelle de score — P2 | TRAORE Abdoulaye / KIEMA François | Valide |
| IMP-12 | Échelle de score — P2 | TRAORE Abdoulaye / KIEMA François | Valide |
| ISS-06 | Débit / Latence — P2 | Wangraoua Aicha Bénédicte Flore Myriam / SAWADOGO Sutongnoma Saturnin | Valide |
| ISS-02 | Identification réseau — P1 | BAMBA Seydou / NANEMA Wendinkonté Dimitri Judicaël | Valide |
| ISS-04 | Serveur — P1 | KOHOUN Damou Daniel / TAMINI Heremave | Valide |
| ISS-01 | Mesures radio — P1 | SAWADOGO Hassan Achraf Ammar | Valide |
| ISS-03 | Identification réseau — P1 | SAWADOGO Hassan Achraf Ammar | Valide |
| ISS-05 | Comparaison — P1 | ZOUNGRANA Wendkuni Brice Yannick / OUEDRAOGO AZIZ | Valide |
