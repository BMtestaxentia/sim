// @ts-check
/**
 * Calendrier de l'operation : chaine de dates derivees de la saisie.
 *
 * Source d'ergonomie : onglet ACCUEIL de la maquette LEON REWORK, ou seule la
 * date de debut des travaux est saisie ; livraison et mise en location en
 * decoulent (`C24 = C22 decalee de C23 mois`, `C25 = C24 + 1 jour`).
 *
 * LES REGLES VIVENT DANS `formules/domaines/calendrier.js`, ecrites en blocs :
 * c'est la que le moteur les lit et que l'ecran les affiche. Ce module ne fait
 * que restituer le calendrier sous la forme que l'ecran et les exports
 * consomment, et garde `calendrierOperation` pour les appelants qui ne
 * disposent que des dates.
 *
 * Aucune horloge systeme : toutes les dates sont des entrees explicites.
 */
import { decalerMois } from './dates.js';
import { nouveauClasseur } from './formules/modele.js';

// L'arithmetique des dates vit dans `dates.js`, partagee avec les prets, la
// tresorerie et les formules. `decalerMois` reste exporte d'ici pour les
// appelants qui l'y cherchent.
export { decalerMois };

/**
 * @typedef {Object} EntreesCalendrier
 * @property {string|Date} [date_debut_travaux]
 * @property {number} [duree_chantier_mois]
 * @property {string|Date} [date_livraison]      surcharge (contractuelle en VEFA)
 * @property {string|Date} [date_mise_en_location] surcharge
 * @property {number} [annee_mise_en_location]   surcharge directe (forme minimale)
 *
 * @typedef {Object} Calendrier
 * @property {string|null} date_debut_travaux
 * @property {number|null} duree_chantier_mois
 * @property {string|null} date_livraison
 * @property {string|null} date_mise_en_location
 * @property {number} annee_mise_en_location
 * @property {Record<string, 'saisie'|'calcule'>} origine  d'ou vient chaque date
 */

/**
 * Restitue le calendrier d'un classeur.
 *
 * `origine` dit pour chaque date si elle a ete saisie ou calculee : l'ecran s'en
 * sert pour griser les dates derivees sans reimplementer la regle.
 *
 * @param {import('./formules/classeur.js').Classeur} c
 * @returns {Calendrier}
 */
export function restituerCalendrier(c) {
  const v = (/** @type {string} */ id) => c.valeur(id);
  // Lue en premier : une saisie qui ne permet pas de la situer arrete tout.
  const annee = v('annee_mise_en_location');

  /** @type {Record<string, 'saisie'|'calcule'>} */
  const origine = {};
  for (const cle of ['date_livraison', 'date_mise_en_location']) {
    const o = v(`origine_${cle}`);
    if (o) origine[cle] = o;
  }
  origine.annee_mise_en_location = v('origine_annee_mise_en_location');
  if (v('origine_date_debut_travaux')) origine.date_debut_travaux = 'saisie';

  return {
    date_debut_travaux: v('date_debut_travaux'),
    duree_chantier_mois: v('duree_chantier_mois'),
    date_livraison: v('date_livraison'),
    date_mise_en_location: v('date_mise_en_location'),
    annee_mise_en_location: annee,
    origine,
  };
}

/**
 * Derive le calendrier de l'operation a partir de ses seules dates.
 * @param {EntreesCalendrier} entrees
 * @returns {Calendrier}
 */
export function calendrierOperation(entrees = {}) {
  return restituerCalendrier(nouveauClasseur({ entrees: { dates: entrees } }));
}
