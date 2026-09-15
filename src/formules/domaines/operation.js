// @ts-check
/**
 * DOMAINE « OPERATION » : ce que la saisie decrit, et les dimensions du modele.
 *
 * Presque rien ne s'y calcule. Ce sont les donnees d'entree - les lots du
 * programme, l'identite de l'operation, les annexes louees - et la liste des
 * tranches qui s'en deduit. Toutes les autres formules les citent.
 *
 * Les proprietes d'un PRODUIT (foyer, coefficient de structure, loyer de
 * marche...) viennent du referentiel des produits (`produits.js`) : elles se
 * lisent, elles ne se calculent pas.
 */
import { produit, ORDRE_PRODUITS } from '../../produits.js';

/**
 * Lecture d'une propriete du produit d'une tranche.
 * @param {string} cle
 */
const proprieteProduit = (cle) => (/** @type {any} */ _ctx, /** @type {any} */ tranche) =>
  /** @type {any} */ (produit(tranche))[cle];

/** @type {import('../classeur.js').Domaine} */
export const OPERATION = {
  domaine: 'operation',
  titre: 'Opération et programme',
  dimensions: {
    lot: { libelle: 'Lot', valeurs: 'INDICES(lots_saisis)', etiquette: 'libelle_lot' },
    tranche: { libelle: 'Tranche', valeurs: 'tranches_presentes' },
    annexe: { libelle: 'Annexe louée', valeurs: 'INDICES(annexes_louees_saisies)' },
    // Dimension LIBRE : toute annee civile y est admise. Elle sert a lire les
    // tables annuelles (trajectoires), pas a les parcourir.
    an: { libelle: 'Année civile' },
  },
  grandeurs: {
    // --- Programme ----------------------------------------------------------
    lots_saisis: { libelle: 'Lots du programme', unite: 'liste', saisie: 'lots', ecran: 'Programme' },
    code_produit_lot: {
      libelle: 'Produit du lot',
      unite: 'texte',
      sur: ['lot'],
      saisie: 'lots[lot].code_produit',
      ecran: 'Programme',
    },
    nb_logements_lot: {
      libelle: 'Logements du lot',
      unite: 'nombre',
      sur: ['lot'],
      saisie: 'lots[lot].nb_logements',
      ecran: 'Programme',
    },
    shab_lot: {
      libelle: 'Surface habitable du lot',
      unite: 'm2',
      sur: ['lot'],
      saisie: 'lots[lot].shab_m2',
      ecran: 'Programme',
    },
    annexes_lot: {
      libelle: 'Surfaces annexes du lot',
      unite: 'm2',
      sur: ['lot'],
      saisie: 'lots[lot].surfaces_annexes_m2',
      ecran: 'Programme',
    },
    su_forcee_lot: {
      libelle: 'Surface utile forcée du lot',
      unite: 'm2',
      sur: ['lot'],
      saisie: 'lots[lot].su_forcee_m2',
      ecran: 'Programme',
    },
    libelle_lot: {
      libelle: 'Libellé du lot',
      unite: 'texte',
      sur: ['lot'],
      lire: (ctx, lot) => {
        const l = ctx.entrees?.lots?.[lot] ?? {};
        return [`Lot ${lot + 1}`, l.code_produit, l.typologie].filter(Boolean).join(' · ');
      },
    },
    codes_des_lots: {
      libelle: 'Produits des lots, dans l’ordre de saisie',
      unite: 'liste',
      formule: 'LISTE(code_produit_lot POUR lot)',
    },
    tranches_ordre_saisie: {
      libelle: 'Tranches, dans l’ordre de saisie',
      unite: 'liste',
      formule: 'UNIQUES(codes_des_lots)',
      note: 'Ordre de première apparition dans les lots : c’est celui des répartitions au prorata des surfaces.',
    },
    ordre_produits: {
      libelle: 'Ordre réglementaire des produits',
      unite: 'liste',
      lire: () => ORDRE_PRODUITS,
    },
    tranches_presentes: {
      libelle: 'Tranches du programme',
      unite: 'liste',
      formule:
        'CONCATENER(LISTE(p POUR p DANS ordre_produits QUAND CONTIENT(tranches_ordre_saisie; p)); ' +
        'LISTE(p POUR p DANS tranches_ordre_saisie QUAND NON(CONTIENT(ordre_produits; p))))',
      note: 'Dans l’ordre réglementaire, du plus social au plus libre.',
    },

    // --- Identite -------------------------------------------------------------
    zone_123: { libelle: 'Zone 1/2/3', unite: 'texte', saisie: 'identite.zone_123', ecran: 'Opération' },
    zone_abc: { libelle: 'Zone A/B/C', unite: 'texte', saisie: 'identite.zone_ABC', ecran: 'Opération' },
    type_operation: {
      libelle: 'Type d’opération',
      unite: 'texte',
      saisie: 'identite.type_operation',
      ecran: 'Opération',
    },
    foyer_operation: {
      libelle: 'Opération en foyer',
      unite: 'booleen',
      saisie: 'identite.foyer',
      ecran: 'Opération',
    },

    // --- Annexes louees separement ----------------------------------------------
    annexes_louees_saisies: {
      libelle: 'Annexes louées séparément',
      unite: 'liste',
      saisie: 'annexes_louees',
      ecran: 'Programme',
    },
    nombre_annexe: {
      libelle: 'Nombre d’annexes',
      unite: 'nombre',
      sur: ['annexe'],
      saisie: 'annexes_louees[annexe].nombre',
      ecran: 'Programme',
    },
    loyer_unitaire_annexe: {
      libelle: 'Loyer mensuel d’une annexe',
      unite: 'eur',
      sur: ['annexe'],
      saisie: 'annexes_louees[annexe].loyer_unitaire_eur_mois',
      ecran: 'Programme',
    },

    // --- Proprietes des produits ------------------------------------------------
    produit_foyer: {
      libelle: 'Produit de foyer',
      unite: 'booleen',
      sur: ['tranche'],
      lire: proprieteProduit('foyer'),
      ecran: 'Référentiel des produits',
    },
    produit_avec_cs: {
      libelle: 'Loyer soumis au coefficient de structure',
      unite: 'booleen',
      sur: ['tranche'],
      lire: proprieteProduit('coefficient_structure'),
      ecran: 'Référentiel des produits',
    },
    produit_loyer_par_convention: {
      libelle: 'Plafond de loyer conventionnel',
      unite: 'booleen',
      sur: ['tranche'],
      lire: proprieteProduit('loyer_par_convention'),
      ecran: 'Référentiel des produits',
    },
    produit_loyer_de_marche: {
      libelle: 'Loyer de marché',
      unite: 'booleen',
      sur: ['tranche'],
      lire: proprieteProduit('loyer_de_marche'),
      ecran: 'Référentiel des produits',
    },
    produit_avec_majoration: {
      libelle: 'Produit à loyer majoré',
      unite: 'booleen',
      sur: ['tranche'],
      lire: (_ctx, tranche) => Boolean(produit(tranche).majoration_loyer),
      ecran: 'Référentiel des produits',
    },

    // --- Constantes calendaires -------------------------------------------------
    mois_par_an: { libelle: 'Mois par an', unite: 'nombre', constante: 12 },
  },
};
