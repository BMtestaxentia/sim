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
import { pretsDefautResolus, produit, marge, ORDRE_PRODUITS } from './produits.js';
import { fusionner, surchargerTrajectoires, ecartsParametrage } from './parametrage.js';
import {
  prixDeRevient,
  prixDeRevientVentile,
  valeurComptableTerrain,
  baseAmortissementComptable,
} from './bilan.js';
import { agregerSubventions, surchargeFonciere } from './subventions.js';
import {
  soldeAFinancer,
  foncierFinancable,
  quotiteFoncier,
  annuiteFondsPropres,
  scinderPLS,
  plafondPretsLLI,
  pretsCDCTheoriques,
  redresserBesoins,
  controleEquilibre,
} from './financement.js';
import { tableauAmortissement, anneePremiereEcheance, prefinancement } from './amortissement.js';
import { exonerationTFPB, taxeAmenagement } from './fiscalite.js';
import {
  compteExploitation,
  dotationParComposants,
  resoudreChargesExploitation,
  anneeReconstitutionFondsPropres,
  indicateursExploitation,
  jalonsExploitation,
} from './exploitation.js';
import { arrondiEuro, arrondiSurface, arrondirEnConservantLaSomme } from './arrondis.js';

/** Version du moteur, reportee dans les resultats pour la tracabilite. */
export const VERSION_MOTEUR = '0.4.0';

/**
 * @typedef {Object} Entrees
 * @property {Object} identite            nom, zones, type d'operation (PAS de produit)
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
  // R-PARAM - Les referentiels du depot font foi, la simulation peut les
  // surcharger. La fusion a lieu ICI, une fois, et tous les modules travaillent
  // ensuite sur le bareme effectif : un module qui irait rechercher la valeur
  // d'origine ailleurs produirait deux verites pour la meme grandeur.
  const baremesReferentiel = referentiels.baremes ?? referentiels;
  const baremes = fusionner(baremesReferentiel, entrees.parametrage?.baremes);
  // Le referentiel de trajectoires stocke une ligne par annee ; les modules de
  // calcul consomment un dictionnaire par poste. Sans cette normalisation,
  // l'indexation retombe silencieusement a zero (defaut V2).
  const trajectoires = surchargerTrajectoires(
    normaliserTrajectoires(referentiels.trajectoires),
    entrees.parametrage?.trajectoires,
  );
  const alertes = [];

  const { identite = {}, dates = {}, lots = [], options = {} } = entrees;
  const zones = { zone_123: identite.zone_123, zone_ABC: identite.zone_ABC };

  // --- 0. Calendrier (R-AMT-3 en amont) ---
  const calendrier = calendrierOperation(dates);
  const anneeMEL = calendrier.annee_mise_en_location;

  // --- 1. Surfaces (R-SURF) ---
  // La SU de chaque lot est conservee EXACTE pour l'agregation ; l'arrondi a
  // 2 decimales n'intervient qu'a la tranche, seul niveau ou R-SURF-1 le
  // prescrit. Arrondir lot par lot ferait deriver le total de l'operation.
  const surfaces = lots.map((lot) => ({
    ...lot,
    su_m2: arrondiSurface(surfaceUtile(lot, baremes)),
    su_exacte_m2: surfaceUtile({ ...lot, arrondir: false }, baremes),
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
    t.su_m2 += s.su_exacte_m2 ?? s.su_m2 ?? 0;
    t.shab_m2 += s.shab_m2 ?? 0;
    t.lignes.push(s);
  }

  // Arrondi de la SU au niveau de la TRANCHE, une fois les lots sommes.
  for (const t of Object.values(tranches)) t.su_m2 = arrondiSurface(t.su_m2);
  const suParProduit = Object.fromEntries(
    Object.entries(tranches).map(([code, t]) => [code, t.su_m2]),
  );
  const quotesParts = quotesPartsSU(suParProduit);

  /** Codes de produit presents, dans l'ordre canonique. */
  const codesPresents = ORDRE_PRODUITS.filter((c) => tranches[c]).concat(
    Object.keys(tranches).filter((c) => !ORDRE_PRODUITS.includes(/** @type {any} */ (c))),
  );

  // --- 2. Loyers (R-LOYER), une ligne par TRANCHE ---
  // Les parametres de loyer (majoration, marge locale, loyer force) sont des
  // proprietes de la TRANCHE, pas du lot : `entrees.loyers_par_produit` est leur
  // emplacement officiel. Les valeurs portees par un lot restent acceptees en
  // repli (fixtures et anciens appels), premiere valeur renseignee retenue.
  const parametresLoyer = entrees.loyers_par_produit ?? {};

  // R-LOYER-9 - Millesime du bareme de loyers. Les plafonds sont revalorises au
  // 1er janvier : les appliquer tels quels a une mise en location posterieure
  // sous-estime les recettes de toute la simulation.
  //
  // Le moteur revalorise DONC PAR DEFAUT : il applique au plafond de zone le
  // cumul des IRL de la trajectoire entre le millesime et la mise en location.
  // La marge locale n'est pas touchee - c'est une saisie en euros du jour, elle
  // n'a pas de millesime a rattraper.
  //
  // LEON, lui, applique le bareme tel quel. Les fixtures qui le reproduisent
  // posent donc explicitement `revaloriser_loyers_plafonds: false` : l'ecart est
  // ecrit dans la fixture, la ou il se lit, plutot que cache dans un defaut.
  const millesimeBareme = (() => {
    const a = [
      baremes.loyers_max_zone_123?.annee_reference,
      baremes.loyers_max_zone_ABC?.annee_reference,
    ].filter((x) => Number.isFinite(x));
    return a.length ? Math.min(...a) : null;
  })();
  const anneesARattraper = millesimeBareme === null ? 0 : Math.max(0, anneeMEL - millesimeBareme);
  let cumulIRL = 1;
  for (let a = millesimeBareme + 1; a <= anneeMEL && anneesARattraper > 0; a++) {
    cumulIRL *= 1 + (trajectoires.par_poste?.loyers_irl?.[a] ?? 0);
  }
  const revaloriser = options.revaloriser_loyers_plafonds !== false && anneesARattraper > 0;
  const coefficientMillesime = revaloriser ? cumulIRL : 1;

  const loyers = codesPresents.map((code) => {
    const t = tranches[code];
    const params = parametresLoyer[code] ?? {};
    const premiere = t.lignes.find((l) => l.marge_locale_eur_m2 !== undefined) ?? t.lignes[0];
    const forcee = t.lignes.find((l) => l.loyer_sortie_force !== undefined && l.loyer_sortie_force !== null);
    const l = loyerProduit(
      {
        code_produit: code,
        su_m2: t.su_m2,
        nb_logements: t.nb_logements,
        zones,
        marge_locale_eur_m2: params.marge_locale_eur_m2 ?? premiere?.marge_locale_eur_m2,
        marge_majoration: params.marge_majoration ?? premiere?.marge_majoration,
        loyer_sortie_force: params.loyer_sortie_force ?? forcee?.loyer_sortie_force,
        loyer_plafond_convention_eur_m2:
          params.loyer_plafond_convention_eur_m2 ?? premiere?.loyer_plafond_convention_eur_m2,
        // Le foyer se declare au niveau du PRODUIT (FPLUS, FPLAI, FPLS) ou de
        // l'operation entiere : une operation mixte peut porter une tranche de
        // foyer a cote de tranches d'habitat ordinaire, chacune avec son propre
        // coefficient de structure (R-SURF-2).
        foyer: produit(code).foyer ?? identite.foyer,
        coefficient_millesime: coefficientMillesime,
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

  // Suite de R-LOYER-9 : dire ce que le millesime change, dans les deux sens.
  if (anneesARattraper > 0 && loyers.length) {
    const ecartPct = ((cumulIRL - 1) * 100).toFixed(1);
    const total = loyers.reduce((s, l) => s + l.loyer_annuel_eur, 0);
    alertes.push(
      revaloriser
        ? `Loyers plafonds revalorises du millesime ${millesimeBareme} a la mise en location ` +
            `${anneeMEL}, soit +${ecartPct} % aux IRL de la trajectoire. Ecart assume avec LEON, ` +
            "qui applique le bareme tel quel (option a l'ecran Parametres)."
        : `Bareme de loyers ${millesimeBareme} applique a une mise en location ${anneeMEL}, ` +
            `soit ${anneesARattraper} an${anneesARattraper > 1 ? 's' : ''} de revalorisation non ` +
            `pris en compte. Aux trajectoires du profil, les plafonds vaudraient ${ecartPct} % de ` +
            `plus, soit ${arrondiEuro(total * (cumulIRL - 1))} EUR de loyers annuels. Activer la ` +
            "revalorisation a l'ecran Parametres, saisir le bareme du millesime attendu, ou " +
            "assumer l'ecart.",
    );
  }

  const loyersLogementsAnnuels = arrondiEuro(
    loyers.reduce((s, l) => s + l.loyer_annuel_eur, 0),
  );
  const loyersAnnexesAnnuels = loyerAnnexesSeparees(entrees.annexes_louees ?? []);

  // La saisie lot par lot est le mode normal : plusieurs lignes d'un meme
  // produit forment une tranche, sans avertissement. On ne signale que le cas
  // reellement dangereux : des parametres de loyer DIVERGENTS portes par les
  // lots d'une meme tranche, dont seul le premier serait retenu.
  for (const [code, t] of Object.entries(tranches)) {
    for (const cle of ['marge_locale_eur_m2', 'marge_majoration', 'loyer_sortie_force']) {
      const valeurs = new Set(
        t.lignes.map((l) => l[cle]).filter((x) => x !== undefined && x !== null),
      );
      if (valeurs.size > 1) {
        alertes.push(
          `Tranche ${code} : plusieurs valeurs de ${cle} portees par les lots ` +
            `(${[...valeurs].join(', ')}), seule la premiere est retenue. ` +
            'Ce parametre se definit par tranche (entrees.loyers_par_produit).',
        );
      }
    }
  }

  // --- 3. Prix de revient (R-TVA) ---
  // Le bilan reste calcule globalement (chapitres, detail par poste) ET ventile
  // par tranche au prorata de surface utile, chaque tranche portant son propre
  // taux de livraison a soi-meme.
  //
  // IL N'Y A PAS DE PRODUIT PRINCIPAL. Chaque financement coexiste dans la meme
  // simulation avec ses regles propres : son taux de livraison a soi-meme, son
  // zonage (1/2/3 ou A/B/C, propriete du produit) et son jeu de prets CDC par
  // defaut. Le seul repli est l'operation MONO-tranche, ou l'unique produit
  // present tient lieu de reference pour ce que la saisie n'a pas affecte.
  const trancheUnique = codesPresents.length === 1 ? codesPresents[0] : null;
  const postesBilan = entrees.postes_bilan ?? [];
  const modulation = entrees.modulation_ttc_eur ?? 0;

  // Version globale : un seul taux de LASM, donc juste seulement en mono-tranche.
  // Elle sert de socle (chapitres, detail par poste) et la ventilation par
  // tranche la remplace des qu'il y a un programme.
  const bilan = prixDeRevient(
    {
      code_produit: trancheUnique ?? codesPresents[0],
      postes: postesBilan,
      modulation_ttc_eur: modulation,
      // R-TVA-2 : le PLUS en quartier prioritaire releve du taux social.
      qpv: identite.qpv === true,
    },
    baremes,
  );

  if (codesPresents.length) {
    const ventilation = prixDeRevientVentile(
      {
        postes: postesBilan,
        su_par_produit: suParProduit,
        modulation_ttc_eur: modulation,
        qpv: identite.qpv === true,
      },
      baremes,
    );
    // La ventilation fait FOI des qu'elle existe : elle applique a chaque tranche
    // son propre taux de livraison a soi-meme, la version globale n'en applique
    // qu'un seul. Les chapitres viennent d'elle aussi, faute de quoi leur somme
    // ne vaudrait plus le total en operation multi-tranches.
    bilan.ventilation = ventilation;
    bilan.chapitres = ventilation.chapitres;
    bilan.par_tranche = ventilation.par_tranche;
    bilan.total_ht_eur = ventilation.total_ht_eur;
    bilan.total_tva_eur = ventilation.total_tva_eur;
    bilan.total_ttc_eur = ventilation.total_ttc_eur;
    bilan.total_ttc_lasm_eur = ventilation.total_ttc_lasm_eur;
    bilan.total_ttc_module_eur = ventilation.total_ttc_module_eur;
    bilan.taux_lasm_par_tranche = Object.fromEntries(
      codesPresents.map((c) => [c, ventilation.par_tranche[c].taux_lasm]),
    );
  }

  // --- 4. Subventions (R-SUB) ---
  const subventions = agregerSubventions(entrees.subventions ?? [], quotesParts);
  const ssf = entrees.surcharge_fonciere
    ? surchargeFonciere(entrees.surcharge_fonciere, baremes)
    : null;
  const subventionsTotal = arrondiEuro(subventions.total_eur + (ssf?.subvention_eur ?? 0));

  // --- 5. Financement (R-FIN) ---
  // Les fonds propres se saisissent par tranche (onglets Tranches de l'UI). Le
  // scalaire global reste accepte pour les appels anciens et les fixtures.
  // R-FIN-7 - Apport AUTOMATIQUE. Un apport non saisi n'est pas un apport nul :
  // c'est une part du prix de revient de la tranche, 5 % en regle generale et
  // 2 % en redevance transparente ou il prend la forme d'une avance de
  // tresorerie. Le moteur le resout lui-meme, comme il resout le montant d'un
  // pret CDC laisse en automatique - sinon l'ecran devrait pre-remplir une
  // valeur, et une valeur pre-remplie devient vite une valeur figee.
  const cfgApport = baremes.fonds_propres?.apport ?? {};
  const expEntree = entrees.exploitation ?? {};
  const tauxApport =
    (expEntree.mode === 'redevance' &&
    (expEntree.mode_redevance ?? 'forfaitaire') === 'transparence'
      ? cfgApport.taux_redevance_transparence
      : cfgApport.taux_defaut) ?? 0;
  /** Apport automatique d'une tranche : la part du referentiel sur son PR TTC. */
  const apportAutoDe = (c) => arrondiEuro((bilan.par_tranche?.[c]?.total_ttc_eur ?? 0) * tauxApport);
  const apportSaisi = (c) => {
    const v = entrees.fonds_propres_par_produit?.[c];
    return v === undefined || v === null || v === '' ? null : (Number(v) || 0);
  };
  /** Apport resolu d'une tranche : la saisie si elle existe, sinon la part. */
  const apportDe = (c) => apportSaisi(c) ?? apportAutoDe(c);

  const fpParProduit = entrees.fonds_propres_par_produit ?? null;
  // Union des tranches PRESENTES et des tranches SAISIES : l'apport automatique
  // ne vaut que pour les premieres, mais un montant saisi compte la ou il est,
  // meme si le produit a quitte le programme entre-temps. Restreindre la somme
  // aux tranches presentes ferait disparaitre cet apport sans le dire.
  const clesFP = [...new Set([...codesPresents, ...Object.keys(fpParProduit ?? {})])];
  const fondsPropres = fpParProduit
    ? clesFP.reduce((s, c) => s + apportDe(c), 0)
    : (entrees.fonds_propres_eur ?? 0);
  // R-FIN-7 - Fonds propres REMUNERES : ceux dont la tranche porte un taux de
  // remuneration et une duree de reconstitution produisent une annuite, comme
  // un pret que l'operation se fait a elle-meme. Les autres se reconstituent
  // sur l'autofinancement, sans charge annuelle.
  const paramFP = entrees.remuneration_fonds_propres ?? {};
  /** @type {Record<string, any>} */
  const fondsPropresParTranche = {};
  let annuiteFPTotale = 0;
  /** Charge de fonds propres annee par annee : chaque tranche a SA duree. */
  /** @type {Array<{annee: number, montant_eur: number}>} */
  const annuitesFP = [];
  const horizon = dates.duree_simulation_ans ?? 50;
  for (const c of codesPresents) {
    const montant = fpParProduit
      ? apportDe(c)
      : (quotesParts[c] ?? 0) * (entrees.fonds_propres_eur ?? 0);
    const p = paramFP[c] ?? {};
    // Deux options INDEPENDANTES : un taux sans duree sert des interets sans
    // rendre le capital, une duree sans taux rend le capital sans le remunerer.
    const taux = p.remuneres === true ? (Number(p.taux) || 0) : 0;
    const duree = p.reconstitues === true ? (Number(p.duree_reconstitution_ans) || 0) : 0;
    const annuite = annuiteFondsPropres({ montant_eur: montant, taux, duree_ans: duree });
    annuiteFPTotale += annuite;
    // Reconstitues, la charge s'arrete au terme : le capital est rendu. Non
    // reconstitues, elle court tant que l'operation existe, puisque le capital
    // reste dedans. C'est pour ce cas mixte que la serie remplace un scalaire.
    if (annuite > 0) {
      const derniere = duree > 0 ? Math.min(duree, horizon) : horizon;
      for (let k = 0; k < derniere; k++) {
        annuitesFP.push({ annee: anneeMEL + k, montant_eur: annuite });
      }
    }
    fondsPropresParTranche[c] = {
      montant_eur: arrondiEuro(montant),
      // De quoi permettre a l'ecran de dire d'ou vient le montant : calcule a la
      // part du referentiel, ou saisi. Sans cette distinction il ne pourrait
      // qu'afficher un nombre, sans jamais dire s'il est subi ou choisi.
      montant_auto: fpParProduit ? apportSaisi(c) === null : false,
      montant_auto_eur: fpParProduit ? apportAutoDe(c) : null,
      taux_apport: fpParProduit ? tauxApport : null,
      remuneres: taux > 0,
      reconstitues: duree > 0,
      taux_remuneration: taux,
      duree_reconstitution_ans: duree,
      annuite_eur: annuite,
    };
  }
  annuiteFPTotale = arrondiEuro(annuiteFPTotale);

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
            subventions_eur: subventionsTotal,
            prix_revient_operation_eur: bilan.total_ttc_module_eur,
          }),
          prefinancement_eur: prefi?.interets_eur ?? 0,
          arrondir_milliers: options.arrondir_prets_milliers_sup ?? false,
        });

  // --- 6. Amortissement (R-AMT) ---
  const laOrigine = trajectoires.taux_reference_livret_a;
  const laParAnnee = trajectoires.livret_a_par_annee;

  // R-AMT-1 - Grille tarifaire des prets CDC, deja surchargee par la fusion des
  // referentiels : le taux d'un pret vaut Livret A + marge, et seule la marge
  // est propre au produit.
  const margesPrets = baremes.prets_cdc?.marges ?? {};

  /**
   * Prets a amortir. En l'absence de prets saisis, on mobilise les prets CDC
   * theoriques, dont les caracteristiques sont resolues depuis `produits.js`
   * (R-AMT-1) et non laissees indefinies - sans quoi l'amortissement leve
   * « Duree de pret invalide » (defaut V4).
   * @type {Array<Object>}
   */
  let pretsACalculer;
  /**
   * Subventions et fonds propres revenant a chaque tranche, une fois ventilees.
   * Rempli par le calcul des besoins, relu par la restitution par tranche.
   * @type {Record<string, {subventions_eur: number, fonds_propres_eur: number}>}
   */
  const ressourcesParTranche = {};
  /**
   * Subventions ligne par ligne, chacune ventilee sur les tranches. Une seule
   * source pour le besoin de financement et pour la restitution.
   * @type {Array<{libelle: string, montant_eur: number, affectation: string|null, par_tranche: Record<string, number>}>}
   */
  const detailSubventions = [];
  {
    const surcharges = entrees.caracteristiques_prets_defaut ?? {};
    const codesFinances = codesPresents.length ? codesPresents : [];

    // R-FIN-3 - Chaque tranche porte par defaut un pret CDC foncier et un pret
    // CDC construction dont le MONTANT S'AJUSTE a son besoin de financement.
    // Rien a saisir tant que l'equilibre convient : modifier les subventions ou
    // les fonds propres d'une tranche suffit a faire bouger ses prets.
    //
    // Un pret dont le montant est saisi FIGE ce montant et sort du calcul
    // automatique : il vient alors en deduction du besoin, comme une ressource
    // deja acquise. C'est la seule facon d'avoir les deux a l'ecran sans qu'ils
    // se contredisent.
    const auto = (p) => p.montant_auto === true || p.montant_eur === null || p.montant_eur === undefined;

    let prets = [...pretsSaisis];
    if (!prets.some((p) => p.nature === 'foncier' || p.nature === 'construction')) {
      const suffixe = codesFinances.length > 1;
      prets = prets.concat(
        codesFinances.flatMap((c) => [
          { code: `CDC_FONCIER_${c}`, libelle: `Prêt CDC foncier${suffixe ? ` ${c}` : ''}`, nature: 'foncier', produit: c, montant_auto: true },
          { code: `CDC_BATIMENT_${c}`, libelle: `Prêt CDC construction${suffixe ? ` ${c}` : ''}`, nature: 'construction', produit: c, montant_auto: true },
        ]),
      );
    }

    // Besoin de financement de chaque tranche : ce que son prix de revient ne
    // couvre pas encore. Faute de ventilation (operation sans programme), on
    // retombe sur le solde global.
    // Une subvention NON AFFECTEE profite a toute l'operation : elle se ventile
    // au prorata de surface utile, comme le prix de revient. La rattacher a
    // aucune tranche la ferait disparaitre du besoin, et les prets couvriraient
    // un montant deja finance.
    // Le detail est etabli UNE fois et sert deux fois : a chiffrer le besoin de
    // chaque tranche, et a le restituer ligne par ligne. Deux parcours de la
    // meme liste finiraient par ventiler differemment.
    /** @type {Array<{libelle: string, montant_eur: number, affectation: string|null, par_tranche: Record<string, number>}>} */
    const lignesSub = [];
    const ventiler = (libelle, montant, affectation) => {
      const cible = affectation && codesFinances.includes(affectation) ? affectation : null;
      /** @type {Record<string, number>} */
      const parTranche = {};
      for (const c of codesFinances) {
        parTranche[c] = cible ? (c === cible ? montant : 0) : (quotesParts[c] ?? 0) * montant;
      }
      lignesSub.push({ libelle, montant_eur: montant, affectation: cible, par_tranche: parTranche });
    };
    for (const s of entrees.subventions ?? []) {
      const m = Number(s.montant_eur) || 0;
      if (m) ventiler(s.libelle ?? 'Subvention', m, s.affectation);
    }
    if (ssf?.subvention_eur) ventiler('Surcharge foncière', ssf.subvention_eur, null);
    detailSubventions.push(...lignesSub);

    /** @type {Record<string, number>} */
    const besoinBrut = {};
    for (const c of codesFinances) {
      const pr = bilan.par_tranche?.[c]?.total_ttc_module_eur ?? 0;
      const sub = lignesSub.reduce((s, l) => s + (l.par_tranche[c] ?? 0), 0);
      // `apportDe` et non la saisie brute : un apport laisse au calcul vaut sa
      // part du prix de revient, pas zero. Lire la saisie ici faisait croire la
      // tranche sans fonds propres - la part affichee tombait a 0,0 % et les
      // prets CDC couvraient un besoin qu'ils n'avaient pas a couvrir.
      const fp = fpParProduit ? apportDe(c) : (quotesParts[c] ?? 0) * fondsPropres;
      // Memorise pour la restitution par tranche : la ventilation des ressources
      // est une regle du moteur (une subvention non affectee profite a tous, au
      // prorata de surface utile), pas une commodite d'affichage. La refaire a
      // l'ecran serait la deuxieme occasion de s'en ecarter.
      ressourcesParTranche[c] = { subventions_eur: arrondiEuro(sub), fonds_propres_eur: arrondiEuro(fp) };
      const fixes = prets
        .filter((p) => !auto(p) && (p.produit ?? trancheUnique) === c)
        .reduce((s, p) => s + (Number(p.montant_eur) || 0), 0);
      // Le signe est CONSERVE : un besoin negatif signale une tranche
      // surfinancee, dont l'excedent va financer les autres.
      besoinBrut[c] = pr - sub - fp - fixes;
    }
    const redresse = redresserBesoins(besoinBrut, quotesParts);
    const besoin = redresse.besoins;
    if (redresse.excedent_eur > 0) {
      const surfinancees = codesFinances.filter((c) => besoinBrut[c] < 0);
      alertes.push(
        `Tranche${surfinancees.length > 1 ? 's' : ''} ${surfinancees.join(', ')} surfinancee${surfinancees.length > 1 ? 's' : ''} ` +
          `de ${redresse.excedent_eur} EUR : cet excedent reduit d'autant les prets des autres tranches ` +
          '(redressement en serie, calculette CDC).',
      );
    }

    // Repartition foncier / construction : le foncier est plafonne a la part
    // FINANCABLE de la charge fonciere de la tranche (R-FIN-2), le reste va a la
    // construction. Sans ce plafond, un terrain cher absorberait tout le pret
    // long et fausserait la duree moyenne de la dette.
    //
    // Le droit a pret foncier se calcule GLOBALEMENT puis se repartit au prorata
    // de surface utile, et non tranche par tranche : c'est la marche de la
    // calculette CDC (`Construction!AT37` pour le total, `M49` pour la
    // repartition). La difference n'est pas cosmetique - une subvention flechee
    // sur une seule tranche reduit le droit a pret foncier de TOUTE l'operation,
    // pas seulement celui de la tranche qui la recoit.
    const droitFoncierTotal = foncierFinancable({
      charge_fonciere_eur: bilan.chapitres.charge_fonciere?.ttc_lasm_eur ?? 0,
      subventions_eur: subventionsTotal,
      prix_revient_operation_eur: bilan.total_ttc_module_eur,
    });
    /** @type {Record<string, number>} */
    const plafondFoncier = {};
    for (const c of codesFinances) {
      plafondFoncier[c] = droitFoncierTotal * (quotesParts[c] ?? 0);
    }

    pretsACalculer = [];
    /** Caracteristiques par defaut d'une tranche, resolues une seule fois. */
    const defautsTranche = {};
    const defautsDe = (code) => {
      if (defautsTranche[code]) return defautsTranche[code];
      try {
        defautsTranche[code] = Object.fromEntries(
          pretsDefautResolus(code, {
            zone_ABC: identite.zone_ABC,
            livret_a_reference: surcharges.livret_a_origine ?? laOrigine,
            marges: margesPrets,
            // La progressivite des echeances est une regle de MONTAGE, pas une
            // propriete du produit : elle vient du referentiel, ou une surcharge
            // de simulation peut la remplacer.
            progressivite:
              surcharges.progressivite ?? baremes.prets_cdc?.defauts?.progressivite ?? 0,
          }).map((d) => [d.nature, d]),
        );
      } catch (e) {
        alertes.push(
          `Prets CDC par defaut de la tranche ${code} non calculables : ` +
            `${/** @type {Error} */ (e).message}. Saisir leur taux et leur duree.`,
        );
        defautsTranche[code] = {};
      }
      return defautsTranche[code];
    };

    // Montants automatiques resolus PAR TRANCHE et arrondis ENSEMBLE : le
    // foncier se sert le premier dans la limite de son plafond, la construction
    // prend le reste. Arrondir les deux separement laissait fuir un euro, le
    // reste etant calcule sur un foncier non arrondi.
    /** @type {Record<string, Record<string, number>>} */
    const montantsAuto = {};
    for (const c of codesFinances) {
      const aFoncierAuto = prets.some(
        (x) => auto(x) && x.nature === 'foncier' && (x.produit ?? trancheUnique) === c,
      );
      const foncierExact = aFoncierAuto ? Math.min(besoin[c] ?? 0, plafondFoncier[c] ?? 0) : 0;
      const constructionExact = Math.max(0, (besoin[c] ?? 0) - foncierExact);
      const [f, b] = arrondirEnConservantLaSomme(
        [foncierExact, constructionExact],
        arrondiEuro(foncierExact + constructionExact),
      );
      montantsAuto[c] = { foncier: f, construction: b };
    }

    for (const p of prets) {
      const code = p.produit ?? trancheUnique;
      let montant = p.montant_eur;
      if (auto(p) && code) {
        montant = montantsAuto[code]?.[p.nature] ?? 0;
      }
      // Les valeurs du pret ne sont reprises que si elles sont RENSEIGNEES :
      // etaler `p` tel quel ecraserait un taux par defaut avec un `undefined`,
      // et le pret deviendrait inamortissable sans qu'on comprenne pourquoi.
      const renseignees = Object.fromEntries(
        Object.entries(p).filter(([, v]) => v !== undefined && v !== null),
      );
      const resolu = {
        ...(p.nature ? (defautsDe(code)?.[p.nature] ?? {}) : {}),
        ...renseignees,
        montant_eur: montant,
        produit: code,
        montant_calcule: auto(p),
        livret_a_origine: p.livret_a_origine ?? laOrigine,
        livret_a_par_annee: p.livret_a_par_annee ?? laParAnnee,
      };
      // Un pret CDC est TOUJOURS indexe sur le Livret A : ce qui se saisit est
      // sa MARGE, pas son taux. Le taux s'en deduit et se recalcule donc ici,
      // sans quoi une marge modifiee resterait sans effet, le taux par defaut du
      // produit ayant deja ete pose par `defautsDe`.
      // Un taux saisi en clair reste prioritaire : c'est le seul recours pour un
      // pret hors fonds d'epargne, dont le taux n'est pas adosse au Livret A.
      if (renseignees.taux === undefined && Number.isFinite(resolu.spread)) {
        resolu.taux = resolu.livret_a_origine + resolu.spread;
      }
      pretsACalculer.push(resolu);
    }

    // Un pret theorique dont les caracteristiques n'ont pas pu etre resolues ne
    // doit pas faire echouer toute la simulation : on le signale et on l'ecarte.
    const incalculables = pretsACalculer.filter((p) => p.montant_eur > 0 && !(p.duree_ans > 0));
    for (const p of incalculables) {
      alertes.push(
        `${p.libelle} de ${arrondiEuro(p.montant_eur)} EUR non amorti : duree et taux inconnus ` +
          `pour le produit ${p.produit}. Saisir ce pret manuellement.`,
      );
    }
    pretsACalculer = pretsACalculer.filter((p) => p.duree_ans > 0);

    // R-FIN-8 - Scission PLS / CPLS. Au-dela de 55 % du prix de revient de la
    // tranche, le complement n'est plus du PLS : c'est un CPLS. On scinde le
    // pret CONSTRUCTION, le foncier etant deja plafonne par son propre droit.
    if (tranches.PLS) {
      const prPLS = bilan.par_tranche?.PLS?.total_ttc_module_eur ?? 0;
      const pretsPLS = pretsACalculer.filter((p) => p.produit === 'PLS' && p.nature !== 'autre');
      const totalPLS = pretsPLS.reduce((s, p) => s + (p.montant_eur || 0), 0);
      const scission = scinderPLS({ montant_pls_eur: totalPLS, prix_revient_eur: prPLS });

      if (scission.cpls_eur > 0) {
        // L'exces se preleve sur la CONSTRUCTION d'abord, sur le foncier
        // ensuite, et JAMAIS au-dela de ce que chaque pret porte : retirer
        // aveuglement du pret construction rendait celui-ci negatif des que le
        // foncier absorbait tout le besoin, ce qui arrive sur une operation a
        // forte charge fonciere.
        let reste = scission.cpls_eur;
        const ordre = ['construction', 'foncier'];
        for (const nature of ordre) {
          if (reste <= 0) break;
          const p = pretsPLS.find((x) => x.nature === nature && x.montant_eur > 0);
          if (!p) continue;
          const pris = Math.min(p.montant_eur, reste);
          p.montant_eur = arrondiEuro(p.montant_eur - pris);
          reste = arrondiEuro(reste - pris);
        }
        // Le CPLS reprend les caracteristiques du pret construction PLS : c'est
        // de lui qu'il prend la place dans le plan.
        const modele = pretsPLS.find((p) => p.nature === 'construction') ?? pretsPLS[0] ?? {};
        pretsACalculer.push({
          ...modele,
          code: 'CPLS',
          libelle: 'CPLS',
          nature: 'construction',
          produit: 'PLS',
          montant_eur: scission.cpls_eur,
          montant_calcule: true,
          derive: true,
        });
        // Pas d'alerte : la ligne CPLS apparait d'elle-meme dans le plan de
        // financement, avec son origine en jeton. Le dire deux fois faisait
        // passer une mecanique normale pour un incident.
      } else if (scission.sous_plancher && totalPLS > 0) {
        alertes.push(
          `PLS a ${(scission.part_pls * 100).toFixed(1)} % du prix de revient de sa tranche, ` +
            'sous le plancher de 51 % de la calculette CDC. Un PLS trop faible signale que ' +
            "l'operation n'en avait pas besoin : le corriger releve du montage, pas du calcul.",
        );
      }
    }

    // R-FIN-9 - L'ensemble des prets LLI ne peut exceder 90 % du prix de revient.
    if (tranches.LOC) {
      const prLLI = bilan.par_tranche?.LOC?.total_ttc_module_eur ?? 0;
      const totalLLI = pretsACalculer
        .filter((p) => p.produit === 'LOC')
        .reduce((s, p) => s + (p.montant_eur || 0), 0);
      const cap = plafondPretsLLI({ total_prets_eur: totalLLI, prix_revient_eur: prLLI });
      if (cap.depassement_eur > 0) {
        alertes.push(
          `Prets LLI a ${(cap.part * 100).toFixed(1)} % du prix de revient de la tranche, ` +
            `au-dela du plafond de 90 % : ${cap.depassement_eur} EUR de trop. Ce solde doit ` +
            'venir en fonds propres ou en subventions (calculette CDC, controle AT32).',
        );
      }
    }
  }

  // R-AMT-1 - Un pret indexe se decrit par sa MARGE, jamais par son taux : le
  // taux en decoule et changerait tout seul si le Livret A de reference bougeait.
  // La derivation se fait ici, sur TOUS les prets, et non dans la seule branche
  // des prets CDC theoriques : un pret « autre » pose depuis un modele - Action
  // Logement, PHB 2.0 - porte lui aussi une marge et rien d'autre.
  for (const p of pretsACalculer) {
    if (p.taux === undefined || p.taux === null) {
      const spread = Number(p.spread);
      if (Number.isFinite(spread)) p.taux = (p.livret_a_origine ?? laOrigine) + spread;
    }
  }

  const amortissements = pretsACalculer
    .filter((p) => p.montant_eur > 0)
    .map((p) => ({
      code: p.code ?? p.libelle ?? 'pret',
      libelle: p.libelle ?? p.code,
      montant_eur: p.montant_eur,
      nature: p.nature ?? 'autre',
      produit: p.produit ?? trancheUnique,
      // Vrai si le montant a ete calcule pour equilibrer la tranche, faux s'il
      // a ete saisi. L'ecran s'en sert pour proposer le retour au calcul.
      montant_calcule: p.montant_calcule === true,
      // Pret DERIVE d'une regle et non saisi : l'ecran le montre en lecture seule.
      derive: p.derive === true,
      // Pret STRUCTURANT de la tranche : c'est lui qui absorbe l'ecart du plan
      // de financement. Un pret ajoute a cote finance un besoin identifie, pas
      // un solde - la distinction sert a l'ecran, qui ne les presente pas de la
      // meme facon, et un pret derive l'est toujours (le CPLS nait du plafond).
      principal: p.principal === true || p.derive === true,
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
        // R-AMT-6 : capital constant plutot qu'annuite progressive. C'est le
        // profil de la seconde phase du PHB 2.0 ; les prets CDC ordinaires
        // gardent l'annuite, qui reste le defaut.
        profil: p.profil_amortissement ?? 'annuite',
        // R-AMT-7 : les prets indexes SOUS le Livret A portent un plancher.
        taux_plancher: p.taux_plancher,
        // R-AMT-8 : echeances par an. Le compte reste annuel, le pret non.
        periodicite: p.periodicite ?? 1,
        livret_a_origine: p.livret_a_origine ?? laOrigine,
        livret_a_par_annee: p.livret_a_par_annee ?? laParAnnee,
      }),
    }));

  // Prets RESOLUS : la liste complete, y compris ceux dont le montant est nul et
  // qui ne sont donc pas amortis. Leur taux et leur duree existent pourtant, et
  // une restitution qui ne lirait que `amortissements` afficherait des tirets a
  // la place de caracteristiques parfaitement determinees.
  const pretsResolus = pretsACalculer.map((p) => ({
    code: p.code ?? p.libelle ?? 'pret',
    libelle: p.libelle ?? p.code,
    nature: p.nature ?? 'autre',
    produit: p.produit ?? trancheUnique,
    montant_eur: p.montant_eur,
    montant_calcule: p.montant_calcule === true,
    derive: p.derive === true,
    taux: p.taux ?? null,
    // Marge effectivement appliquee, a cote du taux qu'elle produit : l'ecran
    // donne a saisir la MARGE, et sans elle il ne pourrait afficher que le taux,
    // dont le lecteur ne saurait pas s'il vient du produit ou d'une surcharge.
    // Nulle sur un pret a taux saisi, qui n'est pas indexe sur le Livret A.
    spread: Number.isFinite(p.spread) && p.taux === p.livret_a_origine + p.spread ? p.spread : null,
    cle_marge: p.cle_marge ?? null,
    // R-AMT-7 : le taux NOMINAL peut etre negatif sur un pret indexe sous le
    // Livret A ; ce que le pret paie est le taux plancher. On publie les deux -
    // le nominal reste la base des revisions, l'applique est ce qui se lit.
    taux_plancher: p.taux_plancher ?? null,
    taux_applique:
      p.taux === undefined || p.taux === null
        ? null
        : p.taux_plancher === undefined || p.taux_plancher === null
          ? p.taux
          : Math.max(p.taux, p.taux_plancher),
    duree_ans: p.duree_ans ?? null,
    revisabilite: p.revisabilite ?? null,
    progressivite: p.progressivite ?? 0,
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

  // Plan de financement PAR TRANCHE. Une operation mixte n'a pas un plan mais
  // autant de plans qu'elle porte de produits : chacun a son prix de revient,
  // ses subventions, ses fonds propres et ses prets, et c'est a ce niveau que
  // se juge un equilibre. Les ressources ventilees viennent du calcul des
  // besoins, jamais d'un recalcul : deux ventilations finiraient par diverger.
  /** @type {Record<string, any>} */
  const planParTranche = {};
  for (const code of codesPresents) {
    const t = bilan.par_tranche?.[code];
    if (!t) continue;
    const res = ressourcesParTranche[code] ?? { subventions_eur: 0, fonds_propres_eur: 0 };
    const prets = pretsResolus.filter((p) => p.produit === code);
    const totalPretsTranche = arrondiEuro(prets.reduce((s, p) => s + (p.montant_eur || 0), 0));
    const ressources = arrondiEuro(
      res.subventions_eur + res.fonds_propres_eur + totalPretsTranche,
    );
    planParTranche[code] = {
      // Emplois : le prix de revient de la tranche, decline par chapitre.
      chapitres: Object.fromEntries(
        Object.entries(bilan.chapitres).map(([ch, v]) => [ch, v.par_tranche?.[code] ?? null]),
      ),
      prix_revient_ttc_eur: t.total_ttc_module_eur,
      part_su: t.part_su,
      // Le detail ne retient que les lignes qui rapportent quelque chose a
      // cette tranche : une subvention flechee ailleurs n'a rien a y faire.
      subventions: detailSubventions
        .filter((l) => (l.par_tranche[code] ?? 0) > 0)
        .map((l) => ({
          libelle: l.libelle,
          montant_eur: arrondiEuro(l.par_tranche[code]),
          montant_total_eur: l.montant_eur,
          ventilee: l.affectation === null,
        })),
      subventions_eur: res.subventions_eur,
      fonds_propres_eur: res.fonds_propres_eur,
      prets,
      total_prets_eur: totalPretsTranche,
      ressources_eur: ressources,
      ecart_eur: arrondiEuro(ressources - t.total_ttc_module_eur),
    };
  }

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


  // --- 7. Fiscalite (R-FISC) ---
  // R-FISC-1 : la duree d'exoneration est une propriete du PRODUIT (Q-14).
  // 25 ans en logement social (CGI art. 1384 A), 20 ans en intermediaire
  // (art. 1384-0 A), rien en libre. Une duree posee sur la simulation prime,
  // pour les operations qui ne remplissent pas les conditions.
  const tfpbParTranche = {};
  const tfpbMontantParLogement =
    entrees.exploitation?.tfpb_par_logement_eur ??
    baremes.constantes_reglementaires.tfpb.montant_par_logement_eur;
  /** @type {Array<{annee: number, montant_eur: number}>} */
  const tfpbParAnnee = [];
  const horizonTFPB = dates.duree_simulation_ans ?? 50;
  for (const c of codesPresents) {
    const duree =
      options.duree_exoneration_tfpb_ans ??
      produit(/** @type {any} */ (c)).duree_exoneration_tfpb_ans ??
      baremes.constantes_reglementaires.tfpb.duree_exoneration_defaut_ans;
    const debut = anneeMEL + duree;
    tfpbParTranche[c] = { duree_exoneration_ans: duree, annee_debut_tfpb: debut };
    const montant = tranches[c].nb_logements * tfpbMontantParLogement;
    for (let k = 0; k < horizonTFPB; k++) {
      const annee = anneeMEL + k;
      if (annee >= debut) tfpbParAnnee.push({ annee, montant_eur: montant });
    }
  }

  // Vue d'ensemble : la PREMIERE annee ou une taxe est due, quelle que soit la
  // tranche. C'est celle qui marque la rupture sur la courbe de resultat.
  const tfpb = exonerationTFPB(
    {
      annee_mise_en_location: anneeMEL,
      duree_exoneration_ans:
        options.duree_exoneration_tfpb_ans ??
        (codesPresents.length
          ? Math.min(...codesPresents.map((c) => tfpbParTranche[c].duree_exoneration_ans))
          : undefined),
    },
    baremes,
  );
  tfpb.par_tranche = tfpbParTranche;
  const ta = entrees.taxe_amenagement
    ? taxeAmenagement(entrees.taxe_amenagement, baremes)
    : null;

  // --- 8. Exploitation (R-EXP) ---
  const exp = entrees.exploitation ?? {};

  // R-EXP-PGE - Assiette de la provision pour gros entretien (`SimPLUS!BK31`).
  // En VEFA, c'est le prix de revient TTC tel quel. Hors VEFA, LEON en retranche
  // ce qu'une provision pour gros entretien n'a pas a couvrir : une part du
  // foncier, les frais d'acte et les frais financiers. Les postes retranches et
  // leur quotite viennent du referentiel, jamais du code.
  const cfgPGE = baremes.provision_gros_entretien ?? {};
  const assiettePGE = (() => {
    const total = bilan.total_ttc_module_eur;
    const vefa = /vefa/i.test(String(identite.type_operation ?? ''));
    if (vefa) return total;
    const parId = {};
    for (const p of bilan.postes ?? []) {
      if (p.id) parId[p.id] = (parId[p.id] ?? 0) + (p.ttc_lasm_eur ?? p.ttc_eur ?? 0);
    }
    const deductions = (cfgPGE.assiette?.hors_vefa_deductions ?? []).reduce(
      (s, d) => s + (parId[d.poste] ?? 0) * (d.quotite ?? 1),
      0,
    );
    return arrondiEuro(Math.max(0, total - deductions));
  })();

  // Le plafond de PGE est un CONTROLE, pas un ecretement : l'annexe le porte a
  // cote du taux (« PLAFOND PGERC »), et le depasser est une decision de
  // montage. Le moteur le dit et laisse passer, comme pour le plancher du PLS.
  const tauxPGERetenu = exp.pge_taux ?? cfgPGE.taux_defaut ?? 0;
  if (cfgPGE.taux_plafond > 0 && tauxPGERetenu > cfgPGE.taux_plafond) {
    alertes.push(
      `Provision pour gros entretien a ${(tauxPGERetenu * 100).toFixed(2)} % du prix de revient, ` +
        `au-dela du plafond de ${(cfgPGE.taux_plafond * 100).toFixed(2)} %.`,
    );
  }
  const annuitesAplaties = amortissements.flatMap((a) =>
    a.tableau.map((l) => ({ annee: l.annee, annuite_eur: l.annuite_eur })),
  );
  // R-EXP-2 - Les INTERETS, pour la vue comptable. Ils sont deja dans les
  // tableaux d'amortissement : le compte de resultat ne fait que les y lire,
  // plutot que de les recalculer et risquer d'en donner une seconde version.
  const interetsAplatis = amortissements.flatMap((a) =>
    a.tableau.map((l) => ({ annee: l.annee, montant_eur: l.interets_eur })),
  );

  // R-EXP-2 et R-EXP-5 - Dotation aux amortissements comptables. La base est le
  // prix de revient diminue de la valeur comptable du terrain, qui ne s'amortit
  // pas. Sur cette base, deux etalements possibles :
  //  - PAR COMPOSANTS (le cas de LEON) : chaque composant a sa quote-part et sa
  //    duree, la dotation decroit par paliers a mesure qu'ils s'eteignent ;
  //  - LINEAIRE sur une duree unique, repli quand aucune grille n'est retenue.
  const cfgAmort = baremes.amortissement_comptable ?? {};
  const baseAmortissable = (() => {
    const quotiteTerrain =
      exp.quotite_terrain_non_amortissable ??
      quotiteFoncier(identite.zone_ABC, baremes, 'valeur_comptable_terrain_vefa');
    const terrain = (bilan.chapitres.charge_fonciere?.ttc_lasm_eur ?? 0) * quotiteTerrain;
    return Math.max(0, bilan.total_ttc_module_eur - terrain);
  })();

  // Une operation collective et une operation individuelle ne s'amortissent pas
  // de la meme facon : la maison est presque tout structure, l'immeuble porte
  // des equipements a duree courte. La grille suit donc la nature du programme.
  const grilleComposants =
    exp.composants_amortissement ??
    cfgAmort.composants?.[exp.nature_batie ?? identite.nature_batie ?? 'collectif'];
  const dureeSerie = dates.duree_simulation_ans ?? 50;
  const dotationSerie =
    exp.dotation_amortissements_par_annee?.length
      ? exp.dotation_amortissements_par_annee
      : exp.dotation_amortissements_eur === undefined && grilleComposants?.length
        ? dotationParComposants(baseAmortissable, grilleComposants, anneeMEL, dureeSerie, {
            continuer: cfgAmort.continuer_amortissement === true,
          })
        : [];

  const dotationAnnuelle = (() => {
    if (exp.dotation_amortissements_eur !== undefined) return exp.dotation_amortissements_eur;
    const duree = exp.duree_amortissement_ans ?? cfgAmort.duree_defaut_ans;
    if (!(duree > 0)) return 0;
    return arrondiEuro(baseAmortissable / duree);
  })();
  const nbLogements = lots.reduce((s, l) => s + (l.nb_logements ?? 0), 0);
  const shabTotal = lots.reduce((s, l) => s + (l.shab_m2 ?? 0), 0);

  // Q-16 : les postes de charge diverses viennent du referentiel, la saisie ne
  // fait que les activer. Q-27 : le mode foyer remplace les loyers par une
  // redevance forfaitaire indexee.
  const chargesDiverses = resoudreChargesExploitation(exp.charges_diverses, baremes);

  // R-EXP-4 - Impot sur les societes. Le logement social conventionne releve du
  // service d'interet general et en est exonere ; le logement intermediaire non.
  // C'est donc une propriete des PRODUITS presents dans le programme, et non un
  // reglage d'operation : une seule tranche imposable suffit a rendre l'IS du.
  // La saisie peut trancher elle-meme (exp.soumis_is), le referentiel fournit
  // toujours le taux, le differe et la liste des charges deductibles.
  const cfgIS = baremes.impot_societes ?? {};
  const produitsSoumisIS = new Set(cfgIS.produits_soumis ?? []);
  const soumisIS =
    exp.soumis_is ?? loyers.some((l) => produitsSoumisIS.has(l.code_produit));

  // La part fixe deductible se saisit par lot ou globalement (bloc « Part fixe
  // de la PGE/PGR »). Le moteur ramene les deux a un montant annuel.
  const partFixeGE = cfgIS.part_fixe_gros_entretien ?? {};
  const partFixeGEAnnuelle =
    (exp.is_part_fixe_ge_eur ?? partFixeGE.montant_eur ?? 0) *
    ((exp.is_part_fixe_ge_assiette ?? partFixeGE.assiette) === 'lot' ? nbLogements : 1);

  // Credits d'impot TFPB des logements intermediaires : un montant, une duree,
  // a compter de la mise en location (SimTOTAL_IS colonne J).
  const creditsIS = (exp.is_credits_impot ?? cfgIS.credit_impot_tfpb_lli?.lignes ?? []).flatMap(
    (c) =>
      Array.from({ length: c.duree_ans ?? 0 }, (_, k) => ({
        annee: anneeMEL + k,
        montant_eur: c.montant_eur ?? 0,
      })),
  );

  const exploitation = compteExploitation({
    annee_mise_en_location: anneeMEL,
    duree_ans: dates.duree_simulation_ans ?? 50,
    mode: exp.mode ?? 'loyers',
    mode_redevance: exp.mode_redevance ?? 'forfaitaire',
    redevance_annuelle_eur: exp.redevance_annuelle_eur ?? 0,
    redevance_annee_valeur: exp.redevance_annee_valeur,
    index_redevance: exp.index_redevance ?? 'loyers_irl',
    // Somme des annuites de fonds propres remuneres des tranches (R-FIN-7).
    // Une surcharge explicite reste possible pour un appel qui la connait deja.
    // Le scalaire ne sert plus qu'aux appels qui le fournissent eux-memes ;
    // les fonds propres des tranches passent par la SERIE, chacune avec sa duree.
    annuite_fonds_propres_eur: exp.annuite_fonds_propres_eur ?? 0,
    duree_annuite_fonds_propres_ans: exp.duree_annuite_fonds_propres_ans ?? 0,
    annuites_fonds_propres: annuitesFP,
    // R-FISC-1 : une serie, car la duree d exoneration varie selon le produit.
    tfpb_par_annee: tfpbParAnnee,
    // Le nombre de places d'un foyer, c'est son nombre de lots : le programme
    // le porte deja, le redemander serait une saisie a tenir en double.
    nb_lits: exp.nb_lits ?? nbLogements,
    qp_subventions_annuelle_eur: exp.qp_subventions_annuelle_eur ?? 0,
    duree_qp_subventions_ans: exp.duree_qp_subventions_ans ?? 0,
    prix_revient_ttc_eur: bilan.total_ttc_module_eur,
    charges_diverses: chargesDiverses,
    loyers_logements_annuels_eur: loyersLogementsAnnuels,
    loyers_annexes_annuels_eur: loyersAnnexesAnnuels,
    loyers_divers_annuels_eur: exp.loyers_divers_annuels_eur ?? 0,
    frais_gestion_annuels_eur: exp.frais_gestion_annuels_eur ?? 0,
    frais_gestion_pct_loyers: exp.frais_gestion_pct_loyers ?? 0,
    rel_annuel_eur: exp.rel_annuel_eur ?? 0,
    gros_entretien_eur_m2: exp.gros_entretien_eur_m2 ?? 0,
    pge_taux: tauxPGERetenu,
    pge_taux_par_annee: exp.pge_taux_par_annee ?? [],
    pge_base_eur: exp.pge_base_eur ?? assiettePGE,
    shab_m2: shabTotal,
    taux_vacance_impayes: exp.taux_vacance_impayes ?? 0,
    taux_produits_financiers: exp.taux_produits_financiers ?? 0,
    nb_logements: nbLogements,
    tfpb_par_logement_eur:
      exp.tfpb_par_logement_eur ?? baremes.constantes_reglementaires.tfpb.montant_par_logement_eur,
    annee_debut_tfpb: exp.annee_debut_tfpb ?? tfpb.annee_debut_tfpb,
    annuites: annuitesAplaties,
    // R-EXP-2 : de quoi tenir la vue comptable a cote de la vue tresorerie.
    interets_par_annee: interetsAplatis,
    dotation_amortissements_eur: dotationAnnuelle,
    dotation_amortissements_par_annee: dotationSerie,
    // R-EXP-4 : l'IS ne s'active que si un produit assujetti est au programme.
    is_taux: soumisIS ? (exp.is_taux ?? cfgIS.taux ?? 0) : 0,
    is_duree_differe_ans: exp.is_duree_differe_ans ?? cfgIS.duree_differe_ans ?? 0,
    is_charges_deductibles: exp.is_charges_deductibles ?? cfgIS.charges_deductibles ?? [],
    is_credits_impot_par_annee: creditsIS,
    is_part_fixe_ge_eur: partFixeGEAnnuelle,
    is_part_fixe_ge_differe_ans:
      exp.is_part_fixe_ge_differe_ans ?? partFixeGE.duree_differe_ans ?? 0,
    // Trajectoires par poste, issues du referentiel normalise. Une surcharge
    // explicite dans les entrees reste possible pour tester un scenario.
    trajectoires: exp.trajectoires ?? trajectoires.par_poste,
  });

  // Ruptures qui expliquent la forme de la courbe de resultat. Elles sont
  // calculees ici, sinon l'interface les redecouvrirait par difference, ce qui
  // serait du calcul metier dans l'ecran.
  const evenements = [];
  const anneeDebutTFPB = exp.annee_debut_tfpb ?? tfpb.annee_debut_tfpb;
  if (anneeDebutTFPB > anneeMEL && anneeDebutTFPB <= anneeFinSimulation) {
    evenements.push({
      annee: anneeDebutTFPB,
      code: 'tfpb',
      libelle: `Fin d'exonération de taxe foncière`,
    });
  }
  for (const a of amortissements) {
    const derniere = a.tableau.at(-1)?.annee;
    if (derniere && derniere <= anneeFinSimulation) {
      evenements.push({ annee: derniere, code: 'pret', libelle: `Dernière échéance ${a.libelle}` });
    }
  }
  evenements.sort((x, y) => x.annee - y.annee);

  exploitation.evenements = evenements;
  exploitation.indicateurs = indicateursExploitation(exploitation.lignes, {
    prix_revient_ttc_eur: bilan.total_ttc_module_eur,
  });
  exploitation.jalons = jalonsExploitation(exploitation.lignes, evenements);
  exploitation.indicateurs.annee_reconstitution_fonds_propres = anneeReconstitutionFondsPropres(
    exploitation.lignes,
    fondsPropres,
  );
  exploitation.fonds_propres_eur = fondsPropres;
  exploitation.charges_diverses_actives = chargesDiverses;
  // R-FIN-7 : detail des fonds propres par tranche, remuneres ou non.
  exploitation.fonds_propres_par_tranche = fondsPropresParTranche;
  exploitation.annuite_fonds_propres_eur = annuiteFPTotale;

  // En transparence, la redevance vaut la somme des charges (annexe RA44), et le
  // bailleur ne porte ni vacance ni impaye : le gestionnaire lui doit ces frais
  // que les places soient occupees ou non. Le taux saisi est donc NEUTRALISE par
  // le compte. On le dit quand meme : une valeur saisie qui ne produit rien doit
  // etre signalee, sans quoi l'utilisateur la croirait prise en compte.
  if (
    (exp.mode ?? 'loyers') === 'redevance' &&
    (exp.mode_redevance ?? 'forfaitaire') === 'transparence' &&
    (exp.taux_vacance_impayes ?? 0) > 0
  ) {
    alertes.push(
      `Redevance en transparence : les ${((exp.taux_vacance_impayes ?? 0) * 100).toFixed(1)} % de ` +
        'vacance et impayes ne sont pas appliques. Sous bail a gestionnaire, la redevance ' +
        'refacture les charges quelle que soit l’occupation - le risque est porte par le gestionnaire.',
    );
  }
  // Postes du compte que le moteur ne sait pas encore produire, listes pour que
  // l'ecran le dise plutot que de laisser croire a un compte complet. TEOM,
  // CGLLS, ANCOLS et assurance PNO en sont sortis : ils sont desormais des
  // postes du referentiel que la saisie active (Q-16).
  // Les frais de structure ont rejoint le catalogue de charges (forfait par
  // logement indexe sur la gestion) et la dotation aux amortissements est
  // desormais calculee : ils sortent de cette liste. Le seul poste de LEON qui
  // reste sans equivalent est la subvention d'exploitation a duree limitee.
  exploitation.postes_absents = ['Subvention d’exploitation à durée limitée'];

  // Base d'amortissement comptable (Grille d'analyse). Calculee UNIQUEMENT si
  // l'appelant fournit le montant de terrain et la quotite non amortissable :
  // la quotite n'a pas de valeur par defaut tant que Q-26 n'est pas tranchee
  // (25 % dans les annexes contre 13 % en zone B1 au referentiel).
  let amortissementComptable = null;
  if (entrees.amortissement_comptable?.montant_terrain_eur !== undefined) {
    const valeurTerrain = valeurComptableTerrain({
      montant_terrain_eur: entrees.amortissement_comptable.montant_terrain_eur,
      quotite: entrees.amortissement_comptable.quotite_terrain,
    });
    amortissementComptable = {
      valeur_comptable_terrain_eur: valeurTerrain,
      quotite_terrain: entrees.amortissement_comptable.quotite_terrain,
      ...baseAmortissementComptable({
        prix_revient_ttc_eur: bilan.total_ttc_module_eur,
        valeur_comptable_terrain_eur: valeurTerrain,
      }),
    };
  }

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
    surfaces_annexes_m2: lots.reduce((s, l) => s + (l.surfaces_annexes_m2 ?? 0), 0),
    subventions_eur: subventionsTotal,
    fonds_propres_eur: fondsPropres,
    ressources_eur: equilibre.ressources_eur,
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
    amortissement_comptable: amortissementComptable,
  };

  return {
    version_moteur: VERSION_MOTEUR,
    identite,
    calendrier,
    profil_trajectoires: trajectoires.profil ?? null,
    // R-PARAM - Ce qui a ete chiffre hors referentiel du depot. Une simulation
    // qui s'ecarte du bareme doit le dire : deux exports identiques a l'oeil
    // peuvent sinon porter des tarifs differents.
    parametrage: {
      baremes_ecarts: ecartsParametrage(baremesReferentiel, entrees.parametrage?.baremes),
      trajectoires_surchargees: Object.keys(entrees.parametrage?.trajectoires?.par_annee ?? {}).length,
    },
    surfaces: {
      par_produit: suParProduit,
      quotes_parts: quotesParts,
      tranches: codesPresents,
      detail: surfaces,
      // Recapitulatif par tranche, ce que les onglets Tranches restituent.
      recapitulatif: Object.fromEntries(
        codesPresents.map((c) => [
          c,
          {
            nb_lots: tranches[c].lignes.length,
            nb_logements: tranches[c].nb_logements,
            shab_m2: arrondiSurface(tranches[c].shab_m2),
            su_m2: arrondiSurface(tranches[c].su_m2),
            quote_part_su: quotesParts[c],
            // Apport RESOLU et non saisie brute : laisse au calcul, il vaut sa
            // part du prix de revient. Publier la saisie ici affichait une part
            // de 0 % sous un apport pourtant bien present.
            fonds_propres_eur: fpParProduit ? apportDe(c) : null,
            subventions_eur: subventions.par_produit[c] ?? 0,
            prix_revient_ttc_eur: bilan.par_tranche?.[c]?.total_ttc_module_eur ?? null,
            prets: amortissements
              .filter((a) => (a.produit ?? trancheUnique) === c)
              .map((a) => ({ code: a.code, libelle: a.libelle, montant_eur: a.montant_eur })),
          },
        ]),
      ),
    },
    loyers,
    bilan,
    subventions: { ...subventions, surcharge_fonciere: ssf, total_avec_ssf_eur: subventionsTotal },
    financement: {
      solde_a_financer_eur: solde,
      prets_cdc_theoriques: cdcTheoriques,
      prets_resolus: pretsResolus,
      // Grille tarifaire effectivement appliquee, surcharges comprises : l'ecran
      // en a besoin pour afficher « Livret A 2,40 % + 0,60 % » a cote de chaque
      // marge.
      livret_a_reference: laOrigine,
      marges_prets: margesPrets,
      // Subventions ligne par ligne, avec leur ventilation : la restitution en
      // a besoin, et l'operation entiere se lit comme une tranche de plus.
      subventions_detail: detailSubventions,
      prefinancement: prefi,
      total_prets_eur: totalPrets,
      total_prets_cdc_eur: totalPretsCDC,
      equilibre,
      par_tranche: planParTranche,
    },
    amortissements,
    fiscalite: { tfpb, taxe_amenagement: ta },
    exploitation,
    indicateurs,
    alertes,
  };
}
