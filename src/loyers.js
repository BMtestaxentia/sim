// @ts-check
/**
 * R-SURF + R-LOYER - Surfaces, coefficient de structure et loyers reglementes.
 *
 * LES FORMULES NE SONT PLUS ICI. Elles vivent dans `formules/domaines/surfaces.js`
 * et `formules/domaines/loyers.js`, ecrites une fois en blocs : c'est la que le
 * moteur les execute, et de la que l'ecran les affiche.
 *
 * Ce module garde :
 *  - la RESTITUTION du loyer d'une tranche, lue dans le classeur ;
 *  - les fonctions historiques (`surfaceUtile`, `coefficientStructure`,
 *    `loyerProduit`...). Elles evaluent ces memes formules sur les valeurs
 *    qu'on leur donne, en posant ces valeurs dans un classeur : elles ne
 *    calculent rien elles-memes, et ne peuvent donc pas diverger du moteur ;
 *  - les controles de coherence, qui produisent des alertes et non des valeurs.
 *
 * Unites : surfaces en m2, loyers en EUR/m2 SU/mois sauf mention `_annuel_eur`.
 */
import { produit } from './produits.js';
import { nouveauClasseur } from './formules/modele.js';
import { loyerMaxZone } from './formules/domaines/loyers.js';

export { loyerMaxZone };

/**
 * Classeur reduit a UNE tranche, pour evaluer les formules de loyer sur des
 * valeurs donnees plutot que sur un programme de lots.
 * @param {string} code
 * @param {any} referentiels
 * @param {any} [entrees]
 */
function classeurDeTranche(code, referentiels, entrees = {}) {
  const c = nouveauClasseur({ entrees, baremes: referentiels });
  c.fixerDimension('tranche', [code]);
  return c;
}

/**
 * R-SURF-1 - Surface utile d'un lot : SU = SHAB + coefficient x surfaces annexes.
 * Formule : `su_lot` (arrondie) ou `su_exacte_lot`.
 * @param {{shab_m2: number, surfaces_annexes_m2?: number, su_forcee_m2?: number, arrondir?: boolean}} lot
 * @param {any} referentiels
 * @returns {number}
 */
export function surfaceUtile(lot, referentiels) {
  const c = nouveauClasseur({ entrees: { lots: [lot] }, baremes: referentiels });
  return c.valeur(lot.arrondir === false ? 'su_exacte_lot' : 'su_lot', { lot: 0 });
}

/**
 * R-SURF-2 - Coefficient de structure. Formule : `cs_calcule` (ou `cs_exact`).
 * @param {{nb_logements: number, su_m2: number, foyer?: boolean, arrondir?: boolean}} p
 * @param {any} referentiels
 * @returns {number}
 */
export function coefficientStructure({ nb_logements, su_m2, foyer = false, arrondir = true }, referentiels) {
  const T = { tranche: '_' };
  const c = classeurDeTranche('_', referentiels)
    .fixer('nb_logements_tranche', T, nb_logements)
    .fixer('su_tranche', T, su_m2)
    .fixer('produit_foyer', T, foyer)
    .fixer('foyer_tranche', T, foyer);
  return c.valeur(arrondir ? 'cs_calcule' : 'cs_exact', T);
}

/**
 * R-SURF-3 - Quotes-parts de surface utile. Formule : `quote_part_su`.
 * @param {Record<string, number>} su_par_produit
 * @returns {Record<string, number>}
 */
export function quotesPartsSU(su_par_produit) {
  const codes = Object.keys(su_par_produit);
  const c = nouveauClasseur({ entrees: {} });
  c.fixerDimension('tranche', codes).fixer('tranches_ordre_saisie', {}, codes);
  for (const code of codes) c.fixer('su_tranche', { tranche: code }, su_par_produit[code]);
  return Object.fromEntries(codes.map((code) => [code, c.valeur('quote_part_su', { tranche: code })]));
}

/**
 * R-LOYER-1 - Loyer de base. Formule : `loyer_base_bareme`.
 * @param {{code_produit: string, zones: {zone_123?: string|number, zone_ABC?: string},
 *          marge_locale_eur_m2?: number, coefficient_millesime?: number}} p
 * @param {any} referentiels
 * @returns {number}
 */
export function loyerDeBase({ code_produit, zones, marge_locale_eur_m2 = 0, coefficient_millesime = 1 }, referentiels) {
  const T = { tranche: code_produit };
  const c = classeurDeTranche(code_produit, referentiels, {
    identite: { zone_123: zones?.zone_123, zone_ABC: zones?.zone_ABC },
  })
    .fixer('marge_locale_tranche', T, marge_locale_eur_m2)
    .fixer('coefficient_millesime', {}, coefficient_millesime);
  return c.valeur('loyer_base_bareme', T);
}

/**
 * R-LOYER-3 - Marge locale de majoration : somme des majorations affectees,
 * plafonnee. Le moteur n'en a plus l'usage - la formule `marge_appliquee` ne
 * porte qu'une marge par tranche - mais la regle reste disponible.
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
 * REGLE NON BRANCHEE : aucune grandeur du moteur ne l'emploie (dictionnaire,
 * §12 bis).
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
 * Loyer d'une tranche, tel que le moteur le restitue. Les champs dependent du
 * regime : un plafond conventionnel ne connait ni marge ni plafond de marge.
 * @param {import('./formules/classeur.js').Classeur} c
 * @param {string} code
 */
export function restituerLoyer(c, code) {
  const T = { tranche: code };
  const v = (/** @type {string} */ id) => c.valeur(id, T);
  if (v('produit_loyer_par_convention')) {
    return {
      cs: v('cs_tranche'),
      loyer_base_eur_m2: v('loyer_base_tranche'),
      loyer_max_base_eur_m2: v('loyer_max_base_tranche'),
      loyer_pratique_eur_m2: v('loyer_pratique_tranche'),
      loyer_annuel_eur: v('loyer_annuel_tranche'),
      force: v('loyer_force_actif'),
      plafond_conventionnel: true,
    };
  }
  const plafond = v('plafond_marge_tranche');
  return {
    cs: v('cs_tranche'),
    loyer_base_eur_m2: v('loyer_base_tranche'),
    loyer_max_base_eur_m2: v('loyer_max_base_tranche'),
    loyer_pratique_eur_m2: v('loyer_pratique_tranche'),
    loyer_annuel_eur: v('loyer_annuel_tranche'),
    force: v('loyer_force_actif'),
    /** Marge REELLEMENT appliquee, une fois le plafond R-LOYER-3 passe. */
    marge_majoration: v('marge_appliquee'),
    marge_majoration_saisie: v('marge_majoration_tranche'),
    marge_plafonnee: v('marge_plafonnee'),
    plafond_marge: Number.isFinite(plafond) ? plafond : null,
  };
}

/**
 * R-LOYER-2 et R-LOYER-5 - Loyer pratique d'un produit, a partir de valeurs
 * donnees. Formules du domaine « loyers ».
 * @param {Object} p
 * @param {string} p.code_produit
 * @param {number} p.su_m2
 * @param {number} p.nb_logements
 * @param {{zone_123?: string|number, zone_ABC?: string}} p.zones
 * @param {number} [p.marge_locale_eur_m2]
 * @param {number} [p.marge_majoration]     fraction avant plafond (R-LOYER-3)
 * @param {number} [p.loyer_sortie_force]   EUR/m2/mois, court-circuite le calcul
 * @param {number} [p.loyer_plafond_convention_eur_m2] produits a plafond conventionnel
 * @param {boolean} [p.foyer]
 * @param {number} [p.coefficient_millesime] R-LOYER-9
 * @param {any} referentiels
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
    loyer_plafond_convention_eur_m2,
    foyer = false,
    coefficient_millesime = 1,
  },
  referentiels,
) {
  const T = { tranche: code_produit };
  const c = classeurDeTranche(code_produit, referentiels, {
    identite: { zone_123: zones?.zone_123, zone_ABC: zones?.zone_ABC },
  })
    .fixer('su_tranche', T, su_m2)
    .fixer('nb_logements_tranche', T, nb_logements)
    .fixer('marge_locale_tranche', T, marge_locale_eur_m2)
    .fixer('marge_majoration_tranche', T, marge_majoration)
    .fixer('loyer_force_tranche', T, loyer_sortie_force)
    .fixer('loyer_convention_tranche', T, loyer_plafond_convention_eur_m2)
    .fixer('foyer_tranche', T, foyer)
    .fixer('coefficient_millesime', {}, coefficient_millesime);
  return restituerLoyer(c, code_produit);
}

/**
 * R-LOYER-7 - Loyers des annexes louees separement. Formule : `loyers_annexes_annuels`.
 * @param {Array<{nombre: number, loyer_unitaire_eur_mois: number}>} annexes
 * @returns {number} loyer annuel en euros
 */
export function loyerAnnexesSeparees(annexes) {
  return nouveauClasseur({ entrees: { annexes_louees: annexes } }).valeur('loyers_annexes_annuels');
}

/**
 * R-LOYER-8 - Controles de coherence. Ne bloquent pas le calcul : ils remontent
 * des alertes que l'appelant (ou l'UI) presente.
 * @param {{loyer_pratique_eur_m2: number, loyer_max_base_eur_m2: number, force: boolean,
 *          marge_plafonnee?: boolean, marge_majoration?: number, marge_majoration_saisie?: number,
 *          plafond_conventionnel?: boolean}} loyer
 * @param {string} code_produit
 * @returns {string[]}
 */
export function controlesLoyer(loyer, code_produit) {
  const alertes = [];
  // R-LOYER-3 : le plafonnement de la marge se DIT. Il change le loyer de sortie,
  // donc tout l'equilibre : le laisser s'appliquer en silence ferait chercher
  // ailleurs la raison d'un compte qui ne tombe plus juste.
  if (loyer.marge_plafonnee) {
    alertes.push(
      `${code_produit} : marge de majoration ramenee de ` +
        `${(/** @type {number} */ (loyer.marge_majoration_saisie) * 100).toFixed(1)} % a ` +
        `${(/** @type {number} */ (loyer.marge_majoration) * 100).toFixed(1)} %, plafond reglementaire de la simulation`,
    );
  }
  // Un plafond conventionnel non saisi vaut zero : le compte serait faux en
  // silence. On le dit plutot que de laisser passer une recette nulle.
  if (loyer.plafond_conventionnel && loyer.loyer_max_base_eur_m2 <= 0) {
    alertes.push(
      `${code_produit} : plafond de loyer conventionnel non renseigne - ` +
        `il ne se deduit d'aucun bareme de zone, il doit etre saisi`,
    );
  }
  // Sur un produit a loyer de MARCHE, le bareme de zone n'est qu'une estimation :
  // le depasser releve de la commercialisation, pas de l'infraction. Alerter
  // reviendrait a reprocher un montage optimiste, ce que le moteur n'a pas a
  // juger - et l'alerte perdrait son sens la ou elle en a un, sur le conventionne.
  const plafondReglementaire = !produit(/** @type {any} */ (code_produit)).loyer_de_marche;
  if (plafondReglementaire && loyer.force && loyer.loyer_pratique_eur_m2 > loyer.loyer_max_base_eur_m2) {
    alertes.push(
      `${code_produit} : loyer de sortie force (${loyer.loyer_pratique_eur_m2} EUR/m2) ` +
        `superieur au loyer max de base (${loyer.loyer_max_base_eur_m2} EUR/m2)`,
    );
  }
  return alertes;
}
