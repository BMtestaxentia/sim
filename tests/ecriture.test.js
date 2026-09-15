// @ts-check
/**
 * ECRITURE EXCEL DES FORMULES : ce que le classeur affiche se relit en la meme
 * formule, et ce qu'on y tape a la francaise devient la formule attendue.
 */
import { describe, it, expect } from 'vitest';
import { MODELE } from '../src/formules/modele.js';
import { analyser } from '../src/formules/langage.js';
import { versExcel, depuisExcel } from '../src/formules/ecriture.js';

describe('ecriture Excel des formules', () => {
  it('relit chaque formule du modele a l’identique', () => {
    let n = 0;
    for (const g of MODELE.grandeurs.values()) {
      if (g.formule === undefined) continue;
      const excel = versExcel(g.formule);
      expect(excel.startsWith('='), g.id).toBe(true);
      expect(analyser(depuisExcel(excel)), g.id).toEqual(analyser(g.formule));
      n++;
    }
    expect(n).toBeGreaterThan(500);
  });

  it('ecrit a la francaise', () => {
    expect(versExcel("SI(a > 0.5; 'VEFA'; b * 2)")).toBe('=SI(a>0,5;"VEFA";b*2)');
    expect(versExcel('SOMME(x POUR tranche QUAND y = 1)')).toBe('=SOMME(x POUR tranche QUAND y=1)');
    expect(versExcel("'dit \"oui\"'")).toBe('="dit ""oui"""');
  });

  it('lit a la francaise', () => {
    expect(analyser(depuisExcel('=SI(a>0,5;"l\'an ""x""";b*2)'))).toEqual(analyser("SI(a > 0.5; 'l''an \"x\"'; b * 2)"));
    expect(depuisExcel('=0,3%*x')).toBe('0.003 * x');
    expect(depuisExcel('7%')).toBe('0.07');
    expect(depuisExcel('=12,5%')).toBe('0.125');
    expect(depuisExcel('=150%')).toBe('1.5');
    expect(depuisExcel('=100%')).toBe('1');
    expect(depuisExcel('=-x+1')).toBe('-x + 1');
  });

  it('ecrit une reference par son adresse quand l’ecran la connait', () => {
    const adresse = (/** @type {string} */ nom) => /** @type {Record<string, string>} */ ({ a: 'C12', b: '$B$4', c: 'D9' })[nom] ?? null;
    expect(versExcel('a + b * SOMME(a POUR tranche) + c[exercice: exercice - 1]', { adresse })).toBe(
      '=C12+$B$4*SOMME(a POUR tranche)+c[exercice:exercice-1]',
    );
  });

  it('traduit une adresse tapee par la fonction de l’ecran', () => {
    /** @param {any} r */
    const reference = (r) => (r.a.col === 'C' ? 'loyers_nets' : r.feuille ? `${r.feuille}_${r.a.ligne}` : 'taux_vacance');
    expect(depuisExcel('=C21*$B$3', { reference })).toBe('loyers_nets * taux_vacance');
    expect(depuisExcel("='Prêts'!D5+Loyers!E7", { reference })).toBe('Prêts_5 + Loyers_7');
    /** @param {any} r */
    const plage = (r) => (r.b ? `plage_${r.a.ligne}_${r.b.ligne}` : 'x');
    expect(depuisExcel('=SOMME(B3:B4)', { reference: plage })).toBe('SOMME(plage_3_4)');
  });

  it('refuse ce qui ne se lit pas', () => {
    expect(() => depuisExcel('=MIN(a,b)')).toThrow(/« ; »/);
    expect(() => depuisExcel('="a"&"b"')).toThrow(/&/);
    expect(() => depuisExcel('=C3')).toThrow(/classeur/);
    expect(() => depuisExcel('=')).toThrow(/vide/);
    expect(() => depuisExcel('="abc')).toThrow(/guillemet/);
  });
});
