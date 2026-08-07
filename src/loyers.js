// @ts-check
/**
 * R-SURF + R-LOYER - Surfaces, coefficient de structure et loyers reglementes.
 *
 * Sources LEON verifiees le 04/08/2026 (classeur BERGERAC, matrice complete) :
 * - `calculs!D384` : surface utile = SHAB + 0,5 x annexes.
 * - `calculs!D92/D94/D95/D96` : coefficient de structure, variantes metropole/DOM,
 *   par produit / mixte / hors annexes.
 * - `calculs!D72:D77` : loyer de base = loyer max de zone + marge locale.
 * - `calculs!D117:D119` : loyer max de base = CS x loyer de base.
 * - `calculs!B117:B119` et `B92` : arrondis pilotes par un flag global (I-9), ici
 *   remplaces par la politique explicite d'`arrondis.js`.
 *
 * Aucun litteral metier ici : 0,77 / 20 / 38 / 0,685 / 31 / 0,5 viennent tous du
 * referentiel de baremes (lecon I-2).
 *
 * Unites : surfaces en m2, loyers en EUR/m2 SU/mois sauf mention `_annuel_eur`.
 */
import { arrondiSurface, arrondiCS, arrondiLoyer, arrondiEuro } from './arrondis.js';
import { produit } from './produits.js';

/** Nombre de mois d'un loyer annuel (constante calendaire). */
const MOIS_PAR_AN = 12;

/**
 * R-SURF-1 - Surface utile d'un lot : SU = SHAB + coefficient x surfaces annexes.
 * Peut etre forcee par la saisie (la valeur forcee court-circuite le calcul).
 * @param {Object} p
 * @param {number} p.shab_m2
 * @param {number} [p.surfaces_annexes_m2]
 * @param {number} [p.su_forcee_m2]
 * @param {{constantes_reglementaires: any}} referentiels
 * @returns {number} surface utile arrondie a 2 decimales
 */
export function surfaceUtile({ shab_m2, surfaces_annexes_m2 = 0, su_forcee_m2, arrondir = true }, referentiels) {
  const k = referentiels.constantes_reglementaires.coefficient_surface_annexes.valeur;
  const su =
    su_forcee_m2 !== undefined && su_forcee_m2 !== null
      ? su_forcee_m2
      : shab_m2 + k * surfaces_annexes_m2;
  // `arrondir: false` sert a l'agregation lot par lot : la surface utile est une
  // grandeur de TRANCHE (R-SURF-1), et arrondir chaque lot avant de sommer fait
  // deriver le total (six lots a 70,005 m2 donnent 420,06 au lieu de 420).
  return arrondir ? arrondiSurface(su) : su;
}

/**
 * R-SURF-2 - Coefficient de structure : `CS = base x (1 + facteur_nl x NL / SU)`.
 * `facteur_nl` vaut 20 en habitat et 38 en foyers (referentiel).
 *
 * La variante DOM du dictionnaire n'est PAS implementee : hors perimetre
 * (decision du 06/08/2026). Le referentiel conserve ses coefficients pour
 * memoire, mais aucun code ne les lit - mieux vaut une absence franche qu'une
 * branche jamais exercee et donc jamais testee.
 *
 * @param {Object} p
 * @param {number} p.nb_logements
 * @param {number} p.su_m2
 * @param {boolean} [p.foyer]
 * @param {boolean} [p.arrondir]      applique l'arrondi 4 decimales (option LEON)
 * @param {{constantes_reglementaires: any}} referentiels
 * @returns {number}
 */
export function coefficientStructure({ nb_logements, su_m2, foyer = false, arrondir = true }, referentiels) {
  if (!(su_m2 > 0)) return 0;
  const cfg = referentiels.constantes_reglementaires.coefficient_structure;
  const facteur = foyer ? cfg.foyers.facteur_nl : cfg.metropole_habitat.facteur_nl;
  const cs = cfg.metropole_habitat.base * (1 + (facteur * nb_logements) / su_m2);
  return arrondir ? arrondiCS(cs) : cs;
}

/**
 * R-SURF-3 - Quotes-parts de surface utile, cle de ventilation de tous les
 * montants partages entre produits (prix de revient, subventions, foncier).
 * @param {Record<string, number>} su_par_produit
 * @returns {Record<string, number>} quotes-parts sommant a 1 (ou toutes nulles)
 */
export function quotesPartsSU(su_par_produit) {
  const total = Object.values(su_par_produit).reduce((s, v) => s + v, 0);
  /** @type {Record<string, number>} */
  const qp = {};
  for (const [code, su] of Object.entries(su_par_produit)) {
    qp[code] = total > 0 ? su / total : 0;
  }
  return qp;
}

/**
 * Loyer maximal reglementaire d'un produit dans sa zone, lu au bareme.
 * Le zonage applicable (1/2/3/1bis ou A/Abis/B1/B2/C) est une propriete du
 * produit, pas une branche de code (lecon I-1).
 * @param {string} code_produit
 * @param {{zone_123?: string|number, zone_ABC?: string}} zones
 * @param {any} baremes
 * @returns {number} EUR/m2 SU/mois
 */
export function loyerMaxZone(code_produit, zones, baremes) {
  const def = produit(/** @type {any} */ (code_produit));
  const table = def.zonage === 'ABC' ? baremes.loyers_max_zone_ABC : baremes.loyers_max_zone_123;
  const valeurs = table[def.cle_bareme_loyer];
  if (!valeurs) throw new Error(`Bareme de loyer absent pour ${code_produit} (${def.cle_bareme_loyer})`);

  const zone = def.zonage === 'ABC' ? zones.zone_ABC : zones.zone_123;
  const cle = def.zonage === 'ABC' ? String(zone).replace(' ', '_') : `zone_${zone}`;
  const i = table.zones.indexOf(def.zonage === 'ABC' ? cle.replace('Abis', 'A_bis') : cle);
  if (i < 0) throw new Error(`Zone inconnue pour ${code_produit} : ${zone}`);
  return valeurs[i];
}

/**
 * R-LOYER-1 - Loyer de base = loyer max de zone + marge locale departementale.
 * Le PLUS 33 % applique en plus une majoration multiplicative (arbitrage I-6 :
 * x1,33 partout, jamais +0,33).
 * @param {Object} p
 * @param {string} p.code_produit
 * @param {{zone_123?: string|number, zone_ABC?: string}} p.zones
 * @param {number} [p.marge_locale_eur_m2]
 * @param {any} referentiels
 * @returns {number} EUR/m2 SU/mois
 */
export function loyerDeBase({ code_produit, zones, marge_locale_eur_m2 = 0 }, referentiels) {
  const def = produit(/** @type {any} */ (code_produit));
  let loyer = loyerMaxZone(code_produit, zones, referentiels) + marge_locale_eur_m2;
  if (def.majoration_loyer) {
    const maj = referentiels.constantes_reglementaires[def.majoration_loyer];
    loyer *= 1 + (typeof maj === 'object' ? maj.valeur : maj);
  }
  return arrondiLoyer(loyer);
}

/**
 * R-LOYER-3 - Marge locale de majoration : somme des majorations affectees,
 * plafonnee. Le plafonnement est separe par produit (FinPLUS!S26:T29).
 * @param {number[]} majorations
 * @param {number} plafond
 * @returns {number}
 */
export function margePlafonnee(majorations, plafond) {
  const somme = majorations.reduce((s, m) => s + m, 0);
  return Math.min(somme, plafond);
}

/**
 * R-LOYER-4 - Majoration liee aux locaux collectifs residentiels (LCR).
 * Sous le seuil bas : nulle. Au-dessus du seuil haut : majoration forfaitaire.
 * Entre les deux : ratio / 100 (borne intermediaire encore a confirmer, Q-10).
 * @param {number} ratio_lcr en pourcentage (ex. 15 pour 15 %)
 * @param {any} referentiels
 * @returns {number} majoration en fraction
 */
export function majorationLCR(ratio_lcr, referentiels) {
  const r = referentiels.constantes_reglementaires.majoration_lcr;
  if (ratio_lcr < r.seuil_bas) return 0;
  if (ratio_lcr > r.seuil_haut) return r.majoration_au_dessus;
  return ratio_lcr / 100; // le ratio est exprime en points de pourcentage
}

/**
 * R-LOYER-2 et R-LOYER-5 - Loyer pratique d'un produit.
 *   Lmax_base = CS x loyer_de_base   (les produits sans CS prennent le loyer de marche)
 *   loyer     = Lmax_base x (1 + marge_plafonnee)
 *   annuel    = 12 x SU x loyer
 * Un loyer de sortie force court-circuite tout le calcul.
 * @param {Object} p
 * @param {string} p.code_produit
 * @param {number} p.su_m2
 * @param {number} p.nb_logements
 * @param {{zone_123?: string|number, zone_ABC?: string}} p.zones
 * @param {number} [p.marge_locale_eur_m2]
 * @param {number} [p.marge_majoration]     fraction deja plafonnee (R-LOYER-3)
 * @param {number} [p.loyer_sortie_force]   EUR/m2/mois, court-circuite le calcul
 * @param {boolean} [p.foyer]
 * @param {any} referentiels
 * @returns {{cs: number, loyer_base_eur_m2: number, loyer_max_base_eur_m2: number,
 *            loyer_pratique_eur_m2: number, loyer_annuel_eur: number, force: boolean}}
 */
export function loyerProduit(
  {
    code_produit,
    su_m2,
    nb_logements,
    zones,
    marge_locale_eur_m2 = 0,
    marge_majoration = 0,
    loyer_sortie_force,
    foyer = false,
  },
  referentiels,
) {
  const def = produit(/** @type {any} */ (code_produit));
  const cs = def.coefficient_structure
    ? coefficientStructure({ nb_logements, su_m2, foyer }, referentiels)
    : 1;

  const loyerBase = loyerDeBase({ code_produit, zones, marge_locale_eur_m2 }, referentiels);
  const loyerMaxBase = arrondiLoyer(cs * loyerBase);

  const force = loyer_sortie_force !== undefined && loyer_sortie_force !== null;
  const loyerPratique = force
    ? arrondiLoyer(loyer_sortie_force)
    : arrondiLoyer(loyerMaxBase * (1 + marge_majoration));

  return {
    cs,
    loyer_base_eur_m2: loyerBase,
    loyer_max_base_eur_m2: loyerMaxBase,
    loyer_pratique_eur_m2: loyerPratique,
    loyer_annuel_eur: arrondiEuro(MOIS_PAR_AN * su_m2 * loyerPratique),
    force,
  };
}

/**
 * R-LOYER-7 - Loyers des annexes louees separement (garages, parkings, commerces,
 * jardins) : ils ne passent PAS par le coefficient de structure.
 * @param {Array<{nombre: number, loyer_unitaire_eur_mois: number}>} annexes
 * @returns {number} loyer annuel en euros
 */
export function loyerAnnexesSeparees(annexes) {
  return arrondiEuro(
    annexes.reduce((s, a) => s + a.nombre * a.loyer_unitaire_eur_mois * MOIS_PAR_AN, 0),
  );
}

/**
 * R-LOYER-8 - Controles de coherence. Ne bloquent pas le calcul : ils remontent
 * des alertes que l'appelant (ou l'UI) presente.
 * @param {{loyer_pratique_eur_m2: number, loyer_max_base_eur_m2: number, force: boolean}} loyer
 * @param {string} code_produit
 * @returns {string[]}
 */
export function controlesLoyer(loyer, code_produit) {
  const alertes = [];
  if (loyer.force && loyer.loyer_pratique_eur_m2 > loyer.loyer_max_base_eur_m2) {
    alertes.push(
      `${code_produit} : loyer de sortie force (${loyer.loyer_pratique_eur_m2} EUR/m2) ` +
        `superieur au loyer max de base (${loyer.loyer_max_base_eur_m2} EUR/m2)`,
    );
  }
  return alertes;
}
