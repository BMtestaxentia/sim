// @ts-check
/**
 * R-TVA — Prix de revient, TVA et livraison a soi-meme (LASM).
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
 * de la simulation), baremes_2025.json/tva.lasm_par_produit.
 *
 * Unites : montants en euros.
 */
import { arrondiEuro } from './arrondis.js';
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
 * R-TVA-1 — Ventilation HT / TVA / TTC d'un poste au taux de saisie.
 * @param {Poste} poste
 * @returns {{ht_eur: number, tva_eur: number, ttc_eur: number}}
 */
export function ventilerPoste(poste) {
  const tva = poste.montant_ht_eur * poste.taux_tva;
  return {
    ht_eur: poste.montant_ht_eur,
    tva_eur: tva,
    ttc_eur: poste.montant_ht_eur + tva,
  };
}

/**
 * Taux de livraison a soi-meme applicable a un produit (R-TVA-2).
 * Attention : pour PLUS/PLAI, LEON utilise le taux reduit de la simulation
 * (10 %) et non la valeur historique 5,5 % du tableau ParaGEN!A78 — l'ecart est
 * documente dans baremes_2025.json.
 * @param {string} code_produit
 * @param {any} referentiels
 * @returns {number}
 */
export function tauxLASM(code_produit, referentiels) {
  const def = produit(/** @type {any} */ (code_produit));
  const tva = referentiels.tva;
  const parProduit = tva.lasm_par_produit;
  // Cle explicite du produit si elle existe, sinon le taux designe par le produit.
  if (parProduit[code_produit] !== undefined) return parProduit[code_produit];
  if (tva[def.cle_lasm] !== undefined) return tva[def.cle_lasm];
  throw new Error(`Taux LASM introuvable pour ${code_produit}`);
}

/**
 * R-TVA-1/2 — Prix de revient d'un produit.
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
export function prixDeRevient({ code_produit, postes, modulation_ttc_eur = 0 }, referentiels) {
  const taux_lasm = tauxLASM(code_produit, referentiels);

  /** @type {Record<string, {ht_eur: number, tva_eur: number, ttc_eur: number, ttc_lasm_eur: number}>} */
  const chapitres = {};
  let ht = 0;
  let tva = 0;
  let ttc = 0;
  let ttcLasm = 0;

  for (const poste of postes) {
    const v = ventilerPoste(poste);
    // R-TVA-2 : un poste hors champ LASM conserve sa TVA de saisie.
    const ttcFinal = poste.hors_lasm ? v.ttc_eur : poste.montant_ht_eur * (1 + taux_lasm);
    const c = (chapitres[poste.chapitre] ??= { ht_eur: 0, tva_eur: 0, ttc_eur: 0, ttc_lasm_eur: 0 });
    c.ht_eur += v.ht_eur;
    c.tva_eur += v.tva_eur;
    c.ttc_eur += v.ttc_eur;
    c.ttc_lasm_eur += ttcFinal;
    ht += v.ht_eur;
    tva += v.tva_eur;
    ttc += v.ttc_eur;
    ttcLasm += ttcFinal;
  }

  for (const c of Object.values(chapitres)) {
    c.ht_eur = arrondiEuro(c.ht_eur);
    c.tva_eur = arrondiEuro(c.tva_eur);
    c.ttc_eur = arrondiEuro(c.ttc_eur);
    c.ttc_lasm_eur = arrondiEuro(c.ttc_lasm_eur);
  }

  return {
    taux_lasm,
    chapitres,
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
 * R-TVA-3 — Cle de repartition d'un montant global entre produits.
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
