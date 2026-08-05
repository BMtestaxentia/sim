# Gabarit : brancher une nouvelle annexe LEON en golden test

Ce que le moteur sait consommer aujourd'hui, et où le déposer. Écrit pour que
l'annexe PLUS/PLAI attendue se branche sans avoir à redécouvrir le format.

## 1. Déposer les deux fichiers

```
fixtures/<ville>_<numero_simulation>_<produit>/
  entrees.json    reconstruit depuis l'onglet IN de l'annexe
  attendus.json   valeurs de la Présentation CA et de la Grille d'analyse
```

Nommage : minuscules, sans accent. Le numéro de simulation suffit à identifier
l'opération ; pas d'autre donnée nominative dans le nom de dossier.

## 2. Ce que `attendus.json` doit contenir

Les clés ci-dessous sont celles que les golden tests existants consomment. Les
deux fixtures Mulhouse en sont l'exemple de référence.

| Clé | Contenu | Sert à tester |
|---|---|---|
| `bilan.postes[]` | `{chapitre, numero, libelle, ht, tva, ttc}` | prix de revient poste à poste |
| `bilan.chapitres` | totaux HT et TTC par chapitre romain | agrégation par chapitre |
| `bilan.total_prix_revient` | `{ht, ttc}` | total, tolérance ±1 € |
| `prets[]` | `{libelle, montant, duree_ans, taux, revisabilite, progressivite, pct_pr}` | amortissement |
| `totaux_plan_financement` | prêts, subventions, fonds propres, total, parts | équilibre R-FIN-1 |
| `grille_analyse` | base d'amortissement, valeur comptable terrain, ratios | indicateurs |
| `synthese_exploitation_par_annee[]` | `{annee, annuites_cdc_keur, ...}` | série d'annuités, ±0,1 % |
| `resultat_par_annee[]` | dont `interets_emprunts_eur` | intérêts année par année |

## 3. Points de vigilance constatés sur les annexes déjà branchées

**TVA et livraison à soi-même.** Sur les deux annexes Mulhouse, tous les postes
portent une TVA nulle et un TTC égal au HT : aucune LASM ne s'applique. Les
tests les marquent `hors_lasm: true`. Vérifier ce point AVANT de conclure à un
écart : sans ce marqueur, le prix de revient LIBRE était faux de 413 k€.
Question ouverte Q-24.

**Trajectoire du Livret A.** Un prêt à `TAUX FIXE` se reproduit exactement.
Un prêt en `DOUBLE` ou `D. LIMITEE` dépend de la trajectoire de Livret A avec
laquelle l'annexe a été calculée, et cette trajectoire n'est pas dans le dépôt.
C'est ce qui bloque aujourd'hui les annuités LLI (Q-25). **Si l'annexe PLUS/PLAI
comporte des prêts révisables — ce sera le cas, les prêts CDC le sont — il faut
exporter aussi la trajectoire de LA du profil**, sans quoi seules les grandeurs
indépendantes du taux seront testables.

**Année de première échéance.** Vérifier que l'annexe ne porte aucune annuité
l'année de mise en location : c'est la règle R-AMT-3, et c'est la seule chose
qui distingue un moteur juste du bug historique ALS.

**Arrondis de présentation.** L'annexe LLI affiche un total de financements
arrondi à l'euro pour un prix de revient à la décimale : l'écart de 0,45 € est
un arrondi d'affichage de LEON, à ne pas reproduire.

## 4. Écrire le test

Reprendre la structure de `tests/golden.test.js`, section MULHOUSE LIBRE. Elle
appelle `calculer()` une fois puis vérifie bloc par bloc, ce qui permet de ne
tester que ce qui est comparable et de documenter le reste en question ouverte
plutôt que de le masquer.

**Ne jamais ajuster une fixture ni assouplir une tolérance pour faire passer un
test.** Un écart au-delà de la tolérance est un bug du moteur ou un bug
documenté de LEON, consigné dans `docs/ECARTS_LEON.md`.

## 5. Ce qui attend déjà l'annexe PLUS/PLAI

`tests/plus_plai.test.js` vérifie que la chaîne complète traverse le produit
sans rien laisser d'indéfini : coefficient de structure par tranche, barème sur
le zonage 1/2/3, prêts CDC par défaut résolus depuis `produits.js`, majoration
PLUS 33 % en multiplicatif, exonération de taxe foncière. Ces tests ne comparent
rien à LEON — ils garantissent seulement qu'aucune régression ne casse PLUS/PLAI
d'ici là. Le golden test viendra s'ajouter à côté, sans les remplacer.
