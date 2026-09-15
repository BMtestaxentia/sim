// @ts-check
/**
 * ECRITURE EXCEL DES FORMULES : le classeur des calculs les affiche et les lit
 * comme Excel en francais.
 *
 * Comme Excel, le moteur garde ses formules dans une ecriture INTERNE et les
 * montre dans l'ecriture francaise : Excel range `=IF(A1>0,1.5,"x")` et
 * affiche `=SI(A1>0;1,5;"x")`. Ici l'ecriture interne est celle des domaines
 * (langage.js) ; l'ecriture affichee
 *   - commence par « = » ;
 *   - ecrit les nombres avec la virgule decimale : 0,5 ;
 *   - met les textes entre guillemets : "VEFA" ;
 *   - separe les arguments par « ; », sans espaces ;
 *   - designe une valeur par son NOM - le nom de la grandeur, qui joue le role
 *     d'un nom defini d'Excel - ou, a la demande, par son ADRESSE dans le
 *     classeur (C12, $B$4, 'Loyers'!D25) quand la reference en a une.
 *
 * Les agregats (POUR, DANS, QUAND) et les indices nommes ([exercice: ...])
 * restent ecrits tels quels : ce sont les deux ajouts du langage au tableur,
 * pour les grandeurs qui se declinent par tranche, par pret ou par annee.
 *
 * `versExcel` et `depuisExcel` sont inverses l'une de l'autre : relire ce qui
 * s'affiche redonne la meme formule (tests/ecriture.test.js). Ce module ne
 * connait pas la disposition du classeur : les adresses se resolvent par les
 * fonctions que l'ecran lui passe.
 */
import { decouper, MOTS_RESERVES } from './langage.js';

/** Mots du langage qui se lisent entoures d'espaces. */
const MOTS_AGREGAT = new Set(['POUR', 'DANS', 'QUAND']);

/**
 * Un nombre en ecriture francaise.
 * @param {number} v
 */
export function nombreExcel(v) {
  return String(v).replace('.', ',');
}

/**
 * Pour chaque parenthese ouvrante, vrai si l'appel qu'elle ouvre est un
 * agregat : un POUR figure a son propre niveau. Dans un agregat, un nom se lit
 * pour chaque valeur parcourue - il n'a pas UNE adresse.
 * @param {import('./langage.js').Jeton[]} jetons
 */
function appelsAgregats(jetons) {
  /** @type {Map<number, boolean>} */
  const agregat = new Map();
  /** @type {number[]} */
  const pile = [];
  jetons.forEach((j, i) => {
    if (j.type === 'op' && (j.v === '(' || j.v === '[')) pile.push(i);
    else if (j.type === 'op' && (j.v === ')' || j.v === ']')) pile.pop();
    else if (j.type === 'nom' && j.v === 'POUR' && pile.length) agregat.set(/** @type {number} */ (pile.at(-1)), true);
  });
  return agregat;
}

/**
 * Formule interne -> ecriture Excel.
 * @param {string} texte
 * @param {{adresse?: (nom: string) => string|null}} [options]
 *   `adresse` rend l'adresse d'une grandeur citee sans indice, ou null pour
 *   garder son nom. Sans elle, toutes les references s'ecrivent en noms.
 * @returns {string}
 */
export function versExcel(texte, options = {}) {
  const jetons = decouper(texte);
  const agregats = appelsAgregats(jetons);
  /** Profondeur des appels d'agregats et des indices ouverts. */
  const pile = /** @type {boolean[]} */ ([]);
  let sortie = '=';
  jetons.forEach((j, i) => {
    const suivant = jetons[i + 1];
    switch (j.type) {
      case 'nombre':
        sortie += nombreExcel(j.v);
        break;
      case 'texte':
        sortie += `"${String(j.v).replace(/"/g, '""')}"`;
        break;
      case 'nom': {
        if (MOTS_AGREGAT.has(j.v)) {
          sortie += ` ${j.v} `;
          break;
        }
        const appel = suivant?.type === 'op' && (suivant.v === '(' || suivant.v === '[');
        const protege = pile.some(Boolean);
        const adresse = !appel && !protege && !MOTS_RESERVES.has(j.v) && options.adresse ? options.adresse(j.v) : null;
        sortie += adresse ?? j.v;
        break;
      }
      case 'op':
        if (j.v === '(' || j.v === '[') {
          // Un indice nomme se lit toujours en noms : ses expressions parlent
          // de dimensions, pas de cellules.
          pile.push(j.v === '[' || agregats.get(i) === true);
        } else if (j.v === ')' || j.v === ']') pile.pop();
        sortie += j.v;
        break;
      default:
        break;
    }
  });
  return sortie;
}

/**
 * @typedef {Object} ReferenceExcel
 * @property {string} texte          telle qu'ecrite : 'Prêts'!$C$5
 * @property {string|null} feuille  nom d'onglet, sans guillemets
 * @property {{col: string, colAbs: boolean, ligne: number, ligneAbs: boolean}} a
 * @property {{col: string, colAbs: boolean, ligne: number, ligneAbs: boolean}|null} b  fin d'une plage
 */

const RE_REFERENCE =
  /^(?:'((?:[^']|'')+)'!|([A-Za-zÀ-ÿ_][A-Za-zÀ-ÿ0-9_.]*)!)?(\$?)([A-Z]{1,3})(\$?)([0-9]+)(?::(\$?)([A-Z]{1,3})(\$?)([0-9]+))?(?![A-Za-zÀ-ÿ0-9_(])/;

/**
 * Ecriture Excel -> formule interne.
 *
 * @param {string} texte  ce qu'on a tape, avec ou sans « = »
 * @param {{reference?: (r: ReferenceExcel) => string}} [options]
 *   `reference` traduit une adresse (ou une plage) en texte de formule interne,
 *   et leve une erreur lisible si elle ne designe rien d'utilisable.
 * @returns {string}
 */
export function depuisExcel(texte, options = {}) {
  const src = texte.trim().replace(/^=/, '');
  /** @type {Array<{type: 'mot'|'nombre'|'texte'|'op'|'brut', v: string}>} */
  const jetons = [];
  let i = 0;
  while (i < src.length) {
    const reste = src.slice(i);
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      for (;;) {
        if (j >= src.length) throw new Error('Texte sans guillemet fermant.');
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            v += '"';
            j += 2;
            continue;
          }
          break;
        }
        v += src[j];
        j++;
      }
      jetons.push({ type: 'texte', v: `'${v.replace(/'/g, "''")}'` });
      i = j + 1;
      continue;
    }
    const ref = RE_REFERENCE.exec(reste);
    if (ref && (ref[1] || ref[2] || /^\$?[A-Z]{1,3}\$?[0-9]/.test(reste))) {
      if (!options.reference) throw new Error(`L’adresse ${ref[0]} ne se lit que dans le classeur.`);
      /** @type {ReferenceExcel} */
      const r = {
        texte: ref[0],
        feuille: ref[1] !== undefined ? ref[1].replace(/''/g, "'") : ref[2] ?? null,
        a: { col: ref[4], colAbs: ref[3] === '$', ligne: Number(ref[6]), ligneAbs: ref[5] === '$' },
        b: ref[8] ? { col: ref[8], colAbs: ref[7] === '$', ligne: Number(ref[10]), ligneAbs: ref[9] === '$' } : null,
      };
      jetons.push({ type: 'brut', v: options.reference(r) });
      i += ref[0].length;
      continue;
    }
    const nombre = /^([0-9]+(?:,[0-9]+)?|,[0-9]+)(?:[eE][-+]?[0-9]+)?(%)?/.exec(reste);
    if (nombre) {
      let v = nombre[0].replace('%', '').replace(',', '.');
      if (nombre[2]) v = centieme(v);
      jetons.push({ type: 'nombre', v });
      i += nombre[0].length;
      continue;
    }
    const mot = /^[A-Za-zÀ-ÿ_][A-Za-zÀ-ÿ0-9_]*(?:\.[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9_]*)*/.exec(reste);
    if (mot) {
      jetons.push({ type: 'mot', v: mot[0] });
      i += mot[0].length;
      continue;
    }
    const op = ['<>', '<=', '>=', '+', '-', '*', '/', '^', '=', '<', '>', '(', ')', '[', ']', ';', ':'].find((o) => reste.startsWith(o));
    if (op) {
      jetons.push({ type: 'op', v: op });
      i += op.length;
      continue;
    }
    if (c === '&') throw new Error('L’opérateur & n’existe pas ici : les formules du moteur calculent des nombres.');
    if (c === ',') throw new Error('Les arguments se séparent par « ; » et la virgule est décimale, comme dans Excel en français.');
    throw new Error(`Caractère inattendu : « ${c} ».`);
  }
  if (!jetons.length) throw new Error('La formule est vide.');

  // Remise en forme lisible : l'espacement n'a pas de sens pour le langage.
  let sortie = '';
  jetons.forEach((j, k) => {
    const prec = jetons[k - 1];
    if (j.type === 'op') {
      if (j.v === ';' || j.v === ':') sortie += `${j.v} `;
      else if (j.v === '(' || j.v === '[' || j.v === ')' || j.v === ']') sortie += j.v;
      else if ((j.v === '-' || j.v === '+') && (!prec || (prec.type === 'op' && !(prec.v === ')' || prec.v === ']')))) sortie += j.v;
      else sortie += ` ${j.v} `;
      return;
    }
    if (prec && prec.type !== 'op' && !sortie.endsWith(' ')) sortie += ' ';
    sortie += j.v;
  });
  return sortie.replace(/ {2,}/g, ' ').trim();
}

/**
 * Un nombre ecrit en pourcentage, divise par cent sans passer par le calcul
 * flottant : « 0,3 % » vaut exactement 0.003, comme dans Excel.
 * @param {string} v  nombre a point decimal, sans exposant
 */
function centieme(v) {
  if (/e/i.test(v)) return String(Number(v) / 100);
  const [entier, decimales = ''] = v.split('.');
  const chiffres = entier.padStart(3, '0') + decimales;
  const point = chiffres.length - decimales.length - 2;
  const resultat = `${chiffres.slice(0, point)}.${chiffres.slice(point)}`.replace(/^0+(?=\d)/, '').replace(/\.?0+$/, '');
  return resultat === '' || resultat === '.' ? '0' : resultat;
}
