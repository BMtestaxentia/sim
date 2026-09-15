// @ts-check
/**
 * DOMAINE « CALENDRIER » : la chaine de dates derivee de la saisie.
 *
 * Seule la date de debut des travaux et la duree du chantier se saisissent
 * d'ordinaire ; la livraison et la mise en location en decoulent (maquette LEON
 * REWORK, onglet ACCUEIL). Chaque date derivee peut etre imposee par la saisie,
 * pour figer un calendrier contractuel - une VEFA par exemple.
 *
 * L'annee de mise en location commande trois choses a la fois : la premiere
 * annee du compte d'exploitation, la premiere echeance des prets et le point de
 * depart de l'exoneration de taxe fonciere.
 */

/** @type {import('../classeur.js').Domaine} */
export const CALENDRIER = {
  domaine: 'calendrier',
  titre: 'Calendrier',
  grandeurs: {
    // --- Saisies --------------------------------------------------------------
    date_debut_travaux_saisie: {
      libelle: 'Début des travaux saisi',
      unite: 'date',
      saisie: 'dates.date_debut_travaux',
      ecran: 'Opération > Calendrier',
    },
    duree_chantier_saisie: {
      libelle: 'Durée du chantier saisie',
      unite: 'mois',
      saisie: 'dates.duree_chantier_mois',
      ecran: 'Opération > Calendrier',
    },
    date_livraison_saisie: {
      libelle: 'Livraison saisie',
      unite: 'date',
      saisie: 'dates.date_livraison',
      ecran: 'Opération > Calendrier',
    },
    date_mise_en_location_saisie: {
      libelle: 'Mise en location saisie',
      unite: 'date',
      saisie: 'dates.date_mise_en_location',
      ecran: 'Opération > Calendrier',
    },
    annee_mise_en_location_saisie: {
      libelle: 'Année de mise en location saisie',
      unite: 'annee',
      saisie: 'dates.annee_mise_en_location',
      ecran: 'Opération > Calendrier',
    },
    duree_simulation_saisie: {
      libelle: 'Durée de simulation saisie',
      unite: 'an',
      saisie: 'dates.duree_simulation_ans',
      ecran: 'Opération > Calendrier',
    },
    duree_simulation_defaut: {
      libelle: 'Durée de simulation par défaut',
      unite: 'an',
      constante: 50,
    },

    // --- Dates ----------------------------------------------------------------
    date_debut_travaux: {
      libelle: 'Début des travaux',
      unite: 'date',
      formule: 'SI(date_debut_travaux_saisie; DATE(date_debut_travaux_saisie); VIDE)',
    },
    duree_chantier_mois: {
      libelle: 'Durée du chantier',
      unite: 'mois',
      formule: 'SI(EST.NOMBRE(duree_chantier_saisie); duree_chantier_saisie; VIDE)',
    },
    duree_chantier_retenue: {
      libelle: 'Durée du chantier retenue',
      unite: 'mois',
      regle: 'R-AMT-9',
      formule: 'NOMBRE(duree_chantier_saisie)',
      note: 'Sert au différé par défaut des prêts principaux et à l’échéancier de trésorerie ; une durée non saisie vaut zéro.',
    },
    date_livraison: {
      libelle: 'Livraison',
      unite: 'date',
      regle: 'R-AMT-3',
      formule:
        'SI(date_livraison_saisie; DATE(date_livraison_saisie); ' +
        'SI(ET(date_debut_travaux_saisie; EST.NOMBRE(duree_chantier_saisie)); ' +
        'AJOUTER.MOIS(date_debut_travaux_saisie; duree_chantier_saisie); VIDE))',
    },
    date_mise_en_location: {
      libelle: 'Mise en location',
      unite: 'date',
      regle: 'R-AMT-3',
      formule:
        'SI(date_mise_en_location_saisie; DATE(date_mise_en_location_saisie); ' +
        'SI(date_livraison; AJOUTER.JOURS(date_livraison; 1); VIDE))',
    },
    annee_mise_en_location: {
      libelle: 'Année de mise en location',
      unite: 'annee',
      regle: 'R-AMT-3',
      formule:
        'SI(date_mise_en_location; ANNEE(date_mise_en_location); ' +
        'SI(EST.ENTIER(annee_mise_en_location_saisie); annee_mise_en_location_saisie; ' +
        "ERREUR('Calendrier incomplet : renseigner soit annee_mise_en_location, soit une date de mise en " +
        "location, soit un debut de travaux avec une duree de chantier.')))",
    },
    duree_simulation: {
      libelle: 'Durée de simulation',
      unite: 'an',
      formule: 'DEFAUT(duree_simulation_saisie; duree_simulation_defaut)',
    },
    annee_fin_simulation: {
      libelle: 'Dernière année simulée',
      unite: 'annee',
      formule: 'annee_mise_en_location + duree_simulation - 1',
    },

    // --- Origine de chaque date, pour l'ecran ----------------------------------
    origine_date_debut_travaux: {
      libelle: 'Origine du début des travaux',
      unite: 'texte',
      formule: "SI(date_debut_travaux_saisie; 'saisie'; VIDE)",
    },
    origine_date_livraison: {
      libelle: 'Origine de la livraison',
      unite: 'texte',
      formule: "SI(date_livraison_saisie; 'saisie'; SI(RENSEIGNE(date_livraison); 'calcule'; VIDE))",
    },
    origine_date_mise_en_location: {
      libelle: 'Origine de la mise en location',
      unite: 'texte',
      formule:
        "SI(date_mise_en_location_saisie; 'saisie'; SI(RENSEIGNE(date_mise_en_location); 'calcule'; VIDE))",
    },
    origine_annee_mise_en_location: {
      libelle: 'Origine de l’année de mise en location',
      unite: 'texte',
      formule: "SI(RENSEIGNE(date_mise_en_location); 'calcule'; 'saisie')",
    },
  },
};
