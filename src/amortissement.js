// @ts-check
/**
 * R-AMT - Tableaux d'amortissement des prets (coeur du moteur, cible +/-0,1 %
 * vs LEON).
 *
 * LES FORMULES VIVENT DANS `formules/domaines/amortissement.js` : le taux et la
 * progression revises chaque annee selon le Livret A et la revisabilite, le
 * facteur d'annuite de la forme fermee, l'annuite, les interets, le capital
 * rembourse et restant du - echeance par echeance pour les prets
 * infra-annuels. Transcription des formules vivantes de la matrice LEON
 * (SimPLUS!FF117:FN117, SimPLUS!AM15, SimLIB!FG8/FH8).
 *
 * Ce module restitue le tableau d'un pret tel que l'ecran et le compte
 * d'exploitation le lisent, et garde les fonctions historiques
 * (`tableauAmortissement`, `facteurAnnuite`, `normaliserRevisabilite`), qui
 * evaluent ces memes formules sur les caracteristiques qu'on leur donne.
 *
 * Unites : montants en euros, taux en fraction (0.021 = 2,1 %), durees en annees.
 * Module pur : la trajectoire du Livret A et les dates sont des ENTREES, jamais
 * lues d'une horloge, d'un fichier ou d'un etat global.
 */
import { nouveauClasseur } from './formules/modele.js';
import { jourUTC, MS_PAR_JOUR } from './dates.js';

// L'arithmetique des dates vit dans `dates.js`. Les deux noms restent exportes
// d'ici pour les appelants qui les y cherchent.
export { jourUTC, MS_PAR_JOUR };

/** @typedef {'DOUBLE'|'D.LIMITEE'|'SIMPLE'|'TAUX FIXE'} Revisabilite */

/**
 * Classeur reduit a UN pret, dont les caracteristiques sont posees telles
 * quelles : les formules du tableau les lisent a la place de celles du plan de
 * financement.
 * @param {Record<string, any>} caracteristiques  identifiant de grandeur -> valeur
 */
function classeurDePret(caracteristiques) {
  const c = nouveauClasseur({}).fixerDimension('pret', ['P']);
  for (const [id, v] of Object.entries(caracteristiques)) c.fixer(id, { pret: 'P' }, v);
  return c;
}

/**
 * Normalise un libelle de revisabilite tel que saisi dans LEON (« D. LIMITEE »
 * avec espace, « TAUX FIXE »...) vers la forme canonique. Formule :
 * `revisabilite_canonique`.
 * @param {string} libelle
 * @returns {Revisabilite}
 */
export function normaliserRevisabilite(libelle) {
  return classeurDePret({ revisabilite_pret: libelle }).valeur('revisabilite_canonique', { pret: 'P' });
}

/**
 * R-AMT-3 - Annee de premiere echeance d'un pret CDC : l'annee de la MISE EN
 * LOCATION elle-meme. Le pret est mobilise a la livraison, il commence a
 * s'amortir dans la foulee ; les interets de la periode de chantier sont deja
 * portes par le prefinancement (R-FIN-6), capitalise au capital emprunte.
 *
 * Le dictionnaire v0.1 lisait « annee(DAT) + 1 » dans LEON. Deux annexes le
 * contredisent - OP-3 et OP-6 demarrent l'annee de la mise en location -
 * et le metier a tranche le 11/08/2026 pour le decalage nul (Q-4, Q-28).
 * @param {number} annee_mise_en_location annee civile de la mise en location (DAT)
 * @param {{demembrement?: boolean}} [_options] conserve pour compatibilite d'appel
 * @returns {number}
 */
export function anneePremiereEcheance(annee_mise_en_location, _options = {}) {
  return annee_mise_en_location;
}

/**
 * Facteur d'annuite de la forme fermee (SimPLUS!AM15, sans le capital) :
 * (1+tx) x (1 - q) / (1 - q^m) avec q = (1+rev)/(1+tx). Formule : `facteur_annuite`.
 * @param {number} tx  taux d'interet de la periode
 * @param {number} rev taux de progression des annuites
 * @param {number} m   nombre d'echeances restantes
 * @returns {number}
 */
export function facteurAnnuite(tx, rev, m) {
  const I = { pret: 'P', annee_pret: 'A' };
  return nouveauClasseur({})
    .fixerDimension('pret', ['P'])
    .fixerDimension('annee_pret', ['A'], { pret: 'P' })
    .fixer('taux_annee', I, tx)
    .fixer('rev_annee', I, rev)
    .fixer('echeances_restantes', I, m)
    .valeur('facteur_annuite', I);
}

/**
 * R-AMT-2 - Premiere annuite d'un pret a profil progressif :
 * annuite_1 = K x facteurAnnuite(t, p, duree - differe). Le cas degenere
 * t = 0 ET p = 0 s'amortit lineairement, comme la branche `K/(duree-differe)`
 * de SimPLUS!FK117.
 * @param {{montant_eur: number, taux: number, progressivite: number, nb_echeances: number}} p
 * @returns {number} annuite de la premiere echeance, en euros
 */
export function premiereAnnuite({ montant_eur, taux, progressivite, nb_echeances }) {
  if (taux === 0 && progressivite === 0) return montant_eur / nb_echeances;
  return montant_eur * facteurAnnuite(taux, progressivite, nb_echeances);
}

/**
 * @typedef {Object} LigneAmortissement
 * @property {number} annee             annee civile de l'echeance
 * @property {number} taux              taux d'interet applique
 * @property {number} annuite_eur
 * @property {number} interets_eur
 * @property {number} amortissement_eur
 * @property {number} crd_eur           capital restant du en fin d'annee
 */

/**
 * Tableau d'amortissement d'un pret du classeur, une ligne par annee.
 * @param {import('./formules/classeur.js').Classeur} c
 * @param {any} pret  cle du pret dans la dimension « pret »
 * @returns {LigneAmortissement[]}
 */
export function restituerTableau(c, pret) {
  return c.valeursDimension('annee_pret', { pret }).map((annee) => {
    const I = { pret, annee_pret: annee };
    return {
      annee,
      taux: c.valeur('taux_annee', I),
      annuite_eur: c.valeur('annuite_pret', I),
      interets_eur: c.valeur('interets_pret', I),
      amortissement_eur: c.valeur('amortissement_pret', I),
      crd_eur: c.valeur('crd_pret', I),
    };
  });
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
 */

/**
 * R-AMT-2/3/4/5 - Table d'amortissement annuelle d'un pret, a partir de ses
 * caracteristiques. Formules du domaine « amortissement ».
 * @param {PretEntree} pret
 * @returns {LigneAmortissement[]} une ligne par annee de la duree du pret
 */
export function tableauAmortissement(pret) {
  const {
    montant_eur,
    taux,
    progressivite = 0,
    duree_ans,
    annee_premiere_echeance,
    revisabilite = 'TAUX FIXE',
    differe_type,
    livret_a_origine,
    livret_a_par_annee,
    profil = 'annuite',
    taux_plancher,
    periodicite = 1,
  } = pret;
  const c = classeurDePret({
    montant_pret: montant_eur,
    taux_pret: taux,
    progressivite_pret: progressivite,
    duree_ans_pret: duree_ans,
    annee_premiere_echeance_pret: annee_premiere_echeance,
    revisabilite_pret: revisabilite,
    differe_ans_pret: pret.differe_ans ?? 0,
    differe_mois_pret: pret.differe_mois,
    differe_type_pret: differe_type,
    profil_pret: profil,
    taux_plancher_pret: taux_plancher,
    periodicite_pret: periodicite,
    livret_a_origine_final: livret_a_origine,
    livret_a_par_annee_final: livret_a_par_annee,
  });
  return restituerTableau(c, 'P');
}

/**
 * @typedef {Object} Tirage
 * @property {number} montant_eur
 * @property {string|Date} date date du tirage (AAAA-MM-JJ)
 */

/**
 * R-FIN-6 - Interets de prefinancement par echeancier de tirages dates.
 *
 * Transcription de SimPLUS!FA15:FD27 : capitalisation ACTUARIELLE de chaque
 * tirage en base exact/365, jusqu'a la date du DERNIER tirage a defaut de date
 * de fin. Formules `prefinancement_*` du domaine « financement ».
 *
 * @param {Object} p
 * @param {Tirage[]} p.tirages
 * @param {number} p.taux        taux annuel du prefinancement (fraction)
 * @param {string|Date} [p.date_fin] defaut : date du dernier tirage
 * @param {boolean} [p.capitaliser] defaut true
 * @returns {{nominal_eur: number, interets_eur: number, capital_constitue_eur: number}}
 */
export function prefinancement({ tirages, taux, date_fin, capitaliser = true }) {
  const c = nouveauClasseur({ entrees: { prefinancement: { tirages, taux, date_fin, capitaliser } } });
  return {
    nominal_eur: c.valeur('prefinancement_nominal'),
    interets_eur: c.valeur('prefinancement_interets'),
    capital_constitue_eur: c.valeur('prefinancement_capital_constitue'),
  };
}
