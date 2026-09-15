// @ts-check
/**
 * IMPORTANCE DES LIGNES : chaque grandeur a un niveau, les resultats cles
 * existent, et les cas typiques tombent au bon endroit.
 */
import { describe, it, expect } from 'vitest';
import { MODELE, modeleDe } from '../src/formules/modele.js';
import { RESULTATS_CLES, niveauDe } from '../src/formules/niveaux.js';

describe('importance des lignes du classeur', () => {
  it('cite des resultats cles qui existent', () => {
    for (const id of RESULTATS_CLES) expect(MODELE.grandeurs.has(id), id).toBe(true);
  });

  it('donne un niveau connu a chaque grandeur', () => {
    const vus = { cle: 0, etape: 0, technique: 0 };
    for (const g of MODELE.grandeurs.values()) {
      if (g.cachee) continue;
      const n = niveauDe(g);
      expect(['cle', 'etape', 'technique'], g.id).toContain(n);
      vus[n]++;
    }
    // Les trois niveaux servent, et les resultats cles restent l'exception.
    expect(vus.cle).toBe(RESULTATS_CLES.size);
    expect(vus.etape).toBeGreaterThan(vus.cle);
    expect(vus.technique).toBeGreaterThan(vus.cle);
  });

  it('range les cas typiques', () => {
    expect(niveauDe(MODELE.grandeur('loyer_annuel_tranche'))).toBe('cle');
    expect(niveauDe(MODELE.grandeur('cs_exact'))).toBe('technique');
    expect(niveauDe(MODELE.grandeur('marge_locale_lot'))).toBe('technique');
    expect(niveauDe(MODELE.grandeur('marge_locale_saisie_tranche'))).toBe('etape');
    expect(niveauDe(MODELE.grandeur('loyer_base_tranche'))).toBe('etape');
    expect(niveauDe(MODELE.grandeur('cs_base'))).toBe('technique');
  });

  it('suit l’importance choisie dans le classeur', () => {
    const m = modeleDe({ niveaux: { cs_exact: 'cle' } });
    expect(niveauDe(m.grandeur('cs_exact'))).toBe('cle');
  });
});
