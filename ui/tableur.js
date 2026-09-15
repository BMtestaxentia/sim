// @ts-check
/**
 * LE CLASSEUR DES CALCULS : tout le modele du moteur, lu et modifie comme un
 * classeur Excel.
 *
 * Une FEUILLE par domaine, dans l'ordre de la chaine de calcul : elles se
 * lisent de gauche a droite. Dans une feuille, une LIGNE par grandeur et une
 * seule formule par ligne, affichee sous son libelle ; les COLONNES sont les
 * valeurs de sa dimension (tranches, exercices, prets...). Les grandeurs qui se
 * declinent de la meme facon forment un tableau, avec sa ligne d'en-tete ; une
 * dimension de plus se choisit en haut de la feuille, comme un segment.
 *
 * Grammaire visuelle, la meme partout :
 *   - la couleur dit la nature : bleu = saisie ou parametre, vert = lien vers
 *     une autre feuille, encre du texte = calcul ;
 *   - la graisse dit l'importance : resultat cle, etape, detail technique
 *     replie en groupe de lignes (niveaux.js) ;
 *   - les fleches et les couleurs des references disent qui alimente qui.
 *
 * Les formules s'ecrivent comme dans Excel en francais (ecriture.js), en noms
 * ou en adresses. Une modification - formule, ligne inseree, importance - est
 * une MODIFICATION DU MODELE (surcharges.js) : le moteur calcule avec, et
 * l'apercu en chiffre l'impact avant qu'on la valide.
 *
 * Rien n'est recalcule ici pour l'affichage : les valeurs viennent du
 * classeur qui a produit les resultats, et « Pourquoi ce chiffre ? » rejoue le
 * meme chemin par `expliquer`.
 */
import { MODELE, modeleDe } from '../src/formules/modele.js';
import { FONCTIONS, AGREGATS } from '../src/formules/fonctions.js';
import { compilerGrandeur } from '../src/formules/classeur.js';
import { nomsCites, analyser } from '../src/formules/langage.js';
import { versExcel, depuisExcel, nombreExcel } from '../src/formules/ecriture.js';
import { niveauDe } from '../src/formules/niveaux.js';
import { nombreSurcharges, sansSurcharge, RE_IDENTIFIANT_GRANDEUR } from '../src/formules/surcharges.js';

/**
 * @typedef {Object} OptionsTableur
 * @property {() => any} lireClasseur            classeur du dernier calcul, null s'il a echoue
 * @property {() => any} lireSurcharges           modifications du modele en vigueur
 * @property {(s: any) => void} ecrireSurcharges  les enregistre, puis recalcule tout l'outil
 * @property {(g: any, indices: Record<string, any>, v: any) => string|null} ecrireCellule
 *   ecrit une saisie ou un parametre et recalcule ; rend un message d'erreur, ou null
 * @property {(d: {surcharges?: any, cellule?: {g: any, indices: Record<string, any>, v: any}}) => any} simuler
 *   classeur d'un calcul a blanc, pour l'apercu
 * @property {() => void} montrerEcran           affiche l'onglet Calculs
 */

/**
 * Pose le classeur des calculs et ses ecouteurs, une fois pour toutes.
 * @param {OptionsTableur} o
 */
export function installerTableur(o) {
  // ------------------------------------------------------------- outils
  const FORMATS = new Map();
  /** @param {number} v @param {number} min @param {number} max */
  const nombreFr = (v, min, max) => {
    const k = `${min}|${max}`;
    let f = FORMATS.get(k);
    if (!f) FORMATS.set(k, (f = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: min, maximumFractionDigits: max })));
    return f.format(v);
  };
  /** @param {any} v */
  const ech = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  /** @param {string} s */
  const sansAccents = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  /** @param {string} id */
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

  const UNITES = /** @type {Record<string, string>} */ ({
    eur: '€', taux: '%', coef: 'coef', annee: 'année', an: 'ans', mois: 'mois', m2: 'm²', eur_m2: '€/m²',
    eur_m2_mois: '€/m²/mois', nombre: 'nb', texte: 'texte', booleen: 'oui/non', liste: 'liste', date: 'date',
  });
  const NIVEAUX = /** @type {Record<string, string>} */ ({ cle: 'Résultat clé', etape: 'Étape', technique: 'Détail technique' });
  const NATURES = /** @type {Record<string, string>} */ ({
    formule: 'Calcul', saisie: 'Saisie', parametre: 'Paramètre du barème', trajectoire: 'Trajectoire',
    constante: 'Constante', lecture: 'Donnée de référence',
  });
  const SYMBOLES = /** @type {Record<string, string>} */ ({ '+': '+', '-': '−', '*': '×', '/': '÷', '^': '^', '=': '=', '<>': '≠', '<': '<', '<=': '≤', '>': '>', '>=': '≥' });
  const PRIORITES = /** @type {Record<string, number>} */ ({ '=': 1, '<>': 1, '<': 1, '<=': 1, '>': 1, '>=': 1, '+': 2, '-': 2, '*': 3, '/': 3, '^': 5 });

  /** Valeur compacte d'une cellule de la grille. @param {any} v @param {string} [unite] */
  function enCellule(v, unite) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return v ? 'VRAI' : 'FAUX';
    if (Array.isArray(v)) return `{${v.length}}`;
    if (typeof v === 'object') return '{…}';
    if (typeof v !== 'number') return String(v);
    if (Number.isNaN(v)) return '#NOMBRE!';
    if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞';
    switch (unite) {
      case 'eur': return nombreFr(v, 0, 0);
      case 'taux': return `${nombreFr(v * 100, 2, 2)} %`;
      case 'coef': return nombreFr(v, 4, 4);
      case 'annee': return String(v);
      case 'eur_m2': case 'eur_m2_mois': return nombreFr(v, 2, 2);
      default: return nombreFr(v, 0, 2);
    }
  }
  /** Valeur exacte, pour le panneau et les blocs. @param {any} v @param {string} [unite] */
  function lisible(v, unite) {
    if (v === undefined) return 'indéfini';
    if (v === null) return 'vide';
    if (typeof v === 'boolean') return v ? 'VRAI' : 'FAUX';
    if (Array.isArray(v)) return v.length ? `${v.length} élément${v.length > 1 ? 's' : ''}` : 'liste vide';
    if (typeof v === 'object') {
      const n = Object.keys(v).length;
      return n ? `table de ${n} entrée${n > 1 ? 's' : ''}` : 'table vide';
    }
    if (typeof v !== 'number') return String(v);
    if (Number.isNaN(v)) return 'non calculable';
    if (!Number.isFinite(v)) return v > 0 ? 'infini' : 'moins l’infini';
    switch (unite) {
      case 'eur': return `${nombreFr(v, 2, 2)} €`;
      case 'taux': return `${nombreFr(v * 100, 2, 4)} %`;
      case 'coef': return nombreFr(v, 4, 7);
      case 'annee': return String(v);
      case 'an': return `${nombreFr(v, 0, 2)} an${Math.abs(v) >= 2 ? 's' : ''}`;
      case 'm2': return `${nombreFr(v, 0, 2)} m²`;
      case 'eur_m2': return `${nombreFr(v, 2, 2)} €/m²`;
      case 'eur_m2_mois': return `${nombreFr(v, 2, 2)} €/m²/mois`;
      case 'mois': return `${nombreFr(v, 0, 2)} mois`;
      default: return nombreFr(v, 0, 4);
    }
  }
  /** Nature d'une grandeur d'apres sa declaration. @param {any} g */
  function nature(g) {
    if (g.formule !== undefined) return 'formule';
    if (g.saisie !== undefined) return 'saisie';
    if (g.parametre !== undefined) return 'parametre';
    if (g.trajectoire !== undefined) return 'trajectoire';
    if ('constante' in g) return 'constante';
    return 'lecture';
  }
  /** Une saisie ou un parametre se tape dans sa cellule. @param {any} g */
  const modifiable = (g) => g.saisie !== undefined || (g.parametre !== undefined && !g.sur.length);
  /** Colonne numero i, a partir de 0 : A, B... Z, AA. @param {number} i */
  function lettre(i) {
    let s = '';
    let k = i + 1;
    while (k > 0) {
      const r = (k - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      k = Math.floor((k - 1) / 26);
    }
    return s;
  }
  /** @param {string} l */
  const indexLettre = (l) => [...l].reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0) - 1;

  // --------------------------------------------------------------- etat
  const etat = {
    feuille: /** @type {string|null} */ (null),
    /** Cellule choisie : la grandeur de sa ligne, et sa lettre de colonne. */
    choix: { id: /** @type {string|null} */ (null), col: 'B' },
    /** Derniere cellule choisie sur chaque feuille. */
    parFeuille: /** @type {Record<string, {id: string|null, col: string}>} */ ({}),
    niveau: 'standard',
    refs: 'noms',
    fleches: true,
    /** Valeur retenue pour chaque dimension choisie en haut de feuille. */
    filtres: /** @type {Record<string, any>} */ ({}),
    ouverts: new Set(),
    edition: /** @type {any} */ (null),
    saisieCellule: false,
    cibles: /** @type {any[]} */ ([]),
    sugg: /** @type {any} */ (null),
    suggNoms: /** @type {any} */ (null),
    deroules: new Set(),
    insertion: false,
    // A la premiere ouverture, la feuille defile jusqu'a la cellule choisie.
    defiler: true,
    /** Cellule ouverte dans la boite « Pourquoi ce chiffre ? », hors de l'onglet. */
    boite: /** @type {any} */ (null),
    /** Grandeurs dont le modele est modifie : formule reecrite ou ligne inseree. */
    surchargees: /** @type {Set<string>} */ (new Set()),
    /** Grandeurs affichees sur la feuille, dans l'ordre, pour le clavier. */
    visibles: /** @type {string[]} */ ([]),
  };
  /** Classeur du dernier calcul, et disposition des feuilles qu'on en a tiree. */
  let C = /** @type {any} */ (null);
  let M = MODELE;
  /** @type {Map<string, any>} */
  let DISPOSITIONS = new Map();

  // ------------------------------------------------- dimensions et colonnes
  /** Valeur de repli d'une dimension libre, la plus parlante pour l'operation. @param {string} d */
  function valeurLibreParDefaut(d) {
    const lire = (/** @type {string} */ id) => {
      try { return C?.valeur(id); } catch { return undefined; }
    };
    switch (d) {
      case 'an': case 'depuis': return lire('annee_mise_en_location');
      case 'index': return 'loyers_irl';
      case 'perimetre': return 'operation';
      case 'poste_is': return 'frais_gestion';
      case 'code': return lire('tranches_presentes')?.[0];
      case 'champ': return 'taux';
      case 'nature': return 'foncier';
      default: return undefined;
    }
  }
  /**
   * Valeurs d'une dimension, ou null pour une dimension libre sans liste : elle
   * se choisit alors en haut de feuille, sans colonnes.
   * @param {string} d @param {Record<string, any>} parents
   */
  function valeursDim(d, parents) {
    const dim = M.dimensions.get(d);
    if (!dim) return null;
    if (!dim.libre) {
      try {
        return C ? C.valeursDimension(d, Object.fromEntries(dim.sur.map((/** @type {string} */ p) => [p, parents[p]]))) ?? [] : [];
      } catch {
        return [];
      }
    }
    const lire = (/** @type {string} */ id) => {
      try { return C?.valeur(id); } catch { return undefined; }
    };
    switch (d) {
      case 'an': {
        try { return C ? C.valeursDimension('exercice') : []; } catch { return []; }
      }
      case 'perimetre': return ['operation', ...(lire('tranches_presentes') ?? [])];
      case 'code': return [...(lire('tranches_presentes') ?? [])];
      default: return null;
    }
  }
  /** Libelle d'une valeur de dimension. @param {string} d @param {any} v @param {Record<string, any>} [parents] */
  function etiquette(d, v, parents = {}) {
    if (v === undefined || v === null) return '';
    if (d === 'perimetre' && v === 'operation') return 'Opération';
    try {
      return C && M.dimensions.has(d) && !M.dimensions.get(d).libre ? C.etiquette(d, v, parents) : String(v);
    } catch {
      return String(v);
    }
  }
  /**
   * Valeur retenue d'une dimension : celle qu'on a choisie si elle existe
   * encore, la premiere sinon.
   * @param {string} d @param {Record<string, any>} parents
   */
  function filtre(d, parents) {
    const liste = valeursDim(d, parents);
    const voulu = etat.filtres[d];
    if (liste === null) return voulu !== undefined ? voulu : valeurLibreParDefaut(d);
    return liste.includes(voulu) ? voulu : liste[0];
  }
  /**
   * Dimension des colonnes d'un tableau : la derniere qui a une liste de
   * valeurs. Une dimension libre sans liste (un champ de table, une charge
   * deductible) se choisit en haut de la feuille.
   * @param {string[]} sur
   */
  function dimColonne(sur) {
    for (let i = sur.length - 1; i >= 0; i--) if (valeursDim(sur[i], {}) !== null) return sur[i];
    return null;
  }
  /**
   * Colonnes d'un tableau : une par valeur de sa dimension de colonne ; les
   * autres dimensions sont fixees par les choix du haut de la feuille.
   * @param {{sur: string[]}} b
   */
  function colonnesDuBloc(b) {
    if (!b.sur.length) return { dim: null, valeurs: [{ v: null, lettre: 'B', etiquette: 'Valeur' }], fixes: {} };
    const dimCol = dimColonne(b.sur);
    /** @type {Record<string, any>} */
    const fixes = {};
    for (const d of b.sur) if (d !== dimCol) fixes[d] = filtre(d, fixes);
    if (!dimCol) return { dim: null, valeurs: [{ v: null, lettre: 'B', etiquette: 'Valeur' }], fixes };
    // Une dimension choisie qui n'a aucune valeur dans cette simulation - pas
    // de charge diverse, pas de pret saisi : le tableau n'a pas de cellules.
    const vide = b.sur.find((d) => d !== dimCol && fixes[d] === undefined && valeursDim(d, fixes) !== null) ?? null;
    if (vide) return { dim: dimCol, valeurs: [], fixes, vide };
    const valeurs = valeursDim(dimCol, fixes) ?? [];
    return {
      dim: dimCol,
      valeurs: valeurs.map((v, i) => ({ v, lettre: lettre(i + 1), etiquette: etiquette(dimCol, v, fixes) })),
      fixes,
    };
  }
  /** Indices de la cellule d'une ligne dans une colonne. @param {any} ligne @param {any} colonne */
  function indicesDe(ligne, colonne) {
    const idx = { ...ligne.col.fixes };
    if (ligne.col.dim && colonne) idx[ligne.col.dim] = colonne.v;
    return Object.fromEntries(ligne.g.sur.map((/** @type {string} */ d) => [d, idx[d]]));
  }

  // -------------------------------------------------------- disposition
  /** Les feuilles : une par domaine qui porte des grandeurs visibles. */
  function feuilles() {
    return M.domaines
      .map((/** @type {any} */ d) => ({ id: d.domaine, titre: d.titre }))
      .filter((/** @type {any} */ f) => [...M.grandeurs.values()].some((g) => g.domaine === f.id && !g.cachee));
  }
  /** @param {string} fid */
  const titreFeuille = (fid) => M.domaines.find((/** @type {any} */ d) => d.domaine === fid)?.titre ?? fid;
  /**
   * Disposition d'une feuille : ses tableaux, leurs lignes numerotees. Les
   * numeros ne dependent pas des choix du haut de la feuille, seulement du
   * modele : une adresse reste la meme d'une tranche a l'autre.
   * @param {string} fid
   */
  function disposition(fid) {
    let d = DISPOSITIONS.get(fid);
    if (d) return d;
    /** @type {Array<{cle: string, sur: string[], grandeurs: any[]}>} */
    const blocs = [];
    for (const g of M.grandeurs.values()) {
      if (g.domaine !== fid || g.cachee) continue;
      const cle = g.sur.join(',');
      let b = blocs.find((x) => x.cle === cle);
      if (!b) blocs.push((b = { cle, sur: g.sur, grandeurs: [] }));
      b.grandeurs.push(g);
    }
    /** @type {any[]} */
    const lignes = [];
    const parId = new Map();
    let n = 0;
    for (const b of blocs) {
      const col = colonnesDuBloc(b);
      lignes.push({ type: 'entete', n: ++n, bloc: b, col });
      for (const g of b.grandeurs) {
        const l = { type: 'grandeur', n: ++n, g, bloc: b, col };
        lignes.push(l);
        parId.set(g.id, l);
      }
    }
    const dims = new Set();
    for (const b of blocs) {
      const dc = dimColonne(b.sur);
      for (const x of b.sur) if (x !== dc) dims.add(x);
    }
    d = { fid, blocs, lignes, parId, dims: [...dims] };
    DISPOSITIONS.set(fid, d);
    return d;
  }
  /** Ligne d'une grandeur, sur sa feuille. @param {string} id */
  function ligneDe(id) {
    const g = M.grandeurs.get(id);
    return g && !g.cachee ? disposition(g.domaine).parId.get(id) ?? null : null;
  }
  /**
   * Position d'une cellule : sa feuille, son numero de ligne, sa lettre ; et
   * si elle est affichee avec les choix du haut de sa feuille.
   * @param {string} id @param {Record<string, any>} idx
   */
  function positionDe(id, idx) {
    const l = ligneDe(id);
    if (!l) return null;
    const g = l.g;
    if (!g.sur.length) return { fid: g.domaine, n: l.n, lettre: 'B', affichee: true, l };
    const dimCol = dimColonne(g.sur);
    const affichee = g.sur.every((/** @type {string} */ d) => d === dimCol || l.col.fixes[d] === idx[d]);
    if (!dimCol) return { fid: g.domaine, n: l.n, lettre: 'B', affichee, l };
    const valeurs = valeursDim(dimCol, { ...idx }) ?? [];
    const i = valeurs.indexOf(idx[dimCol]);
    if (i < 0) return null;
    return { fid: g.domaine, n: l.n, lettre: lettre(i + 1), affichee, l };
  }
  /** Valeur d'une cellule, sans jamais faire echouer l'ecran. @param {string} id @param {Record<string, any>} idx */
  function lireCellule(id, idx) {
    if (!C) return { v: undefined, erreur: 'pas de calcul', controle: false };
    try {
      return { v: C.valeur(id, idx), erreur: null, controle: false };
    } catch (e) {
      // Un CONTROLE du moteur arrete volontairement le calcul d'une cellule
      // (une donnee requise manque) : ce n'est pas une panne, et il se lit
      // comme tel.
      return { v: undefined, erreur: /** @type {Error} */ (e).message, controle: Boolean(/** @type {any} */ (e).issueDeFormule) };
    }
  }

  // ------------------------------------------- references entre cellules
  /** @param {string} fid */
  const prefixeFeuille = (fid) => `'${titreFeuille(fid).replace(/'/g, "''")}'!`;
  /**
   * Adresse d'une grandeur citee sans indice, lue depuis une cellule : ses
   * indices sont ceux de la cellule. Colonne relative quand la cible se
   * decline sur la meme dimension de colonne, absolue ($C) sinon, et $B$n pour
   * une valeur unique - comme on l'ecrirait dans Excel.
   * @param {string} nom
   * @param {{fid: string, indices: Record<string, any>, dimCol: string|null}} ctx
   */
  function adressePour(nom, ctx) {
    const cible = M.grandeurs.get(nom);
    if (!cible || cible.cachee) return null;
    /** @type {Record<string, any>} */
    const idx = {};
    for (const d of cible.sur) {
      if (!(d in ctx.indices)) return null;
      idx[d] = ctx.indices[d];
    }
    const pos = positionDe(nom, idx);
    if (!pos) return null;
    const feuille = pos.fid === ctx.fid ? '' : prefixeFeuille(pos.fid);
    if (!cible.sur.length) return `${feuille}$B$${pos.n}`;
    const relative = ctx.dimCol !== null && dimColonne(cible.sur) === ctx.dimCol;
    return `${feuille}${relative ? '' : '$'}${pos.lettre}${pos.n}`;
  }
  /**
   * La formule d'une cellule en ecriture Excel, en noms ou en adresses. Rend
   * aussi, pour les adresses, la grandeur que chacune designe.
   * @param {any} g @param {Record<string, any>} indices
   */
  function texteFormule(g, indices) {
    if (g.formule === undefined) return { texte: null, adresses: new Map() };
    /** @type {Map<string, string>} */
    const adresses = new Map();
    if (etat.refs === 'noms') return { texte: versExcel(g.formule), adresses };
    const l = ligneDe(g.id);
    const ctx = { fid: g.domaine, indices, dimCol: l?.col.dim ?? null };
    const texte = versExcel(g.formule, {
      adresse: (nom) => {
        const a = adressePour(nom, ctx);
        if (a) adresses.set(a, nom);
        return a;
      },
    });
    return { texte, adresses };
  }
  /**
   * Cellule a une adresse. Sans nom de feuille, l'adresse se lit sur la feuille
   * de la formule, comme dans Excel.
   * @param {string|null} feuilleTitre @param {string} col @param {number} n @param {string} fidDefaut
   */
  function celluleA(feuilleTitre, col, n, fidDefaut) {
    const fid = feuilleTitre ? feuilles().find((/** @type {any} */ f) => f.titre === feuilleTitre)?.id : fidDefaut;
    if (!fid) throw new Error(`Feuille inconnue : ${feuilleTitre}.`);
    const l = disposition(fid).lignes.find((/** @type {any} */ x) => x.n === n);
    if (!l || l.type !== 'grandeur') throw new Error(`La ligne ${n} de la feuille ${titreFeuille(fid)} ne porte pas de valeur.`);
    const colonne = l.col.valeurs.find((/** @type {any} */ v) => v.lettre === col);
    if (!colonne) throw new Error(`La colonne ${col} est hors du tableau de la ligne ${n}.`);
    return { fid, l, g: l.g, colonne, indices: indicesDe(l, colonne) };
  }
  /**
   * Une cellule citee depuis la cellule en cours de modification : son nom, et
   * les indices qui la distinguent. Une colonne relative sur des annees devient
   * un decalage (`exercice - 1`) qui se recopie d'une colonne a l'autre, comme
   * une reference relative d'Excel ; une colonne absolue ($C), une autre
   * tranche, s'ecrivent en clair.
   * @param {{g: any, indices: Record<string, any>}} cible
   * @param {{indices: Record<string, any>, dimCol: string|null}} e
   * @param {boolean} colAbs
   */
  function citation(cible, e, colAbs) {
    /** @type {Array<{dim: string, expr?: string, valeur?: any}>} */
    const index = [];
    for (const d of cible.g.sur) {
      const v = cible.indices[d];
      const partagee = d in e.indices;
      const figee = colAbs && d === e.dimCol;
      if (partagee && e.indices[d] === v && !figee) continue;
      if (partagee && !figee && typeof v === 'number' && typeof e.indices[d] === 'number') {
        const k = v - e.indices[d];
        index.push({ dim: d, expr: `${d} ${k > 0 ? '+' : '-'} ${Math.abs(k)}` });
        continue;
      }
      index.push({ dim: d, valeur: v });
    }
    return { nom: cible.g.id, index };
  }
  /**
   * @param {{nom: string, index: Array<{dim: string, expr?: string, valeur?: any}>}} c
   * @param {'excel'|'interne'} ecriture
   */
  function ecrireCitation(c, ecriture) {
    if (!c.index.length) return c.nom;
    const lit = (/** @type {any} */ v) =>
      typeof v === 'number'
        ? ecriture === 'excel' ? nombreExcel(v) : String(v)
        : typeof v === 'string'
          ? ecriture === 'excel' ? `"${v.replace(/"/g, '""')}"` : `'${v.replace(/'/g, "''")}'`
          : v === true ? 'VRAI' : v === false ? 'FAUX' : 'VIDE';
    return `${c.nom}[${c.index.map((i) => `${i.dim}: ${i.expr ?? lit(i.valeur)}`).join('; ')}]`;
  }
  /**
   * Traduit une adresse tapee dans une formule. Une plage sur toute une ligne
   * parcourt sa dimension (`x POUR tranche`) ; une plage verticale cite ses
   * lignes une a une, pour SOMME, MIN ou MAX.
   * @param {import('../src/formules/ecriture.js').ReferenceExcel} r @param {any} e
   */
  function resoudreReference(r, e) {
    const a = celluleA(r.feuille, r.a.col, r.a.ligne, e.fid);
    if (!r.b) return ecrireCitation(citation(a, e, r.a.colAbs), 'interne');
    const b = celluleA(r.feuille, r.b.col, r.b.ligne, e.fid);
    if (a.l === b.l) {
      const dim = a.l.col.dim;
      const toutes = a.l.col.valeurs;
      if (!dim || a.colonne !== toutes[0] || b.colonne !== toutes.at(-1)) {
        throw new Error(`La plage ${r.texte} doit couvrir toute la ligne ${a.l.n} : une formule du moteur parcourt une dimension entière.`);
      }
      const c = citation(a, e, true);
      c.index = c.index.filter((i) => i.dim !== dim);
      return `${ecrireCitation(c, 'interne')} POUR ${dim}`;
    }
    if (a.colonne.lettre === b.colonne.lettre && a.fid === b.fid) {
      const [n1, n2] = [Math.min(a.l.n, b.l.n), Math.max(a.l.n, b.l.n)];
      const cites = disposition(a.fid)
        .lignes.filter((/** @type {any} */ x) => x.type === 'grandeur' && x.n >= n1 && x.n <= n2)
        .map((/** @type {any} */ x) => {
          const colonne = x.col.valeurs.find((/** @type {any} */ v) => v.lettre === a.colonne.lettre);
          return colonne ? ecrireCitation(citation({ g: x.g, indices: indicesDe(x, colonne) }, e, r.a.colAbs), 'interne') : null;
        })
        .filter(Boolean);
      return cites.join('; ');
    }
    throw new Error(`La plage ${r.texte} couvre plusieurs lignes et plusieurs colonnes : citez les lignes une à une.`);
  }
  /** Ce qu'insere un clic sur une cellule pendant la frappe d'une formule. @param {any} cible @param {any} e */
  function texteInsere(cible, e) {
    if (etat.refs === 'noms') return ecrireCitation(citation(cible, e, false), 'excel');
    const feuille = cible.fid === e.fid ? '' : prefixeFeuille(cible.fid);
    return `${feuille}${cible.g.sur.length ? `${cible.colonne.lettre}${cible.l.n}` : `$B$${cible.l.n}`}`;
  }

  // ------------------------------------------------ antecedents d'une cellule
  /**
   * References directes d'une cellule, lues dans son explication : ce que sa
   * formule a reellement lu, branches ecartees exclues. Chacune recoit une
   * couleur, commune a toutes les cellules d'une meme grandeur.
   * @param {any} arbre
   */
  function ciblesDe(arbre) {
    /** @type {Array<{id: string, dims: Record<string, any>}>} */
    const refs = [];
    const tour = (/** @type {any} */ n) => {
      if (!n || refs.length > 80) return;
      if (n.t === 'ref' && !n.horsDimension) refs.push({ id: n.id, dims: n.dims });
      if (n.t === 'bin') { tour(n.a); tour(n.b); }
      if (n.t === 'neg') tour(n.a);
      if (n.t === 'fn') n.args.forEach((/** @type {any} */ x) => !x.ecarte && tour(x));
      if (n.t === 'agr') {
        n.args.forEach(tour);
        for (const x of n.termes ?? []) tour(x.noeud);
      }
    };
    tour(arbre);
    /** @type {Map<string, string>} */
    const couleurs = new Map();
    return refs.map((r) => {
      if (!couleurs.has(r.id)) couleurs.set(r.id, `var(--cat-${(couleurs.size % 6) + 1})`);
      return { ...r, couleur: /** @type {string} */ (couleurs.get(r.id)) };
    });
  }
  /**
   * Jetons d'un texte de formule en ecriture Excel, pour le colorer.
   * @param {string} texte
   */
  function jetonsExcel(texte) {
    const re = /\s+|"(?:[^"]|"")*"|(?:'(?:[^']|'')+'!)?\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?(?![A-Za-zÀ-ÿ0-9_(])|\d+(?:,\d+)?(?:[eE][-+]?\d+)?%?|[A-Za-zÀ-ÿ_][A-Za-zÀ-ÿ0-9_]*(?:\.[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9_]*)*|<>|<=|>=|[-+*/^=<>();:[\]&,]|./gy;
    /** @type {Array<{t: string, type: string}>} */
    const res = [];
    let m;
    while ((m = re.exec(texte)) !== null && m[0]) {
      const t = m[0];
      const type = /^\s/.test(t) ? 'esp'
        : t[0] === '"' ? 'txt'
          : /^(?:'|\$?[A-Z]{1,3}\$?\d)/.test(t) ? 'ref'
            : /^\d/.test(t) ? 'nb'
              : /^[A-Za-zÀ-ÿ_]/.test(t) ? 'mot' : 'op';
      res.push({ t, type });
    }
    return res;
  }
  /**
   * Une formule en HTML : chaque reference de la couleur de ses cellules, et
   * cliquable vers sa ligne.
   * @param {string} texte
   * @param {{cibles?: any[], adresses?: Map<string, string>, indices?: Record<string, any>}} [opt]
   */
  function htmlFormule(texte, opt = {}) {
    const couleurDe = (/** @type {string} */ id) => opt.cibles?.find((c) => c.id === id)?.couleur;
    const jetons = jetonsExcel(texte);
    return jetons
      .map((j, i) => {
        const suivant = jetons.slice(i + 1).find((x) => x.type !== 'esp');
        if (j.type === 'ref' || (j.type === 'mot' && M.grandeurs.has(j.t) && suivant?.t !== '(')) {
          const id = j.type === 'ref' ? opt.adresses?.get(j.t) : j.t;
          const couleur = id ? couleurDe(id) : undefined;
          const aller = id ? ` data-tb-aller="${ech(id)}"` : '';
          return couleur
            ? `<span class="tb-ref" style="--ref:${couleur}"${aller}>${ech(j.t)}</span>`
            : `<span class="tb-nom"${aller}>${ech(j.t)}</span>`;
        }
        if (j.type === 'mot' && suivant?.t === '(') return `<span class="tb-fn">${ech(j.t)}</span>`;
        if (j.type === 'mot' && /^(POUR|DANS|QUAND)$/.test(j.t)) return `<span class="tb-mot">${j.t}</span>`;
        if (j.type === 'op') return `<span class="tb-op">${ech(j.t)}</span>`;
        if (j.type === 'txt') return `<span class="tb-txt">${ech(j.t)}</span>`;
        return ech(j.t);
      })
      .join('');
  }
  // ------------------------------------------------------------ squelette
  /** La charpente de l'ecran, posee une fois : les zones vivantes se reecrivent. */
  function poserSquelette() {
    const hote = document.getElementById('tableur');
    if (!hote || hote.dataset.pose) return;
    hote.dataset.pose = '1';
    hote.innerHTML = `
      <div class="tb-tete">
        <div class="tb-intro">
          <h2>Calculs</h2>
          <p>Tout le modèle du moteur, écrit comme dans Excel : une ligne par valeur, sa formule sous son libellé.
            Choisissez une cellule pour voir d’où vient le chiffre ; une saisie en bleu se tape dans sa cellule,
            une formule se réécrit dans la barre.</p>
        </div>
        <div class="tb-reglages">
          <div class="tb-segment" role="group" aria-label="Niveau de détail">
            <button type="button" id="tb-niveau-essentiel" data-tb-niveau="essentiel" title="Seulement les résultats clés">Essentiel</button>
            <button type="button" id="tb-niveau-standard" data-tb-niveau="standard" title="Les étapes du calcul, détails techniques repliés">Étapes</button>
            <button type="button" id="tb-niveau-tout" data-tb-niveau="tout" title="Toutes les lignes">Tout le détail</button>
          </div>
          <div class="tb-segment" role="group" aria-label="Écriture des formules">
            <button type="button" id="tb-refs-noms" data-tb-refs="noms" title="Noms des valeurs, comme loyers_nets">Noms</button>
            <button type="button" id="tb-refs-adresses" data-tb-refs="adresses" title="Adresses de cellules, comme C21 ou $B$3">Adresses</button>
          </div>
          <button type="button" class="tb-bascule" id="tb-fleches" title="Flèches des antécédents de la cellule choisie">Flèches</button>
          <button type="button" class="tb-bascule tb-bascule--journal" id="tb-bascule-journal" aria-expanded="false"
            title="Formules réécrites, lignes insérées, importances changées">Modifications du modèle <span class="tb-compte" id="tb-compte-journal">0</span></button>
        </div>
      </div>
      <section class="tb-journal" id="tb-journal" aria-label="Modifications du modèle" hidden></section>
      <div class="tb-barre" id="tb-barre">
        <div class="tb-zone-nom">
          <input type="text" id="tb-zone-nom" autocomplete="off" spellcheck="false"
            aria-label="Zone Nom : tapez une adresse, un nom ou un mot du libellé pour y aller" />
          <span id="tb-zone-libelle"></span>
          <ul class="tb-suggestions tb-suggestions--nom" id="tb-liste-noms" role="listbox" hidden></ul>
        </div>
        <div class="tb-fx" aria-hidden="true">ƒx</div>
        <div class="tb-formule" id="tb-formule" title="Double-clic ou F2 pour modifier la formule"></div>
        <label class="tb-edition" for="tb-saisie-formule">
          <input type="text" id="tb-saisie-formule" autocomplete="off" spellcheck="false" aria-label="Formule de la ligne" />
        </label>
        <div class="tb-actions">
          <button type="button" class="bouton" id="tb-btn-modifier">Modifier la formule</button>
          <button type="button" class="bouton bouton--principal" id="tb-btn-valider" hidden>Valider</button>
          <button type="button" class="bouton" id="tb-btn-annuler" hidden>Annuler</button>
          <button type="button" class="bouton bouton--discret" id="tb-btn-retablir" hidden>Formule du moteur</button>
        </div>
        <div class="tb-bandeau" id="tb-bandeau" hidden></div>
        <ul class="tb-suggestions" id="tb-suggestions" role="listbox" hidden></ul>
      </div>
      <div class="tb-filtres" id="tb-filtres"></div>
      <div class="tb-corps">
        <div class="tb-feuille" id="tb-feuille" tabindex="0" aria-label="Feuille de calcul"></div>
        <aside class="tb-panneau" id="tb-panneau" aria-live="polite" aria-label="Pourquoi ce chiffre ?"></aside>
      </div>
      <div class="tb-pied">
        <div class="tb-onglets" id="tb-onglets" role="tablist" aria-label="Feuilles"></div>
        <div class="tb-legende">
          <span><b>Gras</b> résultat clé</span>
          <span>Gris, replié : détail technique</span>
          <span><span class="tb-l-saisie">1 234</span> saisie ou paramètre</span>
          <span><span class="tb-l-lien">1 234</span> repris d’une autre feuille</span>
          <span><span class="tb-l-fleche">⟶</span> antécédent</span>
        </div>
      </div>`;
  }

  // -------------------------------------------------------------- feuille
  /** @param {any} g */
  function masque(g) {
    const n = niveauDe(g);
    if (etat.niveau === 'tout') return false;
    if (etat.niveau === 'standard') return n === 'technique';
    return n !== 'cle';
  }
  /**
   * Les lignes a afficher : les lignes masquees par le niveau se replient par
   * groupes de lignes voisines, comme le plan d'une feuille Excel.
   * @param {any} d
   */
  function structure(d) {
    /** @type {any[]} */
    const items = [];
    /** @type {any} */
    let groupe = null;
    const fermer = () => {
      if (!groupe) return;
      if (etat.ouverts.has(groupe.id)) {
        groupe.lignes.forEach((/** @type {any} */ l, /** @type {number} */ k) => items.push({ type: 'ligne', l, groupe: groupe.id, premier: k === 0 }));
      } else items.push({ type: 'repli', groupe });
      groupe = null;
    };
    for (const l of d.lignes) {
      if (l.type === 'entete') {
        fermer();
        items.push({ type: 'entete', l });
      } else if (masque(l.g)) {
        if (!groupe) groupe = { id: `${d.fid}:${etat.niveau}:${l.g.id}`, lignes: [] };
        groupe.lignes.push(l);
      } else {
        fermer();
        items.push({ type: 'ligne', l });
      }
    }
    fermer();
    return items;
  }
  /** Deplie le groupe qui contient une ligne, pour qu'on la voie. @param {string} id */
  function deplierPour(id) {
    const l = ligneDe(id);
    if (!l || !masque(l.g)) return;
    const d = disposition(l.g.domaine);
    const i = d.lignes.indexOf(l);
    let k = i;
    while (k > 0 && d.lignes[k - 1].type === 'grandeur' && masque(d.lignes[k - 1].g)) k--;
    etat.ouverts.add(`${d.fid}:${etat.niveau}:${d.lignes[k].g.id}`);
  }
  /** Titre d'un tableau : sa dimension de colonne et les choix qui le fixent. @param {any} l */
  function titreBloc(l) {
    const { col, bloc } = l;
    const dims = bloc.sur;
    if (!dims.length) return 'Pour l’opération';
    const libelle = (/** @type {string} */ d) => M.dimensions.get(d)?.libelle ?? d;
    const fixes = dims
      .filter((/** @type {string} */ d) => d !== col.dim && col.fixes[d] !== undefined)
      .map((/** @type {string} */ d) => `${libelle(d)} ${etiquette(d, col.fixes[d], col.fixes) || String(col.fixes[d])}`);
    const tete = col.dim ? `Par ${libelle(col.dim).toLowerCase()}` : 'Valeur';
    const vide = col.vide ? [`aucune valeur de « ${libelle(col.vide).toLowerCase()} » dans cette simulation`] : [];
    return [tete, ...fixes, ...vide].join(' · ');
  }
  /** La formule d'une ligne se lit comme un lien quand elle ne fait que citer une autre feuille. @param {any} g */
  function estLien(g) {
    if (g.formule === undefined) return false;
    const m = /^\s*([a-z_][a-z0-9_]*)\s*$/.exec(g.formule);
    const cible = m ? M.grandeurs.get(m[1]) : null;
    return !!cible && cible.domaine !== g.domaine;
  }
  /** Seconde ligne du libelle : la formule, ou d'ou vient la valeur. @param {any} l */
  function secondeLigne(l) {
    const g = l.g;
    if (g.formule !== undefined) {
      const indices = indicesDe(l, l.col.valeurs[0]);
      let t;
      try {
        ({ texte: t } = texteFormule(g, indices));
      } catch {
        t = g.formule;
      }
      return `<div class="tb-lib-formule${estLien(g) ? ' tb-lib-formule--lien' : ''}" title="${ech(t)}">${htmlFormule(/** @type {string} */ (t))}</div>`;
    }
    const n = nature(g);
    const ou = g.ecran ? ` · ${g.ecran}` : '';
    const texte = n === 'saisie' ? `Saisie${ou}` : n === 'parametre' ? `Paramètre${ou}` : n === 'trajectoire' ? `Trajectoire${ou}` : n === 'constante' ? 'Constante du modèle' : `Donnée de référence${ou}`;
    return `<div class="tb-lib-origine tb-lib-origine--${n}">${ech(texte)}</div>`;
  }
  /**
   * @param {any} l @param {any} colonne @param {number} largeur colonnes du tableau le plus large
   */
  function htmlCellule(l, colonne) {
    const g = l.g;
    const idx = indicesDe(l, colonne);
    const { v, erreur, controle } = lireCellule(g.id, idx);
    const cls = ['tb-val'];
    if (controle) cls.push('tb-val--controle');
    const n = nature(g);
    if (modifiable(g) && (n === 'saisie' || n === 'parametre')) cls.push('tb-val--saisie');
    else if (n === 'parametre' || n === 'trajectoire' || n === 'lecture' || n === 'constante') cls.push('tb-val--donnee');
    if (estLien(g)) cls.push('tb-val--lien');
    if (typeof v === 'number' && v < 0) cls.push('tb-val--negatif');
    const choisie = etat.choix.id === g.id && etat.choix.col === colonne.lettre && (etat.edition ? etat.edition.fid === g.domaine : true);
    if (choisie) cls.push('tb-val--choisie');
    const contenu = erreur ? (controle ? '—' : '#ERREUR') : ech(enCellule(v, g.unite));
    const titre = erreur ? ` title="${ech(controle ? `Contrôle du calcul : ${erreur}` : erreur)}"` : '';
    return `<td class="${cls.join(' ')}" data-tb-cell="${colonne.lettre}|${ech(g.id)}"${titre}>${contenu}</td>`;
  }
  /** @param {any} item @param {number} largeur */
  function htmlLigne(item, largeur) {
    const l = item.l;
    const g = l.g;
    const niv = niveauDe(g);
    const replier = item.premier
      ? `<button type="button" class="tb-contour" data-tb-replier="${ech(item.groupe)}" aria-label="Replier ce groupe de lignes">−</button>` : '';
    const cellules = l.col.valeurs.map((/** @type {any} */ c) => htmlCellule(l, c)).join('');
    const vides = '<td class="tb-hors"></td>'.repeat(Math.max(0, largeur - l.col.valeurs.length));
    const marque = niv === 'cle' ? '<span class="tb-lib-niveau">clé</span>' : '';
    const modifiee = etat.surchargees.has(g.id) ? ' tb-ligne--modifiee' : '';
    return `<tr class="tb-niveau-${niv}${modifiee}" data-tb-ligne="${ech(g.id)}"><th class="tb-gouttiere" scope="row"><div class="tb-gouttiere-contenu"><span>${l.n}</span>${replier}</div></th>` +
      `<td class="tb-lib"><div class="tb-lib-ligne"><span class="tb-lib-texte" title="${ech(`${g.libelle} · ${g.id}`)}">${ech(g.libelle)}</span>` +
      `${g.unite && UNITES[g.unite] ? `<span class="tb-unite">${ech(UNITES[g.unite])}</span>` : ''}${marque}</div>${secondeLigne(l)}</td>${cellules}${vides}</tr>`;
  }
  /** @param {any} item @param {number} largeur */
  function htmlEntete(item, largeur) {
    const l = item.l;
    const actif = etat.choix.id && ligneDe(etat.choix.id)?.bloc === l.bloc ? etat.choix.col : null;
    const cellules = l.col.valeurs
      .map((/** @type {any} */ c) => `<th scope="col" class="tb-entete-val${c.lettre === actif ? ' tb-col-actif' : ''}" data-tb-col="${c.lettre}">${ech(c.etiquette)}</th>`)
      .join('');
    const vides = '<th class="tb-hors"></th>'.repeat(Math.max(0, largeur - l.col.valeurs.length));
    return `<tr class="tb-entete"><th class="tb-gouttiere" scope="row">${l.n}</th><th class="tb-lib" scope="row">${ech(titreBloc(l))}</th>${cellules}${vides}</tr>`;
  }
  /** @param {any} item @param {number} largeur */
  function htmlRepli(item, largeur) {
    const { lignes, id } = item.groupe;
    const plage = lignes.length > 1 ? `${lignes[0].n}–${lignes.at(-1).n}` : `${lignes[0].n}`;
    const libelles = lignes.map((/** @type {any} */ l) => l.g.libelle).join(' · ');
    return `<tr class="tb-repli" data-tb-debut="${lignes[0].n}" data-tb-fin="${lignes.at(-1).n}"><th class="tb-gouttiere" scope="row"><div class="tb-gouttiere-contenu"><span>${plage}</span>` +
      `<button type="button" class="tb-contour" data-tb-deplier="${ech(id)}" aria-label="Déplier les lignes ${plage}">+</button></div></th>` +
      `<td class="tb-lib" colspan="${1 + largeur}"><button type="button" class="tb-deplier" data-tb-deplier="${ech(id)}">` +
      `+ ${lignes.length} ligne${lignes.length > 1 ? 's' : ''} de détail : ${ech(libelles)}</button></td></tr>`;
  }
  function rendreFeuille() {
    const el = $('tb-feuille');
    const fid = etat.feuille;
    if (!fid) { el.innerHTML = ''; return; }
    const d = disposition(fid);
    const items = structure(d);
    etat.visibles = items.filter((i) => i.type === 'ligne').map((i) => i.l.g.id);
    const largeur = Math.max(1, ...d.lignes.map((/** @type {any} */ l) => l.col.valeurs.length));
    const lettres = Array.from({ length: largeur }, (_, i) => lettre(i + 1));
    const tete = `<thead><tr><th class="tb-gouttiere" scope="col"></th><th class="tb-lib" scope="col">A</th>` +
      lettres.map((x) => `<th scope="col" class="${x === etat.choix.col ? 'tb-col-actif' : ''}">${x}</th>`).join('') + '</tr></thead>';
    const corps = items
      .map((i) => (i.type === 'entete' ? htmlEntete(i, largeur) : i.type === 'repli' ? htmlRepli(i, largeur) : htmlLigne(i, largeur)))
      .join('');
    el.innerHTML = `<table class="tb-grille"><colgroup><col class="tb-c-gouttiere"><col class="tb-c-lib">${'<col class="tb-c-val">'.repeat(largeur)}</colgroup>${tete}<tbody>${corps}</tbody></table>`;
    el.dataset.fid = fid;
  }
  function rendreFiltres() {
    const el = $('tb-filtres');
    const d = etat.feuille ? disposition(etat.feuille) : null;
    if (!d || !d.dims.length) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    /** @type {Record<string, any>} */
    const parents = {};
    el.innerHTML = '<span class="tb-filtres-titre">Afficher</span>' + d.dims.map((/** @type {string} */ dim) => {
      const def = M.dimensions.get(dim);
      const valeurs = valeursDim(dim, parents);
      const courant = filtre(dim, parents);
      parents[dim] = courant;
      const id = `tb-filtre-${dim}`;
      const libelle = ech(def?.libelle ?? dim);
      if (valeurs === null) {
        return `<label class="tb-filtre" for="${id}"><span>${libelle}</span><input id="${id}" data-tb-filtre="${dim}" value="${ech(courant ?? '')}" /></label>`;
      }
      if (!valeurs.length) return `<span class="tb-filtre tb-filtre--vide">${libelle} : aucune dans cette simulation</span>`;
      const options = valeurs.map((v, i) => `<option value="${i}"${v === courant ? ' selected' : ''}>${ech(etiquette(dim, v, parents))}</option>`).join('');
      return `<label class="tb-filtre" for="${id}"><span>${libelle}</span><select id="${id}" data-tb-filtre="${dim}">${options}</select></label>`;
    }).join('');
  }
  function rendreOnglets() {
    $('tb-onglets').innerHTML = feuilles()
      .map((/** @type {any} */ f) => `<button type="button" role="tab" id="tb-onglet-${f.id}" aria-selected="${f.id === etat.feuille}" data-tb-onglet="${f.id}">${ech(f.titre)}</button>`)
      .join('') + '<span class="tb-sens">Les feuilles suivent la chaîne de calcul, de gauche à droite.</span>';
  }
  /** Encadre les cellules citees par la cellule choisie, dans la couleur de leur reference. */
  function surligner() {
    const el = $('tb-feuille');
    for (const c of etat.cibles) {
      const pos = positionDe(c.id, c.dims);
      if (!pos || pos.fid !== etat.feuille || !pos.affichee) continue;
      const td = el.querySelector(`[data-tb-cell="${pos.lettre}|${CSS.escape(c.id)}"]`);
      if (!td) continue;
      td.classList.add('tb-val--citee');
      /** @type {HTMLElement} */ (td).style.setProperty('--ref', c.couleur);
    }
  }

  // --------------------------------------------- fleches des antecedents
  /**
   * Point d'ancrage d'une cellule dans le tableau : la cellule elle-meme, ou la
   * ligne repliee qui la contient.
   * @param {HTMLElement} table @param {string} id @param {string} col @param {number} n
   */
  function ancre(table, id, col, n) {
    const base = table.getBoundingClientRect();
    const td = table.querySelector(`[data-tb-cell="${col}|${CSS.escape(id)}"]`);
    if (td) {
      const r = td.getBoundingClientRect();
      return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height, repliee: false };
    }
    const tr = [...table.querySelectorAll('tr.tb-repli')].find((t) => Number(/** @type {HTMLElement} */ (t).dataset.tbDebut) <= n && n <= Number(/** @type {HTMLElement} */ (t).dataset.tbFin));
    const th = table.querySelectorAll('thead th')[indexLettre(col) + 1];
    if (!tr || !th) return null;
    const rt = tr.getBoundingClientRect();
    const rc = th.getBoundingClientRect();
    return { x: rc.left - base.left, y: rt.top - base.top, w: rc.width, h: rt.height, repliee: true };
  }
  function dessinerFleches() {
    const el = $('tb-feuille');
    el.querySelector('svg.tb-fleches')?.remove();
    const table = /** @type {HTMLElement|null} */ (el.querySelector('table'));
    const e = etat.edition;
    const id = e ? e.id : etat.choix.id;
    const col = e ? e.col : etat.choix.col;
    if (!etat.fleches || !table || !id || !etat.cibles.length) return;
    const l = ligneDe(id);
    if (!l || l.g.domaine !== etat.feuille) return;
    const arrivee = ancre(table, id, col, l.n);
    if (!arrivee || arrivee.repliee) return;
    const W = table.offsetWidth;
    const H = table.offsetHeight;
    let defs = '';
    let traits = '';
    const ay = arrivee.y + arrivee.h / 2;
    const dejaAutres = new Set();
    etat.cibles.slice(0, 40).forEach((c, i) => {
      const couleur = c.couleur;
      const m = `tb-pointe-${i}`;
      defs += `<marker id="${m}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:${couleur}"/></marker>`;
      const pos = positionDe(c.id, c.dims);
      if (!pos) return;
      if (pos.fid !== etat.feuille || !pos.affichee) {
        // Une autre feuille, ou une autre tranche : une etiquette en pointille.
        const cle = `${pos.fid}|${c.id}`;
        if (dejaAutres.has(cle) || dejaAutres.size > 3) return;
        dejaAutres.add(cle);
        const k = dejaAutres.size - 1;
        const ax = arrivee.x + 8;
        const ox = Math.max(4, ax - 96);
        const oy = Math.max(12, ay - 30 - k * 18);
        const nom = pos.fid !== etat.feuille ? titreFeuille(pos.fid) : 'autre choix';
        traits += `<path d="M${ox + 70},${oy} C${ax - 12},${oy} ${ax - 12},${ay} ${ax},${ay}" fill="none" style="stroke:${couleur}" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#${m})"/>` +
          `<rect x="${ox - 4}" y="${oy - 9}" width="76" height="17" rx="4" style="fill:var(--bg-primary);stroke:${couleur}"/>` +
          `<text x="${ox + 34}" y="${oy + 3.5}" text-anchor="middle" style="fill:${couleur}">${ech(nom.slice(0, 13))}</text>`;
        return;
      }
      const depart = ancre(table, c.id, pos.lettre, pos.n);
      if (!depart) return;
      const dy = depart.y + depart.h / 2;
      const tiret = depart.repliee ? ' stroke-dasharray="3 3"' : '';
      let d;
      if (Math.abs(depart.x - arrivee.x) < 1) {
        // Meme colonne : l'arc passe dans la marge gauche des cellules, a
        // l'ecart des chiffres alignes a droite.
        const x = arrivee.x + 12 + (i % 3) * 7;
        const bosse = x - 22 - (i % 3) * 6;
        d = `M${x},${dy} C${bosse},${dy} ${bosse},${ay} ${x - 2},${ay}`;
      } else {
        const versDroite = depart.x < arrivee.x;
        const sx = depart.x + (versDroite ? depart.w - 8 : 8);
        const ex = arrivee.x + (versDroite ? 10 : arrivee.w - 10);
        const mx = (sx + ex) / 2;
        d = `M${sx},${dy} C${mx},${dy} ${mx},${ay} ${ex},${ay}`;
      }
      const [x0, y0] = d.slice(1).split(' ')[0].split(',').map(Number);
      traits += `<path d="${d}" fill="none" style="stroke:${couleur}" stroke-width="1.6" stroke-opacity="0.9"${tiret} marker-end="url(#${m})"/>` +
        `<circle cx="${x0}" cy="${y0}" r="3" style="fill:${couleur}"/>`;
    });
    el.insertAdjacentHTML('beforeend', `<svg class="tb-fleches" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><defs>${defs}</defs>${traits}</svg>`);
  }
  // ------------------------------------------------------ barre de formule
  /** La cellule choisie : sa ligne, sa colonne, ses indices. */
  function celluleChoisie() {
    const id = etat.edition?.id ?? etat.choix.id;
    const l = id ? ligneDe(id) : null;
    if (!l) return null;
    const col = etat.edition?.col ?? etat.choix.col;
    const colonne = l.col.valeurs.find((/** @type {any} */ c) => c.lettre === col) ?? l.col.valeurs[0] ?? { v: undefined, lettre: 'B', etiquette: '' };
    return { l, g: l.g, colonne, indices: indicesDe(l, colonne), fid: l.g.domaine };
  }
  /** Contexte d'une cellule, pour la lire : feuille, colonne, choix du haut. @param {any} g @param {Record<string, any>} idx */
  function contexteCellule(g, idx) {
    return g.sur.map((/** @type {string} */ d) => etiquette(d, idx[d], idx)).filter(Boolean).join(' · ');
  }
  function rendreBarre() {
    const s = celluleChoisie();
    const zone = /** @type {HTMLInputElement} */ ($('tb-zone-nom'));
    if (!s) {
      if (document.activeElement !== zone) zone.value = '';
      $('tb-zone-libelle').textContent = '';
      $('tb-formule').textContent = 'Choisissez une cellule.';
      $('tb-formule').className = 'tb-formule tb-formule--vide';
      $('tb-btn-modifier').hidden = true;
      $('tb-btn-retablir').hidden = true;
      return;
    }
    const { l, g, colonne, indices } = s;
    const adresse = `${colonne.lettre}${l.n}`;
    if (document.activeElement !== zone) zone.value = g.sur.length ? adresse : g.id;
    const ctx = contexteCellule(g, indices);
    $('tb-zone-libelle').textContent = `${g.sur.length ? g.id : adresse} · ${g.libelle}${ctx ? ` · ${ctx}` : ''}`;
    if (etat.edition) return;
    const f = $('tb-formule');
    f.className = 'tb-formule';
    if (g.formule !== undefined) {
      let texte;
      let adresses = new Map();
      try {
        ({ texte, adresses } = texteFormule(g, indices));
      } catch {
        texte = g.formule;
      }
      f.innerHTML = htmlFormule(/** @type {string} */ (texte), { cibles: etat.cibles, adresses });
    } else {
      const { v } = lireCellule(g.id, indices);
      const t = enCellule(v, g.unite);
      f.textContent = t || 'Cellule vide';
      f.classList.add(t ? 'tb-formule--constante' : 'tb-formule--vide');
    }
    const surcharges = o.lireSurcharges() ?? {};
    $('tb-btn-modifier').hidden = g.formule === undefined;
    $('tb-btn-retablir').hidden = !(g.id in (surcharges.formules ?? {}));
  }

  // -------------------------------------- « Pourquoi ce chiffre ? » en blocs
  /** @type {{modele: any, map: Map<string, string[]>}|null} */
  let UTILISATIONS = null;
  /** Grandeurs dont la formule cite une grandeur : les liens dans l'autre sens. @param {string} id */
  function utilisationsDe(id) {
    if (!UTILISATIONS || UTILISATIONS.modele !== M) {
      const map = new Map();
      for (const g of M.grandeurs.values()) {
        if (g.cachee || g.formule === undefined) continue;
        try {
          compilerGrandeur(M, g);
        } catch {
          continue;
        }
        for (const nom of nomsCites(g.ast)) {
          if (nom === g.id || !M.grandeurs.has(nom)) continue;
          if (!map.has(nom)) map.set(nom, []);
          map.get(nom).push(g.id);
        }
      }
      UTILISATIONS = { modele: M, map };
    }
    return UTILISATIONS.map.get(id) ?? [];
  }
  /**
   * Un bloc : une grandeur citee, avec son libelle, ce qui la distingue de la
   * cellule expliquee (une autre feuille, une autre annee) et sa valeur. Un
   * bloc calcule se deroule en sa propre formule.
   * @param {any} n @param {any} ctx
   */
  function bloc(n, ctx) {
    const g = M.grandeurs.get(n.id);
    if (!g) return `<span class="tb-b-nb">${ech(n.id)}</span>`;
    const autres = Object.entries(n.dims ?? {}).filter(([d, x]) => ctx.indices[d] !== x);
    const contexte = [g.domaine !== ctx.fid ? titreFeuille(g.domaine) : '', ...autres.map(([d, x]) => etiquette(d, x, n.dims))]
      .filter(Boolean).join(' · ');
    const cle = `${n.id}|${JSON.stringify(n.dims ?? {})}`;
    const chemin = `${ctx.chemin}>${cle}`;
    const derouler = g.formule !== undefined && !n.horsDimension && ctx.profondeur < 6;
    const couleur = ctx.racine ? ctx.couleurs.get(n.id) : null;
    const ouvert = derouler && etat.deroules.has(chemin);
    if (ouvert && !ctx.sous.some((/** @type {any} */ s) => s.chemin === chemin)) ctx.sous.push({ id: n.id, dims: n.dims ?? {}, chemin, couleur });
    const natureV = modifiable(g) ? ' tb-bloc-val--saisie' : estLien(g) ? ' tb-bloc-val--lien' : '';
    const valeur = n.horsDimension ? 'hors dimension' : lisible(n.v, g.unite);
    const dims = ech(JSON.stringify(n.dims ?? {}));
    const attrs = derouler
      ? `data-tb-derouler="${ech(chemin)}" aria-expanded="${ouvert}" title="Dérouler : comment se calcule « ${ech(g.libelle)} »"`
      : `data-tb-aller="${ech(n.id)}" data-tb-dims="${dims}" title="Aller à la cellule"`;
    return `<button type="button" class="tb-bloc"${couleur ? ` style="--ref:${couleur}"` : ''} ${attrs} data-tb-survol="${ech(n.id)}" data-tb-survol-dims="${dims}">` +
      `<span class="tb-bloc-lib">${derouler ? `<i>${ouvert ? '▾' : '▸'}</i>` : ''}${ech(g.libelle)}</span>` +
      `${contexte ? `<span class="tb-bloc-ctx">${ech(contexte)}</span>` : ''}` +
      `<span class="tb-bloc-val${natureV}">${ech(valeur)}</span></button>`;
  }
  /** Un nom sans valeur : branche ecartee, ou corps generique d'un agregat. @param {any} n */
  function blocSansValeur(n) {
    const g = M.grandeurs.get(n.nom);
    if (!g) return `<span class="tb-b-var">${ech(M.dimensions.get(n.nom)?.libelle ?? n.nom)}</span>`;
    return `<span class="tb-bloc tb-bloc--structure"><span class="tb-bloc-lib">${ech(g.libelle)}</span></span>`;
  }
  /** @param {any} n @param {any} ctx @returns {string} */
  function blocsDe(n, ctx) {
    const r = (/** @type {any} */ m) => blocsDe(m, ctx);
    switch (n.t) {
      case 'nb': return `<span class="tb-b-nb">${ech(nombreExcel(n.v))}</span>`;
      case 'txt': return `<span class="tb-b-nb">"${ech(n.v)}"</span>`;
      case 'cst': return `<span class="tb-b-nb">${ech(n.nom ?? String(n.v))}</span>`;
      case 'neg': return `<span class="tb-b-op">−</span>${n.a.t === 'bin' ? `<span class="tb-b-groupe">${r(n.a)}</span>` : r(n.a)}`;
      case 'bin': {
        const p = PRIORITES[n.op];
        const cote = (/** @type {any} */ m, /** @type {boolean} */ droite) => {
          const q = m.t === 'bin' ? PRIORITES[m.op] : 9;
          const entourer = q < p || (q === p && ((droite && (n.op === '-' || n.op === '/')) || (!droite && n.op === '^')));
          return entourer ? `<span class="tb-b-groupe">${r(m)}</span>` : r(m);
        };
        return `${cote(n.a, false)}<span class="tb-b-op">${SYMBOLES[n.op] ?? ech(n.op)}</span>${cote(n.b, true)}`;
      }
      case 'var':
        return `<span class="tb-b-var">${ech(M.dimensions.get(n.nom)?.libelle ?? n.nom)} <b>${ech(etiquette(n.nom, n.v))}</b></span>`;
      case 'ref': return bloc(n, ctx);
      case 'nom': return blocSansValeur(n);
      case 'fn': return fonctionEnBlocs(n, ctx);
      case 'agr': return agregatEnBlocs(n, ctx);
      default: return '';
    }
  }
  /** @param {any} n @param {any} ctx */
  function fonctionEnBlocs(n, ctx) {
    const arg = (/** @type {any} */ a) => (a.ecarte ? `<span class="tb-b-ecarte" title="Sans objet ici">${blocsDe(a, ctx)}</span>` : blocsDe(a, ctx));
    if (n.nom === 'SI') {
      const test = n.args[0];
      const verdict = test && !test.ecarte && 'v' in test ? Boolean(test.v) : null;
      const cas = (/** @type {any} */ a, /** @type {string} */ mot, /** @type {boolean} */ retenu) =>
        `<span class="tb-si-mot">${mot}</span><span class="tb-si-cas${retenu ? '' : ' tb-si-cas--ecarte'}">${a ? blocsDe(a, ctx) : '<span class="tb-b-nb">FAUX</span>'}</span>`;
      return `<span class="tb-si"><span class="tb-si-mot">SI</span><span class="tb-si-cas">${blocsDe(test, ctx)}` +
        `${verdict === null ? '' : `<span class="tb-verdict tb-verdict--${verdict ? 'vrai' : 'faux'}">${verdict ? 'VRAI' : 'FAUX'}</span>`}</span>` +
        cas(n.args[1], 'valeur_si_vrai', verdict !== false) + cas(n.args[2], 'valeur_si_faux', verdict !== true) + '</span>';
    }
    const def = FONCTIONS[n.nom];
    const egal = 'v' in n && !['ET', 'OU', 'NON'].includes(n.nom) ? `<span class="tb-b-egal-petit">= ${ech(lisible(n.v))}</span>` : '';
    return `<span class="tb-fonction"><span class="tb-fn-nom" title="${ech(def?.aide ?? '')}">${ech(n.nom)}</span>` +
      `<span class="tb-fn-args">${n.args.map(arg).join('<span class="tb-b-sep">;</span>')}</span>${egal}</span>`;
  }
  /** @param {any} n @param {any} ctx */
  function agregatEnBlocs(n, ctx) {
    const def = AGREGATS[n.nom];
    const pour = n.parcours.map((/** @type {any} */ p) =>
      `<span class="tb-pour"><span class="tb-si-mot">POUR</span> ${ech(M.dimensions.get(p.variable)?.libelle ?? p.variable)}` +
      `${p.dans ? ` <span class="tb-si-mot">DANS</span> ${blocsDe(p.dans, ctx)}` : ''}` +
      `${p.quand ? ` <span class="tb-si-mot">QUAND</span> ${blocsDe(p.quand, ctx)}` : ''}</span>`).join('');
    const args = n.args.length ? `<span class="tb-b-sep">;</span>${n.args.map((/** @type {any} */ a) => blocsDe(a, ctx)).join('<span class="tb-b-sep">;</span>')}` : '';
    let termes = '';
    if (n.termes?.length) {
      const variable = n.parcours.length === 1 ? n.parcours[0].variable : null;
      const lignes = n.termes.slice(0, 60).map((/** @type {any} */ x) => {
        const cle = Array.isArray(x.cle)
          ? x.cle.map((/** @type {any} */ k, /** @type {number} */ i) => etiquette(n.parcours[i]?.variable, k)).join(' · ')
          : etiquette(/** @type {string} */ (variable), x.cle);
        const v = x.noeud?.t === 'ref' ? bloc(x.noeud, { ...ctx, racine: false, sous: [] }) : `<span class="tb-b-nb">${ech(lisible(x.part ?? x.v))}</span>`;
        return `<li><span>${ech(cle)}</span>${v}</li>`;
      });
      const reste = n.termes.length > 60 ? `<li><span>… ${n.termes.length - 60} de plus</span></li>` : '';
      termes = `<details class="tb-termes"><summary>${n.parcourus} terme${n.parcourus > 1 ? 's' : ''}</summary><ul>${lignes.join('')}${reste}</ul></details>`;
    }
    return `<span class="tb-fonction tb-fonction--agregat"><span class="tb-fn-nom" title="${ech(def?.aide ?? '')}">${ech(n.nom)}</span>` +
      `<span class="tb-fn-args">${blocsDe(n.corps, ctx)}${pour}${args}</span>` +
      `<span class="tb-b-egal-petit">= ${ech(lisible(n.v))}</span>${termes}</span>`;
  }
  /**
   * Une equation : la formule d'une cellule en blocs, puis, sous elle, celle de
   * chaque bloc qu'on a deroule.
   * @param {string} id @param {Record<string, any>} indices @param {string} chemin
   * @param {boolean} racine @param {string|null} couleur @param {number} [profondeur]
   * @returns {string}
   */
  function equation(id, indices, chemin, racine, couleur, profondeur = 0) {
    const g = M.grandeurs.get(id);
    if (!g || !C) return '';
    let e;
    try {
      e = C.expliquer(id, indices);
    } catch (x) {
      return `<p class="tb-alerte">${ech(/** @type {Error} */ (x).message)}</p>`;
    }
    if (!e.arbre) return '';
    const couleurs = new Map(racine ? etat.cibles.map((c) => [c.id, c.couleur]) : []);
    const ctx = { fid: g.domaine, indices, chemin, racine, sous: /** @type {any[]} */ ([]), profondeur, couleurs };
    const corps = blocsDe(e.arbre, ctx);
    const contexte = contexteCellule(g, indices);
    const tete = racine ? '' : `<div class="tb-eq-tete"><strong>${ech(g.libelle)}</strong>${contexte ? ` · ${ech(contexte)}` : ''}</div>`;
    let h = `<div class="tb-equation"${couleur ? ` style="--eq:${couleur}"` : ''}>${tete}<div class="tb-eq-corps">${corps}` +
      `<span class="tb-b-egal">=</span><span class="tb-b-resultat">${ech(lisible(e.v, g.unite))}</span></div>`;
    for (const s of ctx.sous) h += equation(s.id, s.dims, s.chemin, false, s.couleur, profondeur + 1);
    return h + '</div>';
  }
  /**
   * « Tout derouler » : jusqu'aux saisies, trois niveaux au plus, sans suivre
   * une grandeur vers sa propre annee precedente (cumuls, indexations).
   * @param {string} id @param {Record<string, any>} indices @param {string} chemin @param {number} profondeur
   */
  function toutDerouler(id, indices, chemin, profondeur) {
    if (profondeur >= 3 || !C) return;
    let e;
    try {
      e = C.expliquer(id, indices);
    } catch {
      return;
    }
    for (const c of ciblesDe(e.arbre).slice(0, 12)) {
      const g = M.grandeurs.get(c.id);
      if (!g || g.formule === undefined || c.id === id) continue;
      const ch = `${chemin}>${c.id}|${JSON.stringify(c.dims ?? {})}`;
      etat.deroules.add(ch);
      toutDerouler(c.id, c.dims ?? {}, ch, profondeur + 1);
    }
  }
  /**
   * Le panneau d'une cellule : sa valeur, son calcul en blocs, d'ou elle vient,
   * ce qui l'utilise, et ce qu'on peut y modifier.
   * @param {any} s  cellule choisie
   * @param {boolean} dansBoite  la boite ouverte depuis un autre ecran
   */
  function htmlPanneau(s, dansBoite = false) {
    if (!s) return '<p class="tb-meta">Choisissez une cellule de la feuille.</p>';
    const { l, g, colonne, indices } = s;
    const surcharges = o.lireSurcharges() ?? {};
    const { v, erreur, controle } = lireCellule(g.id, indices);
    const nat = nature(g);
    const niv = niveauDe(g);
    const contexte = [titreFeuille(g.domaine), contexteCellule(g, indices)].filter(Boolean).join(' · ');
    const classeNature = nat === 'saisie' || nat === 'parametre' ? 'tb-badge--saisie' : estLien(g) ? 'tb-badge--lien' : '';
    const meta = [`<code>${colonne.lettre}${l.n}</code>`, `nom <code>${ech(g.id)}</code>`];
    if (g.regle) meta.push(ech(g.regle));
    if (g.unite && UNITES[g.unite]) meta.push(ech(UNITES[g.unite]));
    let h = `<div class="tb-fiche-tete"><span class="tb-surtitre">${ech(contexte)}</span><h3>${ech(g.libelle)}</h3>` +
      `<div class="tb-valeur-exacte${typeof v === 'number' && v < 0 ? ' tb-val--negatif' : ''}">${ech(erreur ? (controle ? '—' : '#ERREUR') : lisible(v, g.unite))}</div>` +
      `<div class="tb-badges"><span class="tb-badge${niv === 'cle' ? ' tb-badge--cle' : ''}">${NIVEAUX[niv]}</span>` +
      `<span class="tb-badge ${classeNature}">${estLien(g) ? 'Lien vers une autre feuille' : NATURES[nat]}</span>` +
      `${g.ajoutee ? '<span class="tb-badge tb-badge--modifie">Ligne ajoutée</span>' : ''}</div>` +
      `<div class="tb-meta">${meta.join(' · ')}</div></div>`;
    if (erreur) h += `<p class="tb-alerte">${controle ? 'Contrôle du calcul : ' : ''}${ech(erreur)}</p>`;
    if (g.id in (surcharges.formules ?? {})) {
      const moteur = MODELE.grandeurs.get(g.id)?.formule;
      h += `<p class="tb-alerte">Formule modifiée dans le modèle. Celle du moteur : <code>${ech(moteur ? versExcel(moteur) : '')}</code></p>`;
    }
    if (g.formule !== undefined && !erreur) {
      let texte;
      let adresses = new Map();
      try {
        ({ texte, adresses } = texteFormule(g, indices));
      } catch {
        texte = g.formule;
      }
      const racine = `${g.id}|${JSON.stringify(indices)}`;
      h += `<section class="tb-rubrique"><div class="tb-rubrique-tete"><h4>Le calcul</h4><span>` +
        `<button type="button" class="tb-lien" data-tb-tout-derouler>Tout dérouler</button>` +
        `${etat.deroules.size ? ' · <button type="button" class="tb-lien" data-tb-tout-replier>Replier</button>' : ''}</span></div>` +
        `<div class="tb-texte-excel">${htmlFormule(/** @type {string} */ (texte), { cibles: etat.cibles, adresses })}</div>` +
        equation(g.id, indices, racine, true, null) +
        `<p class="tb-meta">Chaque bloc est une ligne du classeur, avec sa valeur. ▸ déroule sa propre formule ; un bloc sans flèche est une saisie ou une valeur lue.</p></section>`;
    } else if (g.formule === undefined) {
      const chemin = g.saisie ?? g.parametre ?? g.trajectoire ?? null;
      const ou = g.ecran ? ` Elle se règle à l’écran <strong>${ech(g.ecran)}</strong>.` : '';
      const tape = modifiable(g) && !dansBoite ? ' Tapez une nouvelle valeur dans la cellule bleue : l’aperçu chiffre l’impact, Entrée valide.' : '';
      h += `<section class="tb-rubrique"><h4>D’où vient la valeur</h4><p>${ech(NATURES[nat])}${chemin ? ` lu en <code>${ech(chemin)}</code>` : ''}.${ou}${tape}</p></section>`;
    }
    if (g.note) h += `<section class="tb-rubrique"><h4>À savoir</h4><p>${ech(g.note)}</p></section>`;
    const usages = utilisationsDe(g.id);
    if (usages.length) {
      const puces = usages.slice(0, 30).map((u) => {
        const cible = M.grandeurs.get(u);
        const dims = Object.fromEntries(cible.sur.filter((/** @type {string} */ d) => d in indices).map((/** @type {string} */ d) => [d, indices[d]]));
        return `<button type="button" class="tb-puce" data-tb-aller="${ech(u)}" data-tb-dims="${ech(JSON.stringify(dims))}">${ech(cible.libelle)}</button>`;
      });
      h += `<section class="tb-rubrique"><h4>Utilisé par</h4><div class="tb-liste-blocs">${puces.join('')}${usages.length > 30 ? `<span class="tb-meta">et ${usages.length - 30} autres</span>` : ''}</div></section>`;
    }
    if (dansBoite) {
      h += `<div class="tb-actions-panneau"><button type="button" class="bouton bouton--principal" data-tb-ouvrir-classeur>Ouvrir dans le classeur</button></div>`;
    } else {
      const options = Object.entries(NIVEAUX).map(([k, t]) => `<option value="${k}"${k === niv ? ' selected' : ''}>${t}</option>`).join('');
      h += `<div class="tb-actions-panneau">${g.formule !== undefined ? '<button type="button" class="bouton" data-tb-modifier>Modifier la formule</button>' : ''}` +
        `<button type="button" class="bouton bouton--discret" data-tb-inserer>Insérer une ligne en dessous</button>` +
        `<label class="tb-champ-importance" for="tb-importance">Importance<select id="tb-importance">${options}</select></label></div>`;
    }
    return h;
  }
  function rendrePanneau() {
    const p = $('tb-panneau');
    p.innerHTML = etat.insertion ? htmlInsertion() : htmlPanneau(celluleChoisie());
  }
  // ------------------------------------------------------------ bandeau
  /** @param {'info'|'erreur'} genre @param {string|null} html */
  function bandeau(genre, html) {
    const b = $('tb-bandeau');
    if (!html) {
      b.hidden = true;
      b.innerHTML = '';
      return;
    }
    b.hidden = false;
    b.className = `tb-bandeau tb-bandeau--${genre}`;
    b.innerHTML = html;
  }
  /** @param {'info'|'erreur'} genre @param {string|null} texte */
  const message = (genre, texte) => bandeau(genre, texte ? ech(texte) : null);

  // ---------------------------------------------- modifications du modele
  /** Formule en ecriture Excel, sans jamais echouer. @param {string} f */
  const excelSur = (f) => {
    try { return versExcel(f); } catch { return f; }
  };
  /**
   * Verifie des modifications avant de les enregistrer : le modele se monte,
   * et chaque grandeur touchee compile. Leve une erreur lisible sinon.
   * @param {any} s
   */
  function verifierSurcharges(s) {
    const m = modeleDe(s);
    const ids = [...Object.keys(s.formules ?? {}), ...(s.ajouts ?? []).map((/** @type {any} */ a) => a.id)];
    for (const id of ids) {
      try {
        compilerGrandeur(m, m.grandeur(id));
      } catch (e) {
        throw new Error(`${m.grandeur(id).libelle} : ${/** @type {Error} */ (e).message.replace(/^.*?: /, '')}`);
      }
    }
    return m;
  }
  /** Enregistre des modifications verifiees ; rend un message d'erreur, ou null. @param {any} s */
  function appliquer(s) {
    try {
      verifierSurcharges(s);
    } catch (e) {
      return /** @type {Error} */ (e).message;
    }
    o.ecrireSurcharges(sansSurcharge(s) ? {} : s);
    return null;
  }
  const copieSurcharges = () => structuredClone(o.lireSurcharges() ?? {});

  function rendreJournal() {
    const s = o.lireSurcharges() ?? {};
    const n = nombreSurcharges(s);
    const b = $('tb-bascule-journal');
    $('tb-compte-journal').textContent = String(n);
    b.dataset.actif = String(n > 0);
    const j = $('tb-journal');
    b.setAttribute('aria-expanded', String(!j.hidden));
    if (j.hidden) return;
    const voir = (/** @type {string} */ id) => `<button type="button" class="bouton bouton--discret" data-tb-aller="${ech(id)}" data-tb-dims="{}">Voir</button>`;
    /** @type {string[]} */
    const items = [];
    for (const [id, texte] of Object.entries(s.formules ?? {})) {
      const g = M.grandeurs.get(id);
      const moteur = MODELE.grandeurs.get(id)?.formule ?? '';
      items.push(`<li><span class="tb-quoi">Formule · ${ech(g?.libelle ?? id)} <span class="tb-meta">${ech(titreFeuille(g?.domaine ?? ''))}</span></span>` +
        `<span class="tb-journal-actions">${voir(id)}<button type="button" class="bouton bouton--discret" data-tb-retablir-formule="${ech(id)}">Rétablir</button></span>` +
        `<span class="tb-detail"><del>${ech(excelSur(moteur))}</del><br>→ ${ech(excelSur(/** @type {string} */ (texte)))}</span></li>`);
    }
    for (const a of s.ajouts ?? []) {
      const quoi = a.formule !== undefined && a.formule !== null ? excelSur(a.formule) : `valeur fixe ${lisible(a.constante, a.unite)}`;
      items.push(`<li><span class="tb-quoi">Ligne insérée · ${ech(a.libelle)} <span class="tb-meta">${ech(titreFeuille(a.domaine))}</span></span>` +
        `<span class="tb-journal-actions">${voir(a.id)}<button type="button" class="bouton bouton--discret" data-tb-retirer-ligne="${ech(a.id)}">Retirer</button></span>` +
        `<span class="tb-detail">nom ${ech(a.id)} · ${ech(quoi)}</span></li>`);
    }
    for (const [id, niv] of Object.entries(s.niveaux ?? {})) {
      const g = M.grandeurs.get(id);
      items.push(`<li><span class="tb-quoi">Importance · ${ech(g?.libelle ?? id)} <span class="tb-meta">${ech(titreFeuille(g?.domaine ?? ''))}</span></span>` +
        `<span class="tb-journal-actions">${voir(id)}<button type="button" class="bouton bouton--discret" data-tb-retablir-niveau="${ech(id)}">Rétablir</button></span>` +
        `<span class="tb-detail">${ech(NIVEAUX[/** @type {string} */ (niv)] ?? niv)}</span></li>`);
    }
    j.innerHTML = `<div class="tb-journal-tete"><h3>Modifications du modèle</h3>` +
      `<button type="button" class="bouton bouton--icone" data-tb-fermer-journal aria-label="Fermer">×</button></div>` +
      `<p class="tb-meta">Elles s’appliquent à tous les calculs de l’outil, dans ce navigateur. Exportez-les pour les transmettre :
        elles s’intègrent alors au moteur, et deviennent le modèle de tous.</p>` +
      (items.length ? `<ol>${items.join('')}</ol>` : '<p class="tb-vide">Aucune modification : le classeur est celui du moteur.</p>') +
      `<div class="tb-journal-pied">${items.length ? '<button type="button" class="bouton" data-tb-tout-retablir>Tout rétablir</button><button type="button" class="bouton" data-tb-exporter>Exporter</button>' : ''}` +
      `<label class="bouton bouton--discret" for="tb-importer">Importer<input type="file" id="tb-importer" accept="application/json,.json" hidden /></label></div>`;
  }
  /** @param {string} id */
  function retablirFormule(id) {
    const s = copieSurcharges();
    if (s.formules) delete s.formules[id];
    const erreur = appliquer(s);
    message(erreur ? 'erreur' : 'info', erreur ?? 'Formule du moteur rétablie : tout l’outil est recalculé.');
  }
  /** @param {string} id */
  function retirerLigne(id) {
    const usages = utilisationsDe(id);
    if (usages.length) {
      message('erreur', `« ${M.grandeurs.get(id)?.libelle ?? id} » est utilisée par ${usages.map((u) => `« ${M.grandeurs.get(u)?.libelle ?? u} »`).join(', ')} : retirez-la d’abord de ces formules.`);
      return;
    }
    const s = copieSurcharges();
    s.ajouts = (s.ajouts ?? []).filter((/** @type {any} */ a) => a.id !== id);
    if (s.niveaux) delete s.niveaux[id];
    if (etat.choix.id === id) etat.choix = { id: null, col: 'B' };
    const erreur = appliquer(s);
    message(erreur ? 'erreur' : 'info', erreur ?? 'Ligne retirée du modèle.');
  }
  /** @param {string} id */
  function retablirNiveau(id) {
    const s = copieSurcharges();
    if (s.niveaux) delete s.niveaux[id];
    appliquer(s);
  }
  function exporter() {
    const s = o.lireSurcharges() ?? {};
    const texte = JSON.stringify({ format: 'modifications-modele', version: 1, modifications: s }, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([texte], { type: 'application/json' }));
    a.download = 'modifications-modele.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
  }
  /** @param {File} fichier */
  async function importer(fichier) {
    try {
      const brut = JSON.parse(await fichier.text());
      const s = brut?.format === 'modifications-modele' ? brut.modifications : brut;
      if (!s || typeof s !== 'object') throw new Error('ce fichier ne contient pas de modifications du modèle');
      const erreur = appliquer(s);
      message(erreur ? 'erreur' : 'info', erreur ? `Import refusé : ${erreur}` : `${nombreSurcharges(s)} modification${nombreSurcharges(s) > 1 ? 's' : ''} importée${nombreSurcharges(s) > 1 ? 's' : ''} : tout l’outil est recalculé.`);
    } catch (e) {
      message('erreur', `Import impossible : ${/** @type {Error} */ (e).message}.`);
    }
  }

  // ----------------------------------------------------- inserer une ligne
  const UNITES_AJOUT = [['eur', '€'], ['taux', '%'], ['coef', 'coefficient'], ['nombre', 'nombre'], ['m2', 'm²'], ['eur_m2', '€/m²'], ['eur_m2_mois', '€/m²/mois'], ['annee', 'année']];
  /** Nom propose d'apres le libelle : minuscules sans accent, unique. @param {string} libelle */
  function nomPropose(libelle) {
    let n = sansAccents(libelle).replace(/[’']/g, ' ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!n) return '';
    if (!/^[a-z_]/.test(n)) n = `_${n}`;
    let essai = n;
    for (let k = 2; M.grandeurs.has(essai) || M.dimensions.has(essai); k++) essai = `${n}_${k}`;
    return essai;
  }
  /** @param {string} nom */
  function nomInvalide(nom) {
    if (!RE_IDENTIFIANT_GRANDEUR.test(nom)) return 'Un nom s’écrit en minuscules sans accent, chiffres et soulignés, et commence par une lettre (frais_assurance).';
    if (/^[a-z]{1,3}[0-9]+$/.test(nom)) return 'Ce nom ressemble à une adresse de cellule.';
    if (M.grandeurs.has(nom) || M.dimensions.has(nom)) return `Le nom ${nom} existe déjà.`;
    if (FONCTIONS[nom.toUpperCase()] || AGREGATS[nom.toUpperCase()] || ['vrai', 'faux', 'vide', 'pour', 'dans', 'quand', 'indefini', 'infini'].includes(nom)) return 'Ce nom est réservé.';
    return null;
  }
  function htmlInsertion() {
    const s = celluleChoisie();
    if (!s) return '<p class="tb-meta">Choisissez d’abord la ligne sous laquelle insérer.</p>';
    const options = UNITES_AJOUT.map(([k, t]) => `<option value="${k}"${k === s.g.unite ? ' selected' : ''}>${t}</option>`).join('');
    return `<form class="tb-formulaire" id="tb-form-insertion" novalidate>
      <div class="tb-fiche-tete"><span class="tb-surtitre">${ech(titreFeuille(s.fid))} · sous la ligne ${s.l.n}</span>
        <h3>Insérer une ligne</h3>
        <p class="tb-meta">Sous « ${ech(s.g.libelle)} », dans le tableau « ${ech(titreBloc(s.l))} ». Elle se décline comme lui ;
          comme dans Excel, les numéros des lignes suivantes se décalent, et les formules qui les citent par leur nom ne bougent pas.</p></div>
      <label class="tb-champ" for="tb-nl-libelle">Libellé<input id="tb-nl-libelle" required placeholder="Frais d’assurance" autocomplete="off" /></label>
      <label class="tb-champ" for="tb-nl-nom">Nom<input id="tb-nl-nom" required placeholder="frais_assurance" autocomplete="off" spellcheck="false" />
        <small>Proposé d’après le libellé ; c’est lui qu’on tape dans les formules.</small></label>
      <fieldset class="tb-choix-nature"><legend>Nature</legend>
        <label for="tb-nl-formule"><input type="radio" name="tb-nature" id="tb-nl-formule" value="formule" checked /> Formule</label>
        <label for="tb-nl-constante"><input type="radio" name="tb-nature" id="tb-nl-constante" value="constante" /> Valeur fixe du modèle</label>
      </fieldset>
      <label class="tb-champ" for="tb-nl-valeur" id="tb-nl-valeur-champ" hidden>Valeur<input id="tb-nl-valeur" inputmode="decimal" placeholder="0,2 %" autocomplete="off" /></label>
      <div class="tb-deux">
        <label class="tb-champ" for="tb-nl-unite">Unité<select id="tb-nl-unite">${options}</select></label>
        <label class="tb-champ" for="tb-nl-niveau">Importance<select id="tb-nl-niveau">
          <option value="etape">Étape</option><option value="technique">Détail technique</option><option value="cle">Résultat clé</option></select></label>
      </div>
      <p class="tb-alerte" id="tb-nl-erreur" hidden></p>
      <div class="tb-actions-panneau"><button type="submit" class="bouton bouton--principal">Insérer</button>
        <button type="button" class="bouton" data-tb-annuler-insertion>Annuler</button></div>
    </form>`;
  }
  /** Lit une valeur tapee a la francaise : 2,5 ; 3 % ; VRAI. @param {string} texte @param {string} [unite] */
  function lireSaisie(texte, unite) {
    const t = texte.trim().replace(/[\s  ]/g, '');
    if (t === '') return null;
    const u = t.toUpperCase();
    if (u === 'VRAI') return true;
    if (u === 'FAUX') return false;
    const x = Number(t.replace('%', '').replace(',', '.'));
    if (!Number.isFinite(x)) return unite === 'texte' ? texte.trim() : undefined;
    return t.endsWith('%') || unite === 'taux' ? x / 100 : x;
  }
  function insererLigne() {
    const s = celluleChoisie();
    if (!s) return;
    const libelle = /** @type {HTMLInputElement} */ ($('tb-nl-libelle')).value.trim();
    const nom = /** @type {HTMLInputElement} */ ($('tb-nl-nom')).value.trim();
    const natureAjout = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="tb-nature"]:checked'))?.value ?? 'formule';
    const unite = /** @type {HTMLSelectElement} */ ($('tb-nl-unite')).value;
    const niveau = /** @type {HTMLSelectElement} */ ($('tb-nl-niveau')).value;
    const erreurEl = $('tb-nl-erreur');
    const refus = (/** @type {string} */ t) => {
      erreurEl.textContent = t;
      erreurEl.hidden = false;
    };
    if (!libelle) return refus('Donnez un libellé à la ligne.');
    const invalide = nomInvalide(nom);
    if (invalide) return refus(invalide);
    /** @type {any} */
    const ajout = { id: nom, domaine: s.fid, apres: s.g.id, libelle, unite, sur: s.g.sur, niveau };
    if (natureAjout === 'constante') {
      const v = lireSaisie(/** @type {HTMLInputElement} */ ($('tb-nl-valeur')).value, unite);
      if (v === undefined || v === null) return refus('Tapez la valeur, par exemple 0,2 % ou 1 500.');
      ajout.constante = v;
    } else ajout.formule = 'VIDE';
    const sur = copieSurcharges();
    sur.ajouts = [...(sur.ajouts ?? []), ajout];
    const erreur = appliquer(sur);
    if (erreur) return refus(erreur);
    etat.insertion = false;
    etat.choix = { id: nom, col: s.colonne.lettre };
    etat.defiler = true;
    if (natureAjout === 'formule') {
      etat.apresRendu = () => commencerEdition(true);
    } else {
      message('info', `Ligne « ${libelle} » insérée. Citez ${nom} dans une formule pour qu’elle compte.`);
    }
  }

  // ------------------------------------------------------------ rendu
  /** Relit le classeur du dernier calcul et le modele qu'il a utilise. */
  function rafraichirDonnees() {
    C = o.lireClasseur();
    const surcharges = o.lireSurcharges();
    try {
      M = C?.modele ?? modeleDe(surcharges);
    } catch {
      M = MODELE;
    }
    DISPOSITIONS = new Map();
    etat.surchargees = new Set([...Object.keys(surcharges?.formules ?? {}), ...(surcharges?.ajouts ?? []).map((/** @type {any} */ a) => a.id)]);
  }
  /** La premiere valeur cle de la feuille, pour ne jamais ouvrir sur une cellule vide. */
  function choixParDefaut() {
    const d = etat.feuille ? disposition(etat.feuille) : null;
    const memo = etat.feuille ? etat.parFeuille[etat.feuille] : null;
    if (memo?.id && ligneDe(memo.id)) return memo;
    const l = d?.lignes.find((/** @type {any} */ x) => x.type === 'grandeur' && niveauDe(x.g) === 'cle') ??
      d?.lignes.find((/** @type {any} */ x) => x.type === 'grandeur');
    return { id: l?.g.id ?? null, col: 'B' };
  }
  function ciblesChoisies() {
    const s = celluleChoisie();
    if (!s || !C || s.g.formule === undefined) return [];
    try {
      return ciblesDe(C.expliquer(s.g.id, s.indices).arbre);
    } catch {
      return [];
    }
  }
  /** Redessine l'ecran, sans relire le calcul. */
  function rendreVue() {
    poserSquelette();
    const fs = feuilles();
    if (!etat.feuille || !fs.some((/** @type {any} */ f) => f.id === etat.feuille)) {
      etat.feuille = fs.find((/** @type {any} */ f) => f.id === 'exploitation')?.id ?? fs[0]?.id ?? null;
    }
    if (!etat.choix.id || !ligneDe(etat.choix.id) || ligneDe(etat.choix.id).g.domaine !== etat.feuille) etat.choix = choixParDefaut();
    if (etat.feuille) etat.parFeuille[etat.feuille] = { ...etat.choix };
    if (!etat.edition) etat.cibles = ciblesChoisies();
    for (const b of document.querySelectorAll('[data-tb-niveau]')) b.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (b).dataset.tbNiveau === etat.niveau));
    for (const b of document.querySelectorAll('[data-tb-refs]')) b.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (b).dataset.tbRefs === etat.refs));
    $('tb-fleches').setAttribute('aria-pressed', String(etat.fleches));
    rendreOnglets();
    rendreFiltres();
    try {
      rendreFeuille();
    } catch (e) {
      // Une feuille qui ne se dessine pas le dit, plutot que de rester blanche.
      $('tb-feuille').innerHTML = `<p class="tb-alerte">Cette feuille ne s’affiche pas : ${ech(/** @type {Error} */ (e).message)}</p>`;
      console.error(e);
    }
    surligner();
    rendreBarre();
    rendrePanneau();
    rendreJournal();
    dessinerFleches();
    if (etat.defiler) {
      $('tb-feuille').querySelector('.tb-val--choisie')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      etat.defiler = false;
    }
    const suite = etat.apresRendu;
    etat.apresRendu = null;
    suite?.();
  }
  /**
   * Choisit une cellule : sa feuille s'affiche, son groupe de lignes se
   * deplie, les choix du haut de la feuille suivent ses indices.
   * @param {string} id @param {string} col @param {boolean} [defiler]
   */
  function choisir(id, col, defiler = false) {
    const g = M.grandeurs.get(id);
    if (!g) return;
    if (etat.choix.id !== id || etat.choix.col !== col) etat.deroules = new Set();
    etat.feuille = g.domaine;
    etat.choix = { id, col };
    etat.insertion = false;
    deplierPour(id);
    etat.defiler = defiler;
    rendreVue();
  }
  /**
   * Va a une cellule designee par sa grandeur et ses indices : les choix du
   * haut de sa feuille prennent ses valeurs, pour qu'elle soit affichee.
   * @param {string} id @param {Record<string, any>} [dims]
   */
  function aller(id, dims = {}) {
    const g = M.grandeurs.get(id);
    if (!g || g.cachee) return;
    const courant = celluleChoisie();
    /** @type {Record<string, any>} */
    const idx = {};
    for (const d of g.sur) idx[d] = d in dims ? dims[d] : courant?.indices[d] ?? filtre(d, idx);
    const dc = dimColonne(g.sur);
    for (const d of g.sur) if (d !== dc) etat.filtres[d] = idx[d];
    DISPOSITIONS = new Map();
    const pos = positionDe(id, idx);
    message(null, null);
    choisir(id, pos?.lettre ?? 'B', true);
  }

  // ---------------------------------------------------- apercu de l'impact
  /** Les indicateurs que l'apercu chiffre avant chaque validation. */
  const SUIVIS = /** @type {Array<[string, Record<string, any>]>} */ ([
    ['total_ttc_module', {}],
    ['loyers_annuels_operation', {}],
    ['fonds_propres_total', {}],
    ['besoin_maximal', {}],
    ['autofinancement_perimetre_horizon', { perimetre: 'operation' }],
    ['resultat_cumule_final', { perimetre: 'operation' }],
  ]);
  let minuterieApercu = 0;
  /**
   * Calcule a blanc, puis compare les indicateurs suivis a ceux du calcul en
   * cours : rien ne change tant qu'on n'a pas valide.
   * @param {() => any} simuler @param {{id: string, indices: Record<string, any>}|null} cellule
   */
  function apercu(simuler, cellule) {
    clearTimeout(minuterieApercu);
    minuterieApercu = window.setTimeout(() => {
      let c2;
      try {
        c2 = simuler();
      } catch (e) {
        bandeau('erreur', `<strong>${ech(/** @type {Error} */ (e).message)}</strong> La modification ne peut pas être appliquée.`);
        return;
      }
      const lignes = [...(cellule ? [[cellule.id, cellule.indices]] : []), ...SUIVIS.filter(([id]) => id !== cellule?.id)];
      const items = lignes.map(([id, idx]) => {
        const g = c2.modele.grandeurs.get(id) ?? M.grandeurs.get(id);
        if (!g) return '';
        const avant = lireCellule(/** @type {string} */ (id), /** @type {any} */ (idx)).v;
        let apres;
        try {
          apres = c2.valeur(id, idx);
        } catch {
          apres = undefined;
        }
        const nombres = typeof avant === 'number' && typeof apres === 'number';
        const change = nombres ? Math.abs(apres - avant) > 1e-9 : avant !== apres;
        const delta = nombres && change ? `<span class="tb-delta">${apres > avant ? '+' : '−'}${ech(lisible(Math.abs(apres - avant), g.unite))}</span>` : '';
        return `<span class="tb-impact${change ? '' : ' tb-impact--inchange'}"><strong>${ech(g.libelle)}</strong> ` +
          `<span class="tb-mono">${ech(lisible(avant, g.unite))}</span>` +
          (change ? ` → <span class="tb-mono">${ech(lisible(apres, g.unite))}</span> ${delta}` : ' <span class="tb-meta">inchangé</span>') + '</span>';
      });
      bandeau('info', `<span class="tb-apercu-titre">Aperçu avant validation</span>${items.join('')}<span class="tb-meta">Entrée valide · Échap annule</span>`);
    }, 180);
  }

  // ------------------------------------------------ saisie dans une cellule
  /** @param {string} [premier] premier caractere tape */
  function editerCellule(premier) {
    const s = celluleChoisie();
    if (!s || !modifiable(s.g) || etat.edition) return false;
    const td = $('tb-feuille').querySelector(`[data-tb-cell="${s.colonne.lettre}|${CSS.escape(s.g.id)}"]`);
    if (!td) return false;
    const actuelle = lireCellule(s.g.id, s.indices).v;
    const initial = premier ?? (actuelle === null || actuelle === undefined ? '' : enCellule(actuelle, s.g.unite));
    td.innerHTML = `<input id="tb-saisie-cellule" value="${ech(initial)}" aria-label="Nouvelle valeur de ${ech(s.g.libelle)}" autocomplete="off" />`;
    const input = /** @type {HTMLInputElement} */ (td.querySelector('input'));
    input.focus();
    if (premier === undefined) input.select();
    else input.setSelectionRange(initial.length, initial.length);
    etat.saisieCellule = true;
    const previsualiser = () => {
      const v = lireSaisie(input.value, s.g.unite);
      if (v === undefined) {
        bandeau('erreur', `<strong>« ${ech(input.value)} » n’est pas un nombre.</strong> Tapez par exemple 2,5 ou 3 %.`);
        return;
      }
      apercu(() => o.simuler({ cellule: { g: s.g, indices: s.indices, v } }), { id: s.g.id, indices: s.indices });
    };
    input.addEventListener('input', previsualiser);
    if (premier !== undefined) previsualiser();
    const finir = (/** @type {boolean} */ garder) => {
      if (!etat.saisieCellule) return;
      etat.saisieCellule = false;
      clearTimeout(minuterieApercu);
      const v = garder ? lireSaisie(input.value, s.g.unite) : actuelle;
      if (!garder || v === undefined || v === actuelle) {
        message(garder && v === undefined ? 'erreur' : 'info', garder && v === undefined ? `« ${input.value} » n’est pas un nombre : la valeur ne change pas.` : null);
        rendreVue();
        $('tb-feuille').focus();
        return;
      }
      const erreur = o.ecrireCellule(s.g, s.indices, v);
      message(erreur ? 'erreur' : 'info', erreur ?? `${s.g.libelle} vaut maintenant ${lisible(v, s.g.unite)} : tout l’outil est recalculé.`);
      $('tb-feuille').focus();
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finir(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); finir(false); }
    });
    input.addEventListener('blur', () => finir(true));
    return true;
  }

  // ------------------------------------------------ edition d'une formule
  const saisieF = () => /** @type {HTMLInputElement} */ ($('tb-saisie-formule'));
  /** Le texte tape, en formule interne. @param {any} e @param {string} brut */
  const formuleTapee = (e, brut) => depuisExcel(brut, { reference: (r) => resoudreReference(r, e) });
  /** Les modifications du modele, avec la formule tapee pour la ligne en cours. @param {any} e @param {string} interne */
  function surchargesAvec(e, interne) {
    const s = copieSurcharges();
    const ajout = (s.ajouts ?? []).find((/** @type {any} */ a) => a.id === e.id);
    if (ajout) {
      ajout.formule = interne;
      delete ajout.constante;
      return s;
    }
    s.formules = { ...(s.formules ?? {}) };
    const moteur = MODELE.grandeurs.get(e.id)?.formule;
    if (moteur !== undefined && analyserSur(moteur) === analyserSur(interne)) delete s.formules[e.id];
    else s.formules[e.id] = interne;
    return s;
  }
  /** Empreinte d'une formule, pour reconnaitre celle du moteur quelle que soit son ecriture. @param {string} f */
  const analyserSur = (f) => {
    try { return JSON.stringify(analyser(f)); } catch { return f; }
  };
  /** Grandeurs citees par une formule tapee, pour les colorer et les flecher. @param {any} e @param {string} interne */
  function ciblesTapees(e, interne) {
    /** @type {Array<{id: string, dims: Record<string, any>}>} */
    const refs = [];
    const tour = (/** @type {any} */ n) => {
      if (!n || typeof n !== 'object') return;
      if (n.t === 'nom' && M.grandeurs.has(n.nom) && !n.index) {
        const g = M.grandeurs.get(n.nom);
        if (g.sur.every((/** @type {string} */ d) => d in e.indices)) refs.push({ id: n.nom, dims: Object.fromEntries(g.sur.map((/** @type {string} */ d) => [d, e.indices[d]])) });
      }
      for (const v of Object.values(n)) {
        if (Array.isArray(v)) v.forEach(tour);
        else if (v && typeof v === 'object') tour(v);
      }
    };
    try {
      tour(analyser(interne));
    } catch {
      return [];
    }
    const couleurs = new Map();
    return refs.map((r) => {
      if (!couleurs.has(r.id)) couleurs.set(r.id, `var(--cat-${(couleurs.size % 6) + 1})`);
      return { ...r, couleur: couleurs.get(r.id) };
    });
  }
  /** @param {boolean} [vierge] */
  function commencerEdition(vierge = false) {
    if (etat.edition) return;
    const s = celluleChoisie();
    if (!s) return;
    if (s.g.formule === undefined) {
      message('info', s.g.ecran
        ? `Cette valeur n’est pas une formule : elle se règle à l’écran ${s.g.ecran}${modifiable(s.g) ? ', ou se tape dans sa cellule bleue' : ''}.`
        : 'Cette valeur n’est pas une formule.');
      return;
    }
    etat.insertion = false;
    etat.edition = { id: s.g.id, g: s.g, col: s.colonne.lettre, fid: s.fid, indices: s.indices, dimCol: s.l.col.dim };
    $('tb-barre').classList.add('tb-barre--edition');
    const f = saisieF();
    let texte = '=';
    if (!vierge && s.g.formule !== 'VIDE') {
      try {
        texte = /** @type {string} */ (texteFormule(s.g, s.indices).texte);
      } catch {
        texte = `=${s.g.formule}`;
      }
    }
    f.value = texte;
    $('tb-btn-modifier').hidden = true;
    $('tb-btn-retablir').hidden = true;
    $('tb-btn-valider').hidden = false;
    $('tb-btn-annuler').hidden = false;
    f.focus();
    f.setSelectionRange(f.value.length, f.value.length);
    surFrappe();
    if (f.value === '=') {
      bandeau('info', '<strong>Écrivez la formule.</strong> Cliquez une cellule pour la citer, même sur une autre feuille ; tapez les premières lettres d’un nom ou d’une fonction pour les compléter.');
    }
  }
  function surFrappe() {
    const e = etat.edition;
    if (!e) return;
    let interne = null;
    let erreur = null;
    try {
      interne = formuleTapee(e, saisieF().value);
      verifierSurcharges(surchargesAvec(e, interne));
    } catch (x) {
      erreur = /** @type {Error} */ (x).message;
    }
    etat.cibles = interne ? ciblesTapees(e, interne) : [];
    rendreFeuille();
    surligner();
    dessinerFleches();
    suggestions();
    if (erreur || interne === null) {
      clearTimeout(minuterieApercu);
      bandeau('info', `<strong>Formule en cours.</strong> ${ech(erreur ?? '')}`);
      return;
    }
    const s = surchargesAvec(e, interne);
    apercu(() => o.simuler({ surcharges: s }), { id: e.id, indices: e.indices });
  }
  function finirEdition() {
    const e = etat.edition;
    etat.edition = null;
    clearTimeout(minuterieApercu);
    $('tb-barre').classList.remove('tb-barre--edition');
    fermerSuggestions();
    $('tb-btn-valider').hidden = true;
    $('tb-btn-annuler').hidden = true;
    if (e) {
      etat.feuille = e.fid;
      etat.choix = { id: e.id, col: e.col };
    }
  }
  function annulerEdition() {
    finirEdition();
    message(null, null);
    rendreVue();
    $('tb-feuille').focus();
  }
  function validerEdition() {
    const e = etat.edition;
    if (!e) return;
    let s;
    try {
      s = surchargesAvec(e, formuleTapee(e, saisieF().value));
      o.simuler({ surcharges: s });
    } catch (x) {
      bandeau('erreur', `<strong>${ech(/** @type {Error} */ (x).message)}</strong> La formule n’est pas appliquée.`);
      return;
    }
    finirEdition();
    const erreur = appliquer(s);
    const colonnes = ligneDe(e.id)?.col.valeurs ?? [];
    message(erreur ? 'erreur' : 'info', erreur ?? (colonnes.length > 1
      ? `Formule appliquée à toute la ligne, de ${colonnes[0].lettre} à ${colonnes.at(-1).lettre} : le moteur calcule désormais avec elle, sur tout l’outil. Elle figure dans les modifications du modèle.`
      : 'Formule appliquée : le moteur calcule désormais avec elle, sur tout l’outil. Elle figure dans les modifications du modèle.'));
    $('tb-feuille').focus();
  }
  /** Clic sur une cellule pendant la frappe : sa reference s'insere au curseur. @param {string} col @param {string} id */
  function insererReference(col, id) {
    const e = etat.edition;
    const l = ligneDe(id);
    const colonne = l?.col.valeurs.find((/** @type {any} */ c) => c.lettre === col);
    if (!e || !l || !colonne) return;
    const ref = texteInsere({ fid: l.g.domaine, l, g: l.g, colonne, indices: indicesDe(l, colonne) }, e);
    const f = saisieF();
    const debut = f.selectionStart ?? f.value.length;
    const fin = f.selectionEnd ?? debut;
    f.value = f.value.slice(0, debut) + ref + f.value.slice(fin);
    const p = debut + ref.length;
    f.focus();
    f.setSelectionRange(p, p);
    surFrappe();
  }
  // ------------------------------------------------------------ completion
  function fermerSuggestions() {
    const l = $('tb-suggestions');
    l.hidden = true;
    l.innerHTML = '';
    etat.sugg = null;
  }
  function suggestions() {
    if (!etat.edition) return fermerSuggestions();
    const f = saisieF();
    const pos = f.selectionStart ?? f.value.length;
    const m = /[A-Za-zÀ-ÿ_][A-Za-zÀ-ÿ0-9_.]*$/.exec(f.value.slice(0, pos));
    if (!m || /^[A-Z]{1,3}\d+$/.test(m[0])) return fermerSuggestions();
    const mot = m[0];
    const q = mot.toUpperCase();
    const qs = sansAccents(mot);
    const fonctions = [...new Set([...Object.keys(FONCTIONS), ...Object.keys(AGREGATS)])]
      .filter((k) => k.startsWith(q))
      .map((k) => ({ type: 'ƒ', texte: `${k}(`, libelle: (FONCTIONS[k] ?? AGREGATS[k])?.aide ?? '' }));
    const noms = [...M.grandeurs.values()]
      .filter((g) => !g.cachee && (g.id.startsWith(qs) || (qs.length > 2 && sansAccents(g.libelle).includes(qs))))
      .slice(0, 12)
      .map((g) => ({ type: '●', texte: g.id, libelle: `${g.libelle} · ${titreFeuille(g.domaine)}` }));
    const items = [...fonctions, ...noms].slice(0, 10);
    if (!items.length || (items.length === 1 && items[0].texte === mot)) return fermerSuggestions();
    etat.sugg = { items, index: 0, debut: pos - mot.length, fin: pos };
    const l = $('tb-suggestions');
    l.innerHTML = items
      .map((it, i) => `<li role="option" id="tb-sugg-${i}" aria-selected="${i === 0}" data-tb-sugg="${i}"><span>${it.type}</span>` +
        `<span class="tb-mono">${ech(it.texte)}</span><small>${ech(it.libelle)}</small></li>`)
      .join('');
    l.hidden = false;
  }
  /** @param {number} i */
  function insererSuggestion(i) {
    const { items, debut, fin } = etat.sugg;
    const texte = items[i].texte;
    const f = saisieF();
    f.value = f.value.slice(0, debut) + texte + f.value.slice(fin);
    const p = debut + texte.length;
    f.focus();
    f.setSelectionRange(p, p);
    fermerSuggestions();
    surFrappe();
  }

  // -------------------------------------------------------------- zone Nom
  const zoneNom = () => /** @type {HTMLInputElement} */ ($('tb-zone-nom'));
  function suggestionsNoms() {
    const qs = sansAccents(zoneNom().value.trim());
    const items = qs.length < 2 ? [] : [...M.grandeurs.values()]
      .filter((g) => !g.cachee && (g.id.includes(qs) || sansAccents(g.libelle).includes(qs)))
      .slice(0, 12);
    etat.suggNoms = { items, index: 0 };
    const l = $('tb-liste-noms');
    l.innerHTML = items
      .map((g, i) => `<li role="option" id="tb-nom-${i}" aria-selected="${i === 0}" data-tb-nom="${i}"><span>●</span>` +
        `<span class="tb-mono">${ech(g.id)}</span><small>${ech(g.libelle)} · ${ech(titreFeuille(g.domaine))}</small></li>`)
      .join('');
    l.hidden = !items.length;
  }
  function quitterZoneNom() {
    $('tb-liste-noms').hidden = true;
    zoneNom().blur();
  }
  /** Une adresse (C21, 'Loyers'!D5), un nom ou un libelle tape dans la zone Nom. @param {string} texte */
  function allerSaisie(texte) {
    const t = texte.trim();
    const m = /^(?:'((?:[^']|'')+)'!|([^'!]+)!)?\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(t);
    if (m) {
      try {
        const c = celluleA(m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2] ?? null, m[3].toUpperCase(), Number(m[4]), /** @type {string} */ (etat.feuille));
        quitterZoneNom();
        aller(c.g.id, c.indices);
      } catch (e) {
        message('erreur', /** @type {Error} */ (e).message);
      }
      return;
    }
    const g = M.grandeurs.get(t) ?? [...M.grandeurs.values()].find((x) => !x.cachee && sansAccents(x.libelle) === sansAccents(t));
    if (g && !g.cachee) {
      quitterZoneNom();
      aller(g.id);
      return;
    }
    message('erreur', `« ${t} » n’est ni une adresse ni un nom. Tapez quelques lettres d’un libellé pour chercher.`);
  }

  // --------------------------------------------------------------- clavier
  /** @param {number} dLigne @param {number} dCol */
  function deplacer(dLigne, dCol) {
    const s = celluleChoisie();
    if (!s) return;
    let id = s.g.id;
    let col = s.colonne.lettre;
    if (dLigne) {
      const i = etat.visibles.indexOf(id);
      id = etat.visibles[Math.max(0, Math.min(etat.visibles.length - 1, (i < 0 ? 0 : i) + dLigne))] ?? id;
      const vals = ligneDe(id)?.col.valeurs ?? [];
      if (!vals.some((/** @type {any} */ c) => c.lettre === col)) col = vals.at(-1)?.lettre ?? 'B';
    }
    if (dCol) {
      const vals = ligneDe(id)?.col.valeurs ?? [];
      const k = vals.findIndex((/** @type {any} */ c) => c.lettre === col);
      col = vals[Math.max(0, Math.min(vals.length - 1, k + dCol))]?.lettre ?? col;
    }
    message(null, null);
    choisir(id, col, true);
  }

  // ---------------------------------------- boite « Pourquoi ce chiffre ? »
  /**
   * Ouvre l'explication d'un chiffre de l'outil sans quitter son ecran.
   * @param {string} id @param {Record<string, any>} indices
   */
  function ouvrirBoite(id, indices) {
    rafraichirDonnees();
    const g = M.grandeurs.get(id);
    const boite = /** @type {HTMLDialogElement|null} */ (document.getElementById('boite-formule'));
    const corps = document.getElementById('tb-boite-corps');
    const l = g ? ligneDe(id) : null;
    if (!g || !l || !boite || !corps) return;
    /** @type {Record<string, any>} */
    const idx = {};
    for (const d of g.sur) idx[d] = indices?.[d] !== undefined ? indices[d] : filtre(d, idx);
    const pos = positionDe(id, idx);
    const colonne = { ...(l.col.valeurs[0] ?? { v: null }), lettre: pos?.lettre ?? 'B' };
    if (etat.boite?.id !== id || JSON.stringify(etat.boite?.indices) !== JSON.stringify(idx)) etat.deroules = new Set();
    etat.boite = { id, indices: idx };
    const sauve = etat.cibles;
    try {
      etat.cibles = C && g.formule !== undefined ? ciblesDe(C.expliquer(id, idx).arbre) : [];
    } catch {
      etat.cibles = [];
    }
    corps.innerHTML = htmlPanneau({ l, g, colonne, indices: idx, fid: g.domaine }, true);
    etat.cibles = sauve;
    if (!boite.open) boite.showModal();
  }

  // ------------------------------------------------------------- ecouteurs
  poserSquelette();
  const hote = /** @type {HTMLElement} */ (document.getElementById('tableur'));

  hote?.addEventListener('mousedown', (ev) => {
    // Pendant la frappe d'une formule, la barre garde le curseur : un clic sur
    // une cellule insere sa reference, comme dans Excel.
    const t = /** @type {Element} */ (ev.target);
    if (etat.edition && t.closest?.('td.tb-val[data-tb-cell]')) ev.preventDefault();
  });
  hote?.addEventListener('click', (ev) => {
    const t = /** @type {Element} */ (ev.target);
    if (!(t instanceof Element)) return;
    const d = /** @type {HTMLElement|null} */ (t.closest('[data-tb-deplier]'));
    if (d) { etat.ouverts.add(d.dataset.tbDeplier); rendreVue(); return; }
    const r = /** @type {HTMLElement|null} */ (t.closest('[data-tb-replier]'));
    if (r) { etat.ouverts.delete(r.dataset.tbReplier); rendreVue(); return; }
    const onglet = /** @type {HTMLElement|null} */ (t.closest('[data-tb-onglet]'));
    if (onglet) {
      const fid = /** @type {string} */ (onglet.dataset.tbOnglet);
      if (etat.edition) {
        // Changer de feuille pendant la frappe sert a citer une cellule d'une
        // autre feuille : la formule en cours reste ouverte.
        etat.feuille = fid;
        rendreOnglets();
        rendreFiltres();
        rendreFeuille();
        surligner();
        dessinerFleches();
        saisieF().focus();
        return;
      }
      message(null, null);
      etat.feuille = fid;
      etat.choix = choixParDefaut();
      etat.deroules = new Set();
      rendreVue();
      return;
    }
    const niv = /** @type {HTMLElement|null} */ (t.closest('[data-tb-niveau]'));
    if (niv) { etat.niveau = /** @type {string} */ (niv.dataset.tbNiveau); if (etat.choix.id) deplierPour(etat.choix.id); rendreVue(); return; }
    const refs = /** @type {HTMLElement|null} */ (t.closest('[data-tb-refs]'));
    if (refs) { if (!etat.edition) { etat.refs = /** @type {string} */ (refs.dataset.tbRefs); rendreVue(); } return; }
    if (t.closest('#tb-fleches')) { etat.fleches = !etat.fleches; rendreVue(); return; }
    if (t.closest('#tb-bascule-journal')) { $('tb-journal').hidden = !$('tb-journal').hidden; rendreJournal(); return; }
    if (t.closest('[data-tb-fermer-journal]')) { $('tb-journal').hidden = true; rendreJournal(); return; }
    const rf = /** @type {HTMLElement|null} */ (t.closest('[data-tb-retablir-formule]'));
    if (rf) { retablirFormule(/** @type {string} */ (rf.dataset.tbRetablirFormule)); return; }
    const rl = /** @type {HTMLElement|null} */ (t.closest('[data-tb-retirer-ligne]'));
    if (rl) { retirerLigne(/** @type {string} */ (rl.dataset.tbRetirerLigne)); return; }
    const rn = /** @type {HTMLElement|null} */ (t.closest('[data-tb-retablir-niveau]'));
    if (rn) { retablirNiveau(/** @type {string} */ (rn.dataset.tbRetablirNiveau)); return; }
    if (t.closest('[data-tb-tout-retablir]')) {
      appliquer({});
      message('info', 'Toutes les modifications sont rétablies : le classeur est celui du moteur.');
      return;
    }
    if (t.closest('[data-tb-exporter]')) { exporter(); return; }
    if (t.closest('[data-tb-tout-derouler]')) {
      const s = celluleChoisie();
      if (s) toutDerouler(s.g.id, s.indices, `${s.g.id}|${JSON.stringify(s.indices)}`, 0);
      rendrePanneau();
      return;
    }
    if (t.closest('[data-tb-tout-replier]')) { etat.deroules = new Set(); rendrePanneau(); return; }
    const der = /** @type {HTMLElement|null} */ (t.closest('[data-tb-derouler]'));
    if (der) {
      const ch = /** @type {string} */ (der.dataset.tbDerouler);
      if (etat.deroules.has(ch)) etat.deroules.delete(ch);
      else etat.deroules.add(ch);
      rendrePanneau();
      return;
    }
    const va = /** @type {HTMLElement|null} */ (t.closest('[data-tb-aller]'));
    if (va && !etat.edition) {
      const dims = va.dataset.tbDims ? JSON.parse(va.dataset.tbDims) : celluleChoisie()?.indices ?? {};
      if (!t.closest('#tb-journal')) $('tb-journal').hidden = true;
      aller(/** @type {string} */ (va.dataset.tbAller), dims);
      return;
    }
    if (t.closest('[data-tb-modifier]') || t.closest('#tb-btn-modifier')) { commencerEdition(); return; }
    if (t.closest('#tb-btn-valider')) { validerEdition(); return; }
    if (t.closest('#tb-btn-annuler')) { annulerEdition(); return; }
    if (t.closest('#tb-btn-retablir')) { if (etat.choix.id) retablirFormule(etat.choix.id); return; }
    if (t.closest('[data-tb-inserer]')) {
      etat.insertion = true;
      rendrePanneau();
      $('tb-nl-libelle')?.focus();
      return;
    }
    if (t.closest('[data-tb-annuler-insertion]')) { etat.insertion = false; rendrePanneau(); return; }
    const td = /** @type {HTMLElement|null} */ (t.closest('td.tb-val[data-tb-cell]'));
    if (td) {
      const [col, id] = /** @type {string} */ (td.dataset.tbCell).split('|');
      if (etat.edition) { insererReference(col, id); return; }
      if (etat.saisieCellule) return;
      message(null, null);
      choisir(id, col);
      $('tb-feuille').focus({ preventScroll: true });
      return;
    }
    const lib = /** @type {HTMLElement|null} */ (t.closest('tr[data-tb-ligne] td.tb-lib'));
    if (lib && !etat.edition) {
      const id = /** @type {string} */ (/** @type {HTMLElement} */ (lib.parentElement).dataset.tbLigne);
      const vals = ligneDe(id)?.col.valeurs ?? [];
      message(null, null);
      choisir(id, vals.some((/** @type {any} */ c) => c.lettre === etat.choix.col) ? etat.choix.col : vals[0]?.lettre ?? 'B');
      $('tb-feuille').focus({ preventScroll: true });
    }
  });
  hote?.addEventListener('dblclick', (ev) => {
    const t = /** @type {Element} */ (ev.target);
    if (etat.edition) return;
    if (t.closest?.('#tb-formule')) { commencerEdition(); return; }
    if (t.closest?.('td.tb-val[data-tb-cell]') && !editerCellule()) commencerEdition();
  });
  hote?.addEventListener('change', (ev) => {
    const el = /** @type {HTMLInputElement|HTMLSelectElement} */ (ev.target);
    const dim = el.dataset?.tbFiltre;
    if (dim) {
      const d = disposition(/** @type {string} */ (etat.feuille));
      /** @type {Record<string, any>} */
      const parents = {};
      for (const x of d.dims) {
        if (x === dim) break;
        parents[x] = filtre(x, parents);
      }
      const liste = valeursDim(dim, parents);
      etat.filtres[dim] = liste === null ? (/^-?\d+$/.test(el.value.trim()) ? Number(el.value) : el.value.trim()) : liste[Number(el.value)];
      DISPOSITIONS = new Map();
      rendreVue();
      return;
    }
    if (el.id === 'tb-importance') {
      const s = celluleChoisie();
      if (!s) return;
      const sur = copieSurcharges();
      sur.niveaux = { ...(sur.niveaux ?? {}) };
      const parDefaut = niveauDe({ ...MODELE.grandeurs.get(s.g.id) ?? s.g, niveau: MODELE.grandeurs.get(s.g.id)?.niveau });
      const ajout = (sur.ajouts ?? []).find((/** @type {any} */ a) => a.id === s.g.id);
      if (ajout) ajout.niveau = el.value;
      else if (el.value === parDefaut) delete sur.niveaux[s.g.id];
      else sur.niveaux[s.g.id] = el.value;
      const erreur = appliquer(sur);
      message(erreur ? 'erreur' : 'info', erreur ?? `Importance de « ${s.g.libelle} » : ${NIVEAUX[el.value]}.`);
      return;
    }
    if (el.id === 'tb-importer' && /** @type {HTMLInputElement} */ (el).files?.[0]) {
      importer(/** @type {File} */ (/** @type {HTMLInputElement} */ (el).files?.[0]));
      /** @type {HTMLInputElement} */ (el).value = '';
      return;
    }
    if (/** @type {HTMLInputElement} */ (el).name === 'tb-nature') {
      $('tb-nl-valeur-champ').hidden = el.value !== 'constante';
    }
  });
  hote?.addEventListener('input', (ev) => {
    const el = /** @type {HTMLInputElement} */ (ev.target);
    if (el.id === 'tb-saisie-formule') surFrappe();
    else if (el.id === 'tb-zone-nom') suggestionsNoms();
    else if (el.id === 'tb-nl-nom') el.dataset.touche = '1';
    else if (el.id === 'tb-nl-libelle') {
      const nom = /** @type {HTMLInputElement} */ ($('tb-nl-nom'));
      if (!nom.dataset.touche) nom.value = nomPropose(el.value);
    }
  });
  hote?.addEventListener('submit', (ev) => {
    if (/** @type {HTMLElement} */ (ev.target).id !== 'tb-form-insertion') return;
    ev.preventDefault();
    insererLigne();
  });
  hote?.addEventListener('mouseover', (ev) => {
    const b = /** @type {HTMLElement|null} */ (/** @type {Element} */ (ev.target).closest?.('[data-tb-survol]'));
    if (!b) return;
    const pos = positionDe(/** @type {string} */ (b.dataset.tbSurvol), JSON.parse(b.dataset.tbSurvolDims ?? '{}'));
    if (!pos || pos.fid !== etat.feuille || !pos.affichee) return;
    $('tb-feuille').querySelector(`[data-tb-cell="${pos.lettre}|${CSS.escape(/** @type {string} */ (b.dataset.tbSurvol))}"]`)?.classList.add('tb-val--survol');
  });
  hote?.addEventListener('mouseout', (ev) => {
    if (/** @type {Element} */ (ev.target).closest?.('[data-tb-survol]')) {
      for (const td of $('tb-feuille').querySelectorAll('.tb-val--survol')) td.classList.remove('tb-val--survol');
    }
  });
  hote?.addEventListener('keyup', (ev) => {
    if (/** @type {HTMLElement} */ (ev.target).id === 'tb-saisie-formule' && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) suggestions();
  });
  hote?.addEventListener('keydown', (ev) => {
    const el = /** @type {HTMLElement} */ (ev.target);
    if (el.id === 'tb-saisie-formule') {
      if (etat.sugg && !$('tb-suggestions').hidden) {
        const n = etat.sugg.items.length;
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          etat.sugg.index = (etat.sugg.index + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
          [...$('tb-suggestions').children].forEach((li, i) => li.setAttribute('aria-selected', String(i === etat.sugg.index)));
          return;
        }
        if (ev.key === 'Tab' || ev.key === 'Enter') { ev.preventDefault(); insererSuggestion(etat.sugg.index); return; }
        if (ev.key === 'Escape') { ev.preventDefault(); fermerSuggestions(); return; }
      }
      if (ev.key === 'Enter') { ev.preventDefault(); validerEdition(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); annulerEdition(); }
      return;
    }
    if (el.id === 'tb-zone-nom') {
      const s = etat.suggNoms;
      const ouverte = s && !$('tb-liste-noms').hidden && s.items.length;
      if (ouverte && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
        ev.preventDefault();
        s.index = (s.index + (ev.key === 'ArrowDown' ? 1 : s.items.length - 1)) % s.items.length;
        [...$('tb-liste-noms').children].forEach((li, i) => li.setAttribute('aria-selected', String(i === s.index)));
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (ouverte) { quitterZoneNom(); aller(s.items[s.index].id); } else allerSaisie(zoneNom().value);
        return;
      }
      if (ev.key === 'Escape') { ev.preventDefault(); quitterZoneNom(); rendreBarre(); $('tb-feuille').focus(); }
      return;
    }
    if (!$('tb-feuille').contains(el) || etat.edition || etat.saisieCellule) return;
    const s = celluleChoisie();
    switch (ev.key) {
      case 'ArrowUp': ev.preventDefault(); deplacer(-1, 0); return;
      case 'ArrowDown': ev.preventDefault(); deplacer(1, 0); return;
      case 'ArrowLeft': ev.preventDefault(); deplacer(0, -1); return;
      case 'ArrowRight': ev.preventDefault(); deplacer(0, 1); return;
      case 'Tab': ev.preventDefault(); deplacer(0, ev.shiftKey ? -1 : 1); return;
      case 'Enter': case 'F2': ev.preventDefault(); if (!editerCellule()) commencerEdition(); return;
      case '=': ev.preventDefault(); commencerEdition(true); return;
      case 'Delete':
        if (s && modifiable(s.g)) {
          ev.preventDefault();
          const erreur = o.ecrireCellule(s.g, s.indices, null);
          message(erreur ? 'erreur' : 'info', erreur ?? `${s.g.libelle} est vidée : tout l’outil est recalculé.`);
        }
        return;
      default:
        if (ev.key.length === 1 && /[0-9,.-]/.test(ev.key) && !ev.ctrlKey && !ev.metaKey && editerCellule(ev.key)) ev.preventDefault();
    }
  });
  $('tb-suggestions')?.addEventListener('mousedown', (ev) => {
    const li = /** @type {HTMLElement|null} */ (/** @type {Element} */ (ev.target).closest('[data-tb-sugg]'));
    if (!li) return;
    ev.preventDefault();
    insererSuggestion(Number(li.dataset.tbSugg));
  });
  $('tb-liste-noms')?.addEventListener('mousedown', (ev) => {
    const li = /** @type {HTMLElement|null} */ (/** @type {Element} */ (ev.target).closest('[data-tb-nom]'));
    if (!li) return;
    ev.preventDefault();
    quitterZoneNom();
    aller(etat.suggNoms.items[Number(li.dataset.tbNom)].id);
  });
  zoneNom()?.addEventListener('focus', () => zoneNom().select());
  zoneNom()?.addEventListener('blur', () => {
    $('tb-liste-noms').hidden = true;
    setTimeout(() => { if (document.activeElement !== zoneNom()) rendreBarre(); }, 0);
  });
  window.addEventListener('resize', () => dessinerFleches());

  // Un chiffre de n'importe quel ecran : son explication dans la boite.
  document.addEventListener('click', (ev) => {
    const t = /** @type {Element} */ (ev.target);
    if (!(t instanceof Element)) return;
    const boite = /** @type {HTMLDialogElement|null} */ (document.getElementById('boite-formule'));
    if (t.closest('[data-formule-fermer]')) { boite?.close(); return; }
    if (t.closest('#boite-formule')) {
      if (t.closest('[data-tb-ouvrir-classeur]') && etat.boite) {
        const { id, indices } = etat.boite;
        boite?.close();
        o.montrerEcran();
        aller(id, indices);
        return;
      }
      const der = /** @type {HTMLElement|null} */ (t.closest('[data-tb-derouler]'));
      if (der && etat.boite) {
        const ch = /** @type {string} */ (der.dataset.tbDerouler);
        if (etat.deroules.has(ch)) etat.deroules.delete(ch);
        else etat.deroules.add(ch);
        ouvrirBoite(etat.boite.id, etat.boite.indices);
        return;
      }
      if (t.closest('[data-tb-tout-derouler]') && etat.boite) {
        toutDerouler(etat.boite.id, etat.boite.indices, `${etat.boite.id}|${JSON.stringify(etat.boite.indices)}`, 0);
        ouvrirBoite(etat.boite.id, etat.boite.indices);
        return;
      }
      if (t.closest('[data-tb-tout-replier]') && etat.boite) { etat.deroules = new Set(); ouvrirBoite(etat.boite.id, etat.boite.indices); return; }
      const va = /** @type {HTMLElement|null} */ (t.closest('[data-tb-aller]'));
      if (va) {
        ouvrirBoite(/** @type {string} */ (va.dataset.tbAller), va.dataset.tbDims ? JSON.parse(va.dataset.tbDims) : {});
        return;
      }
      return;
    }
    if (t.closest('#tableur')) return;
    const cible = /** @type {HTMLElement|null} */ (t.closest('[data-formule]'));
    if (!cible) return;
    ev.preventDefault();
    etat.deroules = new Set();
    ouvrirBoite(/** @type {string} */ (cible.dataset.formule), cible.dataset.indices ? JSON.parse(cible.dataset.indices) : {});
  });

  return {
    /** Apres chaque calcul : relit le classeur, et redessine ce qui est affiche. */
    rendre() {
      rafraichirDonnees();
      const ecran = document.getElementById('ecran-calculs');
      if (ecran && !ecran.hidden && !etat.saisieCellule) {
        if (etat.edition) surFrappe();
        else rendreVue();
      } else rendreJournal();
      const boite = /** @type {HTMLDialogElement|null} */ (document.getElementById('boite-formule'));
      if (boite?.open && etat.boite) ouvrirBoite(etat.boite.id, etat.boite.indices);
    },
    ouvrirBoite,
    /** @param {string} id @param {Record<string, any>} [indices] */
    aller: (id, indices) => {
      rafraichirDonnees();
      aller(id, indices);
    },
  };
}
