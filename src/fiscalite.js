// @ts-check
/**
 * R-FISC - Fiscalite : exoneration de TFPB et taxe d'amenagement.
 *
 *
 * Sources : `SimPLUS!G37` (annee de fin d'exoneration TFPB),
 * `calculs!B1255:B1259` (assiette de taxe d'amenagement),
 * baremes_her_2027.json/taxe_amenagement et constantes_reglementaires.tfpb.
 *
 * La duree d'exoneration est un PARAMETRE (irregularite I-7 : LEON la cable a
 * 25 ans a un endroit et lit « EXONERATION 2 » a un autre).
 *
 * Unites : montants en euros, surfaces en m2.
 */
import { arrondiEuro } from './arrondis.js';
import { PRODUITS } from './produits.js';

/**
 * R-FISC-2 - Regime de taxe d'amenagement d'un produit. Defaut : l'abattement de
 * 50 % des logements finances par un pret aide de l'Etat, qui couvre le PLUS, le
 * PLS et les foyers correspondants.
 * @param {string} code_produit
 * @returns {'exoneration'|'abattement_50'|'aucun'}
 */
function regimeProduit(code_produit) {
  return PRODUITS[code_produit]?.regime_taxe_amenagement ?? 'abattement_50';
}

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
    quotes_parts_sdp,
  },
  referentiels,
) {
  const ta = referentiels.taxe_amenagement;
  const valeurForfaitaire = idf ? ta.idf : ta.hors_idf;

  // R-FISC-2 - Le regime n'est PAS le meme pour tous les logements aides. Le
  // PLAI ouvre une exoneration de PLEIN DROIT (CGI art. 1635 quater D, I, 2°),
  // le PLUS et le PLS n'ont que l'abattement de 50 % (art. 1635 quater I), et le
  // LLI comme le libre n'ont ni l'un ni l'autre - ils ne sont pas finances par un
  // pret aide de l'Etat. Un abattement uniforme de 50 % surtaxait donc le PLAI
  // et sous-taxait le libre, sur la meme operation.
  //
  // L'assiette se ventile a la quote-part de surface de plancher de chaque
  // tranche, chacune appliquant ensuite son regime. Un `abattement` saisi force
  // la valeur pour toute l'operation : c'est le recours quand une deliberation
  // locale s'ecarte du droit commun (art. 1635 quater E).
  const regimes = ta.regimes ?? {};
  const abattementDe = (regime) =>
    abattement ?? regimes[regime ?? 'abattement_50'] ?? ta.abattement_logement_social;

  const parts = quotes_parts_sdp ?? {};
  const codes = Object.keys(parts);
  /** @type {Record<string, {sdp_m2: number, abattement: number, assiette_eur: number}>} */
  const parTranche = {};
  let assietteSurface = 0;
  if (codes.length) {
    for (const code of codes) {
      const sdpTranche = sdp_m2 * (parts[code] ?? 0);
      const ab = abattementDe(regimeProduit(code));
      const a = sdpTranche * (1 - ab) * valeurForfaitaire;
      parTranche[code] = { sdp_m2: sdpTranche, abattement: ab, assiette_eur: arrondiEuro(a) };
      assietteSurface += a;
    }
  } else {
    assietteSurface = sdp_m2 * (1 - abattementDe(undefined)) * valeurForfaitaire;
  }

  const assiette = assietteSurface + nb_places_exterieures * valeur_place_eur;
  return {
    valeur_forfaitaire_eur_m2: valeurForfaitaire,
    assiette_eur: arrondiEuro(assiette),
    montant_eur: arrondiEuro(assiette * (taux_commune + taux_departement)),
    ...(codes.length ? { par_tranche: parTranche } : {}),
  };
}

/*
 * R-FISC-3 (VERSEMENT POUR SOUS-DENSITE) ET tfpbAnnee ONT ETE RETIRES le
 * 03/09/2026, a l'issue de l'audit reglementaire. Ce commentaire tient lieu de
 * trace : sans lui, R-FISC-3 semblerait simplement oubliee du dictionnaire.
 *
 * Le VERSEMENT POUR SOUS-DENSITE est ABROGE. Loi n° 2020-1721 du 29 decembre
 * 2020 (loi de finances pour 2021), article 155 : le versement disparait au
 * 1er janvier 2021, plus aucun seuil minimal de densite ne peut etre institue et
 * ceux qui existaient cessent de produire effet. Le code etait ecrit, teste, et
 * n'a jamais ete appele par le moteur : il modelisait un impot qui n'existe plus.
 *
 * `tfpbAnnee` calculait la taxe fonciere d'une annee donnee et n'etait appelee
 * que par ses propres tests. Elle portait un piege : son annee de reference par
 * defaut etait l'annee de DEBUT de TFPB, si bien que la brancher telle quelle
 * aurait efface vingt-cinq ans d'indexation en silence. Le calcul reellement
 * emprunte vit dans `exploitation.js`, qui indexe depuis la mise en location -
 * c'est la seule version qui doive exister.
 */
