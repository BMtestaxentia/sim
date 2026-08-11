# Fixtures golden test

**Données réelles AXENTIA — repo privé uniquement.** Ne jamais copier vers `exnihilo`.

Deux origines distinctes, qui n'ont pas la même structure (voir plus bas) :
les **annexes** LEON (Mulhouse) et la **matrice** LEON complète (Bergerac).

## Contenu

- `mulhouse_3308_libre/` — simulation n°3308, produit LIBRE, VEFA, zone 2/B1.
  Prêt unique : Libre 1 960 617,65 EUR, 30 ans, TAUX FIXE 1,5 %. FP 105 212 EUR. Équilibre exact (écart 0,00).
- `mulhouse_3308_lli/` — simulation n°3307 (même opération, partie LLI), VEFA, zone 2/B1.
  Prêts : LLI 5 198 270 EUR (35 ans, DOUBLE, LA+1,4 %), LLI Foncier 2 546 267 EUR (40 ans, DOUBLE),
  ALS 100 000 EUR. Subventions 1 193 114 EUR. FP 643 020 EUR.
- `agde_2402_foyer_pls/` : simulation n°2402, **foyer en colocation** de 16 lots, VEFA zone 3/B1,
  financé en **PLS** (Foncier 606 891 € / 50 ans, Travaux 1 371 760 € / 40 ans, tous deux en double
  révisabilité, LA + 1,11 %, progressivité −0,5 %). Subventions 193 000 €, avance de trésorerie
  rémunérée 44 318,74 € (2 % du PR, rémunérée 2,5 %, reconstituée sur 30 ans). Régime **redevance
  forfaitaire**. C'est la fixture la plus complète du dépôt : bilan, plan de financement,
  amortissement, amortissement comptable et compte d'exploitation, tous confrontés.
- `bergerac_lls6_pls/` — produit **PLS**, VEFA, habitation. Extraite le 04/08/2026 non pas d'une
  annexe mais de la **matrice complète** (131 onglets), en lecture seule via Excel COM.
  Prêts : PLS construction 494 023 EUR (40 ans) et PLS foncier 176 035 EUR (50 ans), tous deux
  à 3,51 % saisis / **3,11 % appliqués** (révisabilité SIMPLE : 3,51 % + LA 2028 2,0 % − LA de
  référence 2,4 %), progressivité 0. Périmètre : **amortissement uniquement.**

## Structure — fixtures issues de la matrice (`bergerac_lls6_pls`)

La matrice n'a pas d'onglet `IN` ni de Présentation CA : les entrées sont lues dans le bloc de
saisie (`SimPLS!AL10:AN21`) et les attendus sont les **tableaux calculés par LEON lui-même**
(`SimPLS!FH16:FO55` et `FP16:FW65`). C'est une référence plus fine qu'une annexe : elle donne
l'échéancier année par année (taux, annuité, intérêts, amortissement, CRD) et non des totaux.

- `entrees.json` — schéma propre au moteur (aucune reprise de la structure du tableur) :
  identité, `referentiel_amortissement` (LA de référence + trajectoire), liste de prêts.
  Chaque bloc cite sa cellule source.
- `attendus.json` — un tableau d'amortissement complet par prêt.

## Structure — fixtures issues des annexes (`mulhouse_*`)

- `entrees.json` — reconstruit depuis l'onglet IN (sérialisation de la simulation) :
  identité, zones, dates, taux d'évolution, surfaces par produit, plan de financement,
  caractéristiques des prêts. La clé `dump_in_brut` contient TOUTES les cellules non vides
  de IN (coordonnée -> valeur) : garantie zéro perte, à consulter si un champ curaté manque.
- `attendus.json` — valeurs cibles lues dans la Présentation CA, la Grille d'analyse,
  le compte de synthèse (IN) et le PMT : bilan par poste (47 lignes), totaux par chapitre,
  hypothèses d'exploitation, 12 prêts caractérisés, totaux du plan de financement (avec TRI),
  indicateurs de la grille (RMO, base d'amortissement, valeur comptable terrain, VAN 5/10/15 ans),
  et 4 tables annuelles sur 60 ans : redevance forfaitaire (kEUR), résultat (EUR),
  autofinancement (EUR), synthèse exploitation (kEUR), plus les redevances PMT.

## Tolérances et pièges connus

- Tolérances : ±1 EUR sur bilan et plan de financement ; ±0,1 % sur annuités et exploitation.
- **Mulhouse LIBRE** : reproduit **bout en bout** par `calculer()` — prix de revient (écart 0,35 €),
  équilibre exact, part de prêts identique à 4 décimales, et les 30 annuités à
  **2,4 × 10⁻⁴ €** près, soit 2,9 × 10⁻⁷ %. C'est la fixture qui valide la chaîne complète.
- **Mulhouse LLI** : bilan, plan de financement et montants reproduits. **Les annuités ne le sont
  pas** : les deux prêts sont en révisabilité DOUBLE, donc suspendus à une trajectoire de Livret A
  que le dépôt ne contient pas. Écart mesuré et analysé en question Q-25. Ce n'est pas masqué :
  le test ne compare que ce qui est comparable, et dit pourquoi.
- Les postes de ces deux annexes portent une **TVA nulle** et un TTC égal au HT : ils sont marqués
  `hors_lasm` dans les tests. Sans cela le taux LIBRE de 20 % s'appliquerait et le prix de revient
  serait faux de 413 k€. Voir Q-24.
- Bergerac PLS : le moteur reproduit actuellement les deux tables à **1,8 × 10⁻¹¹ EUR près**
  (soit 10⁻¹³ %), c'est-à-dire au bruit flottant. La tolérance de ±0,1 % n'est donc pas
  « juste tenue » : tout écart visible sur cette fixture signale une régression réelle.
- Bergerac PLS : le collecteur (20 000 EUR à 0,25 %, 40 ans) est saisi dans la matrice mais
  n'a **pas** de bloc d'amortissement dans `SimPLS` — il est donc hors fixture, faute de
  référence à confronter. Question ouverte Q-9.
- LLI : le TOTAL FINANCEMENTS de LEON est affiché arrondi à l'euro (9 680 671) alors que le
  PR TTC vaut 9 680 671,454... L'écart de 0,45 EUR est un arrondi de présentation de LEON,
  pas une erreur du moteur. Ne pas chercher à le reproduire.
- **AGDE foyer PLS** : les 50 annuités contractuelles sont reproduites à **moins de 10⁻¹² d'écart
  relatif**, sur une trajectoire de Livret A réelle et non plate lue dans l'annexe elle-même
  (1,6 % en 2026, puis 2,1 / 2,0 / 2,2 %). Trois pièges à connaître sur cette fixture :
  - **l'année 1 ne compte qu'un mois** (mise en location au 01/12/2026). Le rapport année 2 / année 1
    vaut 12,42 sur les charges, pas 12 : c'est douze mois indexés de 2,1 %. La comparaison
    d'exploitation porte donc sur 2027 à 2085 ;
  - **la redevance et les charges suivent DEUX trajectoires distinctes** (+1,7 % puis +1,8 %, contre
    +2,0 % puis +1,8 %). La trajectoire unique observée sur Orléans n'est pas une règle du mode
    redevance ;
  - **LEON émet une 51ᵉ échéance sur le prêt de 50 ans** (écart E-13). Elle est hors contrat et
    n'est pas reproduite ; le test l'affirme explicitement plutôt que de l'ignorer.
- Les valeurs annuelles LEON portent du bruit de virgule flottante (irrégularité I-4 du
  dictionnaire) : comparer en tolérance relative, jamais en égalité stricte.
- Dates : converties en ISO (AAAA-MM-JJ) depuis les numéros de série Excel.
- Ne JAMAIS modifier ces fichiers pour faire passer un test.
