// @ts-check
/**
 * DOMAINE « SYNTHESE » : les indicateurs de l'operation entiere, et les
 * montants que citent les alertes.
 *
 * Ratios de lecture du montage (prix de revient au logement et au m2,
 * rendement des loyers, part des fonds propres), base d'amortissement de la
 * grille d'analyse, et deux montants qui ne se lisent qu'en alerte : l'ecart
 * de loyers du au millesime du bareme, et les annuites d'un pret qui depassent
 * l'horizon de simulation.
 */

/** @type {import('../classeur.js').Domaine} */
export const SYNTHESE = {
  domaine: 'synthese',
  titre: 'Synthèse',
  grandeurs: {
    // --- Ratios de l'operation ----------------------------------------------------
    prix_revient_par_logement: {
      libelle: 'Prix de revient par logement',
      unite: 'eur',
      formule: 'SI(nb_logements_total > 0; ARRONDI.EURO(total_ttc_module / nb_logements_total); VIDE)',
    },
    prix_revient_par_m2_shab: {
      libelle: 'Prix de revient au m² habitable',
      unite: 'eur_m2',
      formule: 'SI(shab_totale > 0; ARRONDI.EURO(total_ttc_module / shab_totale); VIDE)',
    },
    loyers_annuels_operation: {
      libelle: 'Loyers annuels de l’opération',
      unite: 'eur',
      formule: 'ARRONDI.EURO(loyers_logements_annuels + loyers_annexes_annuels)',
      note: 'Loyers de la première année, logements et annexes.',
    },
    rmo: {
      libelle: 'Rendement des loyers (RMO)',
      unite: 'taux',
      formule: 'SI(total_ttc_module > 0; (loyers_logements_annuels + loyers_annexes_annuels) / total_ttc_module; VIDE)',
      note: 'Loyers de la première année sur le prix de revient TTC.',
    },
    taux_fonds_propres: {
      libelle: 'Part des fonds propres',
      unite: 'taux',
      formule: 'SI(total_ttc_module > 0; fonds_propres_total / total_ttc_module; VIDE)',
    },

    // --- Base d'amortissement comptable (Grille d'analyse) ------------------------------
    terrain_comptable_saisi: {
      libelle: 'Montant du terrain, grille d’analyse',
      unite: 'eur',
      saisie: 'amortissement_comptable.montant_terrain_eur',
      ecran: 'Exploitation',
    },
    quotite_terrain_comptable_saisie: {
      libelle: 'Quotité de terrain non amortissable, grille d’analyse',
      unite: 'taux',
      saisie: 'amortissement_comptable.quotite_terrain',
      ecran: 'Exploitation',
    },
    amortissement_comptable_demande: {
      libelle: 'Base d’amortissement demandée',
      unite: 'booleen',
      formule: 'DEFINI(terrain_comptable_saisi)',
    },
    valeur_comptable_terrain: {
      libelle: 'Valeur comptable du terrain',
      unite: 'eur',
      formule:
        'SI(EST.NOMBRE(quotite_terrain_comptable_saisie); ' +
        'ARRONDI.EURO(terrain_comptable_saisi * quotite_terrain_comptable_saisie); ' +
        "ERREUR('Quotite de terrain requise : elle n a pas de valeur par defaut (Q-26)'))",
      note: 'La quotité n’a pas de valeur par défaut : 25 % dans les annexes, 13 % en zone B1 au référentiel (Q-26).',
    },
    base_amortissement_comptable: {
      libelle: 'Base d’amortissement comptable',
      unite: 'eur',
      formule: 'ARRONDI.EURO(total_ttc_module - valeur_comptable_terrain)',
    },
    part_amortissable: {
      libelle: 'Part amortissable du prix de revient',
      unite: 'taux',
      formule: 'SI(total_ttc_module > 0; (total_ttc_module - valeur_comptable_terrain) / total_ttc_module; VIDE)',
    },

    // --- Montants cites par les alertes ---------------------------------------------------
    ecart_loyers_millesime: {
      libelle: 'Loyers annuels non revalorisés du millésime',
      unite: 'eur',
      regle: 'R-LOYER-9',
      formule: 'ARRONDI.EURO(SOMME(loyer_annuel_tranche POUR tranche) * (cumul_irl_millesime - 1))',
      note: 'Ce que les plafonds rapporteraient de plus s’ils étaient revalorisés jusqu’à la mise en location.',
    },
    derniere_annee_pret: {
      libelle: 'Dernière échéance du prêt',
      unite: 'annee',
      sur: ['pret'],
      formule: 'DERNIER(annee_pret POUR annee_pret)',
    },
    annuites_hors_horizon: {
      libelle: 'Annuités au-delà de l’horizon',
      unite: 'eur',
      sur: ['pret'],
      formule: 'SOMME(annuite_pret POUR annee_pret QUAND annee_pret > annee_fin_simulation)',
      note: 'Elles ne sont pas comptées au compte d’exploitation.',
    },
  },
};
