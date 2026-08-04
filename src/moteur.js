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
import { normaliserTrajectoires } from './trajectoires.js';
import { calendrierOperation } from './calendrier.js';
import { pretsDefautResolus, ORDRE_PRODUITS } from './produits.js';
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
export const VERSION_MOTEUR = '0.4.0';

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
  // Le referentiel de trajectoires stocke une ligne par annee ; les modules de
  // calcul consomment un dictionnaire par poste. Sans cette normalisation,
  // l'indexation retombe silencieusement a zero (defaut V2).
  const trajectoires = normaliserTrajectoires(referentiels.trajectoires);
  const alertes = [];

  const { identite = {}, dates = {}, lots = [], options = {} } = entrees;
  const zones = { zone_123: identite.zone_123, zone_ABC: identite.zone_ABC };

  // --- 0. Calendrier (R-AMT-3 en amont) ---
  const calendrier = calendrierOperation(dates);
  const anneeMEL = calendrier.annee_mise_en_location;

  // --- 1. Surfaces (R-SURF) ---
  const surfaces = lots.map((lot) => ({
    ...lot,
    su_m2: surfaceUtile(lot, baremes),
  }));

  // Agregation PAR TRANCHE DE FINANCEMENT avant tout calcul de loyer : le
  // coefficient de structure est une fonction de (nb logements, SU) de la
  // tranche entiere (R-SURF-2). Le calculer ligne a ligne donnerait des CS
  // differents selon le decoupage de saisie, donc des loyers faux (defaut V3).
  /** @type {Record<string, {nb_logements: number, su_m2: number, shab_m2: number, lignes: any[]}>} */
  const tranches = {};
  for (const s of surfaces) {
    const t = (tranches[s.code_produit] ??= { nb_logements: 0, su_m2: 0, shab_m2: 0, lignes: [] });
    t.nb_logements += s.nb_logements ?? 0;
    t.su_m2 += s.su_m2 ?? 0;
    t.shab_m2 += s.shab_m2 ?? 0;
    t.lignes.push(s);
  }

  const suParProduit = Object.fromEntries(
    Object.entries(tranches).map(([code, t]) => [code, t.su_m2]),
  );
  const quotesParts = quotesPartsSU(suParProduit);

  /** Codes de produit presents, dans l'ordre canonique. */
  const codesPresents = ORDRE_PRODUITS.filter((c) => tranches[c]).concat(
    Object.keys(tranches).filter((c) => !ORDRE_PRODUITS.includes(/** @type {any} */ (c))),
  );

  // --- 2. Loyers (R-LOYER), une ligne par TRANCHE ---
  const loyers = codesPresents.map((code) => {
    const t = tranches[code];
    // Les surcharges de loyer se saisissent au niveau de la tranche : on prend
    // la premiere valeur renseignee parmi ses lignes.
    const premiere = t.lignes.find((l) => l.marge_locale_eur_m2 !== undefined) ?? t.lignes[0];
    const forcee = t.lignes.find((l) => l.loyer_sortie_force !== undefined && l.loyer_sortie_force !== null);
    const l = loyerProduit(
      {
        code_produit: code,
        su_m2: t.su_m2,
        nb_logements: t.nb_logements,
        zones,
        marge_locale_eur_m2: premiere?.marge_locale_eur_m2,
        marge_majoration: premiere?.marge_majoration,
        loyer_sortie_force: forcee?.loyer_sortie_force,
        dom: identite.dom,
        foyer: identite.foyer,
      },
      baremes,
    );
    alertes.push(...controlesLoyer(l, code));
    return {
      code_produit: code,
      nb_logements: t.nb_logements,
      su_m2: t.su_m2,
      shab_m2: t.shab_m2,
      ...l,
    };
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
  const laOrigine = trajectoires.taux_reference_livret_a;
  const laParAnnee = trajectoires.livret_a_par_annee;

  /**
   * Prets a amortir. En l'absence de prets saisis, on mobilise les prets CDC
   * theoriques, dont les caracteristiques sont resolues depuis `produits.js`
   * (R-AMT-1) et non laissees indefinies — sans quoi l'amortissement leve
   * « Duree de pret invalide » (defaut V4).
   * @type {Array<Object>}
   */
  let pretsACalculer;
  if (pretsCDCSaisis.length > 0) {
    pretsACalculer = pretsSaisis;
  } else {
    const surcharges = entrees.caracteristiques_prets_defaut ?? {};
    let defauts = [];
    try {
      defauts = pretsDefautResolus(produitPrincipal, {
        zone_ABC: identite.zone_ABC,
        livret_a_reference: surcharges.livret_a_origine ?? laOrigine,
        progressivite: surcharges.progressivite ?? 0,
      });
    } catch (e) {
      alertes.push(
        `Prets CDC theoriques non calculables : ${/** @type {Error} */ (e).message}. ` +
          'Saisir les prets manuellement.',
      );
    }
    const parNature = Object.fromEntries(defauts.map((d) => [d.nature, d]));
    pretsACalculer = [
      { code: 'CDC_FONCIER', libelle: 'Pret CDC foncier', montant_eur: cdcTheoriques.pret_foncier_eur, nature: 'foncier' },
      { code: 'CDC_BATIMENT', libelle: 'Pret CDC construction', montant_eur: cdcTheoriques.pret_batiment_eur, nature: 'construction' },
    ].map((p) => ({
      ...p,
      ...(parNature[p.nature] ?? {}),
      livret_a_origine: laOrigine,
      livret_a_par_annee: laParAnnee,
      ...surcharges,
    }));

    // Un pret theorique dont les caracteristiques n'ont pas pu etre resolues ne
    // doit pas faire echouer toute la simulation : on le signale et on l'ecarte.
    const incalculables = pretsACalculer.filter((p) => p.montant_eur > 0 && !(p.duree_ans > 0));
    for (const p of incalculables) {
      alertes.push(
        `${p.libelle} de ${arrondiEuro(p.montant_eur)} EUR non amorti : duree et taux inconnus ` +
          `pour le produit ${produitPrincipal}. Saisir ce pret manuellement.`,
      );
    }
    pretsACalculer = pretsACalculer.filter((p) => p.duree_ans > 0);
  }

  const amortissements = pretsACalculer
    .filter((p) => p.montant_eur > 0)
    .map((p) => ({
      code: p.code ?? p.libelle ?? 'pret',
      libelle: p.libelle ?? p.code,
      montant_eur: p.montant_eur,
      nature: p.nature ?? 'autre',
      taux_saisi: p.taux,
      annee_premiere_echeance:
        p.annee_premiere_echeance ??
        anneePremiereEcheance(anneeMEL, { demembrement: identite.demembrement }),
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

  // Tous les prets amortis, quelle que soit leur nature. `amortissements` porte
  // deja les prets « autre » : les rajouter les compterait deux fois (defaut V1).
  const totalPrets = arrondiEuro(amortissements.reduce((s, a) => s + a.montant_eur, 0));

  // Seuls les prets CDC entrent au ratio reglementaire R-FIN-5 : un pret
  // collecteur ou une avance ne sont pas des prets de la Caisse des Depots.
  const totalPretsCDC = cdcTheoriques
    ? cdcTheoriques.total_cdc_eur
    : arrondiEuro(
        amortissements.filter((a) => a.nature !== 'autre').reduce((s, a) => s + a.montant_eur, 0),
      );

  const equilibre = controleEquilibre(
    {
      prix_revient_ttc_module_eur: bilan.total_ttc_module_eur,
      subventions_eur: subventionsTotal,
      fonds_propres_eur: fondsPropres,
      prets_eur: totalPrets,
      prets_cdc_eur: totalPretsCDC,
    },
    baremes,
  );
  alertes.push(...equilibre.alertes);

  // Un pret dont les echeances depassent l'horizon de simulation voit ses
  // annuites disparaitre des totaux d'exploitation SANS AUCUN SIGNAL : le compte
  // boucle sur la duree de simulation. On le signale explicitement.
  const anneeFinSimulation = anneeMEL + (dates.duree_simulation_ans ?? 50) - 1;
  for (const a of amortissements) {
    const derniere = a.tableau.at(-1)?.annee;
    if (derniere > anneeFinSimulation) {
      const horsHorizon = a.tableau
        .filter((l) => l.annee > anneeFinSimulation)
        .reduce((s, l) => s + l.annuite_eur, 0);
      alertes.push(
        `${a.libelle} court jusqu'en ${derniere}, au-dela de l'horizon de simulation ` +
          `(${anneeFinSimulation}) : ${arrondiEuro(horsHorizon)} EUR d'annuites ne sont pas ` +
          "comptes au compte d'exploitation.",
      );
    }
  }

  // Le prix de revient applique un taux de LASM unique, celui du produit
  // principal : sur une operation a plusieurs tranches, c'est une approximation.
  if (codesPresents.length > 1) {
    alertes.push(
      `Operation a ${codesPresents.length} tranches (${codesPresents.join(', ')}) mais un seul ` +
        `taux de livraison a soi-meme applique, celui du ${produitPrincipal}. ` +
        'Le prix de revient par tranche n est pas encore ventile.',
    );
  }

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
    // Trajectoires par poste, issues du referentiel normalise. Une surcharge
    // explicite dans les entrees reste possible pour tester un scenario.
    trajectoires: exp.trajectoires ?? trajectoires.par_poste,
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
    calendrier,
    profil_trajectoires: trajectoires.profil ?? null,
    surfaces: {
      par_produit: suParProduit,
      quotes_parts: quotesParts,
      tranches: codesPresents,
      detail: surfaces,
    },
    loyers,
    bilan,
    subventions: { ...subventions, surcharge_fonciere: ssf, total_avec_ssf_eur: subventionsTotal },
    financement: {
      solde_a_financer_eur: solde,
      prets_cdc_theoriques: cdcTheoriques,
      prefinancement: prefi,
      total_prets_eur: totalPrets,
      total_prets_cdc_eur: totalPretsCDC,
      equilibre,
    },
    amortissements,
    fiscalite: { tfpb, taxe_amenagement: ta },
    exploitation,
    indicateurs,
    alertes,
  };
}
