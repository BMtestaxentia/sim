// @ts-check
/**
 * R-AMT - Moteur d'amortissement des prets (coeur du moteur, cible +/-0,1 % vs LEON).
 *
 * Transcription etablie a partir des formules VIVANTES de la matrice LEON
 * (classeur BERGERAC 07/2026, meme version 131 onglets que la matrice de
 * reference) : SimPLUS!FF117:FN117 pour le tableau d'amortissement,
 * SimPLUS!AM15 pour le facteur d'annuite affiche, SimPLUS!FA15:FD27 pour la
 * capitalisation du prefinancement, SimLIB!FG8/FH8 pour la variante taux fixe.
 *
 * Regles couvertes :
 * - R-AMT-2 : forme fermee de l'annuite (SimPLUS!AM15 = facteur, hors capital).
 * - R-AMT-3 : annee de premiere echeance PAR PRET (SimPLUS!AM17/AR17...).
 *   C'est la regle dont la violation causait le bug historique ALS.
 * - R-AMT-4 : RE-AMORTISSEMENT annuel (et non progression geometrique de
 *   l'annuite) : chaque annee, l'annuite est recalculee par la forme fermee sur
 *   le CRD restant et la duree restante m_N = duree - (annee_N - annee_1re_echeance),
 *   aux taux revises de l'annee. Les deux formulations coincident exactement
 *   tant que le Livret A ne bouge pas ; elles divergent des qu'il bouge.
 * - R-AMT-5 : table par pret (annee -> taux, annuite, interets, amortissement, CRD).
 * - R-FIN-6 : interets de prefinancement, capitalisation ACTUARIELLE base
 *   exact/365 jusqu'a la date du dernier tirage.
 *
 * Unites : montants en euros, taux en fraction (0.021 = 2,1 %), durees en annees.
 * Module pur : la trajectoire du Livret A et les dates sont des ENTREES, jamais
 * lues d'une horloge, d'un fichier ou d'un etat global.
 */
import { arrondiCRD } from './arrondis.js';

/**
 * Base de jours de la capitalisation du prefinancement : exact/365.
 * Convention lue dans la formule source SimPLUS!FA15 (`(FA$14-AL23)/365`),
 * ce n'est pas un parametre de bareme mais la convention de calcul de LEON.
 */
const BASE_JOURS_ACT365 = 365;

/** Millisecondes par jour (constante calendaire). Source unique du projet. */
export const MS_PAR_JOUR = 86400000;

/** @typedef {'DOUBLE'|'D.LIMITEE'|'SIMPLE'|'TAUX FIXE'} Revisabilite */

/**
 * Libelles rencontres dans LEON (SimPLUS!AM19, onglet IN) -> forme canonique.
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
 * Normalise un libelle de revisabilite tel que saisi dans LEON
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
 * R-AMT-3 - Annee de premiere echeance d'un pret CDC : l'annee de la MISE EN
 * LOCATION elle-meme. Le pret est mobilise a la livraison, il commence a
 * s'amortir dans la foulee ; les interets de la periode de chantier sont deja
 * portes par le prefinancement (R-FIN-6), capitalise au capital emprunte.
 *
 * Le dictionnaire v0.1 lisait « annee(DAT) + 1 » dans LEON. Deux annexes le
 * contredisent - BERGERAC et ORLEANS demarrent l'annee de la mise en location -
 * et le metier a tranche le 11/08/2026 pour le decalage nul (Q-4, Q-28). Le
 * decalage de demembrement devient donc sans objet.
 *
 * Les prets « autres » portent leur propre date saisie (SimPLUS!AR17...) et ne
 * passent pas par cette fonction : chacun garde SA date.
 * @param {number} annee_mise_en_location annee civile de la mise en location (DAT)
 * @param {{demembrement?: boolean}} [options] conserve pour compatibilite d'appel
 * @returns {number}
 */
export function anneePremiereEcheance(annee_mise_en_location, _options = {}) {
  return annee_mise_en_location;
}

/**
 * Facteur d'annuite de la forme fermee (SimPLUS!AM15, sans le capital) :
 * (1+tx) x (1 - q) / (1 - q^m) avec q = (1+rev)/(1+tx).
 * Multiplie par un capital, il donne l'annuite qui amortit exactement ce capital
 * en m echeances progressant au taux `rev`, au taux d'interet `tx`.
 * @param {number} tx  taux d'interet de la periode
 * @param {number} rev taux de progression des annuites
 * @param {number} m   nombre d'echeances restantes
 * @returns {number}
 */
export function facteurAnnuite(tx, rev, m) {
  if (!(m > 0)) throw new Error(`Nombre d'echeances invalide : ${m}`);
  const q = (1 + rev) / (1 + tx);
  // q = 1 <=> rev = tx : LEON produit #DIV/0! ; la limite mathematique est (1+tx)/m.
  if (q === 1) return (1 + tx) / m;
  return ((1 + tx) * (1 - q)) / (1 - q ** m);
}

/**
 * R-AMT-2 - Premiere annuite d'un pret a profil progressif.
 * annuite_1 = K x facteurAnnuite(t, p, duree - differe).
 *
 * Ecart documente avec LEON : la cellule d'affichage SimPLUS!AM15 renvoie 0
 * quand t = 0 (irregularite I-8), mais le TABLEAU d'amortissement, lui, ne
 * l'utilise pas et traite le cas t = 0 correctement. Le cas reellement degenere
 * est t = 0 ET p = 0, ou LEON amortit lineairement (branche `K/(duree-differe)`
 * de SimPLUS!FK117) : c'est cette regle-la qui est implementee ici.
 * @param {Object} p
 * @param {number} p.montant_eur   K : capital a amortir
 * @param {number} p.taux          t : taux d'interet initial (fraction)
 * @param {number} p.progressivite p : taux de progressivite des annuites (fraction, ex. -0.005)
 * @param {number} p.nb_echeances  m : nombre d'echeances amortissantes (duree - differe)
 * @returns {number} annuite de la premiere echeance, en euros
 */
export function premiereAnnuite({ montant_eur, taux, progressivite, nb_echeances }) {
  if (taux === 0 && progressivite === 0) return montant_eur / nb_echeances;
  return montant_eur * facteurAnnuite(taux, progressivite, nb_echeances);
}

/**
 * Livret A applicable une annee donnee. Reproduit le VLOOKUP approche de LEON
 * (SimPLUS!FJ117 -> ParaGEN!CT22:DD102, colonne 11) : valeur exacte si l'annee
 * est dans la table, sinon derniere valeur anterieure. Hors table par le bas,
 * LEON renvoie #N/A ; ici on retombe sur le LA d'origine (aucune revision).
 * @param {Record<number, number>|null|undefined} livret_a_par_annee
 * @param {number} annee
 * @param {number} defaut LA d'origine du pret
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
 * @typedef {Object} PretEntree
 * @property {number} montant_eur                capital emprunte (0 -> table vide, pret non mobilise)
 * @property {number} taux                       taux d'interet initial t (fraction)
 * @property {number} [progressivite]            p, defaut 0
 * @property {number} duree_ans                  n : duree totale, differe inclus
 * @property {number} annee_premiere_echeance    annee civile de la 1re echeance DE CE PRET (R-AMT-3)
 * @property {Revisabilite|string} [revisabilite] defaut 'TAUX FIXE'
 * @property {number} [differe_ans]              d, defaut 0
 * @property {number} [differe_mois]             R-AMT-9 : differe en MOIS, prioritaire sur `differe_ans`
 * @property {1|2} [differe_type]                1 = rien n'est du ; 2 = interets seuls
 * @property {number} [livret_a_origine]         LA_0 a l'origine du pret (plage nommee Tx_LA)
 * @property {Record<number, number>} [livret_a_par_annee] trajectoire LA (annee civile -> taux)
 * @property {'annuite'|'constant'} [profil] R-AMT-6 : annuite progressive (defaut) ou capital constant
 * @property {number} [taux_plancher]        R-AMT-7 : plancher du taux applique (prets indexes sous le LA)
 * @property {number} [periodicite]          R-AMT-8 : echeances par an (1 annuelle, 4 trimestrielle...)
 *
 * @typedef {Object} LigneAmortissement
 * @property {number} annee             annee civile de l'echeance
 * @property {number} taux              taux d'interet applique (tx_N)
 * @property {number} annuite_eur
 * @property {number} interets_eur
 * @property {number} amortissement_eur
 * @property {number} crd_eur           capital restant du en fin d'annee
 */

/**
 * R-AMT-2/3/4/5 - Table d'amortissement annuelle d'un pret.
 *
 * Transcription de SimPLUS!FF117:FN117. Pour chaque annee N (k = 0..duree-1,
 * annee = annee_premiere_echeance + k) :
 *   LA_N   = trajectoire(annee), a defaut LA_0
 *   tx_N   = t si TAUX FIXE, sinon (1+t)(1 + (LA_N-LA_0)/(1+t)) - 1   [FJ]
 *   rev_N  = DOUBLE -> (1+p)(1 + (LA_N-LA_0)/(1+t)) - 1               [FF/FI]
 *            D.LIMITEE -> MAX(ci-dessus, 0) ; sinon -> p
 *   pendant le differe (k < d) : amortissement 0, CRD inchange,
 *            interets = 0 (type 1) ou tx_N x CRD (type 2), annuite = interets
 *   sinon    annuite = CRD_{N-1} x facteurAnnuite(tx_N, rev_N, duree - k)   [FK]
 *            interets = tx_N x CRD_{N-1} ; amortissement = annuite - interets
 *            CRD_N = CRD_{N-1} - amortissement
 *
 * La derniere echeance n'est PAS un cas particulier : a la derniere annee
 * m_N = 1, donc facteurAnnuite = (1+tx) et l'annuite solde exactement le CRD.
 * Si le CRD est deja epuise (ROUND(CRD,4) <= 0), l'annuite est nulle et la
 * ligne reste dans la table, comme dans LEON.
 *
 * Aucune valeur n'est arrondie dans la table (les arrondis s'appliquent aux
 * frontieres de presentation, R-CONV / I-9) ; seul le test d'arret utilise
 * arrondiCRD, comme LEON.
 *
 * @param {PretEntree} pret
 * @returns {LigneAmortissement[]} une ligne par annee de la duree du pret
 */
/**
 * R-AMT-8 - Amortissement a echeances INFRA-ANNUELLES, agrege par annee civile.
 *
 * Convention de taux : le taux de periode est PROPORTIONNEL, taux annuel divise
 * par le nombre d'echeances. C'est l'usage des prets reglementes, et la fiche
 * produit d'Action Logement ne dit rien de plus - le choix est donc documente
 * ici plutot que suppose ailleurs. La convention actuarielle, (1+t)^(1/m)-1,
 * donnerait des interets legerement plus faibles.
 *
 * Le taux et la progression sont revises UNE FOIS PAR AN, comme sur un pret
 * annuel : c'est le Livret A qui les commande, et il ne bouge pas au trimestre.
 *
 * @param {PretEntree} pret
 * @param {{rev: Revisabilite, la0: number}} contexte deja normalises par l'appelant
 * @returns {LigneAmortissement[]}
 */
/**
 * R-AMT-9 - Differe exprime en PERIODES d'echeance.
 *
 * Le differe se saisit desormais en MOIS, parce que c'est l'unite du chantier :
 * un pret principal differe le temps des travaux, et un chantier de trente mois
 * ne fait pas un nombre entier d'annees. Il se convertit ici en periodes
 * d'echeance, arrondies a l'entier le plus proche - la moitie d'une echeance
 * n'existe pas, et un pret annuel ne peut pas commencer a s'amortir en juin.
 *
 * `differe_ans` reste accepte pour les appels qui raisonnent en annees, dont
 * les fixtures : il vaut alors autant de periodes que d'annees fois la
 * periodicite.
 * @param {PretEntree} pret
 * @param {number} m nombre d'echeances par an
 * @returns {number}
 */
function differeEnPeriodes(pret, m) {
  return pret.differe_mois !== undefined && pret.differe_mois !== null
    ? Math.round((Number(pret.differe_mois) * m) / 12)
    : (pret.differe_ans ?? 0) * m;
}

function tableauPeriodique(pret, { rev, la0 }) {
  const {
    montant_eur,
    taux,
    progressivite = 0,
    duree_ans,
    annee_premiere_echeance,
    differe_ans = 0,
    differe_type,
    livret_a_par_annee,
    profil = 'annuite',
    taux_plancher,
    periodicite: m,
  } = pret;

  /** @type {LigneAmortissement[]} */
  const lignes = [];
  let crd = montant_eur;
  // R-AMT-9 : le differe se compte en PERIODES. Un differe de 30 mois sur un
  // pret trimestriel vaut dix echeances, ce qu'une duree en annees entieres ne
  // sait pas dire.
  const differePeriodes = differeEnPeriodes(pret, m);
  const periodesAmortissantes = duree_ans * m - differePeriodes;

  for (let k = 0; k < duree_ans; k++) {
    const annee = annee_premiere_echeance + k;
    const laN = livretAPourAnnee(livret_a_par_annee, annee, la0);
    const ecartLA = (laN - la0) / (1 + taux);
    const txBrut = rev === 'TAUX FIXE' ? taux : (1 + taux) * (1 + ecartLA) - 1;
    const txAnnuel = taux_plancher === undefined ? txBrut : Math.max(txBrut, taux_plancher);
    const revBrut = (1 + progressivite) * (1 + ecartLA) - 1;
    const revAnnuel =
      rev === 'DOUBLE' ? revBrut : rev === 'D.LIMITEE' ? Math.max(revBrut, 0) : progressivite;

    const txp = txAnnuel / m;
    // La progression est ANNUELLE : repartie sur les periodes, elle vaut la
    // racine m-ieme. Sans cette racine, une progression de -0,5 % par an
    // deviendrait -2 % par an sur un pret trimestriel.
    const revp = (1 + revAnnuel) ** (1 / m) - 1;

    let interetsAnnee = 0;
    let amortAnnee = 0;
    for (let j = 0; j < m; j++) {
      const periode = k * m + j;
      if (periode < differePeriodes) {
        interetsAnnee += differe_type === 1 ? 0 : txp * crd;
        continue;
      }
      if (arrondiCRD(crd) <= 0) continue;
      const restantes = periodesAmortissantes - (periode - differePeriodes);
      const amort =
        profil === 'constant'
          ? montant_eur / periodesAmortissantes
          : (txp === 0 && revp === 0
              ? montant_eur / periodesAmortissantes
              : crd * facteurAnnuite(txp, revp, restantes)) - txp * crd;
      interetsAnnee += txp * crd;
      amortAnnee += amort;
      crd -= amort;
    }

    lignes.push({
      annee,
      taux: txAnnuel,
      annuite_eur: interetsAnnee + amortAnnee,
      interets_eur: interetsAnnee,
      amortissement_eur: amortAnnee,
      crd_eur: crd,
    });
  }
  return lignes;
}

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
    profil = 'annuite',
    taux_plancher,
    periodicite = 1,
  } = pret;

  if (montant_eur === 0) return [];
  if (!(montant_eur > 0)) throw new Error(`Montant de pret invalide : ${montant_eur}`);
  if (!Number.isInteger(duree_ans) || duree_ans <= 0) {
    throw new Error(`Duree de pret invalide : ${duree_ans}`);
  }
  if (!Number.isInteger(annee_premiere_echeance)) {
    throw new Error(`Annee de premiere echeance invalide : ${annee_premiere_echeance}`);
  }
  const differeControle = differeEnPeriodes(pret, periodicite) / periodicite;
  if (differeControle < 0 || differeControle >= duree_ans) {
    throw new Error(`Differe invalide : ${differeControle} an(s) pour un pret de ${duree_ans} an(s)`);
  }
  if (differeControle > 0 && differe_type !== 1 && differe_type !== 2) {
    throw new Error(`Type de differe invalide : ${differe_type} (attendu 1 ou 2)`);
  }

  const rev = normaliserRevisabilite(String(revisabilite));
  const la0 = livret_a_origine ?? 0;
  // R-AMT-9 : a periodicite annuelle, une periode EST une annee.
  const differeAns = differeEnPeriodes(pret, 1);

  // R-AMT-8 - ECHEANCES INFRA-ANNUELLES. Les prets Action Logement s'amortissent
  // par trimestre. Le compte d'exploitation, lui, reste annuel : on amortit donc
  // a la PERIODE puis on agrege par annee civile. Un pret trimestriel ne se
  // ramene pas a un pret annuel de meme taux - le capital recule quatre fois
  // dans l'annee, donc les interets de l'annee sont plus faibles.
  //
  // Chemin separe et non branche dans la boucle annuelle : celle-ci transcrit
  // SimPLUS!FF117:FN117 et porte tous les golden tests. La laisser intacte
  // garantit qu'aucun pret annuel ne change de comportement.
  if (periodicite > 1) {
    return tableauPeriodique(pret, { rev, la0 });
  }

  /** @type {LigneAmortissement[]} */
  const lignes = [];
  let crd = montant_eur;

  for (let k = 0; k < duree_ans; k++) {
    const annee = annee_premiere_echeance + k;
    const laN = livretAPourAnnee(livret_a_par_annee, annee, la0);
    const ecartLA = (laN - la0) / (1 + taux);

    // [FJ] Le taux d'interet suit le Livret A sauf en taux fixe (garde SimLIB!FH8 ;
    // le bloc CDC de SimPLUS omet cette garde, cf. ECARTS_LEON E-3).
    //
    // R-AMT-7 - TAUX PLANCHER. Les prets Action Logement sont indexes SOUS le
    // Livret A - jusqu'a -225 points de base - et leur fiche produit fixe un
    // plancher de 0,25 %. Sans lui, un Livret A a 1,50 % donnerait un taux
    // NEGATIF : le pret rapporterait de l'argent a l'emprunteur, ce qu'aucune
    // fiche ne prevoit. Le plancher borne le taux applique, jamais la marge.
    const txBrut = rev === 'TAUX FIXE' ? taux : (1 + taux) * (1 + ecartLA) - 1;
    const tx = taux_plancher === undefined ? txBrut : Math.max(txBrut, taux_plancher);

    // [FF/FI] Revision de la progression de l'annuite selon la revisabilite.
    const revBrut = (1 + progressivite) * (1 + ecartLA) - 1;
    const revN =
      rev === 'DOUBLE' ? revBrut : rev === 'D.LIMITEE' ? Math.max(revBrut, 0) : progressivite;

    if (k < differeAns) {
      // Differe : aucun amortissement, CRD inchange. Type 1 -> rien n'est du
      // (LEON ne capitalise PAS ces interets, cf. ECARTS_LEON E-2).
      const interets = differe_type === 1 ? 0 : tx * crd;
      lignes.push({
        annee,
        taux: tx,
        annuite_eur: interets,
        interets_eur: interets,
        amortissement_eur: 0,
        crd_eur: crd,
      });
      continue;
    }

    // R-AMT-6 - Amortissement CONSTANT : c'est le CAPITAL qui est constant, et
    // non l'annuite. Chaque echeance rembourse la meme fraction du capital
    // d'origine, plus les interets du CRD - l'annuite decroit donc d'annee en
    // annee. C'est le profil de la seconde phase du PHB 2.0, et il ne se
    // confond pas avec la branche lineaire ci-dessous, qui ne vaut qu'a taux
    // nul : ici le taux joue, il ne fait varier que la part d'interets.
    if (profil === 'constant') {
      const solde = arrondiCRD(crd) <= 0;
      const amort = solde ? 0 : montant_eur / (duree_ans - differeAns);
      const interets = solde ? 0 : tx * crd;
      crd -= amort;
      lignes.push({
        annee,
        taux: tx,
        annuite_eur: amort + interets,
        interets_eur: interets,
        amortissement_eur: amort,
        crd_eur: crd,
      });
      continue;
    }

    let annuite;
    if (arrondiCRD(crd) <= 0) {
      annuite = 0; // pret deja solde : LEON continue d'emettre des lignes a zero
    } else if ((taux === 0 && progressivite === 0) || (revN === 0 && tx === 0)) {
      // Branche lineaire de FK117 : capital d'ORIGINE / duree amortissante.
      annuite = montant_eur / (duree_ans - differeAns);
    } else {
      annuite = crd * facteurAnnuite(tx, revN, duree_ans - k);
    }

    const interets = tx * crd;
    const amort = annuite - interets;
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
 * Numero de jour UTC d'une date exprimee en ISO 'AAAA-MM-JJ' (ou d'un objet Date).
 * Pas d'horloge systeme : la date est toujours une entree explicite.
 * @param {string|Date} date
 * @returns {number}
 */
export function jourUTC(date) {
  if (date instanceof Date) {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / MS_PAR_JOUR;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  if (!m) throw new Error(`Date attendue au format AAAA-MM-JJ : ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / MS_PAR_JOUR;
}

/**
 * @typedef {Object} Tirage
 * @property {number} montant_eur
 * @property {string|Date} date date du tirage (AAAA-MM-JJ)
 */

/**
 * R-FIN-6 - Interets de prefinancement par echeancier de tirages dates.
 *
 * Transcription de SimPLUS!FA15:FD27 :
 *   capitalise = SOMME( montant_i x (1 + taux) ^ ((date_fin - date_i) / 365) )
 *   interets   = capitalise - SOMME(montant_i)
 * La capitalisation est ACTUARIELLE (puissance fractionnaire du taux annuel) en
 * base exact/365, et court jusqu'a `date_fin` = date du DERNIER tirage
 * (SimPLUS!FA14 = $AL$35), pas jusqu'a la mise en location.
 *
 * Le flag « ne pas capitaliser les interets de prefinancement » (SimPLUS!AS24)
 * ne supprime pas le cout des interets : il empeche seulement leur incorporation
 * au capital du pret.
 *
 * @param {Object} p
 * @param {Tirage[]} p.tirages
 * @param {number} p.taux        taux annuel du prefinancement (fraction)
 * @param {string|Date} [p.date_fin] defaut : date du dernier tirage
 * @param {boolean} [p.capitaliser] defaut true
 * @returns {{nominal_eur: number, interets_eur: number, capital_constitue_eur: number}}
 */
export function prefinancement({ tirages, taux, date_fin, capitaliser = true }) {
  if (!tirages.length) return { nominal_eur: 0, interets_eur: 0, capital_constitue_eur: 0 };
  const jours = tirages.map((t) => jourUTC(t.date));
  const jourFin = date_fin === undefined ? Math.max(...jours) : jourUTC(date_fin);

  let nominal = 0;
  let capitalise = 0;
  tirages.forEach((tirage, i) => {
    if (jours[i] > jourFin) {
      throw new Error(`Tirage posterieur a la date de fin de capitalisation : ${tirage.date}`);
    }
    nominal += tirage.montant_eur;
    capitalise += tirage.montant_eur * (1 + taux) ** ((jourFin - jours[i]) / BASE_JOURS_ACT365);
  });

  const interets = capitalise - nominal;
  return {
    nominal_eur: nominal,
    interets_eur: interets,
    capital_constitue_eur: capitaliser ? nominal + interets : nominal,
  };
}
