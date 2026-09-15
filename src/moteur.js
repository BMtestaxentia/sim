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
import { nouveauClasseur, modeleDe } from './formules/modele.js';
import { restituerTresorerie } from './tresorerie.js';
import { fusionner, surchargerTrajectoires, ecartsParametrage } from './parametrage.js';
import { restituerPrixDeRevient } from './bilan.js';
import { restituerSubventions, restituerSurchargeFonciere } from './subventions.js';
import { restituerEquilibre } from './financement.js';
import { restituerTableau } from './amortissement.js';
import { restituerTFPB, restituerTaxeAmenagement } from './fiscalite.js';
import {
  restituerCompte,
  restituerChargesDiverses,
  restituerPerimetre,
  restituerIndicateurs,
  jalonsExploitation,
} from './exploitation.js';
import { arrondiEuro } from './arrondis.js';

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
  return calculerAvecClasseur(entrees, referentiels).resultats;
}

/**
 * Calcule une simulation complete, et rend avec ses resultats le CLASSEUR qui
 * les a produits : l'ecran s'en sert pour expliquer chaque chiffre par sa
 * formule, sans rien recalculer.
 * @param {Entrees} entrees
 * @param {any} referentiels  { baremes, trajectoires }
 * @returns {{resultats: any, classeur: import('./formules/classeur.js').Classeur}}
 */
export function calculerAvecClasseur(entrees, referentiels) {
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
  // LE CLASSEUR DE L'OPERATION. Les grandeurs ecrites en formules - du
  // calendrier au compte d'exploitation - s'y calculent et s'y lisent ; ce
  // fichier ne fait que les restituer. Chaque cellule n'y est calculee qu'une
  // fois.
  //
  // Les MODIFICATIONS DU MODELE faites dans le classeur des calculs voyagent
  // avec les referentiels : ce sont des donnees, comme les baremes, et le
  // moteur calcule avec le modele qu'elles decrivent. Sans elles, c'est le
  // modele du depot.
  const classeur = nouveauClasseur({ entrees, baremes, trajectoires }, modeleDe(referentiels.surcharges_modele));
  /**
   * @param {string} id
   * @param {Record<string, any>} [indices]
   */
  const lire = (id, indices) => classeur.valeur(id, indices);

  // --- 0. Calendrier (R-AMT-3, domaine « calendrier ») ---
  const calendrier = restituerCalendrier(classeur);
  const anneeMEL = calendrier.annee_mise_en_location;

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
    alertes.push(
      revaloriser
        ? `Loyers plafonds revalorises du millesime ${millesimeBareme} a la mise en location ` +
            `${anneeMEL}, soit +${ecartPct} % aux IRL de la trajectoire. Ecart assume avec LEON, ` +
            "qui applique le bareme tel quel (option a l'ecran Parametres)."
        : `Bareme de loyers ${millesimeBareme} applique a une mise en location ${anneeMEL}, ` +
            `soit ${anneesARattraper} an${anneesARattraper > 1 ? 's' : ''} de revalorisation non ` +
            `pris en compte. Aux trajectoires du profil, les plafonds vaudraient ${ecartPct} % de ` +
            `plus, soit ${lire('ecart_loyers_millesime')} EUR de loyers annuels. Activer la ` +
            "revalorisation a l'ecran Parametres, saisir le bareme du millesime attendu, ou " +
            "assumer l'ecart.",
    );
  }


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
  // La charge annee par annee de ces fonds propres est une ligne du compte
  // d'exploitation de chaque tranche (`annuite_fp_serie`).
  for (const c of codesPresents) {
    const T = { tranche: c };
    const taux = lire('taux_remuneration_fp', T);
    const duree = lire('duree_reconstitution_fp', T);
    const annuite = lire('annuite_fp_tranche', T);
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
        // R-AMT : le tableau se lit dans le classeur, domaine « amortissement ».
        tableau: restituerTableau(classeur, p.cle),
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
  const anneeFinSimulation = lire('annee_fin_simulation');
  for (const p of prets) {
    if (!(p.montant_eur > 0)) continue;
    const P = { pret: p.cle };
    const derniere = lire('derniere_annee_pret', P);
    if (derniere > anneeFinSimulation) {
      alertes.push(
        `${p.libelle ?? p.code} court jusqu'en ${derniere}, au-dela de l'horizon de simulation ` +
          `(${anneeFinSimulation}) : ${arrondiEuro(lire('annuites_hors_horizon', P))} EUR d'annuites ne sont pas ` +
          "comptes au compte d'exploitation.",
      );
    }
  }


  // --- 7. Fiscalite (R-FISC) ---
  // R-FISC-1 : la duree d'exoneration est une propriete du PRODUIT (Q-14).
  // 25 ans en logement social (CGI art. 1384 A), 20 ans en intermediaire
  // (art. 1384-0 A), rien en libre. Une duree posee sur la simulation prime,
  // pour les operations qui ne remplissent pas les conditions.
  // Domaine « fiscalite » : la duree d'exoneration de chaque tranche. La taxe
  // due chaque annee a partir de la fin d'exoneration est une ligne du compte
  // d'exploitation de la tranche (`tfpb_serie`).
  const tfpb = restituerTFPB(classeur);
  // R-FISC-2 - La taxe d'amenagement, ventilee par tranche.
  const ta = restituerTaxeAmenagement(classeur);

  // --- 8. Exploitation (R-EXP, domaine « exploitation ») ---
  const exp = entrees.exploitation ?? {};

  // Le plafond de PGE est un CONTROLE, pas un ecretement : l'annexe le porte a
  // cote du taux (« PLAFOND PGERC »), et le depasser est une decision de
  // montage. Le moteur le dit et laisse passer, comme pour le plancher du PLS.
  const tauxPGERetenu = lire('pge_taux');
  const plafondPGE = lire('pge_taux_plafond');
  if (plafondPGE > 0 && tauxPGERetenu > plafondPGE) {
    alertes.push(
      `Provision pour gros entretien a ${(tauxPGERetenu * 100).toFixed(2)} % du prix de revient, ` +
        `au-dela du plafond de ${(plafondPGE * 100).toFixed(2)} %.`,
    );
  }
  const nbLogements = lire('nb_logements_total');
  const shabTotal = lire('shab_totale');

  // Q-16 : les postes de charges diverses viennent du referentiel, la saisie ne
  // fait que les activer. Une charge incompletement decrite arrete le calcul.
  const chargesDiverses = restituerChargesDiverses(classeur);

  // R-EXP-8 - LE CONSOLIDE EST LA SOMME DES TRANCHES.
  //
  // Chaque tranche tient SON compte dans le classeur : ses loyers ou sa
  // redevance, ses prets, sa taxe fonciere, sa part des charges communes, et
  // son regime d'impot. Un compte tenu d un seul tenant sur une operation mixte
  // melangeait des regimes qui ne se melangent pas : l impot sur les societes,
  // calcule sur le resultat global, frappait le surplus des tranches
  // exonerees des qu une seule tranche imposable figurait au programme - sur
  // une operation PLAI+PLUS+PLS+LLI, 2 158 885 € contre 538 123 € en sommant
  // les tranches, soit quatre fois trop. Tout le reste est additif a l euro
  // pres (E-14).
  //
  // Un programme sans tranche s'est arrete au prix de revient : il y a
  // toujours au moins un compte a sommer.
  const comptesTranches = Object.fromEntries(
    codesPresents.map((c) => [c, restituerCompte(classeur, c)]),
  );
  const exploitation = restituerPerimetre(classeur, 'operation', comptesTranches);
  // Le mode vient de la saisie et non de la premiere tranche : une operation
  // mixte porte les deux, et c est la saisie qui dit lequel gouverne la vue.
  exploitation.mode = exp.mode ?? 'loyers';

  // --- R-TRESO : tresorerie de la phase chantier ---
  // Elle se calcule APRES le plan de financement : il lui faut le prix de
  // revient par chapitre, les subventions et les fonds propres resolus. Elle
  // s'arrete a la livraison, la ou le compte d'exploitation commence.
  // Domaine « tresorerie » : il faut un ordre de service et une duree de
  // chantier pour tenir l'echeancier.
  const tresorerie = lire('tresorerie_calculee') ? restituerTresorerie(classeur) : null;

  // Ruptures qui expliquent la forme de la courbe de resultat. Elles sont
  // calculees ici, sinon l'interface les redecouvrirait par difference, ce qui
  // serait du calcul metier dans l'ecran.
  const evenements = [];
  const anneeDebutTFPB = lire('annee_debut_tfpb_exploitation');
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
  // R-EXP-3 : indicateurs du perimetre « operation ».
  exploitation.indicateurs = restituerIndicateurs(classeur, 'operation');
  exploitation.jalons = jalonsExploitation(exploitation.lignes, evenements);
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
      compte.indicateurs = restituerIndicateurs(classeur, c);
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
  const amortissementComptable = lire('amortissement_comptable_demande')
    ? {
        valeur_comptable_terrain_eur: lire('valeur_comptable_terrain'),
        quotite_terrain: lire('quotite_terrain_comptable_saisie'),
        base_eur: lire('base_amortissement_comptable'),
        part_du_prix_revient: lire('part_amortissable'),
      }
    : null;

  // --- 9. Indicateurs de synthese ---
  const indicateurs = {
    nb_logements: nbLogements,
    shab_m2: shabTotal,
    su_m2: lire('su_totale_tranches'),
    prix_revient_ttc_eur: bilan.total_ttc_module_eur,
    prix_revient_par_logement_eur: lire('prix_revient_par_logement'),
    prix_revient_par_m2_shab_eur: lire('prix_revient_par_m2_shab'),
    loyers_annuels_eur: lire('loyers_annuels_operation'),
    surfaces_annexes_m2: lire('annexes_totales'),
    subventions_eur: subventionsTotal,
    fonds_propres_eur: fondsPropres,
    ressources_eur: equilibre.ressources_eur,
    // RMO : rendement des loyers de l'annee 1 sur le prix de revient TTC.
    rmo: lire('rmo'),
    taux_fonds_propres: lire('taux_fonds_propres'),
    annee_reconstitution_fonds_propres: exploitation.indicateurs.annee_reconstitution_fonds_propres,
    annee_debut_tfpb: tfpb.annee_debut_tfpb,
    amortissement_comptable: amortissementComptable,
  };

  const resultats = {
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
  return { resultats, classeur };
}
