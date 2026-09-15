// @ts-check
/**
 * MODIFICATIONS DU MODELE : ce qu'un administrateur change dans le classeur des
 * calculs, sans toucher au code.
 *
 * Trois sortes de modifications, toutes des DONNEES - un objet JSON qui
 * s'enregistre, s'exporte, et voyage avec les referentiels jusqu'au moteur :
 *
 *   formules  { id: 'texte' }     la formule d'une grandeur existante, reecrite ;
 *   ajouts    [{ id, domaine, apres, libelle, unite, sur, niveau, formule | constante }]
 *                                 une grandeur nouvelle, rangee dans son domaine
 *                                 juste apres une autre, comme une ligne inseree ;
 *   niveaux   { id: 'cle' | 'etape' | 'technique' }   l'importance d'une ligne.
 *
 * Le modele modifie est un NOUVEAU modele, assemble des memes domaines : les
 * definitions du depot ne sont jamais touchees, et « tout retablir » revient
 * simplement a ne plus rien passer.
 */
import { MOTS_RESERVES } from './langage.js';

/** Importance d'une ligne du classeur, de la plus visible a la plus discrete. */
export const NIVEAUX_IMPORTANCE = ['cle', 'etape', 'technique'];

/** Identifiant d'une grandeur : minuscules sans accent, chiffres et soulignes. */
export const RE_IDENTIFIANT_GRANDEUR = /^[a-z_][a-z0-9_]*$/;

/**
 * @typedef {Object} Ajout
 * @property {string} id
 * @property {string} domaine
 * @property {string} [apres]      grandeur apres laquelle ranger la nouvelle
 * @property {string} libelle
 * @property {string} unite
 * @property {string[]} [sur]
 * @property {string} [niveau]
 * @property {string} [note]
 * @property {string} [formule]
 * @property {any} [constante]     valeur fixe, a defaut de formule
 */

/**
 * @typedef {Object} Surcharges
 * @property {Record<string, string>} [formules]
 * @property {Ajout[]} [ajouts]
 * @property {Record<string, string>} [niveaux]
 */

/**
 * Vrai si les modifications ne changent rien au modele.
 * @param {Surcharges|null|undefined} s
 */
export function sansSurcharge(s) {
  return (
    !s ||
    (!Object.keys(s.formules ?? {}).length && !(s.ajouts ?? []).length && !Object.keys(s.niveaux ?? {}).length)
  );
}

/**
 * Nombre de modifications, pour l'afficher.
 * @param {Surcharges|null|undefined} s
 */
export function nombreSurcharges(s) {
  if (!s) return 0;
  return Object.keys(s.formules ?? {}).length + (s.ajouts ?? []).length + Object.keys(s.niveaux ?? {}).length;
}

/**
 * Definition d'une grandeur ajoutee.
 * @param {Ajout} a
 */
function definitionAjout(a) {
  /** @type {Record<string, any>} */
  const def = { libelle: a.libelle, unite: a.unite, sur: a.sur ?? [], niveau: a.niveau ?? 'etape', ajoutee: true };
  if (a.note) def.note = a.note;
  if (a.formule !== undefined && a.formule !== null) def.formule = a.formule;
  else def.constante = a.constante ?? null;
  return def;
}

/**
 * Les domaines du modele, modifies. Une grandeur modifiee est une COPIE de sa
 * definition : le modele du depot reste celui que les tests verifient.
 * @param {import('./classeur.js').Domaine[]} domaines
 * @param {Surcharges} s
 * @returns {import('./classeur.js').Domaine[]}
 */
export function domainesModifies(domaines, s) {
  const formules = s.formules ?? {};
  const niveaux = s.niveaux ?? {};
  const ajouts = s.ajouts ?? [];
  const connus = new Set(domaines.flatMap((d) => Object.keys(d.grandeurs ?? {})));
  for (const id of Object.keys(formules)) {
    if (!connus.has(id)) throw new Error(`Formule modifiée d’une grandeur inconnue : ${id}`);
  }
  for (const [id, n] of Object.entries(niveaux)) {
    if (!NIVEAUX_IMPORTANCE.includes(n)) throw new Error(`Importance inconnue pour ${id} : ${n}`);
  }
  for (const a of ajouts) {
    if (!RE_IDENTIFIANT_GRANDEUR.test(a.id) || MOTS_RESERVES.has(a.id.toUpperCase())) {
      throw new Error(`Nom de grandeur invalide : ${a.id}`);
    }
    if (connus.has(a.id)) throw new Error(`La grandeur ${a.id} existe déjà`);
    if (!domaines.some((d) => d.domaine === a.domaine)) throw new Error(`Domaine inconnu pour ${a.id} : ${a.domaine}`);
    connus.add(a.id);
  }

  return domaines.map((d) => {
    const propres = ajouts.filter((a) => a.domaine === d.domaine);
    const touche = Object.keys(d.grandeurs ?? {}).some((id) => id in formules || id in niveaux);
    if (!propres.length && !touche) return d;
    /** @type {Record<string, any>} */
    const sortie = {};
    const places = new Set();
    /**
     * Pose une grandeur, puis celles qu'on a inserees juste apres elle - une
     * ligne inseree sous une ligne inseree suit la sienne.
     * @param {string} id
     * @param {any} def
     */
    const poser = (id, def) => {
      sortie[id] = def;
      for (const a of propres) {
        if (a.apres === id && !places.has(a.id)) {
          places.add(a.id);
          poser(a.id, definitionAjout(a));
        }
      }
    };
    for (const [id, def] of Object.entries(d.grandeurs ?? {})) {
      let copie = def;
      if (id in formules) {
        if (def.formule === undefined) {
          throw new Error(`${id} n’est pas calculée par une formule : sa valeur se règle à son écran`);
        }
        copie = { ...copie, formule: formules[id] };
      }
      if (niveaux[id]) copie = { ...copie, niveau: niveaux[id] };
      poser(id, copie);
    }
    // Une grandeur rangee apres une ligne qui n'existe plus se place en fin
    // de domaine plutot que de disparaitre.
    for (const a of propres) {
      if (!places.has(a.id)) {
        places.add(a.id);
        poser(a.id, definitionAjout(a));
      }
    }
    return { ...d, grandeurs: sortie };
  });
}
