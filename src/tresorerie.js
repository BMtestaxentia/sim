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
 * R-TRESO-2 - INDEXATION DES DEPENSES. Transcription du classeur « Indexeur cout
 * travaux » (metier, 11/08/2026). Deux indexations se suivent, et les confondre
 * donnerait un surcout faux :
 *
 *  1. le cout est saisi a une DATE DE VALEUR, et revise jusqu'a l'ordre de
 *     service :  cout_revise = cout x (1 + t)^((debut - valeur)/365,25)  ;
 *  2. l'echeancier repartit ce cout revise a PARTS EGALES sur les mois de
 *     chantier, et chaque mensualite est indexee de SA propre duree, du debut
 *     des travaux a son echeance. Le classeur le dit en titre : « seules les
 *     sommes dues sont indexees » - une facture payee au premier mois ne subit
 *     pas l'indexation de la trentieme.
 *
 * La base est 365,25 jours, celle du classeur, et la premiere echeance tombe un
 * mois APRES l'ordre de service : un chantier ne facture pas le jour ou il
 * commence.
 *
 * Module pur : aucune date systeme, aucun acces disque. Meme entrees, memes
 * sorties.
 */
import { arrondiEuro, arrondirEnConservantLaSomme } from './arrondis.js';
import { decalerMois } from './calendrier.js';
import { jourUTC } from './amortissement.js';

/** Base de jours de l'indexation : celle du classeur (365,25). */
const BASE_JOURS = 365.25;

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
 * Echeancier de tresorerie du chantier.
 *
 * @param {Object} p
 * @param {string} p.date_debut_travaux         ordre de service
 * @param {number} p.duree_chantier_mois
 * @param {number} p.cout_total_eur             prix de revient TTC de l'operation
 * @param {string} [p.date_valeur_cout]         date a laquelle le cout est exprime
 * @param {number} [p.taux_indexation]          taux ANNUEL, fraction
 * @param {number} [p.subventions_eur]          mobilisables a l'ordre de service
 * @param {number} [p.fonds_propres_eur]        apport de l'organisme
 * @param {boolean} [p.tirer_les_prets]         defaut vrai : les prets comblent le manque
 * @returns {{lignes: LigneTresorerie[], indicateurs: Object, tirages: Array<{date: string, montant_eur: number}>}}
 */
export function tresorerieChantier(p) {
  const {
    date_debut_travaux,
    duree_chantier_mois,
    cout_total_eur = 0,
    date_valeur_cout,
    taux_indexation = 0,
    subventions_eur = 0,
    fonds_propres_eur = 0,
    tirer_les_prets = true,
    jalons = null,
    mode_tirage = 'integral',
  } = p;

  const n = Math.max(1, Math.round(Number(duree_chantier_mois) || 0));
  const anneesDepuis = (date) => (jourUTC(date) - jourUTC(date_debut_travaux)) / BASE_JOURS;

  // 1. Revision du cout jusqu'a l'ordre de service. Sans date de valeur, le
  //    cout est repute exprime au demarrage : il n'y a rien a rattraper.
  const anneesRevision = date_valeur_cout ? -anneesDepuis(date_valeur_cout) : 0;
  const coutRevise = cout_total_eur * (1 + taux_indexation) ** anneesRevision;

  // 2. Repartition du cout revise sur les mois de chantier.
  //
  // R-TRESO-3 - En VEFA, le promoteur appelle des fonds A L'AVANCEMENT selon un
  // bareme LEGAL (CCH R261-14) : 25 % a la signature, 10 % aux fondations, et
  // ainsi de suite. Repartir a parts egales y serait faux d'un quart des le
  // premier mois. Hors VEFA, l'operation paie ses factures au fil du chantier
  // et la repartition egale reste la meilleure approximation.
  const nominauxParMois = new Array(n).fill(0);
  if (jalons?.length) {
    for (const jalon of jalons) {
      // L'avancement se convertit en RANG DE MOIS. Un jalon a l'ordre de
      // service tombe au premier mois - il n'y a pas de mois zero, le premier
      // appel de fonds est du des la signature.
      const rang = Math.min(n, Math.max(1, Math.ceil((jalon.avancement ?? 0) * n) || 1));
      nominauxParMois[rang - 1] += coutRevise * (jalon.part ?? 0);
    }
  } else {
    for (let k = 0; k < n; k++) nominauxParMois[k] = coutRevise / n;
  }

  // 3. Chaque somme due est indexee de SA propre duree.
  const dates = Array.from({ length: n }, (_, k) => decalerMois(date_debut_travaux, k + 1));
  const coefficients = dates.map((d) => (1 + taux_indexation) ** anneesDepuis(d));
  const indexees = coefficients.map((c, k) => nominauxParMois[k] * c);
  // Les mensualites s'arrondissent EN CONSERVANT LEUR SOMME : arrondies une a
  // une, trente lignes derivaient de quelques euros du total, et un echeancier
  // qui ne totalise pas son propre total n'inspire rien de bon.
  const depenses = arrondirEnConservantLaSomme(indexees);

  /** @type {LigneTresorerie[]} */
  const lignes = [];
  /** @type {Array<{date: string, montant_eur: number}>} */
  const tirages = [];
  let cumulDepenses = 0;
  let cumulTirages = 0;
  // Subventions et fonds propres arrivent a l'ordre de service, donc AVANT la
  // premiere echeance : la tresorerie demarre en positif. La regle des
  // subventions est un arbitrage metier ; celle des fonds propres suit le bon
  // sens - l'organisme met sa part avant d'emprunter.
  let tresorerie = subventions_eur + fonds_propres_eur;

  // R-TRESO-4 - MODE DE TIRAGE. En `integral`, le pret est mobilise en une fois
  // des le premier mois : c'est la pratique de l'organisme, et elle a un cout -
  // les interets intercalaires courent sur la totalite pendant tout le chantier,
  // pas seulement sur ce qui est consomme. En `au_fil_de_l_eau`, le pret ne se
  // tire qu'a hauteur du manque du mois. Les deux modes financent exactement la
  // meme chose ; ils ne la financent pas au meme prix.
  const totalDepenses = depenses.reduce((s, d) => s + d, 0);
  const aEmprunter = Math.max(0, totalDepenses - subventions_eur - fonds_propres_eur);

  for (let k = 0; k < n; k++) {
    const depense = depenses[k];

    // Le tirage integral tombe AVANT la depense du premier mois : le pret est
    // en caisse quand la premiere facture arrive.
    let tirage = 0;
    if (tirer_les_prets && mode_tirage === 'integral' && k === 0 && aEmprunter > 0) {
      tirage = aEmprunter;
      tresorerie += tirage;
      cumulTirages += tirage;
      tirages.push({ date: dates[0], montant_eur: arrondiEuro(tirage) });
    }

    cumulDepenses += depense;
    tresorerie -= depense;

    // Au fil de l'eau : on comble le manque du mois, jamais plus.
    if (tirer_les_prets && mode_tirage !== 'integral' && tresorerie < 0) {
      tirage = -tresorerie;
      tresorerie = 0;
      cumulTirages += tirage;
      tirages.push({ date: dates[k], montant_eur: arrondiEuro(tirage) });
    }

    lignes.push({
      mois: k + 1,
      date: dates[k],
      nominal_eur: arrondiEuro(nominauxParMois[k]),
      coefficient: coefficients[k],
      depenses_eur: depense,
      subventions_eur: k === 0 ? arrondiEuro(subventions_eur) : 0,
      fonds_propres_eur: k === 0 ? arrondiEuro(fonds_propres_eur) : 0,
      tirage_eur: arrondiEuro(tirage),
      solde_eur: arrondiEuro(tresorerie),
      cumul_depenses_eur: arrondiEuro(cumulDepenses),
      cumul_tirages_eur: arrondiEuro(cumulTirages),
      besoin_eur: arrondiEuro(cumulDepenses - subventions_eur - fonds_propres_eur),
    });
  }

  // Le besoin de prefinancement est le point HAUT du besoin cumule : c'est le
  // moment ou l'operation doit le plus d'argent, et donc ce que les prets
  // devront couvrir.
  const pic = lignes.reduce((max, l) => (l.besoin_eur > max.besoin_eur ? l : max), lignes[0]);

  return {
    lignes,
    tirages,
    indicateurs: {
      cout_initial_eur: arrondiEuro(cout_total_eur),
      cout_revise_eur: arrondiEuro(coutRevise),
      revision_au_demarrage_eur: arrondiEuro(coutRevise - cout_total_eur),
      // L'echeance nominale n'a de sens qu'a parts egales : sous bareme de
      // jalons, les appels de fonds vont de 1 a 25 % et une « mensualite »
      // moyenne ne decrirait aucun mois reel.
      echeance_nominale_eur: jalons?.length ? null : arrondiEuro(coutRevise / n),
      total_depenses_eur: arrondiEuro(cumulDepenses),
      // Ce que l'indexation coute en propre, revision de depart comprise : le
      // chiffre que le classeur appelle « ecart total vs cout initial ».
      surcout_indexation_eur: arrondiEuro(cumulDepenses - cout_total_eur),
      taux_indexation,
      total_subventions_eur: arrondiEuro(subventions_eur),
      total_fonds_propres_eur: arrondiEuro(fonds_propres_eur),
      total_tirages_eur: arrondiEuro(cumulTirages),
      besoin_maximal_eur: arrondiEuro(Math.max(0, pic.besoin_eur)),
      mois_pic: pic.mois,
      mode_tirage,
      // Le pic de TRESORERIE dit ce que le tirage integral laisse dormir en
      // caisse : c'est l'argent sur lequel courent des interets intercalaires
      // sans qu'il finance encore quoi que ce soit.
      tresorerie_maximale_eur: arrondiEuro(Math.max(0, ...lignes.map((l) => l.solde_eur))),
      jalons_utilises: Boolean(jalons?.length),
    },
  };
}
