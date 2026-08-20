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
 * @type {Array<{code: string, libelle: string, unite: 'relatif'|'points'|'annees',
 *   amplitude: number, appliquer: (c: {entrees: any, referentiels: any}, v: number) => void}>}
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
    unite: 'points',
    amplitude: 0.01,
    appliquer: (c, v) => {
      const e = (c.entrees.exploitation ??= {});
      e.frais_gestion_pct_loyers = Math.max(0, (e.frais_gestion_pct_loyers ?? 0) + v);
      return true;
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
export const INDICATEURS = [
  {
    code: 'autofinancement_cumule',
    libelle: 'Autofinancement cumulé',
    unite: 'eur',
    // `sens` dit ce qu'une HAUSSE de l'indicateur signifie pour l'operation :
    // +1 elle va mieux, -1 elle va moins bien. L'affichage s'en sert pour
    // colorer, et rien d'autre - le calcul ne le lit jamais.
    sens: 1,
    lire: (r) => r?.exploitation?.indicateurs?.resultat_cumule_final_eur ?? null,
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
 * @param {{indicateur?: string, leviers?: string[], amplitudes?: Record<string, number>}} [options]
 */
export function tornade(entrees, referentiels, options = {}) {
  const indicateur = indicateurDe(options.indicateur ?? INDICATEURS[0].code);
  if (!indicateur) throw new Error(`Indicateur inconnu : ${options.indicateur}`);
  const codes = options.leviers ?? LEVIERS.map((l) => l.code);

  const reference = calculer(copier(entrees), copier(referentiels));
  const valeurReference = indicateur.lire(reference);

  const barres = codes.map((code) => {
    const levier = levierDe(code);
    if (!levier) throw new Error(`Levier inconnu : ${code}`);
    const amplitude = options.amplitudes?.[code] ?? levier.amplitude;
    const { points } = balayerLevier(entrees, referentiels, code, [-amplitude, amplitude]);
    const bas = indicateur.lire(points[0].resultat);
    const haut = indicateur.lire(points[1].resultat);
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
