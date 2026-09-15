// @ts-check
/**
 * BIBLIOTHEQUE DES FONCTIONS DU LANGAGE DE FORMULES.
 *
 * Une formule ne dispose que de ce qui est ici. C'est volontaire : chaque
 * fonction porte son libelle et une phrase d'aide, que l'ecran affiche a cote
 * du bloc qui l'emploie. Une fonction qu'on ne sait pas expliquer en une phrase
 * n'a rien a faire dans une formule - elle cache un calcul qui devrait etre
 * ecrit en grandeurs.
 *
 * Trois familles :
 *
 *   - les fonctions STRICTES recoivent des valeurs (ARRONDI, MIN, AJOUTER.MOIS) ;
 *   - les fonctions PARESSEUSES recoivent des arguments non encore calcules et
 *     n'evaluent que ceux dont elles ont besoin (SI, DEFAUT, ET, OU). C'est ce
 *     qui permet d'ecrire `SI(su > 0; nl / su; 0)` sans diviser par zero ;
 *   - les AGREGATS parcourent une dimension ou une liste (SOMME, PRODUIT,
 *     REPARTIR, TRI...).
 *
 * Les rares fonctions de metier - l'indexation d'une trajectoire, le TRI, la
 * repartition sans perte - sont des ALGORITHMES, pas des formules : une
 * dichotomie ou une methode du plus grand reste ne s'ecrivent pas en blocs
 * lisibles. Elles sont nommees, documentees, et leur aide dit ce qu'elles font.
 */
import { arrondi, arrondiEuro, arrondiMillierSup, arrondirEnConservantLaSomme } from '../arrondis.js';
import { decalerMois, jourUTC, versISO } from '../dates.js';

/** @typedef {(c: any, s: any[]) => any} Fn */

/**
 * Facteur d'indexation composee entre deux annees, a partir d'une trajectoire
 * de taux annuels. Une annee absente de la trajectoire reconduit le dernier
 * taux connu (meme convention que le VLOOKUP approche de LEON).
 * @param {Record<number, number>|number} trajectoire taux par annee, ou taux constant
 * @param {number} annee_debut
 * @param {number} annee
 * @returns {number}
 */
export function facteurIndexation(trajectoire, annee_debut, annee) {
  if (annee <= annee_debut) return 1;
  if (typeof trajectoire === 'number') return (1 + trajectoire) ** (annee - annee_debut);
  let f = 1;
  // Amorce du VLOOKUP approche : la derniere valeur connue AVANT le depart, et
  // non zero. Une trajectoire qui ne commence qu'en 2030, sur une operation
  // livree en 2028, tenait autrement l'inflation pour nulle jusqu'en 2030 - une
  // sous-estimation silencieuse des charges, d'autant plus traitre que les
  // trajectoires du depot sont denses et ne l'exercent jamais.
  let dernier = 0;
  let amorce = null;
  for (const cle of Object.keys(trajectoire)) {
    const a = Number(cle);
    if (a <= annee_debut && (amorce === null || a > amorce)) amorce = a;
  }
  if (amorce !== null) dernier = trajectoire[amorce];
  for (let a = annee_debut + 1; a <= annee; a++) {
    const t = trajectoire[a];
    if (t !== undefined) dernier = t;
    f *= 1 + dernier;
  }
  return f;
}

/**
 * R-EXP-3 - Taux de rentabilite interne d'une serie de flux.
 *
 * Taux qui annule la valeur actuelle nette. Resolu par DICHOTOMIE et non par
 * Newton : la serie d'une operation de logement social commence par un flux
 * tres negatif suivi de cinquante flux faibles, ou la derivee est proche de
 * zero et ou Newton diverge. La dichotomie est plus lente et s'en moque.
 *
 * @param {number[]} flux  flux de chaque periode, le premier a la date zero
 * @returns {number|null} le taux, ou null s'il n'existe pas dans [-99 %, +100 %]
 */
export function tauxRentabiliteInterne(flux) {
  if (flux.length < 2) return null;
  const van = (t) => flux.reduce((s, f, i) => s + f / (1 + t) ** i, 0);
  let bas = -0.99;
  let haut = 1;
  let vBas = van(bas);
  // Sans changement de signe aux bornes, aucun taux ne l'annule : une operation
  // qui ne rembourse jamais sa mise n'a pas de TRI, et en inventer un serait
  // pire que de n'en donner aucun.
  if (!Number.isFinite(vBas) || vBas * van(haut) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const milieu = (bas + haut) / 2;
    const v = van(milieu);
    if (v * vBas > 0) {
      bas = milieu;
      vBas = v;
    } else {
      haut = milieu;
    }
  }
  return (bas + haut) / 2;
}

/**
 * Valeur d'une table annuelle pour une annee donnee : la valeur de l'annee si
 * elle existe, sinon la derniere valeur anterieure, sinon la valeur par
 * defaut. C'est le VLOOKUP approche de LEON (SimPLUS!FJ117), qui lit le
 * Livret A de l'annee dans la trajectoire.
 * @param {Record<number, number>|null|undefined} table
 * @param {number} annee
 * @param {number} defaut
 * @returns {number}
 */
export function rechercheAnnee(table, annee, defaut) {
  if (!table) return defaut;
  const direct = table[annee];
  if (direct !== undefined) return direct;
  let anneeRetenue = null;
  for (const cle of Object.keys(table)) {
    const a = Number(cle);
    if (a < annee && (anneeRetenue === null || a > anneeRetenue)) anneeRetenue = a;
  }
  return anneeRetenue === null ? defaut : table[anneeRetenue];
}

/**
 * @typedef {Object} DefFonction
 * @property {string} libelle
 * @property {string} aide
 * @property {[number, number]} arite         nombre d'arguments, minimum et maximum
 * @property {(...v: any[]) => any} [calc]    fonction STRICTE : recoit des valeurs
 * @property {(args: Fn[]) => Fn} [compiler]  fonction PARESSEUSE : version compilee
 * @property {(args: Array<() => any>) => any} [evaluer] fonction PARESSEUSE : version lue
 */

/** @type {Record<string, DefFonction>} */
export const FONCTIONS = {
  // --- Logique ---------------------------------------------------------------
  SI: {
    libelle: 'Si',
    aide: 'Rend la deuxième valeur si la condition est vraie, la troisième sinon. Seule la branche retenue est calculée.',
    arite: [3, 3],
    compiler: ([q, a, b]) => (c, s) => (q(c, s) ? a(c, s) : b(c, s)),
    evaluer: ([q, a, b]) => (q() ? a() : b()),
  },
  DEFAUT: {
    libelle: 'À défaut',
    aide: 'Rend la première valeur renseignée : la saisie si elle existe, sinon la valeur suivante.',
    arite: [2, 8],
    compiler: (args) => {
      if (args.length === 2) {
        const [a, b] = args;
        return (c, s) => a(c, s) ?? b(c, s);
      }
      return (c, s) => {
        for (let i = 0; i < args.length - 1; i++) {
          const v = args[i](c, s);
          if (v !== undefined && v !== null) return v;
        }
        return args[args.length - 1](c, s);
      };
    },
    evaluer: (args) => {
      for (let i = 0; i < args.length - 1; i++) {
        const v = args[i]();
        if (v !== undefined && v !== null) return v;
      }
      return args[args.length - 1]();
    },
  },
  ET: {
    libelle: 'Et',
    aide: 'Vrai si toutes les conditions le sont. S’arrête à la première fausse.',
    arite: [2, 8],
    compiler: (args) => (c, s) => {
      for (const a of args) if (!a(c, s)) return false;
      return true;
    },
    evaluer: (args) => {
      for (const a of args) if (!a()) return false;
      return true;
    },
  },
  OU: {
    libelle: 'Ou',
    aide: 'Vrai si l’une des conditions l’est. S’arrête à la première vraie.',
    arite: [2, 8],
    compiler: (args) => (c, s) => {
      for (const a of args) if (a(c, s)) return true;
      return false;
    },
    evaluer: (args) => {
      for (const a of args) if (a()) return true;
      return false;
    },
  },
  'SI.ABSENT': {
    libelle: 'Si absent',
    aide: 'Rend la seconde valeur si la première est absente. Une valeur explicitement vide est gardée telle quelle.',
    arite: [2, 2],
    compiler: ([a, b]) => (c, s) => {
      const v = a(c, s);
      return v === undefined ? b(c, s) : v;
    },
    evaluer: ([a, b]) => {
      const v = a();
      return v === undefined ? b() : v;
    },
  },
  ERREUR: {
    libelle: 'Erreur',
    aide: 'Arrête le calcul avec ce message : la saisie ne permet pas de conclure.',
    arite: [1, 4],
    calc: (...morceaux) => {
      throw new Error(morceaux.map(String).join(''));
    },
  },
  NON: { libelle: 'Non', aide: 'Inverse une condition.', arite: [1, 1], calc: (x) => !x },
  RENSEIGNE: {
    libelle: 'Renseigné',
    aide: 'Vrai si la valeur existe (ni vide, ni absente). Zéro est une valeur renseignée.',
    arite: [1, 1],
    calc: (x) => x !== undefined && x !== null,
  },
  DEFINI: {
    libelle: 'Défini',
    aide: 'Vrai si la valeur n’est pas absente. Une valeur explicitement vide compte comme définie.',
    arite: [1, 1],
    calc: (x) => x !== undefined,
  },
  SAISI: {
    libelle: 'Saisi',
    aide: 'Vrai si la case porte une saisie : ni absente, ni vide, ni effacée.',
    arite: [1, 1],
    calc: (x) => x !== undefined && x !== null && x !== '',
  },
  'EST.NOMBRE': {
    libelle: 'Est un nombre',
    aide: 'Vrai si la valeur est un nombre fini.',
    arite: [1, 1],
    calc: (x) => Number.isFinite(x),
  },
  'EST.ENTIER': {
    libelle: 'Est un entier',
    aide: 'Vrai si la valeur est un nombre entier.',
    arite: [1, 1],
    calc: (x) => Number.isInteger(x),
  },

  // --- Nombres ---------------------------------------------------------------
  NOMBRE: {
    libelle: 'Nombre',
    aide: 'Lit une saisie comme un nombre ; une saisie illisible ou vide vaut zéro.',
    arite: [1, 1],
    calc: (x) => Number(x) || 0,
  },
  'NOMBRE.BRUT': {
    libelle: 'Nombre',
    aide: 'Lit une saisie comme un nombre, sans la ramener à zéro si elle est illisible.',
    arite: [1, 1],
    calc: (x) => Number(x),
  },
  ABS: { libelle: 'Valeur absolue', aide: 'La valeur sans son signe.', arite: [1, 1], calc: (x) => Math.abs(x) },
  MIN: {
    libelle: 'Minimum',
    aide: 'La plus petite des valeurs.',
    arite: [2, 8],
    calc: (...v) => Math.min(...v),
  },
  MAX: {
    libelle: 'Maximum',
    aide: 'La plus grande des valeurs.',
    arite: [2, 8],
    calc: (...v) => Math.max(...v),
  },
  ARRONDI: {
    libelle: 'Arrondi',
    aide: 'Arrondi au nombre de décimales indiqué, les demis s’éloignant de zéro (convention d’Excel).',
    arite: [2, 2],
    calc: (x, n) => arrondi(x, n),
  },
  'ARRONDI.EURO': {
    libelle: 'Arrondi à l’euro',
    aide: 'Arrondi à l’euro entier, les demis s’éloignant de zéro.',
    arite: [1, 1],
    calc: (x) => arrondiEuro(x),
  },
  'ARRONDI.MILLIER.SUP': {
    libelle: 'Arrondi au millier supérieur',
    aide: 'Arrondi au millier d’euros supérieur.',
    arite: [1, 1],
    calc: (x) => arrondiMillierSup(x),
  },
  ENT: { libelle: 'Partie entière', aide: 'L’entier inférieur ou égal.', arite: [1, 1], calc: (x) => Math.floor(x) },
  'ENTIER.PROCHE': {
    libelle: 'Entier le plus proche',
    aide: 'L’entier le plus proche, les demis montant.',
    arite: [1, 1],
    calc: (x) => Math.round(x),
  },
  'ENTIER.SUP': {
    libelle: 'Entier supérieur',
    aide: 'L’entier supérieur ou égal.',
    arite: [1, 1],
    calc: (x) => Math.ceil(x),
  },

  // --- Textes ----------------------------------------------------------------
  MAJUSCULE: {
    libelle: 'En majuscules',
    aide: 'Le texte en majuscules, pour comparer sans tenir compte de la casse.',
    arite: [1, 1],
    calc: (x) => String(x ?? '').toUpperCase(),
  },
  'TEXTE.CONTIENT': {
    libelle: 'Contient',
    aide: 'Vrai si le texte contient le motif, sans tenir compte de la casse.',
    arite: [2, 2],
    calc: (x, motif) => String(x ?? '').toLowerCase().includes(String(motif).toLowerCase()),
  },

  // --- Listes ----------------------------------------------------------------
  SUITE: {
    libelle: 'Suite',
    aide: 'Les entiers du premier au dernier, bornes comprises.',
    arite: [2, 2],
    calc: (a, b) => {
      const r = [];
      for (let x = a; x <= b; x++) r.push(x);
      return r;
    },
  },
  INDICES: {
    libelle: 'Rangs',
    aide: 'Les rangs d’une liste saisie : 0, 1, 2…',
    arite: [1, 1],
    calc: (l) => (Array.isArray(l) ? l.map((_, i) => i) : []),
  },
  LONGUEUR: {
    libelle: 'Nombre d’éléments',
    aide: 'Le nombre d’éléments d’une liste.',
    arite: [1, 1],
    calc: (l) => (Array.isArray(l) ? l.length : 0),
  },
  CONTIENT: {
    libelle: 'Figure dans',
    aide: 'Vrai si la valeur figure dans la liste.',
    arite: [2, 2],
    calc: (l, x) => Array.isArray(l) && l.includes(x),
  },
  ELEMENT: {
    libelle: 'Élément',
    aide: 'L’élément de la liste au rang indiqué, le premier étant au rang 0.',
    arite: [2, 2],
    calc: (l, i) => (Array.isArray(l) ? l[i] : undefined),
  },
  UNIQUES: {
    libelle: 'Sans doublon',
    aide: 'La liste sans ses doublons, dans l’ordre de première apparition.',
    arite: [1, 1],
    calc: (l) => (Array.isArray(l) ? [...new Set(l)] : []),
  },
  CONCATENER: {
    libelle: 'Mis bout à bout',
    aide: 'Les listes mises bout à bout, dans l’ordre.',
    arite: [2, 8],
    calc: (...listes) => listes.flatMap((l) => (Array.isArray(l) ? l : [])),
  },
  VALEURS: {
    libelle: 'Valeurs',
    aide: 'Les valeurs d’une saisie par tranche, dans l’ordre où elles ont été saisies.',
    arite: [1, 1],
    calc: (o) => (o && typeof o === 'object' ? Object.values(o) : []),
  },
  CLES: {
    libelle: 'Clés',
    aide: 'Les tranches d’une saisie par tranche, dans l’ordre où elles ont été saisies.',
    arite: [1, 1],
    calc: (o) => (o && typeof o === 'object' ? Object.keys(o) : []),
  },

  // --- Dates -----------------------------------------------------------------
  'AJOUTER.MOIS': {
    libelle: 'Décaler de mois',
    aide: 'La date décalée d’un nombre de mois, en calendaire : un 31 janvier plus un mois tombe le dernier jour de février.',
    arite: [2, 2],
    calc: (d, n) => decalerMois(d, n),
  },
  'AJOUTER.JOURS': {
    libelle: 'Décaler de jours',
    aide: 'La date décalée d’un nombre de jours.',
    arite: [2, 2],
    calc: (d, n) => versISO(jourUTC(d) + n),
  },
  DATE: {
    libelle: 'Date',
    aide: 'La date au format AAAA-MM-JJ.',
    arite: [1, 1],
    calc: (d) => versISO(jourUTC(d)),
  },
  ANNEE: {
    libelle: 'Année',
    aide: 'L’année civile d’une date.',
    arite: [1, 1],
    calc: (d) => Number(String(d).slice(0, 4)),
  },
  JOURS: {
    libelle: 'Rang du jour',
    aide: 'Le nombre de jours écoulés depuis le 1er janvier 1970 : la différence de deux rangs donne une durée en jours.',
    arite: [1, 1],
    calc: (d) => jourUTC(d),
  },

  // --- Metier ----------------------------------------------------------------
  INDEXATION: {
    libelle: 'Indexation',
    aide: 'Le produit des (1 + taux) d’une trajectoire, de l’année suivant le départ jusqu’à l’année visée. Une année absente reconduit le dernier taux connu ; un taux unique s’applique en puissance.',
    arite: [3, 3],
    calc: (trajectoire, debut, annee) => facteurIndexation(trajectoire ?? 0, debut, annee),
  },
  'RECHERCHE.ANNEE': {
    libelle: 'Valeur de l’année',
    aide: 'La valeur d’une table annuelle pour l’année visée ; à défaut, celle de la dernière année antérieure ; à défaut, la valeur indiquée.',
    arite: [3, 3],
    calc: (table, annee, defaut) => rechercheAnnee(table, annee, defaut),
  },
};

/**
 * @typedef {Object} DefAgregat
 * @property {string} libelle
 * @property {string} aide
 * @property {[number, number]} [arite]  arguments en plus du corps
 * @property {() => any} [init]
 * @property {(acc: any, v: any) => any} [ajouter]
 * @property {(acc: any) => any} [fin]
 * @property {(acc: any) => boolean} [arret]  vrai : le parcours peut s'arreter
 * @property {boolean} [sansCorps]            le corps n'est pas evalue (NB)
 * @property {'repartir'|'tri'} [special]
 */

/** @type {Record<string, DefAgregat>} */
export const AGREGATS = {
  SOMME: {
    libelle: 'Somme',
    aide: 'La somme des valeurs, dans l’ordre du parcours.',
    init: () => 0,
    ajouter: (a, v) => a + v,
  },
  PRODUIT: {
    libelle: 'Produit',
    aide: 'Le produit des valeurs, dans l’ordre du parcours.',
    init: () => 1,
    ajouter: (a, v) => a * v,
  },
  NB: {
    libelle: 'Nombre',
    aide: 'Le nombre d’éléments parcourus qui remplissent la condition.',
    sansCorps: true,
    init: () => 0,
    ajouter: (a) => a + 1,
  },
  MIN: {
    libelle: 'Minimum',
    aide: 'La plus petite des valeurs parcourues.',
    init: () => Infinity,
    ajouter: (a, v) => Math.min(a, v),
  },
  MAX: {
    libelle: 'Maximum',
    aide: 'La plus grande des valeurs parcourues.',
    init: () => -Infinity,
    ajouter: (a, v) => Math.max(a, v),
  },
  MOYENNE: {
    libelle: 'Moyenne',
    aide: 'La moyenne des valeurs parcourues ; vide s’il n’y en a aucune.',
    init: () => ({ s: 0, n: 0 }),
    ajouter: (a, v) => {
      a.s += v;
      a.n += 1;
      return a;
    },
    fin: (a) => (a.n ? a.s / a.n : null),
  },
  PREMIER: {
    libelle: 'Premier',
    aide: 'La valeur du premier élément qui remplit la condition ; vide s’il n’y en a aucun.',
    init: () => ({ trouve: false, v: null }),
    ajouter: (a, v) => (a.trouve ? a : { trouve: true, v }),
    arret: (a) => a.trouve,
    fin: (a) => a.v,
  },
  DERNIER: {
    libelle: 'Dernier',
    aide: 'La valeur du dernier élément qui remplit la condition ; vide s’il n’y en a aucun.',
    init: () => null,
    ajouter: (_a, v) => v,
  },
  TOUS: {
    libelle: 'Tous',
    aide: 'Vrai si la condition est vraie pour chaque élément.',
    init: () => true,
    ajouter: (a, v) => a && Boolean(v),
    arret: (a) => !a,
  },
  UN: {
    libelle: 'Au moins un',
    aide: 'Vrai si la condition est vraie pour au moins un élément.',
    init: () => false,
    ajouter: (a, v) => a || Boolean(v),
    arret: (a) => a,
  },
  LISTE: {
    libelle: 'Liste',
    aide: 'La liste des valeurs parcourues.',
    init: () => [],
    ajouter: (a, v) => {
      a.push(v);
      return a;
    },
  },
  REPARTIR: {
    libelle: 'Répartition sans perte',
    aide: 'Arrondit chaque part à l’euro de sorte que les parts totalisent exactement le total (méthode du plus grand reste). Rend la part de l’élément courant.',
    arite: [0, 1],
    special: 'repartir',
  },
  TRI: {
    libelle: 'Taux de rentabilité interne',
    aide: 'Le taux qui annule la valeur actuelle des flux, le flux initial en premier. Résolu par dichotomie ; vide si les flux ne changent jamais de signe.',
    arite: [1, 1],
    special: 'tri',
  },
};

export { arrondirEnConservantLaSomme };
