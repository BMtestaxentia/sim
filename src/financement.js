// @ts-check
/**
 * R-FIN - Plan de financement et prets CDC theoriques.
 *
 * Sources : `calculs!D327` (controle sur/sous-financement), `calculs!D336`
 * (solde a financer), `calculs!B338` (arrondi du pret aux milliers superieurs),
 * `calculs!B1281:B1287` (prix du foncier par quotites VEFA),
 * baremes_her_2027.json/quotites_foncier_vefa.
 *
 * Unites : montants en euros.
 */
import { arrondiEuro } from './arrondis.js';
import { nouveauClasseur } from './formules/modele.js';

// LES FORMULES DU SOLDE, DU DROIT A PRET FONCIER, DES PRETS CDC THEORIQUES, DES
// FONDS PROPRES ET DU REDRESSEMENT VIVENT DANS `formules/domaines/financement.js`.
// Les fonctions qui suivent les evaluent sur les valeurs qu'on leur donne ;
// celles qui ne s'y referent pas encore restent ecrites ici.

/**
 * R-FIN-3 - Solde a financer par pret CDC :
 * `solde = PR_TTC_module - (subventions + fonds propres + autres prets)`.
 * @param {Object} p
 * @param {number} p.prix_revient_ttc_module_eur
 * @param {number} [p.subventions_eur]
 * @param {number} [p.fonds_propres_eur]
 * @param {number} [p.autres_prets_eur]
 * @returns {number}
 */
export function soldeAFinancer({
  prix_revient_ttc_module_eur,
  subventions_eur = 0,
  fonds_propres_eur = 0,
  autres_prets_eur = 0,
}) {
  return nouveauClasseur({})
    .fixer('total_ttc_module', {}, prix_revient_ttc_module_eur)
    .fixer('subventions_total', {}, subventions_eur)
    .fixer('fonds_propres_total', {}, fonds_propres_eur)
    .fixer('autres_prets', {}, autres_prets_eur)
    .valeur('solde_a_financer');
}

/**
 * R-FIN-8 - Scission PLS / CPLS.
 *
 * « Le pret PLS doit etre compris entre 51 et 55 % du prix de revient et le
 * besoin de financement restant est finance en CPLS » (calculette CDC
 * « production LS », guide d'utilisation). Au-dela du plafond, le complement
 * n'est plus du PLS : c'est un CPLS, pret complementaire distribue par les
 * memes reseaux mais sur ressource libre.
 *
 * Le PLANCHER de 51 %, lui, ne se corrige pas : un PLS trop faible signale que
 * l'operation n'avait pas besoin d'un PLS, pas qu'il faut gonfler l'emprunt. Il
 * est rendu pour que l'appelant le signale.
 *
 * @param {Object} p
 * @param {number} p.montant_pls_eur   montant total appele en PLS
 * @param {number} p.prix_revient_eur  prix de revient de la tranche PLS
 * @param {number} [p.plafond]         part maximale en PLS, defaut 0,55
 * @param {number} [p.plancher]        part minimale attendue, defaut 0,51
 * @returns {{pls_eur: number, cpls_eur: number, part_pls: number|null, sous_plancher: boolean}}
 */
export function scinderPLS({ montant_pls_eur, prix_revient_eur, plafond = 0.55, plancher = 0.51 }) {
  // Formules du domaine « prets » : `pls_eur`, `cpls_montant`, `part_pls`,
  // `pls_sous_plancher`. Le plancher se juge sur le PLS effectivement appele.
  const c = nouveauClasseur({})
    .fixer('total_pls', {}, montant_pls_eur)
    .fixer('pr_pls', {}, prix_revient_eur)
    .fixer('plafond_pls', {}, plafond)
    .fixer('plancher_pls', {}, plancher)
    .fixer('tranche_pls_presente', {}, true);
  return {
    pls_eur: c.valeur('pls_eur'),
    cpls_eur: c.valeur('cpls_montant'),
    part_pls: c.valeur('part_pls'),
    sous_plancher: c.valeur('pls_sous_plancher'),
  };
}

/**
 * R-FIN-9 - Plafond de financement du logement locatif intermediaire.
 *
 * « L'ensemble des prets de financement du LLI (PLI CDC et prets hors CDC) ne
 * peut exceder 90 % du prix de revient du LLI » (calculette CDC, controle AT32).
 * Le solde revient obligatoirement en fonds propres ou en subventions.
 *
 * @param {Object} p
 * @param {number} p.total_prets_eur
 * @param {number} p.prix_revient_eur
 * @param {number} [p.plafond] defaut 0,90
 * @returns {{plafond_eur: number, depassement_eur: number, part: number|null}}
 */
export function plafondPretsLLI({ total_prets_eur, prix_revient_eur, plafond = 0.9 }) {
  // Formules du domaine « prets » : `plafond_prets_lli_eur`,
  // `depassement_prets_lli`, `part_prets_lli`.
  const c = nouveauClasseur({})
    .fixer('total_prets_lli', {}, total_prets_eur)
    .fixer('pr_lli', {}, prix_revient_eur)
    .fixer('plafond_lli', {}, plafond);
  return {
    plafond_eur: c.valeur('plafond_prets_lli_eur'),
    depassement_eur: c.valeur('depassement_prets_lli'),
    part: c.valeur('part_prets_lli'),
  };
}

/**
 * R-FIN-7 - Charge annuelle des fonds propres.
 *
 * REMUNERATION et RECONSTITUTION sont DEUX OPTIONS INDEPENDANTES, et les quatre
 * combinaisons existent. L'annexe OP-1 les porte toutes les quatre dans
 * une seule operation (`plan_financement.fonds_propres`) :
 *
 *   produit | taux  | duree | regime
 *   --------|-------|-------|------------------------------------------------
 *   PLS     | 2,5 % | 30    | remuneres ET reconstitues
 *   CD      | 2,5 % | 0     | remuneres SEULEMENT : interets servis, capital
 *           |       |       | laisse dans l'operation
 *   LIB     | 0     | 30    | reconstitues SEULEMENT : capital rendu, sans
 *           |       |       | remuneration
 *   PLUS    | 0     | 0     | ni l'un ni l'autre : reconstitution sur le seul
 *           |       |       | autofinancement
 *
 * Les trois cas produisant une charge sont les trois formes d'une meme
 * expression, `montant x taux / (1 - (1+taux)^-n)` :
 *   - n infini (pas de reconstitution) : elle tend vers `montant x taux`,
 *     l'interet seul ;
 *   - taux nul (pas de remuneration)   : elle tend vers `montant / n`,
 *     le capital seul.
 * Les ecrire separement evite une division par zero et une limite a l'infini
 * la ou les deux reponses sont evidentes.
 *
 * @param {Object} p
 * @param {number} p.montant_eur
 * @param {number} [p.taux]        taux de remuneration annuel ; 0 = non remuneres
 * @param {number} [p.duree_ans]   duree de reconstitution ; 0 = non reconstitues
 * @returns {number} charge annuelle en euros
 */
export function annuiteFondsPropres({ montant_eur, taux = 0, duree_ans = 0 }) {
  const T = { tranche: '_' };
  return nouveauClasseur({})
    .fixerDimension('tranche', ['_'])
    .fixer('fonds_propres_tranche', T, montant_eur)
    .fixer('taux_remuneration_fp', T, taux)
    .fixer('duree_reconstitution_fp', T, duree_ans)
    .valeur('annuite_fp_tranche', T);
}

/**
 * R-FIN-2 - Part de charge fonciere finançable.
 *
 *   foncier_financable = charge_fonciere x (1 - subventions / prix_de_revient)
 *
 * Methode globale (ParaGEN!A64 = "global") : la charge fonciere est reduite au
 * prorata des subventions deja obtenues sur l'operation, puis repartie au
 * prorata des surfaces utiles.
 *
 * L'assiette est celle de la CALCULETTE CDC (« production LS juin 2026 »,
 * Construction!AT37) : TOUTES les subventions du plan, et non les seules
 * subventions gratuites comme le faisait LEON. Arbitrage metier du
 * 06/08/2026 (Q-30) : c'est le preteur qui fixe la regle de son propre pret.
 * L'ancien nom du parametre, `financements_gratuits_eur`, aurait menti sur ce
 * qu'il contient.
 *
 * @param {Object} p
 * @param {number} p.charge_fonciere_eur
 * @param {number} [p.subventions_eur]   toutes subventions confondues
 * @param {number} [p.prix_revient_operation_eur]
 * @param {number} [p.quote_part_su]  defaut 1 (operation mono-produit)
 * @returns {number}
 */
/**
 * R-FIN-3 bis - Redressement en serie des besoins de financement negatifs.
 *
 * Une tranche peut etre SURFINANCEE : sa subvention flechee et ses fonds propres
 * depassent son prix de revient. Son besoin est alors negatif, et cet excedent
 * finance les AUTRES tranches - il ne s'evapore pas. Le plafonner a zero ferait
 * emprunter aux autres un montant deja couvert, et le plan sortirait
 * surfinance de cet excedent.
 *
 * Transcrit de la calculette CDC « production LS » (onglet Construction,
 * colonnes AI a AO, libelle « Prets construction redresses ») : l'excedent est
 * reparti sur les tranches encore positives au prorata de leur surface utile, et
 * l'operation est repetee, car une repartition peut rendre negative une tranche
 * qui ne l'etait pas. La calculette itere trois fois ; on itere jusqu'a
 * stabilite, avec la meme borne de securite.
 *
 * @param {Record<string, number>} besoins   besoin par tranche, signe conserve
 * @param {Record<string, number>} quotesParts clef de repartition (surface utile)
 * @returns {{besoins: Record<string, number>, excedent_eur: number, tours: number}}
 */
export function redresserBesoins(besoins, quotesParts) {
  const codes = Object.keys(besoins);
  const c = nouveauClasseur({}).fixerDimension('tranche', codes);
  for (const code of codes) {
    c.fixer('besoin_brut', { tranche: code }, besoins[code]);
    c.fixer('quote_part_su', { tranche: code }, quotesParts[code] ?? 0);
  }
  return {
    besoins: Object.fromEntries(codes.map((code) => [code, c.valeur('besoin_redresse', { tranche: code })])),
    excedent_eur: c.valeur('excedent_redresse'),
    tours: c.valeur('redressement_tours'),
  };
}

export function foncierFinancable({
  charge_fonciere_eur,
  subventions_eur = 0,
  prix_revient_operation_eur = 0,
  quote_part_su = 1,
}) {
  return nouveauClasseur({})
    .fixer('charge_fonciere_lasm', {}, charge_fonciere_eur)
    .fixer('subventions_total', {}, subventions_eur)
    .fixer('total_ttc_module', {}, prix_revient_operation_eur)
    .fixer('quote_part_foncier', {}, quote_part_su)
    .valeur('droit_foncier_total');
}

/**
 * Quote-part de terrain d'une VEFA, lue au bareme par zone ABC.
 * @param {string} zone_ABC
 * @param {any} referentiels
 * @param {'terrain_vefa'|'terrain_acq_amelioration'|'valeur_comptable_terrain_vefa'|'ssf_pge_acq_amelioration'} [cle]
 * @returns {number}
 */
export function quotiteFoncier(zone_ABC, referentiels, cle = 'terrain_vefa') {
  const t = referentiels.quotites_foncier_vefa;
  const i = t.zones.indexOf(String(zone_ABC).replace('Abis', 'A_bis').replace(' ', '_'));
  if (i < 0) throw new Error(`Zone ABC inconnue : ${zone_ABC}`);
  return t[cle][i];
}

/**
 * R-FIN-4 - Repartition du solde entre pret foncier et pret batiment.
 *   PRET FONCIER  = MIN(solde, foncier_finançable), plancher 0,
 *                   arrondi au millier superieur si l'option est active ;
 *   PRET BATIMENT = solde - prefinancement - pret foncier.
 * Des montants forces court-circuitent le calcul (saisie manuelle dans LEON).
 * @param {Object} p
 * @param {number} p.solde_eur
 * @param {number} p.foncier_financable_eur
 * @param {number} [p.prefinancement_eur]
 * @param {boolean} [p.arrondir_milliers]
 * @param {number} [p.pret_foncier_force_eur]
 * @param {number} [p.pret_batiment_force_eur]
 */
export function pretsCDCTheoriques({
  solde_eur,
  foncier_financable_eur,
  prefinancement_eur = 0,
  arrondir_milliers = false,
  pret_foncier_force_eur,
  pret_batiment_force_eur,
}) {
  const c = nouveauClasseur({})
    .fixer('solde_a_financer', {}, solde_eur)
    .fixer('droit_foncier_total', {}, foncier_financable_eur)
    .fixer('interets_prefinancement', {}, prefinancement_eur)
    .fixer('arrondir_prets_milliers', {}, arrondir_milliers);
  // Un montant FORCE court-circuite la formule du pret : c'est la saisie
  // manuelle de LEON. Le moteur ne s'en sert pas ; la fonction le permet.
  if (pret_foncier_force_eur !== undefined && pret_foncier_force_eur !== null) {
    c.fixer('cdc_foncier', {}, pret_foncier_force_eur);
  }
  if (pret_batiment_force_eur !== undefined && pret_batiment_force_eur !== null) {
    c.fixer('cdc_batiment', {}, Math.max(0, pret_batiment_force_eur));
  } else if (pret_batiment_force_eur === null) {
    // Un forcage VIDE n'impose rien, mais suspend l'arrondi au millier.
    c.fixer('cdc_batiment', {}, c.valeur('cdc_batiment_exact'));
  }
  return {
    pret_foncier_eur: c.valeur('cdc_pret_foncier'),
    pret_batiment_eur: c.valeur('cdc_pret_batiment'),
    total_cdc_eur: c.valeur('cdc_total'),
  };
}

/**
 * R-FIN-1 et R-FIN-5 - Controle d'equilibre du plan de financement.
 * `Subventions + FP + Prets = PR_TTC_module`. L'ecart est signale, jamais
 * absorbe silencieusement.
 * @param {Object} p
 * @param {number} p.prix_revient_ttc_module_eur
 * @param {number} [p.subventions_eur]
 * @param {number} [p.fonds_propres_eur]
 * @param {number} [p.prets_eur]
 * @param {number} [p.prets_cdc_eur]  sous-ensemble CDC, pour le ratio R-FIN-5
 * @param {number} [p.prix_revient_cdc_eur]  prix de revient des seules tranches financees
 *   sur fonds d'epargne ; defaut : le prix de revient entier (operation homogene)
 * @param {any} [referentiels]
 */
export function controleEquilibre(
  {
    prix_revient_ttc_module_eur,
    subventions_eur = 0,
    fonds_propres_eur = 0,
    prets_eur = 0,
    prets_cdc_eur = 0,
    prix_revient_cdc_eur,
  },
  referentiels,
) {
  const c = nouveauClasseur({ baremes: referentiels })
    .fixer('total_ttc_module', {}, prix_revient_ttc_module_eur)
    .fixer('subventions_total', {}, subventions_eur)
    .fixer('fonds_propres_total', {}, fonds_propres_eur)
    .fixer('total_prets', {}, prets_eur)
    .fixer('total_prets_cdc', {}, prets_cdc_eur)
    .fixer('prix_revient_cdc', {}, prix_revient_cdc_eur);
  // Sans referentiel, pas de minimum a opposer : le ratio ne se mesure pas.
  if (!referentiels) c.fixer('ratio_prets_cdc', {}, null);
  return restituerEquilibre(c);
}

/**
 * R-FIN-1 et R-FIN-5 - Equilibre du plan de financement, tel que le moteur le
 * restitue. `Subventions + FP + Prets = PR_TTC_module` : l'ecart est signale,
 * jamais absorbe silencieusement.
 *
 * Le ratio se mesure sur le PERIMETRE des fonds d'epargne : une tranche libre,
 * financee en banque, n'a rien a faire au denominateur d'un controle CDC.
 * @param {import('./formules/classeur.js').Classeur} c
 */
export function restituerEquilibre(c) {
  const ecart = c.valeur('ecart_plan');
  const ratio = c.valeur('ratio_prets_cdc');
  const alertes = [];
  if (ecart > 0) alertes.push(`Surfinancement de ${ecart} EUR`);
  if (ecart < 0) alertes.push(`Sous-financement de ${-ecart} EUR`);
  if (ratio !== null && ratio !== undefined && c.valeur('ratio_cdc_insuffisant')) {
    alertes.push(
      `Ratio prets CDC / prix de revient de ${(ratio * 100).toFixed(1)} %, ` +
        `en dessous du minimum reglementaire de ${(c.valeur('ratio_prets_cdc_min') * 100).toFixed(0)} %`,
    );
  }
  return {
    ressources_eur: c.valeur('ressources_plan_arrondies'),
    emplois_eur: c.valeur('emplois_plan'),
    ecart_eur: ecart,
    equilibre: c.valeur('plan_equilibre'),
    ratio_prets_cdc: ratio ?? null,
    alertes,
  };
}
