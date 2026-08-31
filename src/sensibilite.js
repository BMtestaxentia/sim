// @ts-check
/**
 * R-SENS - Analyse de sensibilite.
 *
 * Le moteur est PUR : memes entrees, memes sorties, aucune date systeme, aucun
 * etat global (CLAUDE.md §4). Une analyse de sensibilite n'est donc pas un
 * calcul de plus, c'est le meme calcul relance sur des entrees decalees. Ce
 * module ne modelise rien : il decrit QUOI faire varier, QUOI lire en retour,
 * et rejoue `calculer`.
 *
 * Deux lectures se completent :
 *
 *   - le BALAYAGE d'un levier, qui donne la courbe d'un indicateur sur une
 *     plage de variations. C'est la reponse a « et si les travaux derapent de
 *     5 % ? » ;
 *   - la TORNADE, qui compare les leviers entre eux : pour chacun, l'ecart de
 *     l'indicateur entre sa borne basse et sa borne haute. C'est la reponse a
 *     « qu'est-ce qui compte vraiment dans cette operation ? », et c'est
 *     souvent la plus utile, parce qu'elle contredit les intuitions.
 *
 * Aucun litteral metier ici : les amplitudes par defaut sont des hypotheses de
 * lecture, pas des regles, et chaque appel peut les remplacer.
 */

import { calculer } from './moteur.js';

/**
 * Copie profonde, sans passer par `structuredClone` : les referentiels et les
 * entrees sont du JSON pur, et le moteur doit rester importable dans un
 * navigateur ancien comme dans Node.
 * @template T
 * @param {T} v
 * @returns {T}
 */
const copier = (v) => JSON.parse(JSON.stringify(v));

/**
 * LEVIERS - ce qu'on fait varier.
 *
 * Chaque levier porte son UNITE, qui dit comment lire sa variation :
 *
 *   - `relatif` : une part, appliquee en multiplication. +0,05 = +5 % ;
 *   - `points`  : un decalage additif, en points de pourcentage. +0,005 = +0,5
 *     point. C'est l'unite des taux, ou un « +5 % » serait ambigu ;
 *   - `annees`  : un decalage additif, en annees.
 *
 * `appliquer` recoit un contexte DEJA copie et le modifie sur place : le
 * balayage en cree un par point de mesure, il n'y a rien a preserver. Il rend
 * VRAI s'il a trouve quelque chose a decaler, FAUX sinon - une operation sans
 * subvention ne se teste pas sur ses subventions, et une barre nulle dirait
 * alors « ce levier ne pese rien » la ou il faut lire « ce levier n'a pas ete
 * essaye ». La difference est tout sauf cosmetique : elle separe un resultat
 * d'une absence de resultat.
 *
 * `actionnable` distingue ce sur quoi le monteur a PRISE de ce qu il subit.
 * Negocier un prix, aller chercher une subvention sont des decisions ; le
 * Livret A, la vacance, les frais de gestion sont du contexte. Les deux
 * comptent dans la tornade - savoir ce qui pese ne demande pas d'y pouvoir
 * quelque chose - mais seuls les premiers ont leur place la ou on cherche quoi
 * FAIRE.
 *
 * @type {Array<{code: string, libelle: string, unite: 'relatif'|'points'|'annees',
 *   amplitude: number, actionnable?: boolean,
 *   appliquer: (c: {entrees: any, referentiels: any}, v: number) => void}>}
 */
export const LEVIERS = [
  {
    code: 'cout_batiment',
    libelle: 'Coût des travaux',
    unite: 'relatif',
    amplitude: 0.05,
    appliquer: (c, v) => {
      let mordu = false;
      for (const p of c.entrees.postes_bilan ?? []) {
        if (p.chapitre === 'batiment' && p.montant_ht_eur) {
          p.montant_ht_eur *= 1 + v;
          mordu = true;
        }
      }
      return mordu;
    },
  },
  {
    code: 'prix_revient',
    libelle: 'Prix de revient',
    unite: 'relatif',
    amplitude: 0.05,
    actionnable: true,
    appliquer: (c, v) => {
      let mordu = false;
      for (const p of c.entrees.postes_bilan ?? []) {
        if (p.montant_ht_eur) {
          p.montant_ht_eur *= 1 + v;
          mordu = true;
        }
      }
      return mordu;
    },
  },
  {
    code: 'subventions',
    libelle: 'Subventions',
    unite: 'relatif',
    amplitude: 0.2,
    actionnable: true,
    appliquer: (c, v) => {
      let mordu = false;
      for (const s of c.entrees.subventions ?? []) {
        if (s.montant_eur) {
          s.montant_eur *= 1 + v;
          mordu = true;
        }
      }
      return mordu;
    },
  },
  {
    code: 'livret_a',
    libelle: 'Livret A',
    unite: 'points',
    amplitude: 0.005,
    appliquer: (c, v) => {
      // Le TAUX DE REFERENCE ne bouge pas : la revision d'un pret CDC vaut
      // `LA_N - LA_0` (R-AMT-4), et c'est bien l'ecart a l'origine du contrat
      // qui fait l'annuite. Decaler les deux ne changerait rien.
      const tr = c.referentiels?.trajectoires?.trajectoires;
      if (!tr) return false;
      let mordu = false;
      for (const cle of Object.keys(tr)) {
        const a = tr[cle];
        if (a && typeof a.livret_a === 'number') {
          a.livret_a += v;
          mordu = true;
        }
      }
      return mordu;
    },
  },
  {
    code: 'vacance_impayes',
    libelle: 'Vacance et impayés',
    unite: 'points',
    amplitude: 0.01,
    appliquer: (c, v) => {
      const e = (c.entrees.exploitation ??= {});
      e.taux_vacance_impayes = Math.max(0, (e.taux_vacance_impayes ?? 0) + v);
      return true;
    },
  },
  {
    code: 'frais_gestion',
    libelle: 'Frais de gestion',
    unite: 'relatif',
    amplitude: 0.2,
    appliquer: (c, v) => {
      // Trois assiettes possibles et UNE SEULE en place par operation (R-EXP) :
      // en % des loyers, en % du prix de revient, ou en forfait. Le levier
      // decale CELLE QUI GOUVERNE, en part relative - la meme discipline que le
      // gros entretien.
      //
      // La version precedente ajoutait des points a la variante en % des
      // loyers, quelle que soit l'assiette en place. Or les assiettes sont
      // EXCLUSIVES dans le compte : poser un % des loyers sur une operation
      // assise sur le prix de revient ne s'y ajoutait pas, il la REMPLACAIT.
      // Sur un foyer a 0,3 % du prix de revient, « +1 pt de frais de gestion »
      // troquait 11 500 EUR de charge annuelle contre 2 400, et la tornade
      // montrait un levier qui AMELIORE l'operation en la chargeant.
      //
      // Le decalage RELATIF remplace les points pour la meme raison : un point
      // vaut un septieme d'une assiette a 7 % des loyers et quatre fois une
      // assiette a 0,3 % du prix de revient - la meme secousse ne peut pas
      // s'ecrire en points sur les deux.
      const e = (c.entrees.exploitation ??= {});
      if ((e.frais_gestion_pct_loyers ?? 0) > 0) {
        e.frais_gestion_pct_loyers *= 1 + v;
        return true;
      }
      const surPR =
        e.frais_gestion_pct_prix_revient ??
        c.referentiels?.baremes?.charges_exploitation?.frais_gestion_pct_prix_revient ??
        0;
      if (surPR > 0) {
        e.frais_gestion_pct_prix_revient = Math.max(0, surPR * (1 + v));
        return true;
      }
      if ((e.frais_gestion_annuels_eur ?? 0) > 0) {
        e.frais_gestion_annuels_eur *= 1 + v;
        return true;
      }
      return false;
    },
  },
  {
    code: 'gros_entretien',
    libelle: 'Gros entretien',
    unite: 'relatif',
    amplitude: 0.2,
    appliquer: (c, v) => {
      // Le gros entretien se dit de DEUX facons - un montant au metre carre,
      // ou une provision en part du prix de revient - et une seule gouverne a
      // la fois. Le levier decale celle qui est en place, sans avoir a savoir
      // laquelle : ne toucher que la premiere le rendait muet sur toute
      // operation reglee en provision, ce qui est le cas courant.
      const e = (c.entrees.exploitation ??= {});
      let mordu = false;
      if (e.gros_entretien_eur_m2) {
        e.gros_entretien_eur_m2 *= 1 + v;
        mordu = true;
      }
      const pge =
        e.pge_taux ?? c.referentiels?.baremes?.provision_gros_entretien?.taux_defaut ?? 0;
      if (pge) {
        e.pge_taux = Math.max(0, pge * (1 + v));
        mordu = true;
      }
      return mordu;
    },
  },
  {
    code: 'duree_prets',
    libelle: 'Durée des prêts',
    unite: 'annees',
    amplitude: 5,
    appliquer: (c, v) => {
      let mordu = false;
      for (const p of c.entrees.prets ?? []) {
        if (p.duree_ans) {
          p.duree_ans = Math.max(1, Math.round(p.duree_ans + v));
          mordu = true;
        }
      }
      // Seuls les prets SAISIS sont touches. Sans pret saisi, le moteur en
      // calcule de theoriques dont la duree ne se lit pas dans les entrees :
      // le levier rend alors faux, et la tornade le range parmi les
      // non-applicables plutot que de lui donner une barre nulle. Une barre
      // nulle dirait « la duree ne compte pas », ce qui serait faux.
      return mordu;
    },
  },
];

/**
 * INDICATEURS - ce qu'on lit en retour.
 *
 * `lire` rend `null` quand la grandeur n'a pas de sens sur ce resultat - un TRI
 * dont les flux ne changent jamais de signe, par exemple. Zero dirait autre
 * chose.
 *
 * @type {Array<{code: string, libelle: string, unite: 'eur'|'taux'|'annee'|'nombre',
 *   sens: 1|-1, lire: (r: any) => number|null}>}
 */
/**
 * Autofinancement cumule, a la FIN de l'horizon ou a une annee donnee.
 *
 * L'horizon complet - cinquante ans, parfois soixante - dit ce que
 * l'operation rapporte en tout. Il ne dit pas si elle passe le cap des vingt
 * ans, qui est la question qu'on se pose devant un directoire. Le cumul se lit
 * donc a une annee au choix.
 *
 * L'annee est ABSOLUE - 2048, pas « la vingtieme » : c'est ce que le tableau
 * du compte affiche, et demander a l'utilisateur de convertir serait lui faire
 * faire le travail du logiciel. Une annee hors horizon rend `null` et non la
 * derniere ligne : mieux vaut une case vide qu'un chiffre pris ailleurs.
 */
const cumulAutofinancement = (r, o) => {
  const n = o?.annee_cumul;
  if (!n) return r?.exploitation?.indicateurs?.resultat_cumule_final_eur ?? null;
  const ligne = (r?.exploitation?.lignes ?? []).find((l) => l.annee === Number(n));
  return ligne ? (ligne.cumul_autofinancement_eur ?? null) : null;
};

export const INDICATEURS = [
  {
    code: 'autofinancement_cumule',
    libelle: 'Autofinancement cumulé',
    unite: 'eur',
    // `sens` dit ce qu'une HAUSSE de l'indicateur signifie pour l'operation :
    // +1 elle va mieux, -1 elle va moins bien. L'affichage s'en sert pour
    // colorer, et rien d'autre - le calcul ne le lit jamais.
    sens: 1,
    lire: cumulAutofinancement,
  },
  {
    code: 'tri',
    libelle: 'TRI de l’opération',
    unite: 'taux',
    sens: 1,
    lire: (r) => r?.exploitation?.indicateurs?.tri ?? null,
  },
  {
    code: 'creux_cumul',
    libelle: 'Creux du cumul',
    unite: 'eur',
    sens: 1,
    lire: (r) => r?.exploitation?.indicateurs?.creux_cumul_eur ?? null,
  },
  {
    code: 'exercices_deficitaires',
    libelle: 'Exercices déficitaires',
    unite: 'nombre',
    sens: -1,
    lire: (r) => r?.exploitation?.indicateurs?.exercices_deficitaires ?? null,
  },
  {
    // La meme grandeur que l'OBJECTIF du meme code : elle manquait au catalogue
    // des indicateurs, si bien qu'une tornade ne savait pas dire ce qu'un
    // levier fait aux fonds propres appeles alors que la recherche d'equilibre
    // savait les viser. Les deux catalogues partagent desormais leurs trois
    // grandeurs communes, et une vue peut passer de l'un a l'autre sans table
    // de correspondance.
    code: 'fonds_propres',
    libelle: 'Fonds propres appelés',
    unite: 'eur',
    sens: -1,
    lire: (r) => r?.indicateurs?.fonds_propres_eur ?? null,
  },
];

/** Levier connu, par son code. */
export const levierDe = (code) => LEVIERS.find((l) => l.code === code) ?? null;
/** Indicateur connu, par son code. */
export const indicateurDe = (code) => INDICATEURS.find((i) => i.code === code) ?? null;

/**
 * Relance le moteur sur des entrees decalees d'UN levier.
 *
 * Le contexte est copie avant chaque variation : un levier qui multiplie des
 * montants les multiplierait sinon en cascade d'un point de mesure au suivant,
 * et la courbe serait exponentielle sans que rien ne le dise.
 *
 * Une variation qui fait echouer le moteur - un programme devenu incalculable -
 * rend un point sans valeur plutot que d'interrompre le balayage : c'est une
 * information, pas une panne.
 *
 * @param {any} entrees
 * @param {any} referentiels
 * @param {string} codeLevier
 * @param {number[]} variations
 * @returns {{levier: any, points: Array<{variation: number, resultat: any|null, erreur: string|null}>}}
 */
export function balayerLevier(entrees, referentiels, codeLevier, variations) {
  const levier = levierDe(codeLevier);
  if (!levier) throw new Error(`Levier inconnu : ${codeLevier}`);
  const points = variations.map((variation) => {
    const contexte = { entrees: copier(entrees), referentiels: copier(referentiels) };
    const applique = variation === 0 ? true : levier.appliquer(contexte, variation) !== false;
    try {
      return {
        variation,
        applique,
        resultat: calculer(contexte.entrees, contexte.referentiels),
        erreur: null,
      };
    } catch (e) {
      return { variation, applique, resultat: null, erreur: /** @type {Error} */ (e).message };
    }
  });
  return { levier, points };
}

/**
 * Plage de variations centree sur zero.
 *
 * Le point CENTRAL est toujours present, et vaut exactement zero : c'est le cas
 * de reference, celui auquel tout le reste se compare. Un nombre pair de pas le
 * ferait manquer, on impose donc un nombre impair de points.
 *
 * @param {number} amplitude
 * @param {number} points nombre de points, ramene au premier impair superieur
 * @returns {number[]}
 */
export function plage(amplitude, points = 5) {
  const n = points % 2 === 0 ? points + 1 : points;
  const moitie = (n - 1) / 2;
  return Array.from({ length: n }, (_, k) => ((k - moitie) / moitie) * amplitude);
}

/**
 * TORNADE - l'effet de chaque levier sur un indicateur, tous compares.
 *
 * Pour chaque levier, deux relances : borne basse et borne haute. L'ecart entre
 * les deux mesure ce que le levier PESE, et le classement par amplitude
 * decroissante donne la figure qui a donne son nom a l'exercice.
 *
 * La reference est calculee UNE fois, pas une par levier : c'est le meme
 * resultat, et le moteur etant pur, le recalculer n'apprendrait rien.
 *
 * @param {any} entrees
 * @param {any} referentiels
 * `contexte` est passe a CHAQUE lecture d indicateur : il porte les reglages
 * de lecture - l annee ou lire un cumul, par exemple - qui ne sont ni des
 * entrees du moteur ni des variations de levier.
 *
 * @param {{indicateur?: string, leviers?: string[], amplitudes?: Record<string, number>,
 *   contexte?: any}} [options]
 */
export function tornade(entrees, referentiels, options = {}) {
  const indicateur = indicateurDe(options.indicateur ?? INDICATEURS[0].code);
  if (!indicateur) throw new Error(`Indicateur inconnu : ${options.indicateur}`);
  const codes = options.leviers ?? LEVIERS.map((l) => l.code);

  const reference = calculer(copier(entrees), copier(referentiels));
  const valeurReference = indicateur.lire(reference, options.contexte);

  const barres = codes.map((code) => {
    const levier = levierDe(code);
    if (!levier) throw new Error(`Levier inconnu : ${code}`);
    const amplitude = options.amplitudes?.[code] ?? levier.amplitude;
    const { points } = balayerLevier(entrees, referentiels, code, [-amplitude, amplitude]);
    const bas = indicateur.lire(points[0].resultat, options.contexte);
    const haut = indicateur.lire(points[1].resultat, options.contexte);
    return {
      code,
      libelle: levier.libelle,
      unite: levier.unite,
      amplitude,
      bas,
      haut,
      reference: valeurReference,
      // L'ecart est pris en VALEUR ABSOLUE : un levier qui fait perdre autant
      // qu'un autre fait gagner pese autant, et c'est le poids qui classe.
      ecart: bas === null || haut === null ? null : Math.abs(haut - bas),
      // Un levier qui n'a rien trouve a decaler n'a pas ete essaye. Sa barre
      // nulle ne dit pas « sans effet », elle ne dit rien du tout.
      applique: points.every((p) => p.applique),
      erreurs: points.filter((p) => p.erreur).map((p) => p.erreur),
    };
  });

  // Les leviers non applicables ferment la marche : ils ne se comparent pas
  // aux autres, ils attendent une operation qui les porte.
  barres.sort((a, b) => {
    if (a.applique !== b.applique) return a.applique ? -1 : 1;
    return (b.ecart ?? -1) - (a.ecart ?? -1);
  });
  return { indicateur, reference: valeurReference, barres };
}

/**
 * OBJECTIFS - ce qu on cherche a atteindre.
 *
 * Un objectif est une grandeur du resultat et une valeur a lui donner. Il se
 * distingue d'un indicateur : celui-ci s'observe, celui-la se vise.
 *
 * @type {Array<{code: string, libelle: string, unite: string, cible_defaut: number,
 *   lire: (r: any) => number|null}>}
 */
export const OBJECTIFS = [
  {
    // L ECART du plan de financement ne fait pas un objectif : il est nul par
    // construction, les fonds propres absorbant le residu. Chercher a l annuler
    // repondrait toujours « deja atteint ». Ce qui se cherche, c est le montant
    // d APPORT que l operation reclame - et de combien bouger un levier pour le
    // ramener a ce que l organisme peut mettre.
    code: 'fonds_propres',
    libelle: 'Fonds propres appelés',
    unite: 'eur',
    // `sens` dit dans quel sens on veut aller : -1, moins il y en a, mieux
    // c'est. Sans lui, « atteindre la cible » ne veut rien dire - on ne sait
    // pas si on la veut au-dessus ou en dessous.
    sens: -1,
    cible_defaut: 0,
    lire: (r) => r?.indicateurs?.fonds_propres_eur ?? null,
  },
  {
    code: 'autofinancement_cumule',
    libelle: 'Autofinancement cumulé',
    unite: 'eur',
    sens: 1,
    cible_defaut: 0,
    lire: cumulAutofinancement,
  },
  {
    code: 'creux_cumul',
    libelle: 'Creux du cumul',
    unite: 'eur',
    sens: 1,
    cible_defaut: 0,
    lire: (r) => r?.exploitation?.indicateurs?.creux_cumul_eur ?? null,
  },
];

/** Objectif connu, par son code. */
export const objectifDe = (code) => OBJECTIFS.find((o) => o.code === code) ?? null;

/**
 * R-SENS-2 - RECHERCHE D EQUILIBRE.
 *
 * L'analyse de sensibilite demande « que se passe-t-il si ? ». Celle-ci pose la
 * question a l'envers : « de combien faut-il bouger ce levier pour atteindre
 * cela ? ». Meme moteur, meme purete, mais parcouru en sens inverse.
 *
 * La methode est la DICHOTOMIE, comme pour le TRI (`tauxRentabiliteInterne`) :
 * on encadre la solution entre deux bornes ou l'ecart a la cible change de
 * signe, puis on resserre. Elle ne demande aucune derivee, elle tolere les
 * discontinuites que le moteur porte - un arrondi au millier superieur, un
 * plafond de droit a pret - et elle converge toujours quand elle part d un
 * encadrement valide.
 *
 * Elle ne trouve rien dans deux cas, et les DISTINGUE :
 *
 *   - la cible n'est pas encadree par les bornes. Le levier ne peut pas y
 *     mener, du moins pas dans la plage exploree : c'est une reponse, et elle
 *     dit de chercher ailleurs ou plus loin ;
 *   - le levier ne mord pas sur cette operation - pas de subvention a faire
 *     varier, pas de pret saisi. Rien n a ete essaye.
 *
 * Une operation deja a l'equilibre rend une variation nulle, sans iterer.
 *
 * @param {any} entrees
 * @param {any} referentiels
 * @param {{levier: string, objectif?: string, cible?: number, bornes?: [number, number],
 *   tolerance?: number, iterations_max?: number}} options
 */
export function chercherEquilibre(entrees, referentiels, options) {
  const levier = levierDe(options.levier);
  if (!levier) throw new Error(`Levier inconnu : ${options.levier}`);
  const objectif = objectifDe(options.objectif ?? OBJECTIFS[0].code);
  if (!objectif) throw new Error(`Objectif inconnu : ${options.objectif}`);

  const cible = options.cible ?? objectif.cible_defaut;
  // Les bornes par defaut suivent l UNITE du levier : doubler un montant a du
  // sens, doubler un taux de Livret A n en a pas.
  const larges =
    levier.unite === 'relatif' ? [-0.9, 3] : levier.unite === 'annees' ? [-30, 30] : [-0.1, 0.1];
  const [a0, b0] = options.bornes ?? larges;
  const tolerance = options.tolerance ?? 1;
  const maxi = options.iterations_max ?? 60;

  /** Ecart a la cible pour une variation donnee, et le resultat qui va avec. */
  let applique = true;
  const essayer = (v) => {
    const contexte = { entrees: copier(entrees), referentiels: copier(referentiels) };
    if (v !== 0 && levier.appliquer(contexte, v) === false) applique = false;
    try {
      const resultat = calculer(contexte.entrees, contexte.referentiels);
      const valeur = objectif.lire(resultat, options.contexte);
      return { valeur, ecart: valeur === null ? null : valeur - cible, resultat };
    } catch (e) {
      return { valeur: null, ecart: null, resultat: null, erreur: /** @type {Error} */ (e).message };
    }
  };

  // La PRISE du levier se teste avant tout le reste : un levier sans prise ne
  // doit pas ressortir « deja atteint », qui laisserait croire qu il a servi.
  const essai = { entrees: copier(entrees), referentiels: copier(referentiels) };
  const mord = levier.appliquer(essai, b0) !== false;
  if (!mord) {
    return {
      trouve: false,
      applique: false,
      levier,
      objectif,
      cible,
      bornes: [a0, b0],
      raison: "ce levier n’a pas de prise sur cette opération",
    };
  }

  const depart = essayer(0);
  if (depart.ecart !== null && Math.abs(depart.ecart) <= tolerance) {
    return {
      trouve: true,
      applique: true,
      variation: 0,
      valeur: depart.valeur,
      cible,
      iterations: 0,
      levier,
      objectif,
      resultat: depart.resultat,
      raison: 'déjà atteint',
    };
  }

  let bas = { v: a0, ...essayer(a0) };
  let haut = { v: b0, ...essayer(b0) };
  applique = applique && bas.ecart !== null && haut.ecart !== null;
  if (!applique || bas.ecart === null || haut.ecart === null) {
    return {
      trouve: false,
      applique: false,
      levier,
      objectif,
      cible,
      bornes: [a0, b0],
      raison: 'ce levier n’a pas de prise sur cette opération',
    };
  }
  if (bas.ecart * haut.ecart > 0) {
    return {
      trouve: false,
      applique: true,
      levier,
      objectif,
      cible,
      bornes: [a0, b0],
      atteignable: [Math.min(bas.valeur, haut.valeur), Math.max(bas.valeur, haut.valeur)],
      raison: 'la cible n’est pas atteignable dans la plage explorée',
    };
  }

  let milieu = depart;
  let v = 0;
  let iterations = 0;
  while (iterations < maxi) {
    iterations += 1;
    v = (bas.v + haut.v) / 2;
    milieu = essayer(v);
    if (milieu.ecart === null) break;
    if (Math.abs(milieu.ecart) <= tolerance) break;
    // On garde le cote qui CHANGE DE SIGNE avec le milieu : c est lui qui
    // contient la racine.
    if (bas.ecart * milieu.ecart < 0) haut = { v, ...milieu };
    else bas = { v, ...milieu };
  }

  return {
    trouve: milieu.ecart !== null && Math.abs(milieu.ecart) <= tolerance,
    applique: true,
    variation: v,
    valeur: milieu.valeur,
    cible,
    iterations,
    levier,
    objectif,
    resultat: milieu.resultat,
    raison:
      milieu.ecart !== null && Math.abs(milieu.ecart) <= tolerance
        ? null
        : 'la dichotomie n’a pas convergé dans la tolérance demandée',
  };
}

/**
 * R-SENS-3 - RECHERCHE DE LA VERSION LA PLUS SOUTENABLE.
 *
 * « Optimiser » une operation ne veut rien dire tant qu on n a pas dit
 * OPTIMISER QUOI, et surtout A QUEL PRIX. Maximiser l'autofinancement
 * repondrait « supprimez la depense » ; minimiser les fonds propres,
 * « demandez tout en subvention ». Les deux sont vrais et inutiles.
 *
 * La question utile est renversee : quel est le MOINDRE EFFORT qui fait tenir
 * l'operation ? On se donne un objectif de tenue - l'autofinancement cumule
 * repasse au-dessus de zero, par defaut - et on cherche le plus petit
 * mouvement des leviers sur lesquels le monteur a prise.
 *
 * L'EFFORT est la mesure commune. Une variation brute ne se compare pas d'un
 * levier a l autre : -12 % de prix de revient et +180 % de subventions ne sont
 * pas du meme ordre de difficulte. Chaque levier declare une amplitude de
 * reference - son « cran » -, et l effort est le nombre de crans a parcourir.
 * Deux crans de prix, c est -10 % : dur mais discutable. Neuf crans de
 * subvention, c est une autre operation.
 *
 * Trois reponses possibles, et la troisieme compte autant que les autres :
 *
   - l'operation tient deja. On le dit, avec la marge ;
 *   - un levier seul suffit, ou une combinaison des deux. On donne le chemin ;
 *   - rien n'y arrive dans les limites explorees. On le dit, avec ce que
 *     l effort maximal permet quand meme d atteindre. Un outil qui ne sait pas
 *     dire non fait prendre des decisions sur du vent.
 *
 * La COMBINAISON partage l effort a parts egales entre les leviers : chacun
 * avance du meme nombre de crans, dans le sens qui ameliore. Ce n est pas la
 * seule repartition possible, c est la plus honnete a defaut de savoir ce qui
 * coute le plus cher a l'organisme - et elle se lit d'une phrase.
 *
 * @param {any} entrees
 * @param {any} referentiels
 * @param {{objectif?: string, cible?: number, leviers?: string[],
 *   effort_max?: number, contexte?: any}} [options]
 */
export function optimiser(entrees, referentiels, options = {}) {
  const objectif = objectifDe(options.objectif ?? 'autofinancement_cumule');
  if (!objectif) throw new Error(`Objectif inconnu : ${options.objectif}`);
  const cible = options.cible ?? objectif.cible_defaut;
  const codes = options.leviers ?? LEVIERS.filter((l) => l.actionnable).map((l) => l.code);
  // Quatre crans : au-dela, ce n est plus la meme operation. La borne se
  // remonte a l appel pour qui veut explorer plus loin.
  const effortMax = options.effort_max ?? 4;

  const lire = (r) => (r ? objectif.lire(r, options.contexte) : null);
  const satisfait = (v) =>
    v !== null && (objectif.sens === 1 ? v >= cible : v <= cible);

  /** Applique un effort - en crans - a plusieurs leviers a la fois. */
  const essayer = (mouvements) => {
    const contexte = { entrees: copier(entrees), referentiels: copier(referentiels) };
    let mordu = mouvements.length === 0;
    for (const { code, variation } of mouvements) {
      const levier = levierDe(code);
      if (!levier || variation === 0) continue;
      if (levier.appliquer(contexte, variation) !== false) mordu = true;
    }
    try {
      return { valeur: lire(calculer(contexte.entrees, contexte.referentiels)), mordu };
    } catch {
      return { valeur: null, mordu };
    }
  };

  const depart = essayer([]);
  if (satisfait(depart.valeur)) {
    return {
      etat: 'deja',
      objectif,
      cible,
      valeur: depart.valeur,
      marge: depart.valeur - cible,
      pistes: [],
      combinaison: null,
    };
  }

  // SENS D AMELIORATION de chaque levier, mesure et non suppose : baisser un
  // prix de revient aide, baisser une subvention nuit, et rien ne dit qu un
  // levier futur suivra la meme regle. Deux passages suffisent a le savoir.
  const utiles = [];
  for (const code of codes) {
    const levier = levierDe(code);
    if (!levier) continue;
    const bas = essayer([{ code, variation: -levier.amplitude }]);
    const haut = essayer([{ code, variation: levier.amplitude }]);
    if (!bas.mordu && !haut.mordu) {
      utiles.push({ code, libelle: levier.libelle, levier, sens: 0, raison: 'sans prise' });
      continue;
    }
    if (bas.valeur === null || haut.valeur === null) continue;
    const mieuxEnHaut =
      objectif.sens === 1 ? haut.valeur > bas.valeur : haut.valeur < bas.valeur;
    utiles.push({ code, libelle: levier.libelle, levier, sens: mieuxEnHaut ? 1 : -1 });
  }

  /** Plus petit effort, en crans, qui satisfait - ou `null`. */
  const chercherEffort = (mouvementsPour) => {
    const extreme = essayer(mouvementsPour(effortMax));
    if (!satisfait(extreme.valeur)) return { trouve: false, extreme: extreme.valeur };
    let bas = 0;
    let haut = effortMax;
    let valeur = extreme.valeur;
    // Vingt-cinq resserrements : la precision tombe sous le millieme de cran,
    // bien plus fin que ce qu une negociation sait tenir.
    for (let k = 0; k < 25; k++) {
      const milieu = (bas + haut) / 2;
      const essai = essayer(mouvementsPour(milieu));
      if (satisfait(essai.valeur)) {
        haut = milieu;
        valeur = essai.valeur;
      } else {
        bas = milieu;
      }
    }
    return { trouve: true, effort: haut, valeur };
  };

  const pistes = utiles
    .filter((u) => u.sens !== 0)
    .map((u) => {
      const r = chercherEffort((e) => [{ code: u.code, variation: u.sens * e * u.levier.amplitude }]);
      return {
        code: u.code,
        libelle: u.libelle,
        unite: u.levier.unite,
        amplitude: u.levier.amplitude,
        ...r,
        variation: r.trouve ? u.sens * r.effort * u.levier.amplitude : null,
      };
    })
    .sort((a, b) => (a.trouve === b.trouve ? (a.effort ?? 0) - (b.effort ?? 0) : a.trouve ? -1 : 1));

  const ensemble = utiles.filter((u) => u.sens !== 0);
  const combinaison =
    ensemble.length > 1
      ? (() => {
          const r = chercherEffort((e) =>
            ensemble.map((u) => ({ code: u.code, variation: u.sens * e * u.levier.amplitude })),
          );
          return {
            ...r,
            mouvements: r.trouve
              ? ensemble.map((u) => ({
                  code: u.code,
                  libelle: u.libelle,
                  unite: u.levier.unite,
                  variation: u.sens * r.effort * u.levier.amplitude,
                }))
              : [],
          };
        })()
      : null;

  const possible = pistes.some((p) => p.trouve) || combinaison?.trouve;
  return {
    etat: possible ? 'atteignable' : 'hors de portee',
    objectif,
    cible,
    valeur: depart.valeur,
    effort_max: effortMax,
    sansPrise: utiles.filter((u) => u.sens === 0).map((u) => u.libelle),
    pistes,
    combinaison,
  };
}

/**
 * R-SENS-4 - TOUS LES SCENARIOS.
 *
 * La tornade fait varier UN levier a la fois ; l optimiseur cherche le moindre
 * effort sur deux. Celle-ci enumere les COMBINAISONS COMPLETES : chaque levier
 * retenu prend tour a tour chacune de ses valeurs, on relance le moteur sur
 * chaque assemblage, et on classe.
 *
 * Ce que cela apporte et que les deux autres ne peuvent pas donner :
 * l INTERACTION. Le moteur n est pas lineaire - seuils de TVA, plafonds de
 * droit a pret, franchissement du seuil d imposition, plafond de provision -
 * si bien que deux leviers ensemble ne font pas toujours la somme de leurs
 * effets separes. Chaque scenario porte donc son ecart a cette somme. Un ecart
 * franc signale un seuil qu on vient de passer, et c est exactement ce qu on
 * ne peut pas deviner d une tornade.
 *
 * Deux avertissements sur le classement, et ils comptent :
 *
 *   - le meilleur scenario est toujours celui qui pousse tous les leviers du
 *     bon cote. C est vrai et sans interet. La colonne d EFFORT est donc
 *     indissociable du classement : elle dit ce que le scenario coute a
 *     obtenir, en crans de negociation, et permet de trier au rapport plutot
 *     qu au resultat brut ;
 *   - l enumeration explose. Quatre leviers a trois valeurs font quatre-vingt-
 *     un calculs, huit leviers en font six mille cinq cent soixante et un. Le
 *     plafond est explicite et le refus l est aussi : on ne tronque pas en
 *     silence une liste que l utilisateur croira complete.
 *
 * @param {any} entrees
 * @param {any} referentiels
 * @param {{leviers?: Array<{code: string, crans?: number[]}>, indicateur?: string,
 *   contexte?: any, max?: number}} [options]
 */
export function scenarios(entrees, referentiels, options = {}) {
  const indicateur = indicateurDe(options.indicateur ?? INDICATEURS[0].code);
  if (!indicateur) throw new Error(`Indicateur inconnu : ${options.indicateur}`);
  const max = options.max ?? 500;

  // Par defaut, les leviers sur lesquels on a prise, a un cran de part et
  // d autre. Zero est TOUJOURS present : sans lui la liste ne contiendrait pas
  // l operation telle qu elle est, et il n y aurait rien a quoi se comparer.
  const demandes =
    options.leviers ??
    LEVIERS.filter((l) => l.actionnable).map((l) => ({ code: l.code, crans: [-1, 0, 1] }));

  const axes = [];
  for (const d of demandes) {
    const levier = levierDe(d.code);
    if (!levier) throw new Error(`Levier inconnu : ${d.code}`);
    const crans = [...new Set([...(d.crans ?? [-1, 0, 1]), 0])].sort((a, b) => a - b);
    axes.push({ levier, crans });
  }

  // LES LEVIERS SANS PRISE QUITTENT L ENUMERATION. Garder un levier qui ne
  // decale rien triple la table de lignes IDENTIQUES aux precedentes : trois
  // compositions differentes, un seul chiffre, et le lecteur cherche l erreur.
  // Meme regle qu ailleurs - un levier muet est pire qu un levier absent.
  const sansPrise = [];
  const retenus = [];
  for (const a of axes) {
    const essai = { entrees: copier(entrees), referentiels: copier(referentiels) };
    const cran = a.crans.find((c) => c !== 0) ?? 1;
    if (a.levier.appliquer(essai, cran * a.levier.amplitude) === false) {
      sansPrise.push({ code: a.levier.code, libelle: a.levier.libelle });
    } else {
      retenus.push(a);
    }
  }
  axes.length = 0;
  axes.push(...retenus);

  const total = axes.reduce((n, a) => n * a.crans.length, 1);
  if (total > max) {
    return {
      etat: 'trop de combinaisons',
      sansPrise,
      indicateur,
      total,
      max,
      axes: axes.map((a) => ({ code: a.levier.code, libelle: a.levier.libelle, valeurs: a.crans.length })),
      scenarios: [],
    };
  }

  const mesurer = (mouvements) => {
    const contexte = { entrees: copier(entrees), referentiels: copier(referentiels) };
    let mordu = true;
    for (const m of mouvements) {
      if (m.variation === 0) continue;
      if (m.levier.appliquer(contexte, m.variation) === false) mordu = false;
    }
    try {
      return { valeur: indicateur.lire(calculer(contexte.entrees, contexte.referentiels), options.contexte), mordu };
    } catch (e) {
      return { valeur: null, mordu, erreur: /** @type {Error} */ (e).message };
    }
  };

  const reference = mesurer([]).valeur;

  // EFFETS ISOLES, calcules une fois : ils servent a la fois de repere et de
  // base a l interaction. Les recalculer par scenario multiplierait le cout par
  // le nombre de leviers sans rien apprendre de plus.
  const isole = new Map();
  for (const a of axes) {
    for (const c of a.crans) {
      if (c === 0) continue;
      const cle = `${a.levier.code}:${c}`;
      const m = mesurer([{ levier: a.levier, variation: c * a.levier.amplitude }]);
      isole.set(cle, m.valeur === null || reference === null ? null : m.valeur - reference);
    }
  }

  /** Produit cartesien, en profondeur : la liste tient en memoire, elle est bornee. */
  const combinaisons = axes.reduce(
    (acc, a) => acc.flatMap((debut) => a.crans.map((c) => [...debut, { axe: a, cran: c }])),
    [[]],
  );

  const liste = combinaisons.map((combo) => {
    const mouvements = combo.map(({ axe, cran }) => ({
      levier: axe.levier,
      variation: cran * axe.levier.amplitude,
    }));
    const m = mesurer(mouvements);
    const bouges = combo.filter((c) => c.cran !== 0);
    const sommeIsolee = bouges.reduce((s, c) => {
      const e = isole.get(`${c.axe.levier.code}:${c.cran}`);
      return s === null || e === null ? null : s + e;
    }, 0);
    const ecart = m.valeur === null || reference === null ? null : m.valeur - reference;
    return {
      // L EFFORT est la somme des crans parcourus, en valeur absolue : deux
      // leviers pousses d un cran chacun coutent autant qu un seul pousse de
      // deux, ce qui est discutable mais dit au moins quelque chose de stable.
      effort: bouges.reduce((s, c) => s + Math.abs(c.cran), 0),
      mouvements: bouges.map((c) => ({
        code: c.axe.levier.code,
        libelle: c.axe.levier.libelle,
        unite: c.axe.levier.unite,
        cran: c.cran,
        variation: c.cran * c.axe.levier.amplitude,
      })),
      valeur: m.valeur,
      ecart,
      // INTERACTION : ce que la combinaison fait EN PLUS de la somme de ses
      // parties. Nulle sur un moteur lineaire, elle ne l est pas ici.
      interaction: ecart === null || sommeIsolee === null ? null : ecart - sommeIsolee,
      erreur: m.erreur ?? null,
      applique: m.mordu,
    };
  });

  // Classement dans le sens FAVORABLE de l indicateur. Les scenarios sans
  // valeur ferment la marche : ils n ont pas echoue au classement, ils n ont
  // pas pu etre calcules.
  const signe = indicateur.sens === 1 ? -1 : 1;
  liste.sort((a, b) => {
    if ((a.valeur === null) !== (b.valeur === null)) return a.valeur === null ? 1 : -1;
    if (a.valeur === null) return 0;
    return signe * (a.valeur - b.valeur);
  });

  return { etat: 'ok', indicateur, reference, total, sansPrise, scenarios: liste };
}
