// @ts-check
/**
 * LE CLASSEUR : ce qui fait tourner les formules.
 *
 * Un MODELE est l'ensemble des grandeurs declarees - leur libelle, leur unite,
 * leur regle et leur formule - et des dimensions sur lesquelles elles se
 * declinent (tranche, lot, pret, annee...). Il ne depend d'aucune operation.
 *
 * Un CLASSEUR est ce modele applique a UNE operation : ses entrees, ses baremes
 * et ses trajectoires. Il calcule a la demande, chaque cellule une seule fois
 * (memoisation), et sait dire pour chacune d'ou elle vient (`expliquer`).
 *
 * Le calcul est PARESSEUX : une grandeur n'est evaluee que si quelqu'un la lit.
 * C'est ce qui donne son sens a `SI` - la branche ecartee n'est jamais calculee -
 * et ce qui rend le moteur aussi rapide qu'un code ecrit a la main : on ne paie
 * que ce qu'on consulte.
 *
 * DIMENSIONS
 *
 * Une grandeur declaree `sur: ['tranche']` est une famille de cellules, une par
 * tranche. Dans sa formule, toute grandeur de la meme dimension se lit
 * implicitement pour la meme tranche : `su_tranche / su_totale` n'a pas besoin
 * de dire « de cette tranche ». Pour lire une AUTRE valeur de la dimension, on
 * la nomme : `crd[annee_pret: annee_pret - 1]`. Une valeur hors de la dimension
 * rend INDEFINI plutot que de calculer une cellule qui n'existe pas.
 *
 * Une dimension a une liste de valeurs, elle-meme calculee par une formule -
 * les tranches presentes se deduisent des lots. Elle peut dependre d'une autre
 * dimension : les annees d'un pret dependent du pret. Une dimension sans liste
 * est LIBRE : toute valeur y est admise, elle sert aux lectures de tables.
 *
 * FORCAGE
 *
 * `fixer` pose une valeur dans une cellule avant tout calcul : la formule de
 * cette cellule n'est alors plus lue. C'est ce qui permet de reutiliser une
 * partie du modele hors d'une operation complete - calculer un tableau
 * d'amortissement a partir d'un montant donne, sans plan de financement.
 */
import { analyser } from './langage.js';
import { FONCTIONS, AGREGATS, tauxRentabiliteInterne, arrondirEnConservantLaSomme } from './fonctions.js';

/** Valeur memorisee `undefined` : une Map rend deja undefined pour « absent ». */
const INDEFINI_MEMO = Symbol('indefini');
/** Cellule en cours de calcul : la relire signale une dependance circulaire. */
const EN_COURS = Symbol('en cours');

/** Operateurs binaires, partages par l'evaluation compilee et l'explication. */
const OPERATIONS = /** @type {Record<string, (a: any, b: any) => any>} */ ({
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '^': (a, b) => a ** b,
  '=': (a, b) => a === b,
  '<>': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
});

/**
 * @typedef {Object} DefGrandeur
 * @property {string} libelle
 * @property {string} [unite]      'eur', 'm2', 'eur_m2_mois', 'taux', 'annee', 'date', 'nombre', 'texte'...
 * @property {string} [regle]      identifiant R-xxx du dictionnaire
 * @property {string[]} [sur]      dimensions
 * @property {string} [formule]    texte de la formule
 * @property {string} [saisie]     chemin dans les entrees, ex. 'lots[lot].shab_m2'
 * @property {string} [parametre]  chemin dans les baremes effectifs
 * @property {string} [trajectoire] chemin dans les trajectoires normalisees
 * @property {(ctx: any, ...indices: any[]) => any} [lire] lecture sur mesure (une donnee, pas un calcul)
 * @property {any} [constante]
 * @property {string} [ecran]      ou la valeur se regle, pour une saisie ou un parametre
 * @property {string} [note]       precision courte, affichee sous le libelle
 */

/**
 * @typedef {Object} DefDimension
 * @property {string} libelle
 * @property {string[]} [sur]        dimensions dont depend la liste des valeurs
 * @property {string} [valeurs]      formule rendant la liste des valeurs
 * @property {(ctx: any, ...indices: any[]) => any} [lire]
 * @property {string} [etiquette]    grandeur donnant le libelle d'une valeur
 */

/**
 * @typedef {Object} Domaine
 * @property {string} domaine
 * @property {string} [titre]
 * @property {Record<string, DefGrandeur>} [grandeurs]
 * @property {Record<string, DefDimension>} [dimensions]
 */

/**
 * Assemble un modele a partir de ses domaines.
 * @param {Domaine[]} domaines
 */
export function creerModele(domaines) {
  /** @type {Map<string, any>} */
  const grandeurs = new Map();
  /** @type {Map<string, any>} */
  const dimensions = new Map();
  /** @type {Array<{domaine: string, titre: string}>} */
  const ordreDomaines = [];

  for (const d of domaines) {
    ordreDomaines.push({ domaine: d.domaine, titre: d.titre ?? d.domaine });
    for (const [nom, def] of Object.entries(d.dimensions ?? {})) {
      if (dimensions.has(nom)) throw new Error(`Dimension « ${nom} » declaree deux fois`);
      dimensions.set(nom, { nom, domaine: d.domaine, ...def, sur: def.sur ?? [] });
    }
    for (const [id, def] of Object.entries(d.grandeurs ?? {})) {
      if (grandeurs.has(id)) throw new Error(`Grandeur « ${id} » declaree deux fois`);
      grandeurs.set(id, { id, domaine: d.domaine, ...def, sur: def.sur ?? [] });
    }
  }

  // Chaque dimension devient une grandeur cachee `@nom` : la liste de ses
  // valeurs. Elle se calcule, se memorise et se force comme les autres.
  for (const dim of dimensions.values()) {
    if (grandeurs.has(dim.nom)) throw new Error(`« ${dim.nom} » nomme a la fois une dimension et une grandeur`);
    const id = `@${dim.nom}`;
    const g = {
      id,
      cachee: true,
      domaine: dim.domaine,
      libelle: `Valeurs de la dimension « ${dim.libelle ?? dim.nom} »`,
      sur: dim.sur,
      unite: 'liste',
    };
    if (dim.valeurs !== undefined) g.formule = dim.valeurs;
    else if (dim.lire) g.lire = dim.lire;
    else {
      // Dimension LIBRE : elle n'a pas de liste, toute valeur y est admise. Sa
      // grandeur cachee existe pour la forme, et ne rend rien.
      dim.libre = true;
      g.constante = undefined;
    }
    grandeurs.set(id, g);
    dim.grandeur = g;
  }

  let num = 0;
  for (const g of grandeurs.values()) g.num = num++;

  const modele = {
    grandeurs,
    dimensions,
    domaines: ordreDomaines,
    taille: num,
    /** @param {string} id */
    grandeur(id) {
      const g = grandeurs.get(id);
      if (!g) throw new Error(`Grandeur inconnue : ${id}`);
      return g;
    },
  };
  return modele;
}

/**
 * Compile une grandeur a sa premiere lecture. Une formule fausse ne se revele
 * donc qu'a l'usage - d'ou le test qui compile tout le modele d'un coup.
 * @param {any} modele
 * @param {any} g
 */
export function compilerGrandeur(modele, g) {
  if (g.f) return g;
  for (const d of g.sur) {
    const dim = modele.dimensions.get(d);
    if (!dim) throw new Error(`${g.id} : dimension inconnue « ${d} »`);
    for (const p of dim.sur) {
      if (g.sur.indexOf(p) < 0 || g.sur.indexOf(p) > g.sur.indexOf(d)) {
        throw new Error(`${g.id} : la dimension « ${d} » depend de « ${p} », qui doit la preceder`);
      }
    }
  }
  const ctx = { modele, g, taille: g.sur.length };
  if (g.formule !== undefined) {
    g.ast = analyser(g.formule);
    g.f = compiler(ctx, g.ast, g.sur.slice());
  } else if (g.saisie !== undefined || g.parametre !== undefined || g.trajectoire !== undefined) {
    g.f = compilerChemin(g);
  } else if (g.lire) {
    const lire = g.lire;
    const n = g.sur.length;
    g.f =
      n === 0
        ? (c) => lire(c.contexte)
        : n === 1
          ? (c, s) => lire(c.contexte, s[0])
          : (c, s) => lire(c.contexte, ...s.slice(0, n));
  } else if ('constante' in g) {
    const v = g.constante;
    g.f = () => v;
  } else {
    throw new Error(`${g.id} : ni formule, ni saisie, ni parametre, ni lecture`);
  }
  g.taille = ctx.taille;
  return g;
}

/**
 * Chemin d'une donnee : `lots[lot].shab_m2`. Les crochets designent une
 * dimension de la grandeur, remplacee par sa valeur courante.
 * @param {string} chemin
 * @param {string[]} sur
 * @returns {Array<{cle?: string, k?: number}>}
 */
function segmentsChemin(chemin, sur) {
  const segments = [];
  for (const brut of chemin.split('.')) {
    const m = /^([^[\]]*)((?:\[[^\]]+\])*)$/.exec(brut);
    if (!m) throw new Error(`Chemin illisible : ${chemin}`);
    if (m[1]) segments.push({ cle: m[1] });
    for (const [, dim] of m[2].matchAll(/\[([^\]]+)\]/g)) {
      const k = sur.indexOf(dim);
      if (k < 0) throw new Error(`Chemin ${chemin} : « ${dim} » n'est pas une dimension de la grandeur`);
      segments.push({ k });
    }
  }
  return segments;
}

/** @param {any} g */
function compilerChemin(g) {
  const [racine, chemin] =
    g.saisie !== undefined
      ? ['entrees', g.saisie]
      : g.parametre !== undefined
        ? ['baremes', g.parametre]
        : ['trajectoires', g.trajectoire];
  const segments = segmentsChemin(chemin, g.sur);
  g.segments = segments;
  g.racine = racine;
  return (c, s) => {
    let o = c.contexte[racine];
    for (const seg of segments) {
      if (o === undefined || o === null) return undefined;
      o = o[seg.cle !== undefined ? seg.cle : s[/** @type {number} */ (seg.k)]];
    }
    return o;
  };
}

/**
 * Compile un noeud en fermeture `(classeur, portee) => valeur`. La portee est
 * un tableau : d'abord les indices de la grandeur, puis une case par variable
 * d'agregat ouverte. Chaque nom est resolu ICI, une fois pour toutes, en une
 * position de ce tableau : l'evaluation ne cherche jamais un nom.
 * @param {{modele: any, g: any, taille: number}} ctx
 * @param {import('./langage.js').Noeud} n
 * @param {string[]} noms  noms lies, dans l'ordre des cases de la portee
 * @returns {(c: any, s: any[]) => any}
 */
function compiler(ctx, n, noms) {
  switch (n.t) {
    case 'nb':
    case 'txt':
    case 'cst': {
      const v = n.v;
      return () => v;
    }
    case 'neg': {
      const a = compiler(ctx, n.a, noms);
      return (c, s) => -a(c, s);
    }
    case 'bin': {
      const a = compiler(ctx, n.a, noms);
      const b = compiler(ctx, n.b, noms);
      switch (n.op) {
        case '+': return (c, s) => a(c, s) + b(c, s);
        case '-': return (c, s) => a(c, s) - b(c, s);
        case '*': return (c, s) => a(c, s) * b(c, s);
        case '/': return (c, s) => a(c, s) / b(c, s);
        case '^': return (c, s) => a(c, s) ** b(c, s);
        case '=': return (c, s) => a(c, s) === b(c, s);
        case '<>': return (c, s) => a(c, s) !== b(c, s);
        case '<': return (c, s) => a(c, s) < b(c, s);
        case '<=': return (c, s) => a(c, s) <= b(c, s);
        case '>': return (c, s) => a(c, s) > b(c, s);
        case '>=': return (c, s) => a(c, s) >= b(c, s);
        default: throw new Error(`Operateur inconnu : ${n.op}`);
      }
    }
    case 'nom':
      return compilerNom(ctx, n, noms);
    case 'fn': {
      const def = FONCTIONS[n.nom];
      if (!def) throw new Error(`${ctx.g.id} : fonction inconnue ${n.nom}`);
      const [mini, maxi] = def.arite;
      if (n.args.length < mini || n.args.length > maxi) {
        throw new Error(`${ctx.g.id} : ${n.nom} attend de ${mini} a ${maxi} arguments, ${n.args.length} donnes`);
      }
      const args = n.args.map((a) => compiler(ctx, a, noms));
      if (def.compiler) return def.compiler(args);
      const calc = /** @type {(...v: any[]) => any} */ (def.calc);
      if (args.length === 1) {
        const [a] = args;
        return (c, s) => calc(a(c, s));
      }
      if (args.length === 2) {
        const [a, b] = args;
        return (c, s) => calc(a(c, s), b(c, s));
      }
      if (args.length === 3) {
        const [a, b, d] = args;
        return (c, s) => calc(a(c, s), b(c, s), d(c, s));
      }
      return (c, s) => calc(...args.map((a) => a(c, s)));
    }
    case 'agr':
      return compilerAgregat(ctx, n, noms);
    default:
      throw new Error(`Noeud inconnu : ${/** @type {any} */ (n).t}`);
  }
}

/**
 * Un nom : variable liee, ou grandeur. Une grandeur se lit aux indices de la
 * portee courante pour chacune de ses dimensions, sauf celles que la formule
 * nomme explicitement entre crochets.
 * @param {{modele: any, g: any, taille: number}} ctx
 * @param {import('./langage.js').NoeudNom} n
 * @param {string[]} noms
 */
function compilerNom(ctx, n, noms) {
  if (!n.index) {
    const k = noms.lastIndexOf(n.nom);
    if (k >= 0) return (_c, s) => s[k];
  }
  const cible = ctx.modele.grandeurs.get(n.nom);
  if (!cible) {
    if (ctx.modele.dimensions.has(n.nom)) {
      throw new Error(`${ctx.g.id} : la dimension « ${n.nom} » n'est pas liee a cet endroit de la formule`);
    }
    throw new Error(`${ctx.g.id} : « ${n.nom} » n'est ni une grandeur, ni une variable`);
  }
  const explicites = new Map((n.index ?? []).map((i) => [i.dim, compiler(ctx, i.expr, noms)]));
  for (const d of explicites.keys()) {
    if (!cible.sur.includes(d)) throw new Error(`${ctx.g.id} : ${cible.id} n'a pas de dimension « ${d} »`);
  }
  /** @type {Array<{f?: (c: any, s: any[]) => any, k?: number}>} */
  const acces = cible.sur.map((d) => {
    const f = explicites.get(d);
    if (f) return { f };
    const k = noms.lastIndexOf(d);
    if (k < 0) {
      throw new Error(
        `${ctx.g.id} : la lecture de ${cible.id} demande la dimension « ${d} », qui n'est pas liee ici`,
      );
    }
    return { k };
  });

  if (!explicites.size) {
    if (acces.length === 0) return (c) => c.v0(cible);
    if (acces.length === 1) {
      const k = /** @type {number} */ (acces[0].k);
      return (c, s) => c.v1(cible, s[k]);
    }
    if (acces.length === 2) {
      const k0 = /** @type {number} */ (acces[0].k);
      const k1 = /** @type {number} */ (acces[1].k);
      return (c, s) => c.v2(cible, s[k0], s[k1]);
    }
    const ks = acces.map((a) => /** @type {number} */ (a.k));
    return (c, s) => c.vn(cible, ks.map((k) => s[k]));
  }

  // Indices explicites : la valeur demandee doit appartenir a la dimension,
  // sinon la cellule n'existe pas. `crd[annee_pret: annee_pret - 1]` la premiere
  // annee d'un pret designe une annee hors du pret : INDEFINI, et non un calcul
  // qui remonterait les annees sans fin.
  const aVerifier = cible.sur
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => explicites.has(d) && !ctx.modele.dimensions.get(d).libre)
    .map(({ d, i }) => ({
      dim: ctx.modele.dimensions.get(d),
      i,
      parents: ctx.modele.dimensions.get(d).sur.map((p) => cible.sur.indexOf(p)),
    }));
  return (c, s) => {
    const idx = acces.map((a) => (a.f ? a.f(c, s) : s[/** @type {number} */ (a.k)]));
    for (const v of aVerifier) {
      if (!c.appartient(v.dim, idx[v.i], v.parents.map((p) => idx[p]))) return undefined;
    }
    return c.vn(cible, idx);
  };
}

/**
 * Source d'un niveau d'agregat : la liste parcourue. Soit l'expression DANS,
 * soit les valeurs de la dimension qui porte le nom de la variable.
 * @param {{modele: any, g: any}} ctx
 * @param {import('./langage.js').Parcours} n
 * @param {string[]} noms
 */
function compilerSource(ctx, n, noms) {
  if (n.dans) return compiler(ctx, n.dans, noms);
  const dim = ctx.modele.dimensions.get(n.variable);
  if (!dim) {
    throw new Error(`${ctx.g.id} : POUR ${n.variable} - ni une dimension, ni suivi de DANS`);
  }
  if (dim.libre) throw new Error(`${ctx.g.id} : la dimension libre « ${n.variable} » ne se parcourt pas`);
  const parents = dim.sur.map((p) => {
    const k = noms.lastIndexOf(p);
    if (k < 0) throw new Error(`${ctx.g.id} : parcourir « ${n.variable} » demande « ${p} », non lie ici`);
    return k;
  });
  const g = dim.grandeur;
  if (parents.length === 0) return (c) => c.v0(g);
  if (parents.length === 1) {
    const [k] = parents;
    return (c, s) => c.v1(g, s[k]);
  }
  return (c, s) => c.vn(g, parents.map((k) => s[k]));
}

/**
 * @param {{modele: any, g: any, taille: number}} ctx
 * @param {import('./langage.js').NoeudAgregat} n
 * @param {string[]} noms
 */
function compilerAgregat(ctx, n, noms) {
  const def = AGREGATS[n.nom];
  if (!def) throw new Error(`${ctx.g.id} : ${n.nom} ne peut pas porter POUR`);
  const [mini, maxi] = def.arite ?? [0, 0];
  if (n.args.length < mini || n.args.length > maxi) {
    throw new Error(`${ctx.g.id} : ${n.nom} attend de ${mini} a ${maxi} arguments apres le corps`);
  }
  if (def.special && n.parcours.length !== 1) {
    throw new Error(`${ctx.g.id} : ${n.nom} ne parcourt qu'une seule variable`);
  }
  // Un niveau par POUR : chacun ouvre une case de la portee, et sa condition
  // QUAND voit les variables des niveaux qui le precedent.
  /** @type {Array<{source: (c: any, s: any[]) => any, k: number, quand: ((c: any, s: any[]) => any)|null}>} */
  const niveaux = [];
  let portee = noms;
  for (const p of n.parcours) {
    const source = compilerSource(ctx, p, portee);
    const k = portee.length;
    portee = [...portee, p.variable];
    ctx.taille = Math.max(ctx.taille, k + 1);
    niveaux.push({ source, k, quand: p.quand ? compiler(ctx, p.quand, portee) : null });
  }
  const corps = compiler(ctx, n.corps, portee);
  const args = n.args.map((a) => compiler(ctx, a, noms));
  const [{ source, k, quand }] = niveaux;

  if (def.special === 'repartir') {
    // La part de l'element COURANT : la variable doit donc deja etre liee a
    // l'exterieur, et la repartition se calcule pour toutes ses valeurs a la
    // fois - une seule fois par cellule exterieure, grace au cache.
    const variable = n.parcours[0].variable;
    const kExterieur = noms.lastIndexOf(variable);
    if (kExterieur < 0) {
      throw new Error(`${ctx.g.id} : REPARTIR(… POUR ${variable}) doit etre ecrit dans une grandeur sur « ${variable} »`);
    }
    const [total] = args;
    return (c, s) => {
      const cle = cleExterieure(s, k, kExterieur);
      const cache = c.cacheNoeud(n);
      let parts = cache.get(cle);
      if (!parts) {
        const liste = source(c, s);
        const valeurs = [];
        for (let i = 0; i < liste.length; i++) {
          s[k] = liste[i];
          if (quand && !quand(c, s)) continue;
          valeurs.push([liste[i], corps(c, s)]);
        }
        const entiers = arrondirEnConservantLaSomme(
          valeurs.map((x) => x[1]),
          total ? total(c, s) : undefined,
        );
        parts = new Map(valeurs.map((x, i) => [x[0], entiers[i]]));
        cache.set(cle, parts);
      }
      return parts.get(s[kExterieur]);
    };
  }

  if (def.special === 'tri') {
    const [initial] = args;
    return (c, s) => {
      const liste = source(c, s);
      const flux = [initial(c, s)];
      for (let i = 0; i < liste.length; i++) {
        s[k] = liste[i];
        if (quand && !quand(c, s)) continue;
        flux.push(corps(c, s));
      }
      return tauxRentabiliteInterne(flux);
    };
  }

  const init = /** @type {() => any} */ (def.init);
  const ajouter = /** @type {(a: any, v: any) => any} */ (def.ajouter);
  const { fin, arret, sansCorps } = def;
  if (niveaux.length === 1) {
    return (c, s) => {
      const liste = source(c, s);
      let acc = init();
      for (let i = 0; i < liste.length; i++) {
        s[k] = liste[i];
        if (quand && !quand(c, s)) continue;
        acc = ajouter(acc, sansCorps ? null : corps(c, s));
        if (arret && arret(acc)) break;
      }
      return fin ? fin(acc) : acc;
    };
  }
  // Boucles imbriquees, un seul accumulateur.
  return (c, s) => {
    let acc = init();
    let arrete = false;
    /** @param {number} i */
    const parcourir = (i) => {
      if (i === niveaux.length) {
        acc = ajouter(acc, sansCorps ? null : corps(c, s));
        if (arret && arret(acc)) arrete = true;
        return;
      }
      const niveau = niveaux[i];
      const liste = niveau.source(c, s);
      for (let j = 0; j < liste.length && !arrete; j++) {
        s[niveau.k] = liste[j];
        if (niveau.quand && !niveau.quand(c, s)) continue;
        parcourir(i + 1);
      }
    };
    parcourir(0);
    return fin ? fin(acc) : acc;
  };
}

/**
 * Cle des cases exterieures d'une portee, sauf celle qu'on repartit.
 * @param {any[]} s
 * @param {number} k        nombre de cases exterieures
 * @param {number} exclue
 */
function cleExterieure(s, k, exclue) {
  let cle = '';
  for (let i = 0; i < k; i++) if (i !== exclue) cle += `${typeof s[i]}:${s[i]}`;
  return cle;
}

/**
 * Lit ou cree une case de memoire imbriquee.
 * @param {Map<any, any>} racine
 * @param {any[]} idx
 */
function feuilleMemoire(racine, idx) {
  let m = racine;
  for (let i = 0; i < idx.length - 1; i++) {
    let suivante = m.get(idx[i]);
    if (suivante === undefined) m.set(idx[i], (suivante = new Map()));
    m = suivante;
  }
  return m;
}

export class Classeur {
  /**
   * @param {any} modele
   * @param {{entrees?: any, baremes?: any, trajectoires?: any, [cle: string]: any}} contexte
   */
  constructor(modele, contexte) {
    this.modele = modele;
    this.contexte = contexte;
    /** @type {any[]} */
    this.memoire = new Array(modele.taille);
    /** @type {Map<any, Map<string, any>>} */
    this.caches = new Map();
    /** @type {WeakMap<any[], Set<any>>} */
    this.ensembles = new WeakMap();
  }

  /** @param {any} n */
  cacheNoeud(n) {
    let m = this.caches.get(n);
    if (!m) this.caches.set(n, (m = new Map()));
    return m;
  }

  /**
   * @param {any} g
   * @param {any[]} idx
   */
  cycle(g, idx) {
    return new Error(`Dependance circulaire sur ${g.id}${idx.length ? `[${idx.join(', ')}]` : ''}`);
  }

  /** @param {any} g */
  v0(g) {
    const m = this.memoire[g.num];
    if (m !== undefined) {
      if (m === EN_COURS) throw this.cycle(g, []);
      return m === INDEFINI_MEMO ? undefined : m;
    }
    if (!g.f) compilerGrandeur(this.modele, g);
    this.memoire[g.num] = EN_COURS;
    let v;
    try {
      v = g.f(this, new Array(g.taille));
    } catch (e) {
      this.memoire[g.num] = undefined;
      throw e;
    }
    this.memoire[g.num] = v === undefined ? INDEFINI_MEMO : v;
    return v;
  }

  /**
   * @param {any} g
   * @param {any} a
   */
  v1(g, a) {
    let map = this.memoire[g.num];
    if (map === undefined) this.memoire[g.num] = map = new Map();
    const m = map.get(a);
    if (m !== undefined) {
      if (m === EN_COURS) throw this.cycle(g, [a]);
      return m === INDEFINI_MEMO ? undefined : m;
    }
    if (!g.f) compilerGrandeur(this.modele, g);
    map.set(a, EN_COURS);
    const s = new Array(g.taille);
    s[0] = a;
    let v;
    try {
      v = g.f(this, s);
    } catch (e) {
      map.delete(a);
      throw e;
    }
    map.set(a, v === undefined ? INDEFINI_MEMO : v);
    return v;
  }

  /**
   * @param {any} g
   * @param {any} a
   * @param {any} b
   */
  v2(g, a, b) {
    let map = this.memoire[g.num];
    if (map === undefined) this.memoire[g.num] = map = new Map();
    let sous = map.get(a);
    if (sous === undefined) map.set(a, (sous = new Map()));
    const m = sous.get(b);
    if (m !== undefined) {
      if (m === EN_COURS) throw this.cycle(g, [a, b]);
      return m === INDEFINI_MEMO ? undefined : m;
    }
    if (!g.f) compilerGrandeur(this.modele, g);
    sous.set(b, EN_COURS);
    const s = new Array(g.taille);
    s[0] = a;
    s[1] = b;
    let v;
    try {
      v = g.f(this, s);
    } catch (e) {
      sous.delete(b);
      throw e;
    }
    sous.set(b, v === undefined ? INDEFINI_MEMO : v);
    return v;
  }

  /**
   * @param {any} g
   * @param {any[]} idx
   */
  vn(g, idx) {
    if (idx.length === 0) return this.v0(g);
    if (idx.length === 1) return this.v1(g, idx[0]);
    if (idx.length === 2) return this.v2(g, idx[0], idx[1]);
    let racine = this.memoire[g.num];
    if (racine === undefined) this.memoire[g.num] = racine = new Map();
    const feuille = feuilleMemoire(racine, idx);
    const derniere = idx[idx.length - 1];
    const m = feuille.get(derniere);
    if (m !== undefined) {
      if (m === EN_COURS) throw this.cycle(g, idx);
      return m === INDEFINI_MEMO ? undefined : m;
    }
    if (!g.f) compilerGrandeur(this.modele, g);
    feuille.set(derniere, EN_COURS);
    const s = new Array(g.taille);
    for (let i = 0; i < idx.length; i++) s[i] = idx[i];
    let v;
    try {
      v = g.f(this, s);
    } catch (e) {
      feuille.delete(derniere);
      throw e;
    }
    feuille.set(derniere, v === undefined ? INDEFINI_MEMO : v);
    return v;
  }

  /**
   * Vrai si la valeur appartient a la dimension (pour ces valeurs de ses parents).
   * @param {any} dim
   * @param {any} valeur
   * @param {any[]} parents
   */
  appartient(dim, valeur, parents) {
    const liste = this.vn(dim.grandeur, parents);
    if (!Array.isArray(liste)) return false;
    let ensemble = this.ensembles.get(liste);
    if (!ensemble) this.ensembles.set(liste, (ensemble = new Set(liste)));
    return ensemble.has(valeur);
  }

  /**
   * Indices d'une grandeur, dans l'ordre de ses dimensions.
   * @param {any} g
   * @param {Record<string, any>} indices
   */
  indicesDe(g, indices) {
    return g.sur.map((d) => {
      if (!(d in indices)) throw new Error(`${g.id} : indice « ${d} » manquant`);
      return indices[d];
    });
  }

  /**
   * Valeur d'une cellule.
   * @param {string} id
   * @param {Record<string, any>} [indices]
   */
  valeur(id, indices = {}) {
    const g = this.modele.grandeur(id);
    return this.vn(g, this.indicesDe(g, indices));
  }

  /**
   * Valeurs d'une dimension.
   * @param {string} nom
   * @param {Record<string, any>} [parents]
   * @returns {any[]}
   */
  valeursDimension(nom, parents = {}) {
    const dim = this.modele.dimensions.get(nom);
    if (!dim) throw new Error(`Dimension inconnue : ${nom}`);
    return this.vn(dim.grandeur, this.indicesDe(dim.grandeur, parents)) ?? [];
  }

  /**
   * Pose une valeur dans une cellule : sa formule ne sera pas lue.
   * @param {string} id
   * @param {Record<string, any>} indices
   * @param {any} valeur
   */
  fixer(id, indices, valeur) {
    const g = this.modele.grandeur(id);
    const idx = this.indicesDe(g, indices);
    const v = valeur === undefined ? INDEFINI_MEMO : valeur;
    if (idx.length === 0) {
      this.memoire[g.num] = v;
      return this;
    }
    let racine = this.memoire[g.num];
    if (racine === undefined) this.memoire[g.num] = racine = new Map();
    feuilleMemoire(racine, idx).set(idx[idx.length - 1], v);
    return this;
  }

  /**
   * Pose la liste des valeurs d'une dimension.
   * @param {string} nom
   * @param {any[]} valeurs
   * @param {Record<string, any>} [parents]
   */
  fixerDimension(nom, valeurs, parents = {}) {
    return this.fixer(`@${nom}`, parents, valeurs);
  }

  /**
   * Libelle d'une valeur de dimension, pour l'ecran.
   * @param {string} nom
   * @param {any} valeur
   * @param {Record<string, any>} [parents]
   */
  etiquette(nom, valeur, parents = {}) {
    const dim = this.modele.dimensions.get(nom);
    if (dim?.etiquette) {
      try {
        const v = this.valeur(dim.etiquette, { ...parents, [nom]: valeur });
        if (v !== undefined && v !== null && v !== '') return String(v);
      } catch {
        // Une etiquette qui ne se calcule pas n'empeche pas d'afficher la valeur.
      }
    }
    return String(valeur);
  }

  /**
   * EXPLICATION d'une cellule : sa formule, et la valeur de chaque bloc.
   *
   * Rejoue la formule en suivant le MEME chemin que le calcul - memes branches,
   * memes termes - mais en gardant trace de chaque etape. Les grandeurs citees
   * ne sont pas recalculees : elles sont lues dans la memoire du classeur, et
   * portent de quoi les expliquer a leur tour.
   *
   * @param {string} id
   * @param {Record<string, any>} [indices]
   */
  expliquer(id, indices = {}) {
    const g = this.modele.grandeur(id);
    if (!g.f) compilerGrandeur(this.modele, g);
    const idx = this.indicesDe(g, indices);
    const v = this.vn(g, idx);
    const base = {
      id,
      libelle: g.libelle,
      unite: g.unite ?? null,
      regle: g.regle ?? null,
      domaine: g.domaine,
      note: g.note ?? null,
      sur: g.sur,
      indices: Object.fromEntries(g.sur.map((d, i) => [d, idx[i]])),
      v,
    };
    if (g.formule !== undefined) {
      return {
        ...base,
        nature: 'formule',
        formule: g.formule,
        arbre: tracer(this, g, g.ast, g.sur.slice(), idx.slice()),
      };
    }
    if (g.segments) {
      const chemin = g.segments
        .map((seg) => (seg.cle !== undefined ? seg.cle : `[${idx[seg.k]}]`))
        .join('.')
        .replace(/\.\[/g, '[');
      return {
        ...base,
        nature: g.racine === 'entrees' ? 'saisie' : g.racine === 'baremes' ? 'parametre' : 'trajectoire',
        chemin,
        ecran: g.ecran ?? null,
      };
    }
    if ('constante' in g) return { ...base, nature: 'constante' };
    return { ...base, nature: 'lecture', ecran: g.ecran ?? null };
  }
}

/**
 * Rejoue un noeud de formule en gardant trace de chaque etape.
 * @param {Classeur} c
 * @param {any} g
 * @param {any} n
 * @param {string[]} noms
 * @param {any[]} s
 * @returns {any}
 */
function tracer(c, g, n, noms, s) {
  const t = (m, noms2 = noms, s2 = s) => tracer(c, g, m, noms2, s2);
  switch (n.t) {
    case 'nb':
      return { t: 'nb', v: n.v };
    case 'txt':
      return { t: 'txt', v: n.v };
    case 'cst':
      return { t: 'cst', nom: n.nom, v: n.v };
    case 'neg': {
      const a = t(n.a);
      return { t: 'neg', a, v: -a.v };
    }
    case 'bin': {
      const a = t(n.a);
      const b = t(n.b);
      return { t: 'bin', op: n.op, a, b, v: OPERATIONS[n.op](a.v, b.v) };
    }
    case 'nom': {
      if (!n.index) {
        const k = noms.lastIndexOf(n.nom);
        if (k >= 0) return { t: 'var', nom: n.nom, v: s[k] };
      }
      const cible = c.modele.grandeur(n.nom);
      const explicites = new Map((n.index ?? []).map((i) => [i.dim, t(i.expr)]));
      const idx = cible.sur.map((d) => (explicites.has(d) ? explicites.get(d).v : s[noms.lastIndexOf(d)]));
      const dims = Object.fromEntries(cible.sur.map((d, i) => [d, idx[i]]));
      const index = [...explicites].map(([dim, noeud]) => ({ dim, noeud }));
      for (const [d, noeud] of explicites) {
        const dim = c.modele.dimensions.get(d);
        if (dim.libre) continue;
        const parents = dim.sur.map((p) => idx[cible.sur.indexOf(p)]);
        if (!c.appartient(dim, noeud.v, parents)) {
          return { t: 'ref', id: cible.id, dims, index, horsDimension: true, v: undefined };
        }
      }
      return { t: 'ref', id: cible.id, dims, index, v: c.vn(cible, idx) };
    }
    case 'fn': {
      const def = FONCTIONS[n.nom];
      if (def.evaluer) {
        /** @type {any[]} */
        const args = n.args.map(() => null);
        const v = def.evaluer(
          n.args.map((a, i) => () => {
            args[i] = t(a);
            return args[i].v;
          }),
        );
        // Les arguments ecartes restent visibles, sans valeur : on lit la
        // formule entiere, et on voit ce qui n'a pas servi.
        return {
          t: 'fn',
          nom: n.nom,
          args: args.map((x, i) => x ?? { ...structure(n.args[i]), ecarte: true }),
          v,
        };
      }
      const args = n.args.map((a) => t(a));
      return { t: 'fn', nom: n.nom, args, v: /** @type {any} */ (def.calc)(...args.map((a) => a.v)) };
    }
    case 'agr': {
      const def = AGREGATS[n.nom];
      /** @type {Array<{cle: any, noeud: any, v: any, part?: number}>} */
      const termes = [];
      // Meme accumulation, dans le meme ordre, que le calcul compile - et le
      // meme arret : PREMIER s'arrete au premier terme retenu.
      let acc = def.special ? null : /** @type {() => any} */ (def.init)();
      let arrete = false;
      /**
       * @param {number} i
       * @param {string[]} nomsCourants
       * @param {any[]} sCourante
       * @param {any[]} cles
       */
      const parcourir = (i, nomsCourants, sCourante, cles) => {
        if (i === n.parcours.length) {
          const corps = def.sansCorps ? null : tracer(c, g, n.corps, nomsCourants, sCourante);
          const v = corps ? corps.v : null;
          termes.push({ cle: cles.length === 1 ? cles[0] : cles, noeud: corps, v });
          if (!def.special) {
            acc = /** @type {(a: any, v: any) => any} */ (def.ajouter)(acc, v);
            if (def.arret && def.arret(acc)) arrete = true;
          }
          return;
        }
        const p = n.parcours[i];
        let liste;
        if (p.dans) liste = tracer(c, g, p.dans, nomsCourants, sCourante).v;
        else {
          const dim = c.modele.dimensions.get(p.variable);
          liste = c.vn(dim.grandeur, dim.sur.map((q) => sCourante[nomsCourants.lastIndexOf(q)]));
        }
        const interieur = [...nomsCourants, p.variable];
        for (const valeur of liste ?? []) {
          if (arrete) break;
          const s2 = [...sCourante, valeur];
          if (p.quand && !tracer(c, g, p.quand, interieur, s2).v) continue;
          parcourir(i + 1, interieur, s2, [...cles, valeur]);
        }
      };
      parcourir(0, noms, s, []);
      const args = n.args.map((a) => t(a));
      let v;
      if (def.special === 'repartir') {
        const entiers = arrondirEnConservantLaSomme(
          termes.map((x) => x.v),
          args[0] ? args[0].v : undefined,
        );
        const courant = s[noms.lastIndexOf(n.parcours[0].variable)];
        termes.forEach((x, i) => {
          x.part = entiers[i];
        });
        v = entiers[termes.findIndex((x) => x.cle === courant)];
      } else if (def.special === 'tri') {
        v = tauxRentabiliteInterne([args[0].v, ...termes.map((x) => x.v)]);
      } else {
        v = def.fin ? def.fin(acc) : acc;
      }
      return {
        t: 'agr',
        nom: n.nom,
        parcours: n.parcours.map(structureParcours),
        corps: structure(n.corps),
        args,
        termes,
        parcourus: termes.length,
        v,
      };
    }
    default:
      throw new Error(`Noeud inconnu : ${n.t}`);
  }
}

/**
 * Structure d'un noeud sans valeur : ce que l'ecran affiche pour une branche
 * ecartee, ou pour le corps generique d'un agregat.
 * @param {any} n
 * @returns {any}
 */
export function structure(n) {
  switch (n.t) {
    case 'nb':
    case 'txt':
      return { t: n.t, v: n.v };
    case 'cst':
      return { t: 'cst', nom: n.nom, v: n.v };
    case 'neg':
      return { t: 'neg', a: structure(n.a) };
    case 'bin':
      return { t: 'bin', op: n.op, a: structure(n.a), b: structure(n.b) };
    case 'nom':
      return {
        t: 'nom',
        nom: n.nom,
        index: (n.index ?? []).map((i) => ({ dim: i.dim, noeud: structure(i.expr) })),
      };
    case 'fn':
      return { t: 'fn', nom: n.nom, args: n.args.map(structure) };
    case 'agr':
      return {
        t: 'agr',
        nom: n.nom,
        parcours: n.parcours.map(structureParcours),
        corps: structure(n.corps),
        args: n.args.map(structure),
      };
    default:
      return { t: n.t };
  }
}

/**
 * Structure d'un niveau de parcours d'agregat.
 * @param {import('./langage.js').Parcours} p
 */
function structureParcours(p) {
  return {
    variable: p.variable,
    dans: p.dans ? structure(p.dans) : null,
    quand: p.quand ? structure(p.quand) : null,
  };
}
