# Fixtures golden test — annexes LEON Mulhouse

Extraites le 04/08/2026 depuis les annexes officielles LEON (anx_1303) par l'instance chat.
À placer dans `fixtures/` du repo moteur-sim. **Données réelles AXENTIA — repo privé uniquement.**

## Contenu

- `mulhouse_3308_libre/` — simulation n°3308, produit LIBRE, VEFA, zone 2/B1.
  Prêt unique : Libre 1 960 617,65 EUR, 30 ans, TAUX FIXE 1,5 %. FP 105 212 EUR. Équilibre exact (écart 0,00).
- `mulhouse_3308_lli/` — simulation n°3307 (même opération, partie LLI), VEFA, zone 2/B1.
  Prêts : LLI 5 198 270 EUR (35 ans, DOUBLE, LA+1,4 %), LLI Foncier 2 546 267 EUR (40 ans, DOUBLE),
  ALS 100 000 EUR. Subventions 1 193 114 EUR. FP 643 020 EUR.

## Structure de chaque dossier

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
- LLI : le TOTAL FINANCEMENTS de LEON est affiché arrondi à l'euro (9 680 671) alors que le
  PR TTC vaut 9 680 671,454... L'écart de 0,45 EUR est un arrondi de présentation de LEON,
  pas une erreur du moteur. Ne pas chercher à le reproduire.
- Les valeurs annuelles LEON portent du bruit de virgule flottante (irrégularité I-4 du
  dictionnaire) : comparer en tolérance relative, jamais en égalité stricte.
- Dates : converties en ISO (AAAA-MM-JJ) depuis les numéros de série Excel.
- Ne JAMAIS modifier ces fichiers pour faire passer un test.
