// @ts-check
/**
 * Cas canoniques du moteur d'amortissement (R-AMT-2 a R-AMT-5, R-FIN-6).
 *
 * Les attendus sont soit des invariants structurels (somme des amortissements
 * = capital, CRD final nul), soit des oracles independants (PMT classique,
 * simplification algebrique tx_N = t + dLA, capitalisation actuarielle
 * recalculee a la main), jamais une recopie du code teste.
 *
 * Reference : formules SimPLUS!FF117:FN117, SimPLUS!FA15:FD27, SimLIB!FG8/FH8
 * de la matrice LEON (classeur BERGERAC 07/2026).
 */
import { describe, it, expect } from 'vitest';
import {
  tableauAmortissement,
  premiereAnnuite,
  facteurAnnuite,
  anneePremiereEcheance,
  normaliserRevisabilite,
  prefinancement,
  jourUTC,
} from '../src/amortissement.js';

/** Oracle independant : annuite constante classique (formule PMT). */
function pmt(capital, taux, duree) {
  return (capital * taux) / (1 - (1 + taux) ** -duree);
}

/** Somme des amortissements d'une table. */
function sommeAmortissements(table) {
  return table.reduce((s, l) => s + l.amortissement_eur, 0);
}

describe('R-AMT-2 - forme fermee de l annuite', () => {
  it('progressivite 0 : annuite egale au PMT classique', () => {
    const a1 = premiereAnnuite({ montant_eur: 100000, taux: 0.02, progressivite: 0, nb_echeances: 25 });
    expect(a1).toBeCloseTo(pmt(100000, 0.02, 25), 8);
  });

  it('taux 0 ET progressivite 0 : amortissement lineaire (branche lineaire de FK117)', () => {
    expect(premiereAnnuite({ montant_eur: 120000, taux: 0, progressivite: 0, nb_echeances: 30 })).toBe(4000);
  });

  it('taux 0 mais progressivite non nulle : forme fermee, pas de lineaire', () => {
    // q = (1+p)/1 = 1+p : la forme fermee reste definie, LEON ne bascule pas en lineaire.
    const a1 = premiereAnnuite({ montant_eur: 120000, taux: 0, progressivite: -0.005, nb_echeances: 30 });
    const q = 0.995;
    expect(a1).toBeCloseTo((120000 * (1 - q)) / (1 - q ** 30), 8);
    expect(a1).not.toBeCloseTo(4000, 2);
  });

  it('cas degenere rev = tx (q = 1) : limite (1+tx)/m, la ou LEON produit #DIV/0!', () => {
    expect(facteurAnnuite(0.02, 0.02, 20)).toBeCloseTo(1.02 / 20, 12);
  });

  it('derniere echeance : a m = 1 le facteur vaut (1+tx), soit CRD + interets', () => {
    expect(facteurAnnuite(0.031, -0.005, 1)).toBeCloseTo(1.031, 12);
  });
});

describe('R-AMT-4/5 - table a taux fixe', () => {
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
    expect(table.at(-1)?.crd_eur).toBeCloseTo(0, 6);
    expect(sommeAmortissements(table)).toBeCloseTo(100000, 6);
  });

  it('progressivite -0,5 % : le re-amortissement annuel reproduit la progression geometrique 0,995', () => {
    // Invariant fort : a taux constant, re-amortir le CRD sur la duree restante
    // redonne exactement la suite geometrique de raison (1+p).
    const table = tableauAmortissement({
      montant_eur: 100000,
      taux: 0.021,
      progressivite: -0.005,
      duree_ans: 40,
      annee_premiere_echeance: 2027,
      revisabilite: 'TAUX FIXE',
    });
    expect(table).toHaveLength(40);
    for (let i = 1; i < table.length; i++) {
      expect(table[i].annuite_eur / table[i - 1].annuite_eur).toBeCloseTo(0.995, 9);
    }
    expect(table.at(-1)?.crd_eur).toBeCloseTo(0, 6);
    expect(sommeAmortissements(table)).toBeCloseTo(100000, 6);
  });

  it('taux 0 et progressivite 0 : table lineaire pure', () => {
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
    expect(table.at(-1)?.crd_eur).toBeCloseTo(0, 8);
  });

  it('40 ans vs 60 ans : premiere annuite plus faible sur la duree longue, les deux soldent', () => {
    const base = { montant_eur: 500000, taux: 0.021, progressivite: -0.005, annee_premiere_echeance: 2027 };
    const t40 = tableauAmortissement({ ...base, duree_ans: 40 });
    const t60 = tableauAmortissement({ ...base, duree_ans: 60 });
    expect(t60[0].annuite_eur).toBeLessThan(t40[0].annuite_eur);
    expect(t40.at(-1)?.crd_eur).toBeCloseTo(0, 5);
    expect(t60.at(-1)?.crd_eur).toBeCloseTo(0, 5);
    expect(sommeAmortissements(t60)).toBeCloseTo(500000, 5);
  });
});

describe('R-AMT-4 - revision Livret A', () => {
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

  it('hausse du LA (DOUBLE) : taux revise = t + dLA', () => {
    const table = tableauAmortissement({
      ...pretDouble,
      livret_a_par_annee: { 2027: 0.015, 2028: 0.025 },
    });
    // Oracle algebrique : tx_N = (1+t)(1 + dLA/(1+t)) - 1 == t + dLA
    expect(table[0].taux).toBeCloseTo(0.021, 12);
    expect(table[1].taux).toBeCloseTo(0.031, 12);
    expect(table[1].interets_eur).toBeCloseTo(0.031 * table[0].crd_eur, 8);
    // Le LA reste a 2,5 % ensuite : l'annuite reprend une progression geometrique
    // de raison rev = 0,995 x (1 + 0,01/1,021) - 1 (valeur derivee a la main).
    const rev = 0.995 * (1 + 0.01 / 1.021) - 1;
    expect(table[2].annuite_eur / table[1].annuite_eur).toBeCloseTo(1 + rev, 9);
    expect(table.at(-1)?.crd_eur).toBeCloseTo(0, 5);
  });

  it('baisse du LA : DOUBLE baisse l annuite, D.LIMITEE la maintient', () => {
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
    // Ce qui distingue les deux : la PENTE du profil restant.
    // DOUBLE -> rev_N = (1+p)(1 + dLA/(1+t)) - 1 < 0 : le profil continue de decroitre.
    const rev = 1 * (1 + -0.01 / 1.036) - 1;
    expect(double[2].annuite_eur / double[1].annuite_eur).toBeCloseTo(1 + rev, 9);
    // D.LIMITEE -> MAX(rev_N, 0) = 0 : le profil devient plat.
    expect(limitee[2].annuite_eur / limitee[1].annuite_eur).toBeCloseTo(1, 9);
    // Consequence du re-amortissement : un profil decroissant se paie plus tot,
    // donc l'annuite DOUBLE de l'annee N+1 est SUPERIEURE a celle de D.LIMITEE.
    expect(double[1].annuite_eur).toBeGreaterThan(limitee[1].annuite_eur);
    // Dans les deux cas le pret solde exactement a son terme (re-amortissement).
    expect(double.at(-1)?.crd_eur).toBeCloseTo(0, 5);
    expect(limitee.at(-1)?.crd_eur).toBeCloseTo(0, 5);
  });

  it('TAUX FIXE : la trajectoire LA est ignoree (garde SimLIB!FH8)', () => {
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

  it('SIMPLE : le taux suit le LA, la progression de l annuite reste a p', () => {
    const table = tableauAmortissement({
      montant_eur: 100000,
      taux: 0.02,
      progressivite: -0.005,
      duree_ans: 30,
      annee_premiere_echeance: 2027,
      revisabilite: 'SIMPLE',
      livret_a_origine: 0.02,
      livret_a_par_annee: { 2027: 0.02, 2028: 0.03 },
    });
    expect(table[1].taux).toBeCloseTo(0.03, 12); // taux revise
    // rev reste p : la progression n'est pas affectee par le LA.
    expect(table[2].annuite_eur / table[1].annuite_eur).toBeCloseTo(0.995, 9);
  });

  it('re-amortissement : le pret solde toujours a son terme, meme apres un choc de LA', () => {
    // Difference de fond avec une simple progression geometrique de l'annuite :
    // apres un choc, LEON recalcule l'annuite sur le CRD et la duree restante,
    // donc le CRD atterrit exactement a zero au terme contractuel.
    const table = tableauAmortissement({
      montant_eur: 100000,
      taux: 0.036,
      progressivite: 0,
      duree_ans: 40,
      annee_premiere_echeance: 2027,
      revisabilite: 'DOUBLE',
      livret_a_origine: 0.03,
      livret_a_par_annee: { 2027: 0.03, 2035: 0.005, 2045: 0.05 },
    });
    expect(table).toHaveLength(40);
    expect(table.at(-1)?.crd_eur).toBeCloseTo(0, 5);
    expect(sommeAmortissements(table)).toBeCloseTo(100000, 5);
  });
});

describe('R-AMT-4 - differes', () => {
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
    expect(table).toHaveLength(25);
    expect(table[0].annuite_eur).toBeCloseTo(2000, 8);
    expect(table[0].crd_eur).toBe(100000);
    expect(table[1].crd_eur).toBe(100000);
    // Les 23 echeances restantes amortissent le capital d'origine (oracle PMT).
    expect(table[2].annuite_eur).toBeCloseTo(pmt(100000, 0.02, 23), 6);
    expect(table.at(-1)?.crd_eur).toBeCloseTo(0, 6);
  });

  it('differe type 1 : rien n est du et le CRD reste constant (LEON ne capitalise pas, cf. E-2)', () => {
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
    expect(table[0].interets_eur).toBe(0);
    expect(table[1].crd_eur).toBe(100000);
    // Le capital amorti reste celui d'origine : les interets du differe sont perdus.
    expect(table[2].annuite_eur).toBeCloseTo(pmt(100000, 0.02, 23), 6);
    expect(sommeAmortissements(table)).toBeCloseTo(100000, 6);
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

describe('R-AMT-3 - date de premiere echeance PAR PRET (bug historique ALS)', () => {
  it("demarre l'annee de la mise en location", () => {
    // Le pret est mobilise a la livraison et s'amortit dans la foulee ; les
    // interets du chantier sont deja portes par le prefinancement. Arbitrage
    // metier du 11/08/2026 (Q-4, Q-28), contre le « +1 » lu dans LEON et
    // contredit par les annexes BERGERAC et ORLEANS.
    expect(anneePremiereEcheance(2026)).toBe(2026);
    // Le demembrement ne decale plus rien : il n'y a plus de decalage a annuler.
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
  it('accepte les formes saisies dans SimPLUS!AM19', () => {
    expect(normaliserRevisabilite('D. LIMITEE')).toBe('D.LIMITEE');
    expect(normaliserRevisabilite('TAUX FIXE')).toBe('TAUX FIXE');
    expect(normaliserRevisabilite('double')).toBe('DOUBLE');
    expect(() => normaliserRevisabilite('QUADRUPLE')).toThrow();
  });
});

describe('R-FIN-6 - prefinancement (capitalisation actuarielle exact/365)', () => {
  // Echeancier type SimPLUS!AL23:AL35 : tirages mensuels, capitalises jusqu au dernier.
  const tirages = [
    { montant_eur: 100000, date: '2027-01-01' },
    { montant_eur: 50000, date: '2027-07-01' },
  ];

  it('capitalise chaque tirage a la puissance (jours/365) jusqu a la date de fin', () => {
    const r = prefinancement({ tirages, taux: 0.03, date_fin: '2028-01-01' });
    // Oracle recalcule a la main : 2027 n'est pas bissextile, 365 j et 184 j.
    const attendu =
      100000 * 1.03 ** (365 / 365) + 50000 * 1.03 ** (184 / 365) - 150000;
    expect(r.nominal_eur).toBe(150000);
    expect(r.interets_eur).toBeCloseTo(attendu, 6);
    expect(r.capital_constitue_eur).toBeCloseTo(150000 + attendu, 6);
  });

  it('sans date_fin explicite, la capitalisation court jusqu au dernier tirage (SimPLUS!FA14 = $AL$35)', () => {
    const r = prefinancement({ tirages, taux: 0.03 });
    const attendu = 100000 * 1.03 ** (181 / 365) - 100000; // 01/01 -> 01/07 = 181 j
    expect(r.interets_eur).toBeCloseTo(attendu, 6);
  });

  it('flag « ne pas capitaliser » : le capital reste au nominal, le cout des interets demeure', () => {
    const r = prefinancement({ tirages, taux: 0.03, date_fin: '2028-01-01', capitaliser: false });
    expect(r.capital_constitue_eur).toBe(150000);
    expect(r.interets_eur).toBeGreaterThan(0);
  });

  it('un tirage plus precoce coute plus d interets', () => {
    const opts = { taux: 0.03, date_fin: '2028-01-01' };
    const precoce = prefinancement({ tirages: [{ montant_eur: 100000, date: '2027-01-01' }], ...opts });
    const tardif = prefinancement({ tirages: [{ montant_eur: 100000, date: '2027-10-01' }], ...opts });
    expect(precoce.interets_eur).toBeGreaterThan(tardif.interets_eur);
  });

  it('refuse un tirage posterieur a la date de fin de capitalisation', () => {
    expect(() =>
      prefinancement({
        tirages: [{ montant_eur: 1000, date: '2028-06-01' }],
        taux: 0.03,
        date_fin: '2028-01-01',
      }),
    ).toThrow(/posterieur/i);
  });

  it('les dates sont lues en UTC, sans horloge systeme', () => {
    expect(jourUTC('2028-01-01') - jourUTC('2027-01-01')).toBe(365);
    expect(() => jourUTC('01/01/2028')).toThrow();
  });
});

// --- R-AMT-6 : amortissement a capital constant (PHB 2.0 phase 2) --------
describe('R-AMT-6 amortissement constant', () => {
  const base = {
    montant_eur: 100_000,
    taux: 0.02,
    duree_ans: 10,
    annee_premiere_echeance: 2028,
    profil: 'constant',
  };

  it('rembourse la meme fraction de capital chaque annee', () => {
    const t = tableauAmortissement(base);
    for (const l of t) expect(l.amortissement_eur).toBeCloseTo(10_000, 6);
    expect(t.at(-1)?.crd_eur).toBeCloseTo(0, 6);
  });

  it("fait DECROITRE l'annuite, contrairement au profil d'annuite", () => {
    const t = tableauAmortissement(base);
    // 10 000 de capital + 2 % du CRD : 12 000 la premiere annee, 10 200 la
    // derniere. C'est la difference de fond avec une annuite constante.
    expect(t[0].annuite_eur).toBeCloseTo(12_000, 6);
    expect(t.at(-1)?.annuite_eur).toBeCloseTo(10_200, 6);
    for (let i = 1; i < t.length; i++) expect(t[i].annuite_eur).toBeLessThan(t[i - 1].annuite_eur);
  });

  it('etale sur la duree AMORTISSANTE quand un differe le precede', () => {
    // PHB 2.0 : 20 ans a taux zero en differe total, puis 20 ans d'amortissement.
    const t = tableauAmortissement({
      ...base,
      duree_ans: 40,
      differe_ans: 20,
      differe_type: 1,
    });
    expect(t.slice(0, 20).every((l) => l.amortissement_eur === 0)).toBe(true);
    expect(t.slice(0, 20).every((l) => l.interets_eur === 0)).toBe(true);
    expect(t[20].amortissement_eur).toBeCloseTo(5_000, 6); // 100 000 / 20
    expect(t.at(-1)?.crd_eur).toBeCloseTo(0, 6);
  });

  it('amortit exactement le capital, interets non compris', () => {
    const t = tableauAmortissement(base);
    expect(t.reduce((s, l) => s + l.amortissement_eur, 0)).toBeCloseTo(100_000, 6);
  });

  it('suit le Livret A quand le pret est revisable', () => {
    const t = tableauAmortissement({
      ...base,
      revisabilite: 'SIMPLE',
      livret_a_origine: 0.015,
      livret_a_par_annee: { 2028: 0.015, 2029: 0.025 },
    });
    // Le capital rembourse ne bouge pas ; seuls les interets suivent le taux.
    expect(t[1].amortissement_eur).toBeCloseTo(10_000, 6);
    // 2 % sur 100 000 la premiere annee, puis 3 % sur le CRD DEJA amorti de
    // 90 000 : les interets montent moins vite que le taux, precisement parce
    // que le capital, lui, a deja recule.
    expect(t[0].interets_eur).toBeCloseTo(2_000, 6);
    expect(t[1].taux).toBeCloseTo(0.03, 12);
    expect(t[1].interets_eur).toBeCloseTo(2_700, 6);
  });
});

// --- R-AMT-7 : taux plancher (prets indexes sous le Livret A) ------------
describe('R-AMT-7 taux plancher', () => {
  // Action Logement PLAI : Livret A - 225 pb, plancher 0,25 %. Avec le Livret A
  // du profil HER 2027 a 1,50 %, le taux nu vaudrait -0,75 %.
  const base = {
    montant_eur: 100_000,
    taux: 0.015 - 0.0225,
    duree_ans: 40,
    annee_premiere_echeance: 2028,
    revisabilite: 'D. LIMITEE',
    progressivite: -0.005,
    livret_a_origine: 0.015,
  };

  it('empeche le taux de passer sous le plancher', () => {
    const t = tableauAmortissement({ ...base, taux_plancher: 0.0025 });
    expect(t[0].taux).toBeCloseTo(0.0025, 12);
    for (const l of t) expect(l.taux).toBeGreaterThanOrEqual(0.0025);
  });

  it('laisse le taux NEGATIF quand aucun plancher n est pose', () => {
    // Le plancher est une propriete du contrat, pas une garde du moteur : sans
    // lui, le taux du pret reste ce qu'il est. C'est ce qui rend visible un
    // preset mal renseigne plutot que de le corriger en silence.
    const t = tableauAmortissement(base);
    expect(t[0].taux).toBeLessThan(0);
  });

  it('laisse le taux monter au-dessus du plancher quand le Livret A remonte', () => {
    const t = tableauAmortissement({
      ...base,
      taux_plancher: 0.0025,
      livret_a_par_annee: { 2028: 0.015, 2029: 0.04 },
    });
    // +2,50 points de Livret A : -0,75 % + 2,50 % = 1,75 %, bien au-dessus.
    expect(t[0].taux).toBeCloseTo(0.0025, 12);
    expect(t[1].taux).toBeGreaterThan(0.0025);
    expect(t[1].taux).toBeCloseTo(-0.0075 + 0.025, 4);
  });

  it('solde le pret malgre le plancher', () => {
    const t = tableauAmortissement({ ...base, taux_plancher: 0.0025 });
    expect(t.at(-1)?.crd_eur).toBeCloseTo(0, 5);
    expect(sommeAmortissements(t)).toBeCloseTo(100_000, 5);
  });
});

// --- R-AMT-8 : echeances infra-annuelles --------------------------------
describe('R-AMT-8 periodicite', () => {
  const base = {
    montant_eur: 100_000,
    taux: 0.02,
    progressivite: 0,
    duree_ans: 20,
    annee_premiere_echeance: 2028,
    revisabilite: 'TAUX FIXE',
  };

  it('a periodicite 1, reproduit exactement le pret annuel', () => {
    const annuel = tableauAmortissement(base);
    const explicite = tableauAmortissement({ ...base, periodicite: 1 });
    expect(explicite).toEqual(annuel);
  });

  it('solde exactement le pret en trimestriel', () => {
    const t = tableauAmortissement({ ...base, periodicite: 4 });
    expect(t).toHaveLength(20);
    expect(t.at(-1)?.crd_eur).toBeCloseTo(0, 5);
    expect(sommeAmortissements(t)).toBeCloseTo(100_000, 5);
  });

  it('coute MOINS cher en trimestriel : le capital recule quatre fois par an', () => {
    const annuel = tableauAmortissement(base);
    const trim = tableauAmortissement({ ...base, periodicite: 4 });
    const interets = (t) => t.reduce((s, l) => s + l.interets_eur, 0);
    expect(interets(trim)).toBeLessThan(interets(annuel));
  });

  it('garde la progression ANNUELLE et non par periode', () => {
    // -0,5 % par an doit rester -0,5 % par an, pas -2 % : c'est la racine
    // quatrieme qui repartit la progression sur les trimestres.
    const t = tableauAmortissement({ ...base, periodicite: 4, progressivite: -0.005 });
    expect(t[1].annuite_eur / t[0].annuite_eur).toBeCloseTo(0.995, 3);
  });

  it('respecte le differe en trimestriel', () => {
    // Differe de type 2 : le capital ne bouge pas, les interets restent dus.
    const t = tableauAmortissement({ ...base, periodicite: 4, differe_ans: 4, differe_type: 2 });
    for (const l of t.slice(0, 4)) {
      expect(l.amortissement_eur).toBe(0);
      expect(l.crd_eur).toBeCloseTo(100_000, 6);
      expect(l.interets_eur).toBeCloseTo(2_000, 6); // 4 x (2 %/4) x 100 000
    }
    expect(t.at(-1)?.crd_eur).toBeCloseTo(0, 5);
    expect(sommeAmortissements(t)).toBeCloseTo(100_000, 5);
  });

  it('applique le plancher de taux en trimestriel aussi', () => {
    const t = tableauAmortissement({
      ...base,
      periodicite: 4,
      taux: -0.0075,
      revisabilite: 'D. LIMITEE',
      livret_a_origine: 0.015,
      taux_plancher: 0.0025,
    });
    expect(t[0].taux).toBeCloseTo(0.0025, 12);
    expect(t.at(-1)?.crd_eur).toBeCloseTo(0, 5);
  });
});
