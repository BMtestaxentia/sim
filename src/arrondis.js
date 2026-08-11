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
  const v = arrondi(eur, 0);
  // `+ 0` normalise le ZERO NEGATIF. Un residu de calcul a -1e-13 s'arrondit en
  // `-0` : economiquement c'est zero, mais `Object.is(-0, 0)` est faux, JSON le
  // serialise « -0 » et l'ecran affiche « -0 € ». Un solde nul ne doit pas
  // dependre du sens dans lequel on s'en est approche.
  return v === 0 ? 0 : v;
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

/**
 * Repartit des valeurs en euros entiers dont la somme vaut EXACTEMENT l'arrondi
 * de la somme exacte (methode du plus grand reste).
 *
 * Arrondir chaque part independamment fait deriver le total : trois parts de
 * 3,33 EUR arrondies donnent 9 EUR pour un total de 10 EUR. Sur un prix de
 * revient ventile par tranche, l'ecart se voit immediatement et decredibilise
 * la restitution. Le reliquat est attribue aux plus grands restes, puis, a
 * egalite, dans l'ordre fourni : le resultat est deterministe.
 *
 * Un total peut etre IMPOSE : c'est le cas quand la somme a respecter a deja
 * ete arrondie ailleurs et fait autorite. Ventiler un sous-total de chapitre
 * entre tranches doit retomber sur le sous-total AFFICHE, pas sur l'arrondi
 * de la somme exacte, faute de quoi la ligne ne s'additionne pas a l'ecran.
 *
 * @param {number[]} valeurs valeurs exactes, non arrondies
 * @param {number} [totalImpose] somme a atteindre exactement
 * @returns {number[]} entiers de meme longueur, sommant au total
 */
export function arrondirEnConservantLaSomme(valeurs, totalImpose) {
  const total =
    totalImpose !== undefined ? totalImpose : arrondiEuro(valeurs.reduce((s, v) => s + v, 0));
  const bas = valeurs.map((v) => Math.floor(v));
  const reliquat = total - bas.reduce((s, v) => s + v, 0);

  const ordre = valeurs
    .map((v, i) => ({ i, reste: v - Math.floor(v) }))
    .sort((a, b) => b.reste - a.reste || a.i - b.i);

  const resultat = bas.slice();
  // Le reliquat peut etre negatif si les valeurs le sont : on distribue dans le
  // sens qui convient, une unite a la fois.
  const pas = reliquat >= 0 ? 1 : -1;
  for (let k = 0; k < Math.abs(reliquat); k++) {
    resultat[ordre[k % ordre.length].i] += pas;
  }
  return resultat;
}

/**
 * CRD pour le test d'arret du tableau d'amortissement : 4 decimales
 * (R-AMT-4 : « si ROUND(CRD,4) <= 0 -> derniere annuite ajustee », SimPLUS!FF117 sq.).
 * @param {number} eur
 */
export function arrondiCRD(eur) {
  return arrondi(eur, 4);
}
