// @ts-check
/**
 * Orchestration du moteur de simulation.
 *
 * Point d'entree unique : `calculer(entrees, referentiels) -> resultats`.
 * Fonction PURE : memes entrees, memes sorties, toujours. Aucune I/O, aucun
 * acces reseau, aucun etat global, aucune date systeme (la date de mise en
 * location est une entree). C'est ce qui permet de l'importer tel quel dans
 * Node (tests) comme dans le navigateur (maquette SFO).
 *
 * Enchainement : surfaces -> loyers -> prix de revient -> subventions ->
 * financement -> amortissement -> exploitation -> indicateurs.
 *
 * Chaque etape delegue a son module ; ce fichier ne contient aucune regle de
 * calcul metier, seulement l'assemblage et la propagation des donnees.
 */
import { surfaceUtile, quotesPartsSU, loyerProduit, loyerAnnexesSeparees, controlesLoyer } from './loyers.js';
import { prixDeRevient } from './bilan.js';
import { agregerSubventions, surchargeFonciere } from './subventions.js';
import {
  soldeAFinancer,
  foncierFinancable,
  pretsCDCTheoriques,
  controleEquilibre,
} from './financement.js';
import { tableauAmortissement, anneePremiereEcheance, prefinancement } from './amortissement.js';
import { exonerationTFPB, taxeAmenagement } from './fiscalite.js';
import { compteExploitation, anneeReconstitutionFondsPropres } from './exploitation.js';
import { arrondiEuro } from './arrondis.js';

/** Version du moteur, reportee dans les resultats pour la tracabilite. */
export const VERSION_MOTEUR = '0.3.0';

/**
 * @typedef {Object} Entrees
 * @property {Object} identite            nom, produit, zones, type d'operation
 * @property {Object} dates               annee de mise en location, duree de simulation
 * @property {Array<Object>} lots         programme physique par produit
 * @property {Array<Object>} [postes_bilan]
 * @property {Array<Object>} [subventions]
 * @property {Array<Object>} [prets]      prets saisis (sinon prets CDC theoriques)
 * @property {Object} [exploitation]      parametres d'exploitation
 * @property {Object} [options]
 */

/**
 * Calcule une simulation complete.
 * @param {Entrees} entrees
 * @param {any} referentiels  { baremes, trajectoires }
 * @returns {Object} resultats structures
 */
export function calculer(entrees, referentiels) {
  const baremes = referentiels.baremes ?? referentiels;
  const trajectoires = referentiels.trajectoires ?? {};
  const alertes = [];

  const { identite = {}, dates = {}, lots = [], options = {} } = entrees;
  const zones = { zone_123: identite.zone_123, zone_ABC: identite.zone_ABC };
  const anneeMEL = dates.annee_mise_en_location;
  if (!Number.isInteger(anneeMEL)) {
    throw new Error("dates.annee_mise_en_location est requise (annee civile entiere)");
  }

  // --- 1. Surfaces (R-SURF) ---
  const surfaces = lots.map((lot) => ({
    ...lot,
    su_m2: surfaceUtile(lot, baremes),
  }));
  const suParProduit = {};
  for (const s of surfaces) {
    suParProduit[s.code_produit] = (suParProduit[s.code_produit] ?? 0) + s.su_m2;
  }
  const quotesParts = quotesPartsSU(suParProduit);

  // --- 2. Loyers (R-LOYER) ---
  const loyers = surfaces.map((s) => {
    const l = loyerProduit(
      {
        code_produit: s.code_produit,
        su_m2: s.su_m2,
        nb_logements: s.nb_logements,
        zones,
        marge_locale_eur_m2: s.marge_locale_eur_m2,
        marge_majoration: s.marge_majoration,
        loyer_sortie_force: s.loyer_sortie_force,
        dom: identite.dom,
        foyer: identite.foyer,
      },
      baremes,
    );
    alertes.push(...controlesLoyer(l, s.code_produit));
    return { code_produit: s.code_produit, nb_logements: s.nb_logements, su_m2: s.su_m2, ...l };
  });

  const loyersLogementsAnnuels = arrondiEuro(
    loyers.reduce((s, l) => s + l.loyer_annuel_eur, 0),
  );
  const loyersAnnexesAnnuels = loyerAnnexesSeparees(entrees.annexes_louees ?? []);

  // --- 3. Prix de revient (R-TVA) ---
  const produitPrincipal = identite.produit ?? lots[0]?.code_produit;
  const bilan = prixDeRevient(
    {
      code_produit: produitPrincipal,
      postes: entrees.postes_bilan ?? [],
      modulation_ttc_eur: entrees.modulation_ttc_eur ?? 0,
    },
    baremes,
  );

  // --- 4. Subventions (R-SUB) ---
  const subventions = agregerSubventions(entrees.subventions ?? [], quotesParts);
  const ssf = entrees.surcharge_fonciere
    ? surchargeFonciere(entrees.surcharge_fonciere, baremes)
    : null;
  const subventionsTotal = arrondiEuro(subventions.total_eur + (ssf?.subvention_eur ?? 0));

  // --- 5. Financement (R-FIN) ---
  const fondsPropres = entrees.fonds_propres_eur ?? 0;
  const pretsSaisis = entrees.prets ?? [];
  const autresPretsEur = pretsSaisis
    .filter((p) => p.nature === 'autre')
    .reduce((s, p) => s + p.montant_eur, 0);

  const solde = soldeAFinancer({
    prix_revient_ttc_module_eur: bilan.total_ttc_module_eur,
    subventions_eur: subventionsTotal,
    fonds_propres_eur: fondsPropres,
    autres_prets_eur: autresPretsEur,
  });

  // Prefinancement (R-FIN-6) : seulement si un echeancier de tirages est fourni.
  const prefi = entrees.prefinancement
    ? prefinancement(entrees.prefinancement)
    : null;

  // Prets CDC theoriques, sauf si la saisie impose deja les prets.
  const pretsCDCSaisis = pretsSaisis.filter((p) => p.nature !== 'autre');
  const cdcTheoriques =
    pretsCDCSaisis.length > 0
      ? null
      : pretsCDCTheoriques({
          solde_eur: solde,
          foncier_financable_eur: foncierFinancable({
            charge_fonciere_eur: bilan.chapitres.charge_fonciere?.ttc_lasm_eur ?? 0,
            financements_gratuits_eur: subventions.gratuites_eur,
            prix_revient_operation_eur: bilan.total_ttc_module_eur,
          }),
          prefinancement_eur: prefi?.interets_eur ?? 0,
          arrondir_milliers: options.arrondir_prets_milliers_sup ?? false,
        });

  // --- 6. Amortissement (R-AMT) ---
  const laOrigine = trajectoires.taux_reference_livret_a ?? trajectoires.taux_livret_a_courant;
  const laParAnnee = trajectoires.livret_a_par_annee;

  /** @type {Array<Object>} */
  const pretsACalculer =
    pretsCDCSaisis.length > 0
      ? pretsSaisis
      : [
          { code: 'CDC_FONCIER', montant_eur: cdcTheoriques.pret_foncier_eur, nature: 'foncier' },
          { code: 'CDC_BATIMENT', montant_eur: cdcTheoriques.pret_batiment_eur, nature: 'construction' },
        ].map((p) => ({ ...p, ...(entrees.caracteristiques_prets_defaut ?? {}) }));

  const amortissements = pretsACalculer
    .filter((p) => p.montant_eur > 0)
    .map((p) => ({
      code: p.code ?? p.libelle ?? 'pret',
      libelle: p.libelle ?? p.code,
      montant_eur: p.montant_eur,
      tableau: tableauAmortissement({
        montant_eur: p.montant_eur,
        taux: p.taux,
        progressivite: p.progressivite ?? 0,
        duree_ans: p.duree_ans,
        // R-AMT-3 : chaque pret garde SA date ; a defaut, la regle par defaut.
        annee_premiere_echeance:
          p.annee_premiere_echeance ??
          anneePremiereEcheance(anneeMEL, { demembrement: identite.demembrement }),
        revisabilite: p.revisabilite ?? 'TAUX FIXE',
        differe_ans: p.differe_ans ?? 0,
        differe_type: p.differe_type,
        livret_a_origine: p.livret_a_origine ?? laOrigine,
        livret_a_par_annee: p.livret_a_par_annee ?? laParAnnee,
      }),
    }));

  const totalPrets = arrondiEuro(
    amortissements.reduce((s, a) => s + a.montant_eur, 0) + autresPretsEur * 0,
  );

  const equilibre = controleEquilibre(
    {
      prix_revient_ttc_module_eur: bilan.total_ttc_module_eur,
      subventions_eur: subventionsTotal,
      fonds_propres_eur: fondsPropres,
      prets_eur: totalPrets + autresPretsEur,
      prets_cdc_eur: cdcTheoriques ? cdcTheoriques.total_cdc_eur : totalPrets,
    },
    baremes,
  );
  alertes.push(...equilibre.alertes);

  // --- 7. Fiscalite (R-FISC) ---
  const tfpb = exonerationTFPB(
    {
      annee_mise_en_location: anneeMEL,
      duree_exoneration_ans: options.duree_exoneration_tfpb_ans,
    },
    baremes,
  );
  const ta = entrees.taxe_amenagement
    ? taxeAmenagement(entrees.taxe_amenagement, baremes)
    : null;

  // --- 8. Exploitation (R-EXP) ---
  const exp = entrees.exploitation ?? {};
  const annuitesAplaties = amortissements.flatMap((a) =>
    a.tableau.map((l) => ({ annee: l.annee, annuite_eur: l.annuite_eur })),
  );
  const nbLogements = lots.reduce((s, l) => s + (l.nb_logements ?? 0), 0);
  const shabTotal = lots.reduce((s, l) => s + (l.shab_m2 ?? 0), 0);

  const exploitation = compteExploitation({
    annee_mise_en_location: anneeMEL,
    duree_ans: dates.duree_simulation_ans ?? 50,
    loyers_logements_annuels_eur: loyersLogementsAnnuels,
    loyers_annexes_annuels_eur: loyersAnnexesAnnuels,
    loyers_divers_annuels_eur: exp.loyers_divers_annuels_eur ?? 0,
    frais_gestion_annuels_eur: exp.frais_gestion_annuels_eur ?? 0,
    frais_gestion_pct_loyers: exp.frais_gestion_pct_loyers ?? 0,
    rel_annuel_eur: exp.rel_annuel_eur ?? 0,
    gros_entretien_eur_m2: exp.gros_entretien_eur_m2 ?? 0,
    shab_m2: shabTotal,
    taux_vacance_impayes: exp.taux_vacance_impayes ?? 0,
    taux_produits_financiers: exp.taux_produits_financiers ?? 0,
    nb_logements: nbLogements,
    tfpb_par_logement_eur:
      exp.tfpb_par_logement_eur ?? baremes.constantes_reglementaires.tfpb.montant_par_logement_eur,
    annee_debut_tfpb: exp.annee_debut_tfpb ?? tfpb.annee_debut_tfpb,
    annuites: annuitesAplaties,
    trajectoires: exp.trajectoires ?? trajectoires,
  });

  // --- 9. Indicateurs de synthese ---
  const indicateurs = {
    nb_logements: nbLogements,
    shab_m2: shabTotal,
    su_m2: Object.values(suParProduit).reduce((s, v) => s + v, 0),
    prix_revient_ttc_eur: bilan.total_ttc_module_eur,
    prix_revient_par_logement_eur:
      nbLogements > 0 ? arrondiEuro(bilan.total_ttc_module_eur / nbLogements) : null,
    prix_revient_par_m2_shab_eur:
      shabTotal > 0 ? arrondiEuro(bilan.total_ttc_module_eur / shabTotal) : null,
    loyers_annuels_eur: arrondiEuro(loyersLogementsAnnuels + loyersAnnexesAnnuels),
    // RMO : rendement des loyers de l'annee 1 sur le prix de revient TTC.
    rmo:
      bilan.total_ttc_module_eur > 0
        ? (loyersLogementsAnnuels + loyersAnnexesAnnuels) / bilan.total_ttc_module_eur
        : null,
    taux_fonds_propres:
      bilan.total_ttc_module_eur > 0 ? fondsPropres / bilan.total_ttc_module_eur : null,
    annee_reconstitution_fonds_propres: anneeReconstitutionFondsPropres(
      exploitation.lignes,
      fondsPropres,
    ),
    annee_debut_tfpb: tfpb.annee_debut_tfpb,
  };

  return {
    version_moteur: VERSION_MOTEUR,
    identite,
    surfaces: { par_produit: suParProduit, quotes_parts: quotesParts, detail: surfaces },
    loyers,
    bilan,
    subventions: { ...subventions, surcharge_fonciere: ssf, total_avec_ssf_eur: subventionsTotal },
    financement: {
      solde_a_financer_eur: solde,
      prets_cdc_theoriques: cdcTheoriques,
      prefinancement: prefi,
      equilibre,
    },
    amortissements,
    fiscalite: { tfpb, taxe_amenagement: ta },
    exploitation,
    indicateurs,
    alertes,
  };
}
