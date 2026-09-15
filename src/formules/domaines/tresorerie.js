// @ts-check
/**
 * DOMAINE « TRESORERIE » - R-TRESO : la tresorerie de la phase chantier, du
 * premier ordre de service a la livraison, mois par mois.
 *
 * Deux indexations se suivent (classeur « Indexeur cout travaux », metier,
 * 11/08/2026) : le cout est revise de sa date de valeur a l'ordre de service,
 * puis chaque somme due est indexee de SA propre duree, du demarrage a son
 * echeance - « seules les sommes dues sont indexees ». La base est 365,25 jours
 * et la premiere echeance tombe un mois apres l'ordre de service.
 *
 * En VEFA, les depenses suivent le bareme legal des appels de fonds
 * (R-TRESO-3) ; ailleurs, le cout se repartit a parts egales. Subventions et
 * fonds propres arrivent a l'ordre de service ; les prets comblent le manque,
 * tires en une fois au premier mois ou au fil de l'eau (R-TRESO-4).
 */

/** @type {import('../classeur.js').Domaine} */
export const TRESORERIE = {
  domaine: 'tresorerie',
  titre: 'Trésorerie du chantier',
  dimensions: {
    mois_chantier: { libelle: 'Mois de chantier', valeurs: 'SUITE(1; nb_mois_chantier)' },
    jalon: { libelle: 'Appel de fonds', valeurs: 'INDICES(jalons_tresorerie)', etiquette: 'libelle_jalon' },
  },
  grandeurs: {
    // --- Parametres -------------------------------------------------------------
    taux_indexation_saisi: {
      libelle: 'Indexation des travaux saisie',
      unite: 'taux',
      saisie: 'tresorerie.taux_indexation',
      ecran: 'Trésorerie',
    },
    taux_indexation_bareme: {
      libelle: 'Indexation des travaux du barème',
      unite: 'taux',
      regle: 'R-TRESO-2',
      parametre: 'tresorerie.taux_indexation',
      ecran: 'Paramètres > Trésorerie',
    },
    taux_indexation_chantier: {
      libelle: 'Indexation annuelle des travaux',
      unite: 'taux',
      regle: 'R-TRESO-2',
      formule: 'DEFAUT(taux_indexation_saisi; taux_indexation_bareme; 0)',
    },
    mode_tirage_saisi: {
      libelle: 'Mode de tirage saisi',
      unite: 'texte',
      saisie: 'tresorerie.mode_tirage',
      ecran: 'Trésorerie',
    },
    mode_tirage_bareme: {
      libelle: 'Mode de tirage du barème',
      unite: 'texte',
      regle: 'R-TRESO-4',
      parametre: 'tresorerie.mode_tirage',
      ecran: 'Paramètres > Trésorerie',
    },
    mode_tirage: {
      libelle: 'Mode de tirage des prêts',
      unite: 'texte',
      regle: 'R-TRESO-4',
      formule: "DEFAUT(mode_tirage_saisi; mode_tirage_bareme; 'integral')",
      note: 'Intégral : tout le prêt au premier mois. Au fil de l’eau : à hauteur du manque de chaque mois.',
    },
    jalons_saisis: {
      libelle: 'Appels de fonds saisis',
      unite: 'liste',
      saisie: 'tresorerie.jalons',
      ecran: 'Trésorerie',
    },
    jalons_bareme: {
      libelle: 'Barème légal des appels de fonds en VEFA',
      unite: 'liste',
      regle: 'R-TRESO-3',
      parametre: 'tresorerie.jalons_vefa.jalons',
      ecran: 'Paramètres > Trésorerie',
    },
    date_valeur_cout_saisie: {
      libelle: 'Date de valeur du coût saisie',
      unite: 'date',
      saisie: 'dates.date_valeur_cout',
      ecran: 'Opération > Calendrier',
    },
    date_valeur_cout_tresorerie: {
      libelle: 'Date de valeur du coût, écran de trésorerie',
      unite: 'date',
      saisie: 'tresorerie.date_valeur_cout',
      ecran: 'Trésorerie',
    },
    date_valeur_cout: {
      libelle: 'Date de valeur du coût',
      unite: 'date',
      formule: 'DEFAUT(date_valeur_cout_saisie; date_valeur_cout_tresorerie)',
      note: 'Sans date de valeur, le coût est réputé exprimé au démarrage.',
    },
    jours_indexation: { libelle: 'Base de jours de l’indexation', unite: 'nombre', constante: 365.25 },
    tirer_les_prets: {
      libelle: 'Les prêts comblent le manque',
      unite: 'booleen',
      constante: true,
    },
    tresorerie_calculee: {
      libelle: 'Trésorerie du chantier calculée',
      unite: 'booleen',
      formule: 'ET(date_debut_travaux_saisie; duree_chantier_retenue > 0)',
    },
    cout_chantier: {
      libelle: 'Coût du chantier',
      unite: 'eur',
      formule: 'total_ttc_module',
      note: 'Le prix de revient TTC de l’opération.',
    },
    subventions_chantier: {
      libelle: 'Subventions mobilisées au démarrage',
      unite: 'eur',
      formule: 'subventions_total',
      note: 'Mobilisables dès l’ordre de service (arbitrage métier du 11/08/2026).',
    },
    fonds_propres_chantier: {
      libelle: 'Fonds propres mobilisés au démarrage',
      unite: 'eur',
      formule: 'fonds_propres_total',
    },
    jalons_tresorerie: {
      libelle: 'Appels de fonds retenus',
      unite: 'liste',
      regle: 'R-TRESO-3',
      formule: "SI(MAJUSCULE(type_operation) = 'VEFA'; DEFAUT(jalons_saisis; jalons_bareme; VIDE); VIDE)",
      note: 'Le barème d’appels de fonds ne vaut qu’en VEFA : en maîtrise d’ouvrage directe, les factures se paient au fil du chantier.',
    },
    jalons_utilises: {
      libelle: 'Dépenses aux appels de fonds',
      unite: 'booleen',
      formule: 'LONGUEUR(jalons_tresorerie) > 0',
    },
    nb_mois_chantier: {
      libelle: 'Mois de chantier',
      unite: 'nombre',
      formule: 'MAX(1; ENTIER.PROCHE(NOMBRE(duree_chantier_retenue)))',
    },

    // --- R-TRESO-2 : revision et indexation du cout -------------------------------------
    revision_annees: {
      libelle: 'Années de révision jusqu’au démarrage',
      unite: 'an',
      regle: 'R-TRESO-2',
      formule:
        'SI(date_valeur_cout; -((JOURS(date_valeur_cout) - JOURS(date_debut_travaux_saisie)) / jours_indexation); 0)',
    },
    cout_revise: {
      libelle: 'Coût révisé au démarrage',
      unite: 'eur',
      regle: 'R-TRESO-2',
      formule: 'cout_chantier * (1 + taux_indexation_chantier) ^ revision_annees',
    },
    libelle_jalon: {
      libelle: 'Appel de fonds',
      unite: 'texte',
      sur: ['jalon'],
      formule: "DEFAUT(CHAMP(ELEMENT(jalons_tresorerie; jalon); 'libelle'); CHAMP(ELEMENT(jalons_tresorerie; jalon); 'id'))",
    },
    part_jalon: {
      libelle: 'Part du prix appelée',
      unite: 'taux',
      regle: 'R-TRESO-3',
      sur: ['jalon'],
      formule: "DEFAUT(CHAMP(ELEMENT(jalons_tresorerie; jalon); 'part'); 0)",
    },
    rang_brut_jalon: {
      libelle: 'Mois de l’appel, avant bornage',
      unite: 'nombre',
      sur: ['jalon'],
      formule: "ENTIER.SUP(DEFAUT(CHAMP(ELEMENT(jalons_tresorerie; jalon); 'avancement'); 0) * nb_mois_chantier)",
    },
    rang_jalon: {
      libelle: 'Mois de l’appel de fonds',
      unite: 'nombre',
      regle: 'R-TRESO-3',
      sur: ['jalon'],
      formule: 'MIN(nb_mois_chantier; MAX(1; SI(rang_brut_jalon; rang_brut_jalon; 1)))',
      note: 'Il n’y a pas de mois zéro : un appel à l’ordre de service tombe le premier mois. Ceux qui suivent la livraison y sont ramenés.',
    },
    date_echeance: {
      libelle: 'Échéance du mois',
      unite: 'date',
      sur: ['mois_chantier'],
      formule: 'AJOUTER.MOIS(date_debut_travaux_saisie; mois_chantier)',
    },
    nominal_mois: {
      libelle: 'Dépense du mois avant indexation',
      unite: 'eur',
      sur: ['mois_chantier'],
      formule:
        'SI(jalons_utilises; SOMME(cout_revise * part_jalon POUR jalon QUAND rang_jalon = mois_chantier); ' +
        'cout_revise / nb_mois_chantier)',
    },
    coefficient_mois: {
      libelle: 'Coefficient d’indexation du mois',
      unite: 'coef',
      regle: 'R-TRESO-2',
      sur: ['mois_chantier'],
      formule:
        '(1 + taux_indexation_chantier) ^ ((JOURS(date_echeance) - JOURS(date_debut_travaux_saisie)) / jours_indexation)',
      note: 'Chaque somme due est indexée de sa propre durée, du démarrage à son échéance.',
    },
    depense_indexee: {
      libelle: 'Dépense indexée du mois',
      unite: 'eur',
      sur: ['mois_chantier'],
      formule: 'nominal_mois * coefficient_mois',
    },
    depense_mois: {
      libelle: 'Dépense du mois',
      unite: 'eur',
      regle: 'R-TRESO-2',
      sur: ['mois_chantier'],
      formule: 'REPARTIR(depense_indexee POUR mois_chantier)',
      note: 'Arrondie en conservant la somme : l’échéancier totalise son propre total.',
    },

    // --- Financement mois par mois ---------------------------------------------------------
    total_depenses_chantier: {
      libelle: 'Dépenses du chantier',
      unite: 'eur',
      formule: 'SOMME(depense_mois POUR mois_chantier)',
    },
    a_emprunter: {
      libelle: 'Montant à emprunter',
      unite: 'eur',
      regle: 'R-TRESO-4',
      formule: 'MAX(0; total_depenses_chantier - subventions_chantier - fonds_propres_chantier)',
    },
    tirage_integral: {
      libelle: 'Tirage intégral',
      unite: 'eur',
      regle: 'R-TRESO-4',
      sur: ['mois_chantier'],
      formule: "SI(ET(tirer_les_prets; mode_tirage = 'integral'; mois_chantier = 1; a_emprunter > 0); a_emprunter; 0)",
      note: 'Le prêt est en caisse avant la première facture.',
    },
    solde_brut: {
      libelle: 'Trésorerie avant tirage au fil de l’eau',
      unite: 'eur',
      sur: ['mois_chantier'],
      formule:
        'DEFAUT(solde_chantier[mois_chantier: mois_chantier - 1]; subventions_chantier + fonds_propres_chantier) + ' +
        'tirage_integral - depense_mois',
    },
    tirage_fil: {
      libelle: 'Tirage au fil de l’eau',
      unite: 'eur',
      regle: 'R-TRESO-4',
      sur: ['mois_chantier'],
      formule: "SI(ET(tirer_les_prets; mode_tirage <> 'integral'; solde_brut < 0); -solde_brut; 0)",
      note: 'Comble le manque du mois, jamais plus.',
    },
    solde_chantier: {
      libelle: 'Trésorerie en fin de mois',
      unite: 'eur',
      sur: ['mois_chantier'],
      formule: 'SI(tirage_fil > 0; 0; solde_brut)',
    },
    tirage_mois: {
      libelle: 'Tirage du mois',
      unite: 'eur',
      sur: ['mois_chantier'],
      formule: 'tirage_integral + tirage_fil',
    },
    cumul_depenses_chantier: {
      libelle: 'Dépenses cumulées',
      unite: 'eur',
      sur: ['mois_chantier'],
      formule: 'DEFAUT(cumul_depenses_chantier[mois_chantier: mois_chantier - 1]; 0) + depense_mois',
    },
    cumul_tirages: {
      libelle: 'Tirages cumulés',
      unite: 'eur',
      sur: ['mois_chantier'],
      formule: 'DEFAUT(cumul_tirages[mois_chantier: mois_chantier - 1]; 0) + tirage_mois',
    },
    besoin_mois: {
      libelle: 'Besoin cumulé hors prêts',
      unite: 'eur',
      sur: ['mois_chantier'],
      formule: 'cumul_depenses_chantier - subventions_chantier - fonds_propres_chantier',
    },
    encaissement_subventions: {
      libelle: 'Subventions encaissées',
      unite: 'eur',
      sur: ['mois_chantier'],
      formule: 'SI(mois_chantier = 1; subventions_chantier; 0)',
    },
    encaissement_fonds_propres: {
      libelle: 'Fonds propres apportés',
      unite: 'eur',
      sur: ['mois_chantier'],
      formule: 'SI(mois_chantier = 1; fonds_propres_chantier; 0)',
    },

    // --- Indicateurs ------------------------------------------------------------------
    revision_au_demarrage: {
      libelle: 'Révision au démarrage',
      unite: 'eur',
      formule: 'cout_revise - cout_chantier',
    },
    echeance_nominale: {
      libelle: 'Échéance nominale',
      unite: 'eur',
      formule: 'SI(jalons_utilises; VIDE; cout_revise / nb_mois_chantier)',
      note: 'Sans objet sous barème d’appels de fonds : aucun mois réel ne la porte.',
    },
    total_depenses_final: {
      libelle: 'Total des dépenses',
      unite: 'eur',
      formule: 'DERNIER(cumul_depenses_chantier POUR mois_chantier)',
    },
    surcout_indexation: {
      libelle: 'Surcoût de l’indexation',
      unite: 'eur',
      regle: 'R-TRESO-2',
      formule: 'total_depenses_final - cout_chantier',
      note: 'Révision de départ comprise.',
    },
    total_tirages: {
      libelle: 'Total des tirages',
      unite: 'eur',
      formule: 'DERNIER(cumul_tirages POUR mois_chantier)',
    },
    besoin_pic: {
      libelle: 'Point haut du besoin',
      unite: 'eur',
      formule: 'MAX(ARRONDI.EURO(besoin_mois) POUR mois_chantier)',
    },
    mois_pic: {
      libelle: 'Mois du point haut',
      unite: 'nombre',
      formule: 'PREMIER(mois_chantier POUR mois_chantier QUAND ARRONDI.EURO(besoin_mois) = besoin_pic)',
    },
    besoin_maximal: {
      libelle: 'Besoin de préfinancement',
      unite: 'eur',
      regle: 'R-TRESO',
      formule: 'MAX(0; besoin_pic)',
    },
    tresorerie_maximale: {
      libelle: 'Trésorerie maximale en caisse',
      unite: 'eur',
      regle: 'R-TRESO-4',
      formule: 'MAX(0; MAX(ARRONDI.EURO(solde_chantier) POUR mois_chantier))',
      note: 'Ce que le tirage intégral laisse dormir en caisse, sur quoi courent des intérêts intercalaires.',
    },
  },
};
