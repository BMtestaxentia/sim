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
import { OPERATION } from './domaines/operation.js';
import { CALENDRIER } from './domaines/calendrier.js';
import { SURFACES } from './domaines/surfaces.js';
import { LOYERS } from './domaines/loyers.js';
import { PRIX_REVIENT } from './domaines/prix_revient.js';
import { SUBVENTIONS } from './domaines/subventions.js';
import { FINANCEMENT } from './domaines/financement.js';

export const MODELE = creerModele([
  OPERATION,
  CALENDRIER,
  SURFACES,
  LOYERS,
  PRIX_REVIENT,
  SUBVENTIONS,
  FINANCEMENT,
]);

/**
 * Un classeur neuf sur le modele du moteur.
 * @param {{entrees?: any, baremes?: any, trajectoires?: any}} contexte
 */
export function nouveauClasseur(contexte) {
  return new Classeur(MODELE, contexte);
}
