// @ts-check
/**
 * R-FISC - Fiscalite : exoneration de TFPB et taxe d'amenagement.
 *
 * LES FORMULES VIVENT DANS `formules/domaines/fiscalite.js`. Ce module restitue
 * la taxe fonciere et la taxe d'amenagement d'un classeur, et garde les
 * fonctions historiques (`exonerationTFPB`, `taxeAmenagement`), qui evaluent ces
 * memes formules sur les valeurs qu'on leur donne.
 *
 * La duree d'exoneration est un PARAMETRE (irregularite I-7 : LEON la cable a
 * 25 ans a un endroit et lit « EXONERATION 2 » a un autre).
 *
 * Unites : montants en euros, surfaces en m2.
 */
import { nouveauClasseur } from './formules/modele.js';

/**
 * Taxe fonciere d'un classeur : la premiere annee ou elle est due, et la duree
 * d'exoneration de chaque tranche.
 * @param {import('./formules/classeur.js').Classeur} c
 */
export function restituerTFPB(c) {
  return {
    annee_debut_tfpb: c.valeur('annee_debut_tfpb'),
    duree_exoneration_ans: c.valeur('duree_exoneration_operation'),
    par_tranche: Object.fromEntries(
      c.valeursDimension('tranche').map((code) => {
        const T = { tranche: code };
        return [
          code,
          {
            duree_exoneration_ans: c.valeur('duree_exoneration_tranche', T),
            annee_debut_tfpb: c.valeur('annee_debut_tfpb_tranche', T),
          },
        ];
      }),
    ),
  };
}

/**
 * R-FISC-1 - Premiere annee d'assujettissement a la taxe fonciere :
 * `annee(mise en location) + duree d'exoneration`. Formule : `annee_debut_tfpb`.
 * @param {{annee_mise_en_location: number, duree_exoneration_ans?: number}} p
 * @param {any} referentiels
 * @returns {{annee_debut_tfpb: number, duree_exoneration_ans: number}}
 */
export function exonerationTFPB({ annee_mise_en_location, duree_exoneration_ans }, referentiels) {
  const c = nouveauClasseur({ baremes: referentiels })
    .fixer('annee_mise_en_location', {}, annee_mise_en_location)
    .fixer('duree_exoneration_saisie', {}, duree_exoneration_ans);
  return {
    annee_debut_tfpb: c.valeur('annee_debut_tfpb'),
    duree_exoneration_ans: c.valeur('duree_exoneration_operation'),
  };
}

/**
 * Taxe d'amenagement d'un classeur, ou `null` si elle n'est pas demandee.
 * @param {import('./formules/classeur.js').Classeur} c
 */
export function restituerTaxeAmenagement(c) {
  if (!c.valeur('ta_active')) return null;
  const codes = c.valeursDimension('tranche_sdp');
  /** @type {Record<string, any>} */
  const r = {
    valeur_forfaitaire_eur_m2: c.valeur('ta_valeur_forfaitaire'),
    assiette_eur: c.valeur('assiette_ta_arrondie'),
    montant_eur: c.valeur('taxe_amenagement'),
  };
  if (codes.length) {
    r.par_tranche = Object.fromEntries(
      codes.map((code) => {
        const T = { tranche_sdp: code };
        return [
          code,
          {
            sdp_m2: c.valeur('sdp_tranche', T),
            abattement: c.valeur('abattement_tranche_sdp', T),
            assiette_eur: c.valeur('assiette_ta_tranche', T),
          },
        ];
      }),
    );
  }
  return r;
}

/**
 * R-FISC-2 - Taxe d'amenagement, a partir de valeurs donnees.
 * `assiette = SDP x (1 - abattement) x valeur_forfaitaire`, ventilee par tranche
 * quand des quotes-parts de surface de plancher sont fournies.
 * @param {Object} p
 * @param {number} p.sdp_m2
 * @param {boolean} [p.idf]
 * @param {number} [p.abattement]        force l'abattement de toute l'operation
 * @param {number} [p.taux_commune]
 * @param {number} [p.taux_departement]
 * @param {number} [p.nb_places_exterieures]
 * @param {number} [p.valeur_place_eur]
 * @param {Record<string, number>} [p.quotes_parts_sdp]
 * @param {any} referentiels
 */
export function taxeAmenagement(p, referentiels) {
  return /** @type {NonNullable<ReturnType<typeof restituerTaxeAmenagement>>} */ (
    restituerTaxeAmenagement(nouveauClasseur({ entrees: { taxe_amenagement: { ...p } }, baremes: referentiels }))
  );
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
 * emprunte vit dans le compte d'exploitation, qui indexe depuis la mise en
 * location - c'est la seule version qui doive exister.
 */
