// @ts-check
/**
 * Le MODELE des formules, verifie en bloc.
 *
 * Trois garanties que chaque grandeur ajoutee doit tenir :
 *  - sa formule compile : un nom mal orthographie, une dimension non liee,
 *    une fonction inconnue echouent ici plutot qu'a l'ecran ;
 *  - elle porte un libelle et une unite, sans quoi l'ecran ne saurait pas
 *    l'afficher ;
 *  - son EXPLICATION retombe exactement sur sa valeur, cellule par cellule :
 *    ce que l'ecran montre est ce qui a ete calcule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MODELE, nouveauClasseur } from '../src/formules/modele.js';
import { compilerGrandeur } from '../src/formules/classeur.js';
import { normaliserTrajectoires } from '../src/trajectoires.js';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const lire = (f) => JSON.parse(readFileSync(join(racine, 'referentiels', f), 'utf8'));
const baremes = lire('baremes_her_2027.json');
const trajectoires = normaliserTrajectoires(lire('trajectoires_her_2027.json'));

/** Operation a quatre tranches, avec les cas particuliers des loyers. */
const ENTREES = {
  identite: { zone_ABC: 'A', zone_123: 1, type_operation: 'Neuf' },
  dates: { date_debut_travaux: '2026-03-01', duree_chantier_mois: 24, duree_simulation_ans: 50 },
  lots: [
    { code_produit: 'PLAI', nb_logements: 9, shab_m2: 540, surfaces_annexes_m2: 72 },
    { code_produit: 'PLUS', nb_logements: 14, shab_m2: 966, surfaces_annexes_m2: 112, marge_majoration: 0.3 },
    { code_produit: 'PLS', nb_logements: 5, shab_m2: 320, surfaces_annexes_m2: 40 },
    { code_produit: 'LOC', nb_logements: 6, shab_m2: 396 },
    { code_produit: 'PLUS', nb_logements: 2, shab_m2: 130, su_forcee_m2: 140 },
  ],
  loyers_par_produit: { PLS: { loyer_sortie_force: 9.5 } },
  annexes_louees: [{ nombre: 10, loyer_unitaire_eur_mois: 45 }],
};

/**
 * Toutes les combinaisons d'indices d'une grandeur. Une dimension libre ne se
 * parcourt pas : ses grandeurs ne se lisent qu'a une valeur donnee.
 * @param {any} c
 * @param {any} g
 */
function combinaisons(c, g) {
  /** @type {Array<Record<string, any>>} */
  let combos = [{}];
  for (const d of g.sur) {
    const dim = MODELE.dimensions.get(d);
    if (dim.libre) return [];
    const suivantes = [];
    for (const idx of combos) {
      const parents = Object.fromEntries(dim.sur.map((p) => [p, idx[p]]));
      for (const v of c.valeursDimension(d, parents)) suivantes.push({ ...idx, [d]: v });
    }
    combos = suivantes;
  }
  return combos;
}

describe('modele des formules', () => {
  it('compile chaque grandeur', () => {
    for (const g of MODELE.grandeurs.values()) {
      expect(() => compilerGrandeur(MODELE, g), g.id).not.toThrow();
    }
  });

  it('donne un libelle et une unite a chaque grandeur', () => {
    for (const g of MODELE.grandeurs.values()) {
      expect(g.libelle, g.id).toBeTruthy();
      if (!g.cachee) expect(g.unite, g.id).toBeTruthy();
    }
  });

  it('explique chaque cellule en retombant exactement sur sa valeur', () => {
    const c = nouveauClasseur({ entrees: ENTREES, baremes, trajectoires });
    let cellules = 0;
    for (const g of MODELE.grandeurs.values()) {
      if (g.cachee) continue;
      for (const indices of combinaisons(c, g)) {
        const v = c.valeur(g.id, indices);
        const e = c.expliquer(g.id, indices);
        expect(e.v, g.id).toEqual(v);
        if (e.arbre) expect(e.arbre.v, `${g.id} ${JSON.stringify(indices)}`).toEqual(v);
        cellules++;
      }
    }
    expect(cellules).toBeGreaterThan(100);
  });
});
