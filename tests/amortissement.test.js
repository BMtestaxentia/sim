// @ts-check
/**
 * Cas canoniques du moteur d'amortissement (R-AMT-2 a R-AMT-5, R-FIN-6),
 * conformement au brief sessions 2-3 : taux 0 (I-8), progressivite 0 (PMT),
 * progressivite -0,5 %, revision LA hausse/baisse, differes, 40 vs 60 ans,
 * derniere echeance, prefinancement.
 *
 * Les valeurs attendues sont soit des invariants structurels (somme des
 * amortissements = capital, CRD final nul), soit des oracles independants
 * (PMT classique, simplification algebrique tx_N = t + dLA), jamais une
 * simple recopie du code teste.
 */
import { describe, it, expect } from 'vitest';
import {
  tableauAmortissement,
  premiereAnnuite,
  anneePremiereEcheance,
  normaliserRevisabilite,
  prefinancement,
} from '../src/amortissement.js';

/** Oracle independant : annuite constante classique (formule PMT). */
function pmt(capital, taux, duree) {
  return (capital * taux) / (1 - (1 + taux) ** -duree);
}

/** Somme des amortissements d'une table. */
function sommeAmortissements(table) {
  return table.reduce((s, l) => s + l.amortissement_eur, 0);
}

describe('R-AMT-2 — premiere annuite', () => {
  it('progressivite 0 : annuite egale au PMT classique', () => {
    const a1 = premiereAnnuite({ montant_eur: 100000, taux: 0.02, progressivite: 0, nb_echeances: 25 });
    expect(a1).toBeCloseTo(pmt(100000, 0.02, 25), 8);
  });

  it('taux 0 : amortissement lineaire (arbitrage I-8, LEON renvoie 0)', () => {
    expect(premiereAnnuite({ montant_eur: 120000, taux: 0, progressivite: -0.005, nb_echeances: 30 })).toBe(4000);
  });

  it('cas degenere p = t : annuite = K(1+t)/m', () => {
    const a1 = premiereAnnuite({ montant_eur: 100000, taux: 0.02, progressivite: 0.02, nb_echeances: 20 });
    expect(a1).toBeCloseTo((100000 * 1.02) / 20, 8);
  });
});

describe('R-AMT-4/5 — table a taux fixe', () => {
  it('progressivite 0 : annuites constantes, CRD final nul, somme amortissements = capital', () => {
    const table = tableauAmortissement({
      montant_eur: 100000,
      taux: 0.02,
      progressivite: 0,
      duree_ans: 25,
      annee_premiere_echeance: 2027,
      revisabilite: 'TAUX FIXE',
    });
    expect(table).toHaveLength(25);
    const attendu = pmt(100000, 0.02, 25);
    for (const ligne of table) expect(ligne.annuite_eur).toBeCloseTo(attendu, 6);
    expect(table.at(-1)?.crd_eur).toBe(0);
    expect(sommeAmortissements(table)).toBeCloseTo(100000, 6);
  });

  it('progressivite -0,5 % : annuites en progression geometrique 0,995 jusqu a la derniere incluse', () => {
    const table = tableauAmortissement({
      montant_eur: 100000,
      taux: 0.021,
      progressivite: -0.005,
      duree_ans: 40,
      annee_premiere_echeance: 2027,
      revisabilite: 'TAUX FIXE',
    });
    expect(table).toHaveLength(40);
    for (let i = 1; i < table.length - 1; i++) {
      expect(table[i].annuite_eur / table[i - 1].annuite_eur).toBeCloseTo(0.995, 10);
    }
    // La forme fermee R-AMT-2 doit faire atterrir le CRD exactement en annee 40 :
    // la derniere annuite ajustee ne s'ecarte du profil geometrique que du bruit flottant.
    const derniere = table.at(-1);
    const avantDerniere = table.at(-2);
    expect(derniere && avantDerniere && derniere.annuite_eur / avantDerniere.annuite_eur).toBeCloseTo(0.995, 6);
    expect(derniere?.crd_eur).toBe(0);
    expect(sommeAmortissements(table)).toBeCloseTo(100000, 6);
  });

  it('taux 0 : table lineaire pure', () => {
    const table = tableauAmortissement({
      montant_eur: 120000,
      taux: 0,
      progressivite: 0,
      duree_ans: 30,
      annee_premiere_echeance: 2027,
    });
    expect(table).toHaveLength(30);
    for (const ligne of table) {
      expect(ligne.annuite_eur).toBeCloseTo(4000, 8);
      expect(ligne.interets_eur).toBe(0);
    }
    expect(table.at(-1)?.crd_eur).toBe(0);
  });

  it('40 ans vs 60 ans : premiere annuite plus faible sur la duree longue, les deux soldent', () => {
    const base = { montant_eur: 500000, taux: 0.021, progressivite: -0.005, annee_premiere_echeance: 2027 };
    const t40 = tableauAmortissement({ ...base, duree_ans: 40 });
    const t60 = tableauAmortissement({ ...base, duree_ans: 60 });
    expect(t60[0].annuite_eur).toBeLessThan(t40[0].annuite_eur);
    expect(t40.at(-1)?.crd_eur).toBe(0);
    expect(t60.at(-1)?.crd_eur).toBe(0);
    expect(sommeAmortissements(t60)).toBeCloseTo(500000, 5);
  });
});

describe('R-AMT-4 — revision Livret A', () => {
  // Pret type PLUS construction : LA_0 1,5 % + 0,6 % = 2,1 %, progressivite -0,5 %.
  const pretDouble = {
    montant_eur: 100000,
    taux: 0.021,
    progressivite: -0.005,
    duree_ans: 40,
    annee_premiere_echeance: 2027,
    revisabilite: 'DOUBLE',
    livret_a_origine: 0.015,
  };

  it('hausse du LA (DOUBLE) : taux revise = t + dLA et annuite revisee a la hausse', () => {
    const table = tableauAmortissement({
      ...pretDouble,
      livret_a_par_annee: { 2027: 0.015, 2028: 0.025 },
    });
    // Oracle algebrique : tx_N = (1+t)(1 + dLA/(1+t)) - 1 == t + dLA
    expect(table[0].taux).toBeCloseTo(0.021, 12);
    expect(table[1].taux).toBeCloseTo(0.031, 12);
    expect(table[1].interets_eur).toBeCloseTo(0.031 * table[0].crd_eur, 8);
    // rev_N = 0.995 x (1 + 0.01/1.021) - 1 = 0.0047453477 : l'annuite monte
    // malgre la progressivite negative (valeur derivee a la main).
    expect(table[1].annuite_eur / table[0].annuite_eur).toBeCloseTo(1.0047453477, 8);
  });

  it('baisse du LA : DOUBLE baisse l annuite, D.LIMITEE la plancher a son niveau precedent', () => {
    const base = {
      montant_eur: 100000,
      taux: 0.036,
      progressivite: 0,
      duree_ans: 40,
      annee_premiere_echeance: 2027,
      livret_a_origine: 0.03,
      livret_a_par_annee: { 2027: 0.03, 2028: 0.02 },
    };
    const double = tableauAmortissement({ ...base, revisabilite: 'DOUBLE' });
    const limitee = tableauAmortissement({ ...base, revisabilite: 'D. LIMITEE' });
    // Le taux d'interet baisse dans les deux cas : 3,6 % - 1 point = 2,6 %
    expect(double[1].taux).toBeCloseTo(0.026, 12);
    expect(limitee[1].taux).toBeCloseTo(0.026, 12);
    // DOUBLE : rev_N < 0, l'annuite baisse ; D.LIMITEE : MAX(rev_N, 0) = 0, annuite inchangee
    expect(double[1].annuite_eur).toBeLessThan(double[0].annuite_eur);
    expect(limitee[1].annuite_eur).toBeCloseTo(limitee[0].annuite_eur, 10);
  });

  it('TAUX FIXE : la trajectoire LA est ignoree', () => {
    const table = tableauAmortissement({
      montant_eur: 100000,
      taux: 0.015,
      progressivite: 0,
      duree_ans: 30,
      annee_premiere_echeance: 2027,
      revisabilite: 'TAUX FIXE',
      livret_a_origine: 0.015,
      livret_a_par_annee: { 2027: 0.015, 2028: 0.045 },
    });
    expect(table[1].taux).toBe(0.015);
    expect(table[1].annuite_eur).toBeCloseTo(table[0].annuite_eur, 8);
  });

  it('baisse durable du LA (D.LIMITEE) : annuite planchee mais taux en baisse, le pret se solde avant terme avec derniere echeance ajustee', () => {
    const table = tableauAmortissement({
      montant_eur: 100000,
      taux: 0.036,
      progressivite: 0,
      duree_ans: 40,
      annee_premiere_echeance: 2027,
      revisabilite: 'D.LIMITEE',
      livret_a_origine: 0.03,
      livret_a_par_annee: { 2027: 0.03, 2028: 0.005 },
    });
    expect(table.length).toBeLessThan(40);
    const derniere = table.at(-1);
    const avantDerniere = table.at(-2);
    expect(derniere?.crd_eur).toBe(0);
    // Derniere annuite ajustee : elle solde exactement le CRD precedent + interets
    expect(derniere?.annuite_eur).toBeCloseTo(
      (avantDerniere?.crd_eur ?? 0) + (derniere?.interets_eur ?? 0),
      8,
    );
    expect(sommeAmortissements(table)).toBeCloseTo(100000, 6);
  });
});

describe('R-AMT-4 — differes', () => {
  it('differe type 1 : annuites nulles, interets capitalises, puis amortissement du capital majore', () => {
    const table = tableauAmortissement({
      montant_eur: 100000,
      taux: 0.02,
      progressivite: 0,
      duree_ans: 25,
      annee_premiere_echeance: 2027,
      differe_ans: 2,
      differe_type: 1,
    });
    expect(table).toHaveLength(25);
    expect(table[0].annuite_eur).toBe(0);
    expect(table[1].annuite_eur).toBe(0);
    // Capitalisation composee : 100000 x 1,02 x 1,02
    expect(table[1].crd_eur).toBeCloseTo(100000 * 1.02 ** 2, 8);
    // Les 23 echeances restantes amortissent le capital capitalise (oracle PMT)
    expect(table[2].annuite_eur).toBeCloseTo(pmt(100000 * 1.02 ** 2, 0.02, 23), 6);
    expect(table.at(-1)?.crd_eur).toBe(0);
  });

  it('differe type 2 : annuite = interets seuls, CRD constant', () => {
    const table = tableauAmortissement({
      montant_eur: 100000,
      taux: 0.02,
      progressivite: 0,
      duree_ans: 25,
      annee_premiere_echeance: 2027,
      differe_ans: 2,
      differe_type: 2,
    });
    expect(table[0].annuite_eur).toBeCloseTo(2000, 8);
    expect(table[0].crd_eur).toBe(100000);
    expect(table[1].crd_eur).toBe(100000);
    expect(table[2].annuite_eur).toBeCloseTo(pmt(100000, 0.02, 23), 6);
    expect(table.at(-1)?.crd_eur).toBe(0);
  });

  it('refuse un differe sans type explicite', () => {
    expect(() =>
      tableauAmortissement({
        montant_eur: 100000,
        taux: 0.02,
        duree_ans: 25,
        annee_premiere_echeance: 2027,
        differe_ans: 2,
      }),
    ).toThrow(/differe/i);
  });
});

describe('R-AMT-3 — date de premiere echeance PAR PRET (bug historique ALS)', () => {
  it('mise en location + 1 an, decalage nul en demembrement', () => {
    expect(anneePremiereEcheance(2026)).toBe(2027);
    expect(anneePremiereEcheance(2026, { demembrement: true })).toBe(2026);
  });

  it('chaque pret demarre a SA date, jamais a un an 1 commun', () => {
    const commun = { montant_eur: 100000, taux: 0.02, progressivite: 0, duree_ans: 25 };
    const pretA = tableauAmortissement({ ...commun, annee_premiere_echeance: 2027 });
    const pretB = tableauAmortissement({ ...commun, annee_premiere_echeance: 2029 });
    expect(pretA[0].annee).toBe(2027);
    expect(pretB[0].annee).toBe(2029);
    expect(pretB.at(-1)?.annee).toBe(2029 + 24);
  });

  it('un pret non mobilise (montant 0) produit une table vide', () => {
    expect(
      tableauAmortissement({ montant_eur: 0, taux: 0.02, duree_ans: 25, annee_premiere_echeance: 2027 }),
    ).toEqual([]);
  });
});

describe('normalisation des libelles LEON', () => {
  it('accepte les formes serialisees par l onglet IN', () => {
    expect(normaliserRevisabilite('D. LIMITEE')).toBe('D.LIMITEE');
    expect(normaliserRevisabilite('TAUX FIXE')).toBe('TAUX FIXE');
    expect(normaliserRevisabilite('double')).toBe('DOUBLE');
    expect(() => normaliserRevisabilite('QUADRUPLE')).toThrow();
  });
});

describe('R-FIN-6 — prefinancement', () => {
  const tirages = [
    { montant_eur: 100000, mois_avant_location: 12 },
    { montant_eur: 50000, mois_avant_location: 6 },
  ];

  it('capitalise chaque tirage mensuellement jusqu a la mise en location', () => {
    const r = prefinancement({ tirages, taux: 0.03 });
    const attendu =
      100000 * ((1 + 0.03 / 12) ** 12 - 1) + 50000 * ((1 + 0.03 / 12) ** 6 - 1);
    expect(r.nominal_eur).toBe(150000);
    expect(r.interets_eur).toBeCloseTo(attendu, 8);
    expect(r.capital_constitue_eur).toBeCloseTo(150000 + attendu, 8);
  });

  it('flag « ne pas capitaliser » : le capital reste au nominal, le cout des interets demeure', () => {
    const r = prefinancement({ tirages, taux: 0.03, capitaliser: false });
    expect(r.capital_constitue_eur).toBe(150000);
    expect(r.interets_eur).toBeGreaterThan(0);
  });

  it('un tirage plus precoce coute plus d interets', () => {
    const precoce = prefinancement({ tirages: [{ montant_eur: 100000, mois_avant_location: 12 }], taux: 0.03 });
    const tardif = prefinancement({ tirages: [{ montant_eur: 100000, mois_avant_location: 3 }], taux: 0.03 });
    expect(precoce.interets_eur).toBeGreaterThan(tardif.interets_eur);
  });
});
