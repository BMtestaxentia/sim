// @ts-check
/**
 * R-TRESO - Tresorerie de la PHASE CHANTIER, du premier ordre de service a la
 * livraison.
 *
 * Ce module repond a une question que le compte d'exploitation ne pose jamais :
 * l'operation a-t-elle de quoi payer ses factures PENDANT les travaux ? Le point
 * de vue est celui du FINANCEUR : on suit le solde mois par mois, on regarde a
 * quel moment il creuse le plus, et de combien.
 *
 * LES FORMULES VIVENT DANS `formules/domaines/tresorerie.js` : revision du cout,
 * indexation de chaque somme due, appels de fonds en VEFA, tirages des prets.
 * Ce module restitue l'echeancier d'un classeur, et garde la fonction
 * historique `tresorerieChantier`, qui evalue ces memes formules sur les
 * valeurs qu'on lui donne.
 *
 * Module pur : aucune date systeme, aucun acces disque.
 */
import { arrondiEuro } from './arrondis.js';
import { nouveauClasseur } from './formules/modele.js';

/**
 * @typedef {Object} LigneTresorerie
 * @property {number} mois            rang du mois, 1 = premiere echeance
 * @property {string} date            date d'echeance, ISO
 * @property {number} nominal_eur     mensualite avant indexation
 * @property {number} coefficient     (1 + t) ^ (duree ecoulee en annees)
 * @property {number} depenses_eur    mensualite indexee, ce qui sort vraiment
 * @property {number} subventions_eur encaissements de subventions
 * @property {number} fonds_propres_eur apport mobilise
 * @property {number} tirage_eur      pret tire ce mois pour couvrir le manque
 * @property {number} solde_eur       solde du mois, tirages compris
 * @property {number} cumul_depenses_eur
 * @property {number} cumul_tirages_eur
 * @property {number} besoin_eur      cumul depenses - ressources hors prets
 */

/**
 * Echeancier de tresorerie du chantier d'un classeur.
 * @param {import('./formules/classeur.js').Classeur} c
 * @returns {{lignes: LigneTresorerie[], tirages: Array<{date: string, montant_eur: number}>, indicateurs: Object}}
 */
export function restituerTresorerie(c) {
  const mois = c.valeursDimension('mois_chantier');
  const v = (/** @type {string} */ id, /** @type {number} */ m) => c.valeur(id, { mois_chantier: m });
  const lignes = mois.map((m) => ({
    mois: m,
    date: v('date_echeance', m),
    nominal_eur: arrondiEuro(v('nominal_mois', m)),
    coefficient: v('coefficient_mois', m),
    depenses_eur: v('depense_mois', m),
    subventions_eur: arrondiEuro(v('encaissement_subventions', m)),
    fonds_propres_eur: arrondiEuro(v('encaissement_fonds_propres', m)),
    tirage_eur: arrondiEuro(v('tirage_mois', m)),
    solde_eur: arrondiEuro(v('solde_chantier', m)),
    cumul_depenses_eur: arrondiEuro(v('cumul_depenses_chantier', m)),
    cumul_tirages_eur: arrondiEuro(v('cumul_tirages', m)),
    besoin_eur: arrondiEuro(v('besoin_mois', m)),
  }));
  const tirages = mois
    .filter((m) => v('tirage_mois', m) > 0)
    .map((m) => ({ date: v('date_echeance', m), montant_eur: arrondiEuro(v('tirage_mois', m)) }));
  const g = (/** @type {string} */ id) => c.valeur(id);
  const echeance = g('echeance_nominale');
  return {
    lignes,
    tirages,
    indicateurs: {
      cout_initial_eur: arrondiEuro(g('cout_chantier')),
      cout_revise_eur: arrondiEuro(g('cout_revise')),
      revision_au_demarrage_eur: arrondiEuro(g('revision_au_demarrage')),
      echeance_nominale_eur: echeance === null ? null : arrondiEuro(echeance),
      total_depenses_eur: arrondiEuro(g('total_depenses_final')),
      surcout_indexation_eur: arrondiEuro(g('surcout_indexation')),
      taux_indexation: g('taux_indexation_chantier'),
      total_subventions_eur: arrondiEuro(g('subventions_chantier')),
      total_fonds_propres_eur: arrondiEuro(g('fonds_propres_chantier')),
      total_tirages_eur: arrondiEuro(g('total_tirages')),
      besoin_maximal_eur: arrondiEuro(g('besoin_maximal')),
      mois_pic: g('mois_pic'),
      mode_tirage: g('mode_tirage'),
      tresorerie_maximale_eur: arrondiEuro(g('tresorerie_maximale')),
      jalons_utilises: g('jalons_utilises'),
    },
  };
}

/** Valeur d'une entree, ou son defaut si elle est absente - et seulement absente. */
const saisieOuDefaut = (/** @type {any} */ v, /** @type {any} */ defaut) => (v === undefined ? defaut : v);

/**
 * Echeancier de tresorerie d'un chantier decrit par ses seules valeurs.
 * Formules du domaine « tresorerie ».
 *
 * @param {Object} p
 * @param {string} p.date_debut_travaux         ordre de service
 * @param {number} p.duree_chantier_mois
 * @param {number} [p.cout_total_eur]           prix de revient TTC de l'operation
 * @param {string} [p.date_valeur_cout]         date a laquelle le cout est exprime
 * @param {number} [p.taux_indexation]          taux ANNUEL, fraction
 * @param {number} [p.subventions_eur]          mobilisables a l'ordre de service
 * @param {number} [p.fonds_propres_eur]        apport de l'organisme
 * @param {boolean} [p.tirer_les_prets]         defaut vrai : les prets comblent le manque
 * @param {Array<{part: number, avancement: number}>|null} [p.jalons] appels de fonds (VEFA)
 * @param {'integral'|'au_fil_de_l_eau'} [p.mode_tirage]
 */
export function tresorerieChantier(p) {
  const c = nouveauClasseur({})
    .fixer('date_debut_travaux_saisie', {}, p.date_debut_travaux)
    .fixer('duree_chantier_retenue', {}, p.duree_chantier_mois)
    .fixer('cout_chantier', {}, saisieOuDefaut(p.cout_total_eur, 0))
    .fixer('date_valeur_cout', {}, p.date_valeur_cout)
    .fixer('taux_indexation_chantier', {}, saisieOuDefaut(p.taux_indexation, 0))
    .fixer('subventions_chantier', {}, saisieOuDefaut(p.subventions_eur, 0))
    .fixer('fonds_propres_chantier', {}, saisieOuDefaut(p.fonds_propres_eur, 0))
    .fixer('tirer_les_prets', {}, saisieOuDefaut(p.tirer_les_prets, true))
    .fixer('jalons_tresorerie', {}, saisieOuDefaut(p.jalons, null))
    .fixer('mode_tirage', {}, saisieOuDefaut(p.mode_tirage, 'integral'));
  return restituerTresorerie(c);
}
