// @ts-check
/**
 * R-SUB - Subventions : rattachement a la tranche, totaux, surcharge fonciere.
 *
 * LES FORMULES VIVENT DANS `formules/domaines/subventions.js`, ecrites une fois
 * en blocs. Ce module restitue les subventions sous la forme que l'ecran et les
 * exports consomment, et garde les fonctions historiques (`agregerSubventions`,
 * `surchargeFonciere`, `valeurDeBase`), qui evaluent ces memes formules sur les
 * valeurs qu'on leur donne.
 *
 * Unites : montants en euros, taux en fraction.
 */
import { arrondiEuro } from './arrondis.js';
import { nouveauClasseur } from './formules/modele.js';

/**
 * @typedef {Object} Subvention
 * @property {string} libelle
 * @property {number} montant_eur
 * @property {boolean} [gratuite]      une subvention gratuite ne se rembourse pas
 * @property {string} [affectation]    code de la tranche qui la porte (R-SUB-3)
 */

/**
 * Subventions d'un classeur : celles qui entrent au plan, rattachees a leur
 * tranche, et celles qui restent hors plan, pour que l'appelant les signale.
 * @param {import('./formules/classeur.js').Classeur} c
 * @returns {{par_produit: Record<string, number>, gratuites_eur: number,
 *            non_gratuites_eur: number, total_eur: number,
 *            rattachees: Array<any>, hors_plan: Array<{libelle: string, montant_eur: number, affectation: string|null}>}}
 */
export function restituerSubventions(c) {
  const saisies = c.valeur('subventions_saisies') ?? [];
  const rattachees = [];
  const horsPlan = [];
  /** @type {Record<string, number>} */
  const parProduit = {};
  for (const i of c.valeursDimension('subvention')) {
    const S = { subvention: i };
    if (!c.valeur('subvention_retenue', S)) continue;
    const montant = c.valeur('montant_subvention', S);
    const tranche = c.valeur('tranche_subvention', S);
    if (tranche) {
      rattachees.push({ ...saisies[i], montant_eur: montant, affectation: tranche });
      if (!(tranche in parProduit)) parProduit[tranche] = c.valeur('subventions_tranche', { tranche });
    } else {
      horsPlan.push({
        libelle: saisies[i].libelle ?? 'Subvention',
        montant_eur: montant,
        affectation: saisies[i].affectation ?? null,
      });
    }
  }
  return {
    par_produit: parProduit,
    gratuites_eur: c.valeur('subventions_gratuites'),
    non_gratuites_eur: c.valeur('subventions_non_gratuites'),
    total_eur: c.valeur('subventions_saisies_total'),
    rattachees,
    hors_plan: horsPlan,
  };
}

/**
 * Classeur reduit a des subventions et a des tranches donnees.
 * @param {Subvention[]} subventions
 * @param {string[]} codes
 */
function classeurDeSubventions(subventions, codes) {
  const c = nouveauClasseur({ entrees: { subventions } });
  c.fixerDimension('tranche', codes).fixer('tranches_ordre_saisie', {}, codes);
  return c;
}

/**
 * R-SUB-3 - Rattachement des subventions a leur tranche.
 * @param {Subvention[]} subventions
 * @param {string[]} codes tranches presentes au programme
 */
export function rattacherSubventions(subventions, codes) {
  const { rattachees, hors_plan } = restituerSubventions(classeurDeSubventions(subventions ?? [], codes));
  return { rattachees, hors_plan };
}

/**
 * R-SUB-3 - Agregation des subventions saisies, par tranche. Seules les
 * subventions RATTACHEES entrent aux totaux.
 * @param {Subvention[]} subventions
 * @param {Record<string, number>} quotes_parts ses cles sont les tranches du programme
 */
export function agregerSubventions(subventions, quotes_parts) {
  return restituerSubventions(classeurDeSubventions(subventions ?? [], Object.keys(quotes_parts)));
}

/**
 * Subvention de surcharge fonciere d'un classeur, ou `null` si elle n'est pas
 * demandee. Formules : `ssf_*` du domaine « subventions ».
 * @param {import('./formules/classeur.js').Classeur} c
 */
export function restituerSurchargeFonciere(c) {
  if (!c.valeur('ssf_active')) return null;
  return {
    reference_eur: c.valeur('ssf_reference_arrondie'),
    depassement_eur: c.valeur('ssf_depassement_arrondi'),
    depassement_plafonne_eur: c.valeur('ssf_depassement_plafonne_arrondi'),
    subvention_eur: c.valeur('ssf_subvention_calculee'),
    eligible: c.valeur('ssf_eligible'),
  };
}

/**
 * R-SUB-2 - Valeur de base (VB) au metre carre, lue au bareme `valeurs_de_base`.
 * Formule : `valeur_de_base_bareme`.
 * @param {{zone_123?: string|number, type?: 'neuf'|'acq_amelioration', habitat?: 'collectif'|'individuel'}} p
 * @param {any} referentiels
 * @returns {number} EUR/m2
 */
export function valeurDeBase({ zone_123, type = 'neuf', habitat = 'collectif' }, referentiels) {
  const c = nouveauClasseur({ entrees: { surcharge_fonciere: { zone_123, type, habitat } }, baremes: referentiels });
  return c.valeur('valeur_de_base_bareme');
}

/**
 * R-SUB-2 - Subvention de surcharge fonciere, a partir de valeurs donnees.
 * @param {Object} p
 * @param {number} p.valeur_fonciere_eur
 * @param {number} [p.valeur_de_base_eur_m2]  a defaut, lue au bareme
 * @param {number} p.su_ssf_m2
 * @param {number} [p.participations_collectivites_eur]
 * @param {'neuf'|'acq_amelioration'} [p.type]
 * @param {boolean} [p.eligible]  flag ParaPLUS!DE76 = OK
 * @param {string|number} [p.zone_123]
 * @param {'collectif'|'individuel'} [p.habitat]
 * @param {any} referentiels
 */
export function surchargeFonciere(p, referentiels) {
  const c = nouveauClasseur({ entrees: { surcharge_fonciere: { ...p } }, baremes: referentiels });
  return /** @type {NonNullable<ReturnType<typeof restituerSurchargeFonciere>>} */ (restituerSurchargeFonciere(c));
}

/**
 * R-SUB-1 🔶 Subvention de l'Etat (SLA). REGLE NON BRANCHEE : aucune grandeur du
 * moteur ne l'emploie (dictionnaire, §12 bis).
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
