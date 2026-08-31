// @ts-check
/**
 * R-TVA - Prix de revient, TVA et livraison a soi-meme (LASM).
 *
 * Structure LEON (onglets Bil*) : 4 chapitres (charge fonciere, batiment,
 * honoraires, frais divers) x (collectif, individuel) x (HT, TVA, TTC), chaque
 * poste portant son propre taux de TVA de saisie. Une colonne separee recalcule
 * la « TVA finale » au taux de livraison a soi-meme du produit.
 *
 * Ici la structure est une DONNEE : une liste de postes typees, pas 4 blocs de
 * colonnes dupliques. Ajouter un chapitre ou un poste ne touche pas le code.
 *
 * Sources : BilPLS!D:J (saisie HT/taux/TTC par poste), ParaGLOB!J44 (taux reduit
 * de la simulation), baremes_her_2027.json/tva.lasm_par_produit.
 *
 * Unites : montants en euros.
 */
import { arrondiEuro, arrondirEnConservantLaSomme } from './arrondis.js';
import { produit } from './produits.js';

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
 * R-TVA-1 - Ventilation HT / TVA / TTC d'un poste au taux de saisie.
 * @param {Poste} poste
 * @returns {{ht_eur: number, tva_eur: number, ttc_eur: number}}
 */
export function ventilerPoste(poste) {
  const ht = montantHTPoste(poste);
  const tva = ht * (poste.taux_tva ?? 0);
  return {
    ht_eur: ht,
    tva_eur: tva,
    ttc_eur: ht + tva,
  };
}

/**
 * R-TVA-3 - Montant HT d'un poste, quel que soit son mode de saisie.
 *
 * Un poste se saisit de DEUX facons, au choix, ligne par ligne :
 *  - un montant GLOBAL (`montant_ht_eur`), que le moteur ventile au prorata de
 *    surface utile ;
 *  - un montant PAR TRANCHE (`montants_ht_par_produit`), quand la depense n'est
 *    pas proportionnelle aux surfaces - un ascenseur qui ne dessert qu'un
 *    batiment, une subvention de travaux propre a une tranche.
 *
 * Des que la saisie par tranche existe, elle FAIT FOI et le total en decoule.
 * L'inverse ferait cohabiter deux verites pour la meme grandeur.
 *
 * @param {{montant_ht_eur?: number, montants_ht_par_produit?: Record<string, number>}} poste
 * @returns {number}
 */
export function montantHTPoste(poste) {
  const parTranche = poste.montants_ht_par_produit;
  if (!parTranche) return poste.montant_ht_eur ?? 0;
  return Object.values(parTranche).reduce((s, v) => s + (v ?? 0), 0);
}

/**
 * R-TVA-2 - Taux de TVA applicable a un poste POUR UNE TRANCHE donnee.
 * Le taux se surcharge tranche par tranche : une meme ligne de travaux peut
 * relever de 5,5 % en PLAI et de 10 % en PLUS. A defaut, le taux de la ligne.
 * @param {{taux_tva?: number, taux_tva_par_produit?: Record<string, number>}} poste
 * @param {string} code
 * @returns {number}
 */
export function tauxTVAPoste(poste, code, taux_produit) {
  const t = poste.taux_tva_par_produit?.[code];
  if (t !== undefined && t !== null) return t;
  // A defaut de saisie, la tranche prend LE TAUX DE SON PRODUIT, tel qu'il est
  // regle au referentiel. Pas celui de la ligne : le taux social est propre au
  // produit, et une ligne a 5,5 % parce qu'une tranche est en PLAI n'a pas a
  // imposer ce taux a la part PLS de la meme ligne, ou il n'existe pas.
  // Corollaire voulu : changer le taux d'un produit a l'ecran des parametres
  // deplace toutes les lignes de ce produit qui n'ont pas de saisie propre.
  // Un poste HORS CHAMP de la livraison a soi-meme garde son taux de saisie :
  // il est par definition en dehors du regime du produit, lui appliquer le taux
  // de ce produit n'aurait pas de sens. C'est le cas des annexes OP-1, dont
  // les postes portent une TVA nulle et un TTC egal au HT (Q-24).
  if (poste.hors_lasm) return poste.taux_tva ?? 0;
  if (taux_produit !== undefined && taux_produit !== null) return taux_produit;
  return poste.taux_tva ?? 0;
}

/**
 * Taux de livraison a soi-meme applicable a un produit (R-TVA-2).
 * Attention : pour PLUS/PLAI, LEON utilise le taux reduit de la simulation
 * (10 %) et non la valeur historique 5,5 % du tableau ParaGEN!A78 - l'ecart est
 * documente dans baremes_her_2027.json.
 * @param {string} code_produit
 * @param {any} referentiels
 * @returns {number}
 */
export function tauxLASM(code_produit, referentiels, contexte = {}) {
  const def = produit(/** @type {any} */ (code_produit));
  const tva = referentiels.tva;
  const parProduit = tva.lasm_par_produit;
  // Le PLUS en quartier prioritaire ou sous convention de renouvellement urbain
  // releve du taux social de 5,5 % (CGI 278 sexies). Ce n'est pas un autre
  // produit, seulement une condition de localisation : la traiter comme un
  // huitieme produit dupliquerait tout son parametrage pour un seul chiffre.
  if (code_produit === 'PLUS' && contexte.qpv && tva.plus_en_qpv?.taux !== undefined) {
    return tva.plus_en_qpv.taux;
  }
  // Cle explicite du produit si elle existe, sinon le taux designe par le produit.
  if (parProduit[code_produit] !== undefined) return parProduit[code_produit];
  if (tva[def.cle_lasm] !== undefined) return tva[def.cle_lasm];
  throw new Error(`Taux LASM introuvable pour ${code_produit}`);
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
 * R-TVA-1/2 - Prix de revient d'un produit.
 *
 * Deux lectures du meme bilan :
 * - `saisie`      : TTC au taux de TVA de chaque poste (ce que coute l'operation) ;
 * - `lasm`        : TTC recalcule au taux de livraison a soi-meme du produit,
 *                   `TTC_final = HT x (1 + taux_lasm)` (R-TVA-2), qui sert de base
 *                   au plan de financement.
 * @param {Object} p
 * @param {string} p.code_produit
 * @param {Poste[]} p.postes
 * @param {number} [p.modulation_ttc_eur] TTC non fincancable ajoute au PR (R-TVA-4)
 * @param {any} referentiels
 */
export function prixDeRevient({ code_produit, postes, modulation_ttc_eur = 0, qpv = false }, referentiels) {
  const taux_lasm = tauxLASM(code_produit, referentiels, { qpv });

  /** @type {Record<string, {ht_eur: number, tva_eur: number, ttc_eur: number, ttc_lasm_eur: number}>} */
  const chapitres = {};
  /** Detail poste par poste, pour que la restitution n'ait rien a recalculer. */
  const detail = [];
  let ht = 0;
  let tva = 0;
  let ttc = 0;
  let ttcLasm = 0;

  for (const poste of postes) {
    const v = ventilerPoste(poste);
    // R-TVA-2 : un poste hors champ LASM conserve sa TVA de saisie.
    const ttcFinal = poste.hors_lasm ? v.ttc_eur : v.ht_eur * (1 + taux_lasm);
    const c = (chapitres[poste.chapitre] ??= { ht_eur: 0, tva_eur: 0, ttc_eur: 0, ttc_lasm_eur: 0 });
    c.ht_eur += v.ht_eur;
    c.tva_eur += v.tva_eur;
    c.ttc_eur += v.ttc_eur;
    c.ttc_lasm_eur += ttcFinal;
    ht += v.ht_eur;
    tva += v.tva_eur;
    ttc += v.ttc_eur;
    ttcLasm += ttcFinal;
    detail.push({
      // Identifiant stable du poste, s'il en porte un : c'est lui qui permet a
      // une restitution de retrouver sa ligne de saisie, jamais le rang.
      id: poste.id,
      chapitre: poste.chapitre,
      libelle: poste.libelle,
      taux_tva: poste.taux_tva,
      ht_eur: arrondiEuro(v.ht_eur),
      tva_eur: arrondiEuro(v.tva_eur),
      ttc_eur: arrondiEuro(v.ttc_eur),
      ttc_lasm_eur: arrondiEuro(ttcFinal),
    });
  }

  // Les totaux sont arrondis A PARTIR DES VALEURS EXACTES, jamais en sommant des
  // valeurs deja arrondies : sommer des arrondis fait deriver le total (un total
  // de 12 EUR pour un prix de revient de 11 EUR, constate en revue).
  for (const c of Object.values(chapitres)) {
    c.ht_eur = arrondiEuro(c.ht_eur);
    c.tva_eur = arrondiEuro(c.tva_eur);
    c.ttc_eur = arrondiEuro(c.ttc_eur);
    c.ttc_lasm_eur = arrondiEuro(c.ttc_lasm_eur);
  }

  return {
    taux_lasm,
    chapitres,
    postes: detail,
    total_ht_eur: arrondiEuro(ht),
    total_tva_eur: arrondiEuro(tva),
    total_ttc_eur: arrondiEuro(ttc),
    /** Base du plan de financement (R-TVA-2). */
    total_ttc_lasm_eur: arrondiEuro(ttcLasm),
    /** R-TVA-4 : prix de revient module, reference de l'equilibre R-FIN-1. */
    total_ttc_module_eur: arrondiEuro(ttcLasm + modulation_ttc_eur),
    modulation_ttc_eur,
  };
}

/**
 * R-TVA-2/3 - Prix de revient VENTILE par tranche de financement.
 *
 * Methode reprise de la maquette LEON REWORK (`PDR!B3` : « Saisie HT globale,
 * ventilation au prorata SU ») : chaque poste est saisi une fois, globalement,
 * puis reparti entre les tranches au prorata de leur surface utile. Chaque
 * tranche applique ENSUITE son propre taux de livraison a soi-meme, ce qui est
 * tout l'interet de la ventilation : un PLAI et un LIBRE ne portent pas la meme
 * TVA finale sur le meme poste.
 *
 * La cle est unique pour toute l'operation (arbitrage metier du 05/08/2026 :
 * « ventile tout en SU »), conformement au titre de l'onglet source. Une cle par
 * chapitre ou par poste reste possible plus tard sans changer cette signature.
 *
 * Aucun arrondi n'intervient pendant la ventilation : les montants restent
 * exacts jusqu'aux totaux, ou `arrondirEnConservantLaSomme` garantit que la
 * somme des tranches vaut exactement le total de l'operation.
 *
 * @param {Object} p
 * @param {Poste[]} p.postes
 * @param {Record<string, number>} p.su_par_produit  surface utile de chaque tranche
 * @param {number} [p.modulation_ttc_eur]  TTC non finançable, ventile lui aussi
 * @param {any} referentiels
 */
export function prixDeRevientVentile(
  { postes, su_par_produit, modulation_ttc_eur = 0, qpv = false },
  referentiels,
) {
  const codes = Object.keys(su_par_produit);
  const suTotale = Object.values(su_par_produit).reduce((s, v) => s + v, 0);

  // Sans surface, aucune ventilation n'a de sens : on retombe sur le calcul
  // mono-produit plutot que de diviser par zero.
  /** @type {Record<string, number>} */
  const parts = {};
  for (const code of codes) parts[code] = suTotale > 0 ? su_par_produit[code] / suTotale : 0;

  /** @type {Record<string, number>} */
  const tauxLasmParTranche = {};
  for (const code of codes) tauxLasmParTranche[code] = tauxLASM(code, referentiels, { qpv });

  /** Accumulateurs exacts par tranche, arrondis seulement a la fin. */
  const cumul = Object.fromEntries(
    codes.map((c) => [c, { ht: 0, tva: 0, ttc: 0, ttcLasm: 0, modulation: 0 }]),
  );

  /** Cumuls exacts par chapitre, pour que la somme des chapitres vaille le total. */
  const chapitresExacts = {};

  const detail = postes.map((poste) => {
    const v = ventilerPoste(poste);
    const ch = (chapitresExacts[poste.chapitre] ??= {
      ht: 0, tva: 0, ttc: 0, ttcLasm: 0,
      // Croisement chapitre x tranche : c'est lui qui alimente le sous-total
      // affiche sous chaque colonne de tranche.
      parTranche: Object.fromEntries(codes.map((c) => [c, { ht: 0, tva: 0, ttc: 0, ttcLasm: 0 }])),
    });
    // Une ligne saisie tranche par tranche impose sa repartition ; les autres
    // suivent la cle de l'operation (prorata de surface utile).
    const explicite = poste.montants_ht_par_produit;
    const parTranche = {};
    for (const code of codes) {
      const ht = explicite ? (explicite[code] ?? 0) : v.ht_eur * parts[code];
      const taux = tauxTVAPoste(poste, code, tauxLasmParTranche[code]);
      const tva = ht * taux;
      // R-TVA-2 : un poste hors champ LASM conserve la TVA de saisie.
      const ttcLasm = poste.hors_lasm ? ht + tva : ht * (1 + tauxLasmParTranche[code]);
      parTranche[code] = {
        // Part REELLEMENT appliquee, et non la cle de l'operation : sur une
        // ligne ventilee a la main, afficher le prorata SU mentirait.
        part: v.ht_eur > 0 ? ht / v.ht_eur : parts[code],
        explicite: Boolean(explicite),
        taux_tva: taux,
        ht_eur: ht,
        tva_eur: tva,
        ttc_eur: ht + tva,
        ttc_lasm_eur: ttcLasm,
      };
      cumul[code].ht += ht;
      cumul[code].tva += tva;
      cumul[code].ttc += ht + tva;
      cumul[code].ttcLasm += ttcLasm;
      ch.ht += ht;
      ch.tva += tva;
      ch.ttc += ht + tva;
      ch.ttcLasm += ttcLasm;
      const cht = ch.parTranche[code];
      cht.ht += ht;
      cht.tva += tva;
      cht.ttc += ht + tva;
      cht.ttcLasm += ttcLasm;
    }
    // Totaux de LIGNE recomposes depuis les tranches, et non recalcules au taux
    // global : des que les taux different d'une tranche a l'autre, le produit
    // total x taux_global ne vaut plus la somme des TVA reellement dues.
    const sommeTranches = (cle) =>
      Object.values(parTranche).reduce((s, t) => s + t[cle], 0);

    return {
      id: poste.id,
      chapitre: poste.chapitre,
      libelle: poste.libelle,
      taux_tva: poste.taux_tva,
      ventile_a_la_main: Boolean(explicite),
      ht_eur: arrondiEuro(v.ht_eur),
      tva_eur: arrondiEuro(sommeTranches('tva_eur')),
      ttc_eur: arrondiEuro(sommeTranches('ttc_eur')),
      ttc_lasm_eur: arrondiEuro(sommeTranches('ttc_lasm_eur')),
      par_tranche: parTranche,
    };
  });

  for (const code of codes) cumul[code].modulation = modulation_ttc_eur * parts[code];

  // Arrondis finaux : chaque grandeur est repartie en entiers dont la somme vaut
  // exactement le total de l'operation.
  const cle = (nom) => codes.map((c) => cumul[c][nom]);
  const htArrondi = arrondirEnConservantLaSomme(cle('ht'));
  const tvaArrondi = arrondirEnConservantLaSomme(cle('tva'));
  const ttcArrondi = arrondirEnConservantLaSomme(cle('ttc'));
  const lasmArrondi = arrondirEnConservantLaSomme(cle('ttcLasm'));
  const moduleArrondi = arrondirEnConservantLaSomme(
    codes.map((c) => cumul[c].ttcLasm + cumul[c].modulation),
  );

  /** @type {Record<string, any>} */
  const parTranche = {};
  codes.forEach((code, i) => {
    parTranche[code] = {
      part_su: parts[code],
      su_m2: su_par_produit[code],
      taux_lasm: tauxLasmParTranche[code],
      total_ht_eur: htArrondi[i],
      total_tva_eur: tvaArrondi[i],
      total_ttc_eur: ttcArrondi[i],
      total_ttc_lasm_eur: lasmArrondi[i],
      total_ttc_module_eur: moduleArrondi[i],
    };
  });

  // Chapitres arrondis en conservant leur somme, pour la meme raison.
  const nomsChapitres = Object.keys(chapitresExacts);
  const chapHt = arrondirEnConservantLaSomme(nomsChapitres.map((n) => chapitresExacts[n].ht));
  const chapTva = arrondirEnConservantLaSomme(nomsChapitres.map((n) => chapitresExacts[n].tva));
  const chapTtc = arrondirEnConservantLaSomme(nomsChapitres.map((n) => chapitresExacts[n].ttc));
  const chapLasm = arrondirEnConservantLaSomme(nomsChapitres.map((n) => chapitresExacts[n].ttcLasm));
  /** @type {Record<string, any>} */
  const chapitres = {};
  nomsChapitres.forEach((nom, i) => {
    const exact = chapitresExacts[nom];
    // Ventilation du sous-total de chapitre entre tranches. Le total IMPOSE est
    // le sous-total deja arrondi : la ligne doit s'additionner a l'ecran, or ce
    // sous-total a lui-meme ete ajuste pour que la colonne des chapitres somme
    // au prix de revient. L'exactitude est donc garantie LIGNE par ligne ; la
    // colonne d'une tranche peut s'ecarter d'un euro de son total, un arrondi
    // ne pouvant satisfaire les deux sens a la fois.
    const repartir = (cle, total) =>
      arrondirEnConservantLaSomme(codes.map((c) => exact.parTranche[c][cle]), total);
    const htTr = repartir('ht', chapHt[i]);
    const tvaTr = repartir('tva', chapTva[i]);
    const ttcTr = repartir('ttc', chapTtc[i]);
    const lasmTr = repartir('ttcLasm', chapLasm[i]);
    chapitres[nom] = {
      ht_eur: chapHt[i], tva_eur: chapTva[i], ttc_eur: chapTtc[i], ttc_lasm_eur: chapLasm[i],
      par_tranche: Object.fromEntries(
        codes.map((c, j) => [
          c,
          { ht_eur: htTr[j], tva_eur: tvaTr[j], ttc_eur: ttcTr[j], ttc_lasm_eur: lasmTr[j] },
        ]),
      ),
    };
  });

  return {
    cle_ventilation: 'surface_utile',
    parts,
    par_tranche: parTranche,
    chapitres,
    postes: detail,
    total_ht_eur: htArrondi.reduce((s, v) => s + v, 0),
    total_tva_eur: tvaArrondi.reduce((s, v) => s + v, 0),
    total_ttc_eur: ttcArrondi.reduce((s, v) => s + v, 0),
    total_ttc_lasm_eur: lasmArrondi.reduce((s, v) => s + v, 0),
    total_ttc_module_eur: moduleArrondi.reduce((s, v) => s + v, 0),
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
  if (!Number.isFinite(quotite)) {
    throw new Error('Quotite de terrain requise : elle n a pas de valeur par defaut (Q-26)');
  }
  return arrondiEuro(montant_terrain_eur * quotite);
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
  const base = prix_revient_ttc_eur - valeur_comptable_terrain_eur;
  return {
    base_eur: arrondiEuro(base),
    part_du_prix_revient: prix_revient_ttc_eur > 0 ? base / prix_revient_ttc_eur : null,
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
