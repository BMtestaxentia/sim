// @ts-check
/**
 * LE MODELE DU MOTEUR : toutes les grandeurs qu'il calcule, domaine par domaine.
 *
 * C'est ici qu'on vient pour savoir COMMENT une valeur se calcule : chaque
 * domaine de `domaines/` ecrit ses grandeurs en formules, avec leur libelle,
 * leur unite et leur regle du dictionnaire. Le moteur les execute telles
 * quelles, et l'ecran les affiche telles quelles : il n'existe pas d'autre
 * redaction des calculs qui pourrait diverger de celle-ci.
 *
 * L'ordre des domaines est celui de la chaine de calcul, et celui dans lequel
 * l'ecran les presente.
 */
import { creerModele, Classeur } from './classeur.js';
import { sansSurcharge, domainesModifies } from './surcharges.js';
import { OPERATION } from './domaines/operation.js';
import { CALENDRIER } from './domaines/calendrier.js';
import { SURFACES } from './domaines/surfaces.js';
import { LOYERS } from './domaines/loyers.js';
import { PRIX_REVIENT } from './domaines/prix_revient.js';
import { SUBVENTIONS } from './domaines/subventions.js';
import { FINANCEMENT } from './domaines/financement.js';
import { PRETS } from './domaines/prets.js';
import { AMORTISSEMENT } from './domaines/amortissement.js';
import { FISCALITE } from './domaines/fiscalite.js';
import { TRESORERIE } from './domaines/tresorerie.js';
import { EXPLOITATION } from './domaines/exploitation.js';
import { SYNTHESE } from './domaines/synthese.js';

export const DOMAINES = [
  OPERATION,
  CALENDRIER,
  SURFACES,
  LOYERS,
  PRIX_REVIENT,
  SUBVENTIONS,
  FINANCEMENT,
  PRETS,
  AMORTISSEMENT,
  FISCALITE,
  TRESORERIE,
  EXPLOITATION,
  SYNTHESE,
];

export const MODELE = creerModele(DOMAINES);

/** Modeles modifies deja assembles, par texte de leurs modifications. */
const MODELES_MODIFIES = new Map();

/**
 * Le modele du moteur avec les modifications d'un administrateur
 * (`surcharges.js`), ou le modele du depot s'il n'y en a pas.
 *
 * Memes modifications, meme modele : il est garde en memoire, comme une
 * formule compilee, pour que l'analyse de sensibilite - des centaines de
 * calculs - ne recompile pas toutes les formules a chaque fois. Ce cache ne
 * change aucun resultat : il ne fait qu'eviter de refaire le meme travail.
 * @param {import('./surcharges.js').Surcharges|null|undefined} surcharges
 */
export function modeleDe(surcharges) {
  if (sansSurcharge(surcharges)) return MODELE;
  const cle = JSON.stringify(surcharges);
  let modele = MODELES_MODIFIES.get(cle);
  if (!modele) {
    modele = creerModele(domainesModifies(DOMAINES, /** @type {any} */ (surcharges)));
    if (MODELES_MODIFIES.size >= 24) MODELES_MODIFIES.clear();
    MODELES_MODIFIES.set(cle, modele);
  }
  return modele;
}

/**
 * Un classeur neuf, sur le modele du moteur ou sur un modele modifie.
 * @param {{entrees?: any, baremes?: any, trajectoires?: any}} contexte
 * @param {any} [modele]
 */
export function nouveauClasseur(contexte, modele = MODELE) {
  return new Classeur(modele, contexte);
}
