// @ts-check
/**
 * Acces aux FIXTURES REELLES, celles qui portent les golden tests.
 *
 * Elles vivent dans `fixtures-reelles/`, hors de git : ce sont des exports
 * d'operations reelles, et le depot est public. Le dossier `fixtures/`, lui,
 * ne porte que des operations inventees, sans valeurs attendues - une valeur
 * attendue n'a de sens que si elle vient d'une annexe LEON.
 *
 * Consequence assumee : sur un poste qui n'a pas les fixtures reelles, les
 * golden tests ne s'executent pas. Ils ne sont pas remplaces par des tests
 * equivalents-mais-anonymes, parce qu'un tel test comparerait le moteur a
 * lui-meme et ne pourrait jamais echouer pour la bonne raison. Mieux vaut un
 * test absent, et qui le dit, qu'un test qui rassure a tort.
 *
 * Les tests de calcul (amortissement, bilan, exploitation, sensibilite) et les
 * tests de non-regression, eux, tournent partout : ils n'ont besoin d'aucune
 * donnee reelle.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Dossier des fixtures reelles. */
export const DOSSIER_REELLES = join(RACINE, 'fixtures-reelles');

/** Vrai si les fixtures reelles sont presentes sur ce poste. */
export const fixturesReellesPresentes = existsSync(DOSSIER_REELLES);

/**
 * Bouchon rendu quand les fixtures sont absentes.
 *
 * `describe.skipIf` ne saute que l'EXECUTION des tests : Vitest deroule quand
 * meme le corps du `describe` pour les collecter, et ce corps lit la fixture
 * des sa premiere ligne. Sans bouchon, le fichier entier tombe en erreur de
 * collecte au lieu d'etre proprement saute.
 *
 * Il repond a tout : n'importe quel acces rend un bouchon, un appel rend un
 * bouchon, `length` vaut zero et la conversion en nombre donne zero. De quoi
 * traverser la collecte sans lever. Aucun test ne le lit jamais - ils sont tous
 * sautes - il n'a donc pas a etre juste, seulement inerte.
 */
const ABSENT = new Proxy(function absent() {}, {
  get: (_, p) => {
    if (p === Symbol.toPrimitive || p === 'valueOf') return () => 0;
    if (p === 'length') return 0;
    return ABSENT;
  },
  apply: () => ABSENT,
});

/**
 * Lit un fichier d'une fixture reelle, ou rend un bouchon inerte si les
 * fixtures ne sont pas sur ce poste.
 * @param {string} nom dossier de la fixture
 * @param {string} fichier `entrees.json` ou `attendus.json`
 */
export function lireFixtureReelle(nom, fichier) {
  if (!fixturesReellesPresentes) return ABSENT;
  return JSON.parse(readFileSync(join(DOSSIER_REELLES, nom, fichier), 'utf8'));
}
