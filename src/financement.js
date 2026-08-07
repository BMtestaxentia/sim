// @ts-check
/**
 * R-FIN — Plan de financement et prets CDC theoriques.
 *
 * Sources : `calculs!D327` (controle sur/sous-financement), `calculs!D336`
 * (solde a financer), `calculs!B338` (arrondi du pret aux milliers superieurs),
 * `calculs!B1281:B1287` (prix du foncier par quotites VEFA),
 * baremes_2025.json/quotites_foncier_vefa.
 *
 * Unites : montants en euros.
 */
import { arrondiEuro, arrondiMillierSup } from './arrondis.js';

/**
 * R-FIN-3 — Solde a financer par pret CDC :
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
  return arrondiEuro(
    prix_revient_ttc_module_eur - (subventions_eur + fonds_propres_eur + autres_prets_eur),
  );
}

/**
 * R-FIN-7 — Annuite de fonds propres REMUNERES.
 *
 * Des fonds propres remuneres se comportent comme un pret que l'operation se
 * fait a elle-meme : elle en verse chaque annee une annuite constante qui couvre
 * la remuneration ET la reconstitution du capital sur la duree convenue. C'est
 * la colonne « ANNUITES DE FP » de la table de transparence de la CDC, et le
 * couple (taux de remuneration, duree de reconstitution) du dictionnaire LEON.
 *
 *   annuite = montant x taux / (1 - (1 + taux)^-duree)
 *
 * A taux nul, la limite est montant / duree : l'operation rend le capital sans
 * le remunerer. Ecrire la formule generale ferait une division par zero la ou la
 * reponse est evidente.
 *
 * Des fonds propres NON remuneres ne produisent aucune annuite : ils se
 * reconstituent sur l'autofinancement, ce que rapporte deja
 * `anneeReconstitutionFondsPropres`.
 *
 * @param {Object} p
 * @param {number} p.montant_eur
 * @param {number} [p.taux]        taux de remuneration annuel, en fraction
 * @param {number} [p.duree_ans]   duree de reconstitution
 * @returns {number} annuite annuelle en euros
 */
export function annuiteFondsPropres({ montant_eur, taux = 0, duree_ans = 0 }) {
  if (!(montant_eur > 0) || !(duree_ans > 0)) return 0;
  if (!taux) return arrondiEuro(montant_eur / duree_ans);
  return arrondiEuro((montant_eur * taux) / (1 - (1 + taux) ** -duree_ans));
}

/**
 * R-FIN-2 — Part de charge fonciere finançable.
 *
 *   foncier_financable = charge_fonciere x (1 - subventions / prix_de_revient)
 *
 * Methode globale (ParaGEN!A64 = "global") : la charge fonciere est reduite au
 * prorata des subventions deja obtenues sur l'operation, puis repartie au
 * prorata des surfaces utiles.
 *
 * L'assiette est celle de la CALCULETTE CDC (« production LS juin 2026 »,
 * Construction!AT37) : TOUTES les subventions du plan, et non les seules
 * subventions gratuites comme le faisait LEON. Arbitrage de Bastien du
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
 * R-FIN-3 bis — Redressement en serie des besoins de financement negatifs.
 *
 * Une tranche peut etre SURFINANCEE : sa subvention flechee et ses fonds propres
 * depassent son prix de revient. Son besoin est alors negatif, et cet excedent
 * finance les AUTRES tranches — il ne s'evapore pas. Le plafonner a zero ferait
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
  const resultat = { ...besoins };
  let excedentTotal = 0;
  let tours = 0;

  for (; tours < 3; tours++) {
    const negatifs = codes.filter((c) => resultat[c] < 0);
    if (!negatifs.length) break;

    const excedent = negatifs.reduce((s, c) => s + resultat[c], 0); // valeur negative
    excedentTotal += -excedent;
    for (const c of negatifs) resultat[c] = 0;

    const positifs = codes.filter((c) => resultat[c] > 0);
    const cle = positifs.reduce((s, c) => s + (quotesParts[c] ?? 0), 0);
    // Plus aucune tranche a servir : l'excedent reste acquis a l'operation et
    // ressortira en surfinancement, ce qui est la verite du plan.
    if (!positifs.length || cle <= 0) break;
    for (const c of positifs) resultat[c] += excedent * ((quotesParts[c] ?? 0) / cle);
  }

  return { besoins: resultat, excedent_eur: arrondiEuro(excedentTotal), tours };
}

export function foncierFinancable({
  charge_fonciere_eur,
  subventions_eur = 0,
  prix_revient_operation_eur = 0,
  quote_part_su = 1,
}) {
  const reduction =
    prix_revient_operation_eur > 0 ? subventions_eur / prix_revient_operation_eur : 0;
  return arrondiEuro(charge_fonciere_eur * (1 - reduction) * quote_part_su);
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
 * R-FIN-4 — Repartition du solde entre pret foncier et pret batiment.
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
  let foncier = Math.max(0, Math.min(solde_eur, foncier_financable_eur));
  if (arrondir_milliers) foncier = arrondiMillierSup(foncier);
  if (pret_foncier_force_eur !== undefined && pret_foncier_force_eur !== null) {
    foncier = pret_foncier_force_eur;
  }

  let batiment = solde_eur - prefinancement_eur - foncier;
  if (pret_batiment_force_eur !== undefined && pret_batiment_force_eur !== null) {
    batiment = pret_batiment_force_eur;
  }
  batiment = Math.max(0, batiment);
  if (arrondir_milliers && pret_batiment_force_eur === undefined) {
    batiment = arrondiMillierSup(batiment);
  }

  return {
    pret_foncier_eur: arrondiEuro(foncier),
    pret_batiment_eur: arrondiEuro(batiment),
    total_cdc_eur: arrondiEuro(foncier + batiment),
  };
}

/**
 * R-FIN-1 et R-FIN-5 — Controle d'equilibre du plan de financement.
 * `Subventions + FP + Prets = PR_TTC_module`. L'ecart est signale, jamais
 * absorbe silencieusement.
 * @param {Object} p
 * @param {number} p.prix_revient_ttc_module_eur
 * @param {number} [p.subventions_eur]
 * @param {number} [p.fonds_propres_eur]
 * @param {number} [p.prets_eur]
 * @param {number} [p.prets_cdc_eur]  sous-ensemble CDC, pour le ratio R-FIN-5
 * @param {any} [referentiels]
 */
export function controleEquilibre(
  {
    prix_revient_ttc_module_eur,
    subventions_eur = 0,
    fonds_propres_eur = 0,
    prets_eur = 0,
    prets_cdc_eur = 0,
  },
  referentiels,
) {
  const ressources = subventions_eur + fonds_propres_eur + prets_eur;
  const ecart = arrondiEuro(ressources - prix_revient_ttc_module_eur);

  const alertes = [];
  if (ecart > 0) alertes.push(`Surfinancement de ${ecart} EUR`);
  if (ecart < 0) alertes.push(`Sous-financement de ${-ecart} EUR`);

  let ratio_cdc = null;
  if (referentiels && prix_revient_ttc_module_eur > 0) {
    ratio_cdc = prets_cdc_eur / prix_revient_ttc_module_eur;
    const mini = referentiels.constantes_reglementaires.controle_ratio_prets_cdc_min.valeur;
    if (prets_cdc_eur > 0 && ratio_cdc < mini) {
      alertes.push(
        `Ratio prets CDC / prix de revient de ${(ratio_cdc * 100).toFixed(1)} %, ` +
          `en dessous du minimum reglementaire de ${(mini * 100).toFixed(0)} %`,
      );
    }
  }

  return {
    ressources_eur: arrondiEuro(ressources),
    emplois_eur: arrondiEuro(prix_revient_ttc_module_eur),
    ecart_eur: ecart,
    equilibre: ecart === 0,
    ratio_prets_cdc: ratio_cdc,
    alertes,
  };
}
