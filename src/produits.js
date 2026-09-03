// @ts-check
/**
 * Definitions PARAMETRIQUES des produits de financement (lecon I-1 de LEON :
 * le moteur y est duplique 14 fois, un onglet par produit, avec des divergences
 * de bugs. Ici le produit est une DONNEE, jamais du code duplique).
 *
 * Perimetre actif : PLUS / PLUS 33 / PLAI / PLS, les trois foyers, le LLI et le
 * LIBRE. La rehabilitation reste declaree en squelette pour figer l'architecture ;
 * elle sera completee a son tour sans reecriture du moteur.
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
 * @property {string} [cle_marge]     cle tarifaire dans baremes.prets_cdc.marges (ex. 'PLUS')
 * @property {string} [duree_ref]     cle de duree (ex. '40', 'zone_abc:B2|C->50,sinon->60')
 * @property {'DOUBLE'|'D.LIMITEE'|'SIMPLE'} [revisabilite]
 * @property {string} [preset]        id d'un modele de `baremes.presets_prets` d'ou tout est lu,
 *                                    pour un pret qui n'est pas indexe sur le Livret A
 * @property {string} [libelle]       nom du pret a l'ecran, quand « Pret CDC » serait faux
 *
 * @typedef {Object} DefinitionProduit
 * @property {CodeProduit} code
 * @property {string} libelle
 * @property {string} cle_bareme_loyer   cle dans referentiels/baremes_her_2027.json (ex. 'PLUS')
 * @property {'123'|'ABC'} zonage        quel zonage indexe le bareme de loyer de ce produit
 * @property {string} [majoration_loyer] cle d'une majoration multiplicative du loyer de base
 * @property {string} cle_lasm           cle du taux LASM (ex. 'taux_reduit_simulation')
 * @property {boolean} coefficient_structure  le loyer passe-t-il par le CS (R-SURF-2) ?
 * @property {number} duree_exoneration_tfpb_ans  R-FISC-1, propriete du PRODUIT (CGI)
 * @property {boolean} [foyer]           R-SURF-2 : le CS prend le facteur foyers (38 et non 20)
 * @property {boolean} [loyer_par_convention] R-LOYER : pas de bareme de zone, le plafond est conventionnel
 * @property {boolean} [loyer_de_marche] R-LOYER : le bareme de zone est une INDICATION de marche
 *                                       et non un plafond reglementaire - le depasser n'est pas une faute
 * @property {boolean} [finance_par_cdc] defaut true. A false, les prets de ce produit ne sont pas
 *                                       des prets sur fonds d'epargne : ils sortent du ratio R-FIN-5
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
      { nature: 'construction', cle_marge: 'PLUS', duree_ref: '40', revisabilite: 'DOUBLE' },
      { nature: 'foncier', cle_marge: 'PLUS', duree_ref: 'zone_abc:B2|C->50,sinon->60', revisabilite: 'DOUBLE' },
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
      { nature: 'construction', cle_marge: 'PLAI', duree_ref: '40', revisabilite: 'DOUBLE' },
      { nature: 'foncier', cle_marge: 'PLAI', duree_ref: 'zone_abc:B2|C->50,sinon->60', revisabilite: 'DOUBLE' },
    ],
    v1: true,
  },
  PLS: {
    code: 'PLS',
    libelle: 'PLS',
    cle_bareme_loyer: 'PLS', // bareme par zone ABC (baremes_her_2027.json/loyers_max_zone_ABC)
    zonage: 'ABC',
    cle_lasm: 'taux_reduit_simulation',
    coefficient_structure: true,
    duree_exoneration_tfpb_ans: 25,
    prets_defaut: [
      // Taux constate sur l'operation OP-3 : 3,51 % pour un LA de reference de
      // 2,40 % (ParaGEN!DD20), soit LA + 1,11 %. Confirme independamment par la
      // maquette LEON REWORK (ADMIN!C45 « Spread PLS » = 0,0111), qui donne aussi
      // PLAI -0,20 % et PLUS +0,60 %, conformes a R-AMT-1.
      //
      // Revisabilite DOUBLE, sur decision du metier (10/08/2026) : les
      // trois produits CDC sont montes en double revisabilite. La matrice
      // OP-3 portait SIMPLE (SimPLS!AM19), ce qui reflete un montage
      // particulier et non la regle - l'ecart est trace dans ECARTS_LEON.
      { nature: 'construction', cle_marge: 'PLS', duree_ref: '40', revisabilite: 'DOUBLE' },
      { nature: 'foncier', cle_marge: 'PLS', duree_ref: 'zone_abc:B2|C->50,sinon->60', revisabilite: 'DOUBLE' },
    ],
    v1: true,
  },
  LIBRE: {
    code: 'LIBRE',
    libelle: 'Libre',
    cle_bareme_loyer: 'LIBRE',
    zonage: '123',
    cle_lasm: 'taux_normal',
    coefficient_structure: false, // loyer de marche, pas de CS
    // Le bareme LIBRE n'est pas un plafond : aucune convention ne s'impose au
    // logement libre. C'est une estimation de loyer de marche par zone, que le
    // montage peut depasser sans faute - d'ou l'absence de controle de plafond.
    loyer_de_marche: true,
    // R-FISC-1. Le logement libre ne releve d'aucune exoneration longue du CGI,
    // mais bien de l'exoneration de DROIT COMMUN de deux ans des constructions
    // nouvelles (CGI art. 1383). LEON pose la meme duree : l'annexe de reference
    // LIBRE porte annee_debut_tfpb = mise en location + 2. La commune peut avoir
    // supprime sa part par deliberation (Q-41) ; la duree se surcharge alors.
    duree_exoneration_tfpb_ans: 2,
    // Le logement libre ne se finance pas sur fonds d'epargne : son pret est un
    // pret bancaire ordinaire, hors ratio R-FIN-5 comme hors droits CDC.
    finance_par_cdc: false,
    // UN seul pret, comme le slot LIB de LEON : une banque prete sur l'operation
    // entiere, sans la distinction foncier / construction propre a la CDC.
    prets_defaut: [{ nature: 'construction', preset: 'BANQUE_LIBRE', libelle: 'Prêt bancaire' }],
    // Active a la demande du metier le 03/09/2026. Loyer de marche, TVA a 20 %,
    // exoneration de TFPB de deux ans, IS du (le libre est hors service d'interet
    // general) et financement bancaire : tout est en place.
    v1: true,
  },
  LOC: {
    code: 'LOC',
    libelle: 'LLI',
    cle_bareme_loyer: 'PLI',
    zonage: 'ABC',
    cle_lasm: 'taux_reduit_simulation',
    coefficient_structure: false,
    duree_exoneration_tfpb_ans: 20,
    prets_defaut: [
      { nature: 'construction', cle_marge: 'PLI', duree_ref: '35', revisabilite: 'DOUBLE' },
      { nature: 'foncier', cle_marge: 'PLI', duree_ref: '40', revisabilite: 'DOUBLE' },
    ],
    // Active a la demande du metier le 06/08/2026 : bareme de loyer, prets par
    // defaut, duree d'exoneration et plafond de financement a 90 % sont en place.
    v1: true,
  },

  // --- Foyers (ParaFPLUS, SimFPLUS_2) ---------------------------------------
  // Un foyer n'est PAS une famille de financement a part : c'est le meme pret
  // PLUS ou PLAI, pose sur un batiment collectif. LEON en fait des codes
  // distincts (FPLUS, FPLS) parce que son moteur est duplique ; ici, deux
  // proprietes suffisent a les decrire, le reste est herite tel quel.
  //   - `foyer` bascule le coefficient de structure sur le facteur 38 (R-SURF-2) ;
  //   - le produit d'exploitation est une redevance, pas un loyer : c'est le
  //     mode 'redevance' du compte, deja en place (Q-27).
  FPLUS: {
    code: 'FPLUS',
    libelle: 'Foyer PLUS',
    cle_bareme_loyer: 'PLUS',
    zonage: '123',
    cle_lasm: 'taux_reduit_simulation',
    coefficient_structure: true,
    foyer: true,
    duree_exoneration_tfpb_ans: 25,
    prets_defaut: [
      { nature: 'construction', cle_marge: 'PLUS', duree_ref: '40', revisabilite: 'DOUBLE' },
      { nature: 'foncier', cle_marge: 'PLUS', duree_ref: 'zone_abc:B2|C->50,sinon->60', revisabilite: 'DOUBLE' },
    ],
    v1: true,
  },
  FPLAI: {
    code: 'FPLAI',
    libelle: 'Foyer PLAI',
    cle_bareme_loyer: 'PLAI',
    zonage: '123',
    cle_lasm: 'taux_reduit_simulation',
    coefficient_structure: true,
    foyer: true,
    duree_exoneration_tfpb_ans: 25,
    prets_defaut: [
      { nature: 'construction', cle_marge: 'PLAI', duree_ref: '40', revisabilite: 'DOUBLE' },
      { nature: 'foncier', cle_marge: 'PLAI', duree_ref: 'zone_abc:B2|C->50,sinon->60', revisabilite: 'DOUBLE' },
    ],
    v1: true,
  },
  FPLS: {
    code: 'FPLS',
    libelle: 'Foyer PLS',
    cle_bareme_loyer: 'PLS',
    zonage: 'ABC',
    cle_lasm: 'taux_reduit_simulation',
    coefficient_structure: true,
    foyer: true,
    duree_exoneration_tfpb_ans: 25,
    prets_defaut: [
      { nature: 'construction', cle_marge: 'PLS', duree_ref: '40', revisabilite: 'SIMPLE' },
      { nature: 'foncier', cle_marge: 'PLS', duree_ref: 'zone_abc:B2|C->50,sinon->60', revisabilite: 'SIMPLE' },
    ],
    v1: true,
  },

  // --- Hors V1 : squelette pour figer l'architecture parametrique -----------
  // --- Rehabilitation (ParaREH, BilREH) -------------------------------------
  // La rehabilitation se distingue sur un point de fond : le loyer ne sort
  // d'aucun bareme de zone. ParaREH!A23 « Loyer maxi convention » est une
  // SAISIE - c'est la convention APL en vigueur, eventuellement majoree de
  // l'impact loyer des travaux (ParaREH!J27). Le moteur ne doit donc pas
  // chercher a le calculer : il le prend tel qu'il lui est donne.
  REHAB: {
    code: 'REHAB',
    libelle: 'Rehabilitation',
    cle_bareme_loyer: 'PLUS', // repli d'ordre de grandeur ; le plafond reel est conventionnel
    zonage: '123',
    loyer_par_convention: true,
    cle_lasm: 'taux_reduit_travaux', // travaux d'amelioration : taux reduit, pas de LASM neuf
    coefficient_structure: true,
    duree_exoneration_tfpb_ans: 0, // le bati existant n'ouvre pas l'exoneration des constructions neuves
    prets_defaut: [
      { nature: 'construction', cle_marge: 'PAM', duree_ref: '25', revisabilite: 'DOUBLE' },
    ],
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

/**
 * Ordre canonique d'affichage et de restitution : rang reglementaire, du plus
 * social au plus libre. Source unique pour les listes deroulantes, les
 * recapitulatifs par tranche et les tableaux - evite de recoder l'ordre partout.
 * @type {CodeProduit[]}
 */
export const ORDRE_PRODUITS = [
  'PLAI',
  'PLUS',
  'PLUS33',
  'PLS',
  'FPLAI',
  'FPLUS',
  'FPLS',
  'REHAB',
  'LOC',
  'LIBRE',
];

/**
 * Produits tries dans l'ordre canonique.
 * @returns {DefinitionProduit[]}
 */
export function produitsOrdonnes() {
  return ORDRE_PRODUITS.map((c) => PRODUITS[c]).filter(Boolean);
}

/**
 * Marge (spread) associee a une cle tarifaire, en fraction.
 *
 * La grille accepte deux ecritures : la forme documentee du referentiel
 * (`{ valeur, libelle, source }`) et le nombre nu, qui est ce que produit une
 * surcharge de simulation. Sans cette tolerance, une marge modifiee a l'ecran
 * arriverait au moteur sous une forme qu'il ne saurait pas lire.
 *
 * @param {string} cle_marge  cle tarifaire ('PLUS', 'PLAI', 'PLS', 'PLI'...)
 * @param {Record<string, any>} marges  grille `baremes.prets_cdc.marges`, surcharges comprises
 * @returns {number} marge en fraction (0,006 pour 0,60 point)
 */
export function marge(cle_marge, marges) {
  const brut = marges?.[cle_marge];
  const v = typeof brut === 'object' && brut !== null ? brut.valeur : brut;
  if (!Number.isFinite(v)) {
    throw new Error(
      `Marge de pret CDC inconnue pour la cle « ${cle_marge} ». ` +
        'Renseigner baremes.prets_cdc.marges.',
    );
  }
  return Number(v);
}

/**
 * Resout le taux d'un pret CDC : Livret A de reference + marge du produit
 * (R-AMT-1). Une cle vide ou `'fixe'` signale un taux a saisir.
 *
 * Les marges ne vivent PAS ici mais dans le referentiel : ce sont des donnees
 * tarifaires, revisees a chaque grille CDC, et les coder en dur reproduirait
 * l'irregularite I-2 de LEON. Trois sources concordent sur les valeurs :
 * `Taux!C11:C15` de la calculette CDC de juin 2026, `ADMIN!C43:C46` de la
 * maquette LEON REWORK, et le taux constate sur l'operation OP-3.
 *
 * @param {string} cle_marge
 * @param {number} livret_a_reference
 * @param {Record<string, any>} marges
 * @returns {number|null} taux en fraction, ou null si le taux doit etre saisi
 */
export function resoudreTaux(cle_marge, livret_a_reference, marges) {
  const cle = String(cle_marge ?? '').trim();
  if (!cle || cle === 'fixe') return null;
  if (!Number.isFinite(livret_a_reference)) {
    throw new Error(`Livret A de reference requis pour resoudre le taux du pret ${cle}`);
  }
  return livret_a_reference + marge(cle, marges);
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
 * Le `spread` est reporte a cote du taux : c'est lui que l'ecran donne a
 * modifier, le taux n'en etant que la somme avec le Livret A.
 *
 * Un pret par defaut qui designe un MODELE (`preset`) y lit tout : il n'est pas
 * indexe sur le Livret A, et lui chercher une marge n'aurait pas de sens. C'est
 * le cas du logement libre, finance par une banque et non sur fonds d'epargne.
 * Passer par les modeles plutot que par un second jeu de constantes garde UNE
 * seule source au taux, celle que l'ecran Parametres donne deja a modifier.
 *
 * @param {CodeProduit} code
 * @param {Object} contexte
 * @param {string} [contexte.zone_ABC]
 * @param {number} contexte.livret_a_reference
 * @param {Record<string, any>} contexte.marges  grille `baremes.prets_cdc.marges`
 * @param {Array<any>} [contexte.presets]  liste `baremes.presets_prets.presets`, surcharges comprises
 * @param {number} [contexte.progressivite] progressivite appliquee (AXENTIA : -0,005)
 * @returns {Array<Record<string, any>>}
 */
export function pretsDefautResolus(
  code,
  { zone_ABC, livret_a_reference, marges, presets = [], progressivite = 0 },
) {
  return produit(code).prets_defaut.map((p) => {
    if (p.preset) {
      const modele = presets.find((x) => x && x.id === p.preset);
      if (!modele) {
        throw new Error(
          `Modele de pret « ${p.preset} » introuvable. Renseigner baremes.presets_prets.presets.`,
        );
      }
      // La NATURE et le LIBELLE viennent du produit, pas du modele : le modele
      // decrit un pret hors fonds d'epargne (nature « autre »), alors que ce
      // pret-ci est bien le pret principal de sa tranche et doit en absorber le
      // besoin. Le reste - taux, duree, profil - est lu tel quel.
      const { id, nature: _n, libelle: _l, groupe: _g, produits: _p, note: _no, ...caracteristiques } = modele;
      return {
        ...caracteristiques,
        nature: p.nature,
        libelle: p.libelle ?? modele.libelle,
        preset: id,
        // Un modele a taux fixe n'a pas de marge : la progressivite d'usage de
        // la CDC ne s'y applique pas davantage, elle vient du modele.
        progressivite: modele.progressivite ?? 0,
      };
    }
    return {
      nature: p.nature,
      taux: resoudreTaux(p.cle_marge, livret_a_reference, marges),
      spread: marge(p.cle_marge, marges),
      cle_marge: p.cle_marge,
      duree_ans: resoudreDuree(p.duree_ref, zone_ABC),
      revisabilite: p.revisabilite,
      progressivite,
      ...(p.libelle ? { libelle: p.libelle } : {}),
    };
  });
}

/**
 * R-FIN-5 - Le produit se finance-t-il sur fonds d'epargne ?
 *
 * Le ratio reglementaire « prets CDC / prix de revient » n'a de sens que sur les
 * tranches qui en relevent : compter le pret bancaire d'une tranche libre parmi
 * les prets CDC, ou son prix de revient au denominateur, ferait echouer le
 * controle sur toute operation mixte sans qu'aucune regle soit enfreinte.
 * @param {string} code
 * @returns {boolean}
 */
export function financeParCDC(code) {
  return PRODUITS[/** @type {CodeProduit} */ (code)]?.finance_par_cdc !== false;
}
