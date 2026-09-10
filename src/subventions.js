// @ts-check
/**
 * R-SUB - Subventions : subvention de l'Etat (SLA), surcharge fonciere (SSF),
 * gratuite et affectation.
 *
 * Sources : `calculs!B254:B264` (SLA), `calculs!D274:B292` (SSF),
 * `calculs!D295:D314` (gratuite / affectation), baremes_her_2027.json/ssf.
 *
 * Unites : montants en euros, taux en fraction.
 */
import { arrondiEuro } from './arrondis.js';

/**
 * @typedef {Object} Subvention
 * @property {string} libelle
 * @property {number} montant_eur
 * @property {boolean} [gratuite]      une subvention gratuite ne se rembourse pas
 * @property {string} [affectation]    code de la tranche qui la porte (R-SUB-3)
 */

/**
 * R-SUB-3 - Tranche visee par une affectation de subvention.
 *
 * Une affectation nomme UNE tranche, et une seule. LEON connait un couple
 * « PLUS-PLAI » parce que son moteur est duplique et qu'il tient une colonne
 * combinee ; ici le PLUS et le PLAI sont deux tranches TOTALEMENT DISTINCTES
 * (arbitrage metier du 03/09/2026), et une aide qui vise les deux se saisit en
 * deux lignes. Introduire un code composite reintroduirait la structure meme
 * dont ce moteur s'est affranchi.
 *
 * Ce que devient une subvention qu'aucune tranche ne porte se decide dans
 * `rattacherSubventions` : elle est rattachee a un financement, ou elle n'existe
 * pas au plan.
 *
 * @param {string|null|undefined} affectation
 * @param {string[]} codes_presents
 * @returns {{cible: string|null, introuvable: boolean}}
 */
export function resoudreAffectation(affectation, codes_presents) {
  const nom = String(affectation ?? '').trim();
  if (!nom) return { cible: null, introuvable: false };
  const cible = codes_presents.find((c) => c.toUpperCase() === nom.toUpperCase()) ?? null;
  return { cible, introuvable: cible === null };
}

/**
 * R-SUB-3 - Rattachement des subventions a leur tranche.
 *
 * Une subvention est rattachee a un FINANCEMENT, comme un pret ou des fonds
 * propres, ou elle n'existe pas (arbitrage metier du 10/09/2026). LEON repartit
 * une subvention sans affectation au prorata des surfaces utiles ; ce moteur ne
 * le fait plus (ecart E-14). La repartition fabriquait des centimes que chaque
 * tranche arrondissait de son cote : une operation a quatre tranches en sortait
 * desequilibree d'un euro. Et elle faisait financer par une aide ce qu'elle ne
 * visait pas, logement libre compris, sans que l'ecran le montre - les ecrans
 * de tranche ne listent que les subventions qui leur sont rattachees.
 *
 * Trois cas :
 *  - la tranche nommee existe au programme : elle porte la subvention ;
 *  - aucune tranche nommee, mais une seule au programme : c'est elle, sans
 *    ambiguite possible - le moteur rattache de meme un pret sans tranche ;
 *  - sinon - aucune tranche nommee sur un programme mixte, ou une tranche qui
 *    n'y figure plus - la subvention reste HORS PLAN : elle ne finance rien, ne
 *    compte dans aucun total, et l'appelant la signale pour qu'on la rattache.
 *
 * @param {Subvention[]} subventions
 * @param {string[]} codes tranches presentes au programme
 * @returns {{rattachees: Array<Subvention & {affectation: string}>,
 *            hors_plan: Array<{libelle: string, montant_eur: number, affectation: string|null}>}}
 */
export function rattacherSubventions(subventions, codes) {
  const rattachees = [];
  const horsPlan = [];
  for (const sub of subventions ?? []) {
    const montant = Number(sub.montant_eur) || 0;
    if (!montant) continue;
    const { cible, introuvable } = resoudreAffectation(sub.affectation, codes);
    const tranche = cible ?? (!introuvable && codes.length === 1 ? codes[0] : null);
    if (tranche) {
      rattachees.push({ ...sub, montant_eur: montant, affectation: tranche });
    } else {
      horsPlan.push({ libelle: sub.libelle ?? 'Subvention', montant_eur: montant, affectation: sub.affectation ?? null });
    }
  }
  return { rattachees, hors_plan: horsPlan };
}

/**
 * R-SUB-3 - Agregation des subventions saisies, par tranche.
 * Seules les subventions RATTACHEES entrent aux totaux ; les autres sont rendues
 * a part, pour etre signalees (voir `rattacherSubventions`).
 * @param {Subvention[]} subventions
 * @param {Record<string, number>} quotes_parts ses cles sont les tranches du programme
 * @returns {{par_produit: Record<string, number>, gratuites_eur: number,
 *            non_gratuites_eur: number, total_eur: number,
 *            rattachees: Array<any>, hors_plan: Array<any>}}
 */
export function agregerSubventions(subventions, quotes_parts) {
  const { rattachees, hors_plan } = rattacherSubventions(subventions, Object.keys(quotes_parts));
  /** @type {Record<string, number>} */
  const parProduit = {};
  let gratuites = 0;
  let nonGratuites = 0;
  for (const sub of rattachees) {
    if (sub.gratuite) gratuites += sub.montant_eur;
    else nonGratuites += sub.montant_eur;
    parProduit[sub.affectation] = (parProduit[sub.affectation] ?? 0) + sub.montant_eur;
  }
  for (const code of Object.keys(parProduit)) parProduit[code] = arrondiEuro(parProduit[code]);

  return {
    par_produit: parProduit,
    gratuites_eur: arrondiEuro(gratuites),
    non_gratuites_eur: arrondiEuro(nonGratuites),
    total_eur: arrondiEuro(gratuites + nonGratuites),
    rattachees,
    hors_plan,
  };
}

/**
 * R-SUB-2 - Valeur de base (VB) au metre carre, assiette de reference de la
 * surcharge fonciere. Lue au bareme `valeurs_de_base` : une table par zone
 * 1/2/3/1bis, croisee neuf / acquisition et collectif / individuel.
 *
 * @param {Object} p
 * @param {string|number} [p.zone_123]
 * @param {'neuf'|'acq_amelioration'} [p.type]
 * @param {'collectif'|'individuel'} [p.habitat]
 * @param {any} referentiels
 * @returns {number} EUR/m2
 */
export function valeurDeBase({ zone_123, type = 'neuf', habitat = 'collectif' }, referentiels) {
  const table = referentiels.valeurs_de_base;
  if (!table) return 0;
  // Le bareme distingue le NEUF de l'ACQUISITION ; le type d'operation du moteur
  // parle d'acquisition-amelioration, c'est la meme colonne.
  const colonne = table[type === 'neuf' ? 'neuf' : 'acquisition']?.[habitat];
  if (!colonne) return 0;
  const i = table.zones.indexOf(`zone_${zone_123}`);
  return i < 0 ? 0 : colonne[i];
}

/**
 * R-SUB-2 - Subvention de surcharge fonciere.
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
    zone_123,
    habitat = 'collectif',
  },
  referentiels,
) {
  const cfg = referentiels.constantes_reglementaires.ssf;
  // La VALEUR DE BASE est un bareme, pas une saisie : elle se lit par zone, par
  // type d'operation et par forme d'habitat (ParaGEN!D36:G41). La table etait au
  // referentiel depuis le debut, editable a l'ecran, et personne ne la lisait :
  // la reference de surcharge fonciere devait etre retapee a la main a chaque
  // simulation, avec le risque de la prendre dans la mauvaise colonne. Une
  // valeur saisie continue de primer - c'est le recours quand un arrete local
  // s'ecarte du bareme.
  const vb = valeur_de_base_eur_m2 ?? valeurDeBase({ zone_123, type, habitat }, referentiels);
  const reference = vb * su_ssf_m2;
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
