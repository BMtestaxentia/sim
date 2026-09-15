// @ts-check
/**
 * LANGAGE DES FORMULES DU MOTEUR.
 *
 * Chaque grandeur que le moteur calcule s'ecrit UNE fois, comme dans un
 * tableur : `prix_revient_ttc / shab_totale`. Ce texte est la seule source du
 * calcul : le moteur l'analyse, le compile et l'execute, et l'ecran en affiche
 * l'arbre sous forme de blocs. Ce qu'on lit est donc, par construction, ce qui
 * a ete calcule - il n'existe pas de seconde redaction qui pourrait diverger.
 *
 * Ce module ne fait que LIRE : texte -> arbre. Il ne connait aucune grandeur,
 * aucune fonction, aucune valeur ; c'est le classeur qui donne un sens aux noms.
 *
 * SYNTAXE
 *
 *   nombres      12   0.5   1e-3
 *   textes       'VEFA'   (apostrophe doublee pour l'echapper : 'l''annee')
 *   constantes   VRAI  FAUX  VIDE (null)  INDEFINI (undefined)
 *   noms         shab_lot, su_tranche...  - une grandeur, ou une variable liee
 *   indices      crd[annee_pret: annee_pret - 1]  - indices NOMMES, toujours
 *   operateurs   + - * / ^   = <> < <= > >=   (et × ÷ − ≤ ≥ ≠, leurs synonymes)
 *   fonctions    SI(condition; alors; sinon), MIN(a; b), ARRONDI(x; 2)...
 *   agregats     SOMME(su_tranche POUR tranche)
 *                SOMME(shab_lot POUR lot QUAND tranche_lot = tranche)
 *                PRODUIT(1 + taux POUR a DANS SUITE(debut; fin))
 *
 * Le separateur d'arguments est le point-virgule, comme dans un tableur
 * francais : la virgule y est le separateur decimal, et l'accepter comme
 * separateur rendrait `MIN(1,5)` ambigu.
 *
 * PRIORITES, de la plus faible a la plus forte : comparaison, addition,
 * multiplication, moins unaire, puissance. Le moins unaire cede a la puissance
 * comme en mathematiques (`-x ^ 2` vaut `-(x ^ 2)`), et la puissance est
 * associative a droite. Ce sont les regles de JavaScript, ce qui garantit
 * qu'une formule transcrite d'un calcul existant s'evalue dans le meme ordre -
 * et donc au meme bit pres.
 */

/**
 * @typedef {{t: 'nb', v: number}} NoeudNombre
 * @typedef {{t: 'txt', v: string}} NoeudTexte
 * @typedef {{t: 'cst', v: boolean|null|undefined, nom: string}} NoeudConstante
 * @typedef {{t: 'nom', nom: string, index: Array<{dim: string, expr: Noeud}>|null}} NoeudNom
 * @typedef {{t: 'neg', a: Noeud}} NoeudNegation
 * @typedef {{t: 'bin', op: string, a: Noeud, b: Noeud}} NoeudBinaire
 * @typedef {{t: 'fn', nom: string, args: Noeud[]}} NoeudFonction
 * @typedef {{variable: string, dans: Noeud|null, quand: Noeud|null}} Parcours
 * @typedef {{t: 'agr', nom: string, corps: Noeud, parcours: Parcours[], args: Noeud[]}} NoeudAgregat
 * @typedef {NoeudNombre|NoeudTexte|NoeudConstante|NoeudNom|NoeudNegation|NoeudBinaire|
 *           NoeudFonction|NoeudAgregat} Noeud
 */

/** Operateurs a plusieurs caracteres d'abord : `<=` ne doit pas se lire `<` puis `=`. */
const OPERATEURS = ['<>', '<=', '>=', '+', '-', '*', '/', '^', '=', '<', '>', '(', ')', '[', ']', ';', ':'];

/** Symboles typographiques acceptes a la saisie : ce sont ceux que l'ecran affiche. */
const SYNONYMES = /** @type {Record<string, string>} */ ({
  '×': '*',
  '÷': '/',
  '−': '-',
  '≤': '<=',
  '≥': '>=',
  '≠': '<>',
});

/** Mots reserves : ils ne peuvent pas nommer une grandeur. */
export const MOTS_RESERVES = new Set(['POUR', 'DANS', 'QUAND', 'VRAI', 'FAUX', 'VIDE', 'INDEFINI', 'INFINI']);

/**
 * @typedef {{type: 'nombre'|'texte'|'nom'|'op'|'fin', v: any, pos: number}} Jeton
 */

/**
 * Decoupe un texte de formule en jetons.
 * @param {string} texte
 * @returns {Jeton[]}
 */
export function decouper(texte) {
  /** @type {Jeton[]} */
  const jetons = [];
  let i = 0;
  while (i < texte.length) {
    const c = texte[i];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(texte[i + 1] ?? ''))) {
      const m = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?/.exec(texte.slice(i));
      if (!m) throw erreur(texte, i, 'nombre illisible');
      jetons.push({ type: 'nombre', v: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let v = '';
      for (;;) {
        if (j >= texte.length) throw erreur(texte, i, 'texte non ferme');
        if (texte[j] === "'") {
          if (texte[j + 1] === "'") {
            v += "'";
            j += 2;
            continue;
          }
          break;
        }
        v += texte[j];
        j++;
      }
      jetons.push({ type: 'texte', v, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      // Un nom de FONCTION peut porter des points (ARRONDI.EURO) ; un nom de
      // grandeur, jamais - il n'y a pas d'acces a un champ dans ce langage.
      const m = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Z][A-Z0-9_]*)*/.exec(texte.slice(i));
      if (!m) throw erreur(texte, i, 'nom illisible');
      jetons.push({ type: 'nom', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const synonyme = SYNONYMES[c];
    if (synonyme) {
      jetons.push({ type: 'op', v: synonyme, pos: i });
      i++;
      continue;
    }
    const op = OPERATEURS.find((o) => texte.startsWith(o, i));
    if (!op) throw erreur(texte, i, `caractere inattendu « ${c} »`);
    jetons.push({ type: 'op', v: op, pos: i });
    i += op.length;
  }
  jetons.push({ type: 'fin', v: null, pos: texte.length });
  return jetons;
}

/**
 * @param {string} texte
 * @param {number} pos
 * @param {string} message
 */
function erreur(texte, pos, message) {
  return new Error(`Formule « ${texte} », position ${pos + 1} : ${message}`);
}

/**
 * Analyse un texte de formule et rend son arbre.
 * @param {string} texte
 * @returns {Noeud}
 */
export function analyser(texte) {
  const jetons = decouper(texte);
  let k = 0;
  const courant = () => jetons[k];
  const estOp = (v) => courant().type === 'op' && courant().v === v;
  const estMot = (v) => courant().type === 'nom' && courant().v === v;
  const attendre = (v) => {
    if (!estOp(v)) {
      const j = courant();
      throw erreur(texte, j.pos, `« ${v} » attendu, « ${j.v ?? 'fin'} » trouve`);
    }
    k++;
  };

  /** @returns {Noeud} */
  const expression = () => comparaison();

  /** @returns {Noeud} */
  const comparaison = () => {
    const a = additif();
    const j = courant();
    if (j.type === 'op' && ['=', '<>', '<', '<=', '>', '>='].includes(j.v)) {
      k++;
      const b = additif();
      return { t: 'bin', op: j.v, a, b };
    }
    return a;
  };

  /** @returns {Noeud} */
  const additif = () => {
    let a = multiplicatif();
    while (estOp('+') || estOp('-')) {
      const op = courant().v;
      k++;
      a = { t: 'bin', op, a, b: multiplicatif() };
    }
    return a;
  };

  /** @returns {Noeud} */
  const multiplicatif = () => {
    let a = unaire();
    while (estOp('*') || estOp('/')) {
      const op = courant().v;
      k++;
      a = { t: 'bin', op, a, b: unaire() };
    }
    return a;
  };

  /** @returns {Noeud} */
  const unaire = () => {
    if (estOp('-')) {
      k++;
      return { t: 'neg', a: unaire() };
    }
    if (estOp('+')) {
      k++;
      return unaire();
    }
    return puissance();
  };

  /** @returns {Noeud} */
  const puissance = () => {
    const a = primaire();
    if (estOp('^')) {
      k++;
      return { t: 'bin', op: '^', a, b: unaire() };
    }
    return a;
  };

  /** @returns {Noeud} */
  const primaire = () => {
    const j = courant();
    if (j.type === 'nombre') {
      k++;
      return { t: 'nb', v: j.v };
    }
    if (j.type === 'texte') {
      k++;
      return { t: 'txt', v: j.v };
    }
    if (estOp('(')) {
      k++;
      const e = expression();
      attendre(')');
      return e;
    }
    if (j.type === 'nom') {
      k++;
      const nom = j.v;
      if (nom === 'VRAI') return { t: 'cst', v: true, nom };
      if (nom === 'FAUX') return { t: 'cst', v: false, nom };
      if (nom === 'VIDE') return { t: 'cst', v: null, nom };
      if (nom === 'INDEFINI') return { t: 'cst', v: undefined, nom };
      if (nom === 'INFINI') return { t: 'cst', v: Infinity, nom };
      if (MOTS_RESERVES.has(nom)) throw erreur(texte, j.pos, `« ${nom} » est un mot reserve`);
      if (estOp('(')) return appel(nom);
      return { t: 'nom', nom, index: estOp('[') ? indices() : null };
    }
    throw erreur(texte, j.pos, `« ${j.v ?? 'fin de formule'} » inattendu`);
  };

  /** @returns {Array<{dim: string, expr: Noeud}>} */
  const indices = () => {
    attendre('[');
    const liste = [];
    for (;;) {
      const j = courant();
      if (j.type !== 'nom') throw erreur(texte, j.pos, 'nom de dimension attendu dans [ ]');
      k++;
      attendre(':');
      liste.push({ dim: j.v, expr: expression() });
      if (estOp(';')) {
        k++;
        continue;
      }
      attendre(']');
      return liste;
    }
  };

  /**
   * Appel de fonction. Si son PREMIER argument porte `POUR`, l'appel est un
   * agregat : le corps est evalue pour chaque valeur de la variable, puis
   * combine par la fonction. Seul le premier argument peut en porter un, sans
   * quoi on ne saurait plus lequel des arguments parcourt quoi.
   *
   * Plusieurs `POUR` a la suite parcourent en BOUCLES IMBRIQUEES, dans l'ordre
   * ecrit, avec un seul accumulateur : `SOMME(x POUR poste POUR tranche)`
   * additionne poste apres poste, tranche apres tranche. Ce n'est pas la meme
   * chose que deux SOMME imbriquees, qui totaliseraient chaque poste avant de
   * les additionner - le resultat est le meme en arithmetique exacte, pas
   * forcement au dernier bit en virgule flottante.
   * @param {string} nom
   * @returns {Noeud}
   */
  const appel = (nom) => {
    attendre('(');
    /** @type {Noeud[]} */
    const args = [];
    /** @type {Array<{variable: string, dans: Noeud|null, quand: Noeud|null}>} */
    const parcours = [];
    if (!estOp(')')) {
      for (;;) {
        const e = expression();
        while (estMot('POUR')) {
          if (args.length) throw erreur(texte, courant().pos, 'POUR ne peut porter que sur le premier argument');
          k++;
          const v = courant();
          if (v.type !== 'nom' || MOTS_RESERVES.has(v.v)) throw erreur(texte, v.pos, 'variable attendue apres POUR');
          k++;
          let dans = null;
          let quand = null;
          if (estMot('DANS')) {
            k++;
            dans = expression();
          }
          if (estMot('QUAND')) {
            k++;
            quand = expression();
          }
          parcours.push({ variable: v.v, dans, quand });
        }
        args.push(e);
        if (estOp(';')) {
          k++;
          continue;
        }
        break;
      }
    }
    attendre(')');
    if (parcours.length) {
      const [corps, ...reste] = args;
      return { t: 'agr', nom, corps, parcours, args: reste };
    }
    return { t: 'fn', nom, args };
  };

  const arbre = expression();
  if (courant().type !== 'fin') throw erreur(texte, courant().pos, `« ${courant().v} » inattendu`);
  return arbre;
}

/**
 * Noms cites par une formule, grandeurs et variables confondues. Sert a la
 * validation du modele et au graphe des dependances.
 * @param {Noeud} n
 * @param {Set<string>} [acc]
 * @returns {Set<string>}
 */
export function nomsCites(n, acc = new Set()) {
  switch (n.t) {
    case 'nom':
      acc.add(n.nom);
      for (const i of n.index ?? []) nomsCites(i.expr, acc);
      break;
    case 'neg':
      nomsCites(n.a, acc);
      break;
    case 'bin':
      nomsCites(n.a, acc);
      nomsCites(n.b, acc);
      break;
    case 'fn':
      for (const a of n.args) nomsCites(a, acc);
      break;
    case 'agr':
      nomsCites(n.corps, acc);
      for (const p of n.parcours) {
        if (p.dans) nomsCites(p.dans, acc);
        if (p.quand) nomsCites(p.quand, acc);
      }
      for (const a of n.args) nomsCites(a, acc);
      break;
    default:
      break;
  }
  return acc;
}

/** Symboles d'affichage des operateurs : ceux d'un cahier, pas d'un clavier. */
export const SYMBOLES = /** @type {Record<string, string>} */ ({
  '+': '+',
  '-': '−',
  '*': '×',
  '/': '÷',
  '^': '^',
  '=': '=',
  '<>': '≠',
  '<': '<',
  '<=': '≤',
  '>': '>',
  '>=': '≥',
});
