// @ts-check
/**
 * R-TRESO - Tresorerie de la PHASE CHANTIER, du premier ordre de service a la
 * livraison.
 *
 * Ce module repond a une question que le compte d'exploitation ne pose jamais :
 * l'operation a-t-elle de quoi payer ses factures PENDANT les travaux ? Le
 * compte d'exploitation demarre a la mise en location ; entre l'ordre de service
 * et la livraison, l'operation ne fait que depenser, et ce qui la finance
 * n'arrive pas au meme rythme.
 *
 * Le point de vue est celui du FINANCEUR : on suit le solde mois par mois, on
 * regarde a quel moment il creuse le plus, et de combien. Ce creux est le besoin
 * de prefinancement, et c'est lui qui porte les interets intercalaires (R-FIN-6).
 *
 * Trois flux, trois rythmes distincts :
 *  - les DEPENSES suivent l'avancement, chapitre par chapitre : le foncier se
 *    paie a l'ordre de service, les travaux s'etalent sur le chantier ;
 *  - les SUBVENTIONS sont mobilisables des l'ordre de service (regle metier du
 *    11/08/2026) ;
 *  - les PRETS se tirent au fil de l'eau, a hauteur de ce qui manque : un
 *    organisme ne tire pas plus tot que necessaire, les interets courent.
 *
 * Module pur : aucune date systeme, aucun acces disque. Meme entrees, memes
 * sorties.
 */
import { arrondiEuro, arrondirEnConservantLaSomme } from './arrondis.js';
import { decalerMois } from './calendrier.js';

/**
 * Courbe de decaissement par defaut, chapitre par chapitre.
 *
 * `os` est la part payee a l'ordre de service, le reste s'etale lineairement sur
 * le chantier. Le foncier se paie comptant a l'acquisition, les travaux suivent
 * l'avancement : ce sont deux rythmes qu'une courbe unique ne saurait pas dire.
 * Surchargeable par le referentiel (`tresorerie.courbes`).
 */
export const COURBES_DEFAUT = {
  charge_fonciere: { os: 1 },
  batiment: { os: 0 },
  honoraires: { os: 0.2 },
  frais_annexes: { os: 0.3 },
  frais_financiers: { os: 0 },
};

/**
 * @typedef {Object} LigneTresorerie
 * @property {number} mois            rang du mois, 0 = ordre de service
 * @property {string} date            premier jour du mois, ISO
 * @property {number} depenses_eur    decaissements du mois
 * @property {number} subventions_eur encaissements de subventions
 * @property {number} fonds_propres_eur apport mobilise
 * @property {number} tirage_eur      pret tire ce mois pour couvrir le manque
 * @property {number} solde_eur       solde du mois, tirages compris
 * @property {number} cumul_depenses_eur
 * @property {number} cumul_tirages_eur
 * @property {number} besoin_eur      cumul depenses - cumul ressources hors prets
 */

/**
 * Echeancier de tresorerie du chantier.
 *
 * @param {Object} p
 * @param {string} p.date_debut_travaux         ordre de service
 * @param {number} p.duree_chantier_mois
 * @param {Record<string, number>} p.depenses_par_chapitre  prix de revient TTC par chapitre
 * @param {number} [p.subventions_eur]          mobilisables a l'ordre de service
 * @param {number} [p.fonds_propres_eur]        apport de l'organisme
 * @param {Record<string, {os: number}>} [p.courbes] surcharge des courbes
 * @param {boolean} [p.tirer_les_prets]         defaut vrai : les prets comblent le manque
 * @returns {{lignes: LigneTresorerie[], indicateurs: Object, tirages: Array<{date: string, montant_eur: number}>}}
 */
export function tresorerieChantier(p) {
  const {
    date_debut_travaux,
    duree_chantier_mois,
    depenses_par_chapitre = {},
    subventions_eur = 0,
    fonds_propres_eur = 0,
    courbes = COURBES_DEFAUT,
    tirer_les_prets = true,
  } = p;

  const n = Math.max(1, Math.round(Number(duree_chantier_mois) || 0));

  // Depenses mois par mois. Le mois 0 porte les parts payees a l'ordre de
  // service ; le reste s'etale jusqu'a la livraison incluse.
  const brut = new Array(n + 1).fill(0);
  for (const [chapitre, montant] of Object.entries(depenses_par_chapitre)) {
    if (!(montant > 0)) continue;
    const partOS = courbes[chapitre]?.os ?? COURBES_DEFAUT[chapitre]?.os ?? 0;
    brut[0] += montant * partOS;
    const etale = montant * (1 - partOS);
    for (let m = 1; m <= n; m++) brut[m] += etale / n;
  }
  // Les mensualites s'arrondissent EN CONSERVANT LEUR SOMME : arrondies une a
  // une, vingt-cinq lignes derivaient de quelques euros du prix de revient, et
  // un echeancier qui ne totalise pas son propre total n'inspire rien de bon.
  const depenses = arrondirEnConservantLaSomme(brut);

  /** @type {LigneTresorerie[]} */
  const lignes = [];
  /** @type {Array<{date: string, montant_eur: number}>} */
  const tirages = [];
  let cumulDepenses = 0;
  let cumulTirages = 0;
  let tresorerie = 0;

  for (let m = 0; m <= n; m++) {
    const depense = depenses[m];
    // Subventions et fonds propres arrivent a l'ordre de service : la regle des
    // subventions est un arbitrage metier, celle des fonds propres suit le bon
    // sens - l'organisme met sa part avant d'emprunter.
    const subvention = m === 0 ? subventions_eur : 0;
    const apport = m === 0 ? fonds_propres_eur : 0;

    cumulDepenses += depense;
    tresorerie += subvention + apport - depense;

    // Le pret se tire a hauteur du MANQUE, jamais plus : tirer d'avance ferait
    // courir des interets intercalaires sur de l'argent qui dort.
    let tirage = 0;
    if (tirer_les_prets && tresorerie < 0) {
      tirage = -tresorerie;
      tresorerie = 0;
      cumulTirages += tirage;
      tirages.push({ date: decalerMois(date_debut_travaux, m), montant_eur: arrondiEuro(tirage) });
    }

    lignes.push({
      mois: m,
      date: decalerMois(date_debut_travaux, m),
      depenses_eur: arrondiEuro(depense),
      subventions_eur: arrondiEuro(subvention),
      fonds_propres_eur: arrondiEuro(apport),
      tirage_eur: arrondiEuro(tirage),
      solde_eur: arrondiEuro(tresorerie),
      cumul_depenses_eur: arrondiEuro(cumulDepenses),
      cumul_tirages_eur: arrondiEuro(cumulTirages),
      besoin_eur: arrondiEuro(cumulDepenses - subventions_eur - fonds_propres_eur),
    });
  }

  // Le besoin de prefinancement est le point HAUT du besoin cumule : c'est le
  // moment ou l'operation doit le plus d'argent, et donc ce que les prets
  // devront couvrir. Le chercher au point bas donnait zero sur toute operation
  // normale - le besoin y est positif du premier au dernier mois.
  const pic = lignes.reduce((max, l) => (l.besoin_eur > max.besoin_eur ? l : max), lignes[0]);

  return {
    lignes,
    tirages,
    indicateurs: {
      total_depenses_eur: arrondiEuro(cumulDepenses),
      total_subventions_eur: arrondiEuro(subventions_eur),
      total_fonds_propres_eur: arrondiEuro(fonds_propres_eur),
      total_tirages_eur: arrondiEuro(cumulTirages),
      besoin_maximal_eur: arrondiEuro(Math.max(0, pic.besoin_eur)),
      mois_pic: pic.mois,
      // Part du prix de revient deja engagee a l'ordre de service : elle dit
      // d'un chiffre a quel point l'operation demande de l'argent tout de suite.
      part_a_l_os: cumulDepenses > 0 ? depenses[0] / cumulDepenses : 0,
    },
  };
}
