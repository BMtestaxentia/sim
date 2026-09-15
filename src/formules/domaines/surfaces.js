// @ts-check
/**
 * DOMAINE « SURFACES » - R-SURF : surface utile, agregation par tranche et cle
 * de repartition.
 *
 * La surface utile sert deux fois : a calculer le loyer plafond, et a partager
 * entre les tranches tout ce qui est commun a l'operation. Elle se garde EXACTE
 * lot par lot et ne s'arrondit qu'a la tranche, seul niveau ou R-SURF-1 le
 * prescrit : six lots de 70,005 m2 arrondis un a un donneraient 420,06 m2 au
 * lieu de 420.
 */

/** @type {import('../classeur.js').Domaine} */
export const SURFACES = {
  domaine: 'surfaces',
  titre: 'Surfaces',
  grandeurs: {
    coefficient_annexes: {
      libelle: 'Coefficient des surfaces annexes',
      unite: 'coef',
      regle: 'R-SURF-1',
      parametre: 'constantes_reglementaires.coefficient_surface_annexes.valeur',
      ecran: 'Paramètres > Constantes réglementaires',
    },
    su_exacte_lot: {
      libelle: 'Surface utile du lot, non arrondie',
      unite: 'm2',
      regle: 'R-SURF-1',
      sur: ['lot'],
      formule:
        'SI(RENSEIGNE(su_forcee_lot); su_forcee_lot; shab_lot + coefficient_annexes * SI.ABSENT(annexes_lot; 0))',
    },
    su_lot: {
      libelle: 'Surface utile du lot',
      unite: 'm2',
      regle: 'R-SURF-1',
      sur: ['lot'],
      formule: 'ARRONDI(su_exacte_lot; 2)',
    },
    nb_logements_tranche: {
      libelle: 'Logements de la tranche',
      unite: 'nombre',
      sur: ['tranche'],
      formule: 'SOMME(DEFAUT(nb_logements_lot; 0) POUR lot QUAND code_produit_lot = tranche)',
    },
    su_tranche: {
      libelle: 'Surface utile de la tranche',
      unite: 'm2',
      regle: 'R-SURF-1',
      sur: ['tranche'],
      formule: 'ARRONDI(SOMME(DEFAUT(su_exacte_lot; su_lot; 0) POUR lot QUAND code_produit_lot = tranche); 2)',
      note: 'Somme des surfaces EXACTES des lots, arrondie une seule fois, à la tranche.',
    },
    shab_tranche: {
      libelle: 'Surface habitable de la tranche',
      unite: 'm2',
      sur: ['tranche'],
      formule: 'SOMME(DEFAUT(shab_lot; 0) POUR lot QUAND code_produit_lot = tranche)',
    },
    shab_tranche_arrondie: {
      libelle: 'Surface habitable de la tranche, arrondie',
      unite: 'm2',
      sur: ['tranche'],
      formule: 'ARRONDI(shab_tranche; 2)',
    },
    nb_lots_tranche: {
      libelle: 'Lots de la tranche',
      unite: 'nombre',
      sur: ['tranche'],
      formule: 'NB(lot POUR lot QUAND code_produit_lot = tranche)',
    },
    su_totale_tranches: {
      libelle: 'Surface utile de l’opération',
      unite: 'm2',
      regle: 'R-SURF-3',
      formule: 'SOMME(su_tranche POUR tranche DANS tranches_ordre_saisie)',
    },
    quote_part_su: {
      libelle: 'Quote-part de surface utile',
      unite: 'taux',
      regle: 'R-SURF-3',
      sur: ['tranche'],
      formule: 'SI(su_totale_tranches > 0; su_tranche / su_totale_tranches; 0)',
      note: 'Clé unique de répartition de tout ce qui est commun à l’opération (arbitrage du 05/08/2026).',
    },
    nb_logements_total: {
      libelle: 'Logements de l’opération',
      unite: 'nombre',
      formule: 'SOMME(DEFAUT(nb_logements_lot; 0) POUR lot)',
    },
    shab_totale: {
      libelle: 'Surface habitable de l’opération',
      unite: 'm2',
      formule: 'SOMME(DEFAUT(shab_lot; 0) POUR lot)',
    },
    annexes_totales: {
      libelle: 'Surfaces annexes de l’opération',
      unite: 'm2',
      formule: 'SOMME(DEFAUT(annexes_lot; 0) POUR lot)',
    },
  },
};
