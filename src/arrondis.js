// @ts-check
/**
 * Politique d'arrondi centralisee (regle R-CONV, lecon de l'irregularite I-9 de LEON :
 * les arrondis y sont piletes par un flag global applique de facon heterogene).
 * Ici : une fonction par grandeur, arrondi explicite, jamais de littéral disperse
 * dans le code de calcul.
 *
 * Rappel I-4 : ne pas accumuler iterativement quand une forme fermee existe ;
 * ces fonctions ne servent qu'aux frontieres de presentation / de regle, pas
 * a chaque iteration interne.
 */

/**
 * Arrondi mathematique a `decimales` chiffres apres la virgule (demi vers le haut).
 * @param {number} valeur
 * @param {number} decimales
 * @returns {number}
 */
export function arrondi(valeur, decimales) {
  if (!Number.isFinite(valeur)) return valeur;
  const f = 10 ** decimales;
  // +Number.EPSILON : neutralise le bruit flottant (ex. 1.005 -> 1.01 et non 1.00)
  return Math.round((valeur + Number.EPSILON) * f) / f;
}

/**
 * Loyer en euros/m2 : 2 decimales (R-LOYER-2, R-LOYER-5).
 * @param {number} eurParM2
 */
export function arrondiLoyer(eurParM2) {
  return arrondi(eurParM2, 2);
}

/**
 * Coefficient de structure : 4 decimales (R-SURF-2).
 * @param {number} cs
 */
export function arrondiCS(cs) {
  return arrondi(cs, 4);
}

/**
 * Montant en euros : entier (bilan, plan de financement).
 * @param {number} eur
 */
export function arrondiEuro(eur) {
  return arrondi(eur, 0);
}

/**
 * Arrondi au millier superieur (option R-FIN-4 « arrondir_prets_milliers_sup »).
 * @param {number} eur
 */
export function arrondiMillierSup(eur) {
  return Math.ceil(eur / 1000) * 1000;
}

/**
 * Surface en m2 : 2 decimales (R-SURF-1).
 * @param {number} m2
 */
export function arrondiSurface(m2) {
  return arrondi(m2, 2);
}
