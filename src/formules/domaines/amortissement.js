// @ts-check
/**
 * DOMAINE « AMORTISSEMENT » - R-AMT-2 a R-AMT-9 : le tableau d'amortissement
 * de chaque pret, annee par annee.
 *
 * Transcription des formules vivantes de la matrice LEON (SimPLUS!FF117:FN117,
 * SimPLUS!AM15 pour le facteur d'annuite, SimLIB!FG8/FH8 pour le taux fixe).
 *
 * Chaque annee, le taux et la progression sont REVISES selon le Livret A de
 * l'annee et la revisabilite du pret, puis l'annuite est RECALCULEE par la
 * forme fermee sur le capital restant du et la duree restante (R-AMT-4, le
 * re-amortissement annuel). La derniere echeance n'est pas un cas particulier :
 * a la derniere annee il reste une echeance, le facteur vaut (1 + taux) et
 * l'annuite solde exactement le capital.
 *
 * Aucun arrondi dans le tableau : les montants restent exacts, seul le test
 * d'arret (« capital deja solde ») arrondit a 4 decimales, comme LEON.
 *
 * Les prets a echeances INFRA-ANNUELLES (R-AMT-8, les prets Action Logement,
 * trimestriels) s'amortissent periode par periode, au taux proportionnel,
 * puis s'agregent par annee civile : le compte d'exploitation reste annuel.
 */

/** Libelles de revisabilite rencontres dans LEON, et leur forme canonique. */
export const REVISABILITES = /** @type {Record<string, string>} */ ({
  DOUBLE: 'DOUBLE',
  'D.LIMITEE': 'D.LIMITEE',
  'D. LIMITEE': 'D.LIMITEE',
  'D.LIMITÉE': 'D.LIMITEE',
  'D. LIMITÉE': 'D.LIMITEE',
  SIMPLE: 'SIMPLE',
  'TAUX FIXE': 'TAUX FIXE',
  FIXE: 'TAUX FIXE',
});

/** @type {import('../classeur.js').Domaine} */
export const AMORTISSEMENT = {
  domaine: 'amortissement',
  titre: 'Tableaux d’amortissement',
  dimensions: {
    annee_pret: {
      libelle: 'Année d’échéance',
      sur: ['pret'],
      valeurs:
        'SI(montant_pret = 0; SUITE(1; 0); SI(controle_tableau_pret; ' +
        'SUITE(annee_premiere_echeance_pret; annee_premiere_echeance_pret + duree_ans_pret - 1); SUITE(1; 0)))',
    },
    periode_pret: {
      libelle: 'Échéance infra-annuelle',
      sur: ['pret'],
      valeurs: 'SUITE(0; duree_ans_pret * periodicite_pret - 1)',
    },
  },
  grandeurs: {
    // --- Parametres du tableau ------------------------------------------------------
    table_revisabilites: {
      libelle: 'Libellés de révisabilité reconnus',
      unite: 'liste',
      constante: REVISABILITES,
    },
    revisabilite_canonique: {
      libelle: 'Révisabilité du prêt',
      unite: 'texte',
      regle: 'R-AMT-4',
      sur: ['pret'],
      formule:
        "DEFAUT(CHAMP(table_revisabilites; MAJUSCULE(SUPPRESPACE(revisabilite_pret))); ERREUR('Revisabilite inconnue : '; revisabilite_pret))",
    },
    differe_periodes_pret: {
      libelle: 'Différé, en échéances',
      unite: 'nombre',
      regle: 'R-AMT-9',
      sur: ['pret'],
      formule:
        'SI(RENSEIGNE(differe_mois_pret); ENTIER.PROCHE(NOMBRE.BRUT(differe_mois_pret) * periodicite_pret / mois_par_an); ' +
        'differe_ans_pret * periodicite_pret)',
      note: 'Le différé se saisit en mois, l’unité du chantier, et se convertit en échéances entières.',
    },
    differe_annees_pret: {
      libelle: 'Différé, en années',
      unite: 'an',
      regle: 'R-AMT-9',
      sur: ['pret'],
      formule:
        'SI(RENSEIGNE(differe_mois_pret); ENTIER.PROCHE(NOMBRE.BRUT(differe_mois_pret) / mois_par_an); differe_ans_pret)',
    },
    differe_controle_pret: {
      libelle: 'Différé rapporté à l’année',
      unite: 'an',
      sur: ['pret'],
      formule: 'differe_periodes_pret / periodicite_pret',
    },
    controle_tableau_pret: {
      libelle: 'Prêt amortissable',
      unite: 'texte',
      sur: ['pret'],
      formule:
        "SI(NON(montant_pret > 0); ERREUR('Montant de pret invalide : '; montant_pret); " +
        "SI(NON(ET(EST.ENTIER(duree_ans_pret); duree_ans_pret > 0)); ERREUR('Duree de pret invalide : '; duree_ans_pret); " +
        "SI(NON(EST.ENTIER(annee_premiere_echeance_pret)); ERREUR('Annee de premiere echeance invalide : '; annee_premiere_echeance_pret); " +
        'SI(OU(differe_controle_pret < 0; differe_controle_pret >= duree_ans_pret); ' +
        "ERREUR('Differe invalide : '; differe_controle_pret; ' an(s) pour un pret de '; duree_ans_pret; ' an(s)'); " +
        'SI(ET(differe_controle_pret > 0; differe_type_pret <> 1; differe_type_pret <> 2); ' +
        "ERREUR('Type de differe invalide : '; differe_type_pret; ' (attendu 1 ou 2)'); revisabilite_canonique)))))",
      note: 'Un prêt qui ne se laisse pas amortir arrête le calcul, avec la raison.',
    },
    la0_pret: {
      libelle: 'Livret A à l’origine du prêt',
      unite: 'taux',
      regle: 'R-AMT-4',
      sur: ['pret'],
      formule: 'DEFAUT(livret_a_origine_final; 0)',
    },
    periodique_pret: {
      libelle: 'Échéances infra-annuelles',
      unite: 'booleen',
      regle: 'R-AMT-8',
      sur: ['pret'],
      formule: 'periodicite_pret > 1',
    },

    // --- Revision annuelle du taux et de la progression (R-AMT-4, R-AMT-7) ---------
    rang_annee_pret: {
      libelle: 'Rang de l’année dans le prêt',
      unite: 'nombre',
      sur: ['pret', 'annee_pret'],
      formule: 'annee_pret - annee_premiere_echeance_pret',
    },
    la_annee_pret: {
      libelle: 'Livret A de l’année',
      unite: 'taux',
      regle: 'R-AMT-4',
      sur: ['pret', 'annee_pret'],
      formule: 'RECHERCHE.ANNEE(livret_a_par_annee_final; annee_pret; la0_pret)',
    },
    ecart_la_pret: {
      libelle: 'Écart de Livret A, rapporté au taux',
      unite: 'taux',
      regle: 'R-AMT-4',
      sur: ['pret', 'annee_pret'],
      formule: '(la_annee_pret - la0_pret) / (1 + taux_pret)',
    },
    taux_brut_annee: {
      libelle: 'Taux révisé de l’année',
      unite: 'taux',
      regle: 'R-AMT-4',
      sur: ['pret', 'annee_pret'],
      formule: "SI(revisabilite_canonique = 'TAUX FIXE'; taux_pret; (1 + taux_pret) * (1 + ecart_la_pret) - 1)",
    },
    taux_annee: {
      libelle: 'Taux de l’année',
      unite: 'taux',
      regle: 'R-AMT-7',
      sur: ['pret', 'annee_pret'],
      formule: 'SI(DEFINI(taux_plancher_pret); MAX(taux_brut_annee; taux_plancher_pret); taux_brut_annee)',
      note: 'Un prêt indexé sous le Livret A ne descend pas sous son taux plancher.',
    },
    rev_brute_annee: {
      libelle: 'Progression révisée de l’année',
      unite: 'taux',
      regle: 'R-AMT-4',
      sur: ['pret', 'annee_pret'],
      formule: '(1 + progressivite_pret) * (1 + ecart_la_pret) - 1',
    },
    rev_annee: {
      libelle: 'Progression de l’année',
      unite: 'taux',
      regle: 'R-AMT-4',
      sur: ['pret', 'annee_pret'],
      formule:
        "SI(revisabilite_canonique = 'DOUBLE'; rev_brute_annee; SI(revisabilite_canonique = 'D.LIMITEE'; MAX(rev_brute_annee; 0); progressivite_pret))",
      note: 'Double révisabilité : la progression suit le Livret A. Limitée : jamais sous zéro. Sinon elle reste celle du contrat.',
    },

    // --- Echeances annuelles (R-AMT-2/4/6/9) -----------------------------------------
    crd_debut: {
      libelle: 'Capital restant dû en début d’année',
      unite: 'eur',
      regle: 'R-AMT-5',
      sur: ['pret', 'annee_pret'],
      formule: 'SI(rang_annee_pret = 0; montant_pret; crd_fin[annee_pret: annee_pret - 1])',
    },
    en_differe: {
      libelle: 'Année de différé',
      unite: 'booleen',
      regle: 'R-AMT-9',
      sur: ['pret', 'annee_pret'],
      formule: 'rang_annee_pret < differe_annees_pret',
    },
    interets_differe: {
      libelle: 'Intérêts dus pendant le différé',
      unite: 'eur',
      regle: 'R-AMT-9',
      sur: ['pret', 'annee_pret'],
      formule: 'SI(differe_type_pret = 1; 0; taux_annee * crd_debut)',
      note: 'Type 1 : rien n’est dû pendant le différé. Type 2 : les intérêts seuls.',
    },
    solde_atteint: {
      libelle: 'Capital déjà soldé',
      unite: 'booleen',
      sur: ['pret', 'annee_pret'],
      formule: 'ARRONDI(crd_debut; 4) <= 0',
    },
    echeances_restantes: {
      libelle: 'Échéances restantes',
      unite: 'nombre',
      regle: 'R-AMT-4',
      sur: ['pret', 'annee_pret'],
      formule: 'duree_ans_pret - rang_annee_pret',
    },
    q_annuite: {
      libelle: 'Rapport de progression',
      unite: 'coef',
      regle: 'R-AMT-2',
      sur: ['pret', 'annee_pret'],
      formule: '(1 + rev_annee) / (1 + taux_annee)',
    },
    facteur_annuite: {
      libelle: 'Facteur d’annuité',
      unite: 'coef',
      regle: 'R-AMT-2',
      sur: ['pret', 'annee_pret'],
      formule:
        "SI(NON(echeances_restantes > 0); ERREUR('Nombre d''echeances invalide : '; echeances_restantes); " +
        'SI(q_annuite = 1; (1 + taux_annee) / echeances_restantes; ' +
        '(1 + taux_annee) * (1 - q_annuite) / (1 - q_annuite ^ echeances_restantes)))',
      note: 'Multiplié par le capital restant dû, il donne l’annuité qui l’amortit exactement sur la durée restante (SimPLUS!AM15).',
    },
    annuite_lineaire: {
      libelle: 'Amortissement linéaire',
      unite: 'booleen',
      regle: 'R-AMT-2',
      sur: ['pret', 'annee_pret'],
      formule: 'OU(ET(taux_pret = 0; progressivite_pret = 0); ET(rev_annee = 0; taux_annee = 0))',
      note: 'Taux et progression nuls : le capital d’origine se rembourse par parts égales.',
    },
    amortissement_constant: {
      libelle: 'Capital remboursé, profil constant',
      unite: 'eur',
      regle: 'R-AMT-6',
      sur: ['pret', 'annee_pret'],
      formule: 'SI(solde_atteint; 0; montant_pret / (duree_ans_pret - differe_annees_pret))',
    },
    interets_annuels: {
      libelle: 'Intérêts de l’année',
      unite: 'eur',
      regle: 'R-AMT-5',
      sur: ['pret', 'annee_pret'],
      formule:
        "SI(en_differe; interets_differe; SI(ET(profil_pret = 'constant'; solde_atteint); 0; taux_annee * crd_debut))",
    },
    annuite_annuelle: {
      libelle: 'Annuité de l’année',
      unite: 'eur',
      regle: 'R-AMT-4',
      sur: ['pret', 'annee_pret'],
      formule:
        "SI(en_differe; interets_differe; SI(profil_pret = 'constant'; amortissement_constant + interets_annuels; " +
        'SI(solde_atteint; 0; SI(annuite_lineaire; montant_pret / (duree_ans_pret - differe_annees_pret); ' +
        'crd_debut * facteur_annuite))))',
    },
    amortissement_annuel: {
      libelle: 'Capital remboursé dans l’année',
      unite: 'eur',
      regle: 'R-AMT-5',
      sur: ['pret', 'annee_pret'],
      formule:
        "SI(en_differe; 0; SI(profil_pret = 'constant'; amortissement_constant; annuite_annuelle - interets_annuels))",
    },
    crd_fin: {
      libelle: 'Capital restant dû en fin d’année',
      unite: 'eur',
      regle: 'R-AMT-5',
      sur: ['pret', 'annee_pret'],
      formule: 'crd_debut - amortissement_annuel',
    },

    // --- Echeances infra-annuelles (R-AMT-8) ----------------------------------------
    periodes_amortissantes: {
      libelle: 'Échéances amortissantes',
      unite: 'nombre',
      regle: 'R-AMT-8',
      sur: ['pret'],
      formule: 'duree_ans_pret * periodicite_pret - differe_periodes_pret',
    },
    annee_periode: {
      libelle: 'Année de l’échéance',
      unite: 'annee',
      sur: ['pret', 'periode_pret'],
      formule: 'annee_premiere_echeance_pret + ENT(periode_pret / periodicite_pret)',
    },
    taux_periode: {
      libelle: 'Taux de l’échéance',
      unite: 'taux',
      regle: 'R-AMT-8',
      sur: ['pret', 'periode_pret'],
      formule: 'taux_annee[annee_pret: annee_periode] / periodicite_pret',
      note: 'Taux proportionnel : le taux annuel divisé par le nombre d’échéances, révisé une fois par an.',
    },
    rev_periode: {
      libelle: 'Progression de l’échéance',
      unite: 'taux',
      regle: 'R-AMT-8',
      sur: ['pret', 'periode_pret'],
      formule: '(1 + rev_annee[annee_pret: annee_periode]) ^ (1 / periodicite_pret) - 1',
      note: 'La progression est annuelle : répartie sur les échéances, elle vaut sa racine.',
    },
    crd_debut_periode: {
      libelle: 'Capital restant dû avant l’échéance',
      unite: 'eur',
      sur: ['pret', 'periode_pret'],
      formule: 'SI(periode_pret = 0; montant_pret; crd_fin_periode[periode_pret: periode_pret - 1])',
    },
    periode_en_differe: {
      libelle: 'Échéance de différé',
      unite: 'booleen',
      sur: ['pret', 'periode_pret'],
      formule: 'periode_pret < differe_periodes_pret',
    },
    periode_soldee: {
      libelle: 'Capital déjà soldé',
      unite: 'booleen',
      sur: ['pret', 'periode_pret'],
      formule: 'ARRONDI(crd_debut_periode; 4) <= 0',
    },
    periodes_restantes: {
      libelle: 'Échéances restantes',
      unite: 'nombre',
      sur: ['pret', 'periode_pret'],
      formule: 'periodes_amortissantes - (periode_pret - differe_periodes_pret)',
    },
    q_periode: {
      libelle: 'Rapport de progression de l’échéance',
      unite: 'coef',
      sur: ['pret', 'periode_pret'],
      formule: '(1 + rev_periode) / (1 + taux_periode)',
    },
    facteur_periode: {
      libelle: 'Facteur d’annuité de l’échéance',
      unite: 'coef',
      regle: 'R-AMT-2',
      sur: ['pret', 'periode_pret'],
      formule:
        "SI(NON(periodes_restantes > 0); ERREUR('Nombre d''echeances invalide : '; periodes_restantes); " +
        'SI(q_periode = 1; (1 + taux_periode) / periodes_restantes; ' +
        '(1 + taux_periode) * (1 - q_periode) / (1 - q_periode ^ periodes_restantes)))',
    },
    amortissement_periode: {
      libelle: 'Capital remboursé à l’échéance',
      unite: 'eur',
      sur: ['pret', 'periode_pret'],
      formule:
        "SI(periode_en_differe; 0; SI(periode_soldee; 0; SI(profil_pret = 'constant'; montant_pret / periodes_amortissantes; " +
        'SI(ET(taux_periode = 0; rev_periode = 0); montant_pret / periodes_amortissantes; crd_debut_periode * facteur_periode) ' +
        '- taux_periode * crd_debut_periode)))',
    },
    interets_periode: {
      libelle: 'Intérêts de l’échéance',
      unite: 'eur',
      sur: ['pret', 'periode_pret'],
      formule:
        'SI(periode_en_differe; SI(differe_type_pret = 1; 0; taux_periode * crd_debut_periode); ' +
        'SI(periode_soldee; 0; taux_periode * crd_debut_periode))',
    },
    crd_fin_periode: {
      libelle: 'Capital restant dû après l’échéance',
      unite: 'eur',
      sur: ['pret', 'periode_pret'],
      formule: 'crd_debut_periode - amortissement_periode',
    },
    interets_annee_periodique: {
      libelle: 'Intérêts des échéances de l’année',
      unite: 'eur',
      regle: 'R-AMT-8',
      sur: ['pret', 'annee_pret'],
      formule:
        'SOMME(interets_periode[periode_pret: t] POUR t DANS SUITE(rang_annee_pret * periodicite_pret; ' +
        'rang_annee_pret * periodicite_pret + periodicite_pret - 1))',
    },
    amortissement_annee_periodique: {
      libelle: 'Capital remboursé par les échéances de l’année',
      unite: 'eur',
      regle: 'R-AMT-8',
      sur: ['pret', 'annee_pret'],
      formule:
        'SOMME(amortissement_periode[periode_pret: t] POUR t DANS SUITE(rang_annee_pret * periodicite_pret; ' +
        'rang_annee_pret * periodicite_pret + periodicite_pret - 1))',
    },
    crd_annee_periodique: {
      libelle: 'Capital restant dû après la dernière échéance de l’année',
      unite: 'eur',
      sur: ['pret', 'annee_pret'],
      formule: 'crd_fin_periode[periode_pret: rang_annee_pret * periodicite_pret + periodicite_pret - 1]',
    },

    // --- La ligne du tableau -----------------------------------------------------------
    annuite_pret: {
      libelle: 'Annuité',
      unite: 'eur',
      regle: 'R-AMT-5',
      sur: ['pret', 'annee_pret'],
      formule: 'SI(periodique_pret; interets_annee_periodique + amortissement_annee_periodique; annuite_annuelle)',
    },
    interets_pret: {
      libelle: 'Intérêts',
      unite: 'eur',
      regle: 'R-AMT-5',
      sur: ['pret', 'annee_pret'],
      formule: 'SI(periodique_pret; interets_annee_periodique; interets_annuels)',
    },
    amortissement_pret: {
      libelle: 'Capital remboursé',
      unite: 'eur',
      regle: 'R-AMT-5',
      sur: ['pret', 'annee_pret'],
      formule: 'SI(periodique_pret; amortissement_annee_periodique; amortissement_annuel)',
    },
    crd_pret: {
      libelle: 'Capital restant dû',
      unite: 'eur',
      regle: 'R-AMT-5',
      sur: ['pret', 'annee_pret'],
      formule: 'SI(periodique_pret; crd_annee_periodique; crd_fin)',
    },
  },
};
