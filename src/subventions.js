// @ts-check
/**
 * R-SUB — Subventions : subvention de l'Etat (SLA), surcharge fonciere (SSF),
 * gratuite et affectation.
 *
 * Sources : `calculs!B254:B264` (SLA), `calculs!D274:B292` (SSF),
 * `calculs!D295:D314` (gratuite / affectation), baremes_2025.json/ssf.
 *
 * Unites : montants en euros, taux en fraction.
 */
import { arrondiEuro } from './arrondis.js';

/**
 * @typedef {Object} Subvention
 * @property {string} libelle
 * @property {number} montant_eur
 * @property {boolean} [gratuite]      une subvention gratuite ne se rembourse pas
 * @property {string} [affectation]    code produit, ou 'PLUS-PLAI' pour une ventilation par quote-part
 */

/**
 * R-SUB-3 — Agregation des subventions saisies, ventilees par produit.
 * Une subvention affectee a un couple de produits ('PLUS-PLAI') est repartie au
 * prorata des quotes-parts de surface utile.
 * @param {Subvention[]} subventions
 * @param {Record<string, number>} quotes_parts
 * @returns {{par_produit: Record<string, number>, gratuites_eur: number,
 *            non_gratuites_eur: number, total_eur: number}}
 */
export function agregerSubventions(subventions, quotes_parts) {
  /** @type {Record<string, number>} */
  const parProduit = {};
  let gratuites = 0;
  let nonGratuites = 0;

  for (const sub of subventions) {
    if (!sub.montant_eur) continue;
    if (sub.gratuite) gratuites += sub.montant_eur;
    else nonGratuites += sub.montant_eur;

    const cible = sub.affectation;
    if (cible && quotes_parts[cible] !== undefined) {
      parProduit[cible] = (parProduit[cible] ?? 0) + sub.montant_eur;
    } else {
      // Affectation multi-produits (ou absente) : ventilation par quote-part SU.
      for (const [code, qp] of Object.entries(quotes_parts)) {
        parProduit[code] = (parProduit[code] ?? 0) + sub.montant_eur * qp;
      }
    }
  }

  for (const code of Object.keys(parProduit)) parProduit[code] = arrondiEuro(parProduit[code]);

  return {
    par_produit: parProduit,
    gratuites_eur: arrondiEuro(gratuites),
    non_gratuites_eur: arrondiEuro(nonGratuites),
    total_eur: arrondiEuro(gratuites + nonGratuites),
  };
}

/**
 * R-SUB-2 — Subvention de surcharge fonciere.
 *
 *   depassement = valeur_fonciere_reelle - reference,  reference = VB x SU_SSF
 *   Si les participations des collectivites couvrent moins du seuil reglementaire
 *   du depassement, le plafond de l'Etat est
 *     MIN(taux_depassement_plafonne x reference, part_max x depassement).
 *   La subvention vaut taux_subvention x depassement plafonne.
 *
 * Les taux different entre neuf et acquisition-amelioration : ils sont lus au
 * referentiel, jamais ecrits en dur.
 * @param {Object} p
 * @param {number} p.valeur_fonciere_eur
 * @param {number} p.valeur_de_base_eur_m2
 * @param {number} p.su_ssf_m2
 * @param {number} [p.participations_collectivites_eur]
 * @param {'neuf'|'acq_amelioration'} [p.type]
 * @param {boolean} [p.eligible]  flag ParaPLUS!DE76 = OK
 * @param {any} referentiels
 */
export function surchargeFonciere(
  {
    valeur_fonciere_eur,
    valeur_de_base_eur_m2,
    su_ssf_m2,
    participations_collectivites_eur = 0,
    type = 'neuf',
    eligible = true,
  },
  referentiels,
) {
  const cfg = referentiels.constantes_reglementaires.ssf;
  const reference = valeur_de_base_eur_m2 * su_ssf_m2;
  const depassement = valeur_fonciere_eur - reference;

  if (!eligible || depassement <= 0) {
    return {
      reference_eur: arrondiEuro(reference),
      depassement_eur: arrondiEuro(Math.max(depassement, 0)),
      depassement_plafonne_eur: 0,
      subvention_eur: 0,
      eligible: false,
    };
  }

  const tauxDep = cfg.taux_depassement_plafonne[type];
  const tauxSub = cfg.taux_subvention[type];

  // Plafond conditionnel : il ne s'applique que si les collectivites participent
  // en dessous du seuil reglementaire du depassement.
  const sousSeuil =
    participations_collectivites_eur < cfg.seuil_participation_collectivites * depassement;
  const plafond = sousSeuil
    ? Math.min(tauxDep * reference, cfg.part_max_depassement * depassement)
    : tauxDep * reference;

  const depassementPlafonne = Math.min(depassement, plafond);

  return {
    reference_eur: arrondiEuro(reference),
    depassement_eur: arrondiEuro(depassement),
    depassement_plafonne_eur: arrondiEuro(depassementPlafonne),
    subvention_eur: arrondiEuro(tauxSub * depassementPlafonne),
    eligible: true,
  };
}

/**
 * R-SUB-1 🔶 Subvention de l'Etat (SLA).
 * En metropole l'assiette reglementaire est nulle : la subvention vient d'un
 * forfait saisi (par logement, par m2 de SHAB ou de SU selon le mode). Le calcul
 * DOM et la MQECO en acquisition-amelioration ne sont pas couverts en V1.
 * @param {Object} p
 * @param {'logement'|'shab'|'su'|'forfait'} p.mode
 * @param {number} p.forfait_eur         montant unitaire (ou global si mode 'forfait')
 * @param {number} [p.nb_logements]
 * @param {number} [p.shab_m2]
 * @param {number} [p.su_m2]
 * @returns {number}
 */
export function subventionEtat({ mode, forfait_eur, nb_logements = 0, shab_m2 = 0, su_m2 = 0 }) {
  switch (mode) {
    case 'logement':
      return arrondiEuro(forfait_eur * nb_logements);
    case 'shab':
      return arrondiEuro(forfait_eur * shab_m2);
    case 'su':
      return arrondiEuro(forfait_eur * su_m2);
    case 'forfait':
      return arrondiEuro(forfait_eur);
    default:
      throw new Error(`Mode de subvention Etat inconnu : ${mode}`);
  }
}
