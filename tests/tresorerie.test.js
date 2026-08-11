// @ts-check
/**
 * R-TRESO - Tresorerie de la phase chantier.
 *
 * Les attendus sont des INVARIANTS de flux (tout ce qui sort est finance par
 * quelque chose) et des cas de bord calendaires, jamais une recopie du code.
 */
import { describe, it, expect } from 'vitest';
import { tresorerieChantier } from '../src/tresorerie.js';

const base = {
  date_debut_travaux: '2026-01-01',
  duree_chantier_mois: 24,
  depenses_par_chapitre: { charge_fonciere: 600_000, batiment: 1_200_000, honoraires: 200_000 },
};

describe('R-TRESO echeancier du chantier', () => {
  it('couvre la durée du chantier, ordre de service inclus', () => {
    const { lignes } = tresorerieChantier(base);
    expect(lignes).toHaveLength(25); // mois 0 a 24
    expect(lignes[0].date).toBe('2026-01-01');
    expect(lignes.at(-1)?.date).toBe('2028-01-01');
  });

  it('depense tout le prix de revient, ni plus ni moins', () => {
    const { lignes, indicateurs } = tresorerieChantier(base);
    const total = lignes.reduce((s, l) => s + l.depenses_eur, 0);
    expect(total).toBeCloseTo(2_000_000, 0);
    expect(indicateurs.total_depenses_eur).toBeCloseTo(2_000_000, 0);
  });

  it('paie le foncier a l ordre de service et etale les travaux', () => {
    const { lignes } = tresorerieChantier(base);
    // Foncier 600 000 comptant + 20 % des honoraires (40 000) au mois 0.
    expect(lignes[0].depenses_eur).toBeCloseTo(640_000, 0);
    // Les mois suivants ne portent que l'etalement : 1 200 000/24 + 160 000/24.
    expect(lignes[1].depenses_eur).toBeCloseTo(1_200_000 / 24 + 160_000 / 24, 0);
  });

  it('mobilise subventions et fonds propres des l ordre de service', () => {
    const { lignes } = tresorerieChantier({
      ...base,
      subventions_eur: 300_000,
      fonds_propres_eur: 100_000,
    });
    expect(lignes[0].subventions_eur).toBe(300_000);
    expect(lignes[0].fonds_propres_eur).toBe(100_000);
    expect(lignes.slice(1).every((l) => l.subventions_eur === 0)).toBe(true);
  });

  it('ne tire les prets qu a hauteur du manque', () => {
    const { lignes, indicateurs } = tresorerieChantier({ ...base, subventions_eur: 300_000 });
    // Le mois 0 depense 640 000 et encaisse 300 000 : il manque 340 000.
    expect(lignes[0].tirage_eur).toBeCloseTo(340_000, 0);
    // Une fois tire, le solde est nul : on ne tire jamais d'avance.
    expect(lignes.every((l) => l.solde_eur >= 0)).toBe(true);
    expect(indicateurs.total_tirages_eur).toBeCloseTo(2_000_000 - 300_000, 0);
  });

  it('boucle : depenses = subventions + fonds propres + tirages', () => {
    const t = tresorerieChantier({ ...base, subventions_eur: 300_000, fonds_propres_eur: 100_000 });
    const i = t.indicateurs;
    expect(i.total_subventions_eur + i.total_fonds_propres_eur + i.total_tirages_eur).toBeCloseTo(
      i.total_depenses_eur,
      0,
    );
  });

  it('chiffre le besoin maximal et le mois ou il tombe', () => {
    const { indicateurs } = tresorerieChantier({ ...base, subventions_eur: 300_000 });
    // Sans pret, le besoin culmine a la livraison : 2 000 000 - 300 000.
    expect(indicateurs.besoin_maximal_eur).toBeCloseTo(1_700_000, 0);
    expect(indicateurs.mois_pic).toBe(24);
  });

  it('produit l echeancier de tirages attendu par le prefinancement', () => {
    const { tirages } = tresorerieChantier({ ...base, subventions_eur: 300_000 });
    expect(tirages[0]).toEqual({ date: '2026-01-01', montant_eur: 340_000 });
    expect(tirages.length).toBe(25);
    expect(tirages.reduce((s, t) => s + t.montant_eur, 0)).toBeCloseTo(1_700_000, 0);
  });

  it('sans tirage, le solde plonge et dit le besoin brut', () => {
    const { lignes } = tresorerieChantier({ ...base, tirer_les_prets: false });
    expect(lignes.at(-1)?.solde_eur).toBeCloseTo(-2_000_000, 0);
    expect(lignes.every((l) => l.tirage_eur === 0)).toBe(true);
  });

  it('dit quelle part du prix de revient est due des l ordre de service', () => {
    const { indicateurs } = tresorerieChantier(base);
    expect(indicateurs.part_a_l_os).toBeCloseTo(640_000 / 2_000_000, 6);
  });
});
