// @ts-check
/**
 * R-FISC - Fiscalite : exoneration de TFPB, taxe d'amenagement, versement pour
 * sous-densite.
 *
 * Sources : `SimPLUS!G37` (annee de fin d'exoneration TFPB),
 * `calculs!B1255:B1259` (assiette de taxe d'amenagement),
 * baremes_2025.json/taxe_amenagement et constantes_reglementaires.tfpb.
 *
 * La duree d'exoneration est un PARAMETRE (irregularite I-7 : LEON la cable a
 * 25 ans a un endroit et lit « EXONERATION 2 » a un autre).
 *
 * Unites : montants en euros, surfaces en m2.
 */
import { arrondiEuro } from './arrondis.js';

/**
 * R-FISC-1 - Premiere annee d'assujettissement a la taxe fonciere.
 * `annee(mise en location) + duree d'exoneration`.
 * @param {Object} p
 * @param {number} p.annee_mise_en_location
 * @param {number} [p.duree_exoneration_ans] defaut : valeur du referentiel
 * @param {any} referentiels
 * @returns {{annee_debut_tfpb: number, duree_exoneration_ans: number}}
 */
export function exonerationTFPB({ annee_mise_en_location, duree_exoneration_ans }, referentiels) {
  const duree =
    duree_exoneration_ans ??
    referentiels.constantes_reglementaires.tfpb.duree_exoneration_defaut_ans;
  return {
    annee_debut_tfpb: annee_mise_en_location + duree,
    duree_exoneration_ans: duree,
  };
}

/**
 * R-FISC-2 - Taxe d'amenagement.
 * `assiette = SDP x (1 - abattement) x valeur_forfaitaire`, la valeur forfaitaire
 * dependant de la localisation (Ile-de-France ou non). Les places de
 * stationnement exterieures s'ajoutent a un forfait par place.
 * @param {Object} p
 * @param {number} p.sdp_m2
 * @param {boolean} [p.idf]
 * @param {number} [p.abattement]        defaut : abattement logement social du referentiel
 * @param {number} [p.taux_commune]
 * @param {number} [p.taux_departement]
 * @param {number} [p.nb_places_exterieures]
 * @param {number} [p.valeur_place_eur]
 * @param {any} referentiels
 */
export function taxeAmenagement(
  {
    sdp_m2,
    idf = false,
    abattement,
    taux_commune = 0,
    taux_departement = 0,
    nb_places_exterieures = 0,
    valeur_place_eur = 0,
  },
  referentiels,
) {
  const ta = referentiels.taxe_amenagement;
  const valeurForfaitaire = idf ? ta.idf : ta.hors_idf;
  abattement = abattement ?? ta.abattement_logement_social;
  const assiette = sdp_m2 * (1 - abattement) * valeurForfaitaire + nb_places_exterieures * valeur_place_eur;
  return {
    valeur_forfaitaire_eur_m2: valeurForfaitaire,
    assiette_eur: arrondiEuro(assiette),
    montant_eur: arrondiEuro(assiette * (taux_commune + taux_departement)),
  };
}

/**
 * R-FISC-3 - Versement pour sous-densite : du seulement en neuf quand un seuil
 * minimal de densite est institue et que le projet reste en deca.
 * `VSD = MIN(valeur_terrain/2 x (1 - SDP/(seuil x surface_terrain)), plafond x valeur_terrain)`.
 * @param {Object} p
 * @param {number} p.valeur_terrain_eur
 * @param {number} p.sdp_m2
 * @param {number} p.surface_terrain_m2
 * @param {number} p.seuil_densite       0 = pas de seuil institue
 * @param {boolean} [p.neuf]
 * @param {any} referentiels
 * @returns {number}
 */
export function versementSousDensite(
  { valeur_terrain_eur, sdp_m2, surface_terrain_m2, seuil_densite, neuf = true },
  referentiels,
) {
  if (!neuf || !(seuil_densite > 0) || !(surface_terrain_m2 > 0)) return 0;
  const cfg = referentiels.versement_sous_densite;
  const densiteCible = seuil_densite * surface_terrain_m2;
  if (sdp_m2 >= densiteCible) return 0;
  const brut = valeur_terrain_eur * cfg.part_valeur_terrain * (1 - sdp_m2 / densiteCible);
  return arrondiEuro(Math.min(brut, cfg.plafond_valeur_terrain * valeur_terrain_eur));
}

/**
 * Taxe fonciere due une annee donnee : nulle pendant l'exoneration, sinon le
 * montant par logement indexe depuis l'annee de reference.
 * @param {Object} p
 * @param {number} p.annee
 * @param {number} p.annee_debut_tfpb
 * @param {number} p.nb_logements
 * @param {number} p.montant_par_logement_eur
 * @param {number} [p.taux_indexation]
 * @param {number} [p.annee_reference]   annee ou `montant_par_logement_eur` est exprime
 * @returns {number}
 */
export function tfpbAnnee({
  annee,
  annee_debut_tfpb,
  nb_logements,
  montant_par_logement_eur,
  taux_indexation = 0,
  annee_reference,
}) {
  if (annee < annee_debut_tfpb) return 0;
  const base = annee_reference ?? annee_debut_tfpb;
  const indexation = (1 + taux_indexation) ** Math.max(0, annee - base);
  return arrondiEuro(nb_logements * montant_par_logement_eur * indexation);
}
