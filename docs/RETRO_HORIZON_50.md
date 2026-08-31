# Rétro-ingénierie « Horizon 50 » — projection des dépenses par composants

> Règle **R-COMP** (provision et renouvellement de composants sur 50 ans),
> reconstituée le 31/08/2026 à partir de sept exports, **sans la matrice de
> calcul d'origine**.

## 1. Ce qu'on avait, et ce qu'on n'avait pas

Sept classeurs, tous des exports d'une grille web (`ag-grid`) : une seule
feuille, dix lignes, une colonne par année, **aucune formule**. Le calcul
n'était donc pas lisible ; seuls ses résultats l'étaient.

| Fichier | 1re année | Années | Assiette an 1 (k€) | Dépense an 0 (k€) |
|---|---|---|---|---|
| BERGERAC RJA | 2027 | 44 | 7 160 | 1 338,77 |
| Données | 2026 | 45 | 3 432 850 | 751,39 |
| Sablé | 2027 | 44 | 12 218 | (hors fenêtre) |
| Lyon 7 | 2026 | 45 | 1 242 | 299,12 |
| Clermont | 2026 | 45 | 22 842 997 | 3 786,41 |
| La Rochelle | 2028 | 43 | 14 398 | 2 739,12 |
| RE | 2026 | 45 | 22 842 997 | 3 786,41 |

Deux remarques d'emblée : **Clermont et RE sont identiques** au centime sur
toutes les lignes, et **« Données » comme Clermont portent des assiettes en
milliards** — ce sont des consolidations de patrimoine, pas des opérations. Les
quatre autres sont des opérations.

Les dix lignes sont les mêmes partout : stock de début, taux de collecte,
montant de collecte, autres financements, montant consommé, dépenses totales,
stock de fin, seuil d'alerte.

## 2. La récurrence du stock — R-COMP-1

```
stock_fin(N) = stock_début(N) + collecte(N) + autres_financements(N) − dépenses(N)
stock_début(N+1) = stock_fin(N)
```

**Vérifiée sur les sept fichiers, sur toutes les années** : écart maximal
0,01 k€, soit exactement l'arrondi à deux décimales de l'export. Ce n'est donc
pas une approximation, c'est la règle.

Le stock **peut devenir négatif** — BERGERAC descend à −318,89 k€ en 2057, à la
suite d'une dépense de 1 687,71 k€ — et rien dans les fichiers ne l'en empêche.
La provision n'est pas une trésorerie : c'est un compte de provision qui se
creuse et se rattrape.

Le **seuil d'alerte** vaut 100 k€ à plat sur les sept fichiers, toutes années
confondues. C'est un repère d'affichage, pas un plancher : le stock passe
dessous sans que rien ne se déclenche.

## 3. La collecte — R-COMP-2

```
collecte(N) = taux(N) × assiette(N)
assiette(N) = assiette(N₀) × (1 + 2,30 %)^(N − N₀)
```

L'assiette se retrouve par division, `collecte / taux`. Sa croissance est de
**2,300 %/an** sur les sept fichiers (2,299 à 2,300 : bruit d'arrondi). C'est
une **donnée d'entrée** — prix de revient TTC pour une opération, patrimoine
pour une consolidation — et non une grandeur dérivée : le rapport entre
l'assiette et la dépense de l'année 0 va de 4,15 à 6 033 selon les fichiers.

Le **taux monte en escalier** sur les premières années, puis se stabilise. La
montée diffère d'un fichier à l'autre :

| Fichier | Escalier |
|---|---|
| BERGERAC | 0 → 0,3 → 0,4 → 0,5 → **0,6 %** |
| Données | 0 → 0,1 → 0,2 → 0,3 → 0,4 → 0,5 → **0,6 %** |
| Lyon 7 | 0 → 0,6 → **1,2 %** |
| Sablé, Clermont, La Rochelle, RE | 0 → **0,6 %** |

Le palier est donc **0,6 %**, sauf Lyon qui monte à **1,2 %** — le double. La
première année est toujours à zéro. L'escalier est une donnée de saisie, pas une
règle : quatre formes différentes sur sept fichiers.

## 4. Les dépenses par composants — R-COMP-3

C'est le cœur, et c'est ce qui n'était nulle part écrit.

### Le calendrier est un GABARIT, identique partout

Années de dépense, comptées depuis la première colonne :

```
BERGERAC, Données, Lyon, Clermont, La Rochelle, RE
  0, 7, 9, 12, 14, 18, 21, 24, 27, 28, 30, 35, 36, 40, 42

Sablé
  6, 8, 11, 13, 17, 20, 23, 26, 27, 29, 34, 35, 39, 41
```

Sablé est le **même gabarit décalé d'un an** : son année de référence précède sa
première colonne, si bien que son année 0 tombe hors fenêtre. Six fichiers sur
sept partagent le calendrier au rang près.

### Il se décompose en sept durées de vie

L'ensemble `{7, 9, 12, 14, 18, 21, 24, 27, 28, 30, 35, 36, 40, 42}` est
exactement l'union des multiples de **7, 9, 12, 14, 30, 35 et 40** dans la
fenêtre :

| Durée | Renouvellements |
|---|---|
| 7 ans | 7, 14, 21, 28, 35, 42 |
| 9 ans | 9, 18, 27, 36 |
| 12 ans | 12, 24, 36 |
| 14 ans | 14, 28, 42 |
| 30 ans | 30 |
| 35 ans | 35 |
| 40 ans | 40 |

Aucune année observée ne manque, aucune année non observée n'apparaît. Ni 15,
ni 20, ni 25 ne figurent : la grille n'est pas celle du référentiel comptable
actuel (structure 50 / toiture 25 / menuiseries 25 / équipements 15 /
agencements 15).

### La formule

```
dépense(t) = Σ  coût_base(L) × (1 + 2,30 %)^t     pour tout L tel que  t mod L = 0,  t > 0
dépense(0) = Σ  coût_base(L)  +  composants jamais renouvelés
```

**Vérification.** Les coûts de base se pèlent de la plus petite durée à la plus
grande : l'année 7 ne porte que le composant de 7 ans, l'année 9 que celui de
9 ans, l'année 14 porte le 7 ans (déjà connu) plus le 14 ans, et ainsi de suite.
Le modèle est ensuite rejoué sur **toutes** les années :

| Fichier | Pire écart de reconstitution |
|---|---|
| BERGERAC | −0,086 k€ |
| Données | +0,066 k€ |
| Sablé | −0,210 k€ |
| Lyon 7 | +0,031 k€ |
| Clermont / RE | +0,064 k€ |
| La Rochelle | −0,115 k€ |

Sur des montants qui vont jusqu'à 3 016 k€, l'écart maximal est de 0,21 k€, soit
**7 pour cent mille**. C'est l'arrondi de l'export, pas un défaut du modèle.

L'indexation retrouvée par le rapport des années 7 et 21 — seules années où le
composant de 7 ans joue seul — vaut **2,2969 % à 2,3022 %** selon le fichier :
le même 2,30 % que l'assiette. **Un seul taux gouverne tout le classeur.**

### La grille de répartition est standard

Part de chaque composant dans le total des bases :

| Durée | BERGERAC | Clermont | Lyon 7 | Données |
|---|---|---|---|---|
| 7 ans | 0,53 % | 0,53 % | 0,53 % | 0,50 % |
| 9 ans | 1,45 % | 1,45 % | 1,45 % | 1,45 % |
| 12 ans | 1,94 % | 1,94 % | 1,94 % | 1,94 % |
| 14 ans | 5,46 % | 5,46 % | 5,46 % | 5,47 % |
| 30 ans | 69,06 % | 69,05 % | 69,05 % | 69,08 % |
| 35 ans | 6,23 % | 6,23 % | 6,23 % | 5,85 % |
| 40 ans | 15,34 % | 15,35 % | 15,35 % | 15,71 % |

Les quatre opérations partagent la **même grille au centième de point**. Seule la
consolidation « Données » s'en écarte légèrement, ce qui est attendu : elle
mélange des patrimoines de compositions différentes.

Le composant de 30 ans porte **69 % du montant** à lui seul. C'est lui qui fait
la forme de la courbe, et le creux de stock de 2057 sur BERGERAC.

### Un huitième composant, qui ne se renouvelle jamais

L'année 0 dépasse systématiquement la somme des sept bases :

| Fichier | Année 0 | Σ bases | Écart | Part |
|---|---|---|---|---|
| BERGERAC | 1 338,77 | 1 234,90 | 103,87 | 8,4 % |
| Clermont | 3 786,41 | 3 494,81 | 291,60 | 8,3 % |
| Lyon 7 | 299,12 | 276,31 | 22,81 | 8,3 % |
| La Rochelle | 2 739,12 | 2 526,92 | 212,20 | 8,4 % |
| Données | 751,39 | 690,20 | 61,19 | 8,9 % |

**8,3 à 8,4 %** du total sur les quatre opérations. Il existe donc un composant
posé à l'année 0 et **jamais renouvelé dans la fenêtre de 45 ans** : sa durée de
vie est supérieure à 42 ans, très vraisemblablement 50 — la structure. Les
fichiers ne permettent pas de trancher entre 43 et 50, aucune de ces années
n'étant observable.

## 5. Ce que les fichiers ne disent pas

- **La durée exacte du huitième composant** (> 42 ans). À demander.
- **Les libellés des composants.** Sept durées, aucun nom. La grille du
  référentiel comptable actuel (`amortissement`) ne correspond pas : il faudra
  soit obtenir les libellés, soit les nommer par convention.
- **Pourquoi Lyon 7 collecte à 1,2 %** et les autres à 0,6 %. Doublement de
  taux, sans indice dans les fichiers.
- **La forme de l'escalier de montée en charge.** Quatre formes sur sept
  fichiers : c'est une saisie, mais sa règle de construction est inconnue.
- **Ce qui déclenche le seuil d'alerte.** Il vaut 100 k€ partout, y compris sur
  une consolidation à 22 milliards d'assiette, ce qui ne peut pas être un
  paramètre calculé.

## 6. Implémentation proposée

Une fonction pure, à côté de `compteExploitation` :

```js
projectionComposants({
  annee_reference,          // année 0 du gabarit
  duree_ans,               // horizon, 45 par défaut
  assiette_eur,            // prix de revient TTC, ou patrimoine
  taux_collecte_par_annee, // l'escalier, en série
  indexation,              // 0,023
  composants,              // [{ libelle, duree_vie_ans, part }]
  cout_initial_eur,        // dépense de l'année 0
  stock_initial_eur,
  autres_financements_par_annee,
})
```

Elle rend la table des dix lignes, année par année, plus le détail par composant
et par année — ce que les exports ne portent pas, et qui est justement l'objet de
la demande.

Les sept durées, leurs parts et l'indexation de 2,30 % ont leur place dans
`referentiels/baremes_her_2027.json`, sous `provision_gros_entretien.composants`,
comme **données versionnées et surchargeables** : ce sont des hypothèses
d'organisme, pas des règles réglementaires (leçon I-2).
