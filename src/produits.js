// @ts-check
/**
 * Definitions PARAMETRIQUES des produits de financement (lecon I-1 de LEON :
 * le moteur y est duplique 14 fois, un onglet par produit, avec des divergences
 * de bugs. Ici le produit est une DONNEE, jamais du code duplique).
 *
 * V1 : PLUS / PLAI / PLS habitat. Les autres (LIBRE, LOC/LLI, foyers) sont
 * declares en squelette pour figer l'architecture des le depart ; ils seront
 * completes a leur tour sans reecriture du moteur.
 *
 * Chaque produit decrit : le schema de loyer (barreme + majorations applicables),
 * le taux de LASM (TVA de livraison a soi-meme), et le jeu de prets CDC par defaut.
 * Les VALEURS chiffrees ne sont pas ici : elles vivent dans referentiels/. Ce
 * fichier ne porte que la STRUCTURE et les references aux cles de bareme.
 *
 * @typedef {'PLUS'|'PLUS33'|'PLAI'|'LIBRE'|'LOC'|'PLS'} CodeProduit
 *
 * @typedef {Object} PretDefaut
 * @property {'construction'|'foncier'} nature
 * @property {string} taux_ref        cle de calcul du taux (ex. 'LA+0.60', 'LA-0.20', 'fixe')
 * @property {string} duree_ref       cle de duree (ex. '40', 'zone_abc:B2|C->50,sinon->60')
 * @property {'DOUBLE'|'D.LIMITEE'|'SIMPLE'} revisabilite
 *
 * @typedef {Object} DefinitionProduit
 * @property {CodeProduit} code
 * @property {string} libelle
 * @property {string} cle_bareme_loyer   cle dans referentiels/baremes_2025.json (ex. 'PLUS')
 * @property {'123'|'ABC'} zonage        quel zonage indexe le bareme de loyer de ce produit
 * @property {string} [majoration_loyer] cle d'une majoration multiplicative du loyer de base
 * @property {string} cle_lasm           cle du taux LASM (ex. 'taux_reduit_simulation')
 * @property {boolean} coefficient_structure  le loyer passe-t-il par le CS (R-SURF-2) ?
 * @property {number} duree_exoneration_tfpb_ans  R-FISC-1, propriete du PRODUIT (CGI)
 * @property {PretDefaut[]} prets_defaut
 * @property {boolean} v1                traite dans la V1 (PLUS/PLAI/PLS) ?
 */

/** @type {Record<CodeProduit, DefinitionProduit>} */
export const PRODUITS = {
  PLUS: {
    code: 'PLUS',
    libelle: 'PLUS',
    cle_bareme_loyer: 'PLUS',
    zonage: '123',
    cle_lasm: 'taux_reduit_simulation',
    coefficient_structure: true,
    duree_exoneration_tfpb_ans: 25,
    prets_defaut: [
      { nature: 'construction', taux_ref: 'LA+0.60', duree_ref: '40', revisabilite: 'DOUBLE' },
      { nature: 'foncier', taux_ref: 'LA+0.60', duree_ref: 'zone_abc:B2|C->50,sinon->60', revisabilite: 'DOUBLE' },
    ],
    v1: true,
  },
  PLUS33: {
    code: 'PLUS33',
    libelle: 'PLUS 33 %',
    cle_bareme_loyer: 'PLUS', // loyer = loyer PLUS x 1,33 (R-LOYER-1 ; arbitrage I-6 : x1,33 partout)
    zonage: '123',
    majoration_loyer: 'majoration_plus_33', // cle dans constantes_reglementaires
    cle_lasm: 'taux_reduit_simulation',
    coefficient_structure: true,
    duree_exoneration_tfpb_ans: 25,
    prets_defaut: [], // finance avec les prets PLUS (affectation PLUS)
    v1: true,
  },
  PLAI: {
    code: 'PLAI',
    libelle: 'PLAI',
    cle_bareme_loyer: 'PLAI',
    zonage: '123',
    cle_lasm: 'taux_reduit_simulation',
    coefficient_structure: true,
    duree_exoneration_tfpb_ans: 25,
    prets_defaut: [
      { nature: 'construction', taux_ref: 'LA-0.20', duree_ref: '40', revisabilite: 'DOUBLE' },
      { nature: 'foncier', taux_ref: 'LA-0.20', duree_ref: 'zone_abc:B2|C->50,sinon->60', revisabilite: 'DOUBLE' },
    ],
    v1: true,
  },
  PLS: {
    code: 'PLS',
    libelle: 'PLS',
    cle_bareme_loyer: 'PLS', // bareme par zone ABC (baremes_2025.json/loyers_max_zone_ABC)
    zonage: 'ABC',
    cle_lasm: 'taux_reduit_simulation',
    coefficient_structure: true,
    duree_exoneration_tfpb_ans: 25,
    prets_defaut: [
      // Taux constate sur l'operation BERGERAC : 3,51 % pour un LA de reference de
      // 2,40 % (ParaGEN!DD20), soit LA + 1,11 %. Confirme independamment par la
      // maquette LEON REWORK (ADMIN!C45 « Spread PLS » = 0,0111), qui donne aussi
      // PLAI -0,20 % et PLUS +0,60 %, conformes a R-AMT-1.
      // Revisabilite SIMPLE (SimPLS!AM19) : le taux suit le Livret A, la
      // progression de l'annuite reste a p.
      { nature: 'construction', taux_ref: 'LA+1.11', duree_ref: '40', revisabilite: 'SIMPLE' },
      { nature: 'foncier', taux_ref: 'LA+1.11', duree_ref: 'zone_abc:B2|C->50,sinon->60', revisabilite: 'SIMPLE' },
    ],
    v1: true,
  },
  // --- Hors V1 : squelettes pour figer l'architecture parametrique ---
  LIBRE: {
    code: 'LIBRE',
    libelle: 'Libre',
    cle_bareme_loyer: 'LIBRE',
    zonage: '123',
    cle_lasm: 'taux_normal',
    coefficient_structure: false, // loyer de marche, pas de CS
    duree_exoneration_tfpb_ans: 0,
    prets_defaut: [],
    v1: false,
  },
  LOC: {
    code: 'LOC',
    libelle: 'LLI (LOC)',
    cle_bareme_loyer: 'PLI',
    zonage: 'ABC',
    cle_lasm: 'taux_reduit_simulation',
    coefficient_structure: false,
    duree_exoneration_tfpb_ans: 20,
    prets_defaut: [
      { nature: 'construction', taux_ref: 'LA+1.40', duree_ref: '35', revisabilite: 'DOUBLE' },
      { nature: 'foncier', taux_ref: 'LA+1.40', duree_ref: '40', revisabilite: 'DOUBLE' },
    ],
    // Active a la demande de Bastien le 06/08/2026 : bareme de loyer, prets par
    // defaut, duree d'exoneration et plafond de financement a 90 % sont en place.
    v1: true,
  },
};

/**
 * @param {CodeProduit} code
 * @returns {DefinitionProduit}
 */
export function produit(code) {
  const p = PRODUITS[code];
  if (!p) throw new Error(`Produit inconnu : ${code}`);
  return p;
}

/**
 * Ordre canonique d'affichage et de restitution : rang reglementaire, du plus
 * social au plus libre. Source unique pour les listes deroulantes, les
 * recapitulatifs par tranche et les tableaux - evite de recoder l'ordre partout.
 * @type {CodeProduit[]}
 */
export const ORDRE_PRODUITS = ['PLAI', 'PLUS', 'PLUS33', 'PLS', 'LOC', 'LIBRE'];

/**
 * Produits tries dans l'ordre canonique.
 * @returns {DefinitionProduit[]}
 */
export function produitsOrdonnes() {
  return ORDRE_PRODUITS.map((c) => PRODUITS[c]).filter(Boolean);
}

/**
 * Resout le taux d'un pret a partir de sa cle de reference.
 * `'LA+0.60'` -> Livret A de reference + 0,60 point. `'fixe'` -> taux a saisir.
 * Les spreads sont confirmes par deux sources independantes : R-AMT-1 du
 * dictionnaire et `ADMIN!C43:C46` de la maquette LEON REWORK.
 * @param {string} taux_ref
 * @param {number} livret_a_reference
 * @returns {number|null} taux en fraction, ou null si le taux doit etre saisi
 */
export function resoudreTaux(taux_ref, livret_a_reference) {
  const m = /^LA([+-])(\d+(?:\.\d+)?)$/.exec(String(taux_ref).trim());
  if (!m) return null;
  if (!Number.isFinite(livret_a_reference)) {
    throw new Error(`Livret A de reference requis pour resoudre le taux ${taux_ref}`);
  }
  const spread = Number(m[2]) / 100;
  return livret_a_reference + (m[1] === '-' ? -spread : spread);
}

/**
 * Resout la duree d'un pret a partir de sa cle de reference.
 * `'40'` -> 40 ans. `'zone_abc:B2|C->50,sinon->60'` -> 50 ans en zone B2 ou C,
 * 60 ans ailleurs (R-AMT-1).
 * @param {string} duree_ref
 * @param {string} [zone_ABC]
 * @returns {number}
 */
export function resoudreDuree(duree_ref, zone_ABC) {
  const brut = String(duree_ref).trim();
  if (/^\d+$/.test(brut)) return Number(brut);

  const m = /^zone_abc:([^-]+)->(\d+),sinon->(\d+)$/.exec(brut);
  if (!m) throw new Error(`Cle de duree de pret non reconnue : ${duree_ref}`);
  const zones = m[1].split('|').map((z) => z.trim().toUpperCase());
  const zone = String(zone_ABC ?? '').trim().toUpperCase();
  if (!zone) {
    throw new Error(`Zone ABC requise pour resoudre la duree de pret « ${duree_ref} »`);
  }
  return zones.includes(zone) ? Number(m[2]) : Number(m[3]);
}

/**
 * Caracteristiques par defaut des prets CDC d'un produit (R-AMT-1), resolues
 * depuis les cles declaratives de `PRODUITS`. C'est ce qui rend le jeu de prets
 * theorique calculable sans saisie.
 * @param {CodeProduit} code
 * @param {Object} contexte
 * @param {string} [contexte.zone_ABC]
 * @param {number} contexte.livret_a_reference
 * @param {number} [contexte.progressivite] progressivite appliquee (AXENTIA : -0,005)
 * @returns {Array<{nature: string, taux: number|null, duree_ans: number, revisabilite: string, progressivite: number}>}
 */
export function pretsDefautResolus(code, { zone_ABC, livret_a_reference, progressivite = 0 }) {
  return produit(code).prets_defaut.map((p) => ({
    nature: p.nature,
    taux: resoudreTaux(p.taux_ref, livret_a_reference),
    duree_ans: resoudreDuree(p.duree_ref, zone_ABC),
    revisabilite: p.revisabilite,
    progressivite,
  }));
}
