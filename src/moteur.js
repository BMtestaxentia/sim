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
  pretsCDCTheoriques,
  controleEquilibre,
} from './financement.js';
import { tableauAmortissement, anneePremiereEcheance, prefinancement } from './amortissement.js';
import { exonerationTFPB, taxeAmenagement } from './fiscalite.js';
import {
  compteExploitation,
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
    { code_produit: trancheUnique ?? codesPresents[0], postes: postesBilan, modulation_ttc_eur: modulation },
    baremes,
  );

  if (codesPresents.length) {
    const ventilation = prixDeRevientVentile(
      { postes: postesBilan, su_par_produit: suParProduit, modulation_ttc_eur: modulation },
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
  const fpParProduit = entrees.fonds_propres_par_produit ?? null;
  const fondsPropres = fpParProduit
    ? Object.values(fpParProduit).reduce((s, v) => s + (Number(v) || 0), 0)
    : (entrees.fonds_propres_eur ?? 0);
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
  {
    const surcharges = entrees.caracteristiques_prets_defaut ?? {};
    const codesFinances = codesPresents.length ? codesPresents : [];

    // R-FIN-3 — Chaque tranche porte par defaut un pret CDC foncier et un pret
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
    /** @type {Record<string, number>} */
    const subAffectees = {};
    let subNonAffectees = ssf?.subvention_eur ?? 0;
    for (const s of entrees.subventions ?? []) {
      const m = Number(s.montant_eur) || 0;
      const c = s.affectation;
      if (c && codesFinances.includes(c)) subAffectees[c] = (subAffectees[c] ?? 0) + m;
      else subNonAffectees += m;
    }

    /** @type {Record<string, number>} */
    const besoin = {};
    for (const c of codesFinances) {
      const pr = bilan.par_tranche?.[c]?.total_ttc_module_eur ?? 0;
      const sub = (subAffectees[c] ?? 0) + (quotesParts[c] ?? 0) * subNonAffectees;
      const fp = fpParProduit ? (Number(fpParProduit[c]) || 0) : (quotesParts[c] ?? 0) * fondsPropres;
      const fixes = prets
        .filter((p) => !auto(p) && (p.produit ?? trancheUnique) === c)
        .reduce((s, p) => s + (Number(p.montant_eur) || 0), 0);
      besoin[c] = Math.max(0, pr - sub - fp - fixes);
    }

    // Repartition foncier / construction : le foncier est plafonne a la part
    // FINANCABLE de la charge fonciere de la tranche (R-FIN-2), le reste va a la
    // construction. Sans ce plafond, un terrain cher absorberait tout le pret
    // long et fausserait la duree moyenne de la dette.
    /** @type {Record<string, number>} */
    const plafondFoncier = {};
    for (const c of codesFinances) {
      plafondFoncier[c] = foncierFinancable({
        charge_fonciere_eur: bilan.chapitres.charge_fonciere?.par_tranche?.[c]?.ttc_lasm_eur ?? 0,
        financements_gratuits_eur: subventions.gratuites_eur * (quotesParts[c] ?? 0),
        prix_revient_operation_eur: bilan.par_tranche?.[c]?.total_ttc_module_eur ?? 0,
      });
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
            progressivite: surcharges.progressivite ?? 0,
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

    for (const p of prets) {
      const code = p.produit ?? trancheUnique;
      let montant = p.montant_eur;
      if (auto(p) && code) {
        // Le foncier se sert le premier, dans la limite de son plafond ; la
        // construction prend ce qui reste. L'ordre importe, pas la position du
        // pret dans la liste.
        if (p.nature === 'foncier') {
          montant = Math.min(besoin[code] ?? 0, plafondFoncier[code] ?? 0);
        } else if (p.nature === 'construction') {
          const foncierAuto = prets.some((x) => auto(x) && x.nature === 'foncier' && (x.produit ?? trancheUnique) === code)
            ? Math.min(besoin[code] ?? 0, plafondFoncier[code] ?? 0)
            : 0;
          montant = Math.max(0, (besoin[code] ?? 0) - foncierAuto);
        } else {
          montant = 0;
        }
        montant = arrondiEuro(montant);
      }
      // Les valeurs du pret ne sont reprises que si elles sont RENSEIGNEES :
      // etaler `p` tel quel ecraserait un taux par defaut avec un `undefined`,
      // et le pret deviendrait inamortissable sans qu'on comprenne pourquoi.
      const renseignees = Object.fromEntries(
        Object.entries(p).filter(([, v]) => v !== undefined && v !== null),
      );
      pretsACalculer.push({
        ...(p.nature ? (defautsDe(code)?.[p.nature] ?? {}) : {}),
        ...renseignees,
        montant_eur: montant,
        produit: code,
        montant_calcule: auto(p),
        livret_a_origine: p.livret_a_origine ?? laOrigine,
        livret_a_par_annee: p.livret_a_par_annee ?? laParAnnee,
      });
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

  // Q-16 : les postes de charge diverses viennent du referentiel, la saisie ne
  // fait que les activer. Q-27 : le mode foyer remplace les loyers par une
  // redevance forfaitaire indexee.
  const chargesDiverses = resoudreChargesExploitation(exp.charges_diverses, baremes);

  const exploitation = compteExploitation({
    annee_mise_en_location: anneeMEL,
    duree_ans: dates.duree_simulation_ans ?? 50,
    mode: exp.mode ?? 'loyers',
    mode_redevance: exp.mode_redevance ?? 'forfaitaire',
    redevance_annuelle_eur: exp.redevance_annuelle_eur ?? 0,
    redevance_annee_valeur: exp.redevance_annee_valeur,
    index_redevance: exp.index_redevance ?? 'loyers_irl',
    annuite_fonds_propres_eur: exp.annuite_fonds_propres_eur ?? 0,
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
  exploitation.indicateurs = indicateursExploitation(exploitation.lignes);
  exploitation.jalons = jalonsExploitation(exploitation.lignes, evenements);
  exploitation.indicateurs.annee_reconstitution_fonds_propres = anneeReconstitutionFondsPropres(
    exploitation.lignes,
    fondsPropres,
  );
  exploitation.fonds_propres_eur = fondsPropres;
  exploitation.charges_diverses_actives = chargesDiverses;

  // En transparence, la redevance vaut la somme des charges (annexe RA44). Un
  // taux de vacance la rabote donc SANS que les charges baissent : le compte
  // sort en deficit permanent de ce taux, ce qui ressemble a un bug de modele
  // alors que c'est une hypothese de saisie. Sous bail a gestionnaire la
  // redevance est garantie et la vacance vaut zero.
  if (
    (exp.mode ?? 'loyers') === 'redevance' &&
    (exp.mode_redevance ?? 'forfaitaire') === 'transparence' &&
    (exp.taux_vacance_impayes ?? 0) > 0
  ) {
    alertes.push(
      `Redevance en transparence avec ${((exp.taux_vacance_impayes ?? 0) * 100).toFixed(1)} % de ` +
        'vacance : la redevance refacture les charges mais la vacance en retranche une part, ' +
        "d'ou un deficit permanent de ce meme taux. Mettre la vacance a 0 % sous bail a gestionnaire.",
    );
  }
  // Postes du compte que le moteur ne sait pas encore produire, listes pour que
  // l'ecran le dise plutot que de laisser croire a un compte complet. TEOM,
  // CGLLS, ANCOLS et assurance PNO en sont sortis : ils sont desormais des
  // postes du referentiel que la saisie active (Q-16).
  exploitation.postes_absents = [
    'Rémunération des fonds propres',
    'Frais de structure',
    'Dotation aux amortissements comptables',
    'Subvention d’exploitation à durée limitée',
  ];

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
            fonds_propres_eur: fpParProduit?.[c] ?? null,
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
