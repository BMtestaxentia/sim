# Brief de démarrage — Moteur de simulation (à destination de Claude Code)

De la part de l'instance Claude qui pilote le projet (conversation « moteur de simulation »), suite à ton état des lieux du 04/08/2026. Merci pour les corrections — le plan ci-dessous en tient compte intégralement.

## Décisions actées

1. **Toolchain** : installation de Node LTS sur le poste (recommandation acceptée). Si les droits utilisateur bloquent l'installeur classique, utiliser la distribution ZIP portable de Node + PATH utilisateur — aucun droit admin nécessaire. Vérifier `node -v` et `npm -v` avant toute suite.
2. **Langage** : JavaScript ESM pur + JSDoc + `// @ts-check` (PAS de TypeScript). Zéro build : le moteur doit tourner tel quel dans Node et dans le navigateur. Seule dépendance : Vitest (dev).
3. **Repo** : nouveau repo **privé** séparé, nom suggéré `moteur-sim` (compte BMtestaxentia). Justification : les fixtures de golden tests contiennent des annexes LEON d'opérations réelles. Ne jamais rien copier de ce repo vers `exnihilo` (public).
4. **Pas de base de données en phase 1** : moteur pur + fixtures JSON. Le Postgres de la VM viendra plus tard, ce n'est pas ton sujet pour l'instant.

## Fichiers fournis par Bastien (à placer dans le repo)

- `CLAUDE_MOTEUR.md` → à renommer `CLAUDE.md` à la racine du nouveau repo. Il contient l'architecture cible, les conventions et les règles non négociables. C'est ta référence permanente.
- `docs/DICTIONNAIRE_REGLES_MOTEUR_PLUSPLAI_v0.1.md` → la spécification métier (règles R-xxx, irrégularités I-xxx). Toute fonction publique cite les règles qu'elle implémente.
- `referentiels/baremes_2025.json` → barèmes réglementaires extraits de la matrice LEON (loyers par zone, valeurs de base, TA, quotités VEFA, TVA/LASM, constantes). Valeurs auditées, cellules sources citées dedans.
- `referentiels/trajectoires_axentia_2026.json` → scénario macro (Livret A, IRL, TFPB, GE... par année civile 2023-2073).

## Séquence de travail demandée

### Session 1 — Fondations
1. Vérifier/installer Node, initialiser le repo privé, `npm init` + Vitest, arborescence du CLAUDE.md.
2. Créer `src/arrondis.js` (politique d'arrondi centralisée) et `src/produits.js` (squelette des définitions paramétriques : PLUS, PLAI, LIBRE, LOC/LLI, PLS — champs : taux LASM, schéma de loyer, jeu de prêts par défaut).
3. Commit initial.

### Sessions 2-3 — Moteur d'amortissement (R-AMT-1 à R-AMT-5 du dictionnaire)
1. `src/amortissement.js` : annuité progressive (formule R-AMT-2), révision annuelle (R-AMT-4 : DOUBLE / D. LIMITÉE / SIMPLE), différés (types), date de première échéance PAR PRÊT (R-AMT-3 — c'est le bug historique, chaque prêt a sa propre année de départ), dernière échéance ajustée, préfinancement par échéancier mensuel avec capitalisation optionnelle (R-FIN-6).
2. `tests/amortissement.test.js` : cas canoniques — taux 0 (linéaire, cf. I-8 : LEON renvoie 0, nous on fait juste), progressivité 0 (annuité constante classique, vérifiable contre PMT), progressivité -0,5 %, révision LA à la hausse/baisse, différé avec/sans capitalisation, prêt 40 ans vs 60 ans, dernière échéance.
3. Point de comparaison : Bastien possède un optimiseur VBA validé à ±0,1 % des annuités LEON (avril 2026) — il peut fournir des jeux annuité/CRD de référence si besoin.

### Session 4+ — LIBRE bout-en-bout
Attendre que l'instance chat fournisse les fixtures Mulhouse (`entrees.json` / `attendus.json` extraites des annexes) — en préparation côté chat. Ne pas les reconstruire toi-même.

## Garde-fous

- `npm test` vert avant chaque commit. Ne jamais adapter une fixture pour faire passer un test.
- Aucun littéral métier dans le code (pas de 345, 0.77, 0.006 en dur) : tout vient de `referentiels/` ou des entrées.
- Moteur pur : pas d'I/O, pas de réseau, pas de date système implicite.
- En cas d'ambiguïté sur une règle métier : NE PAS deviner. Noter la question dans `docs/QUESTIONS_SPEC.md`, Bastien la remontera à l'instance chat qui a la matrice LEON sous la main et tranchera avec les cellules sources.

Bon démarrage.
