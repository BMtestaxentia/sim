# DICTIONNAIRE DES RÈGLES - MOTEUR DE SIMULATION PLUS/PLAI

Version 0.1 - 04/08/2026. Extrait par rétro-ingénierie de la matrice LEON (Scepia) version 2025-042d, profil « AXENTIA HER 2026 (PMT 2025) », fichier MATRICE_CALCULS_BACKGROUND_LEON.XLS (131 onglets, 278 887 formules, 21 423 plages nommées).

> Ce fichier est la reproduction, dans le repo du moteur, de la spécification produite par l'instance Claude « chat » qui détient la matrice LEON. La source de vérité reste cette instance : en cas d'ambiguïté, ne pas deviner - consigner la question dans `docs/QUESTIONS_SPEC.md` (voir CLAUDE.md §6).

Objet : spécification testable du moteur de calcul V1 (périmètre PLUS/PLAI habitat, neuf / VEFA / acquisition-amélioration) pour la ré-implémentation en module de code pur (entrées JSON → sorties JSON), avec validation par golden tests contre les annexes LEON officielles.

Convention de traçabilité : chaque règle porte un identifiant R-xxx et cite sa source (Onglet!Cellule). Statuts : ✅ formule extraite et transcrite · 🔶 mécanisme identifié, extraction fine à compléter à l'implémentation · ⚠️ irrégularité ou arbitrage à trancher.

## 0. Architecture de la matrice source

Chaîne PLUS/PLAI dans LEON : ParaGEN/ParaGLOB (barèmes + paramètres globaux) → ParaPLUS (saisie produit) → BilPLUS (prix de revient HT/TVA/TTC, LASM) → TypPLUS (typologies) → calculs (l.22-350 : loyers, CS, SLA, SSF, prêts ; l.1020-1290 : prêts fonciers globaux, TVA/LASM, préfi, TA) → FinPLUS (plan de financement) → SimPLUS (paramètres + amortissement + exploitation 50 ans) → COMMUN (constantes). SimTOTAL/ComTOTAL = consolidation multi-produits (hors V1).

## 1. Modèle de données d'entrée

Reconstruit depuis ParaPLUS, SimPLUS!A8:A42, ParaGLOB, validé par l'onglet IN des annexes (sérialisation à plat d'une simulation).

- **Identité/contexte** : id_simulation, nom_operation, etape, commune_insee (préfixe 97x → DOM), zone_123 (1/2/3/1bis, barème loyers), zone_ABC (A/Abis/B1/B2/C, durées prêts), type_operation (Neuf/Vefa/Acq-Amélio/Réhab), nature (V1 = Habitation), type_foncier (Pleine propriété/Démembrement → décale la 1re échéance CDC, R-AMT-3), tva_reduite/normale (10/20 %), duree_simulation (18-60), date_OS/livraison/mise_en_location (DAT = mise en location).
- **Programme physique** (par produit × Coll/Ind, ParaPLUS!25:44) : NL, SHAB, surfaces_annexes, SU (R-SURF-1 ou forcée), CS_distinct, loyer_base, modulation, loyer_sortie_forcé (court-circuite le calcul). Annexes louées séparément (garages, parkings, commerces, privatifs, jardins) + LCR. SDP Coll/Ind.
- **Prix de revient** (BilPLUS) : 4 chapitres (Charge foncière 19 postes / Bâtiment / Honoraires / Frais divers) × Coll/Ind × (HT, TVA, TTC), chaque poste avec son taux de TVA de saisie ; colonne TVA finale/LASM retraite au taux de livraison à soi-même (R-TVA-2).
- **Financements saisis** (SimPLUS!AL8:AX42) : 4 prêts CDC (PLUS/PLAI × Construction/Foncier) + jusqu'à 7 autres prêts (montant, taux fixe ou formule LA, progressivité, date 1re échéance, durée, différé, révisabilité, affectation, clé quote-part SU/NL). Options : capitaliser_interets_prefi, arrondir_prets_milliers_sup, option_PLUS_Horizen. Subventions 10 lignes (montant, flag gratuit, affectation) + SLA (R-SUB-1) + SSF (R-SUB-2). Fonds propres (montant, répartition, gratuit, durée reconstitution, taux rémunération, différé).
- **Paramètres d'exploitation** : trajectoires annuelles (ParaGEN!GS22:HE72 : LA, GE, gestion, vacance-impayés, loyers/IRL, frais fin., produits fin., TFPB, index TFPB). TFPB €/logement + année début. REL. Frais de gestion. PGE/PGERC. Marge anticipée LA. Majoration 120 % = 33 %.

## 2. Référentiels versionnés (fichier `referentiels/baremes_her_2027.json` + `trajectoires_her_2027.json`)

> **Profil en vigueur : AXENTIA HER 2027 (PMT2026)**, relevé sur LEON 2026-043h (matrice LEON de reference) le 10/08/2026. Il *est* le référentiel du dépôt et a remplacé AXENTIA HER 2026. Changement majeur : le Livret A de référence (`ParaGEN!DD20`) passe de 2,40 % à 1,50 %, donc tous les prêts CDC démarrent sur ce taux. Les chiffres cités dans la liste ci-dessous sont ceux du profil précédent, gardés pour mémoire ; les valeurs en vigueur sont dans les fichiers.

- **R-PARAM - Surcharge par simulation (07/08/2026).** Les fichiers du dépôt font foi, mais une simulation peut les surcharger : `entrees.parametrage.baremes` calque la structure de `baremes_her_2027.json` et vient par-dessus (fusion en profondeur, tableaux **par index**, valeur vide = valeur du dépôt), et `entrees.parametrage.trajectoires.par_annee` est une table creuse `{année: {poste: taux}}`. La fusion a lieu une seule fois, en tête de `calculer`, et tous les modules travaillent ensuite sur le barème effectif. Rationale : un barème réglementaire change plusieurs fois par an ; attendre une livraison du moteur n'est pas tenable, et modifier le fichier du dépôt rendrait toutes les simulations antérieures irreproductibles d'un coup. La surcharge voyageant **avec la simulation**, le moteur reste pur et le même dossier rejoué ailleurs redonne les mêmes nombres. `resultats.parametrage.baremes_ecarts` liste chemin par chemin ce qui a été chiffré hors référentiel. Côté écran, un **profil** est un jeu nommé de surcharges ; le profil de base porte le référentiel du dépôt, ne surcharge rien et n est pas modifiable, et éditer un paramètre alors qu'il est actif en dérive automatiquement une copie.

- **Loyers max €/m² SU/mois** (ParaGEN!D22:G24) : PLUS 7,32/6,42/5,95/7,77 (zones 1/2/3/1bis) ; PLAI 6,50/5,71/5,28/6,93 ; LIBRE 15/11/8/18. DOM : valeurs par département (branchement présent, hors V1).
- **Valeurs de base VB €/m²** (ParaGEN!D36:G41) : Neuf Coll 1767/1473/1473/1767, Ind 1767/1619/1619/1767 ; Acquisition Coll 1767/1382/1382/1767, Ind 1767/1473/1473/1767.
- **Taxe d'aménagement €/m²** (ParaGEN!B31:B32) : 930 hors IdF, 1054 IdF.
- **Quotité foncier VEFA par zone** (ParaGEN!D61:H69) : matrice usage × zone ABC (constaté B1 : terrain 0,30 ; SSF/PGE 0,60).
- **Trajectoires macro par année civile** (ParaGEN!GS22:HE72) : LA, GE, gestion, vacance, loyers, frais fin., produits fin., TFPB, index TFPB. Profil AXENTIA HER 2026 (PMT 2025).
- **Constantes** : CS 0,77 & facteur 20 (métropole habitat), 0,685 & 31 (DOM), 38 (foyers) ; PLUS 33 % ; majoration >100 % plafonds = 33 % ; marge locale plafonnée (~12 %) ; SSF plafonds 40/50 %, taux État 20 % neuf / 40 % AA ; TVA 10 %/5,5 %/20 % ; exonération TFPB 25 ans.

## 3. R-SURF - Surfaces et coefficients de structure

- **R-SURF-1** ✅ Surface utile : SU = SHAB + 0,5 × surfaces_annexes (par produit × Coll/Ind), arrondie 2 déc. Peut être forcée. Source calculs!D384. DOM → « Surface Financée ».
- **R-SURF-2** ✅ Coefficient de structure (habitat métropole) : CS = 0,77 × (1 + k × NL/SU), k = 20 (habitat/étudiant), 38 (foyers) ; DOM : 0,685 × (31 × NL + SF)/SF. Source calculs!D92:D116. Variantes : par produit, mixte (SU PLUS+PLAI), hors annexes (SHAB), SLA mixte. Flag CS_mixte (ParaPLUS!H27/H37). Arrondi 4 déc. si option.
- **R-SURF-3** ✅ Quotes-parts : qpSUPLUS = SU_(PLUS+PLUS33)/SU_totale, qpSUPLAI = SU_PLAI/SU_totale (calculs!B167:B168).

## 4. R-LOYER - Loyers réglementés

- **R-LOYER-1** ✅ Loyer de base = loyer_max_zone(produit, zone) + marge_locale_départementale (saisie €/m²). Source calculs!D72:D77. PLUS 33 % = loyer PLUS × 1,33 (⚠️ I-6 : LEON fait +0,33 en mode arrondi vs ×1,33 sinon - arbitrage : ×1,33 partout).
- **R-LOYER-2** ✅ Loyer max de base = CS(produit) × loyer_base(produit) (calculs!D117:D119), arrondi 2 déc. optionnel.
- **R-LOYER-3** ✅ Marges locales de majoration : marge = MIN(Σ majorations affectées, plafond ParaPLUS!AD30), plafonnement séparé PLUS/PLAI. Source FinPLUS!S26:T29.
- **R-LOYER-4** 🔶 Majoration LCR : ratio surfaces LCR/référence ; <10 % → 0, >20 % → +2 %, sinon ratio/100 (borne intermédiaire à confirmer calculs!D152/F152).
- **R-LOYER-5** ✅ Loyer pratiqué = Lmax_base × (1 + marge_plafonnée), arrondi 2 déc. si option. Si loyer_sortie_forcé → remplace tout. Annuel = 12 × SU × loyer. Source FinPLUS!S46:U58.
- **R-LOYER-6** 🔶 Annexe importante : si loyer des annexes intégrées > seuil (facteur 1,18 si marge ≤ 12 %, 1,25 sinon), part excédentaire retirée et loyer recalculé « après annexe importante ». Transcription fine à faire avec cas de test dédié (calculs!D120:D156).
- **R-LOYER-7** ✅ Loyers annexes séparées : NL × loyer_unitaire × 12, sans passer par le CS (FinPLUS!S60:U64).
- **R-LOYER-8** ✅ Contrôles : alerte dépassement loyer max ; alerte loyer plafond dépassé.
- **R-LOYER-9** ✅ Millésime du barème de loyers (07/08/2026). Les plafonds sont revalorisés au 1er janvier : le barème porte une `annee_reference`, saisissable. Elle appartient au BARÈME et non à la simulation - la faire suivre l'année de livraison ferait passer les valeurs 2025 pour celles de 2029. Le moteur **revalorise par défaut** : il indexe le plafond de zone (et lui seul, la marge locale étant une saisie en euros du jour) sur le cumul des IRL de la trajectoire entre le millésime et la mise en location. LEON, lui, applique le barème tel quel : les fixtures qui le reproduisent posent donc explicitement `options.revaloriser_loyers_plafonds: false`, l'écart étant écrit là où il se lit plutôt que caché dans un défaut. Dans les deux cas le moteur alerte - revalorisé, il nomme l'écart assumé avec LEON ; désactivé, il chiffre ce que le millésime périmé coûte. Reste ouvert : LEON revalorise-t-il ailleurs, en amont de sa saisie ?

## 5. R-TVA - Prix de revient et TVA (LASM)

- **R-TVA-1** ✅ Saisie HT + taux → TVA → TTC, séparément Coll/Ind (BilPLUS!D:J).
- **R-TVA-2** ✅ TVA finale (livraison à soi-même) : TTC_final(poste) = HT × (1 + taux_LASM), taux_LASM_PLUSPLAI = 10 % (⚠️ le tableau ParaGEN!A78 affiche 5,5 % mais LEON utilise le taux réduit de la simulation ParaGLOB!J44 = 10 % - documenté dans baremes_2025.json). PR TTC réf = BilPLUS!V86.
- **R-TVA-2 bis** ✅ **Taux de TVA par tranche** (10/08/2026, verifie contre le CGI art. 278 sexies et le BOFiP). Le taux social est une propriete du PRODUIT : 5,5 % pour le PLAI, 10 % pour le PLUS, le PLS et le logement intermediaire, 20 % pour le libre ; le PLUS en quartier prioritaire ou sous convention NPNRU releve de 5,5 % (entree `identite.qpv`, condition de localisation et non produit distinct). Trois consequences : (a) le taux par defaut d'une ligne de prix de revient sur une tranche est **celui de son produit**, tel qu'il est regle a l'ecran des parametres - le changer y deplace toutes les lignes de ce produit qui n'ont pas de saisie propre ; (b) le taux d'une ligne ne se propage plus a une tranche ou il n'existe pas - une ligne a 5,5 % ne rend plus la part PLS a 5,5 % ; (c) la liste des taux saisissables sur une tranche se limite a {0 %, taux du produit, taux normal}, un taux deja saisi hors de cette liste etant conserve et signale « hors bareme » plutot qu'ecrase. Un poste **hors champ LASM** garde son taux de saisie : il est en dehors du regime du produit (annexes OP-1, Q-24).
- **R-TVA-3** ✅ Clé de répartition : **% SU**, clé unique pour toute l'opération (arbitrage du 05/08/2026, conforme à `PDR!B3` de la maquette LEON REWORK : « Saisie HT globale, ventilation au prorata SU »). Chaque poste est saisi une fois, globalement, puis réparti entre les tranches au prorata de leur surface utile ; **chaque tranche applique ensuite son propre taux de LASM** (R-TVA-2), ce qui est tout l'intérêt de la ventilation : un PLAI et un LIBRE ne portent pas la même TVA finale sur le même poste. Aucun arrondi pendant la ventilation ; aux totaux, la répartition en euros entiers conserve exactement la somme (méthode du plus grand reste, `arrondirEnConservantLaSomme`). Les variantes % SDP et % SHAB restent possibles sans changer la signature. Source `PDR` (46 postes, 5 chapitres).
- **R-TVA-4** ✅ Modulation du PR : PR_TTC_modulé = PRTTC + modulation (TTC non finançable saisi), ventilé par qpSU.
- **R-TVA-5** ✅ TVA sur intérêts de préfi (ParaPLUS!F47/J47, 0 ou 5 %).

## 6. R-SUB - Subventions calculées

- **R-SUB-1** 🔶 Subvention État (SLA) : métropole via forfait (base NL/SHAB/SU selon mode) ; assiette réglementaire nulle hors DOM. SLA_PLUSPLAI = SLA_PLUS + SLA_PLAI. MQECO en acquisition-amélioration. Source calculs!B254:B264.
- **R-SUB-2** ✅ Subvention surcharge foncière (SSF) : dépassement = valeur foncière réelle − référence (VB × SU_SSF) ; plafond État conditionnel (participations collectivités < 40 % du dépassement → MIN(taux plafonné × réf, 50 % × dépassement)) ; taux dépassement ×1 neuf/×0,2 AA ; taux subvention 2 neuf/0,4 AA. Conditionné au flag ParaPLUS!DE76 = OK. Source calculs!D274:B292.
- **R-SUB-3** ✅ Gratuité et affectation : chaque subvention porte flag gratuit (1/0) et affectation PLUS/PLAI/PLUS-PLAI (ventilée par qpSU). Agrégats gratuites/non gratuites → équilibre. Source calculs!D295:D314.

## 7. R-FIN - Plan de financement et prêts CDC théoriques

- **R-FIN-1** ✅ Équilibre : Subventions + FP + Prêts = PR_TTC_modulé. Contrôle calculs!D327 (surfinancement/sous-financement).
- **R-FIN-2** 🔶 Foncier finançable (méthode globale si ParaGEN!A64 = "global") : charge_foncière × (1 − financements_gratuits/PR_TTC_opération), réparti au prorata SU. Sinon méthode par produit. Prix du foncier par quotités VEFA en VEFA (calculs!B1281:B1287).
- **R-FIN-3** ✅ Solde à financer : solde_PLUS = PR_TTC_PLUS_modulé − (subventions_PLUS + FP_PLUS + autres_prêts_PLUS) (calculs!D336) ; idem PLAI.
- **R-FIN-4** 🔶 Prêts CDC théoriques : PRÊT FONCIER = MIN(borné(solde, foncier_finançable), solde), plancher 0, arrondi milliers sup si option ; PRÊT BÂTIMENT = solde − préfi_échéancier − prêt_foncier. Correction « redressement », montants forcés, option PLUS Horizen (prêts >49 ans affectés PLUS → foncier), dernière échéance = reliquat au dernier tirage.
- **R-FIN-5** ✅ Contrôles : ratio prêts CDC PLUS / PR PLUS ≥ 50 %.
- **R-FIN-6** ✅ Préfinancement - **transcrit le 04/08/2026**. Échéancier de 13 tirages datés (`SimPLUS!AL23:AL35` dates, `AM23:AP35` montants par prêt). Capitalisation **actuarielle en base exact/365** : `capitalisé = Σ montant_i × (1 + taux)^((date_fin − date_i)/365)`, `intérêts_préfi = capitalisé − Σ montant_i`. `date_fin = SimPLUS!FA14 = $AL$35` = date du **dernier tirage** (et non la mise en location). Deux modes : forfait au bilan ou par échéancier. Flag « ne pas capitaliser les intérêts de préfinancement » (`SimPLUS!AS24`) : n'annule pas le coût, empêche seulement l'incorporation au capital. Source `SimPLUS!FA15:FD27`.

## 8. R-AMT - Moteur d'amortissement CDC ⭐ (cœur, validé ±0,1 % avril 2026)

- **R-AMT-1** ✅ Caractéristiques par défaut des 4 prêts CDC : PLUS Constr. LA+0,60 %/40 ans/DOUBLE ; PLUS Foncier LA+0,60 %/50 (B2/C) ou 60 ans/DOUBLE ; PLAI Constr. LA−0,20 %/40 ans/DOUBLE ; PLAI Foncier LA−0,20 %/50-60 ans/DOUBLE. Progressivité −0,5 % (AXENTIA). + marge_anticipée_LA sur tous les taux.
  - **Séparation marge / durée (07/08/2026).** Un taux de prêt CDC ne se saisit ni ne se code : il vaut `Livret A de référence + marge`. Les MARGES sont des données tarifaires, révisées plusieurs fois par an, et vivent donc au référentiel (`baremes.prets_cdc.marges`, grille CDC de juin 2026) ; `produits.js` ne porte plus que la clé (`cle_marge`). Les DURÉES restent au produit : elles suivent une règle de zonage, pas un tarif. Une simulation peut surcharger une marge par `entrees.parametrage.marges_prets`, et un prêt porter la sienne par `spread` ; un `taux` saisi en clair prime sur les deux, seul recours pour un prêt hors fonds d'épargne. Marges en vigueur : PLAI −0,20 %, PLUS +0,60 %, PLUS constructions vertes +0,20 %, PLS et CPLS +1,11 %, PLI/LLI +1,40 % (`Taux!C11:C15`).
- **R-AMT-2** ✅ Première annuité (profil progressif) : `q = (1+p)/(1+t)` ; `annuité_1 = K × (1+t) × (1 − q) / (1 − q^(n−d))`. Si t = 0 → LEON renvoie 0 (⚠️ I-8 : nous faisons l'amortissement linéaire). Source SimPLUS!AM15.
- **R-AMT-3** ✅ Date de première échéance : année(DAT) + 1, +0 si démembrement. Chaque prêt « autre » porte sa propre date (AR17…) - c'est la règle dont la violation causait le bug ALS (chaque prêt démarre à SA date, pas à l'an 1 commun).
- **R-AMT-4** ✅ Révision annuelle (barème CDC) - **transcrite le 04/08/2026 depuis les formules vivantes** (classeur OP-3 07/2026, même version 131 onglets). Pour chaque année N, k = 0…durée−1, année = année_1re_échéance + k :
  - `LA_N = VLOOKUP(année, ParaGEN!CT22:DD102, 11)` (approché, dernière valeur ≤ année) ; `LA₀ = Tx_LA`.
  - `tx_N = (1+t) × (1 + (LA_N − LA₀)/(1+t)) − 1` (= `t + LA_N − LA₀`), sauf `TAUX FIXE` → `tx_N = t` (garde présente dans SimLIB!FH8, absente du bloc CDC : écart E-3).
  - `rev_N` : DOUBLE → `(1+p) × (1 + (LA_N − LA₀)/(1+t)) − 1` ; D. LIMITÉE → `MAX(…, 0)` ; tout autre libellé (SIMPLE inclus) → `p`.
  - **Pendant le différé** (k < d) : amortissement 0, CRD inchangé ; intérêts = 0 si type 1 (LEON ne capitalise pas - écart E-2, question Q-6), sinon `tx_N × CRD` ; annuité = intérêts.
  - **Sinon - RÉ-AMORTISSEMENT annuel** (et non progression géométrique de l'annuité) : `annuité_N = CRD_{N−1} × (1+tx_N) × (1 − q_N)/(1 − q_N^{m_N})` avec `q_N = (1+rev_N)/(1+tx_N)` et `m_N = durée − k`. Puis `intérêts_N = tx_N × CRD_{N−1}` ; `amort_N = annuité_N − intérêts_N` ; `CRD_N = CRD_{N−1} − amort_N`.
  - Branche linéaire : si `(t = 0 et p = 0)` ou `(rev_N = 0 et tx_N = 0)` → `annuité = K/(durée − différé)`.
  - Si `ROUND(CRD_{N−1}, 4) ≤ 0` → annuité 0, la ligne reste dans la table.
  - **Dernière échéance : aucun cas particulier.** À `m_N = 1` le facteur vaut `(1+tx_N)`, donc l'annuité solde exactement `CRD + intérêts`.
  - ⚠️ La formulation `annuité_N = annuité_{N−1} × (1 + rev_N)` de la v0.1 est **fausse dès que le LA bouge** ; elle n'est équivalente qu'à taux constant. Source `SimPLUS!FF117:FN117`.
- **R-AMT-5** ✅ Sortie : table par prêt (année → taux, annuité, intérêts, amortissement, CRD). Annuité comptée si année ≥ année(1re échéance du prêt).

## 9. R-EXP - Compte d'exploitation prévisionnel (50-60 ans) 🔶

Table SimPLUS!DO..EC+ (années en lignes, montants k€). Par année N : **Produits** = loyers logements (an 1 R-LOYER-5 indexé IRL) + loyers annexes + loyer divers + produits financiers. **Charges** = Σ annuités (VLOOKUP tables amortissement, filtrées par date 1re échéance) + frais de gestion + TFPB (à partir de fin d'exonération R-FISC-1) + REL + gros entretien/PGERC (trajectoire GE €/m² × SHAB × index BT01) + vacance & impayés + frais financiers. **Soldes** = résultat, autofinancement, cumuls, reconstitution FP (durée, taux, différé, mode). Bloc à transcrire produit par produit avec l'annexe en golden test (colonnes EC-EN + cachées GU/HB/HH/HX/IA).

- **R-EXP-PGE** ✅ **Provision pour gros entretien, dite aussi PCRC** (10/08/2026, matrice matrice LEON de reference). LEON la présente au m² (`SimPLUS!DX` = tarif €/m² × SHAB) mais ce tarif vient lui-même de `taux × base / SHAB` (`SimPLUS!BJ12`), puis d'une indexation cumulée (`GK = BJ × GI`, `GI` composant la trajectoire de gros entretien). **La SHAB se simplifie** : la provision vaut donc
  ```
  PGE(N) = taux(N) × base × cumul d'indexation du gros entretien
  ```
  et n'est **pas** une grandeur au mètre carré, malgré la forme sous laquelle la matrice la présente. La **base** (`SimPLUS!BK31`) est le prix de revient TTC de la tranche en VEFA, et le prix de revient de l'opération net de quelques postes puis réparti à la surface utile sinon. Le **taux** peut varier par année : c'est ainsi que la provision monte en charge sur les premières années (OP-3 double en quatre ans, ce qu'aucun taux constant ne reproduit). Trois modes au choix dans `SimPLUS!BI10` : `% PGE` (celui décrit ici, 0,6 % sur la matrice d'habitation), `Stats GE` et `Stats internes`, qui lisent des tables de statistiques (`ParaGEN!DF`/`DG`, cette dernière à 1,13 €/m² à plat). Implémenté sous `pge_taux` / `pge_taux_par_annee` / `pge_base_eur` ; une table annuelle saisie continue de primer, une donnée constatée ne se faisant pas recalculer.

## 10. R-FISC - Fiscalité

- **R-FISC-1** 🔶 Exonération TFPB : année_début = année(DAT) + 25 + correction (pivot 1er janvier). Durée 25 ans standard (⚠️ I-7 : paramétrable 2/15/25/30). Source SimPLUS!G37.
- **R-FISC-2** ✅ Taxe d'aménagement : assiette = SDP × (1 − abattement 50 %) × valeur_forfaitaire (930/1054) + parkings ×… Source calculs!B1255:B1259.
- **R-FISC-3** ✅ VSD : si neuf et seuil densité > 0, MIN(valeur_terrain/2 × (1 − SDP/(seuil×surface)), 25 % × valeur_terrain).
- **R-FISC-4** 🔶 TVA (cf. R-TVA) ; dégrèvement/défiscalisation SimPLUS!A40:A42 (hors chemin critique V1 métropole).

## 11. Indicateurs de sortie (Grille d'analyse / Présentation CA)

PR par chapitre HT/TTC + total, €/m² SHAB, €/logement ; plan de financement (prêts montant/durée/% PR/révisabilité, subventions, FP, % prêts, % FP) ; RMO (loyers an 1 / PR TTC) ; frais financiers moyens ; base d'amortissement comptable (PR TTC − terrain, terrain = 25 % acq VEFA) ; année reconstitution FP ; taux rémunération FP ; PGERC (type, plafond 0,6-1 %) ; TFPB €/lgt ; compte d'exploitation année par année.

## 12. Golden tests - protocole

Mêmes entrées (onglet IN) → reproduire la Présentation CA ligne à ligne. Tolérances : ±1 € bilan/plan de financement, ±0,1 % annuités/exploitation. Jeux disponibles : `fixtures/op-1-libre` (LIBRE, VEFA zone 2/B1), `fixtures/op-2-lli` (LLI, en réalité sim n°3307 même opération ; écart résiduel 0,45 € = arrondi de présentation LEON, à NE PAS reproduire). Manque V1 : un jeu PLUS/PLAI habitat (annexe 1303 à exporter). Tests unitaires : R-AMT-2/4 (annuités canoniques), R-LOYER (zone×produit×marges), R-SUB-2 (SSF aux bornes), R-FIN-4 (équilibres, redressement, Horizen).

## 13. Irrégularités de la source (arbitrages)

| ID | Constat | Arbitrage |
|---|---|---|
| I-1 | Moteur dupliqué 14× (divergences de bugs, ex. date 1re échéance ALS) | Moteur unique paramétrique, produit = donnée |
| I-2 | Constantes en dur (`345+117*0`, 0,9, 0,8 %, 1,18/1,25) | Tout en référentiel versionné, zéro littéral |
| I-3 | Référence cassée ParaGLOBC49 → SimPLUS!A36 #DIV/0! | Réimplémenter proprement (frais contrôle ville % loyers) |
| I-4 | Bruit flottant par accumulation itérative (PMT) | Calculs exacts + arrondis aux frontières |
| I-5 | Libellés fautifs (« désamientage »…) | Référentiel de postes propre |
| I-6 | PLUS 33 % : +0,33 vs ×1,33 selon mode | ×1,33 partout, écart documenté |
| I-7 | Exonération TFPB 25 ans câblée vs « EXONERATION 2 » ailleurs | Paramètre durée_exoneration_tfpb |
| I-8 | Annuité à taux 0 → 0 | Taux 0 = amortissement linéaire |
| I-9 | Arrondis pilotés par flag global hétérogène | Politique explicite par grandeur (`arrondis.js`) |
| I-10 | XML malformé des liens annexes | Sans objet dans la cible |

## 14. Backlog d'extraction (par ordre d'implémentation)

R-AMT-4 fin (FK117 + capitalisation préfi FA15:FD27) → R-EXP colonnes EC-EN + cachées → R-LOYER-6 (annexe importante) → reconstitution FP → PGERC (trajectoire GJ13:GK74, index BT01) → Présentation CA (mapping 593 lignes). Modules hors V1 : foyers (jeu Strasbourg n°3204 prêt) → PLS → LLI/LOC → LIBRE → REH → IFRS/IS.

## 15. Schéma de données cible (persistance - phase ultérieure, Postgres VM, jamais Supabase)

`referentiels` (versionnés par date_valeur : baremes loyers/valeurs de base/TA/quotités VEFA, trajectoires, constantes) ; `simulations` (id, operation_id lien SFO, version_moteur, entrees JSONB, resultats JSONB, indicateurs plats requêtables) ; `moteur` (module JS pur versionné : `calculer(entrees, referentiels) → resultats`, déterministe, testé).
