// @ts-check
/**
 * DOMAINE « SUBVENTIONS » - R-SUB : rattachement de chaque subvention a sa
 * tranche, totaux, et subvention de surcharge fonciere.
 *
 * Une subvention est rattachee a un FINANCEMENT, comme un pret ou des fonds
 * propres, ou elle n'existe pas au plan (arbitrage metier du 10/09/2026). Trois
 * cas : la tranche nommee figure au programme et la porte ; aucune n'est nommee
 * mais le programme n'en compte qu'une, et c'est elle ; sinon la subvention
 * reste HORS PLAN - elle ne finance rien et ne compte dans aucun total.
 *
 * Sources : `calculs!B254:B264` (SLA), `calculs!D274:B292` (surcharge
 * fonciere), referentiel `ssf` et `valeurs_de_base`.
 */

/** @type {import('../classeur.js').Domaine} */
export const SUBVENTIONS = {
  domaine: 'subventions',
  titre: 'Subventions',
  dimensions: {
    subvention: {
      libelle: 'Subvention',
      valeurs: 'INDICES(subventions_saisies)',
      etiquette: 'libelle_subvention',
    },
  },
  grandeurs: {
    // --- Saisie ---------------------------------------------------------------
    subventions_saisies: {
      libelle: 'Subventions saisies',
      unite: 'liste',
      saisie: 'subventions',
      ecran: 'Plan de financement',
    },
    libelle_subvention: {
      libelle: 'Libellé de la subvention',
      unite: 'texte',
      sur: ['subvention'],
      saisie: 'subventions[subvention].libelle',
      ecran: 'Plan de financement',
    },
    montant_subvention_saisi: {
      libelle: 'Montant saisi',
      unite: 'eur',
      sur: ['subvention'],
      saisie: 'subventions[subvention].montant_eur',
      ecran: 'Plan de financement',
    },
    gratuite_subvention: {
      libelle: 'Subvention gratuite',
      unite: 'booleen',
      sur: ['subvention'],
      saisie: 'subventions[subvention].gratuite',
      ecran: 'Plan de financement',
    },
    affectation_subvention: {
      libelle: 'Tranche indiquée',
      unite: 'texte',
      sur: ['subvention'],
      saisie: 'subventions[subvention].affectation',
      ecran: 'Plan de financement',
    },

    // --- R-SUB-3 : rattachement -------------------------------------------------
    montant_subvention: {
      libelle: 'Montant de la subvention',
      unite: 'eur',
      sur: ['subvention'],
      formule: 'NOMBRE(montant_subvention_saisi)',
    },
    subvention_retenue: {
      libelle: 'Subvention à montant non nul',
      unite: 'booleen',
      sur: ['subvention'],
      formule: 'montant_subvention <> 0',
    },
    affectation_nettoyee: {
      libelle: 'Tranche indiquée, sans espaces',
      unite: 'texte',
      sur: ['subvention'],
      formule: 'SUPPRESPACE(affectation_subvention)',
    },
    tranche_designee: {
      libelle: 'Tranche désignée',
      unite: 'texte',
      regle: 'R-SUB-3',
      sur: ['subvention'],
      formule:
        "SI(affectation_nettoyee = ''; VIDE; " +
        'PREMIER(t POUR t DANS tranches_ordre_saisie QUAND MAJUSCULE(t) = MAJUSCULE(affectation_nettoyee)))',
      note: 'Une affectation nomme UNE tranche du programme, sans tenir compte de la casse. Le PLUS et le PLAI sont deux tranches distinctes.',
    },
    affectation_introuvable: {
      libelle: 'Tranche indiquée absente du programme',
      unite: 'booleen',
      regle: 'R-SUB-3',
      sur: ['subvention'],
      formule: "ET(affectation_nettoyee <> ''; tranche_designee = VIDE)",
    },
    tranche_subvention: {
      libelle: 'Tranche de la subvention',
      unite: 'texte',
      regle: 'R-SUB-3',
      sur: ['subvention'],
      formule:
        'DEFAUT(tranche_designee; SI(ET(NON(affectation_introuvable); LONGUEUR(tranches_ordre_saisie) = 1); ' +
        'ELEMENT(tranches_ordre_saisie; 0); VIDE))',
      note: 'Sans tranche indiquée, la tranche unique du programme ; sur un programme mixte, aucune.',
    },
    subvention_rattachee: {
      libelle: 'Subvention au plan',
      unite: 'booleen',
      regle: 'R-SUB-3',
      sur: ['subvention'],
      formule: 'ET(subvention_retenue; RENSEIGNE(tranche_subvention))',
    },
    subvention_hors_plan: {
      libelle: 'Subvention hors plan',
      unite: 'booleen',
      regle: 'R-SUB-3',
      sur: ['subvention'],
      formule: 'ET(subvention_retenue; NON(RENSEIGNE(tranche_subvention)))',
    },

    // --- Totaux -----------------------------------------------------------------
    subventions_gratuites_exactes: {
      libelle: 'Subventions gratuites, non arrondies',
      unite: 'eur',
      formule: 'SOMME(montant_subvention POUR subvention QUAND ET(subvention_rattachee; gratuite_subvention))',
    },
    subventions_non_gratuites_exactes: {
      libelle: 'Subventions non gratuites, non arrondies',
      unite: 'eur',
      formule:
        'SOMME(montant_subvention POUR subvention QUAND ET(subvention_rattachee; NON(gratuite_subvention)))',
    },
    subventions_gratuites: {
      libelle: 'Subventions gratuites',
      unite: 'eur',
      formule: 'ARRONDI.EURO(subventions_gratuites_exactes)',
    },
    subventions_non_gratuites: {
      libelle: 'Subventions non gratuites',
      unite: 'eur',
      formule: 'ARRONDI.EURO(subventions_non_gratuites_exactes)',
    },
    subventions_saisies_total: {
      libelle: 'Subventions au plan',
      unite: 'eur',
      formule: 'ARRONDI.EURO(subventions_gratuites_exactes + subventions_non_gratuites_exactes)',
    },
    subventions_tranche: {
      libelle: 'Subventions rattachées à la tranche',
      unite: 'eur',
      regle: 'R-SUB-3',
      sur: ['tranche'],
      formule:
        'ARRONDI.EURO(SOMME(montant_subvention POUR subvention QUAND ET(subvention_rattachee; tranche_subvention = tranche)))',
    },

    // --- R-SUB-2 : surcharge fonciere -----------------------------------------
    ssf_saisie: {
      libelle: 'Surcharge foncière saisie',
      unite: 'liste',
      saisie: 'surcharge_fonciere',
      ecran: 'Plan de financement',
    },
    ssf_active: {
      libelle: 'Surcharge foncière demandée',
      unite: 'booleen',
      regle: 'R-SUB-2',
      formule: 'SI(ssf_saisie; VRAI; FAUX)',
    },
    ssf_zone_saisie: {
      libelle: 'Zone 1/2/3 saisie pour la surcharge foncière',
      unite: 'texte',
      saisie: 'surcharge_fonciere.zone_123',
      ecran: 'Plan de financement',
    },
    ssf_type_saisi: {
      libelle: 'Type d’opération saisi pour la surcharge foncière',
      unite: 'texte',
      saisie: 'surcharge_fonciere.type',
      ecran: 'Plan de financement',
    },
    ssf_habitat_saisi: {
      libelle: 'Forme d’habitat saisie',
      unite: 'texte',
      saisie: 'surcharge_fonciere.habitat',
      ecran: 'Plan de financement',
    },
    ssf_eligible_saisi: {
      libelle: 'Éligibilité saisie',
      unite: 'booleen',
      saisie: 'surcharge_fonciere.eligible',
      ecran: 'Plan de financement',
    },
    ssf_valeur_fonciere: {
      libelle: 'Valeur foncière réelle',
      unite: 'eur',
      saisie: 'surcharge_fonciere.valeur_fonciere_eur',
      ecran: 'Plan de financement',
    },
    ssf_valeur_de_base_saisie: {
      libelle: 'Valeur de base saisie',
      unite: 'eur_m2',
      saisie: 'surcharge_fonciere.valeur_de_base_eur_m2',
      ecran: 'Plan de financement',
    },
    ssf_su: {
      libelle: 'Surface utile de la surcharge foncière',
      unite: 'm2',
      saisie: 'surcharge_fonciere.su_ssf_m2',
      ecran: 'Plan de financement',
    },
    ssf_participations_saisies: {
      libelle: 'Participations des collectivités saisies',
      unite: 'eur',
      saisie: 'surcharge_fonciere.participations_collectivites_eur',
      ecran: 'Plan de financement',
    },
    ssf_zone_123: {
      libelle: 'Zone 1/2/3 de la surcharge foncière',
      unite: 'texte',
      formule: 'SI(DEFINI(ssf_zone_saisie); ssf_zone_saisie; zone_123)',
    },
    ssf_type: {
      libelle: 'Type d’opération de la surcharge foncière',
      unite: 'texte',
      regle: 'R-SUB-2',
      formule:
        "SI(DEFINI(ssf_type_saisi); ssf_type_saisi; SI(TEXTE.CONTIENT(type_operation; 'acq'); 'acq_amelioration'; 'neuf'))",
      note: 'Neuf ou acquisition-amélioration, déduit du type d’opération : les taux diffèrent.',
    },
    ssf_habitat: {
      libelle: 'Forme d’habitat',
      unite: 'texte',
      formule: "SI.ABSENT(ssf_habitat_saisi; 'collectif')",
    },
    ssf_eligible_demande: {
      libelle: 'Opération déclarée éligible',
      unite: 'booleen',
      formule: 'SI.ABSENT(ssf_eligible_saisi; VRAI)',
    },
    ssf_participations: {
      libelle: 'Participations des collectivités',
      unite: 'eur',
      formule: 'SI.ABSENT(ssf_participations_saisies; 0)',
    },
    table_valeurs_de_base: {
      libelle: 'Barème des valeurs de base',
      unite: 'liste',
      regle: 'R-SUB-2',
      parametre: 'valeurs_de_base',
      ecran: 'Paramètres > Foncier et fiscalité',
    },
    vb_colonne: {
      libelle: 'Colonne du barème des valeurs de base',
      unite: 'liste',
      formule:
        "CHAMP(CHAMP(table_valeurs_de_base; SI(ssf_type = 'neuf'; 'neuf'; 'acquisition')); ssf_habitat)",
    },
    vb_rang_zone: {
      libelle: 'Rang de la zone dans le barème',
      unite: 'nombre',
      formule: "POSITION(CHAMP(table_valeurs_de_base; 'zones'); TEXTE.JOINDRE('zone_'; ssf_zone_123))",
    },
    valeur_de_base_bareme: {
      libelle: 'Valeur de base au barème',
      unite: 'eur_m2',
      regle: 'R-SUB-2',
      formule:
        'SI(NON(table_valeurs_de_base); 0; SI(NON(vb_colonne); 0; SI(vb_rang_zone < 0; 0; ELEMENT(vb_colonne; vb_rang_zone))))',
      note: 'Lue par zone, par type d’opération et par forme d’habitat (ParaGEN!D36:G41).',
    },
    ssf_valeur_de_base: {
      libelle: 'Valeur de base',
      unite: 'eur_m2',
      regle: 'R-SUB-2',
      formule: 'DEFAUT(ssf_valeur_de_base_saisie; valeur_de_base_bareme)',
      note: 'Une valeur saisie prime : c’est le recours quand un arrêté local s’écarte du barème.',
    },
    ssf_reference: {
      libelle: 'Charge foncière de référence',
      unite: 'eur',
      regle: 'R-SUB-2',
      formule: 'ssf_valeur_de_base * ssf_su',
    },
    ssf_depassement: {
      libelle: 'Dépassement de la charge foncière',
      unite: 'eur',
      regle: 'R-SUB-2',
      formule: 'ssf_valeur_fonciere - ssf_reference',
    },
    ssf_eligible: {
      libelle: 'Surcharge foncière subventionnable',
      unite: 'booleen',
      regle: 'R-SUB-2',
      formule: 'ET(ssf_eligible_demande; NON(ssf_depassement <= 0))',
    },
    ssf_table_taux_depassement: {
      libelle: 'Taux de dépassement plafonné, par type',
      unite: 'liste',
      parametre: 'constantes_reglementaires.ssf.taux_depassement_plafonne',
      ecran: 'Paramètres > Constantes réglementaires',
    },
    ssf_table_taux_subvention: {
      libelle: 'Taux de subvention, par type',
      unite: 'liste',
      parametre: 'constantes_reglementaires.ssf.taux_subvention',
      ecran: 'Paramètres > Constantes réglementaires',
    },
    ssf_taux_depassement: {
      libelle: 'Taux de dépassement plafonné',
      unite: 'taux',
      regle: 'R-SUB-2',
      formule: 'CHAMP(ssf_table_taux_depassement; ssf_type)',
    },
    ssf_taux_subvention: {
      libelle: 'Taux de subvention',
      unite: 'taux',
      regle: 'R-SUB-2',
      formule: 'CHAMP(ssf_table_taux_subvention; ssf_type)',
    },
    ssf_seuil_participation: {
      libelle: 'Seuil de participation des collectivités',
      unite: 'taux',
      regle: 'R-SUB-2',
      parametre: 'constantes_reglementaires.ssf.seuil_participation_collectivites',
      ecran: 'Paramètres > Constantes réglementaires',
    },
    ssf_part_max_depassement: {
      libelle: 'Part maximale du dépassement',
      unite: 'taux',
      regle: 'R-SUB-2',
      parametre: 'constantes_reglementaires.ssf.part_max_depassement',
      ecran: 'Paramètres > Constantes réglementaires',
    },
    ssf_sous_seuil: {
      libelle: 'Collectivités sous le seuil de participation',
      unite: 'booleen',
      regle: 'R-SUB-2',
      formule: 'ssf_participations < ssf_seuil_participation * ssf_depassement',
    },
    ssf_plafond: {
      libelle: 'Plafond du dépassement',
      unite: 'eur',
      regle: 'R-SUB-2',
      formule:
        'SI(ssf_sous_seuil; MIN(ssf_taux_depassement * ssf_reference; ssf_part_max_depassement * ssf_depassement); ' +
        'ssf_taux_depassement * ssf_reference)',
      note: 'Le plafond conditionnel ne joue que si les collectivités participent sous le seuil réglementaire.',
    },
    ssf_depassement_plafonne: {
      libelle: 'Dépassement plafonné',
      unite: 'eur',
      regle: 'R-SUB-2',
      formule: 'MIN(ssf_depassement; ssf_plafond)',
    },
    ssf_reference_arrondie: {
      libelle: 'Charge foncière de référence, arrondie',
      unite: 'eur',
      formule: 'ARRONDI.EURO(ssf_reference)',
    },
    ssf_depassement_arrondi: {
      libelle: 'Dépassement, arrondi',
      unite: 'eur',
      formule: 'SI(ssf_eligible; ARRONDI.EURO(ssf_depassement); ARRONDI.EURO(MAX(ssf_depassement; 0)))',
    },
    ssf_depassement_plafonne_arrondi: {
      libelle: 'Dépassement plafonné, arrondi',
      unite: 'eur',
      formule: 'SI(ssf_eligible; ARRONDI.EURO(ssf_depassement_plafonne); 0)',
    },
    ssf_subvention_calculee: {
      libelle: 'Subvention de surcharge foncière calculée',
      unite: 'eur',
      regle: 'R-SUB-2',
      formule: 'SI(ssf_eligible; ARRONDI.EURO(ssf_taux_subvention * ssf_depassement_plafonne); 0)',
    },
    subvention_surcharge_fonciere: {
      libelle: 'Subvention de surcharge foncière',
      unite: 'eur',
      regle: 'R-SUB-2',
      formule: 'SI(ssf_active; ssf_subvention_calculee; 0)',
    },
    subventions_total: {
      libelle: 'Subventions du plan de financement',
      unite: 'eur',
      regle: 'R-SUB-3',
      formule: 'ARRONDI.EURO(subventions_saisies_total + subvention_surcharge_fonciere)',
    },
  },
};
