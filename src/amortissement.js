// @ts-check
/**
 * R-AMT — Moteur d'amortissement des prets (coeur du moteur, cible +/-0,1 % vs LEON).
 *
 * Regles couvertes :
 * - R-AMT-2 : premiere annuite du profil progressif (source SimPLUS!AM15).
 *   Arbitrage I-8 : a taux nul LEON renvoie 0 ; ici amortissement lineaire.
 * - R-AMT-3 : annee de premiere echeance PAR PRET (source SimPLUS!AR17...).
 *   C'est la regle dont la violation causait le bug historique ALS : chaque
 *   pret demarre a SA date, jamais a un « an 1 » commun a l'operation.
 * - R-AMT-4 : revision annuelle bareme CDC (source SimPLUS!FF117 sq.) selon la
 *   revisabilite (DOUBLE / D.LIMITEE / SIMPLE / TAUX FIXE), differes type 1
 *   (interets capitalises) et type 2 (interets seuls), arret sur CRD nul et
 *   derniere echeance ajustee (formule FK117 a confirmer, cf. QUESTIONS_SPEC Q-1).
 * - R-AMT-5 : table de sortie par pret (annee -> taux, annuite, interets,
 *   amortissement, CRD).
 * - R-FIN-6 : interets de prefinancement par echeancier de tirages mensuels
 *   (capitalisation SimPLUS!FA15:FD27 ; hypothese de taux mensuel proportionnel,
 *   cf. QUESTIONS_SPEC Q-3).
 *
 * Unites : montants en euros, taux en fraction (0.021 = 2,1 %), durees en annees.
 * Module pur : la trajectoire du Livret A est une ENTREE (annee -> taux), jamais
 * lue d'une horloge, d'un fichier ou d'un etat global.
 */
import { arrondiCRD } from './arrondis.js';

/** Nombre de mois dans une annee civile (constante calendaire, pas un parametre metier). */
const MOIS_PAR_AN = 12;

/** Garde numerique pour les cas degeneres (q -> 1) ; pas un parametre metier. */
const EPSILON_NUMERIQUE = 1e-12;

/** @typedef {'DOUBLE'|'D.LIMITEE'|'SIMPLE'|'TAUX FIXE'} Revisabilite */

/**
 * Libelles rencontres dans LEON (onglet IN) -> forme canonique.
 * @type {Record<string, Revisabilite>}
 */
const REVISABILITES = {
  'DOUBLE': 'DOUBLE',
  'D.LIMITEE': 'D.LIMITEE',
  'D. LIMITEE': 'D.LIMITEE',
  'D.LIMITÉE': 'D.LIMITEE',
  'D. LIMITÉE': 'D.LIMITEE',
  'SIMPLE': 'SIMPLE',
  'TAUX FIXE': 'TAUX FIXE',
  'FIXE': 'TAUX FIXE',
};

/**
 * Normalise un libelle de revisabilite tel que serialise par LEON
 * (« D. LIMITEE » avec espace, « TAUX FIXE »...) vers la forme canonique.
 * @param {string} libelle
 * @returns {Revisabilite}
 */
export function normaliserRevisabilite(libelle) {
  const canonique = REVISABILITES[String(libelle).trim().toUpperCase()];
  if (!canonique) throw new Error(`Revisabilite inconnue : ${libelle}`);
  return canonique;
}

/**
 * R-AMT-3 — Annee de premiere echeance d'un pret CDC :
 * annee(mise en location) + 1 ; en demembrement le decalage est nul
 * (interpretation « +0 si demembrement » du dictionnaire, cf. QUESTIONS_SPEC Q-4).
 * Les prets « autres » portent leur propre date saisie (SimPLUS!AR17...) et ne
 * passent pas par cette fonction.
 * @param {number} annee_mise_en_location annee civile de la mise en location (DAT)
 * @param {{demembrement?: boolean}} [options]
 * @returns {number}
 */
export function anneePremiereEcheance(annee_mise_en_location, { demembrement = false } = {}) {
  return annee_mise_en_location + (demembrement ? 0 : 1);
}

/**
 * R-AMT-2 — Premiere annuite d'un pret a profil progressif (SimPLUS!AM15).
 * q = (1+p)/(1+t) ; annuite_1 = K x (1+t) x (1 - q) / (1 - q^m), m = duree - differe.
 * Arbitrage I-8 : si t = 0, LEON renvoie 0 ; ici amortissement lineaire K/m.
 * @param {Object} p
 * @param {number} p.montant_eur   K : capital a amortir (apres capitalisation d'un eventuel differe type 1)
 * @param {number} p.taux          t : taux d'interet initial (fraction)
 * @param {number} p.progressivite p : taux de progressivite des annuites (fraction, ex. -0.005)
 * @param {number} p.nb_echeances  m : nombre d'echeances amortissantes (duree - differe)
 * @returns {number} annuite de la premiere echeance, en euros
 */
export function premiereAnnuite({ montant_eur, taux, progressivite, nb_echeances }) {
  if (!(nb_echeances > 0)) throw new Error(`Nombre d'echeances invalide : ${nb_echeances}`);
  if (taux === 0) return montant_eur / nb_echeances; // I-8 : lineaire
  const q = (1 + progressivite) / (1 + taux);
  if (Math.abs(1 - q) < EPSILON_NUMERIQUE) {
    // Cas degenere p = t : la formule tend vers K(1+t)/m
    return (montant_eur * (1 + taux)) / nb_echeances;
  }
  return (montant_eur * (1 + taux) * (1 - q)) / (1 - q ** nb_echeances);
}

/**
 * Livret A applicable une annee donnee. Au-dela de la trajectoire connue, la
 * derniere valeur anterieure est reconduite (la table ParaGEN s'arrete en 2073
 * alors qu'un pret foncier 60 ans court au-dela).
 * @param {Record<number, number>|null|undefined} livret_a_par_annee
 * @param {number} annee
 * @param {number} defaut valeur de repli (LA d'origine du pret)
 * @returns {number}
 */
function livretAPourAnnee(livret_a_par_annee, annee, defaut) {
  if (!livret_a_par_annee) return defaut;
  const direct = livret_a_par_annee[annee];
  if (direct !== undefined) return direct;
  let anneeRetenue = null;
  for (const cle of Object.keys(livret_a_par_annee)) {
    const a = Number(cle);
    if (a < annee && (anneeRetenue === null || a > anneeRetenue)) anneeRetenue = a;
  }
  return anneeRetenue === null ? defaut : livret_a_par_annee[anneeRetenue];
}

/**
 * R-AMT-4 — Taux d'interet revise de l'annee N :
 * tx_N = (1+t) x (1 + (LA_N - LA_0)/(1+t)) - 1  (algebriquement : t + LA_N - LA_0).
 * TAUX FIXE : t constant. SIMPLE : taux revise, progressivite seule figee
 * (interpretation a confirmer, cf. QUESTIONS_SPEC Q-2).
 * @param {Revisabilite} revisabilite
 * @param {number} taux t : taux initial
 * @param {number} la_n Livret A de l'annee N
 * @param {number} la_0 Livret A d'origine du pret
 * @returns {number}
 */
function tauxInteretRevise(revisabilite, taux, la_n, la_0) {
  if (revisabilite === 'TAUX FIXE') return taux;
  return (1 + taux) * (1 + (la_n - la_0) / (1 + taux)) - 1;
}

/**
 * R-AMT-4 — Taux de revision de l'annuite de l'annee N :
 * rev_N = (1+p) x (1 + (LA_N - LA_0)/(1+t)) - 1.
 * DOUBLE -> rev_N ; D.LIMITEE -> MAX(rev_N, 0) ; SIMPLE / TAUX FIXE -> p seul.
 * @param {Revisabilite} revisabilite
 * @param {number} taux t : taux initial
 * @param {number} progressivite p
 * @param {number} la_n Livret A de l'annee N
 * @param {number} la_0 Livret A d'origine du pret
 * @returns {number}
 */
function tauxRevisionAnnuite(revisabilite, taux, progressivite, la_n, la_0) {
  const rev = (1 + progressivite) * (1 + (la_n - la_0) / (1 + taux)) - 1;
  switch (revisabilite) {
    case 'DOUBLE':
      return rev;
    case 'D.LIMITEE':
      return Math.max(rev, 0);
    default:
      return progressivite; // SIMPLE et TAUX FIXE (cf. QUESTIONS_SPEC Q-2)
  }
}

/**
 * @typedef {Object} PretEntree
 * @property {number} montant_eur                capital emprunte (0 -> table vide, pret non mobilise)
 * @property {number} taux                       taux d'interet initial t (fraction)
 * @property {number} [progressivite]            p, defaut 0
 * @property {number} duree_ans                  n : duree totale, differe inclus
 * @property {number} annee_premiere_echeance    annee civile de la 1re echeance DE CE PRET (R-AMT-3)
 * @property {Revisabilite|string} [revisabilite] defaut 'TAUX FIXE'
 * @property {number} [differe_ans]              d, defaut 0
 * @property {1|2} [differe_type]                1 = annuite 0, interets capitalises ; 2 = interets seuls
 * @property {number} [livret_a_origine]         LA_0 a l'origine du pret (requis si revisable)
 * @property {Record<number, number>} [livret_a_par_annee] trajectoire LA (annee civile -> taux)
 *
 * @typedef {Object} LigneAmortissement
 * @property {number} annee             annee civile de l'echeance
 * @property {number} taux              taux d'interet applique (tx_N)
 * @property {number} annuite_eur
 * @property {number} interets_eur
 * @property {number} amortissement_eur annuite - interets (negatif en differe type 1 : le CRD croit)
 * @property {number} crd_eur           capital restant du en fin d'annee
 */

/**
 * R-AMT-2/3/4/5 — Table d'amortissement annuelle d'un pret.
 *
 * Deroulement : d annees de differe (type 1 : annuite nulle, interets capitalises
 * au CRD ; type 2 : annuite = interets, CRD constant), puis n-d echeances
 * amortissantes. La premiere annuite vient de la forme fermee R-AMT-2 (pas
 * d'accumulation iterative, lecon I-4), les suivantes sont revisees selon
 * R-AMT-4. Arret : derniere echeance de la duree, ou des que ROUND(CRD,4) <= 0 ;
 * dans les deux cas la derniere annuite est ajustee pour solder exactement le
 * CRD (annuite = CRD precedent + interets — hypothese FK117, QUESTIONS_SPEC Q-1).
 *
 * Aucune valeur n'est arrondie dans la table (les arrondis s'appliquent aux
 * frontieres de presentation, R-CONV / I-9) ; seul le test d'arret utilise
 * arrondiCRD, comme LEON.
 *
 * @param {PretEntree} pret
 * @returns {LigneAmortissement[]}
 */
export function tableauAmortissement(pret) {
  const {
    montant_eur,
    taux,
    progressivite = 0,
    duree_ans,
    annee_premiere_echeance,
    revisabilite = 'TAUX FIXE',
    differe_ans = 0,
    differe_type,
    livret_a_origine,
    livret_a_par_annee,
  } = pret;

  if (montant_eur === 0) return [];
  if (!(montant_eur > 0)) throw new Error(`Montant de pret invalide : ${montant_eur}`);
  if (!Number.isInteger(duree_ans) || duree_ans <= 0) {
    throw new Error(`Duree de pret invalide : ${duree_ans}`);
  }
  if (!Number.isInteger(annee_premiere_echeance)) {
    throw new Error(`Annee de premiere echeance invalide : ${annee_premiere_echeance}`);
  }
  if (differe_ans < 0 || differe_ans >= duree_ans) {
    throw new Error(`Differe invalide : ${differe_ans} an(s) pour un pret de ${duree_ans} an(s)`);
  }
  if (differe_ans > 0 && differe_type !== 1 && differe_type !== 2) {
    throw new Error(`Type de differe invalide : ${differe_type} (attendu 1 ou 2)`);
  }

  const rev = normaliserRevisabilite(String(revisabilite));
  const revisable = rev !== 'TAUX FIXE';
  if (revisable && livret_a_par_annee && livret_a_origine === undefined) {
    throw new Error('livret_a_origine est requis pour un pret revisable avec trajectoire');
  }
  // Sans trajectoire fournie, LA_N = LA_0 : les formules R-AMT-4 se reduisent a t et p.
  const la0 = livret_a_origine ?? 0;

  /** @type {LigneAmortissement[]} */
  const lignes = [];
  let crd = montant_eur;
  let annee = annee_premiere_echeance;

  // --- Phase de differe (R-AMT-4) ---
  for (let i = 0; i < differe_ans; i++, annee++) {
    const laN = livretAPourAnnee(livret_a_par_annee, annee, la0);
    const tx = tauxInteretRevise(rev, taux, laN, la0);
    const interets = tx * crd;
    if (differe_type === 1) {
      // Annuite nulle, interets capitalises : le CRD croit.
      crd += interets;
      lignes.push({
        annee,
        taux: tx,
        annuite_eur: 0,
        interets_eur: interets,
        amortissement_eur: -interets,
        crd_eur: crd,
      });
    } else {
      // Interets seuls : le CRD est inchange.
      lignes.push({
        annee,
        taux: tx,
        annuite_eur: interets,
        interets_eur: interets,
        amortissement_eur: 0,
        crd_eur: crd,
      });
    }
  }

  // --- Phase amortissante ---
  const nbEcheances = duree_ans - differe_ans;

  if (taux === 0) {
    // I-8 : taux nul -> amortissement lineaire, quel que soit le profil.
    const amortConstant = crd / nbEcheances;
    for (let i = 1; i <= nbEcheances; i++, annee++) {
      const amort = i === nbEcheances ? crd : amortConstant;
      crd -= amort;
      lignes.push({
        annee,
        taux: 0,
        annuite_eur: amort,
        interets_eur: 0,
        amortissement_eur: amort,
        crd_eur: i === nbEcheances ? 0 : crd,
      });
    }
    return lignes;
  }

  let annuite = premiereAnnuite({
    montant_eur: crd,
    taux,
    progressivite,
    nb_echeances: nbEcheances,
  });

  for (let i = 1; i <= nbEcheances; i++, annee++) {
    const laN = livretAPourAnnee(livret_a_par_annee, annee, la0);
    const tx = tauxInteretRevise(rev, taux, laN, la0);
    if (i > 1) {
      annuite *= 1 + tauxRevisionAnnuite(rev, taux, progressivite, laN, la0);
    }
    const interets = tx * crd;
    const amort = annuite - interets;

    if (i === nbEcheances || arrondiCRD(crd - amort) <= 0) {
      // Derniere echeance ajustee : solde exact du CRD (R-AMT-4 / Q-1).
      lignes.push({
        annee,
        taux: tx,
        annuite_eur: crd + interets,
        interets_eur: interets,
        amortissement_eur: crd,
        crd_eur: 0,
      });
      break;
    }

    crd -= amort;
    lignes.push({
      annee,
      taux: tx,
      annuite_eur: annuite,
      interets_eur: interets,
      amortissement_eur: amort,
      crd_eur: crd,
    });
  }

  return lignes;
}

/**
 * @typedef {Object} Tirage
 * @property {number} montant_eur
 * @property {number} mois_avant_location nombre de mois entre le tirage et la mise en location (DAT)
 */

/**
 * R-FIN-6 — Interets de prefinancement par echeancier de tirages mensuels.
 * interets = somme(tirages capitalises jusqu'a la DAT) - somme(nominal).
 * HYPOTHESE en attente de la transcription de SimPLUS!FA15:FD27 (QUESTIONS_SPEC
 * Q-3) : capitalisation mensuelle au taux proportionnel taux/12.
 * Le flag « ne pas capitaliser » (SimPLUS) ne supprime pas le cout des interets,
 * il empeche seulement leur incorporation au capital du pret.
 * @param {Object} p
 * @param {Tirage[]} p.tirages
 * @param {number} p.taux taux annuel du prefinancement (fraction)
 * @param {boolean} [p.capitaliser] defaut true ; false = flag « ne pas capitaliser »
 * @returns {{nominal_eur: number, interets_eur: number, capital_constitue_eur: number}}
 */
export function prefinancement({ tirages, taux, capitaliser = true }) {
  const tauxMensuel = taux / MOIS_PAR_AN;
  let nominal = 0;
  let capitalise = 0;
  for (const { montant_eur, mois_avant_location } of tirages) {
    if (mois_avant_location < 0) {
      throw new Error(`Tirage posterieur a la mise en location : ${mois_avant_location} mois`);
    }
    nominal += montant_eur;
    capitalise += montant_eur * (1 + tauxMensuel) ** mois_avant_location;
  }
  const interets = capitalise - nominal;
  return {
    nominal_eur: nominal,
    interets_eur: interets,
    capital_constitue_eur: capitaliser ? nominal + interets : nominal,
  };
}
