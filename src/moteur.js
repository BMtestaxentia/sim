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
import { restituerLoyer, controlesLoyer } from './loyers.js';
import { normaliserTrajectoires } from './trajectoires.js';
import { restituerCalendrier } from './calendrier.js';
import { nouveauClasseur } from './formules/modele.js';
import { tresorerieChantier } from './tresorerie.js';
import { produit } from './produits.js';
import { fusionner, surchargerTrajectoires, ecartsParametrage } from './parametrage.js';
import { restituerPrixDeRevient, valeurComptableTerrain, baseAmortissementComptable } from './bilan.js';
import { restituerSubventions, restituerSurchargeFonciere } from './subventions.js';
import { quotiteFoncier, restituerEquilibre } from './financement.js';
import { tableauAmortissement, anneePremiereEcheance } from './amortissement.js';
import { exonerationTFPB, taxeAmenagement } from './fiscalite.js';
import {
  compteExploitation,
  sommerComptes,
  dotationParComposants,
  resoudreChargesExploitation,
  anneeReconstitutionFondsPropres,
  indicateursExploitation,
  jalonsExploitation,
} from './exploitation.js';
import { arrondiEuro, arrondirEnConservantLaSomme } from './arrondis.js';

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
  // LE CLASSEUR DE L'OPERATION. Les grandeurs deja ecrites en formules - le
  // calendrier, les surfaces, les loyers - s'y calculent et s'y lisent ; le
  // reste du moteur les consomme comme avant, en attendant d'y passer a son
  // tour. Chaque cellule n'y est calculee qu'une fois.
  const classeur = nouveauClasseur({ entrees, baremes, trajectoires });
  /**
   * @param {string} id
   * @param {Record<string, any>} [indices]
   */
  const lire = (id, indices) => classeur.valeur(id, indices);

  // --- 0. Calendrier (R-AMT-3, domaine « calendrier ») ---
  const calendrier = restituerCalendrier(classeur);
  const anneeMEL = calendrier.annee_mise_en_location;
  // Duree du chantier : elle sert au differe par defaut des prets principaux
  // (R-AMT-9) et a l'echeancier de tresorerie (R-TRESO).
  const dureeChantierMois = lire('duree_chantier_retenue');

  // --- 1. Surfaces (R-SURF, domaine « surfaces ») ---
  const surfaces = lots.map((lot, i) => ({
    ...lot,
    su_m2: lire('su_lot', { lot: i }),
    su_exacte_m2: lire('su_exacte_lot', { lot: i }),
  }));

  // Les tranches dans l'ordre de PREMIERE APPARITION dans les lots : c'est
  // celui des repartitions au prorata des surfaces, qui en dependent jusqu'au
  // tri des restes a egalite.
  const ordreSaisie = lire('tranches_ordre_saisie');
  /** @type {Record<string, {nb_logements: number, su_m2: number, shab_m2: number, lignes: any[]}>} */
  const tranches = {};
  for (const code of ordreSaisie) {
    const T = { tranche: code };
    tranches[code] = {
      nb_logements: lire('nb_logements_tranche', T),
      su_m2: lire('su_tranche', T),
      shab_m2: lire('shab_tranche', T),
      lignes: surfaces.filter((s) => s.code_produit === code),
    };
  }
  const suParProduit = Object.fromEntries(ordreSaisie.map((code) => [code, tranches[code].su_m2]));
  const quotesParts = Object.fromEntries(
    ordreSaisie.map((code) => [code, lire('quote_part_su', { tranche: code })]),
  );

  /** Codes de produit presents, dans l'ordre canonique. */
  const codesPresents = [...lire('tranches_presentes')];

  // --- 2. Loyers (R-LOYER, domaine « loyers »), une ligne par TRANCHE ---
  // Les parametres de loyer se lisent a la tranche (`loyers_par_produit`), les
  // valeurs portees par un lot restant lues en repli. R-LOYER-9 : les plafonds
  // de zone sont revalorises du millesime du bareme a la mise en location,
  // sauf si les options l'ecartent comme le fait LEON.
  const loyers = codesPresents.map((code) => {
    const t = tranches[code];
    const l = restituerLoyer(classeur, code);
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
  const anneesARattraper = lire('annees_a_rattraper');
  const millesimeBareme = lire('millesime_bareme');
  const cumulIRL = lire('cumul_irl_millesime');
  const revaloriser = lire('revaloriser_loyers');
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

  const loyersLogementsAnnuels = lire('loyers_logements_annuels');
  const loyersAnnexesAnnuels = lire('loyers_annexes_annuels');

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
  const trancheUnique = lire('tranche_unique');

  // Domaine « prix de revient ». La ventilation par tranche fait FOI pour les
  // chapitres et les totaux : elle applique a chaque tranche son propre taux de
  // livraison a soi-meme. La lecture d'un seul tenant, au taux de la tranche de
  // reference, ne fournit que le detail des postes.
  const bilan = restituerPrixDeRevient(classeur);

  // --- 4. Subventions (R-SUB) ---
  const subventions = restituerSubventions(classeur);
  // R-SUB-3 - Une subvention sans tranche n'existe pas au plan : elle ne finance
  // rien et ne compte dans aucun total. Elle n'est pas effacee pour autant -
  // c'est une somme saisie - mais elle se DIT, avec son montant et sa raison.
  for (const s of subventions.hors_plan) {
    alertes.push(
      `Subvention « ${s.libelle} » (${arrondiEuro(s.montant_eur)} EUR) rattachee a aucune tranche ` +
        (s.affectation
          ? `(« ${s.affectation} » n'est pas une tranche du programme)`
          : '(aucune tranche indiquee, sur un programme qui en compte plusieurs)') +
        " : elle n'entre pas au plan de financement. Une subvention se rattache a un financement, " +
        'comme un pret ; une aide qui vise deux tranches se saisit en deux lignes.',
    );
  }
  // R-SUB-2 : la zone et le type d'operation viennent de l'identite ; ils
  // suffisent a lire la valeur de base au bareme. Une valeur de base saisie
  // continue de primer.
  const ssf = restituerSurchargeFonciere(classeur);
  const subventionsTotal = lire('subventions_total');

  // --- 5. Financement (R-FIN) ---
  // Les fonds propres se saisissent par tranche (onglets Tranches de l'UI). Le
  // scalaire global reste accepte pour les appels anciens et les fixtures.
  // R-FIN-7 - Apport AUTOMATIQUE. Un apport non saisi n'est pas un apport nul :
  // c'est une part du prix de revient de la tranche, 5 % en regle generale et
  // 2 % en redevance transparente ou il prend la forme d'une avance de
  // tresorerie. Le moteur le resout lui-meme, comme il resout le montant d'un
  // pret CDC laisse en automatique - sinon l'ecran devrait pre-remplir une
  // valeur, et une valeur pre-remplie devient vite une valeur figee.
  // Domaine « financement » : l'apport de chaque tranche (R-FIN-7), saisi ou
  // calcule a sa part du prix de revient, et la charge des fonds propres
  // remuneres ou reconstitues.
  const fpParProduit = entrees.fonds_propres_par_produit ?? null;
  /** Apport resolu d'une tranche : la saisie si elle existe, sinon la part. */
  const apportDe = (c) => lire('apport_tranche', { tranche: c });
  const fondsPropres = lire('fonds_propres_total');
  const tauxApport = lire('taux_apport_reference');
  /** @type {Record<string, any>} */
  const fondsPropresParTranche = {};
  /** Charge de fonds propres annee par annee : chaque tranche a SA duree. */
  /** @type {Array<{annee: number, montant_eur: number, produit: string}>} */
  const annuitesFP = [];
  for (const c of codesPresents) {
    const T = { tranche: c };
    const taux = lire('taux_remuneration_fp', T);
    const duree = lire('duree_reconstitution_fp', T);
    const annuite = lire('annuite_fp_tranche', T);
    if (annuite > 0) {
      const derniere = lire('duree_charge_fp', T);
      for (let k = 0; k < derniere; k++) {
        // La tranche est PORTEE par la ligne : le compte d une tranche a besoin
        // de savoir laquelle de ces annuites est la sienne.
        annuitesFP.push({ annee: anneeMEL + k, montant_eur: annuite, produit: c });
      }
    }
    const tauxTranche = fpParProduit ? lire('taux_apport_tranche', T) : null;
    fondsPropresParTranche[c] = {
      montant_eur: lire('fonds_propres_tranche_arrondi', T),
      // De quoi permettre a l'ecran de dire si le montant est calcule ou saisi.
      montant_auto: fpParProduit ? lire('apport_saisi', { code: c }) === null : false,
      montant_auto_eur: fpParProduit ? lire('apport_auto_tranche', T) : null,
      // Le taux EFFECTIF de la tranche, et ce que le referentiel aurait donne,
      // pour que l'ecran sache s'il montre une surcharge ou un defaut.
      taux_apport: tauxTranche,
      taux_apport_reference: fpParProduit ? tauxApport : null,
      taux_apport_surcharge: fpParProduit ? tauxTranche !== tauxApport : false,
      remuneres: taux > 0,
      reconstitues: duree > 0,
      taux_remuneration: taux,
      duree_reconstitution_ans: duree,
      annuite_eur: annuite,
    };
  }
  const annuiteFPTotale = lire('annuite_fp_totale');

  const pretsSaisis = entrees.prets ?? [];

  // Solde a financer (R-FIN-3), prefinancement (R-FIN-6) et prets CDC
  // theoriques (R-FIN-4) : domaine « financement ». Les prets theoriques ne se
  // calculent que si aucun pret CDC n'est saisi et qu'une tranche releve des
  // fonds d'epargne - le logement libre se finance en banque.
  const solde = lire('solde_a_financer');
  const prefi = lire('prefi_actif')
    ? {
        nominal_eur: lire('prefinancement_nominal'),
        interets_eur: lire('prefinancement_interets'),
        capital_constitue_eur: lire('prefinancement_capital_constitue'),
      }
    : null;
  const cdcTheoriques = lire('cdc_theoriques_actifs')
    ? {
        pret_foncier_eur: lire('cdc_pret_foncier'),
        pret_batiment_eur: lire('cdc_pret_batiment'),
        total_cdc_eur: lire('cdc_total'),
      }
    : null;

  // --- 6. Prets (R-FIN-3/5/8/9 et R-AMT-1, domaines « financement » et « prets ») ---
  const laOrigine = trajectoires.taux_reference_livret_a;
  // R-AMT-1 - Grille tarifaire des prets CDC, deja surchargee par la fusion des
  // referentiels : le taux d'un pret vaut Livret A + marge, et seule la marge
  // est propre au produit.
  const margesPrets = baremes.prets_cdc?.marges ?? {};
  const codesFinances = codesPresents;

  // Subventions ligne par ligne, chacune avec les parts par tranche que le
  // besoin de chaque tranche a lues dans le classeur.
  /** @type {Array<{libelle: string, montant_eur: number, affectation: string|null, par_tranche: Record<string, number>}>} */
  const detailSubventions = [];
  /**
   * @param {string} libelle
   * @param {number} montant
   * @param {string|null} affectation
   * @param {Record<string, number>} parTranche
   */
  const ligneSubvention = (libelle, montant, affectation, parTranche) => {
    detailSubventions.push({ libelle, montant_eur: montant, affectation, par_tranche: parTranche });
    // Une subvention rattachee a une tranche qui n'ouvre droit a aucune aide
    // publique - le logement libre - n'est pas refusee : le montant saisi fait
    // foi, et une participation de collectivite de droit commun existe. Mais
    // elle se DIT : c'est le montage qui se decide, pas le calcul.
    const versLibre = codesFinances.filter(
      (c) => parTranche[c] > 0 && !lire('eligible_aides_publiques', { tranche: c }),
    );
    if (versLibre.length) {
      alertes.push(
        `Subvention « ${libelle} » : ${arrondiEuro(
          versLibre.reduce((s, c) => s + parTranche[c], 0),
        )} EUR sur ${versLibre.join(', ')}, tranche(s) hors aide publique. ` +
          "A verifier : une aide de l'Etat n'a pas a financer du logement libre.",
      );
    }
  };
  for (const s of subventions.rattachees) {
    ligneSubvention(
      s.libelle ?? 'Subvention',
      s.montant_eur,
      s.affectation,
      Object.fromEntries(codesFinances.map((c) => [c, c === s.affectation ? s.montant_eur : 0])),
    );
  }
  if (ssf?.subvention_eur) {
    ligneSubvention(
      'Surcharge foncière',
      ssf.subvention_eur,
      null,
      Object.fromEntries(codesFinances.map((c) => [c, lire('ssf_part_tranche', { tranche: c })])),
    );
  }

  /**
   * Subventions et fonds propres revenant a chaque tranche, arrondis : ceux que
   * le besoin a lus, relus par la restitution par tranche.
   * @type {Record<string, {subventions_eur: number, fonds_propres_eur: number}>}
   */
  const ressourcesParTranche = {};
  for (const c of codesFinances) {
    const T = { tranche: c };
    ressourcesParTranche[c] = {
      subventions_eur: lire('subventions_ventilees_tranche_arrondies', T),
      fonds_propres_eur: lire('fonds_propres_tranche_arrondi', T),
    };
  }
  const excedentRedresse = lire('excedent_redresse');
  if (excedentRedresse > 0) {
    const surfinancees = codesFinances.filter((c) => lire('besoin_brut', { tranche: c }) < 0);
    alertes.push(
      `Tranche${surfinancees.length > 1 ? 's' : ''} ${surfinancees.join(', ')} surfinancee${surfinancees.length > 1 ? 's' : ''} ` +
        `de ${excedentRedresse} EUR : cet excedent reduit d'autant les prets des autres tranches ` +
        '(redressement en serie, calculette CDC).',
    );
  }

  // Valeurs par defaut qu'un produit n'a pas pu resoudre - une marge ou une zone
  // inconnue : dites une fois par tranche, dans l'ordre des prets qui les
  // appellent.
  const clesPretsBase = classeur.valeursDimension('pret_base');
  const tranchesSignalees = new Set();
  for (const p of clesPretsBase) {
    const P = { pret_base: p };
    if (!lire('nature_pret', P)) continue;
    const code = lire('tranche_pret', P);
    if (tranchesSignalees.has(String(code))) continue;
    tranchesSignalees.add(String(code));
    const erreur = lire('erreur_defauts_pret', { code });
    if (erreur) {
      alertes.push(
        `Prets CDC par defaut de la tranche ${code} non calculables : ` +
          `${erreur}. Saisir leur taux et leur duree.`,
      );
    }
  }
  // Un pret dont la duree reste inconnue ne fait pas echouer la simulation : il
  // est ecarte du plan, et signale.
  for (const p of clesPretsBase) {
    const P = { pret_base: p };
    const montant = lire('montant_avant_scission', P);
    if (montant > 0 && !lire('pret_calculable', P)) {
      alertes.push(
        `${lire('carac_pret', { ...P, champ: 'libelle' })} de ${arrondiEuro(montant)} EUR non amorti : ` +
          `duree et taux inconnus pour le produit ${lire('tranche_pret', P)}. Saisir ce pret manuellement.`,
      );
    }
  }
  // R-FIN-8 - Le CPLS apparait de lui-meme dans le plan, avec son origine en
  // jeton : le dire deux fois ferait passer une mecanique normale pour un
  // incident. Seul un PLS sous le plancher se signale - le corriger releve du
  // montage, pas du calcul.
  if (tranches.PLS && !(lire('cpls_montant') > 0) && lire('pls_sous_plancher') && lire('total_pls') > 0) {
    alertes.push(
      `PLS a ${(lire('part_pls') * 100).toFixed(1)} % du prix de revient de sa tranche, ` +
        'sous le plancher de 51 % de la calculette CDC. Un PLS trop faible signale que ' +
        "l'operation n'en avait pas besoin : le corriger releve du montage, pas du calcul.",
    );
  }
  // R-FIN-9 - L'ensemble des prets LLI ne peut exceder 90 % du prix de revient.
  if (tranches.LOC && lire('depassement_prets_lli') > 0) {
    alertes.push(
      `Prets LLI a ${(lire('part_prets_lli') * 100).toFixed(1)} % du prix de revient de la tranche, ` +
        `au-dela du plafond de 90 % : ${lire('depassement_prets_lli')} EUR de trop. Ce solde doit ` +
        'venir en fonds propres ou en subventions (calculette CDC, controle AT32).',
    );
  }

  // Les prets du plan, dans l'ordre : saisis, poses par defaut, puis le CPLS.
  const prets = classeur.valeursDimension('pret').map((cle) => {
    const P = { pret: cle };
    return {
      cle,
      code: lire('code_pret', P),
      libelle: lire('libelle_pret', P),
      nature: lire('nature_pret_final', P),
      produit: lire('produit_pret', P),
      montant_eur: lire('montant_pret', P),
      montant_calcule: lire('montant_calcule_pret', P),
      derive: lire('derive_pret', P),
      taux: lire('taux_pret', P),
    };
  });

  const amortissements = prets
    .filter((p) => p.montant_eur > 0)
    .map((p) => {
      const P = { pret: p.cle };
      // R-AMT-3 : chaque pret garde SA date ; a defaut, la mise en location.
      const premiereEcheance = lire('annee_premiere_echeance_pret', P);
      return {
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
        // de financement, et un pret derive l'est toujours.
        principal: lire('principal_pret', P),
        taux_saisi: p.taux,
        annee_premiere_echeance: premiereEcheance,
        tableau: tableauAmortissement({
          montant_eur: p.montant_eur,
          taux: p.taux,
          progressivite: lire('progressivite_pret', P),
          duree_ans: lire('duree_ans_pret', P),
          annee_premiere_echeance: premiereEcheance,
          revisabilite: lire('revisabilite_pret', P),
          differe_ans: lire('differe_ans_pret', P),
          differe_mois: lire('differe_mois_pret', P),
          differe_type: lire('differe_type_pret', P),
          profil: lire('profil_pret', P),
          taux_plancher: lire('taux_plancher_pret', P),
          periodicite: lire('periodicite_pret', P),
          livret_a_origine: lire('livret_a_origine_final', P),
          livret_a_par_annee: lire('livret_a_par_annee_final', P),
        }),
      };
    });

  // Prets RESOLUS : la liste complete, y compris ceux dont le montant est nul et
  // qui ne sont donc pas amortis. Leur taux et leur duree existent pourtant.
  const pretsResolus = prets.map((p) => {
    const P = { pret: p.cle };
    return {
      code: p.code ?? p.libelle ?? 'pret',
      libelle: p.libelle ?? p.code,
      nature: p.nature ?? 'autre',
      produit: p.produit ?? trancheUnique,
      montant_eur: p.montant_eur,
      montant_calcule: p.montant_calcule === true,
      derive: p.derive === true,
      taux: p.taux ?? null,
      // Marge effectivement appliquee, a cote du taux qu'elle produit ; nulle sur
      // un pret a taux saisi, qui n'est pas indexe sur le Livret A.
      spread: lire('marge_affichee_pret', P),
      cle_marge: lire('cle_marge_pret', P),
      // R-AMT-7 : le taux nominal, et le taux applique au-dessus du plancher.
      taux_plancher: lire('taux_plancher_pret', P) ?? null,
      taux_applique: lire('taux_applique_pret', P),
      duree_ans: lire('duree_ans_pret', P) ?? null,
      // R-AMT-9 : le differe EFFECTIF, en mois.
      differe_mois: lire('differe_mois_effectif_pret', P),
      revisabilite: lire('revisabilite_saisie_pret', P) ?? null,
      progressivite: lire('progressivite_pret', P),
    };
  });

  // Tous les prets amortis, quelle que soit leur nature (R-FIN-1), et les seuls
  // prets CDC pour le ratio reglementaire (R-FIN-5).
  const totalPrets = lire('total_prets');
  const totalPretsCDC = lire('total_prets_cdc');
  const equilibre = restituerEquilibre(classeur);
  alertes.push(...equilibre.alertes);

  // Plan de financement PAR TRANCHE. Une operation mixte n'a pas un plan mais
  // autant de plans qu'elle porte de produits, et c'est a ce niveau que se juge
  // un equilibre.
  /** @type {Record<string, any>} */
  const planParTranche = {};
  for (const code of codesPresents) {
    const t = bilan.par_tranche?.[code];
    if (!t) continue;
    const T = { tranche: code };
    const res = ressourcesParTranche[code] ?? { subventions_eur: 0, fonds_propres_eur: 0 };
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
      prets: pretsResolus.filter((p) => p.produit === code),
      total_prets_eur: lire('total_prets_tranche', T),
      ressources_eur: lire('ressources_tranche', T),
      ecart_eur: lire('ecart_tranche', T),
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
      if (annee >= debut) tfpbParAnnee.push({ annee, montant_eur: montant, produit: c });
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
  // R-FISC-2 - La taxe d'amenagement se ventile par tranche : le PLAI en est
  // exonere de plein droit, le PLUS et le PLS n'ont que l'abattement de 50 %, le
  // LLI et le libre n'ont ni l'un ni l'autre. Faute de surface de plancher par
  // tranche, la cle est celle qui sert partout ailleurs, la quote-part de
  // surface utile - une SDP par tranche viendra la remplacer sans changer le
  // calcul. Une saisie d'abattement continue de primer sur tout.
  const ta = entrees.taxe_amenagement
    ? taxeAmenagement(
        {
          ...entrees.taxe_amenagement,
          quotes_parts_sdp:
            entrees.taxe_amenagement.quotes_parts_sdp ??
            (codesPresents.length ? quotesParts : undefined),
        },
        baremes,
      )
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
  const nbLogements = lire('nb_logements_total');
  const shabTotal = lire('shab_totale');

  // Q-16 : les postes de charge diverses viennent du referentiel, la saisie ne
  // fait que les activer. Q-27 : le mode foyer remplace les loyers par une
  // redevance forfaitaire indexee.
  const chargesDiverses = resoudreChargesExploitation(exp.charges_diverses, baremes);

  // R-EXP-7 - Regime de produits par tranche. Une tranche est soit en LOYERS,
  // soit en REDEVANCE ; la redevance est forfaitaire (montant negocie) ou en
  // transparence (refacturation des charges). La quote-part de surface utile
  // suit, car c'est elle qui dit quelle PART des charges une tranche en
  // transparence refacture - la meme cle de ventilation que partout ailleurs.
  //
  // La liste n'est constituee que si au moins une tranche declare un regime :
  // sans cela on laisse le compte sur sa voie scalaire, qui porte les golden
  // tests et decrit tres bien une operation d'un seul tenant.
  const regimes = entrees.regimes_par_produit ?? {};
  const produitsParTranche = Object.keys(regimes).length
    ? loyers.map((l) => {
        const g = regimes[l.code_produit] ?? {};
        return {
          code: l.code_produit,
          mode: g.mode ?? 'loyers',
          mode_redevance: g.mode_redevance ?? 'forfaitaire',
          redevance_annuelle_eur: g.redevance_annuelle_eur ?? 0,
          redevance_annee_valeur: g.redevance_annee_valeur,
          index_redevance: g.index_redevance,
          loyers_annuels_eur: l.loyer_annuel_eur,
          quote_part: quotesParts[l.code_produit] ?? 0,
        };
      })
    : [];

  // R-EXP-4 - Impot sur les societes. Le logement social conventionne releve du
  // service d'interet general et en est exonere ; le logement intermediaire non.
  // C'est donc une propriete des PRODUITS presents dans le programme, et non un
  // reglage d'operation : une seule tranche imposable suffit a rendre l'IS du.
  // La saisie peut trancher elle-meme (exp.soumis_is), le referentiel fournit
  // toujours le taux, le differe et la liste des charges deductibles.
  const cfgIS = baremes.impot_societes ?? {};
  const produitsSoumisIS = new Set(cfgIS.produits_soumis ?? []);

  // R-EXP-RLS - Reduction de loyer de solidarite (CCH art. L. 442-2-1). Le
  // bailleur social diminue le loyer de ses locataires beneficiaires de l'APL :
  // c'est du loyer quittance en moins, pas une charge, et cela ne vise que le
  // parc conventionne. INACTIVE par defaut - l'allumer d'office deplacerait en
  // silence le resultat de toutes les simulations deja enregistrees, et le taux
  // du referentiel est une projection de la note de cadrage, pas un bareme
  // arrete. La saisie l'active, soit par le drapeau, soit en posant un taux.
  const cfgRLS = baremes.charges_exploitation?.reduction_loyer_solidarite ?? {};
  const produitsSoumisRLS = new Set(cfgRLS.produits_soumis ?? []);
  const rlsActive =
    exp.rls_actif ?? (exp.rls_taux !== undefined ? true : cfgRLS.actif_par_defaut === true);
  const tauxRLSBase = exp.rls_taux ?? cfgRLS.taux ?? 0;
  const tauxRLSDe = (code) => {
    if (!rlsActive) return 0;
    // Sans programme, il n'y a pas de tranche a filtrer : l'activation explicite
    // est tout ce dont on dispose, et elle fait foi.
    if (code === null) return tauxRLSBase;
    return produitsSoumisRLS.has(code) ? tauxRLSBase : 0;
  };
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

  /**
   * R-EXP-8 - Contexte du compte d'exploitation, cadre sur UNE tranche.
   *
   * Le compte est deja une fonction pure de son contexte : le cadrer sur une
   * tranche, c'est lui passer la part qui lui revient de chaque entree, pas
   * ecrire un second moteur. La plupart des charges suivent d'elles-memes,
   * leur assiette etant le logement ou les produits locatifs : leur passer le
   * nombre de logements et les loyers de la tranche suffit a les mettre a
   * l'echelle.
   *
   * Ce qui se FILTRE : les annuites de prets, leurs interets, la taxe fonciere
   * et les annuites de fonds propres, chacune portant sa tranche.
   *
   * Ce qui se PRORATISE, faute de porter une tranche : les loyers d annexes,
   * la quote-part de subventions et la base de provision pour gros entretien.
   * La cle est la quote-part de surface utile, celle qui sert partout
   * ailleurs (R-SUB, R-TVA).
   *
   * Ce qui se DECIDE par tranche : l'impot sur les societes. Le PLAI et le
   * PLUS en sont exoneres, le LLI non - le calculer sur un resultat global
   * melangeait des assiettes de regimes differents. Les credits d'impot TFPB
   * suivent le produit qui les ouvre.
   */
  const contexteExploitation = (code) => {
    const part = code === null ? 1 : (quotesParts[code] ?? 0);
    const lotsDe = code === null ? lots : lots.filter((l) => l.code_produit === code);
    const nbLog = code === null ? nbLogements : lotsDe.reduce((s, l) => s + (l.nb_logements ?? 0), 0);
    const shab = code === null ? shabTotal : lotsDe.reduce((s, l) => s + (l.shab_m2 ?? 0), 0);
    const loyerDe =
      code === null
        ? loyersLogementsAnnuels
        : (loyers.find((l) => l.code_produit === code)?.loyer_annuel_eur ?? 0);
    const prTranche =
      code === null
        ? bilan.total_ttc_module_eur
        : (bilan.par_tranche?.[code]?.total_ttc_module_eur ?? 0);
    const amortsDe = code === null ? amortissements : amortissements.filter((a) => a.produit === code);
    const parProduit = (serie) => (code === null ? serie : serie.filter((x) => x.produit === code));
    const soumisDe = code === null ? soumisIS : produitsSoumisIS.has(code);
    return {
      annee_mise_en_location: anneeMEL,
      duree_ans: dates.duree_simulation_ans ?? 50,
      mode: exp.mode ?? 'loyers',
      mode_redevance: exp.mode_redevance ?? 'forfaitaire',
      tranches_produits:
        code === null ? produitsParTranche : produitsParTranche.filter((p) => p.code === code),
      redevance_annuelle_eur: exp.redevance_annuelle_eur ?? 0,
      redevance_annee_valeur: exp.redevance_annee_valeur,
      index_redevance: exp.index_redevance ?? 'loyers_irl',
      annuite_fonds_propres_eur: exp.annuite_fonds_propres_eur ?? 0,
      duree_annuite_fonds_propres_ans: exp.duree_annuite_fonds_propres_ans ?? 0,
      annuites_fonds_propres: parProduit(annuitesFP),
      tfpb_par_annee: parProduit(tfpbParAnnee),
      // Le nombre de places se saisit pour l operation ; une tranche en prend
      // sa part. Lire son seul nombre de lots ferait perdre la saisie des
      // foyers, ou une place n est pas un logement.
      nb_lits: code === null ? (exp.nb_lits ?? nbLogements) : (exp.nb_lits ?? nbLogements) * part,
      qp_subventions_annuelle_eur: (exp.qp_subventions_annuelle_eur ?? 0) * part,
      duree_qp_subventions_ans: exp.duree_qp_subventions_ans ?? 0,
      prix_revient_ttc_eur: prTranche,
      charges_diverses: chargesDiverses,
      loyers_logements_annuels_eur: loyerDe,
      // R-EXP-RLS - Reduction de loyer de solidarite, decidee TRANCHE PAR
      // TRANCHE comme l'impot sur les societes, et pour la raison inverse : le
      // parc conventionne APL la subit, le logement intermediaire et le libre
      // non. Un taux moyen pose sur l'operation entiere aurait abandonne du
      // loyer libre a des locataires qui n'y ont pas droit.
      rls_taux: tauxRLSDe(code),
      rls_taux_par_annee: exp.rls_taux_par_annee ?? [],
      loyers_annexes_annuels_eur: loyersAnnexesAnnuels * part,
      loyers_divers_annuels_eur: (exp.loyers_divers_annuels_eur ?? 0) * part,
      frais_gestion_annuels_eur: (exp.frais_gestion_annuels_eur ?? 0) * part,
      frais_gestion_pct_loyers: exp.frais_gestion_pct_loyers ?? 0,
      frais_gestion_pct_prix_revient:
        exp.frais_gestion_pct_prix_revient ??
        baremes.charges_exploitation?.frais_gestion_pct_prix_revient ??
        0,
      rel_annuel_eur: (exp.rel_annuel_eur ?? 0) * part,
      gros_entretien_eur_m2: exp.gros_entretien_eur_m2 ?? 0,
      pge_taux: tauxPGERetenu,
      pge_taux_par_annee: exp.pge_taux_par_annee ?? [],
      pge_base_eur: (exp.pge_base_eur ?? assiettePGE) * part,
      shab_m2: shab,
      taux_vacance_impayes: exp.taux_vacance_impayes ?? 0,
      taux_produits_financiers: exp.taux_produits_financiers ?? 0,
      nb_logements: nbLog,
      tfpb_par_logement_eur:
        exp.tfpb_par_logement_eur ?? baremes.constantes_reglementaires.tfpb.montant_par_logement_eur,
      annee_debut_tfpb: exp.annee_debut_tfpb ?? tfpb.annee_debut_tfpb,
      // `annuite_eur` et non `montant_eur` : le compte lit ce nom-la pour les
      // annuites, et l autre pour les interets. Se tromper de cle ne leve
      // rien - elle vaut `undefined`, la somme donne NaN, et le compte entier
      // s efface sans un mot.
      annuites: amortsDe.flatMap((a) =>
        a.tableau.map((l) => ({ annee: l.annee, annuite_eur: l.annuite_eur })),
      ),
      interets_par_annee: amortsDe.flatMap((a) =>
        a.tableau.map((l) => ({ annee: l.annee, montant_eur: l.interets_eur })),
      ),
      dotation_amortissements_eur: dotationAnnuelle * part,
      dotation_amortissements_par_annee: dotationSerie.map((d) => ({
        ...d,
        montant_eur: d.montant_eur * part,
      })),
      is_taux: soumisDe ? (exp.is_taux ?? cfgIS.taux ?? 0) : 0,
      is_duree_differe_ans: exp.is_duree_differe_ans ?? cfgIS.duree_differe_ans ?? 0,
      is_charges_deductibles: exp.is_charges_deductibles ?? cfgIS.charges_deductibles ?? [],
      is_credits_impot_par_annee: soumisDe ? creditsIS : [],
      is_part_fixe_ge_eur:
        (exp.is_part_fixe_ge_eur ?? partFixeGE.montant_eur ?? 0) *
        ((exp.is_part_fixe_ge_assiette ?? partFixeGE.assiette) === 'lot' ? nbLog : part),
      is_part_fixe_ge_differe_ans:
        exp.is_part_fixe_ge_differe_ans ?? partFixeGE.duree_differe_ans ?? 0,
      trajectoires: exp.trajectoires ?? trajectoires.par_poste,
    };
  };

  // R-EXP-8 - LE CONSOLIDE EST LA SOMME DES TRANCHES.
  //
  // Un compte tenu d un seul tenant sur une operation mixte melange des
  // regimes qui ne se melangent pas. L impot sur les societes en est la
  // preuve : le PLAI, le PLUS et le PLS relevent du service d interet general
  // et en sont exoneres, le LLI non. Calcule sur le resultat global, il
  // frappait le surplus des tranches exonerees des qu une seule tranche
  // imposable figurait au programme - sur une operation PLAI+PLUS+PLS+LLI,
  // 2 158 885 € contre 538 123 € en sommant les tranches, soit quatre fois
  // trop. Tout le reste est additif a l euro pres (E-14).
  //
  // Sans tranche - les fixtures qui alimentent le bilan et les prets sans
  // passer par un programme de lots - le compte reste calcule d un seul
  // tenant : il n y a rien a sommer, et la voie scalaire decrit tres bien une
  // operation qui ne se decoupe pas.
  const comptesTranches = Object.fromEntries(
    codesPresents.map((c) => [c, compteExploitation(contexteExploitation(c))]),
  );
  const exploitation = codesPresents.length
    ? sommerComptes(codesPresents.map((c) => comptesTranches[c]))
    : compteExploitation({
    annee_mise_en_location: anneeMEL,
    duree_ans: dates.duree_simulation_ans ?? 50,
    mode: exp.mode ?? 'loyers',
    mode_redevance: exp.mode_redevance ?? 'forfaitaire',
    // R-EXP-7 : le regime de produits se declare TRANCHE PAR TRANCHE. Un foyer
    // en redevance peut cotoyer des logements familiaux en loyers dans la meme
    // operation, et c'est le cas courant des programmes mixtes. Les entrees
    // scalaires ci-dessus restent servies pour les appels qui decrivent
    // l'operation d'un seul tenant.
    tranches_produits: produitsParTranche,
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
    // R-EXP-RLS : sans programme, aucune tranche a filtrer - l'activation
    // explicite de la simulation fait foi.
    rls_taux: tauxRLSDe(null),
    rls_taux_par_annee: exp.rls_taux_par_annee ?? [],
    charges_diverses: chargesDiverses,
    loyers_logements_annuels_eur: loyersLogementsAnnuels,
    loyers_annexes_annuels_eur: loyersAnnexesAnnuels,
    loyers_divers_annuels_eur: exp.loyers_divers_annuels_eur ?? 0,
    frais_gestion_annuels_eur: exp.frais_gestion_annuels_eur ?? 0,
    frais_gestion_pct_loyers: exp.frais_gestion_pct_loyers ?? 0,
    // Q-17 : assiette de LEON, 0,3 % du prix de revient TTC. Elle vient du
    // referentiel et se surcharge par simulation, comme tout le reste.
    frais_gestion_pct_prix_revient:
      exp.frais_gestion_pct_prix_revient ??
      baremes.charges_exploitation?.frais_gestion_pct_prix_revient ??
      0,
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

  // Le mode vient de la saisie et non de la premiere tranche : une operation
  // mixte porte les deux, et c est la saisie qui dit lequel gouverne la vue.
  exploitation.mode = exp.mode ?? 'loyers';

  // --- R-TRESO : tresorerie de la phase chantier ---
  // Elle se calcule APRES le plan de financement : il lui faut le prix de
  // revient par chapitre, les subventions et les fonds propres resolus. Elle
  // s'arrete a la livraison, la ou le compte d'exploitation commence.
  const tresorerie =
    dates.date_debut_travaux && dureeChantierMois > 0
      ? tresorerieChantier({
          date_debut_travaux: dates.date_debut_travaux,
          duree_chantier_mois: dureeChantierMois,
          // Le prix de revient TTC, reparti a parts egales sur les mois de
          // chantier puis indexe (R-TRESO-2, classeur « Indexeur cout travaux »).
          cout_total_eur: bilan.total_ttc_module_eur,
          date_valeur_cout: dates.date_valeur_cout ?? entrees.tresorerie?.date_valeur_cout,
          taux_indexation:
            entrees.tresorerie?.taux_indexation ?? baremes.tresorerie?.taux_indexation ?? 0,
          // Mobilisables des l'ordre de service : arbitrage metier du 11/08/2026.
          subventions_eur: subventionsTotal,
          fonds_propres_eur: fondsPropres,
          // R-TRESO-3 : le bareme d'appels de fonds ne vaut QU'EN VEFA. Une
          // operation en maitrise d'ouvrage directe paie ses factures au fil du
          // chantier, sans jalon legal.
          jalons:
            String(identite.type_operation ?? '').toUpperCase() === 'VEFA'
              ? (entrees.tresorerie?.jalons ?? baremes.tresorerie?.jalons_vefa?.jalons ?? null)
              : null,
          mode_tirage:
            entrees.tresorerie?.mode_tirage ?? baremes.tresorerie?.mode_tirage ?? 'integral',
        })
      : null;

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
  // R-EXP-8 - Un compte d'exploitation par tranche, a cote du consolide. Il
  // sert la vue par tranche des ecrans et le cadrage des exports. Le
  // consolide reste calcule d un seul tenant tant que la somme des tranches
  // n'a pas ete confrontee a lui sur des operations reelles.
  exploitation.par_tranche = Object.fromEntries(
    codesPresents.map((c) => {
      const compte = comptesTranches[c];
      // Les memes indicateurs que le consolide, sur le meme horizon : une vue
      // par tranche qui ne saurait pas dire son TRI ou son creux de cumul ne
      // serait qu une table de chiffres.
      compte.indicateurs = indicateursExploitation(compte.lignes, {
        prix_revient_ttc_eur: bilan.par_tranche?.[c]?.total_ttc_module_eur ?? 0,
      });
      compte.indicateurs.annee_reconstitution_fonds_propres = anneeReconstitutionFondsPropres(
        compte.lignes,
        fondsPropresParTranche[c]?.montant_eur ?? 0,
      );
      compte.fonds_propres_eur = fondsPropresParTranche[c]?.montant_eur ?? 0;
      // Les ruptures de la courbe sont celles de l operation - entree en taxe
      // fonciere, fin d un pret - mais leurs JALONS se lisent sur les lignes de
      // la tranche : c est sa courbe qu on annote.
      compte.jalons = jalonsExploitation(compte.lignes, evenements);
      compte.evenements = evenements;
      compte.postes_absents = exploitation.postes_absents ?? [];
      return [c, compte];
    }),
  );
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
  // Plus aucun poste declare absent : la subvention d'exploitation a duree
  // limitee, seule occupante de cette liste, est ecartee du perimetre par le
  // metier (11/08/2026). La liste reste en place, elle servira au prochain
  // poste connu mais non modelise.
  exploitation.postes_absents = [];

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
    su_m2: lire('su_totale_tranches'),
    prix_revient_ttc_eur: bilan.total_ttc_module_eur,
    prix_revient_par_logement_eur:
      nbLogements > 0 ? arrondiEuro(bilan.total_ttc_module_eur / nbLogements) : null,
    prix_revient_par_m2_shab_eur:
      shabTotal > 0 ? arrondiEuro(bilan.total_ttc_module_eur / shabTotal) : null,
    loyers_annuels_eur: arrondiEuro(loyersLogementsAnnuels + loyersAnnexesAnnuels),
    surfaces_annexes_m2: lire('annexes_totales'),
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
            nb_lots: lire('nb_lots_tranche', { tranche: c }),
            nb_logements: tranches[c].nb_logements,
            shab_m2: lire('shab_tranche_arrondie', { tranche: c }),
            su_m2: tranches[c].su_m2,
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
    // R-TRESO : la phase chantier, en amont du compte d exploitation.
    tresorerie,
    indicateurs,
    alertes,
  };
}
