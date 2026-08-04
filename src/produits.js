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
    prets_defaut: [
      // Taux constate sur l'operation BERGERAC : 3,51 % pour un LA de reference de
      // 2,40 % (ParaGEN!DD20), soit LA + 1,11 %. Revisabilite SIMPLE (SimPLS!AM19) :
      // le taux suit le Livret A, la progression de l'annuite reste a p.
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
    prets_defaut: [],
    v1: false,
  },
  LOC: {
    code: 'LOC',
    libelle: 'LLI (LOC)',
    cle_bareme_loyer: 'LLI',
    zonage: 'ABC',
    cle_lasm: 'taux_reduit_simulation',
    coefficient_structure: false,
    prets_defaut: [],
    v1: false,
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
