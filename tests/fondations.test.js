// @ts-check
import { describe, it, expect } from 'vitest';
import { arrondi, arrondiCS, arrondiMillierSup, arrondiLoyer } from '../src/arrondis.js';
import { produit, PRODUITS } from '../src/produits.js';

describe('arrondis (R-CONV / I-9)', () => {
  it('arrondit au demi superieur sans bruit flottant', () => {
    expect(arrondi(1.005, 2)).toBe(1.01);
    expect(arrondiLoyer(6.425)).toBe(6.43);
    expect(arrondiCS(0.77123456)).toBe(0.7712);
  });
  it('arrondit au millier superieur (option R-FIN-4)', () => {
    expect(arrondiMillierSup(120001)).toBe(121000);
    expect(arrondiMillierSup(120000)).toBe(120000);
  });
});

describe('produits (I-1 : produit = donnee, pas de duplication)', () => {
  it('expose les produits V1 PLUS et PLAI', () => {
    expect(produit('PLUS').v1).toBe(true);
    expect(produit('PLAI').v1).toBe(true);
  });
  it('PLAI construction pointe vers la marge PLAI et revise en DOUBLE (R-AMT-1)', () => {
    // Le produit ne porte QUE la cle tarifaire : la valeur de la marge vit au
    // referentiel, ou elle se revise sans toucher au code (I-2).
    const pretC = produit('PLAI').prets_defaut.find((p) => p.nature === 'construction');
    expect(pretC?.cle_marge).toBe('PLAI');
    expect(pretC?.revisabilite).toBe('DOUBLE');
    for (const p of Object.values(PRODUITS).flatMap((x) => x.prets_defaut)) {
      expect(p).not.toHaveProperty('taux_ref');
    }
  });
  it('le libre ne passe pas par le coefficient de structure', () => {
    expect(PRODUITS.LIBRE.coefficient_structure).toBe(false);
  });
  it('leve une erreur sur un produit inconnu', () => {
    // @ts-expect-error test volontaire d'un code hors type
    expect(() => produit('XXX')).toThrow();
  });
});
