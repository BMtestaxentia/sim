// @ts-check
/**
 * R-SURF et R-LOYER. Oracles : formules `calculs!D384` (SU), `calculs!D92`
 * (coefficient de structure) et `calculs!D117` (loyer max de base) de la matrice
 * LEON, recalculees a la main sur des cas simples.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  surfaceUtile,
  coefficientStructure,
  quotesPartsSU,
  loyerMaxZone,
  loyerDeBase,
  margePlafonnee,
  majorationLCR,
  loyerProduit,
  loyerAnnexesSeparees,
  controlesLoyer,
} from '../src/loyers.js';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const baremes = JSON.parse(readFileSync(join(RACINE, 'referentiels', 'baremes_her_2027.json'), 'utf8'));

describe('R-SURF-1 - surface utile', () => {
  it('SU = SHAB + 0,5 x annexes, arrondie a 2 decimales', () => {
    expect(surfaceUtile({ shab_m2: 545.8, surfaces_annexes_m2: 40 }, baremes)).toBe(565.8);
    expect(surfaceUtile({ shab_m2: 100.333, surfaces_annexes_m2: 10.111 }, baremes)).toBe(105.39);
  });

  it('une SU forcee court-circuite le calcul', () => {
    expect(surfaceUtile({ shab_m2: 100, surfaces_annexes_m2: 50, su_forcee_m2: 123.45 }, baremes)).toBe(123.45);
  });

  it('sans annexes, SU = SHAB', () => {
    expect(surfaceUtile({ shab_m2: 545.8 }, baremes)).toBe(545.8);
  });
});

describe('R-SURF-2 - coefficient de structure', () => {
  it('metropole habitat : CS = 0,77 x (1 + 20 x NL / SU)', () => {
    // Oracle a la main : 0,77 x (1 + 20 x 11 / 545,8) = 0,77 x 1,403078... = 1,08037...
    const cs = coefficientStructure({ nb_logements: 11, su_m2: 545.8 }, baremes);
    expect(cs).toBeCloseTo(0.77 * (1 + (20 * 11) / 545.8), 4);
    expect(cs).toBe(1.0804); // arrondi 4 decimales
  });

  it('foyers : le facteur passe de 20 a 38', () => {
    const habitat = coefficientStructure({ nb_logements: 10, su_m2: 500 }, baremes);
    const foyer = coefficientStructure({ nb_logements: 10, su_m2: 500, foyer: true }, baremes);
    expect(foyer).toBeGreaterThan(habitat);
    expect(foyer).toBeCloseTo(0.77 * (1 + (38 * 10) / 500), 4);
  });

  it('la variante DOM n est plus implementee : le drapeau est sans effet', () => {
    // Hors perimetre (06/08/2026). Le referentiel garde ses coefficients DOM
    // pour memoire, mais aucun code ne les lit : un appel portant `dom: true`
    // doit donner exactement le meme resultat qu'un appel metropole, et surtout
    // pas retomber silencieusement sur l'ancienne formule.
    const metropole = coefficientStructure({ nb_logements: 10, su_m2: 500 }, baremes);
    const avecDrapeau = coefficientStructure(
      /** @type {any} */ ({ nb_logements: 10, su_m2: 500, dom: true }),
      baremes,
    );
    expect(avecDrapeau).toBe(metropole);
    expect(avecDrapeau).not.toBeCloseTo((0.685 * (31 * 10 + 500)) / 500, 4);
  });

  it('SU nulle : CS nul, pas de division par zero', () => {
    expect(coefficientStructure({ nb_logements: 10, su_m2: 0 }, baremes)).toBe(0);
  });
});

describe('R-SURF-3 - quotes-parts de surface utile', () => {
  it('somment a 1', () => {
    const qp = quotesPartsSU({ PLUS: 600, PLAI: 400 });
    expect(qp.PLUS).toBeCloseTo(0.6, 12);
    expect(qp.PLAI).toBeCloseTo(0.4, 12);
    expect(qp.PLUS + qp.PLAI).toBeCloseTo(1, 12);
  });

  it('toutes nulles si aucune surface', () => {
    expect(quotesPartsSU({ PLUS: 0, PLAI: 0 })).toEqual({ PLUS: 0, PLAI: 0 });
  });
});

describe('R-LOYER - baremes et loyer pratique', () => {
  it('lit le bareme par zonage 1/2/3 pour PLUS et PLAI', () => {
    // Les valeurs viennent du REFERENTIEL et ne sont pas recopiees : un bareme
    // se revise chaque annee, et un test qui en fige les chiffres casse a chaque
    // millesime sans rien dire du moteur. Ce qui se verifie ici, c'est que le
    // bon zonage et la bonne colonne sont lus.
    expect(loyerMaxZone('PLUS', { zone_123: 2 }, baremes)).toBe(baremes.loyers_max_zone_123.PLUS[1]);
    expect(loyerMaxZone('PLAI', { zone_123: 1 }, baremes)).toBe(baremes.loyers_max_zone_123.PLAI[0]);
  });

  it('lit le bareme par zonage A/B/C pour PLS - le zonage est une propriete du produit', () => {
    expect(loyerMaxZone('PLS', { zone_ABC: 'B1' }, baremes)).toBe(baremes.loyers_max_zone_ABC.PLS[2]);
    expect(loyerMaxZone('PLS', { zone_ABC: 'C' }, baremes)).toBe(baremes.loyers_max_zone_ABC.PLS[4]);
  });

  it('R-LOYER-1 : loyer de base = bareme + marge locale', () => {
    const plafond = baremes.loyers_max_zone_123.PLUS[1];
    expect(loyerDeBase({ code_produit: 'PLUS', zones: { zone_123: 2 }, marge_locale_eur_m2: 0.5 }, baremes))
      .toBeCloseTo(plafond + 0.5, 2);
  });

  it('PLUS 33 % applique x1,33 et non +0,33 (arbitrage I-6)', () => {
    const plus = loyerDeBase({ code_produit: 'PLUS', zones: { zone_123: 2 } }, baremes);
    const plus33 = loyerDeBase({ code_produit: 'PLUS33', zones: { zone_123: 2 } }, baremes);
    expect(plus33).toBeCloseTo(plus * 1.33, 2);
    expect(plus33).not.toBeCloseTo(plus + 0.33, 2);
  });

  it('R-LOYER-2/5 : loyer max de base = CS x loyer de base, puis marge de majoration', () => {
    const r = loyerProduit(
      { code_produit: 'PLUS', su_m2: 545.8, nb_logements: 11, zones: { zone_123: 2 }, marge_majoration: 0.05 },
      baremes,
    );
    expect(r.cs).toBe(1.0804);
    expect(r.loyer_max_base_eur_m2).toBeCloseTo(1.0804 * baremes.loyers_max_zone_123.PLUS[1], 2);
    expect(r.loyer_pratique_eur_m2).toBeCloseTo(r.loyer_max_base_eur_m2 * 1.05, 2);
    // Loyer annuel = 12 x SU x loyer
    expect(r.loyer_annuel_eur).toBe(Math.round(12 * 545.8 * r.loyer_pratique_eur_m2));
  });

  it('un produit sans coefficient de structure ne passe pas par le CS', () => {
    const r = loyerProduit(
      { code_produit: 'LIBRE', su_m2: 545.8, nb_logements: 11, zones: { zone_123: 2 } },
      baremes,
    );
    expect(r.cs).toBe(1);
    expect(r.loyer_pratique_eur_m2).toBe(11); // loyer de marche zone 2
  });

  it('un loyer de sortie force court-circuite tout le calcul', () => {
    const r = loyerProduit(
      {
        code_produit: 'PLUS',
        su_m2: 500,
        nb_logements: 10,
        zones: { zone_123: 2 },
        marge_majoration: 0.5,
        loyer_sortie_force: 5.5,
      },
      baremes,
    );
    expect(r.loyer_pratique_eur_m2).toBe(5.5);
    expect(r.force).toBe(true);
  });

  it('R-LOYER-3 : la marge est plafonnee', () => {
    expect(margePlafonnee([0.05, 0.04, 0.06], 0.12)).toBeCloseTo(0.12, 12);
    expect(margePlafonnee([0.02, 0.03], 0.12)).toBeCloseTo(0.05, 12);
  });

  it('R-LOYER-4 : majoration LCR par paliers', () => {
    expect(majorationLCR(5, baremes)).toBe(0);
    expect(majorationLCR(25, baremes)).toBe(0.02);
    expect(majorationLCR(15, baremes)).toBeCloseTo(0.15, 12);
  });

  it('R-LOYER-7 : les annexes separees ne passent pas par le CS', () => {
    expect(loyerAnnexesSeparees([{ nombre: 10, loyer_unitaire_eur_mois: 50 }])).toBe(6000);
  });

  it('R-LOYER-8 : alerte si le loyer force depasse le loyer max de base', () => {
    const r = loyerProduit(
      { code_produit: 'PLUS', su_m2: 500, nb_logements: 10, zones: { zone_123: 2 }, loyer_sortie_force: 99 },
      baremes,
    );
    expect(controlesLoyer(r, 'PLUS')).toHaveLength(1);
  });

  it('leve une erreur sur une zone inconnue', () => {
    expect(() => loyerMaxZone('PLS', { zone_ABC: 'Z9' }, baremes)).toThrow(/zone/i);
  });
});

// --- Foyers et rehabilitation -------------------------------------------
describe('Foyers : le coefficient de structure prend le facteur 38', () => {
  const p = { su_m2: 1_200, nb_logements: 30, zones: { zone_123: 2, zone_ABC: 'B1' } };

  it('un foyer PLUS ne se calcule pas comme un PLUS ordinaire', () => {
    const ordinaire = loyerProduit({ code_produit: 'PLUS', ...p }, baremes);
    const foyer = loyerProduit({ code_produit: 'FPLUS', ...p }, baremes);
    // Meme bareme de base, mais un CS different : le facteur foyers est 38.
    expect(foyer.loyer_base_eur_m2).toBe(ordinaire.loyer_base_eur_m2);
    expect(foyer.cs).not.toBe(ordinaire.cs);
    expect(foyer.cs).toBe(
      coefficientStructure({ nb_logements: 30, su_m2: 1_200, foyer: true }, baremes),
    );
  });

  it('le foyer se declare par tranche, sans basculer toute l operation', () => {
    // Une tranche FPLAI et une tranche PLAI dans le meme programme gardent
    // chacune son coefficient : c'est le produit qui porte l'information.
    expect(loyerProduit({ code_produit: 'FPLAI', ...p }, baremes).cs).not.toBe(
      loyerProduit({ code_produit: 'PLAI', ...p }, baremes).cs,
    );
  });
});

describe('Rehabilitation : plafond conventionnel, hors bareme de zone', () => {
  const p = { su_m2: 1_000, nb_logements: 20, zones: { zone_123: 2, zone_ABC: 'B1' } };

  it('retient le plafond de la convention et non celui du neuf', () => {
    const l = loyerProduit({ code_produit: 'REHAB', ...p, loyer_plafond_convention_eur_m2: 5.9 }, baremes);
    expect(l.loyer_max_base_eur_m2).toBe(5.9);
    expect(l.loyer_pratique_eur_m2).toBe(5.9);
    expect(l.cs).toBe(1); // aucun coefficient de structure ne s'y applique
    expect(l.loyer_annuel_eur).toBe(12 * 1_000 * 5.9);
  });

  it('alerte quand le plafond conventionnel manque', () => {
    const l = loyerProduit({ code_produit: 'REHAB', ...p }, baremes);
    expect(controlesLoyer(l, 'REHAB')).toHaveLength(1);
    expect(controlesLoyer(l, 'REHAB')[0]).toMatch(/conventionnel non renseigne/);
  });

  it('laisse forcer un loyer de sortie sous le plafond', () => {
    const l = loyerProduit(
      { code_produit: 'REHAB', ...p, loyer_plafond_convention_eur_m2: 5.9, loyer_sortie_force: 5.5 },
      baremes,
    );
    expect(l.loyer_pratique_eur_m2).toBe(5.5);
    expect(controlesLoyer(l, 'REHAB')).toHaveLength(0);
  });
});
