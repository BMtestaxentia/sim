// @ts-check
/**
 * IMPORTANCE DES LIGNES du classeur des calculs : ce qu'on lit d'abord, ce qui
 * explique, ce qui se replie.
 *
 *   cle        un resultat que l'outil restitue et que l'on commente : total,
 *              loyer annuel, autofinancement, besoin de tresorerie ;
 *   etape      un calcul intermediaire qui se lit dans l'enchainement, ou une
 *              saisie de l'operation ;
 *   technique  un detail d'execution : un repli sur le lot, une valeur exacte
 *              avant arrondi, un indicateur oui/non, un parametre de bareme.
 *
 * Une grandeur peut porter son niveau - `niveau` dans son domaine, ou choisi
 * dans le classeur par un administrateur (surcharges.js) ; a defaut, il se
 * deduit ici. Ce n'est qu'un affichage : aucun calcul n'en depend.
 */

/** Les resultats cles, domaine par domaine. */
export const RESULTATS_CLES = new Set([
  // calendrier
  'annee_mise_en_location',
  // surfaces
  'nb_logements_total',
  'shab_totale',
  'su_tranche',
  'su_totale_tranches',
  // loyers
  'loyer_pratique_tranche',
  'loyer_annuel_tranche',
  'loyers_logements_annuels',
  // prix de revient
  'total_ttc_module',
  'total_ttc_module_tranche',
  'total_ht',
  'total_ttc',
  // subventions
  'subventions_total',
  'subventions_tranche',
  'ssf_subvention_calculee',
  // financement
  'fonds_propres_total',
  'fonds_propres_tranche',
  'cdc_total',
  // prets
  'montant_pret',
  'total_prets',
  'total_prets_tranche',
  // amortissement
  'annuite_pret',
  // fiscalite
  'tfpb_base_tranche',
  'taxe_amenagement',
  // tresorerie
  'total_depenses_final',
  'besoin_maximal',
  'total_tirages',
  // exploitation
  'loyers_nets',
  'total_produits',
  'total_charges',
  'autofinancement',
  'cumul_autofinancement',
  'resultat_comptable',
  'autofinancement_perimetre_horizon',
  'resultat_cumule_final',
  'tri',
  'annee_reconstitution_fonds_propres',
  // synthese
  'prix_revient_par_logement',
  'prix_revient_par_m2_shab',
  'loyers_annuels_operation',
  'rmo',
  'taux_fonds_propres',
]);

/** Unites d'un indicateur d'execution plutot que d'un montant. */
const UNITES_TECHNIQUES = new Set(['booleen', 'liste', 'texte']);

/**
 * Noms d'une grandeur d'execution : repli sur le lot, valeur exacte avant
 * arrondi, option, liste, table de lecture, ordre de parcours.
 */
const RE_TECHNIQUE = /(_lot$|^lot_|_exacte?s?$|_brut$|^option_|^est_|_presente?s?$|_ordre|_reference|_designe|^cles_|_table_|_en_serie$)/;

/** Saisie portee par un lot, lue en repli d'une saisie par tranche. */
const RE_SAISIE_DE_REPLI = /(_lot$|^lot_)/;

/**
 * Importance d'une grandeur a l'ecran.
 * @param {any} g  grandeur du modele
 * @returns {'cle'|'etape'|'technique'}
 */
export function niveauDe(g) {
  if (g.niveau) return g.niveau;
  if (RESULTATS_CLES.has(g.id)) return 'cle';
  if (g.formule === undefined) {
    // Une saisie est ce que l'utilisateur tape : elle se voit. Un parametre de
    // bareme, une trajectoire, une lecture de table se replient.
    if (g.saisie !== undefined) return RE_SAISIE_DE_REPLI.test(g.id) ? 'technique' : 'etape';
    return 'technique';
  }
  if (UNITES_TECHNIQUES.has(g.unite) || RE_TECHNIQUE.test(g.id)) return 'technique';
  return 'etape';
}
