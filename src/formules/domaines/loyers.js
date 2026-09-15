// @ts-check
/**
 * DOMAINE « LOYERS » - R-LOYER et R-SURF-2 : du plafond de zone au loyer annuel
 * de chaque tranche.
 *
 * Le loyer se construit en quatre temps, chacun avec sa source : le plafond de
 * zone (bareme), revalorise du millesime du bareme a la mise en location
 * (R-LOYER-9) et augmente de la marge locale ; multiplie par le coefficient de
 * structure de la tranche ; majore dans la limite du plafond de marge ; et
 * remplace, s'il est saisi, par un loyer de sortie force.
 *
 * Sources LEON : `calculs!D72:D77` (loyer de base), `calculs!D92` (coefficient
 * de structure), `calculs!D117:D119` (loyer max de base).
 */
import { produit } from '../../produits.js';

/**
 * Loyer maximal reglementaire d'un produit dans sa zone, lu au bareme.
 * Le zonage applicable (1/2/3 ou A/B/C) est une propriete du produit, pas une
 * branche de code (lecon I-1).
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

/** @type {import('../classeur.js').Domaine} */
export const LOYERS = {
  domaine: 'loyers',
  titre: 'Loyers',
  grandeurs: {
    // --- R-LOYER-9 : millesime du bareme -----------------------------------------
    millesime_bareme_123: {
      libelle: 'Millésime du barème 1/2/3',
      unite: 'annee',
      parametre: 'loyers_max_zone_123.annee_reference',
      ecran: 'Paramètres > Loyers plafonds',
    },
    millesime_bareme_abc: {
      libelle: 'Millésime du barème A/B/C',
      unite: 'annee',
      parametre: 'loyers_max_zone_ABC.annee_reference',
      ecran: 'Paramètres > Loyers plafonds',
    },
    millesime_bareme: {
      libelle: 'Millésime des barèmes de loyer',
      unite: 'annee',
      regle: 'R-LOYER-9',
      formule:
        'SI(ET(EST.NOMBRE(millesime_bareme_123); EST.NOMBRE(millesime_bareme_abc)); ' +
        'MIN(millesime_bareme_123; millesime_bareme_abc); ' +
        'SI(EST.NOMBRE(millesime_bareme_123); millesime_bareme_123; ' +
        'SI(EST.NOMBRE(millesime_bareme_abc); millesime_bareme_abc; VIDE)))',
    },
    annees_a_rattraper: {
      libelle: 'Années de revalorisation à rattraper',
      unite: 'nombre',
      regle: 'R-LOYER-9',
      formule: 'SI(millesime_bareme = VIDE; 0; MAX(0; annee_mise_en_location - millesime_bareme))',
    },
    taux_irl: {
      libelle: 'Indice de référence des loyers de l’année',
      unite: 'taux',
      sur: ['an'],
      trajectoire: 'par_poste.loyers_irl[an]',
      ecran: 'Paramètres > Trajectoires macro',
    },
    cumul_irl_millesime: {
      libelle: 'Cumul des IRL depuis le millésime',
      unite: 'coef',
      regle: 'R-LOYER-9',
      formule:
        'SI(annees_a_rattraper > 0; ' +
        'PRODUIT(1 + DEFAUT(taux_irl[an: a]; 0) POUR a DANS SUITE(millesime_bareme + 1; annee_mise_en_location)); 1)',
    },
    option_revaloriser: {
      libelle: 'Revaloriser les plafonds au millésime',
      unite: 'booleen',
      saisie: 'options.revaloriser_loyers_plafonds',
      ecran: 'Paramètres',
    },
    revaloriser_loyers: {
      libelle: 'Revalorisation des plafonds appliquée',
      unite: 'booleen',
      regle: 'R-LOYER-9',
      formule: 'ET(option_revaloriser <> FAUX; annees_a_rattraper > 0)',
      note: 'Par défaut. LEON applique le barème tel quel ; les fixtures qui le reproduisent désactivent l’option.',
    },
    coefficient_millesime: {
      libelle: 'Coefficient de millésime',
      unite: 'coef',
      regle: 'R-LOYER-9',
      formule: 'SI(revaloriser_loyers; cumul_irl_millesime; 1)',
    },

    // --- Parametres de loyer : la tranche d'abord, les lots en repli ---------------
    marge_locale_saisie_tranche: {
      libelle: 'Marge locale saisie',
      unite: 'eur_m2_mois',
      sur: ['tranche'],
      saisie: 'loyers_par_produit[tranche].marge_locale_eur_m2',
      ecran: 'Tranche > Loyers',
    },
    marge_majoration_saisie_tranche: {
      libelle: 'Marge de majoration saisie',
      unite: 'taux',
      sur: ['tranche'],
      saisie: 'loyers_par_produit[tranche].marge_majoration',
      ecran: 'Tranche > Loyers',
    },
    loyer_force_saisi_tranche: {
      libelle: 'Loyer de sortie saisi',
      unite: 'eur_m2_mois',
      sur: ['tranche'],
      saisie: 'loyers_par_produit[tranche].loyer_sortie_force',
      ecran: 'Tranche > Loyers',
    },
    loyer_convention_saisi_tranche: {
      libelle: 'Plafond conventionnel saisi',
      unite: 'eur_m2_mois',
      sur: ['tranche'],
      saisie: 'loyers_par_produit[tranche].loyer_plafond_convention_eur_m2',
      ecran: 'Tranche > Loyers',
    },
    marge_locale_lot: {
      libelle: 'Marge locale portée par le lot',
      unite: 'eur_m2_mois',
      sur: ['lot'],
      saisie: 'lots[lot].marge_locale_eur_m2',
      ecran: 'Programme',
    },
    marge_majoration_lot: {
      libelle: 'Marge de majoration portée par le lot',
      unite: 'taux',
      sur: ['lot'],
      saisie: 'lots[lot].marge_majoration',
      ecran: 'Programme',
    },
    loyer_force_lot: {
      libelle: 'Loyer de sortie porté par le lot',
      unite: 'eur_m2_mois',
      sur: ['lot'],
      saisie: 'lots[lot].loyer_sortie_force',
      ecran: 'Programme',
    },
    loyer_convention_lot: {
      libelle: 'Plafond conventionnel porté par le lot',
      unite: 'eur_m2_mois',
      sur: ['lot'],
      saisie: 'lots[lot].loyer_plafond_convention_eur_m2',
      ecran: 'Programme',
    },
    lot_reference_loyer: {
      libelle: 'Lot de référence des paramètres de loyer',
      unite: 'nombre',
      sur: ['tranche'],
      formule:
        'DEFAUT(PREMIER(lot POUR lot QUAND ET(code_produit_lot = tranche; DEFINI(marge_locale_lot))); ' +
        'PREMIER(lot POUR lot QUAND code_produit_lot = tranche))',
      note: 'Le premier lot de la tranche qui porte une marge locale, à défaut son premier lot. Il ne sert qu’en repli d’une saisie par tranche.',
    },
    lot_loyer_force: {
      libelle: 'Lot portant un loyer de sortie',
      unite: 'nombre',
      sur: ['tranche'],
      formule: 'PREMIER(lot POUR lot QUAND ET(code_produit_lot = tranche; RENSEIGNE(loyer_force_lot)))',
    },
    marge_locale_tranche: {
      libelle: 'Marge locale',
      unite: 'eur_m2_mois',
      regle: 'R-LOYER-1',
      sur: ['tranche'],
      formule:
        'SI.ABSENT(DEFAUT(marge_locale_saisie_tranche; marge_locale_lot[lot: lot_reference_loyer]); 0)',
    },
    marge_majoration_tranche: {
      libelle: 'Marge de majoration demandée',
      unite: 'taux',
      regle: 'R-LOYER-3',
      sur: ['tranche'],
      formule:
        'SI.ABSENT(DEFAUT(marge_majoration_saisie_tranche; marge_majoration_lot[lot: lot_reference_loyer]); 0)',
    },
    loyer_force_tranche: {
      libelle: 'Loyer de sortie forcé',
      unite: 'eur_m2_mois',
      regle: 'R-LOYER-5',
      sur: ['tranche'],
      formule: 'DEFAUT(loyer_force_saisi_tranche; loyer_force_lot[lot: lot_loyer_force])',
    },
    loyer_convention_tranche: {
      libelle: 'Plafond conventionnel',
      unite: 'eur_m2_mois',
      sur: ['tranche'],
      formule: 'DEFAUT(loyer_convention_saisi_tranche; loyer_convention_lot[lot: lot_reference_loyer])',
    },
    foyer_tranche: {
      libelle: 'Tranche en foyer',
      unite: 'booleen',
      regle: 'R-SURF-2',
      sur: ['tranche'],
      formule: 'DEFAUT(produit_foyer; foyer_operation)',
    },

    // --- R-SURF-2 : coefficient de structure -----------------------------------------
    cs_base: {
      libelle: 'Base du coefficient de structure',
      unite: 'coef',
      regle: 'R-SURF-2',
      parametre: 'constantes_reglementaires.coefficient_structure.metropole_habitat.base',
      ecran: 'Paramètres > Constantes réglementaires',
    },
    cs_facteur_habitat: {
      libelle: 'Facteur de structure en habitat',
      unite: 'nombre',
      regle: 'R-SURF-2',
      parametre: 'constantes_reglementaires.coefficient_structure.metropole_habitat.facteur_nl',
      ecran: 'Paramètres > Constantes réglementaires',
    },
    cs_facteur_foyers: {
      libelle: 'Facteur de structure en foyer',
      unite: 'nombre',
      regle: 'R-SURF-2',
      parametre: 'constantes_reglementaires.coefficient_structure.foyers.facteur_nl',
      ecran: 'Paramètres > Constantes réglementaires',
    },
    cs_exact: {
      libelle: 'Coefficient de structure, non arrondi',
      unite: 'coef',
      regle: 'R-SURF-2',
      sur: ['tranche'],
      formule:
        'SI(su_tranche > 0; cs_base * (1 + SI(OU(produit_foyer; foyer_tranche); cs_facteur_foyers; ' +
        'cs_facteur_habitat) * nb_logements_tranche / su_tranche); 0)',
      note: 'Se calcule sur la tranche entière, jamais lot par lot. Une surface utile nulle le ramène à zéro.',
    },
    cs_calcule: {
      libelle: 'Coefficient de structure calculé',
      unite: 'coef',
      regle: 'R-SURF-2',
      sur: ['tranche'],
      formule: 'ARRONDI(cs_exact; 4)',
    },
    cs_tranche: {
      libelle: 'Coefficient de structure',
      unite: 'coef',
      regle: 'R-SURF-2',
      sur: ['tranche'],
      formule: 'SI(produit_loyer_par_convention; 1; SI(produit_avec_cs; cs_calcule; 1))',
    },

    // --- R-LOYER-1/2 : plafond --------------------------------------------------------
    loyer_max_zone: {
      libelle: 'Plafond de loyer de la zone',
      unite: 'eur_m2_mois',
      regle: 'R-LOYER-1',
      sur: ['tranche'],
      lire: (ctx, tranche) =>
        loyerMaxZone(
          tranche,
          { zone_123: ctx.entrees?.identite?.zone_123, zone_ABC: ctx.entrees?.identite?.zone_ABC },
          ctx.baremes,
        ),
      ecran: 'Paramètres > Loyers plafonds',
      note: 'Lu au barème du produit, dans la zone de l’opération.',
    },
    majoration_produit: {
      libelle: 'Majoration de loyer du produit',
      unite: 'taux',
      regle: 'R-LOYER-1',
      sur: ['tranche'],
      lire: (ctx, tranche) => {
        const cle = produit(tranche).majoration_loyer;
        if (!cle) return undefined;
        const maj = ctx.baremes?.constantes_reglementaires?.[cle];
        return typeof maj === 'object' && maj !== null ? maj.valeur : maj;
      },
      ecran: 'Paramètres > Constantes réglementaires',
    },
    loyer_base_bareme: {
      libelle: 'Loyer de base au barème',
      unite: 'eur_m2_mois',
      regle: 'R-LOYER-1',
      sur: ['tranche'],
      formule:
        'ARRONDI((loyer_max_zone * coefficient_millesime + marge_locale_tranche) * ' +
        'SI(produit_avec_majoration; 1 + majoration_produit; 1); 2)',
    },
    loyer_plafond_conventionnel: {
      libelle: 'Plafond conventionnel retenu',
      unite: 'eur_m2_mois',
      sur: ['tranche'],
      formule: 'ARRONDI(DEFAUT(loyer_convention_tranche; 0); 2)',
    },
    loyer_base_tranche: {
      libelle: 'Loyer de base',
      unite: 'eur_m2_mois',
      regle: 'R-LOYER-1',
      sur: ['tranche'],
      formule: 'SI(produit_loyer_par_convention; loyer_plafond_conventionnel; loyer_base_bareme)',
    },
    loyer_max_base_tranche: {
      libelle: 'Loyer plafond',
      unite: 'eur_m2_mois',
      regle: 'R-LOYER-2',
      sur: ['tranche'],
      formule:
        'SI(produit_loyer_par_convention; loyer_plafond_conventionnel; ARRONDI(cs_tranche * loyer_base_tranche; 2))',
    },

    // --- R-LOYER-3/5 : loyer pratique ------------------------------------------------
    loyer_force_actif: {
      libelle: 'Loyer de sortie forcé',
      unite: 'booleen',
      sur: ['tranche'],
      formule: 'RENSEIGNE(loyer_force_tranche)',
    },
    plafond_marge_parametre: {
      libelle: 'Plafond de la marge de majoration',
      unite: 'taux',
      regle: 'R-LOYER-3',
      parametre: 'constantes_reglementaires.marge_locale_plafond_defaut.valeur',
      ecran: 'Paramètres > Constantes réglementaires',
    },
    plafond_marge_tranche: {
      libelle: 'Plafond de marge applicable',
      unite: 'taux',
      regle: 'R-LOYER-3',
      sur: ['tranche'],
      formule: 'SI(produit_loyer_de_marche; INFINI; DEFAUT(plafond_marge_parametre; INFINI))',
      note: 'Aucun plafond sur un loyer de marché : il n’y a pas de convention à respecter.',
    },
    marge_appliquee: {
      libelle: 'Marge de majoration appliquée',
      unite: 'taux',
      regle: 'R-LOYER-3',
      sur: ['tranche'],
      formule: 'MIN(0 + marge_majoration_tranche; plafond_marge_tranche)',
    },
    marge_plafonnee: {
      libelle: 'Marge ramenée au plafond',
      unite: 'booleen',
      regle: 'R-LOYER-3',
      sur: ['tranche'],
      formule: 'marge_appliquee < marge_majoration_tranche',
    },
    loyer_pratique_tranche: {
      libelle: 'Loyer pratiqué',
      unite: 'eur_m2_mois',
      regle: 'R-LOYER-5',
      sur: ['tranche'],
      formule:
        'SI(produit_loyer_par_convention; ARRONDI(DEFAUT(loyer_force_tranche; loyer_plafond_conventionnel); 2); ' +
        'SI(loyer_force_actif; ARRONDI(loyer_force_tranche; 2); ARRONDI(loyer_max_base_tranche * (1 + marge_appliquee); 2)))',
    },
    loyer_annuel_tranche: {
      libelle: 'Loyer annuel de la tranche',
      unite: 'eur',
      regle: 'R-LOYER-5',
      sur: ['tranche'],
      formule: 'ARRONDI.EURO(mois_par_an * su_tranche * loyer_pratique_tranche)',
    },
    loyers_logements_annuels: {
      libelle: 'Loyers annuels des logements',
      unite: 'eur',
      regle: 'R-LOYER-5',
      formule: 'ARRONDI.EURO(SOMME(loyer_annuel_tranche POUR tranche))',
    },
    loyers_annexes_annuels: {
      libelle: 'Loyers annuels des annexes louées',
      unite: 'eur',
      regle: 'R-LOYER-7',
      formule: 'ARRONDI.EURO(SOMME(nombre_annexe * loyer_unitaire_annexe * mois_par_an POUR annexe))',
      note: 'Garages, parkings, commerces : ils ne passent pas par le coefficient de structure.',
    },
  },
};
