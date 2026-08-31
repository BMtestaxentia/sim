# Fixtures

Ce dossier est **vide de données** dans le dépôt. Il documente le format, rien
de plus.

## Pourquoi

Les golden tests confrontent le moteur à des exports d'**opérations réelles**
(annexes et matrices LEON). Le dépôt étant public, ces exports vivent hors de
git, dans `fixtures-reelles/`, ignoré par `.gitignore`.

Sur un poste qui les possède, `npm test` exécute tout, golden tests compris. Sur
un poste qui ne les a pas, les trois fichiers `golden*.test.js` sont **sautés**
et le reste de la suite tourne normalement.

## Ce qui n'a pas été fait, et pourquoi

Il aurait été possible de livrer des fixtures anonymisées : mêmes structures,
montants modifiés, valeurs attendues recalculées. Cela aurait été pire que rien.
Une valeur attendue n'a de sens que si elle vient d'une annexe LEON : recalculée
par le moteur, elle ne mesure plus que l'accord du moteur avec lui-même, et un
tel test ne peut jamais échouer pour la bonne raison. Mieux vaut un test absent,
qui le dit, qu'un test qui rassure à tort.

Les opérations sur lesquelles jouer sont ailleurs : l'application sème trois
**opérations de démonstration entièrement inventées** au premier chargement
(`Les Tilleuls`, `Cour des Ateliers`, `Îlot Verrières`). Elles couvrent le
mono-produit, le bi-produit et le mixte à quatre tranches.

## Le format

Une fixture est un dossier portant deux fichiers :

- `entrees.json` : ce que l'annexe donne en entrée, plus un bloc `_meta` qui dit
  d'où elle vient et ce qu'elle vaut ;
- `attendus.json` : ce que l'annexe affiche en sortie, recopié sans être
  retouché. **Ne jamais modifier une valeur attendue pour faire passer un
  test** : un écart est soit un défaut du moteur, soit un défaut de LEON à
  consigner dans `docs/ECARTS_LEON.md`.

Les tolérances sont celles du contrat du projet : ±1 EUR sur le bilan et le plan
de financement, ±0,1 % sur les annuités et les lignes d'exploitation.

`GABARIT_ANNEXE.md` décrit, feuille par feuille, où lire chaque grandeur dans
une annexe LEON.
