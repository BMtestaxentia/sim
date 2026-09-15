// @ts-check
/**
 * DOMAINE « PRETS » - R-FIN-3/5/8/9 et R-AMT-1 : la liste des prets, leurs
 * caracteristiques, la scission PLS / CPLS et l'equilibre du plan.
 *
 * LA LISTE. Les prets saisis d'abord. Si aucun n'est un pret foncier ou de
 * construction, chaque tranche recoit en plus les prets que son produit pose
 * par defaut - un foncier et une construction a la CDC, un seul pret en banque
 * pour le logement libre. Un pret dont la duree reste inconnue est ecarte, avec
 * une alerte ; le CPLS s'ajoute en fin de liste quand le PLS est plafonne.
 *
 * LES CARACTERISTIQUES. Chacune se lit sur la saisie, et a defaut sur les
 * valeurs par defaut du produit de la tranche (duree selon la zone, marge de la
 * grille CDC, modele de pret pour le libre). Le taux fait exception : un pret
 * indexe se decrit par sa MARGE, et son taux vaut Livret A d'origine + marge
 * des qu'une marge est connue, sauf taux saisi en clair.
 *
 * Sources : calculette CDC « production LS » (plafond PLS de 55 %, plancher de
 * 51 %, plafond LLI de 90 %, controle AT32), `produits.js` (prets par defaut).
 */
import { produit, financeParCDC, pretsDefautResolus } from '../../produits.js';

/** Code et libelle des prets poses par defaut, avant suffixe de tranche. */
const MODELES_PRETS_DEFAUT = /** @type {Record<string, {code: string, libelle: string}>} */ ({
  foncier: { code: 'CDC_FONCIER', libelle: 'Prêt CDC foncier' },
  construction: { code: 'CDC_BATIMENT', libelle: 'Prêt CDC construction' },
});

/** @type {import('../classeur.js').Domaine} */
export const PRETS = {
  domaine: 'prets',
  titre: 'Prêts',
  dimensions: {
    pret_base: {
      libelle: 'Prêt',
      valeurs: 'CONCATENER(INDICES(prets_saisis); SI(pret_principal_saisi; VIDE; cles_prets_defaut))',
    },
    pret: {
      libelle: 'Prêt',
      valeurs: "CONCATENER(prets_calculables; SI(cpls_montant > 0; ENSEMBLE('CPLS'); VIDE))",
      etiquette: 'libelle_pret',
    },
  },
  grandeurs: {
    // --- Livret A ---------------------------------------------------------------
    la_origine: {
      libelle: 'Livret A de référence',
      unite: 'taux',
      regle: 'R-AMT-1',
      trajectoire: 'taux_reference_livret_a',
      ecran: 'Paramètres > Modèles de prêt',
    },
    la_par_annee: {
      libelle: 'Trajectoire du Livret A',
      unite: 'liste',
      trajectoire: 'livret_a_par_annee',
      ecran: 'Paramètres > Trajectoires macro',
    },

    // --- Valeurs par defaut des produits ------------------------------------------
    defauts_prets_tranche: {
      libelle: 'Prêts par défaut du produit',
      unite: 'liste',
      regle: 'R-AMT-1',
      sur: ['code'],
      // Lecture du referentiel des produits : duree selon la zone, marge de la
      // grille CDC, modele de pret pour un produit finance en banque. Une
      // tranche dont les valeurs ne se resolvent pas (marge ou zone inconnue)
      // n'en a aucune, et le dit.
      lire: (ctx, code) => {
        const surcharges = ctx.entrees?.caracteristiques_prets_defaut ?? {};
        const b = ctx.baremes ?? {};
        try {
          const defauts = pretsDefautResolus(code, {
            zone_ABC: ctx.entrees?.identite?.zone_ABC,
            livret_a_reference: surcharges.livret_a_origine ?? ctx.trajectoires?.taux_reference_livret_a,
            marges: b.prets_cdc?.marges ?? {},
            presets: b.presets_prets?.presets ?? [],
            progressivite: surcharges.progressivite ?? b.prets_cdc?.defauts?.progressivite ?? 0,
          });
          return { defauts: Object.fromEntries(defauts.map((d) => [d.nature, d])), erreur: null };
        } catch (e) {
          return { defauts: {}, erreur: /** @type {Error} */ (e).message };
        }
      },
      ecran: 'Paramètres > Modèles de prêt',
    },
    defaut_pret: {
      libelle: 'Caractéristique par défaut',
      unite: 'texte',
      regle: 'R-AMT-1',
      sur: ['code', 'nature', 'champ'],
      formule: "CHAMP(CHAMP(CHAMP(defauts_prets_tranche; 'defauts'); nature); champ)",
    },
    erreur_defauts_pret: {
      libelle: 'Valeurs par défaut non calculables',
      unite: 'texte',
      sur: ['code'],
      formule: "CHAMP(defauts_prets_tranche; 'erreur')",
    },
    code_base_defaut: {
      libelle: 'Code du prêt par défaut',
      unite: 'texte',
      sur: ['code', 'nature'],
      // Le code cesse d'annoncer la CDC des que la tranche n'en releve pas.
      lire: (_ctx, code, nature) =>
        financeParCDC(code) ? MODELES_PRETS_DEFAUT[nature].code : `PRET_${String(nature).toUpperCase()}`,
    },
    libelle_base_defaut: {
      libelle: 'Libellé du prêt par défaut',
      unite: 'texte',
      sur: ['code', 'nature'],
      lire: (_ctx, code, nature) =>
        produit(code).prets_defaut.find((d) => d.nature === nature)?.libelle ??
        MODELES_PRETS_DEFAUT[nature].libelle,
    },
    finance_par_cdc_code: {
      libelle: 'Produit financé sur fonds d’épargne',
      unite: 'booleen',
      regle: 'R-FIN-5',
      sur: ['code'],
      lire: (_ctx, code) => financeParCDC(code),
    },

    // --- La liste des prets ------------------------------------------------------
    cles_prets_defaut: {
      libelle: 'Prêts posés par défaut',
      unite: 'liste',
      regle: 'R-FIN-3',
      formule: "LISTE(TEXTE.JOINDRE(t; '|'; n) POUR t DANS tranches_presentes POUR n DANS natures_defaut[tranche: t])",
      note: 'Un par tranche et par nature que son produit déclare, quand aucun prêt foncier ou construction n’est saisi.',
    },
    tranche_defaut_pret: {
      libelle: 'Tranche du prêt par défaut',
      unite: 'texte',
      sur: ['pret_base'],
      formule: "SI(EST.NOMBRE(pret_base); VIDE; PARTIE(pret_base; '|'; 0))",
    },
    nature_defaut_pret: {
      libelle: 'Nature du prêt par défaut',
      unite: 'texte',
      sur: ['pret_base'],
      formule: "SI(EST.NOMBRE(pret_base); VIDE; PARTIE(pret_base; '|'; 1))",
    },
    champ_pret_defaut: {
      libelle: 'Caractéristique posée sur le prêt par défaut',
      unite: 'texte',
      sur: ['pret_base', 'champ'],
      formule:
        "SI(champ = 'code'; TEXTE.JOINDRE(code_base_defaut[code: tranche_defaut_pret; nature: nature_defaut_pret]; '_'; tranche_defaut_pret); " +
        "SI(champ = 'libelle'; TEXTE.JOINDRE(libelle_base_defaut[code: tranche_defaut_pret; nature: nature_defaut_pret]; " +
        "SI(LONGUEUR(tranches_presentes) > 1; TEXTE.JOINDRE(' '; tranche_defaut_pret); '')); " +
        "SI(champ = 'nature'; nature_defaut_pret; SI(champ = 'produit'; tranche_defaut_pret; " +
        "SI(champ = 'montant_auto'; VRAI; INDEFINI)))))",
    },
    champ_pret_base: {
      libelle: 'Caractéristique portée par le prêt',
      unite: 'texte',
      sur: ['pret_base', 'champ'],
      formule: 'SI(EST.NOMBRE(pret_base); champ_pret_saisi[pret_saisi: pret_base]; champ_pret_defaut)',
    },
    nature_pret: {
      libelle: 'Nature du prêt',
      unite: 'texte',
      sur: ['pret_base'],
      formule: "champ_pret_base[champ: 'nature']",
    },
    tranche_pret: {
      libelle: 'Tranche du prêt',
      unite: 'texte',
      sur: ['pret_base'],
      formule: "DEFAUT(champ_pret_base[champ: 'produit']; tranche_unique)",
    },
    pret_auto: {
      libelle: 'Prêt à montant automatique',
      unite: 'booleen',
      regle: 'R-FIN-3',
      sur: ['pret_base'],
      formule:
        "OU(champ_pret_base[champ: 'montant_auto'] = VRAI; NON(RENSEIGNE(champ_pret_base[champ: 'montant_eur'])))",
    },
    carac_pret: {
      libelle: 'Caractéristique du prêt',
      unite: 'texte',
      regle: 'R-AMT-1',
      sur: ['pret_base', 'champ'],
      formule:
        'DEFAUT(champ_pret_base; SI(nature_pret; defaut_pret[code: tranche_pret; nature: nature_pret]; INDEFINI))',
      note: 'La saisie, à défaut la valeur par défaut du produit de la tranche.',
    },
    montant_avant_scission: {
      libelle: 'Montant du prêt avant scission',
      unite: 'eur',
      regle: 'R-FIN-3',
      sur: ['pret_base'],
      formule:
        "SI(ET(pret_auto; tranche_pret); DEFAUT(montant_auto[tranche: tranche_pret; nature_auto: nature_pret]; 0); champ_pret_base[champ: 'montant_eur'])",
    },
    livret_a_origine_pret: {
      libelle: 'Livret A d’origine du prêt',
      unite: 'taux',
      regle: 'R-AMT-1',
      sur: ['pret_base'],
      formule: "DEFAUT(champ_pret_base[champ: 'livret_a_origine']; la_origine)",
    },
    livret_a_par_annee_pret: {
      libelle: 'Trajectoire du Livret A du prêt',
      unite: 'liste',
      sur: ['pret_base'],
      formule: "DEFAUT(champ_pret_base[champ: 'livret_a_par_annee']; la_par_annee)",
    },
    spread_pret: {
      libelle: 'Marge du prêt',
      unite: 'taux',
      regle: 'R-AMT-1',
      sur: ['pret_base'],
      formule: "carac_pret[champ: 'spread']",
    },
    taux_resolu_pret: {
      libelle: 'Taux du prêt',
      unite: 'taux',
      regle: 'R-AMT-1',
      sur: ['pret_base'],
      formule:
        "SI(RENSEIGNE(champ_pret_base[champ: 'taux']); champ_pret_base[champ: 'taux']; " +
        "SI(EST.NOMBRE(spread_pret); livret_a_origine_pret + spread_pret; carac_pret[champ: 'taux']))",
      note: 'Un prêt indexé se décrit par sa marge : son taux s’en déduit, sauf taux saisi en clair.',
    },
    duree_pret: {
      libelle: 'Durée du prêt',
      unite: 'an',
      sur: ['pret_base'],
      formule: "carac_pret[champ: 'duree_ans']",
    },
    pret_calculable: {
      libelle: 'Prêt amortissable',
      unite: 'booleen',
      sur: ['pret_base'],
      formule: 'duree_pret > 0',
      note: 'Un prêt sans durée connue est écarté du plan, avec une alerte.',
    },
    prets_calculables: {
      libelle: 'Prêts retenus',
      unite: 'liste',
      formule: 'LISTE(pret_base POUR pret_base QUAND pret_calculable)',
    },

    // --- R-FIN-8 : scission PLS / CPLS -------------------------------------------
    tranche_pls_presente: {
      libelle: 'Le programme porte une tranche PLS',
      unite: 'booleen',
      formule: "CONTIENT(tranches_ordre_saisie; 'PLS')",
    },
    prets_pls: {
      libelle: 'Prêts PLS',
      unite: 'liste',
      regle: 'R-FIN-8',
      formule:
        "LISTE(p POUR p DANS prets_calculables QUAND ET(tranche_pret[pret_base: p] = 'PLS'; nature_pret[pret_base: p] <> 'autre'))",
    },
    total_pls: {
      libelle: 'Prêts appelés en PLS',
      unite: 'eur',
      regle: 'R-FIN-8',
      formule: 'SOMME(NOMBRE(montant_avant_scission[pret_base: p]) POUR p DANS prets_pls)',
    },
    pr_pls: {
      libelle: 'Prix de revient de la tranche PLS',
      unite: 'eur',
      formule: "DEFAUT(total_ttc_module_tranche[tranche: 'PLS']; 0)",
    },
    plafond_pls: {
      libelle: 'Part maximale du PLS',
      unite: 'taux',
      regle: 'R-FIN-8',
      constante: 0.55,
      note: 'Calculette CDC « production LS » : le PLS est compris entre 51 et 55 % du prix de revient.',
    },
    plancher_pls: {
      libelle: 'Part minimale attendue du PLS',
      unite: 'taux',
      regle: 'R-FIN-8',
      constante: 0.51,
    },
    scission_possible: {
      libelle: 'PLS et prix de revient connus',
      unite: 'booleen',
      formule: 'ET(total_pls > 0; pr_pls > 0)',
    },
    plafond_pls_eur: {
      libelle: 'Plafond du PLS',
      unite: 'eur',
      regle: 'R-FIN-8',
      formule: 'pr_pls * plafond_pls',
    },
    pls_retenu: {
      libelle: 'PLS dans la limite du plafond',
      unite: 'eur',
      regle: 'R-FIN-8',
      formule: 'MIN(total_pls; plafond_pls_eur)',
    },
    part_pls: {
      libelle: 'Part du PLS dans le prix de revient',
      unite: 'taux',
      regle: 'R-FIN-8',
      formule: 'SI(scission_possible; pls_retenu / pr_pls; VIDE)',
    },
    pls_eur: {
      libelle: 'PLS retenu, arrondi',
      unite: 'eur',
      formule: 'SI(scission_possible; ARRONDI.EURO(pls_retenu); ARRONDI.EURO(MAX(0; NOMBRE(total_pls))))',
    },
    cpls_montant: {
      libelle: 'CPLS',
      unite: 'eur',
      regle: 'R-FIN-8',
      formule:
        'SI(ET(tranche_pls_presente; scission_possible); ARRONDI.EURO(MAX(0; total_pls - plafond_pls_eur)); 0)',
      note: 'Au-delà du plafond, le complément n’est plus du PLS : c’est un CPLS.',
    },
    pls_sous_plancher: {
      libelle: 'PLS sous le plancher',
      unite: 'booleen',
      regle: 'R-FIN-8',
      formule: 'ET(scission_possible; part_pls < plancher_pls)',
    },
    pls_construction_preleve: {
      libelle: 'Prêt construction PLS entamé',
      unite: 'texte',
      formule:
        "PREMIER(p POUR p DANS prets_pls QUAND ET(nature_pret[pret_base: p] = 'construction'; montant_avant_scission[pret_base: p] > 0))",
    },
    pris_construction: {
      libelle: 'Part du CPLS prise sur la construction',
      unite: 'eur',
      regle: 'R-FIN-8',
      formule:
        'SI(ET(cpls_montant > 0; RENSEIGNE(pls_construction_preleve)); ' +
        'MIN(montant_avant_scission[pret_base: pls_construction_preleve]; cpls_montant); 0)',
      note: 'L’excès se prélève sur la construction d’abord, et jamais au-delà de ce qu’elle porte.',
    },
    reste_cpls: {
      libelle: 'Part du CPLS restant à prélever',
      unite: 'eur',
      formule:
        'SI(ET(cpls_montant > 0; RENSEIGNE(pls_construction_preleve)); ARRONDI.EURO(cpls_montant - pris_construction); cpls_montant)',
    },
    pls_foncier_preleve: {
      libelle: 'Prêt foncier PLS entamé',
      unite: 'texte',
      formule:
        "PREMIER(p POUR p DANS prets_pls QUAND ET(nature_pret[pret_base: p] = 'foncier'; montant_avant_scission[pret_base: p] > 0))",
    },
    pris_foncier: {
      libelle: 'Part du CPLS prise sur le foncier',
      unite: 'eur',
      regle: 'R-FIN-8',
      formule:
        'SI(ET(reste_cpls > 0; RENSEIGNE(pls_foncier_preleve)); MIN(montant_avant_scission[pret_base: pls_foncier_preleve]; reste_cpls); 0)',
    },
    montant_apres_scission: {
      libelle: 'Montant du prêt après scission',
      unite: 'eur',
      regle: 'R-FIN-8',
      sur: ['pret_base'],
      formule:
        'SI(ET(pris_construction > 0; pret_base = pls_construction_preleve); ARRONDI.EURO(montant_avant_scission - pris_construction); ' +
        'SI(ET(pris_foncier > 0; pret_base = pls_foncier_preleve); ARRONDI.EURO(montant_avant_scission - pris_foncier); ' +
        'montant_avant_scission))',
    },
    modele_cpls: {
      libelle: 'Prêt dont le CPLS reprend les caractéristiques',
      unite: 'texte',
      formule:
        "DEFAUT(PREMIER(p POUR p DANS prets_pls QUAND nature_pret[pret_base: p] = 'construction'); ELEMENT(prets_pls; 0))",
    },

    // --- Les prets du plan ---------------------------------------------------------
    source_pret: {
      libelle: 'Prêt d’origine',
      unite: 'texte',
      sur: ['pret'],
      formule: "SI(pret = 'CPLS'; modele_cpls; pret)",
    },
    carac_final: {
      libelle: 'Caractéristique du prêt',
      unite: 'texte',
      sur: ['pret', 'champ'],
      formule: 'carac_pret[pret_base: source_pret]',
    },
    code_pret: {
      libelle: 'Code du prêt',
      unite: 'texte',
      sur: ['pret'],
      formule: "SI(pret = 'CPLS'; 'CPLS'; carac_final[champ: 'code'])",
    },
    libelle_pret: {
      libelle: 'Libellé du prêt',
      unite: 'texte',
      sur: ['pret'],
      formule: "SI(pret = 'CPLS'; 'CPLS'; carac_final[champ: 'libelle'])",
    },
    nature_pret_final: {
      libelle: 'Nature du prêt',
      unite: 'texte',
      sur: ['pret'],
      formule: "SI(pret = 'CPLS'; 'construction'; nature_pret[pret_base: pret])",
    },
    produit_pret: {
      libelle: 'Tranche du prêt',
      unite: 'texte',
      sur: ['pret'],
      formule: "SI(pret = 'CPLS'; 'PLS'; tranche_pret[pret_base: pret])",
    },
    montant_pret: {
      libelle: 'Montant du prêt',
      unite: 'eur',
      regle: 'R-FIN-3',
      sur: ['pret'],
      formule: "SI(pret = 'CPLS'; cpls_montant; montant_apres_scission[pret_base: pret])",
    },
    montant_calcule_pret: {
      libelle: 'Montant calculé',
      unite: 'booleen',
      sur: ['pret'],
      formule: "SI(pret = 'CPLS'; VRAI; pret_auto[pret_base: pret])",
    },
    derive_pret: {
      libelle: 'Prêt dérivé d’une règle',
      unite: 'booleen',
      sur: ['pret'],
      formule: "SI(pret = 'CPLS'; VRAI; carac_final[champ: 'derive'] = VRAI)",
    },
    principal_saisi_pret: {
      libelle: 'Prêt principal déclaré',
      unite: 'booleen',
      sur: ['pret'],
      formule: "carac_final[champ: 'principal']",
    },
    principal_pret: {
      libelle: 'Prêt principal de la tranche',
      unite: 'booleen',
      sur: ['pret'],
      formule: 'OU(principal_saisi_pret = VRAI; derive_pret)',
    },
    livret_a_origine_final: {
      libelle: 'Livret A d’origine',
      unite: 'taux',
      regle: 'R-AMT-1',
      sur: ['pret'],
      formule: 'livret_a_origine_pret[pret_base: source_pret]',
    },
    livret_a_par_annee_final: {
      libelle: 'Trajectoire du Livret A',
      unite: 'liste',
      sur: ['pret'],
      formule: 'livret_a_par_annee_pret[pret_base: source_pret]',
    },
    spread_final: {
      libelle: 'Marge du prêt',
      unite: 'taux',
      regle: 'R-AMT-1',
      sur: ['pret'],
      formule: 'spread_pret[pret_base: source_pret]',
    },
    taux_premier: {
      libelle: 'Taux résolu du prêt',
      unite: 'taux',
      sur: ['pret'],
      formule: 'taux_resolu_pret[pret_base: source_pret]',
    },
    taux_pret: {
      libelle: 'Taux du prêt',
      unite: 'taux',
      regle: 'R-AMT-1',
      sur: ['pret'],
      formule:
        'SI(RENSEIGNE(taux_premier); taux_premier; SI(EST.NOMBRE(NOMBRE.BRUT(spread_final)); ' +
        'livret_a_origine_final + NOMBRE.BRUT(spread_final); taux_premier))',
      note: 'Taux = Livret A d’origine + marge, y compris pour un prêt « autre » posé depuis un modèle.',
    },
    progressivite_pret: {
      libelle: 'Progressivité des échéances',
      unite: 'taux',
      regle: 'R-AMT-2',
      sur: ['pret'],
      formule: "DEFAUT(carac_final[champ: 'progressivite']; 0)",
    },
    duree_ans_pret: {
      libelle: 'Durée du prêt',
      unite: 'an',
      sur: ['pret'],
      formule: "carac_final[champ: 'duree_ans']",
    },
    revisabilite_saisie_pret: {
      libelle: 'Révisabilité déclarée',
      unite: 'texte',
      sur: ['pret'],
      formule: "carac_final[champ: 'revisabilite']",
    },
    revisabilite_pret: {
      libelle: 'Révisabilité',
      unite: 'texte',
      regle: 'R-AMT-4',
      sur: ['pret'],
      formule: "DEFAUT(revisabilite_saisie_pret; 'TAUX FIXE')",
    },
    differe_ans_saisi_pret: {
      libelle: 'Différé déclaré, en années',
      unite: 'an',
      sur: ['pret'],
      formule: "carac_final[champ: 'differe_ans']",
    },
    differe_ans_pret: {
      libelle: 'Différé, en années',
      unite: 'an',
      sur: ['pret'],
      formule: 'DEFAUT(differe_ans_saisi_pret; 0)',
    },
    differe_mois_pret: {
      libelle: 'Différé, en mois',
      unite: 'mois',
      regle: 'R-AMT-9',
      sur: ['pret'],
      formule: "DEFAUT(carac_final[champ: 'differe_mois']; SI(principal_saisi_pret; duree_chantier_retenue; INDEFINI))",
      note: 'Un prêt principal diffère par défaut le temps des travaux : rien à rembourser tant que l’opération ne produit pas de loyer.',
    },
    differe_type_pret: {
      libelle: 'Type de différé',
      unite: 'nombre',
      regle: 'R-AMT-9',
      sur: ['pret'],
      formule: "DEFAUT(carac_final[champ: 'differe_type']; SI(principal_saisi_pret; 2; INDEFINI))",
    },
    differe_mois_effectif_pret: {
      libelle: 'Différé effectif, en mois',
      unite: 'mois',
      regle: 'R-AMT-9',
      sur: ['pret'],
      formule:
        "DEFAUT(carac_final[champ: 'differe_mois']; SI(differe_ans_saisi_pret; differe_ans_saisi_pret * mois_par_an; " +
        'SI(principal_saisi_pret; duree_chantier_retenue; 0)))',
    },
    profil_pret: {
      libelle: 'Profil d’amortissement',
      unite: 'texte',
      regle: 'R-AMT-6',
      sur: ['pret'],
      formule: "DEFAUT(carac_final[champ: 'profil_amortissement']; 'annuite')",
    },
    taux_plancher_pret: {
      libelle: 'Taux plancher',
      unite: 'taux',
      regle: 'R-AMT-7',
      sur: ['pret'],
      formule: "carac_final[champ: 'taux_plancher']",
    },
    periodicite_pret: {
      libelle: 'Échéances par an',
      unite: 'nombre',
      regle: 'R-AMT-8',
      sur: ['pret'],
      formule: "DEFAUT(carac_final[champ: 'periodicite']; 1)",
    },
    annee_premiere_echeance_pret: {
      libelle: 'Année de première échéance',
      unite: 'annee',
      regle: 'R-AMT-3',
      sur: ['pret'],
      formule: "DEFAUT(carac_final[champ: 'annee_premiere_echeance']; annee_mise_en_location)",
      note: 'L’année de la mise en location elle-même : le prêt s’amortit dans la foulée de la livraison (Q-4, Q-28).',
    },
    marge_affichee_pret: {
      libelle: 'Marge appliquée',
      unite: 'taux',
      sur: ['pret'],
      formule: 'SI(ET(EST.NOMBRE(spread_final); taux_pret = livret_a_origine_final + spread_final); spread_final; VIDE)',
      note: 'Vide sur un prêt à taux saisi, qui n’est pas indexé sur le Livret A.',
    },
    cle_marge_pret: {
      libelle: 'Clé de la grille tarifaire',
      unite: 'texte',
      sur: ['pret'],
      formule: "DEFAUT(carac_final[champ: 'cle_marge']; VIDE)",
    },
    taux_applique_pret: {
      libelle: 'Taux appliqué',
      unite: 'taux',
      regle: 'R-AMT-7',
      sur: ['pret'],
      formule:
        'SI(NON(RENSEIGNE(taux_pret)); VIDE; SI(NON(RENSEIGNE(taux_plancher_pret)); taux_pret; MAX(taux_pret; taux_plancher_pret)))',
      note: 'Le taux nominal peut être négatif sur un prêt indexé sous le Livret A ; le prêt paie le taux plancher.',
    },

    // --- Totaux et equilibre (R-FIN-1/5) -------------------------------------------
    total_prets: {
      libelle: 'Prêts du plan de financement',
      unite: 'eur',
      regle: 'R-FIN-1',
      formule: 'ARRONDI.EURO(SOMME(montant_pret POUR pret QUAND montant_pret > 0))',
    },
    toutes_tranches_cdc: {
      libelle: 'Toutes les tranches relèvent des fonds d’épargne',
      unite: 'booleen',
      formule: 'NON(UN(NON(finance_par_cdc) POUR tranche))',
    },
    total_prets_cdc: {
      libelle: 'Prêts CDC',
      unite: 'eur',
      regle: 'R-FIN-5',
      formule:
        'SI(ET(cdc_theoriques_actifs; toutes_tranches_cdc); cdc_total; ' +
        "ARRONDI.EURO(SOMME(montant_pret POUR pret QUAND ET(montant_pret > 0; DEFAUT(nature_pret_final; 'autre') <> 'autre'; " +
        'finance_par_cdc_code[code: produit_pret]))))',
      note: 'Ni un prêt collecteur, ni le prêt bancaire d’une tranche libre ne sont des prêts de la Caisse des Dépôts.',
    },
    prix_revient_cdc_brut: {
      libelle: 'Prix de revient des tranches financées sur fonds d’épargne',
      unite: 'eur',
      regle: 'R-FIN-5',
      formule: 'ARRONDI.EURO(SOMME(total_ttc_module_tranche POUR tranche QUAND finance_par_cdc))',
    },
    prix_revient_cdc: {
      libelle: 'Assiette CDC retenue',
      unite: 'eur',
      formule: 'SI(prix_revient_cdc_brut > 0; prix_revient_cdc_brut; INDEFINI)',
    },
    ressources_plan: {
      libelle: 'Ressources du plan de financement',
      unite: 'eur',
      regle: 'R-FIN-1',
      formule: 'subventions_total + fonds_propres_total + total_prets',
    },
    ressources_plan_arrondies: {
      libelle: 'Ressources du plan de financement, arrondies',
      unite: 'eur',
      formule: 'ARRONDI.EURO(ressources_plan)',
    },
    emplois_plan: {
      libelle: 'Emplois du plan de financement',
      unite: 'eur',
      regle: 'R-FIN-1',
      formule: 'ARRONDI.EURO(total_ttc_module)',
    },
    ecart_plan: {
      libelle: 'Écart du plan de financement',
      unite: 'eur',
      regle: 'R-FIN-1',
      formule: 'ARRONDI.EURO(ressources_plan - total_ttc_module)',
      note: 'Positif : surfinancement. Négatif : sous-financement. Il est signalé, jamais absorbé.',
    },
    plan_equilibre: {
      libelle: 'Plan équilibré',
      unite: 'booleen',
      formule: 'ecart_plan = 0',
    },
    assiette_ratio_cdc: {
      libelle: 'Assiette du ratio CDC',
      unite: 'eur',
      regle: 'R-FIN-5',
      formule: 'SI(EST.NOMBRE(prix_revient_cdc); prix_revient_cdc; total_ttc_module)',
    },
    ratio_prets_cdc: {
      libelle: 'Ratio prêts CDC sur prix de revient',
      unite: 'taux',
      regle: 'R-FIN-5',
      formule: 'SI(assiette_ratio_cdc > 0; total_prets_cdc / assiette_ratio_cdc; VIDE)',
    },
    ratio_prets_cdc_min: {
      libelle: 'Ratio minimal de prêts CDC',
      unite: 'taux',
      regle: 'R-FIN-5',
      parametre: 'constantes_reglementaires.controle_ratio_prets_cdc_min.valeur',
      ecran: 'Paramètres > Constantes réglementaires',
    },
    ratio_cdc_insuffisant: {
      libelle: 'Ratio CDC sous le minimum',
      unite: 'booleen',
      regle: 'R-FIN-5',
      formule: 'ET(total_prets_cdc > 0; ratio_prets_cdc < ratio_prets_cdc_min)',
    },
    total_prets_tranche: {
      libelle: 'Prêts de la tranche',
      unite: 'eur',
      sur: ['tranche'],
      formule: 'ARRONDI.EURO(SOMME(NOMBRE(montant_pret) POUR pret QUAND produit_pret = tranche))',
    },
    ressources_tranche: {
      libelle: 'Ressources de la tranche',
      unite: 'eur',
      sur: ['tranche'],
      formule:
        'ARRONDI.EURO(subventions_ventilees_tranche_arrondies + fonds_propres_tranche_arrondi + total_prets_tranche)',
    },
    ecart_tranche: {
      libelle: 'Écart du plan de la tranche',
      unite: 'eur',
      sur: ['tranche'],
      formule: 'ARRONDI.EURO(ressources_tranche - total_ttc_module_tranche)',
    },

    // --- R-FIN-9 : plafond des prets LLI --------------------------------------------
    tranche_lli_presente: {
      libelle: 'Le programme porte une tranche LLI',
      unite: 'booleen',
      formule: "CONTIENT(tranches_ordre_saisie; 'LOC')",
    },
    total_prets_lli: {
      libelle: 'Prêts de la tranche LLI',
      unite: 'eur',
      regle: 'R-FIN-9',
      formule: "SOMME(NOMBRE(montant_pret) POUR pret QUAND produit_pret = 'LOC')",
    },
    pr_lli: {
      libelle: 'Prix de revient de la tranche LLI',
      unite: 'eur',
      formule: "DEFAUT(total_ttc_module_tranche[tranche: 'LOC']; 0)",
    },
    plafond_lli: {
      libelle: 'Part maximale des prêts LLI',
      unite: 'taux',
      regle: 'R-FIN-9',
      constante: 0.9,
      note: 'Calculette CDC, contrôle AT32 : le solde vient en fonds propres ou en subventions.',
    },
    plafond_prets_lli_eur: {
      libelle: 'Plafond des prêts LLI',
      unite: 'eur',
      regle: 'R-FIN-9',
      formule: 'SI(pr_lli > 0; ARRONDI.EURO(pr_lli * plafond_lli); 0)',
    },
    depassement_prets_lli: {
      libelle: 'Dépassement du plafond LLI',
      unite: 'eur',
      regle: 'R-FIN-9',
      formule: 'SI(pr_lli > 0; ARRONDI.EURO(MAX(0; total_prets_lli - pr_lli * plafond_lli)); 0)',
    },
    part_prets_lli: {
      libelle: 'Part des prêts LLI dans le prix de revient',
      unite: 'taux',
      regle: 'R-FIN-9',
      formule: 'SI(pr_lli > 0; total_prets_lli / pr_lli; VIDE)',
    },
  },
};
