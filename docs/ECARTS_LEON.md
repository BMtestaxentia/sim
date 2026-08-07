# Écarts assumés avec LEON

Registre des divergences volontaires entre le moteur et la matrice LEON, avec la référence à l'irrégularité (I-1 à I-10 du dictionnaire) qui les justifie. Règle du projet (CLAUDE.md §5) : un écart se documente ici, il ne se masque jamais dans un test.

Sources vérifiées le 04/08/2026 sur le classeur `BERGERAC_LLS_6_PLS_ELAN_MAJ_07_2026` (matrice complète, 131 onglets, même version que la matrice de référence), formules lues directement.

| ID | Constat dans LEON | Cellule source | Choix du moteur | Irrégularité |
|---|---|---|---|---|
| E-1 | La cellule « 1ère ANNUITE » renvoie 0 quand le taux est nul. Le tableau d'amortissement, lui, ne consomme pas cette cellule et traite le cas correctement. | `SimPLUS!AM15` | Cellule d'affichage non reproduite. Le moteur applique la règle du tableau : amortissement linéaire si taux = 0 **et** progressivité = 0, forme fermée sinon. | I-8 |
| E-2 | Différé de type 1 : les intérêts sont enregistrés à 0 et le CRD reste constant. Les intérêts du différé ne sont donc jamais appelés ni capitalisés - le différé est économiquement gratuit. Le dictionnaire v0.1 annonçait pourtant « intérêts capitalisés ». | `SimPLUS!FL117`, `FM117`, `FN117` | Comportement LEON reproduit à l'identique (les golden tests sont le contrat). Anomalie économique signalée en Q-6 pour arbitrage. | - (à trancher) |
| E-3 | Le bloc CDC révise le taux d'intérêt **sans** tester la révisabilité : un prêt à taux fixe y verrait quand même son taux suivre le Livret A. Le bloc LIBRE, lui, porte la garde `IF(révisabilité="TAUX FIXE", taux, ...)`. | `SimPLUS!FJ117` vs `SimLIB!FH8` | Garde du bloc LIBRE retenue partout : `TAUX FIXE` fige le taux. C'est la seule lecture cohérente avec le libellé saisi. | I-1 |
| E-4 | Bascule en amortissement linéaire : le bloc CDC teste `OR(AND(taux=0, progressivité=0), AND(rev=0, tx=0))`, le bloc « autres prêts » teste seulement `taux=0`. Deux prêts identiques amortissent différemment selon le bloc qui les porte. | `SimPLUS!FK117` vs `SimPLUS!GA213` | Règle du bloc CDC retenue partout (la plus juste : elle ne bascule en linéaire que dans le cas réellement dégénéré). | I-1 |
| E-5 | Le bloc LIBRE principal teste la révisabilité par `IF(révisabilité="D. LIMITEE", ..., progressivité)` sans jamais tester `"DOUBLE"` : un prêt DOUBLE porté par ce bloc ne verrait pas son annuité révisée, alors que son taux le serait. Le bloc voisin, lui, teste bien les trois cas. | `SimLIB!FG8` vs `SimLIB!FI212` | Test complet DOUBLE / D.LIMITEE / autre retenu partout. Sans effet sur la fixture Mulhouse LIBRE (prêt à TAUX FIXE), mais l'écart mordrait sur un LIBRE révisable. | I-1 |
| E-6 | `rev = tx` (soit q = 1) fait diviser par zéro : LEON renvoie `#DIV/0!`. | `SimPLUS!FK117` | Le moteur renvoie la limite mathématique `(1+tx)/m`, continue en ce point. | I-4 |
| E-7 | Le `VLOOKUP` de la trajectoire du Livret A renvoie `#N/A` pour une année antérieure au début de la table (2028 dans le classeur Bergerac). | `SimPLUS!FJ117` → `ParaGEN!CT22:DD102` | Le moteur retombe sur le Livret A d'origine du prêt (aucune révision), plutôt que de propager une erreur. | I-3 |
| E-8 | **Unités mélangées dans une même ligne du compte d'exploitation** : tous les postes sont en k€ sauf « AUTRES DÉPENSES », en euros, que le total divise par 1000 (`DX15 = SUM(DN:DP)+SUM(DR:DW)+DQ/1000`). Une lecture naïve de la ligne fausse le total d'un facteur 1000 sur ce poste. | `SimPLS!DQ` contre `DN:DW` | Le moteur travaille en euros partout et ne convertit qu'à la présentation (CLAUDE.md §6). L'écart est sans objet dans la cible, mais il est documenté parce qu'il piège toute reprise de données depuis LEON. | I-9 |
| E-9 | La colonne « AUTRES DÉPENSES » du compte d'exploitation est faite de **51 valeurs saisies en dur**, sans formule. | `SimPLS!DQ15:DQ65` | Non reproduit : on ne peut pas transcrire une règle qui n'existe pas. Question ouverte Q-20 pour identifier ce que recouvre le poste. | I-2 |
| E-10 | **L'exonération de TFPB dure 26 ans, pas 25.** Bergerac est mise en location en 2028 et la taxe foncière n'apparaît qu'en **2054**. Une exonération de 25 ans courant de 2028 à 2052 inclus taxerait dès 2053. LEON exonère donc une année de plus que la durée réglementaire du CGI 1384 A. | `SimPLS!DR15:DR95`, première valeur non nulle en 2054 | Le moteur compte l'exonération à partir de la mise en location, donc taxe en 2053 : `annee_debut_tfpb = annee_mise_en_location + duree_exoneration_tfpb_ans`. Le golden test d'exploitation force `annee_debut: 2054` pour reproduire la colonne LEON, et **assert explicitement l'écart d'un an** afin qu'il ne passe pas inaperçu. Reste à trancher : l'exonération part-elle de l'achèvement plutôt que de la mise en location (ce qui reconstituerait le décalage), ou LEON compte-t-il une année de trop ? | I-7 |

## Points confirmés (aucun écart)

Vérifications faites sur les formules, qui **valident** la transcription du dictionnaire :

- **R-AMT-4, taux d'intérêt révisé** : `tx_N = (1+t)(1 + (LA_N − LA_0)/(1+t)) − 1`, soit algébriquement `t + LA_N − LA_0`. Vérifié numériquement sur le classeur (`FJ117 = 1,6 %` pour `t = 2 %`, `LA_N = 2 %`, `Tx_LA = 2,4 %`).
- **R-AMT-4, révision de l'annuité** : `rev_N = (1+p)(1 + (LA_N − LA_0)/(1+t)) − 1`, puis DOUBLE → `rev_N`, D. LIMITEE → `MAX(rev_N, 0)`, autre → `p`. Vérifié (`FF117 = FI117 = −0,890196 %` pour `p = −0,5 %`).
- **R-AMT-3** : chaque prêt porte sa propre date de 1re échéance (`SimPLUS!AM17`, `AN17`, `AO17`, `AP17`, `AR17`…), confirmant que le bug ALS venait bien d'un « an 1 » commun imposé à tous les prêts.
- **Dernière échéance** : ce n'est pas un cas particulier codé dans LEON. Elle émerge de la durée restante `m_N = 1`, où le facteur d'annuité vaut `(1+tx)` - l'annuité solde donc exactement `CRD + intérêts`. La question Q-1 est close.

## Correction majeure apportée au dictionnaire

Le dictionnaire v0.1 décrivait la révision comme `annuité_N = annuité_{N−1} × (1 + taux_annuité)`. La formule réelle (`SimPLUS!FK117`) **ré-amortit** chaque année :

```
annuité_N = CRD_{N−1} × (1 + tx_N) × (1 − q_N) / (1 − q_N^m_N)
q_N = (1 + rev_N) / (1 + tx_N)
m_N = durée − (année_N − année_1re_échéance)
```

Les deux formulations sont **exactement équivalentes tant que le Livret A ne bouge pas** (le ré-amortissement d'un profil progressif reproduit la suite géométrique de raison `1+p`), ce qui explique qu'elles ne se distinguent sur aucun cas à taux constant. Elles divergent dès la première révision : le ré-amortissement recale l'annuité pour que le CRD atterrisse exactement à zéro au terme contractuel, là où la progression géométrique laisse le prêt se solder trop tôt ou trop tard. C'est le comportement implémenté.
