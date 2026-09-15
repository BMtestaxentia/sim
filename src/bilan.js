// @ts-check
/**
 * R-TVA - Prix de revient, TVA et livraison a soi-meme (LASM).
 *
 * LES FORMULES VIVENT DANS `formules/domaines/prix_revient.js`, ecrites une
 * fois en blocs : les postes et leur TVA, le taux de livraison a soi-meme de
 * chaque tranche, la ventilation au prorata des surfaces et les repartitions
 * sans perte. C'est la que le moteur les execute, et de la que l'ecran les
 * affiche.
 *
 * Ce module garde :
 *  - la RESTITUTION du prix de revient, sous la forme que l'ecran et les
 *    exports consomment ;
 *  - les fonctions historiques (`prixDeRevient`, `prixDeRevientVentile`,
 *    `tauxLASM`...). Elles evaluent ces memes formules sur les valeurs qu'on
 *    leur donne : elles ne calculent rien elles-memes ;
 *  - trois regles encore ecrites ici, que le moteur n'emploie qu'en marge
 *    (valeur comptable du terrain, base d'amortissement comptable, cle de
 *    repartition generique).
 *
 * Unites : montants en euros.
 */
import { arrondiEuro } from './arrondis.js';
import { nouveauClasseur } from './formules/modele.js';

/** @typedef {'charge_fonciere'|'batiment'|'honoraires'|'frais_divers'} Chapitre */

/**
 * @typedef {Object} Poste
 * @property {Chapitre} chapitre
 * @property {string} libelle
 * @property {number} montant_ht_eur
 * @property {number} taux_tva            taux de saisie (fraction)
 * @property {'collectif'|'individuel'} [nature] defaut 'collectif'
 * @property {boolean} [hors_lasm]        poste non soumis a la livraison a soi-meme
 */

/**
 * Classeur reduit a des postes et a des tranches donnees, pour evaluer les
 * formules du prix de revient hors d'une operation complete.
 * @param {{postes: any[], codes: string[], modulation_ttc_eur?: number, qpv?: boolean, referentiels?: any}} p
 */
function classeurDePostes({ postes, codes, modulation_ttc_eur, qpv = false, referentiels }) {
  const c = nouveauClasseur({ entrees: { postes_bilan: postes, modulation_ttc_eur }, baremes: referentiels });
  c.fixerDimension('tranche', codes).fixer('tranches_ordre_saisie', {}, codes).fixer('qpv', {}, Boolean(qpv));
  return c;
}

/**
 * R-TVA-1 - Ventilation HT / TVA / TTC d'un poste au taux de saisie.
 * Formules : `ht_poste`, `tva_saisie_poste`, `ttc_saisie_poste`.
 * @param {Poste} poste
 * @returns {{ht_eur: number, tva_eur: number, ttc_eur: number}}
 */
export function ventilerPoste(poste) {
  const c = nouveauClasseur({ entrees: { postes_bilan: [poste] } });
  const P = { poste: 0 };
  return {
    ht_eur: c.valeur('ht_poste', P),
    tva_eur: c.valeur('tva_saisie_poste', P),
    ttc_eur: c.valeur('ttc_saisie_poste', P),
  };
}

/**
 * R-TVA-3 - Montant HT d'un poste, quel que soit son mode de saisie : global,
 * ou tranche par tranche - la saisie par tranche fait alors foi. Formule : `ht_poste`.
 * @param {{montant_ht_eur?: number, montants_ht_par_produit?: Record<string, number>}} poste
 * @returns {number}
 */
export function montantHTPoste(poste) {
  return nouveauClasseur({ entrees: { postes_bilan: [poste] } }).valeur('ht_poste', { poste: 0 });
}

/**
 * R-TVA-2 - Taux de TVA applicable a un poste POUR UNE TRANCHE donnee.
 * Formule : `taux_tva_poste_tranche`.
 * @param {{taux_tva?: number, taux_tva_par_produit?: Record<string, number>, hors_lasm?: boolean}} poste
 * @param {string} code
 * @param {number} [taux_produit] taux de livraison a soi-meme du produit
 * @returns {number}
 */
export function tauxTVAPoste(poste, code, taux_produit) {
  const c = nouveauClasseur({ entrees: { postes_bilan: [poste] } });
  c.fixerDimension('tranche', [code]).fixer('taux_lasm', { tranche: code }, taux_produit);
  return c.valeur('taux_tva_poste_tranche', { poste: 0, tranche: code });
}

/**
 * Taux de livraison a soi-meme applicable a un produit (R-TVA-2).
 * Formule : `taux_lasm`.
 * @param {string} code_produit
 * @param {any} referentiels
 * @param {{qpv?: boolean}} [contexte]
 * @returns {number}
 */
export function tauxLASM(code_produit, referentiels, contexte = {}) {
  const c = nouveauClasseur({ entrees: {}, baremes: referentiels });
  c.fixerDimension('tranche', [code_produit]).fixer('qpv', {}, Boolean(contexte.qpv));
  return c.valeur('taux_lasm', { tranche: code_produit });
}

/**
 * R-TVA-2 - Taux de TVA qu'une ligne de prix de revient peut porter sur une
 * tranche donnee, tries.
 *
 * Le taux social est propre au produit : 5,5 % existe sur du PLAI, pas sur du
 * PLS. Offrir la liste complete partout laissait saisir un taux qui n'existe
 * pas, et c'est ainsi qu'une tranche PLS se retrouvait a 5,5 %. Le taux normal
 * et le taux nul restent possibles partout : des honoraires se facturent a 20 %
 * et une taxe ne porte pas de TVA, quel que soit le produit.
 *
 * Ce n'est pas un montant mais la liste des choix qu'offre l'ecran.
 *
 * @param {string} code_produit
 * @param {any} referentiels
 * @param {{qpv?: boolean}} [contexte]
 * @returns {number[]}
 */
export function tauxTVAAdmissibles(code_produit, referentiels, contexte = {}) {
  const toujours = referentiels.tva.taux_saisie_admissibles?.toujours ?? [0, referentiels.tva.taux_normal];
  const social = tauxLASM(code_produit, referentiels, contexte);
  return [...new Set([...toujours, social])].sort((a, b) => a - b);
}

/**
 * Detail poste par poste, tel que la lecture d'un seul tenant le restitue.
 * @param {import('./formules/classeur.js').Classeur} c
 */
function postesGlobaux(c) {
  return c.valeursDimension('poste').map((p) => {
    const P = { poste: p };
    const v = (/** @type {string} */ id) => c.valeur(id, P);
    return {
      // Identifiant stable du poste, s'il en porte un : c'est lui qui permet a
      // une restitution de retrouver sa ligne de saisie, jamais le rang.
      id: v('id_poste'),
      chapitre: v('chapitre_poste'),
      libelle: v('libelle_poste'),
      taux_tva: v('taux_tva_poste'),
      ht_eur: v('ht_poste_arrondi'),
      tva_eur: v('tva_saisie_poste_arrondie'),
      ttc_eur: v('ttc_saisie_poste_arrondi'),
      ttc_lasm_eur: v('ttc_lasm_reference_poste_arrondi'),
    };
  });
}

/**
 * R-TVA-1/2 - Prix de revient d'un produit, d'un seul tenant.
 *
 * Deux lectures du meme bilan : `ttc_eur` au taux de TVA de chaque poste (ce
 * que coute l'operation), `ttc_lasm_eur` au taux de livraison a soi-meme du
 * produit (R-TVA-2), qui sert de base au plan de financement.
 *
 * @param {{code_produit: string, postes: Poste[], modulation_ttc_eur?: number, qpv?: boolean}} p
 * @param {any} referentiels
 */
export function prixDeRevient({ code_produit, postes, modulation_ttc_eur = 0, qpv = false }, referentiels) {
  const c = classeurDePostes({ postes, codes: [code_produit], modulation_ttc_eur, qpv, referentiels });
  c.fixer('tranche_reference', {}, code_produit);
  /** @type {Record<string, any>} */
  const chapitres = {};
  for (const ch of c.valeursDimension('chapitre')) {
    const C = { chapitre: ch };
    chapitres[ch] = {
      ht_eur: c.valeur('ht_chapitre_global', C),
      tva_eur: c.valeur('tva_chapitre_global', C),
      ttc_eur: c.valeur('ttc_chapitre_global', C),
      ttc_lasm_eur: c.valeur('ttc_lasm_chapitre_global', C),
    };
  }
  return {
    taux_lasm: c.valeur('taux_lasm_reference'),
    chapitres,
    postes: postesGlobaux(c),
    total_ht_eur: c.valeur('total_ht_global'),
    total_tva_eur: c.valeur('total_tva_global'),
    total_ttc_eur: c.valeur('total_ttc_global'),
    /** Base du plan de financement (R-TVA-2). */
    total_ttc_lasm_eur: c.valeur('total_ttc_lasm_global'),
    /** R-TVA-4 : prix de revient module, reference de l'equilibre R-FIN-1. */
    total_ttc_module_eur: c.valeur('total_ttc_module_global'),
    modulation_ttc_eur: c.valeur('modulation_ttc'),
  };
}

/**
 * Ventilation du prix de revient par tranche, telle que le moteur la restitue.
 * Les tranches suivent l'ordre de saisie des lots : c'est celui des
 * repartitions sans perte.
 * @param {import('./formules/classeur.js').Classeur} c
 */
export function restituerVentilation(c) {
  const codes = c.valeur('tranches_ordre_saisie');
  const v = (/** @type {string} */ id, /** @type {Record<string, any>} */ idx) => c.valeur(id, idx);
  const parts = Object.fromEntries(codes.map((code) => [code, v('quote_part_su', { tranche: code })]));

  /** @type {Record<string, any>} */
  const parTranche = {};
  for (const code of codes) {
    const T = { tranche: code };
    parTranche[code] = {
      part_su: parts[code],
      su_m2: v('su_tranche', T),
      taux_lasm: v('taux_lasm', T),
      total_ht_eur: v('total_ht_tranche', T),
      total_tva_eur: v('total_tva_tranche', T),
      total_ttc_eur: v('total_ttc_tranche', T),
      total_ttc_lasm_eur: v('total_ttc_lasm_tranche', T),
      total_ttc_module_eur: v('total_ttc_module_tranche', T),
    };
  }

  /** @type {Record<string, any>} */
  const chapitres = {};
  for (const ch of c.valeursDimension('chapitre')) {
    const C = { chapitre: ch };
    chapitres[ch] = {
      ht_eur: v('ht_chapitre', C),
      tva_eur: v('tva_chapitre', C),
      ttc_eur: v('ttc_chapitre', C),
      ttc_lasm_eur: v('ttc_lasm_chapitre', C),
      par_tranche: Object.fromEntries(
        codes.map((code) => {
          const CT = { chapitre: ch, tranche: code };
          return [
            code,
            {
              ht_eur: v('ht_chapitre_tranche', CT),
              tva_eur: v('tva_chapitre_tranche', CT),
              ttc_eur: v('ttc_chapitre_tranche', CT),
              ttc_lasm_eur: v('ttc_lasm_chapitre_tranche', CT),
            },
          ];
        }),
      ),
    };
  }

  const postes = c.valeursDimension('poste').map((p) => {
    const P = { poste: p };
    return {
      id: v('id_poste', P),
      chapitre: v('chapitre_poste', P),
      libelle: v('libelle_poste', P),
      taux_tva: v('taux_tva_poste', P),
      ventile_a_la_main: v('ventile_a_la_main_poste', P),
      ht_eur: v('ht_poste_arrondi', P),
      tva_eur: v('tva_poste_ventile', P),
      ttc_eur: v('ttc_poste_ventile', P),
      ttc_lasm_eur: v('ttc_lasm_poste_ventile', P),
      par_tranche: Object.fromEntries(
        codes.map((code) => {
          const PT = { poste: p, tranche: code };
          return [
            code,
            {
              // Part REELLEMENT appliquee, et non la cle de l'operation : sur
              // une ligne ventilee a la main, afficher le prorata SU mentirait.
              part: v('part_poste_tranche', PT),
              explicite: v('ventile_a_la_main_poste', P),
              taux_tva: v('taux_tva_poste_tranche', PT),
              ht_eur: v('ht_poste_tranche', PT),
              tva_eur: v('tva_poste_tranche', PT),
              ttc_eur: v('ttc_poste_tranche', PT),
              ttc_lasm_eur: v('ttc_lasm_poste_tranche', PT),
            },
          ];
        }),
      ),
    };
  });

  return {
    cle_ventilation: 'surface_utile',
    parts,
    par_tranche: parTranche,
    chapitres,
    postes,
    total_ht_eur: v('total_ht', {}),
    total_tva_eur: v('total_tva', {}),
    total_ttc_eur: v('total_ttc', {}),
    total_ttc_lasm_eur: v('total_ttc_lasm', {}),
    total_ttc_module_eur: v('total_ttc_module', {}),
  };
}

/**
 * R-TVA-2/3 - Prix de revient VENTILE par tranche de financement, a partir de
 * postes et de surfaces donnes. Formules du domaine « prix de revient ».
 * @param {{postes: Poste[], su_par_produit: Record<string, number>, modulation_ttc_eur?: number, qpv?: boolean}} p
 * @param {any} referentiels
 */
export function prixDeRevientVentile({ postes, su_par_produit, modulation_ttc_eur = 0, qpv = false }, referentiels) {
  const codes = Object.keys(su_par_produit);
  const c = classeurDePostes({ postes, codes, modulation_ttc_eur, qpv, referentiels });
  for (const code of codes) c.fixer('su_tranche', { tranche: code }, su_par_produit[code]);
  return restituerVentilation(c);
}

/**
 * Prix de revient de l'operation, tel que le moteur le restitue : la lecture
 * d'un seul tenant (detail des postes, taux de reference) et la ventilation
 * par tranche, qui fait FOI pour les chapitres et les totaux - elle applique a
 * chaque tranche son propre taux de livraison a soi-meme, la ou la lecture
 * d'un seul tenant n'en applique qu'un.
 * @param {import('./formules/classeur.js').Classeur} c
 */
export function restituerPrixDeRevient(c) {
  // Lu en premier : un programme sans tranche arrete le calcul ici.
  const tauxReference = c.valeur('taux_lasm_reference');
  const ventilation = restituerVentilation(c);
  const codes = c.valeursDimension('tranche');
  return {
    taux_lasm: tauxReference,
    chapitres: ventilation.chapitres,
    postes: postesGlobaux(c),
    total_ht_eur: ventilation.total_ht_eur,
    total_tva_eur: ventilation.total_tva_eur,
    total_ttc_eur: ventilation.total_ttc_eur,
    total_ttc_lasm_eur: ventilation.total_ttc_lasm_eur,
    total_ttc_module_eur: ventilation.total_ttc_module_eur,
    modulation_ttc_eur: c.valeur('modulation_ttc'),
    ventilation,
    par_tranche: ventilation.par_tranche,
    taux_lasm_par_tranche: Object.fromEntries(
      codes.map((code) => [code, ventilation.par_tranche[code].taux_lasm]),
    ),
  };
}

/**
 * Valeur comptable du terrain, part du prix de revient qui ne s'amortit pas.
 *
 * ATTENTION, la quotite est un PARAMETRE et non une constante : l'annexe
 * OP-1 applique 25 % du poste Terrain, alors que `baremes_her_2027.json` porte
 * une table par zone donnant 13 % en B1. Les deux valeurs coexistent dans les
 * sources et ne sont pas arbitrees (QUESTIONS_SPEC Q-26). L'appelant fournit
 * donc la quotite qu'il retient, et la fonction ne choisit pas a sa place.
 *
 * @param {Object} p
 * @param {number} p.montant_terrain_eur  poste de terrain ou d'acquisition VEFA
 * @param {number} p.quotite              part non amortissable (fraction)
 * @returns {number}
 */
export function valeurComptableTerrain({ montant_terrain_eur, quotite }) {
  return nouveauClasseur({
    entrees: { amortissement_comptable: { montant_terrain_eur, quotite_terrain: quotite } },
  }).valeur('valeur_comptable_terrain');
}

/**
 * Base d'amortissement comptable : prix de revient TTC moins la valeur
 * comptable du terrain. C'est l'assiette de la dotation aux amortissements.
 * Source : Grille d'analyse LEON (« base d'amortissement »), verifiee sur
 * l'annexe OP-1 (2 065 829,65 - 478 360,03 = 1 587 469,62).
 *
 * @param {Object} p
 * @param {number} p.prix_revient_ttc_eur
 * @param {number} p.valeur_comptable_terrain_eur
 * @returns {{base_eur: number, part_du_prix_revient: number|null}}
 */
export function baseAmortissementComptable({ prix_revient_ttc_eur, valeur_comptable_terrain_eur }) {
  const c = nouveauClasseur({})
    .fixer('total_ttc_module', {}, prix_revient_ttc_eur)
    .fixer('valeur_comptable_terrain', {}, valeur_comptable_terrain_eur);
  return {
    base_eur: c.valeur('base_amortissement_comptable'),
    part_du_prix_revient: c.valeur('part_amortissable'),
  };
}

/**
 * R-TVA-3 - Cle de repartition d'un montant global entre produits.
 * Defaut : quote-part de surface utile. Les variantes SDP et SHAB se demandent
 * explicitement, elles ne sont pas un branchement cache.
 * @param {number} montant_eur
 * @param {Record<string, number>} quotes_parts
 * @returns {Record<string, number>}
 */
export function ventilerParQuotePart(montant_eur, quotes_parts) {
  /** @type {Record<string, number>} */
  const r = {};
  for (const [code, qp] of Object.entries(quotes_parts)) r[code] = montant_eur * qp;
  return r;
}
