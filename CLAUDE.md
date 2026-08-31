# CLAUDE.md - Moteur de simulation d'opérations (successeur LEON)

> Règles du projet pour toute instance Claude (Code ou chat) travaillant sur ce repo. Lire avant de toucher au code.

## 1. Objet du projet

Moteur de calcul de simulations financières d'opérations de logement social (construction / VEFA / acquisition-amélioration), réécrit à partir de la rétro-ingénierie de la matrice LEON (Scepia). Périmètre V1 : PLUS/PLAI/PLS habitat. Cible : LLI (LOC), LIBRE, foyers - **le moteur est paramétrique dès le départ, le produit est une donnée, jamais une duplication de code.**

Les matrices LEON fournies sont mal conçues (moteur dupliqué 14 fois, constantes en dur, arrondis hétérogènes). **On en reprend les règles de calcul, jamais la structure** : liberté totale de restructuration tant que les résultats sont reproduits.

La spécification de référence est `docs/DICTIONNAIRE_REGLES_MOTEUR_PLUSPLAI_v0.1.md` (identifiants R-xxx). Toute implémentation cite l'identifiant de règle qu'elle couvre. Tout écart volontaire avec LEON est documenté dans `docs/ECARTS_LEON.md` avec référence à l'irrégularité (I-1 à I-10) qui le justifie.

## 2. Contraintes d'environnement (réelles, vérifiées 04/08/2026)

- Poste Windows, **pas de Docker**, pas de Python. Node/npm : à installer (voir §3) - ne rien supposer installé, vérifier.
- **Aucun backend disponible** (VM SFO éteinte temporairement). Le moteur se développe et se teste **sans base de données** : entrées JSON → sorties JSON, fixtures sur disque.
- La persistance (Postgres auto-hébergé de la VM, PostgREST) viendra plus tard. **Jamais Supabase cloud.**
- **Ce repo est PUBLIC** (`github.com/BMtestaxentia/sim`, servi par GitHub Pages). Il ne doit donc contenir **aucune donnée réelle**.
  - Les **fixtures réelles** (exports d'annexes et de matrices LEON) vivent dans `fixtures-reelles/`, **ignoré par git**. Les trois fichiers `golden*.test.js` les lisent quand elles sont là et **se sautent** sinon : `npm test` passe dans les deux cas, avec ou sans elles.
  - Les opérations sont désignées par des **codes** dans tout le dépôt : `OP-1` à `OP-6` pour les fixtures, `H-1` à `H-7` pour les exports Horizon 50. La table de correspondance est dans `fixtures-reelles/CORRESPONDANCE.md`, hors du dépôt.
  - Ne jamais réintroduire un nom de commune, un numéro de simulation, un nom de fichier interne ni un nom de personne dans un fichier suivi par git. Les communes du **zonage** font exception : c'est de la donnée publique (data.gouv.fr).
  - L'application sème trois **opérations de démonstration inventées** au premier chargement : c'est ce que voit un visiteur de la page publique.

## 3. Stack technique

- **JavaScript ESM pur + JSDoc pour le typage. Pas de TypeScript, pas de transpilation, pas de build.** Rationale : zéro toolchain de compilation, le moteur s'importe tel quel dans Node (tests) ET dans le navigateur (future intégration à la maquette SFO). Le typage se fait par annotations JSDoc complètes + `// @ts-check` en tête de fichier.
- **Vitest** comme test runner (seule dépendance de dev). `npm test` doit passer avant tout commit.
- Node LTS. Si l'installation classique est bloquée par les droits du poste, utiliser la **version ZIP portable de Node** (aucun droit admin requis) et l'ajouter au PATH utilisateur.
- Aucune dépendance de production. Le moteur est autonome.

## 4. Architecture

```
moteur/
  src/
    amortissement.js    # R-AMT : moteur de prêts (annuités progressives, révisabilités, différés, préfi)
    loyers.js           # R-LOYER + R-SURF : surfaces, CS, loyers réglementés
    bilan.js            # R-TVA : prix de revient, LASM, modulation
    subventions.js      # R-SUB : SLA, SSF, gratuité/affectation
    financement.js      # R-FIN : équilibre, prêts CDC théoriques
    exploitation.js     # R-EXP : compte d'exploitation 50-60 ans
    fiscalite.js        # R-FISC : TFPB/exonération, TA, VSD
    moteur.js           # orchestration : calculer(entrees, referentiels) -> resultats
    produits.js         # définitions paramétriques des produits (PLUS, PLAI, LIB, LOC/LLI, PLS...)
  referentiels/
    baremes_2025.json          # barèmes réglementaires versionnés (extraits de ParaGEN)
    trajectoires_axentia_2026.json  # scénario macro (LA, IRL, TFPB...)
  fixtures/                    # documentation du format, AUCUNE donnee
  fixtures-reelles/            # les vraies annexes, hors git (.gitignore)
    op-1-libre/                # entrees.json + attendus.json (depuis l'annexe LIBRE)
    op-2-lli/
    op-3-pls/                  # PLS, depuis la matrice complète (tables d'amortissement LEON)
    op-4-foyer-pls/ op-5-foyer-pls/ op-6-foyer-plus-plai/
  tests/
    amortissement.test.js      # cas canoniques (taux 0, progressivité, révision LA, différés, dernière échéance)
    golden.test.js             # comparaison moteur vs annexes LEON, tolérances ±1 EUR bilan / ±0,1 % annuités
  docs/
    DICTIONNAIRE_REGLES_MOTEUR_PLUSPLAI_v0.1.md
    ECARTS_LEON.md
```

Règles d'architecture non négociables :
- **Le moteur est pur** : aucune I/O, aucun accès réseau, aucun état global, aucune date système implicite (la date est une entrée). Même entrées → même sorties, toujours.
- **Aucun littéral métier dans le code de calcul** (pas de `345`, pas de `0.77`, pas de `0.006` en dur) : tout vient des référentiels ou des entrées. C'est la leçon de l'irrégularité I-2 de LEON.
- Arithmétique : calculs en nombre flottant standard MAIS arrondis explicites et centralisés (module unique `arrondis.js`) appliqués aux frontières définies par le dictionnaire (R-CONV / I-9). Pas d'accumulation itérative quand une forme fermée existe (leçon I-4).
- Chaque fonction publique documente en JSDoc : règle(s) R-xxx couverte(s), unités, source LEON.

## 5. Golden tests - le contrat du projet

- Une fixture = `entrees.json` (reconstruit depuis l'onglet IN de l'annexe LEON) + `attendus.json` (valeurs de la Présentation CA / Grille d'analyse / PMT).
- Tolérances : ±1 EUR sur bilan et plan de financement ; ±0,1 % sur annuités et lignes d'exploitation. Un écart au-delà = bug du moteur OU bug documenté de LEON (à consigner dans ECARTS_LEON.md, jamais à masquer).
- Ordre d'implémentation : amortissement (tests canoniques) → LIBRE bout-en-bout (fixture OP-1 disponible) → LLI → PLUS/PLAI (dès fixtures fournies).
- `npm test` est le juge de paix. Ne jamais commiter en rouge.

## 6. Conventions de travail

- Langue : tout en français (code commenté, commits, docs). Pas de tiret cadratin dans les textes.
- Commits directs sur `main` acceptés (comme SFO), messages en français, préfixés du module : `amortissement: gestion du différé type 1`.
- Nombres : unités toujours explicites dans les noms (`montant_eur`, `taux`, `surface_m2`, `duree_ans`). Les montants d'exploitation LEON sont en k€ - le moteur travaille en euros et convertit uniquement à la présentation.
- Ne jamais modifier les fixtures pour faire passer un test.
- Pas de données réelles dans les messages de commit ni dans les noms de fichiers au-delà du nécessaire (numéro de simulation OK).

## 7. Liens avec SFO / ExNihilo

- Repo distinct, aucune dépendance croisée pour l'instant. À terme : la table `simulations` (Postgres VM) se liera aux `operations`/`tranches` de SFO, et la maquette importera `moteur/src/moteur.js` directement (d'où l'exigence ESM navigateur-compatible).
- Le style UI (quand on y viendra) suivra la charte SFO : navy, Manrope, sobriété - mais l'UI n'est PAS dans ce repo pour l'instant.
