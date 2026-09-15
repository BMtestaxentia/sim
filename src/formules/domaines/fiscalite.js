// @ts-check
/**
 * DOMAINE « FISCALITE » - R-FISC : exoneration de taxe fonciere et taxe
 * d'amenagement.
 *
 * La duree d'exoneration de TFPB est une propriete du PRODUIT (Q-14) : 25 ans
 * en logement social (CGI art. 1384 A), 20 ans en intermediaire (art. 1384-0 A),
 * deux ans de droit commun en libre. Une duree posee sur la simulation prime.
 *
 * La taxe d'amenagement se ventile a la quote-part de surface de plancher de
 * chaque tranche, et chacune applique son regime : le PLAI en est exonere de
 * plein droit (art. 1635 quater D), le PLUS et le PLS n'ont que l'abattement de
 * 50 % (art. 1635 quater I), le LLI et le libre ni l'un ni l'autre. Un
 * abattement saisi prime sur tout : c'est le recours quand une deliberation
 * locale s'ecarte du droit commun.
 *
 * Sources : `SimPLUS!G37`, `calculs!B1255:B1259`, referentiel
 * `taxe_amenagement` et `constantes_reglementaires.tfpb`.
 */
import { produit, PRODUITS } from '../../produits.js';

/** @type {import('../classeur.js').Domaine} */
export const FISCALITE = {
  domaine: 'fiscalite',
  titre: 'Fiscalité',
  dimensions: {
    tranche_sdp: { libelle: 'Tranche de surface de plancher', valeurs: 'cles_sdp' },
  },
  grandeurs: {
    // --- R-FISC-1 : taxe fonciere ------------------------------------------------
    tfpb_par_logement_saisi: {
      libelle: 'Taxe foncière saisie, par logement',
      unite: 'eur',
      saisie: 'exploitation.tfpb_par_logement_eur',
      ecran: 'Paramètres > Compte d’exploitation',
    },
    tfpb_par_logement_bareme: {
      libelle: 'Taxe foncière du barème, par logement',
      unite: 'eur',
      regle: 'R-FISC-1',
      parametre: 'constantes_reglementaires.tfpb.montant_par_logement_eur',
      ecran: 'Paramètres > Constantes réglementaires',
    },
    tfpb_par_logement: {
      libelle: 'Taxe foncière par logement',
      unite: 'eur',
      regle: 'R-FISC-1',
      formule: 'DEFAUT(tfpb_par_logement_saisi; tfpb_par_logement_bareme)',
    },
    duree_exoneration_saisie: {
      libelle: 'Durée d’exonération saisie',
      unite: 'an',
      saisie: 'options.duree_exoneration_tfpb_ans',
      ecran: 'Paramètres',
    },
    duree_exoneration_produit: {
      libelle: 'Durée d’exonération du produit',
      unite: 'an',
      regle: 'R-FISC-1',
      sur: ['tranche'],
      lire: (_ctx, tranche) => produit(tranche).duree_exoneration_tfpb_ans,
      ecran: 'Référentiel des produits',
    },
    duree_exoneration_defaut: {
      libelle: 'Durée d’exonération par défaut',
      unite: 'an',
      regle: 'R-FISC-1',
      parametre: 'constantes_reglementaires.tfpb.duree_exoneration_defaut_ans',
      ecran: 'Paramètres > Constantes réglementaires',
    },
    duree_exoneration_tranche: {
      libelle: 'Durée d’exonération de la tranche',
      unite: 'an',
      regle: 'R-FISC-1',
      sur: ['tranche'],
      formule: 'DEFAUT(duree_exoneration_saisie; duree_exoneration_produit; duree_exoneration_defaut)',
    },
    annee_debut_tfpb_tranche: {
      libelle: 'Première année de taxe foncière de la tranche',
      unite: 'annee',
      regle: 'R-FISC-1',
      sur: ['tranche'],
      formule: 'annee_mise_en_location + duree_exoneration_tranche',
    },
    tfpb_base_tranche: {
      libelle: 'Taxe foncière annuelle de la tranche, avant indexation',
      unite: 'eur',
      regle: 'R-FISC-1',
      sur: ['tranche'],
      formule: 'nb_logements_tranche * tfpb_par_logement',
    },
    duree_exoneration_operation: {
      libelle: 'Durée d’exonération la plus courte',
      unite: 'an',
      regle: 'R-FISC-1',
      formule:
        'DEFAUT(duree_exoneration_saisie; SI(LONGUEUR(tranches_presentes) > 0; ' +
        'MIN(duree_exoneration_tranche POUR tranche); INDEFINI); duree_exoneration_defaut)',
      note: 'La première année où une taxe est due, quelle que soit la tranche : celle qui marque la rupture de la courbe.',
    },
    annee_debut_tfpb: {
      libelle: 'Première année de taxe foncière',
      unite: 'annee',
      regle: 'R-FISC-1',
      formule: 'annee_mise_en_location + duree_exoneration_operation',
    },

    // --- R-FISC-2 : taxe d'amenagement --------------------------------------------
    ta_saisie: {
      libelle: 'Taxe d’aménagement saisie',
      unite: 'liste',
      saisie: 'taxe_amenagement',
      ecran: 'Prix de revient',
    },
    ta_active: {
      libelle: 'Taxe d’aménagement calculée',
      unite: 'booleen',
      formule: 'SI(ta_saisie; VRAI; FAUX)',
    },
    ta_sdp: {
      libelle: 'Surface de plancher',
      unite: 'm2',
      saisie: 'taxe_amenagement.sdp_m2',
      ecran: 'Prix de revient',
    },
    ta_idf_saisi: {
      libelle: 'Opération en Île-de-France',
      unite: 'booleen',
      saisie: 'taxe_amenagement.idf',
      ecran: 'Prix de revient',
    },
    ta_abattement_saisi: {
      libelle: 'Abattement saisi',
      unite: 'taux',
      saisie: 'taxe_amenagement.abattement',
      ecran: 'Prix de revient',
    },
    ta_taux_commune_saisi: {
      libelle: 'Taux communal saisi',
      unite: 'taux',
      saisie: 'taxe_amenagement.taux_commune',
      ecran: 'Prix de revient',
    },
    ta_taux_departement_saisi: {
      libelle: 'Taux départemental saisi',
      unite: 'taux',
      saisie: 'taxe_amenagement.taux_departement',
      ecran: 'Prix de revient',
    },
    ta_nb_places_saisi: {
      libelle: 'Places de stationnement extérieures',
      unite: 'nombre',
      saisie: 'taxe_amenagement.nb_places_exterieures',
      ecran: 'Prix de revient',
    },
    ta_valeur_place_saisie: {
      libelle: 'Valeur forfaitaire d’une place',
      unite: 'eur',
      saisie: 'taxe_amenagement.valeur_place_eur',
      ecran: 'Prix de revient',
    },
    ta_quotes_parts_saisies: {
      libelle: 'Quotes-parts de surface de plancher saisies',
      unite: 'liste',
      saisie: 'taxe_amenagement.quotes_parts_sdp',
      ecran: 'Prix de revient',
    },
    ta_valeur_idf: {
      libelle: 'Valeur forfaitaire en Île-de-France',
      unite: 'eur_m2',
      regle: 'R-FISC-2',
      parametre: 'taxe_amenagement.idf',
      ecran: 'Paramètres > Foncier et fiscalité',
    },
    ta_valeur_hors_idf: {
      libelle: 'Valeur forfaitaire hors Île-de-France',
      unite: 'eur_m2',
      regle: 'R-FISC-2',
      parametre: 'taxe_amenagement.hors_idf',
      ecran: 'Paramètres > Foncier et fiscalité',
    },
    ta_regimes: {
      libelle: 'Abattements par régime',
      unite: 'liste',
      regle: 'R-FISC-2',
      parametre: 'taxe_amenagement.regimes',
      ecran: 'Paramètres > Foncier et fiscalité',
    },
    ta_abattement_social: {
      libelle: 'Abattement du logement social',
      unite: 'taux',
      regle: 'R-FISC-2',
      parametre: 'taxe_amenagement.abattement_logement_social',
      ecran: 'Paramètres > Foncier et fiscalité',
    },
    regime_ta: {
      libelle: 'Régime de taxe d’aménagement du produit',
      unite: 'texte',
      regle: 'R-FISC-2',
      sur: ['code'],
      lire: (_ctx, code) => PRODUITS[/** @type {any} */ (code)]?.regime_taxe_amenagement ?? 'abattement_50',
      ecran: 'Référentiel des produits',
    },
    ta_idf: {
      libelle: 'Valeur d’Île-de-France retenue',
      unite: 'booleen',
      formule: 'SI.ABSENT(ta_idf_saisi; FAUX)',
    },
    ta_taux_commune: {
      libelle: 'Taux communal',
      unite: 'taux',
      formule: 'SI.ABSENT(ta_taux_commune_saisi; 0)',
    },
    ta_taux_departement: {
      libelle: 'Taux départemental',
      unite: 'taux',
      formule: 'SI.ABSENT(ta_taux_departement_saisi; 0)',
    },
    ta_nb_places: {
      libelle: 'Places extérieures retenues',
      unite: 'nombre',
      formule: 'SI.ABSENT(ta_nb_places_saisi; 0)',
    },
    ta_valeur_place: {
      libelle: 'Valeur d’une place retenue',
      unite: 'eur',
      formule: 'SI.ABSENT(ta_valeur_place_saisie; 0)',
    },
    ta_valeur_forfaitaire: {
      libelle: 'Valeur forfaitaire au mètre carré',
      unite: 'eur_m2',
      regle: 'R-FISC-2',
      formule: 'SI(ta_idf; ta_valeur_idf; ta_valeur_hors_idf)',
    },
    ta_abattement_regime: {
      libelle: 'Abattement du régime',
      unite: 'taux',
      regle: 'R-FISC-2',
      sur: ['code'],
      formule: "DEFAUT(ta_abattement_saisi; CHAMP(ta_regimes; DEFAUT(regime_ta; 'abattement_50')); ta_abattement_social)",
    },
    ta_abattement_global: {
      libelle: 'Abattement de l’opération entière',
      unite: 'taux',
      regle: 'R-FISC-2',
      formule: "DEFAUT(ta_abattement_saisi; CHAMP(ta_regimes; 'abattement_50'); ta_abattement_social)",
    },
    cles_sdp: {
      libelle: 'Tranches de la surface de plancher',
      unite: 'liste',
      formule:
        'SI(RENSEIGNE(ta_quotes_parts_saisies); CLES(ta_quotes_parts_saisies); ' +
        'SI(LONGUEUR(tranches_presentes) > 0; tranches_ordre_saisie; SUITE(1; 0)))',
      note: 'Faute de surface de plancher par tranche, la clé est la quote-part de surface utile.',
    },
    part_sdp: {
      libelle: 'Quote-part de surface de plancher',
      unite: 'taux',
      sur: ['tranche_sdp'],
      formule:
        'SI(RENSEIGNE(ta_quotes_parts_saisies); DEFAUT(CHAMP(ta_quotes_parts_saisies; tranche_sdp); 0); ' +
        'DEFAUT(quote_part_su[tranche: tranche_sdp]; 0))',
    },
    sdp_tranche: {
      libelle: 'Surface de plancher de la tranche',
      unite: 'm2',
      sur: ['tranche_sdp'],
      formule: 'ta_sdp * part_sdp',
    },
    abattement_tranche_sdp: {
      libelle: 'Abattement de la tranche',
      unite: 'taux',
      regle: 'R-FISC-2',
      sur: ['tranche_sdp'],
      formule: 'ta_abattement_regime[code: tranche_sdp]',
    },
    assiette_ta_exacte_tranche: {
      libelle: 'Assiette de la tranche, non arrondie',
      unite: 'eur',
      regle: 'R-FISC-2',
      sur: ['tranche_sdp'],
      formule: 'sdp_tranche * (1 - abattement_tranche_sdp) * ta_valeur_forfaitaire',
    },
    assiette_ta_tranche: {
      libelle: 'Assiette de la tranche',
      unite: 'eur',
      sur: ['tranche_sdp'],
      formule: 'ARRONDI.EURO(assiette_ta_exacte_tranche)',
    },
    assiette_ta_surface: {
      libelle: 'Assiette des surfaces',
      unite: 'eur',
      regle: 'R-FISC-2',
      formule:
        'SI(LONGUEUR(cles_sdp) > 0; SOMME(assiette_ta_exacte_tranche POUR tranche_sdp); ' +
        'ta_sdp * (1 - ta_abattement_global) * ta_valeur_forfaitaire)',
    },
    assiette_ta: {
      libelle: 'Assiette de la taxe d’aménagement',
      unite: 'eur',
      regle: 'R-FISC-2',
      formule: 'assiette_ta_surface + ta_nb_places * ta_valeur_place',
    },
    assiette_ta_arrondie: {
      libelle: 'Assiette de la taxe d’aménagement, arrondie',
      unite: 'eur',
      formule: 'ARRONDI.EURO(assiette_ta)',
    },
    taxe_amenagement: {
      libelle: 'Taxe d’aménagement',
      unite: 'eur',
      regle: 'R-FISC-2',
      formule: 'ARRONDI.EURO(assiette_ta * (ta_taux_commune + ta_taux_departement))',
    },
  },
};
