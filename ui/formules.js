// @ts-check
/**
 * ECRAN DES FORMULES : comment chaque chiffre de l'outil se calcule.
 *
 * Deux portes sur le meme contenu :
 *  - la page « Formules » des parametres, catalogue de toutes les grandeurs du
 *    modele, domaine par domaine, avec une recherche ;
 *  - un clic sur un chiffre de l'ecran, qui ouvre sa formule dans une boite.
 *
 * Une formule s'affiche en BLOCS : chaque grandeur citee est une etiquette qui
 * porte son libelle et sa valeur sur la simulation en cours ; un clic dessus
 * ouvre SA formule, et ainsi de suite jusqu'aux saisies et aux parametres.
 * Rien n'est recalcule ici : les valeurs viennent du classeur qui a produit les
 * resultats, par `expliquer`, qui rejoue le meme chemin que le calcul.
 */
import { MODELE } from '../src/formules/modele.js';
import { FONCTIONS, AGREGATS } from '../src/formules/fonctions.js';
import { compilerGrandeur } from '../src/formules/classeur.js';
import { nomsCites } from '../src/formules/langage.js';

/** Grandeur ouverte, indices et chemin parcouru, pour la page et pour la boite. */
const vuesFormules = {
  page: { id: /** @type {string|null} */ (null), indices: /** @type {Record<string, any>} */ ({}), historique: /** @type {any[]} */ ([]) },
  boite: { id: /** @type {string|null} */ (null), indices: /** @type {Record<string, any>} */ ({}), historique: /** @type {any[]} */ ([]) },
};
let rechercheFormule = '';
/** Classeur de la derniere simulation calculee, `null` si le calcul a echoue. */
let classeurFormules = () => /** @type {any} */ (null);

// ------------------------------------------------------------------ lecture

const FORMATS_FORMULE = new Map();
/** Nombre en ecriture francaise, au plus `decimales` chiffres apres la virgule. */
function nombreFormule(v, decimales) {
  let f = FORMATS_FORMULE.get(decimales);
  if (!f) FORMATS_FORMULE.set(decimales, (f = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: decimales })));
  return f.format(v);
}
const echapperFormule = (/** @type {any} */ v) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SUFFIXES_UNITE = { eur_m2: ' €/m²', eur_m2_mois: ' €/m²/mois', m2: ' m²', mois: ' mois' };
const LIBELLES_UNITE = {
  eur: 'euros', taux: 'taux', coef: 'coefficient', annee: 'année', an: 'durée en années', mois: 'mois',
  m2: 'm²', eur_m2: '€/m²', eur_m2_mois: '€/m²/mois', nombre: 'nombre', texte: 'texte',
  booleen: 'oui ou non', liste: 'liste', date: 'date',
};
const LIBELLES_NATURE = {
  formule: 'Formule', saisie: 'Saisie', parametre: 'Paramètre du barème', trajectoire: 'Trajectoire',
  constante: 'Constante', lecture: 'Donnée de référence',
};

/**
 * Une valeur telle qu'un lecteur la comprend, selon son unite.
 * @param {any} v
 * @param {string} [unite]
 */
export function valeurLisible(v, unite) {
  if (v === undefined) return 'indéfini';
  if (v === null) return 'vide';
  if (typeof v === 'boolean') return v ? 'vrai' : 'faux';
  if (Array.isArray(v)) return v.length ? `${v.length} élément${v.length > 1 ? 's' : ''}` : 'liste vide';
  if (typeof v === 'object') {
    const n = Object.keys(v).length;
    return n ? `table de ${n} entrée${n > 1 ? 's' : ''}` : 'table vide';
  }
  if (typeof v !== 'number') return String(v);
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 'non calculable' : v > 0 ? 'infini' : 'moins l’infini';
  switch (unite) {
    case 'eur':
      return `${nombreFormule(v, 2)} €`;
    case 'taux':
      return `${nombreFormule(v * 100, 4)} %`;
    case 'coef':
      return nombreFormule(v, 6);
    case 'annee':
      return String(v);
    case 'an':
      return `${nombreFormule(v, 2)} an${Math.abs(v) >= 2 ? 's' : ''}`;
    default:
      return nombreFormule(v, 4) + (SUFFIXES_UNITE[/** @type {keyof typeof SUFFIXES_UNITE} */ (unite)] ?? '');
  }
}

/** Nature d'une grandeur d'apres sa declaration. @param {any} g */
function natureGrandeur(g) {
  if (g.formule !== undefined) return 'formule';
  if (g.saisie !== undefined) return 'saisie';
  if (g.parametre !== undefined) return 'parametre';
  if (g.trajectoire !== undefined) return 'trajectoire';
  if ('constante' in g) return 'constante';
  return 'lecture';
}

/** Texte sans accents ni casse, pour la recherche. @param {string} s */
const sansAccents = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Grandeurs dont la formule cite chaque grandeur : les liens dans l'autre sens. */
let UTILISATIONS_FORMULES = /** @type {Map<string, string[]>|null} */ (null);
/** @param {string} id */
function utilisationsDe(id) {
  if (!UTILISATIONS_FORMULES) {
    UTILISATIONS_FORMULES = new Map();
    for (const g of MODELE.grandeurs.values()) {
      if (g.cachee || g.formule === undefined) continue;
      compilerGrandeur(MODELE, g);
      for (const nom of nomsCites(g.ast)) {
        if (nom === g.id || !MODELE.grandeurs.has(nom)) continue;
        if (!UTILISATIONS_FORMULES.has(nom)) UTILISATIONS_FORMULES.set(nom, []);
        /** @type {string[]} */ (UTILISATIONS_FORMULES.get(nom)).push(g.id);
      }
    }
  }
  return UTILISATIONS_FORMULES.get(id) ?? [];
}

/** Valeur par defaut d'une dimension libre, la plus parlante pour la simulation. */
function valeurLibreParDefaut(c, d) {
  const lire = (/** @type {string} */ id) => {
    try {
      return c?.valeur(id);
    } catch {
      return undefined;
    }
  };
  switch (d) {
    case 'an':
    case 'depuis':
      return lire('annee_mise_en_location');
    case 'index':
      return 'loyers_irl';
    case 'perimetre':
      return 'operation';
    case 'poste_is':
      return 'frais_gestion';
    case 'code':
      return lire('tranches_presentes')?.[0];
    case 'champ':
      return 'taux';
    case 'nature':
      return 'foncier';
    default:
      return undefined;
  }
}

/** Valeurs d'une dimension, sans jamais faire echouer l'ecran. */
function valeursSures(c, d, parents) {
  try {
    return c ? c.valeursDimension(d, parents) : [];
  } catch {
    return [];
  }
}

/**
 * Indices d'une grandeur : ceux qu'on demande s'ils existent dans la
 * simulation, la premiere valeur de chaque dimension sinon.
 */
function indicesRetenus(c, g, demandes) {
  /** @type {Record<string, any>} */
  const idx = {};
  for (const d of g.sur) {
    const dim = MODELE.dimensions.get(d);
    if (dim.libre) {
      idx[d] = demandes[d] !== undefined ? demandes[d] : valeurLibreParDefaut(c, d);
      continue;
    }
    const parents = Object.fromEntries(dim.sur.map((/** @type {string} */ p) => [p, idx[p]]));
    const valeurs = valeursSures(c, d, parents);
    idx[d] = valeurs.includes(demandes[d]) ? demandes[d] : valeurs[0];
  }
  return idx;
}

/** Libelle d'une valeur de dimension. */
function etiquetteFormule(c, d, v, parents = {}) {
  if (!MODELE.dimensions.has(d)) return String(v);
  try {
    return c ? c.etiquette(d, v, parents) : String(v);
  } catch {
    return String(v);
  }
}

// ------------------------------------------------------------------- blocs

const PRIORITES_FORMULE = { '=': 1, '<>': 1, '<': 1, '<=': 1, '>': 1, '>=': 1, '+': 2, '-': 2, '*': 3, '/': 3, '^': 5 };
const SYMBOLES_FORMULE = { '*': '×', '/': '÷', '-': '−', '<=': '≤', '>=': '≥', '<>': '≠' };
const mot = (/** @type {string} */ t) => `<span class="fb-mot">${t}</span>`;
/** Ce que designe l'argument d'un agregat, apres son corps et son parcours. */
const ARGUMENTS_AGREGAT = { TRI: 'flux initial', REPARTIR: 'total à respecter' };

/**
 * Etiquette d'une grandeur citee : son libelle, ses indices quand ils
 * different de ceux de la fiche, et sa valeur.
 */
function etiquetteGrandeur(ctx, id, dims, v, sansValeur, horsDimension) {
  const g = MODELE.grandeurs.get(id);
  if (!g) return `<span class="fb-var">${echapperFormule(id)}</span>`;
  const autres = Object.entries(dims ?? {}).filter(([d, x]) => ctx.indices[d] !== x);
  const indices = autres.map(([d, x]) => etiquetteFormule(ctx.c, d, x, dims)).join(' · ');
  const valeur = sansValeur ? '' : horsDimension ? 'hors dimension' : valeurLisible(v, g.unite);
  return `<button type="button" class="fb-ref ${sansValeur ? 'fb-ref--sans-valeur' : ''}" data-formule="${id}"
      data-indices="${echapperFormule(JSON.stringify(dims ?? {}))}" title="${echapperFormule(id)}">
    <span class="fb-ref__libelle">${echapperFormule(g.libelle)}</span>
    ${indices ? `<span class="fb-ref__indices">${echapperFormule(indices)}</span>` : ''}
    ${valeur ? `<span class="fb-ref__valeur">${echapperFormule(valeur)}</span>` : ''}
  </button>`;
}

/** Resultat d'une fonction ou d'un agregat, en pastille. */
const egal = (n, unite) => ('v' in n ? `<span class="fb-egal">= ${echapperFormule(valeurLisible(n.v, unite))}</span>` : '');

/**
 * Une formule en blocs, a partir de l'arbre d'`expliquer` (avec valeurs) ou de
 * la structure d'une formule (sans).
 * @param {any} n
 * @param {{c: any, indices: Record<string, any>}} ctx
 * @returns {string}
 */
function blocsFormule(n, ctx) {
  const sous = (/** @type {any} */ m) => blocsFormule(m, ctx);
  switch (n.t) {
    case 'nb':
      return `<span class="fb-nb">${nombreFormule(n.v, 10)}</span>`;
    case 'txt':
      return `<span class="fb-txt">« ${echapperFormule(n.v)} »</span>`;
    case 'cst':
      return `<span class="fb-cst">${echapperFormule(n.nom ?? String(n.v))}</span>`;
    case 'neg':
      return `<span class="fb-bin"><span class="fb-op">−</span>${sous(n.a)}</span>`;
    case 'bin': {
      const p = PRIORITES_FORMULE[/** @type {keyof typeof PRIORITES_FORMULE} */ (n.op)];
      const cote = (/** @type {any} */ m, /** @type {boolean} */ droite) => {
        const q = m.t === 'bin' ? PRIORITES_FORMULE[/** @type {keyof typeof PRIORITES_FORMULE} */ (m.op)] : 9;
        const entourer = q < p || (q === p && ((droite && (n.op === '-' || n.op === '/')) || (!droite && n.op === '^')));
        return entourer ? `<span class="fb-paren">(</span>${sous(m)}<span class="fb-paren">)</span>` : sous(m);
      };
      const op = SYMBOLES_FORMULE[/** @type {keyof typeof SYMBOLES_FORMULE} */ (n.op)] ?? n.op;
      return `<span class="fb-bin">${cote(n.a, false)}<span class="fb-op">${op}</span>${cote(n.b, true)}</span>`;
    }
    case 'var':
      return `<span class="fb-var">${echapperFormule(n.nom)}<span class="fb-var__v">${echapperFormule(
        etiquetteFormule(ctx.c, n.nom, n.v),
      )}</span></span>`;
    case 'ref':
      return etiquetteGrandeur(ctx, n.id, n.dims, n.v, false, n.horsDimension);
    case 'nom': {
      // Structure sans valeur : branche ecartee, ou corps generique d'un agregat.
      if (!MODELE.grandeurs.has(n.nom)) return `<span class="fb-var">${echapperFormule(n.nom)}</span>`;
      const index = (n.index ?? []).map((/** @type {any} */ i) => `${i.dim} : ${blocsFormule(i.noeud, ctx)}`);
      return etiquetteGrandeur(ctx, n.nom, {}, undefined, true, false) +
        (index.length ? `<span class="fb-index">[${index.join(' ; ')}]</span>` : '');
    }
    case 'fn':
      return fonctionEnBlocs(n, ctx);
    case 'agr':
      return agregatEnBlocs(n, ctx);
    default:
      return `<span class="fb-var">?</span>`;
  }
}

/** Une fonction : les plus courantes se lisent en mots, les autres en boite. */
function fonctionEnBlocs(n, ctx) {
  const a = n.args.map((/** @type {any} */ x) => {
    const h = blocsFormule(x, ctx);
    return x.ecarte ? `<span class="fb-ecarte">${h}</span>` : h;
  });
  switch (n.nom) {
    case 'SI':
      return `<span class="fb-si">${mot('si')} ${a[0]} ${mot('alors')} ${a[1]} ${mot('sinon')} ${a[2]}</span>`;
    case 'DEFAUT':
      return `<span class="fb-suite">${a.join(` ${mot('à défaut')} `)}</span>`;
    case 'SI.ABSENT':
      return `<span class="fb-suite">${a[0]} ${mot('si absent')} ${a[1]}</span>`;
    case 'ET':
      return `<span class="fb-suite">${a.join(` ${mot('et')} `)}</span>`;
    case 'OU':
      return `<span class="fb-suite">${a.join(` ${mot('ou')} `)}</span>`;
    case 'NON':
      return `<span class="fb-suite">${mot('non')} ${a[0]}</span>`;
    default: {
      const def = FONCTIONS[n.nom];
      return `<span class="fb-fn"><span class="fb-fn__nom" title="${echapperFormule(def?.aide ?? '')}">${echapperFormule(
        def?.libelle ?? n.nom,
      )}</span><span class="fb-args">${a.join('<span class="fb-sep">;</span>')}</span>${egal(n)}</span>`;
    }
  }
}

/** Un agregat : la fonction, son corps, ce qu'elle parcourt, et ses termes. */
function agregatEnBlocs(n, ctx) {
  const def = AGREGATS[n.nom];
  const parcours = n.parcours
    .map(
      (/** @type {any} */ p) =>
        `<span class="fb-pour">${mot('pour chaque')} ${echapperFormule(MODELE.dimensions.get(p.variable)?.libelle ?? p.variable)}` +
        (p.dans ? ` ${mot('parmi')} ${blocsFormule(p.dans, ctx)}` : '') +
        (p.quand ? ` ${mot('quand')} ${blocsFormule(p.quand, ctx)}` : '') +
        `</span>`,
    )
    .join('');
  const args = n.args.length
    ? ` ${mot(ARGUMENTS_AGREGAT[/** @type {keyof typeof ARGUMENTS_AGREGAT} */ (n.nom)] ?? 'avec')} <span class="fb-args">${n.args
        .map((/** @type {any} */ x) => blocsFormule(x, ctx))
        .join('<span class="fb-sep">;</span>')}</span>`
    : '';
  let termes = '';
  if (n.termes) {
    const variable = n.parcours.length === 1 ? n.parcours[0].variable : null;
    const lignes = n.termes.slice(0, 120).map((/** @type {any} */ x) => {
      const cle = Array.isArray(x.cle)
        ? x.cle.map((/** @type {any} */ k, /** @type {number} */ i) => etiquetteFormule(ctx.c, n.parcours[i]?.variable, k)).join(' · ')
        : etiquetteFormule(ctx.c, variable, x.cle);
      const valeur = x.noeud?.t === 'ref'
        ? etiquetteGrandeur(ctx, x.noeud.id, x.noeud.dims, x.noeud.v, false, x.noeud.horsDimension)
        : `<span class="fb-terme__v">${echapperFormule(valeurLisible(x.part ?? x.v))}</span>`;
      return `<tr><th>${echapperFormule(cle)}</th><td>${valeur}</td></tr>`;
    });
    const reste = n.termes.length > 120 ? `<tr><td colspan="2">… ${n.termes.length - 120} de plus</td></tr>` : '';
    termes = `<details class="fb-termes"><summary>${n.parcourus} terme${n.parcourus > 1 ? 's' : ''}</summary>
      <table>${lignes.join('')}${reste}</table></details>`;
  }
  return `<span class="fb-agr"><span class="fb-fn__nom" title="${echapperFormule(def?.aide ?? '')}">${echapperFormule(
    def?.libelle ?? n.nom,
  )}</span><span class="fb-args">${blocsFormule(n.corps, ctx)}</span>${parcours}${args}${egal(n)}${termes}</span>`;
}

// ------------------------------------------------------------------- fiche

/** Selecteurs des indices d'une grandeur : tranche, exercice, pret... */
function selecteursIndices(vue, c, g, indices) {
  if (!g.sur.length) return '';
  const champs = g.sur.map((/** @type {string} */ d) => {
    const dim = MODELE.dimensions.get(d);
    const libelle = echapperFormule(dim.libelle ?? d);
    if (dim.libre) {
      return `<label class="fx-indice"><span>${libelle}</span>
        <input type="text" data-formule-dim="${d}" data-formule-vue="${vue}" value="${echapperFormule(indices[d] ?? '')}" /></label>`;
    }
    const parents = Object.fromEntries(dim.sur.map((/** @type {string} */ p) => [p, indices[p]]));
    const valeurs = valeursSures(c, d, parents);
    if (!valeurs.length) return `<span class="fx-indice fx-indice--vide">${libelle} : aucune dans cette simulation</span>`;
    const options = valeurs
      .map((/** @type {any} */ x, /** @type {number} */ i) =>
        `<option value="${i}" ${x === indices[d] ? 'selected' : ''}>${echapperFormule(etiquetteFormule(c, d, x, parents))}</option>`)
      .join('');
    return `<label class="fx-indice"><span>${libelle}</span>
      <select data-formule-dim="${d}" data-formule-vue="${vue}">${options}</select></label>`;
  });
  return `<div class="fx-indices">${champs.join('')}</div>`;
}

/** Fiche d'une grandeur : libelle, regle, indices, valeur, formule en blocs, usages. */
function ficheFormule(vue) {
  const v = vuesFormules[/** @type {'page'|'boite'} */ (vue)];
  if (!v.id) {
    return `<p class="fx-vide">Choisissez une grandeur : sa formule s’affiche ici en blocs, avec les
      valeurs de la simulation en cours. Un clic sur un bloc ouvre sa propre formule.</p>`;
  }
  const g = MODELE.grandeurs.get(v.id);
  if (!g) return `<p class="fx-vide">Grandeur inconnue : ${echapperFormule(v.id)}.</p>`;
  const c = classeurFormules();
  const indices = indicesRetenus(c, g, v.indices);
  v.indices = indices;
  const domaine = MODELE.domaines.find((/** @type {any} */ d) => d.domaine === g.domaine)?.titre ?? g.domaine;
  const precedent = v.historique.at(-1);
  const retour = precedent
    ? `<button type="button" class="bouton bouton--discret fx-retour" data-formule-retour data-formule-vue="${vue}">← ${echapperFormule(
        MODELE.grandeurs.get(precedent.id)?.libelle ?? precedent.id,
      )}</button>`
    : '';

  // Une dimension vide dans cette simulation : la cellule n'existe pas.
  const incomplet = g.sur.some((/** @type {string} */ d) => !MODELE.dimensions.get(d).libre && indices[d] === undefined);
  /** @type {any} */
  let explication = null;
  let erreur = '';
  if (c && !incomplet) {
    try {
      explication = c.expliquer(g.id, indices);
    } catch (e) {
      erreur = /** @type {Error} */ (e).message;
    }
  }
  const nature = explication?.nature ?? natureGrandeur(g);
  const ctx = { c, indices };

  let corps = '';
  if (g.formule !== undefined) {
    compilerGrandeur(MODELE, g);
    const arbre = explication?.arbre ?? g.ast;
    corps = `<div class="fx-blocs">${blocsFormule(arbre, ctx)}</div>
      <details class="fx-texte"><summary>Formule écrite</summary><pre>${echapperFormule(g.formule)}</pre></details>`;
  } else if (nature === 'saisie' || nature === 'parametre' || nature === 'trajectoire') {
    const chemin = explication?.chemin ?? g.saisie ?? g.parametre ?? g.trajectoire;
    corps = `<p class="fx-origine">${LIBELLES_NATURE[nature]} lu en <code>${echapperFormule(chemin)}</code>${
      g.ecran ? `, réglé à l’écran <strong>${echapperFormule(g.ecran)}</strong>` : ''
    }.</p>`;
  } else if (nature === 'constante') {
    corps = `<p class="fx-origine">Constante du modèle.</p>`;
  } else {
    corps = `<p class="fx-origine">Donnée de référence${g.ecran ? ` (${echapperFormule(g.ecran)})` : ''}.</p>`;
  }

  const valeur = !c
    ? '<span class="fx-valeur fx-valeur--absente">pas de simulation calculée</span>'
    : incomplet
      ? '<span class="fx-valeur fx-valeur--absente">sans objet dans cette simulation</span>'
      : erreur
        ? `<span class="fx-valeur fx-valeur--erreur">${echapperFormule(erreur)}</span>`
        : `<span class="fx-valeur">${echapperFormule(valeurLisible(explication?.v, g.unite))}</span>`;

  const usages = utilisationsDe(g.id);
  const liens = usages.length
    ? `<div class="fx-usages"><span class="fx-usages__titre">Citée par ${usages.length} grandeur${usages.length > 1 ? 's' : ''}</span>${usages
        .slice(0, 40)
        .map((u) => {
          const cible = MODELE.grandeurs.get(u);
          const dims = Object.fromEntries(cible.sur.filter((/** @type {string} */ d) => d in indices).map((/** @type {string} */ d) => [d, indices[d]]));
          return `<button type="button" class="fb-ref fb-ref--sans-valeur" data-formule="${u}" data-indices="${echapperFormule(
            JSON.stringify(dims),
          )}"><span class="fb-ref__libelle">${echapperFormule(cible.libelle)}</span></button>`;
        })
        .join('')}</div>`
    : '';

  const meta = [
    `<code>${echapperFormule(g.id)}</code>`,
    LIBELLES_NATURE[/** @type {keyof typeof LIBELLES_NATURE} */ (nature)],
    g.unite ? LIBELLES_UNITE[/** @type {keyof typeof LIBELLES_UNITE} */ (g.unite)] ?? g.unite : '',
    g.regle ?? '',
  ].filter(Boolean);

  return `<article class="fx-fiche">
    <div class="fx-fil">${retour}<span class="fx-domaine-fil">${echapperFormule(domaine)}</span></div>
    <h4 class="fx-titre">${echapperFormule(g.libelle)}</h4>
    <p class="fx-meta">${meta.join(' · ')}</p>
    ${g.note ? `<p class="fx-note">${echapperFormule(g.note)}</p>` : ''}
    ${selecteursIndices(vue, c, g, indices)}
    <p class="fx-resultat">Valeur ${valeur}</p>
    ${corps}
    ${liens}
  </article>`;
}

// ------------------------------------------------------------------ catalogue

/** Liste des grandeurs, domaine par domaine, filtree par la recherche. */
function listeFormules() {
  const q = sansAccents(rechercheFormule.trim());
  const ouverte = vuesFormules.page.id ? MODELE.grandeurs.get(vuesFormules.page.id)?.domaine : null;
  const blocs = MODELE.domaines.map((/** @type {any} */ { domaine, titre }) => {
    const items = [...MODELE.grandeurs.values()].filter(
      (g) =>
        !g.cachee &&
        g.domaine === domaine &&
        (!q || sansAccents(`${g.libelle} ${g.id} ${g.formule ?? ''} ${g.note ?? ''} ${g.regle ?? ''}`).includes(q)),
    );
    if (!items.length) return '';
    const lignes = items
      .map(
        (g) => `<li><button type="button" class="fx-item ${g.id === vuesFormules.page.id ? 'fx-item--actif' : ''}"
          data-formule="${g.id}" data-formule-liste>${echapperFormule(g.libelle)}<span class="fx-item__id">${g.id}</span></button></li>`,
      )
      .join('');
    return `<details class="fx-domaine" ${q || domaine === ouverte ? 'open' : ''}>
      <summary>${echapperFormule(titre)}<span class="fx-compte">${items.length}</span></summary><ul>${lignes}</ul></details>`;
  });
  return blocs.join('') || '<p class="fx-vide">Aucune grandeur ne correspond.</p>';
}

/**
 * Squelette de la page « Formules » des parametres. Le champ de recherche y
 * est pose une fois : le reconstruire a chaque frappe lui ferait perdre le focus.
 */
export function sectionFormules() {
  return `<section class="bloc para-section fx-section" id="catalogue-formules">
    <h3>Formules</h3>
    <p class="para-source">Chaque chiffre de l’outil sort d’une formule écrite en blocs : c’est elle que
      le moteur exécute, et elle seule. Choisissez une grandeur pour voir ses blocs et leur valeur sur la
      simulation en cours ; un clic sur un bloc ouvre sa propre formule, jusqu’aux saisies. Un clic sur un
      chiffre souligné, ailleurs dans l’outil, ouvre la même fiche.</p>
    <div class="fx">
      <div class="fx-liste">
        <input type="search" id="recherche-formule" class="fx-recherche" value="${echapperFormule(rechercheFormule)}"
          placeholder="Rechercher une grandeur, un code, une formule…" aria-label="Rechercher une grandeur" />
        <div class="fx-domaines" id="fx-domaines">${listeFormules()}</div>
      </div>
      <div class="fx-detail" id="fx-detail-page">${ficheFormule('page')}</div>
    </div>
  </section>`;
}

/**
 * Remet a jour ce qui est affiche : les valeurs changent a chaque calcul.
 * @param {boolean} [liste] reconstruire aussi la liste des grandeurs
 */
export function rendreFormules(liste = false) {
  if (liste) {
    const l = document.getElementById('fx-domaines');
    if (l) l.innerHTML = listeFormules();
  }
  const page = document.getElementById('fx-detail-page');
  if (page) page.innerHTML = ficheFormule('page');
  const boite = /** @type {HTMLDialogElement|null} */ (document.getElementById('boite-formule'));
  const corps = document.getElementById('fx-detail-boite');
  if (boite?.open && corps) corps.innerHTML = ficheFormule('boite');
}

/** Ouvre une grandeur dans une vue, en gardant ou non le chemin parcouru. */
function ouvrirFormule(vue, id, indices, suivre) {
  const v = vuesFormules[/** @type {'page'|'boite'} */ (vue)];
  if (suivre && v.id) v.historique.push({ id: v.id, indices: v.indices });
  if (!suivre) v.historique = [];
  v.id = id;
  v.indices = indices ?? {};
}

/** Une saisie de dimension libre : un nombre s'il en a l'air, un texte sinon. */
const lireIndiceLibre = (/** @type {string} */ s) => (/^-?\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : s.trim());

/**
 * Pose les ecouteurs de l'ecran des formules, une fois pour toutes.
 * @param {() => any} lireClasseur  classeur de la derniere simulation calculee
 */
export function installerFormules(lireClasseur) {
  classeurFormules = lireClasseur;

  document.addEventListener('click', (ev) => {
    const el = /** @type {Element} */ (ev.target);
    if (!(el instanceof Element)) return;
    if (el.closest('[data-formule-fermer]')) {
      /** @type {HTMLDialogElement|null} */ (document.getElementById('boite-formule'))?.close();
      return;
    }
    const retour = /** @type {HTMLElement|null} */ (el.closest('[data-formule-retour]'));
    if (retour) {
      const vue = /** @type {'page'|'boite'} */ (retour.dataset.formuleVue);
      const precedent = vuesFormules[vue].historique.pop();
      if (precedent) Object.assign(vuesFormules[vue], precedent);
      rendreFormules(vue === 'page');
      return;
    }
    const cible = /** @type {HTMLElement|null} */ (el.closest('[data-formule]'));
    if (!cible) return;
    ev.preventDefault();
    const id = /** @type {string} */ (cible.dataset.formule);
    const indices = cible.dataset.indices ? JSON.parse(cible.dataset.indices) : {};
    if (cible.closest('#boite-formule')) {
      ouvrirFormule('boite', id, indices, true);
      rendreFormules();
    } else if (cible.closest('#catalogue-formules')) {
      ouvrirFormule('page', id, indices, !cible.hasAttribute('data-formule-liste'));
      rendreFormules(true);
    } else {
      // Un chiffre de l'ecran : sa fiche s'ouvre dans la boite.
      ouvrirFormule('boite', id, indices, false);
      const boite = /** @type {HTMLDialogElement|null} */ (document.getElementById('boite-formule'));
      const corps = document.getElementById('fx-detail-boite');
      if (!boite || !corps) return;
      corps.innerHTML = ficheFormule('boite');
      if (!boite.open) boite.showModal();
    }
  });

  document.addEventListener('input', (ev) => {
    const el = /** @type {HTMLInputElement} */ (ev.target);
    if (el.id !== 'recherche-formule') return;
    rechercheFormule = el.value;
    const l = document.getElementById('fx-domaines');
    if (l) l.innerHTML = listeFormules();
  });

  document.addEventListener('change', (ev) => {
    const el = /** @type {HTMLInputElement|HTMLSelectElement} */ (ev.target);
    const dim = el.dataset?.formuleDim;
    if (!dim) return;
    const vue = /** @type {'page'|'boite'} */ (el.dataset.formuleVue);
    const v = vuesFormules[vue];
    const g = v.id ? MODELE.grandeurs.get(v.id) : null;
    if (!g) return;
    const definition = MODELE.dimensions.get(dim);
    let valeur;
    if (definition.libre) valeur = lireIndiceLibre(el.value);
    else {
      const parents = Object.fromEntries(definition.sur.map((/** @type {string} */ p) => [p, v.indices[p]]));
      valeur = valeursSures(classeurFormules(), dim, parents)[Number(el.value)];
    }
    /** @type {Record<string, any>} */
    const indices = { ...v.indices, [dim]: valeur };
    // Une dimension qui depend de celle-ci repart de sa premiere valeur.
    for (const d of g.sur) if (MODELE.dimensions.get(d).sur.includes(dim)) delete indices[d];
    v.indices = indices;
    rendreFormules();
  });
}
