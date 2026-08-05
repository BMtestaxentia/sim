// @ts-check
/**
 * Golden tests : le moteur confronte aux valeurs calculees par LEON lui-meme.
 *
 * Protocole (CLAUDE.md §5) : une fixture = entrees.json (reconstruites depuis la
 * saisie) + attendus.json (valeurs de sortie de LEON). Tolerances : +/-1 EUR sur
 * le bilan et le plan de financement, +/-0,1 % sur les annuites et les lignes
 * d'exploitation. Un ecart au-dela est un bug du moteur OU un bug documente de
 * LEON (docs/ECARTS_LEON.md) — jamais une fixture qu'on ajuste.
 *
 * Couverture actuelle : R-AMT (amortissement). Le reste de la chaine (bilan,
 * loyers, financement, exploitation) viendra avec les modules correspondants.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tableauAmortissement } from '../src/amortissement.js';
import { calculer } from '../src/moteur.js';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} nom @param {string} fichier */
function fixture(nom, fichier) {
  return JSON.parse(readFileSync(join(RACINE, 'fixtures', nom, fichier), 'utf8'));
}

/** Tolerance relative de 0,1 % sur les annuites, avec plancher absolu au centime. */
function tolerance(valeurAttendue) {
  return Math.max(Math.abs(valeurAttendue) * 0.001, 0.01);
}

describe('golden — BERGERAC LLS 6 PLS (matrice LEON 2025-042d)', () => {
  const entrees = fixture('bergerac_lls6_pls', 'entrees.json');
  const attendus = fixture('bergerac_lls6_pls', 'attendus.json');
  const { livret_a_origine, livret_a_par_annee } = entrees.referentiel_amortissement;

  for (const pret of entrees.prets) {
    describe(pret.libelle, () => {
      const obtenu = tableauAmortissement({
        montant_eur: pret.montant_eur,
        taux: pret.taux,
        progressivite: pret.progressivite,
        duree_ans: pret.duree_ans,
        annee_premiere_echeance: pret.annee_premiere_echeance,
        revisabilite: pret.revisabilite,
        differe_ans: pret.differe_ans,
        livret_a_origine,
        livret_a_par_annee,
      });
      const attendu = attendus.prets[pret.code].tableau;

      it('produit une table de meme longueur et sur les memes annees', () => {
        expect(obtenu).toHaveLength(attendu.length);
        expect(obtenu.map((l) => l.annee)).toEqual(attendu.map((l) => l.annee));
      });

      it('applique le taux revise de LEON (SIMPLE : le taux suit le Livret A)', () => {
        for (const [i, ligne] of obtenu.entries()) {
          expect(ligne.taux).toBeCloseTo(attendu[i].taux, 10);
        }
      });

      it('reproduit les annuites a +/-0,1 %', () => {
        for (const [i, ligne] of obtenu.entries()) {
          expect(
            Math.abs(ligne.annuite_eur - attendu[i].annuite_eur),
            `annee ${attendu[i].annee} : ${ligne.annuite_eur} vs ${attendu[i].annuite_eur}`,
          ).toBeLessThanOrEqual(tolerance(attendu[i].annuite_eur));
        }
      });

      it('reproduit interets, amortissement et CRD annee par annee', () => {
        for (const [i, ligne] of obtenu.entries()) {
          const a = attendu[i];
          expect(Math.abs(ligne.interets_eur - a.interets_eur)).toBeLessThanOrEqual(
            tolerance(a.interets_eur),
          );
          expect(Math.abs(ligne.amortissement_eur - a.amortissement_eur)).toBeLessThanOrEqual(
            tolerance(a.amortissement_eur),
          );
          expect(
            Math.abs(ligne.crd_eur - a.crd_eur),
            `CRD annee ${a.annee} : ${ligne.crd_eur} vs ${a.crd_eur}`,
          ).toBeLessThanOrEqual(tolerance(a.crd_eur));
        }
      });

      it('solde exactement le capital emprunte', () => {
        const somme = obtenu.reduce((s, l) => s + l.amortissement_eur, 0);
        expect(somme).toBeCloseTo(pret.montant_eur, 4);
        expect(obtenu.at(-1)?.crd_eur).toBeCloseTo(0, 4);
      });
    });
  }
});

/**
 * MULHOUSE 3308 — partie LIBRE, VEFA zone 2 / B1, 11 logements.
 *
 * Cette fixture vient d'une ANNEXE LEON (et non de la matrice) : elle porte les
 * valeurs de la Presentation CA et de la Grille d'analyse. Elle exerce la chaine
 * complete `calculer()` la ou Bergerac ne validait que l'amortissement, et sur
 * un profil de pret oppose : TAUX FIXE sans progressivite, contre SIMPLE revise.
 *
 * Particularite du jeu : tous les postes portent une TVA nulle et un TTC egal au
 * HT. Ils sont donc hors champ de la livraison a soi-meme, sans quoi le taux
 * LIBRE de 20 % s'appliquerait et le prix de revient serait faux de 413 kEUR.
 * Voir QUESTIONS_SPEC Q-24 : est-ce une regle du produit ou une saisie propre a
 * cette operation ?
 */
describe('golden — MULHOUSE 3308 LIBRE (annexe LEON, chaine complete)', () => {
  const attendus = fixture('mulhouse_3308_libre', 'attendus.json');
  const baremes = JSON.parse(
    readFileSync(join(RACINE, 'referentiels', 'baremes_2025.json'), 'utf8'),
  );
  const trajectoires = JSON.parse(
    readFileSync(join(RACINE, 'referentiels', 'trajectoires_axentia_2026.json'), 'utf8'),
  );

  const PRET = attendus.prets.find((p) => p.montant);
  const T = attendus.totaux_plan_financement;

  const entreesLibre = {
      identite: { nom: 'MULHOUSE LIBRE', produit: 'LIBRE', zone_123: 2, zone_ABC: 'B1', type_operation: 'VEFA' },
      dates: { annee_mise_en_location: 2026, duree_simulation_ans: 18 },
      lots: [{ code_produit: 'LIBRE', nb_logements: 11, shab_m2: 545.8, surfaces_annexes_m2: 0 }],
      // Postes repris de l'annexe, avec leur chapitre. `hors_lasm` parce que
      // l'annexe donne TTC = HT sur chacun d'eux.
      postes_bilan: attendus.bilan.postes
        .filter((p) => p.ht)
        .map((p) => ({
          chapitre: p.chapitre.startsWith('I -')
            ? 'charge_fonciere'
            : p.chapitre.startsWith('III')
              ? 'honoraires'
              : 'frais_financiers',
          libelle: p.libelle,
          montant_ht_eur: p.ht,
          taux_tva: p.tva ?? 0,
          hors_lasm: true,
        })),
      fonds_propres_eur: T.fonds_propres_non_remuneres,
      prets: [
        {
          code: 'LIBRE',
          libelle: PRET.libelle,
          nature: 'construction',
          montant_eur: PRET.montant,
          taux: PRET.taux,
          progressivite: PRET.progressivite,
          duree_ans: PRET.duree_ans,
          // R-AMT-3 : mise en location 2026, premiere echeance 2027. L'annexe le
          // confirme, son annee 1 (2026) ne porte aucune annuite.
          annee_premiere_echeance: 2027,
          revisabilite: PRET.revisabilite,
        },
      ],
  };

  const resultat = calculer(entreesLibre, { baremes, trajectoires });

  it('reproduit le prix de revient total a +/-1 EUR', () => {
    expect(
      Math.abs(resultat.bilan.total_ttc_module_eur - attendus.bilan.total_prix_revient.ttc),
    ).toBeLessThanOrEqual(1);
  });

  it('reproduit chaque chapitre du bilan a +/-1 EUR', () => {
    const parChapitre = {
      charge_fonciere: attendus.bilan.chapitres['I - CHARGE FONCIERE'].ttc,
      honoraires: attendus.bilan.chapitres['III - HONORAIRES'].ttc,
      frais_financiers: attendus.bilan.chapitres['V - FRAIS FINANCIERS'].ttc,
    };
    for (const [code, attendu] of Object.entries(parChapitre)) {
      expect(
        Math.abs(resultat.bilan.chapitres[code].ttc_lasm_eur - attendu),
        `chapitre ${code}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('equilibre le plan de financement, comme l annexe', () => {
    expect(Math.abs(resultat.financement.equilibre.ecart_eur)).toBeLessThanOrEqual(1);
    expect(Math.abs(resultat.financement.total_prets_eur - T.total_prets)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(resultat.indicateurs.ressources_eur - T.total_financements),
    ).toBeLessThanOrEqual(1);
  });

  it('reproduit la part de prets et de fonds propres du plan de financement', () => {
    const pctPrets = resultat.financement.total_prets_eur / resultat.bilan.total_ttc_module_eur;
    expect(pctPrets).toBeCloseTo(T.pct_prets, 5);
    expect(resultat.indicateurs.taux_fonds_propres).toBeCloseTo(T.pct_fp, 5);
  });

  it('reproduit les annuites du pret LIBRE a +/-0,1 %', () => {
    // L'annexe donne la serie en kEUR : constante des la premiere echeance,
    // le pret etant a taux fixe et sans progressivite.
    const attenduesKeur = attendus.synthese_exploitation_par_annee
      .filter((l) => l.annuites_cdc_keur > 0)
      .map((l) => ({ annee: l.annee, annuite_eur: l.annuites_cdc_keur * 1000 }));
    expect(attenduesKeur.length).toBeGreaterThan(10);

    const table = resultat.amortissements[0].tableau;
    const parAnnee = Object.fromEntries(table.map((l) => [l.annee, l]));
    for (const a of attenduesKeur) {
      const obtenu = parAnnee[a.annee];
      expect(obtenu, `annee ${a.annee} absente du tableau`).toBeDefined();
      expect(
        Math.abs(obtenu.annuite_eur - a.annuite_eur) / a.annuite_eur,
        `annee ${a.annee} : ${obtenu.annuite_eur} vs ${a.annuite_eur}`,
      ).toBeLessThanOrEqual(0.001);
    }
  });

  it('applique la regle R-AMT-3 : aucune annuite l annee de mise en location', () => {
    const table = resultat.amortissements[0].tableau;
    expect(table[0].annee).toBe(2027);
    expect(table.some((l) => l.annee === 2026)).toBe(false);
    // L'annexe porte bien 0 en 2026 et la premiere annuite en 2027.
    const annexe2026 = attendus.synthese_exploitation_par_annee.find((l) => l.annee === 2026);
    expect(annexe2026.annuites_cdc_keur).toBe(0);
  });

  it('reproduit les interets de la premiere echeance', () => {
    // Serie « resultat_par_annee » de l'annexe : interets d'emprunts de l'annee 2.
    const attendu = attendus.resultat_par_annee[1].interets_emprunts_eur;
    const premiere = resultat.amortissements[0].tableau[0];
    expect(Math.abs(premiere.interets_eur - attendu) / attendu).toBeLessThanOrEqual(0.001);
  });

  it('solde le pret sur sa duree contractuelle', () => {
    const table = resultat.amortissements[0].tableau;
    expect(table).toHaveLength(PRET.duree_ans);
    expect(table.at(-1)?.crd_eur).toBeCloseTo(0, 4);
    const somme = table.reduce((s, l) => s + l.amortissement_eur, 0);
    expect(Math.abs(somme - PRET.montant)).toBeLessThanOrEqual(1);
  });

  it('reproduit la base d amortissement comptable de la Grille d analyse', () => {
    const g = attendus.grille_analyse;
    const terrain = attendus.bilan.postes.find((x) => x.libelle === 'Terrain');
    // La quotite est fournie par l'appelant, pas devinee : l'annexe applique
    // 25 % du poste Terrain (Q-26).
    const avecAmort = calculer(
      { ...entreesLibre, amortissement_comptable: { montant_terrain_eur: terrain.ht, quotite_terrain: 0.25 } },
      { baremes, trajectoires },
    );
    const a = avecAmort.indicateurs.amortissement_comptable;
    expect(Math.abs(a.valeur_comptable_terrain_eur - g.valeur_comptable_terrain)).toBeLessThanOrEqual(1);
    expect(Math.abs(a.base_eur - g.base_amortissement)).toBeLessThanOrEqual(1);
    expect(a.part_du_prix_revient).toBeCloseTo(g.base_amort_sur_pr_ttc, 5);
  });

  it('ne calcule pas la base d amortissement sans quotite explicite', () => {
    expect(resultat.indicateurs.amortissement_comptable).toBe(null);
  });

});

/**
 * MULHOUSE 3307 — partie LLI, meme operation que la fixture LIBRE.
 *
 * Ce jeu porte trois prets dont deux en revisabilite DOUBLE avec progressivite
 * -0,5 %, ce qui en ferait le meilleur test possible du re-amortissement annuel
 * (R-AMT-4). Il ne l'est pas encore : les annuites de l'annexe dependent de la
 * trajectoire de Livret A avec laquelle elle a ete calculee, et cette
 * trajectoire n'est pas dans le depot. Voir QUESTIONS_SPEC Q-25.
 *
 * Sont donc testes ici les blocs INDEPENDANTS de cette trajectoire : prix de
 * revient, plan de financement et montants des prets. La comparaison des
 * annuites reste en attente.
 */
describe('golden — MULHOUSE 3307 LLI (bilan et plan de financement)', () => {
  const attendus = fixture('mulhouse_3308_lli', 'attendus.json');
  const baremes = JSON.parse(readFileSync(join(RACINE, 'referentiels', 'baremes_2025.json'), 'utf8'));
  const trajectoires = JSON.parse(
    readFileSync(join(RACINE, 'referentiels', 'trajectoires_axentia_2026.json'), 'utf8'),
  );
  const T = attendus.totaux_plan_financement;
  const pretsCDC = attendus.prets.filter((p) => p.montant > 0 && p.duree_ans);
  const autresPrets = attendus.prets.filter((p) => p.montant > 0 && !p.duree_ans);

  const resultat = calculer(
    {
      identite: { nom: 'MULHOUSE LLI', produit: 'LOC', zone_123: 2, zone_ABC: 'B1', type_operation: 'VEFA' },
      dates: { annee_mise_en_location: 2026, duree_simulation_ans: 18 },
      // Le loyer LLI n'est pas testable : son bareme est absent du referentiel
      // (defaut V5 connu). On passe par le produit LIBRE, dont seul le prix de
      // revient nous interesse ici — la ventilation etant au prorata SU et
      // l'operation mono-tranche, le choix n'affecte aucun montant teste.
      lots: [{ code_produit: 'LIBRE', nb_logements: 121, shab_m2: 6000, surfaces_annexes_m2: 0 }],
      postes_bilan: attendus.bilan.postes
        .filter((p) => p.ht)
        .map((p) => ({
          chapitre: p.chapitre.startsWith('I -')
            ? 'charge_fonciere'
            : p.chapitre.startsWith('III')
              ? 'honoraires'
              : 'frais_financiers',
          libelle: p.libelle,
          montant_ht_eur: p.ht,
          taux_tva: p.tva ?? 0,
          hors_lasm: true,
        })),
      subventions: [{ libelle: 'Subventions', montant_eur: T.total_subventions }],
      fonds_propres_eur: T.fonds_propres_non_remuneres,
      prets: [
        ...pretsCDC.map((p, i) => ({
          code: `CDC_${i}`, libelle: p.libelle, nature: i === 0 ? 'construction' : 'foncier',
          montant_eur: p.montant, taux: p.taux, progressivite: p.progressivite,
          duree_ans: p.duree_ans, annee_premiere_echeance: 2027, revisabilite: p.revisabilite,
          livret_a_origine: 0.02,
        })),
        ...autresPrets.map((p, i) => ({
          code: `AUTRE_${i}`, libelle: p.libelle, nature: 'autre',
          montant_eur: p.montant, taux: 0, progressivite: 0, duree_ans: 30,
          annee_premiere_echeance: 2027, revisabilite: 'TAUX FIXE',
        })),
      ],
    },
    { baremes, trajectoires },
  );

  it('reproduit le prix de revient total a +/-1 EUR', () => {
    expect(
      Math.abs(resultat.bilan.total_ttc_module_eur - attendus.bilan.total_prix_revient.ttc),
    ).toBeLessThanOrEqual(1);
  });

  it('reproduit le total des prets et des fonds propres', () => {
    expect(Math.abs(resultat.financement.total_prets_eur - T.total_prets)).toBeLessThanOrEqual(1);
    expect(resultat.indicateurs.fonds_propres_eur).toBe(T.fonds_propres_non_remuneres);
    expect(resultat.indicateurs.subventions_eur).toBe(T.total_subventions);
  });

  it('reproduit les parts du plan de financement', () => {
    const pr = resultat.bilan.total_ttc_module_eur;
    expect(resultat.financement.total_prets_eur / pr).toBeCloseTo(T.pct_prets, 4);
    expect(resultat.indicateurs.taux_fonds_propres).toBeCloseTo(T.pct_fp, 4);
    expect(resultat.indicateurs.subventions_eur / pr).toBeCloseTo(T.pct_subventions, 4);
  });

  it('equilibre le plan de financement', () => {
    // L'annexe affiche un total de financements arrondi a l'euro (9 680 671)
    // pour un prix de revient de 9 680 671,45 : l'ecart de 0,45 EUR est un
    // arrondi de PRESENTATION de LEON, a ne pas reproduire (fixtures/README).
    expect(Math.abs(resultat.financement.equilibre.ecart_eur)).toBeLessThanOrEqual(1);
  });

  it('n inclut que les prets CDC dans le ratio reglementaire', () => {
    // Le pret ALS de 100 000 EUR est un pret « autre » : il compte dans les
    // ressources mais pas dans la quotite CDC.
    expect(resultat.financement.total_prets_cdc_eur).toBe(
      pretsCDC.reduce((s, p) => s + p.montant, 0),
    );
    expect(resultat.financement.total_prets_eur).toBe(T.total_prets);
  });
});
