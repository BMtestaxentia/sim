// @ts-check
/**
 * R-TRESO - Tresorerie de la phase chantier et indexation des depenses.
 *
 * L'oracle de l'indexation est le classeur « Indexeur cout travaux » fourni par
 * le metier : ses valeurs sont recalculees a la main ici, jamais recopiees du
 * code teste. Le reste sont des invariants de flux - tout ce qui sort est
 * finance par quelque chose.
 */
import { describe, it, expect } from 'vitest';
import { tresorerieChantier } from '../src/tresorerie.js';

const base = {
  date_debut_travaux: '2026-01-01',
  duree_chantier_mois: 24,
  cout_total_eur: 2_400_000,
};

describe('R-TRESO echeancier du chantier', () => {
  it('une echeance par mois de chantier, la premiere un mois APRES l ordre de service', () => {
    const { lignes } = tresorerieChantier(base);
    expect(lignes).toHaveLength(24);
    expect(lignes[0].mois).toBe(1);
    expect(lignes[0].date).toBe('2026-02-01');
    expect(lignes.at(-1)?.date).toBe('2028-01-01');
  });

  it('repartit le cout a PARTS EGALES sans indexation', () => {
    const { lignes, indicateurs } = tresorerieChantier(base);
    for (const l of lignes) expect(l.depenses_eur).toBe(100_000);
    expect(indicateurs.total_depenses_eur).toBe(2_400_000);
    expect(indicateurs.surcout_indexation_eur).toBe(0);
  });

  it('depense exactement le cout, quelles que soient les arrondis', () => {
    const { lignes, indicateurs } = tresorerieChantier({
      ...base,
      duree_chantier_mois: 7,
      taux_indexation: 0.02,
    });
    const somme = lignes.reduce((s, l) => s + l.depenses_eur, 0);
    expect(somme).toBe(indicateurs.total_depenses_eur);
  });
});

describe('R-TRESO-2 indexation, oracle du classeur metier', () => {
  // Cas du classeur : 100 000 EUR, valeur six mois AVANT le demarrage, chantier
  // de douze mois, indexation a 2 % l'an, base 365,25.
  const cas = {
    date_debut_travaux: '2026-07-01',
    date_valeur_cout: '2026-01-01',
    duree_chantier_mois: 12,
    cout_total_eur: 100_000,
    taux_indexation: 0.02,
  };
  const jours = (a, b) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

  it('revise le cout de la date de valeur au demarrage', () => {
    const { indicateurs } = tresorerieChantier(cas);
    const attendu = 100_000 * 1.02 ** (jours('2026-01-01', '2026-07-01') / 365.25);
    expect(indicateurs.cout_revise_eur).toBe(Math.round(attendu));
    expect(indicateurs.revision_au_demarrage_eur).toBe(Math.round(attendu - 100_000));
  });

  it("l'echeance nominale est le cout REVISE divise par la duree", () => {
    const { indicateurs } = tresorerieChantier(cas);
    expect(indicateurs.echeance_nominale_eur).toBe(
      Math.round(indicateurs.cout_revise_eur / 12),
    );
  });

  it('n indexe chaque echeance que de SA propre duree', () => {
    // « Seules les sommes dues sont indexees » : la premiere echeance ne subit
    // qu'un mois d'indexation, la derniere douze.
    const { lignes } = tresorerieChantier(cas);
    expect(lignes[0].coefficient).toBeCloseTo(
      1.02 ** (jours('2026-07-01', '2026-08-01') / 365.25),
      12,
    );
    expect(lignes.at(-1)?.coefficient).toBeCloseTo(
      1.02 ** (jours('2026-07-01', '2027-07-01') / 365.25),
      12,
    );
    // Coefficients croissants, et le premier depasse tout juste 1.
    expect(lignes[0].coefficient).toBeGreaterThan(1);
    for (let i = 1; i < lignes.length; i++) {
      expect(lignes[i].coefficient).toBeGreaterThan(lignes[i - 1].coefficient);
    }
  });

  it('chiffre le surcout total, revision de depart comprise', () => {
    const { indicateurs } = tresorerieChantier(cas);
    // Le classeur donne +2,085 % sur ce jeu de parametres.
    expect(indicateurs.surcout_indexation_eur / 100_000).toBeCloseTo(0.0208, 3);
    expect(indicateurs.surcout_indexation_eur).toBeGreaterThan(
      indicateurs.revision_au_demarrage_eur,
    );
  });

  it('sans taux, aucune indexation nulle part', () => {
    const { lignes, indicateurs } = tresorerieChantier({ ...cas, taux_indexation: 0 });
    expect(indicateurs.cout_revise_eur).toBe(100_000);
    expect(indicateurs.surcout_indexation_eur).toBe(0);
    for (const l of lignes) expect(l.coefficient).toBe(1);
  });
});

describe('R-TRESO financement du chantier', () => {
  // Ces cas decrivent le tirage AU FIL DE L EAU. Le defaut est desormais le
  // tirage integral (R-TRESO-4) : le preciser evite qu un changement de defaut
  // fasse passer ces tests pour des regressions.
  const avec = {
    ...base, subventions_eur: 300_000, fonds_propres_eur: 100_000,
    mode_tirage: 'au_fil_de_l_eau',
  };

  it('mobilise subventions et fonds propres avant la premiere echeance', () => {
    const { lignes } = tresorerieChantier(avec);
    expect(lignes[0].subventions_eur).toBe(300_000);
    expect(lignes[0].fonds_propres_eur).toBe(100_000);
    expect(lignes.slice(1).every((l) => l.subventions_eur === 0)).toBe(true);
    // 400 000 encaisses contre 100 000 dus : rien a tirer le premier mois.
    expect(lignes[0].tirage_eur).toBe(0);
    expect(lignes[0].solde_eur).toBe(300_000);
  });

  it('ne tire les prets qu a hauteur du manque', () => {
    const { lignes } = tresorerieChantier(avec);
    expect(lignes.every((l) => l.solde_eur >= 0)).toBe(true);
    // Les quatre premieres echeances sont couvertes par l'apport initial.
    expect(lignes.slice(0, 4).every((l) => l.tirage_eur === 0)).toBe(true);
    expect(lignes[4].tirage_eur).toBeGreaterThan(0);
  });

  it('boucle : depenses = subventions + fonds propres + tirages', () => {
    const { indicateurs: i } = tresorerieChantier(avec);
    expect(i.total_subventions_eur + i.total_fonds_propres_eur + i.total_tirages_eur).toBe(
      i.total_depenses_eur,
    );
  });

  it('chiffre le besoin maximal et le mois ou il tombe', () => {
    const { indicateurs } = tresorerieChantier(avec);
    expect(indicateurs.besoin_maximal_eur).toBe(2_400_000 - 400_000);
    expect(indicateurs.mois_pic).toBe(24);
  });

  it('produit l echeancier de tirages attendu par le prefinancement', () => {
    const { tirages, indicateurs } = tresorerieChantier(avec);
    expect(tirages.reduce((s, t) => s + t.montant_eur, 0)).toBe(indicateurs.total_tirages_eur);
    expect(tirages[0].date).toBe('2026-06-01');
  });

  it('sans tirage, le solde plonge et dit le besoin brut', () => {
    const { lignes } = tresorerieChantier({ ...avec, tirer_les_prets: false });
    expect(lignes.at(-1)?.solde_eur).toBe(-(2_400_000 - 400_000));
    expect(lignes.every((l) => l.tirage_eur === 0)).toBe(true);
  });
});

describe('R-TRESO-3 appels de fonds en VEFA', () => {
  // Le bareme legal, tel que le metier l'a fourni.
  const jalons = [
    { id: 'signature', part: 0.25, avancement: 0 },
    { id: 'fondations', part: 0.1, avancement: 0.15 },
    { id: 'plancher', part: 0.15, avancement: 0.3 },
    { id: 'hors_eau', part: 0.15, avancement: 0.5 },
    { id: 'hors_air', part: 0.15, avancement: 0.7 },
    { id: 'livraison', part: 0.15, avancement: 1 },
    { id: 'reserves', part: 0.03, avancement: 1 },
    { id: 'conformite', part: 0.01, avancement: 1 },
    { id: 'gpa', part: 0.01, avancement: 1 },
  ];
  const vefa = { ...base, jalons, tirer_les_prets: false };

  it('appelle un quart du prix de revient des le premier mois', () => {
    const { lignes } = tresorerieChantier(vefa);
    expect(lignes[0].depenses_eur).toBe(600_000); // 25 % de 2 400 000
  });

  it('groupe a la livraison les jalons qui la suivent', () => {
    // Reserves, conformite et garantie tombent apres la livraison ; la
    // tresorerie de chantier s'y arretant, ils y sont ramenes. Les ignorer
    // ferait manquer 5 % du prix de revient.
    const { lignes } = tresorerieChantier(vefa);
    expect(lignes.at(-1)?.depenses_eur).toBe(2_400_000 * 0.2);
  });

  it('depense exactement le prix de revient, jalons compris', () => {
    const { lignes, indicateurs } = tresorerieChantier(vefa);
    expect(lignes.reduce((s, l) => s + l.depenses_eur, 0)).toBe(2_400_000);
    expect(indicateurs.total_depenses_eur).toBe(2_400_000);
    expect(indicateurs.jalons_utilises).toBe(true);
  });

  it('laisse des mois SANS appel de fonds, contrairement aux parts egales', () => {
    const { lignes } = tresorerieChantier(vefa);
    expect(lignes.filter((l) => l.depenses_eur === 0).length).toBeGreaterThan(0);
    // Sans jalons, chaque mois porte sa part : c'est toute la difference.
    const egal = tresorerieChantier({ ...base, tirer_les_prets: false });
    expect(egal.lignes.every((l) => l.depenses_eur > 0)).toBe(true);
  });

  it('indexe chaque appel de fonds de SA date, pas d une date moyenne', () => {
    const t = tresorerieChantier({ ...vefa, taux_indexation: 0.02 });
    // Le premier appel n'a qu'un mois d'indexation, le dernier vingt-quatre.
    expect(t.lignes[0].coefficient).toBeLessThan(t.lignes.at(-1).coefficient);
    expect(t.indicateurs.total_depenses_eur).toBeGreaterThan(2_400_000);
  });
});

describe('R-TRESO-4 mode de tirage', () => {
  const avec = { ...base, subventions_eur: 300_000, fonds_propres_eur: 100_000 };

  it('en INTEGRAL, tire tout le prêt au premier mois', () => {
    const { lignes, indicateurs, tirages } = tresorerieChantier({ ...avec, mode_tirage: 'integral' });
    expect(tirages).toHaveLength(1);
    expect(lignes[0].tirage_eur).toBe(2_400_000 - 400_000);
    expect(indicateurs.total_tirages_eur).toBe(2_000_000);
    expect(lignes.slice(1).every((l) => l.tirage_eur === 0)).toBe(true);
  });

  it('en integral, la caisse est pleine puis se vide jusqu a zero', () => {
    const { lignes, indicateurs } = tresorerieChantier({ ...avec, mode_tirage: 'integral' });
    expect(indicateurs.tresorerie_maximale_eur).toBeGreaterThan(0);
    expect(lignes.at(-1)?.solde_eur).toBe(0);
    expect(lignes.every((l) => l.solde_eur >= 0)).toBe(true);
  });

  it('les deux modes financent le meme total, pas au meme rythme', () => {
    const i = tresorerieChantier({ ...avec, mode_tirage: 'integral' }).indicateurs;
    const f = tresorerieChantier({ ...avec, mode_tirage: 'au_fil_de_l_eau' }).indicateurs;
    expect(i.total_tirages_eur).toBe(f.total_tirages_eur);
    // Mais l'integral laisse dormir de l'argent en caisse, l'autre non.
    expect(i.tresorerie_maximale_eur).toBeGreaterThan(f.tresorerie_maximale_eur);
  });
});
