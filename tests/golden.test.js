// @ts-check
/**
 * Golden tests : le moteur confronte aux valeurs calculees par LEON lui-meme.
 *
 * Protocole (CLAUDE.md §5) : une fixture = entrees.json (reconstruites depuis la
 * saisie) + attendus.json (valeurs de sortie de LEON). Tolerances : +/-1 EUR sur
 * le bilan et le plan de financement, +/-0,1 % sur les annuites et les lignes
 * d'exploitation. Un ecart au-dela est un bug du moteur OU un bug documente de
 * LEON (docs/ECARTS_LEON.md) - jamais une fixture qu'on ajuste.
 *
 * Couverture actuelle : R-AMT (amortissement). Le reste de la chaine (bilan,
 * loyers, financement, exploitation) viendra avec les modules correspondants.
 */
import { describe, it, expect } from 'vitest';
import { fixturesReellesPresentes, lireFixtureReelle } from './fixtures-reelles.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tableauAmortissement } from '../src/amortissement.js';
import { compteExploitation } from '../src/exploitation.js';
import { calculer } from '../src/moteur.js';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} nom @param {string} fichier */
function fixture(nom, fichier) {
  return lireFixtureReelle(nom, fichier);
}

/** Tolerance relative de 0,1 % sur les annuites, avec plancher absolu au centime. */
function tolerance(valeurAttendue) {
  return Math.max(Math.abs(valeurAttendue) * 0.001, 0.01);
}

describe.skipIf(!fixturesReellesPresentes)('golden - OP-3 (matrice LEON 2025-042d)', () => {
  const entrees = fixture('op-3-pls', 'entrees.json');
  const attendus = fixture('op-3-pls', 'attendus.json');
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
 * OP-1 - partie LIBRE, VEFA zone 2 / B1, 11 logements.
 *
 * Cette fixture vient d'une ANNEXE LEON (et non de la matrice) : elle porte les
 * valeurs de la Presentation CA et de la Grille d'analyse. Elle exerce la chaine
 * complete `calculer()` la ou OP-3 ne validait que l'amortissement, et sur
 * un profil de pret oppose : TAUX FIXE sans progressivite, contre SIMPLE revise.
 *
 * Particularite du jeu : tous les postes portent une TVA nulle et un TTC egal au
 * HT. Ils sont donc hors champ de la livraison a soi-meme, sans quoi le taux
 * LIBRE de 20 % s'appliquerait et le prix de revient serait faux de 413 kEUR.
 * Voir QUESTIONS_SPEC Q-24 : est-ce une regle du produit ou une saisie propre a
 * cette operation ?
 */
describe.skipIf(!fixturesReellesPresentes)('golden - OP-1 LIBRE (annexe LEON, chaine complete)', () => {
  const attendus = fixture('op-1-libre', 'attendus.json');
  const baremes = JSON.parse(
    readFileSync(join(RACINE, 'referentiels', 'baremes_her_2027.json'), 'utf8'),
  );
  const trajectoires = JSON.parse(
    readFileSync(join(RACINE, 'referentiels', 'trajectoires_axentia_2026.json'), 'utf8'),
  );

  const PRET = attendus.prets.find((p) => p.montant);
  const T = attendus.totaux_plan_financement;

  const entreesLibre = {
      identite: { nom: 'OP-1', zone_123: 2, zone_ABC: 'B1', type_operation: 'VEFA' },
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
 * OP-2 - partie LLI, meme operation que la fixture LIBRE.
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
describe.skipIf(!fixturesReellesPresentes)('golden - OP-2 LLI (bilan et plan de financement)', () => {
  const attendus = fixture('op-2-lli', 'attendus.json');
  const baremes = JSON.parse(readFileSync(join(RACINE, 'referentiels', 'baremes_her_2027.json'), 'utf8'));
  const trajectoires = JSON.parse(
    readFileSync(join(RACINE, 'referentiels', 'trajectoires_axentia_2026.json'), 'utf8'),
  );
  const T = attendus.totaux_plan_financement;
  const pretsCDC = attendus.prets.filter((p) => p.montant > 0 && p.duree_ans);
  const autresPrets = attendus.prets.filter((p) => p.montant > 0 && !p.duree_ans);

  const resultat = calculer(
    {
      identite: { nom: 'OP-2', zone_123: 2, zone_ABC: 'B1', type_operation: 'VEFA' },
      dates: { annee_mise_en_location: 2026, duree_simulation_ans: 18 },
      // OP-2 est une operation LLI, et la tranche le dit. Le detour par le
      // produit LIBRE datait du defaut V5, quand le bareme de loyer du LLI
      // pointait vers une cle inexistante ; il est corrige depuis, et le detour
      // est devenu faux : le libre ne se finance pas sur fonds d'epargne, ce qui
      // vidait la quotite CDC verifiee plus bas.
      lots: [{ code_produit: 'LOC', nb_logements: 121, shab_m2: 6000, surfaces_annexes_m2: 0 }],
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

/**
 * OP-6 - foyer PLUS/PLAI, la PREMIERE fixture du perimetre V1 declare.
 *
 * C'est le test le plus exigeant du moteur d'amortissement : quatre prets CDC en
 * revisabilite DOUBLE avec progressivite -0,5 %, sur une trajectoire de Livret A
 * NON constante (1,5 % en 2029 puis 2 %), embarquee dans l'annexe elle-meme
 * (Presentation CA, colonne K). C'est exactement la donnee dont l'absence
 * bloquait les annuites LLI (Q-25).
 *
 * La colonne ANNUITES de l'annexe agrege les 4 prets CDC et le collecteur : la
 * comparaison porte donc sur la SOMME des cinq tableaux.
 *
 * Hors perimetre ici : le compte d'exploitation en mode foyer (redevance,
 * Q-27) et le bilan (les postes ne sont pas repris dans cette fixture).
 */
describe.skipIf(!fixturesReellesPresentes)('golden - OP-6 PLUS/PLAI (revisabilite DOUBLE, trajectoire LA reelle)', () => {
  const entrees = fixture('op-6-foyer-plus-plai', 'entrees.json');
  const attendus = fixture('op-6-foyer-plus-plai', 'attendus.json');

  const la0 = entrees.taux_evolution.livret_a_origine;
  const laParAnnee = entrees.livret_a_par_annee;

  const tables = entrees.prets.map((p) =>
    tableauAmortissement({
      montant_eur: p.montant_eur,
      taux: p.taux,
      progressivite: p.progressivite,
      duree_ans: p.duree_ans,
      annee_premiere_echeance: entrees.dates.annee_premiere_echeance,
      revisabilite: p.revisabilite,
      livret_a_origine: la0,
      livret_a_par_annee: laParAnnee,
    }),
  );

  it('le taux de chaque pret CDC vaut LA d origine plus sa marge (R-AMT-1)', () => {
    for (const p of entrees.prets.filter((x) => x.marge !== undefined)) {
      expect(p.taux, p.libelle).toBeCloseTo(la0 + p.marge, 10);
    }
  });

  it('reproduit les 60 annees d annuites agregees a +/-0,1 %', () => {
    let comparees = 0;
    for (const a of attendus.annuites_par_annee) {
      if (!a.annuites_keur) continue;
      const somme =
        tables.reduce((s, t) => s + (t.find((l) => l.annee === a.annee)?.annuite_eur ?? 0), 0) / 1000;
      expect(
        Math.abs(somme - a.annuites_keur) / a.annuites_keur,
        `annee ${a.annee} : ${somme} vs ${a.annuites_keur} kEUR`,
      ).toBeLessThanOrEqual(0.001);
      comparees++;
    }
    expect(comparees).toBe(60);
  });

  it('reproduit la rupture de 2069 : extinction des prets travaux 40 ans', () => {
    // Derniere echeance travaux en 2068 (2029 + 40 - 1) : la serie de l'annexe
    // tombe de ~199 a ~54 kEUR en 2069, ou seuls les fonciers 60 ans subsistent.
    const s2068 = attendus.annuites_par_annee.find((a) => a.annee === 2068);
    const s2069 = attendus.annuites_par_annee.find((a) => a.annee === 2069);
    expect(s2068.annuites_keur).toBeGreaterThan(150);
    expect(s2069.annuites_keur).toBeLessThan(60);
    for (const t of tables.filter((x) => x.length === 40)) {
      expect(t.at(-1)?.annee).toBe(2068);
    }
  });

  it('reproduit les interets d emprunts de la premiere annee', () => {
    const attendu = attendus.resultat_par_annee[0].interets_emprunts_eur;
    const somme = tables.reduce((s, t) => s + (t[0]?.interets_eur ?? 0), 0);
    expect(Math.abs(somme - attendu) / attendu).toBeLessThanOrEqual(0.001);
  });

  it('chaque pret solde exactement son capital', () => {
    tables.forEach((t, i) => {
      const somme = t.reduce((s, l) => s + l.amortissement_eur, 0);
      expect(Math.abs(somme - entrees.prets[i].montant_eur), entrees.prets[i].libelle).toBeLessThanOrEqual(0.01);
      expect(t.at(-1)?.crd_eur).toBeCloseTo(0, 4);
    });
  });

  it('le plan de financement de l annexe s equilibre a l arrondi de presentation pres', () => {
    const T = attendus.totaux_plan_financement;
    const ressources = T.total_prets + T.total_subventions + T.fonds_propres;
    expect(Math.abs(ressources - T.total_financements)).toBeLessThanOrEqual(1);
    // L'annexe affiche un ecart de 0,44 EUR entre PR et financements : arrondi
    // de presentation LEON, comme sur la fixture LLI.
    expect(Math.abs(T.total_financements - T.prix_revient_ttc)).toBeLessThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // Q-27 - Compte d'exploitation en mode foyer (redevance forfaitaire).
  //
  // Les parametres ci-dessous ne sont PAS transcrits de l'onglet IN : ils ont ete
  // IDENTIFIES sur les series de sortie de l'annexe. C'est pourquoi ils vivent
  // dans le test et non dans `entrees.json`, qui ne doit contenir que de la
  // donnee source. Ce qu'ils etablissent :
  //
  // - la redevance n'est PAS recomposee depuis les charges. Le rapport
  //   redevance/charges derive continument de 0,814 a 1,88, et les deux ruptures
  //   de charges (fin d'exoneration 2054, extinction des prets 40 ans en 2069)
  //   n'y laissent aucune trace. « Forfaitaire » est a prendre au mot.
  // - redevance, frais de gestion, TEOM et assurance suivent EXACTEMENT une seule
  //   trajectoire (ecart relatif 5,6e-15 sur 60 ans) : +2,1799450549 % en 2030
  //   puis +1,9 % constant.
  // - la TFPB apparait en 2054 (25 ans d'exoneration) et croit a 2,9 % pile, un
  //   taux distinct de la trajectoire generale, constant sur 34 transitions.
  //
  // Reste inconnu : d'ou vient le montant de redevance de l'annee 1.
  const TRAJECTOIRE_GENERALE = { 2030: 0.021799450549450983, 2031: 0.019 };
  const TRAJECTOIRE_TFPB = { 2030: 0.029 };
  const TFPB_BASE_2029_EUR = 30172.8988;

  describe('mode foyer (redevance forfaitaire, Q-27)', () => {
    const annuites = tables.flatMap((t) =>
      t.map((l) => ({ annee: l.annee, annuite_eur: l.annuite_eur })),
    );
    const T0 = attendus.annuites_par_annee[0];

    const compte = compteExploitation({
      annee_mise_en_location: 2029,
      duree_ans: 60,
      mode: 'redevance',
      redevance_annuelle_eur: T0.redevance_eur,
      index_redevance: 'general',
      loyers_logements_annuels_eur: 0,
      // Les montants de l'annexe sont des totaux d'operation : le nombre de
      // logements n'y figure pas. Les postes passent donc en forfait plutot que
      // par les assiettes « par logement », qui exigeraient un effectif invente.
      nb_logements: 0,
      annee_debut_tfpb: 9999,
      annuites,
      charges_diverses: [
        { code: 'gestion', libelle: 'Frais de gestion', assiette: 'forfait',
          valeur: T0.frais_gestion_keur * 1000, index: 'general' },
        { code: 'teom', libelle: 'TEOM', assiette: 'forfait',
          valeur: T0.tfpb_teom_keur * 1000, index: 'general' },
        { code: 'tfpb', libelle: 'Taxe fonciere', assiette: 'forfait',
          valeur: TFPB_BASE_2029_EUR, index: 'tfpb', annee_debut: 2054 },
        { code: 'assurance', libelle: 'Assurance', assiette: 'forfait',
          valeur: T0.assurance_keur * 1000, index: 'general' },
      ],
      trajectoires: {
        general: TRAJECTOIRE_GENERALE,
        gestion: TRAJECTOIRE_GENERALE,
        tfpb: TRAJECTOIRE_TFPB,
      },
    });

    /** Ecart relatif maximal d'un poste calcule contre la colonne de l'annexe. */
    const ecartMax = (calcule, attendu) => {
      let pire = 0;
      let comparees = 0;
      attendus.annuites_par_annee.forEach((att, i) => {
        const cible = attendu(att);
        if (!cible) return;
        pire = Math.max(pire, Math.abs(calcule(compte.lignes[i], i) - cible) / Math.abs(cible));
        comparees++;
      });
      return { pire, comparees };
    };
    const poste = (code) => (l) =>
      l.detail_charges_diverses.find((d) => d.code === code)?.montant_eur ?? 0;

    it('reproduit les 60 annees de redevance depuis le seul montant de l annee 1', () => {
      const { pire, comparees } = ecartMax((l) => l.redevance_eur, (a) => a.redevance_eur);
      expect(comparees).toBe(60);
      expect(pire).toBeLessThanOrEqual(0.001);
    });

    it('reproduit frais de gestion et assurance sur la meme trajectoire', () => {
      expect(ecartMax(poste('gestion'), (a) => a.frais_gestion_keur * 1000).pire).toBeLessThanOrEqual(0.001);
      expect(ecartMax(poste('assurance'), (a) => a.assurance_keur * 1000).pire).toBeLessThanOrEqual(0.001);
    });

    it('reproduit la TFPB/TEOM et sa rupture d exoneration de 2054', () => {
      const { pire, comparees } = ecartMax(
        (l) => poste('teom')(l) + poste('tfpb')(l),
        (a) => a.tfpb_teom_keur * 1000,
      );
      expect(comparees).toBe(60);
      expect(pire).toBeLessThanOrEqual(0.001);

      // La rupture doit etre PRODUITE par le moteur, pas seulement toleree : le
      // poste quintuple entre 2053 et 2054, et pas avant.
      const l2053 = compte.lignes.find((l) => l.annee === 2053);
      const l2054 = compte.lignes.find((l) => l.annee === 2054);
      expect(poste('tfpb')(l2053)).toBe(0);
      expect(poste('tfpb')(l2054)).toBeGreaterThan(0);
      expect(l2054.charges_diverses_eur / l2053.charges_diverses_eur).toBeGreaterThan(2);
    });

    it('reproduit le total des charges annuelles de l annexe', () => {
      const { pire } = ecartMax(
        (l) => l.total_charges_eur,
        (a) =>
          (a.annuites_keur + a.frais_gestion_keur + a.tfpb_teom_keur + a.assurance_keur) * 1000,
      );
      expect(pire).toBeLessThanOrEqual(0.001);
    });

    it('la redevance ne suit PAS les charges : c est un forfait indexe', () => {
      // Garde-fou contre une future « amelioration » qui recomposerait la
      // redevance depuis les charges. Le rapport doit rester monotone croissant
      // et traverser 1, ce qu'une recomposition interdirait.
      const rapports = attendus.annuites_par_annee.map(
        (a) =>
          a.redevance_eur /
          ((a.annuites_keur + a.frais_gestion_keur + a.tfpb_teom_keur + a.assurance_keur) * 1000),
      );
      expect(rapports[0]).toBeLessThan(0.82);
      expect(rapports.at(-1)).toBeGreaterThan(1.85);
    });
  });
});

/**
 * Q-11 - GOLDEN TEST DU COMPTE D'EXPLOITATION.
 *
 * Le compte de LEON pour OP-3 (SimPLS colonnes DM a EC, 81 annees) est verse
 * dans `exploitation_leon.json`. Ce bloc confronte la MECANIQUE du moteur a cette
 * sortie reelle : agregation des annuites, indexation des recettes et de la
 * gestion, table de gros entretien, entree en TFPB, enchainement des soldes.
 *
 * Les valeurs d'ENTREE de LEON lui sont fournies telles quelles - loyer et
 * gestion de l'annee 1, table de gros entretien, colonne « autres depenses ».
 * Ce sont des donnees dans LEON aussi : une table saisie et 51 valeurs en dur
 * (Q-19 et Q-20). Le test ne valide donc pas d'ou elles viennent, mais tout ce
 * que le moteur en fait.
 *
 * La comparaison s'arrete en 2088, derniere annee couverte par la table de gros
 * entretien. Au-dela, le moteur reconduit sa derniere valeur quand LEON continue
 * de la faire croitre d'environ 2,3 % par an : divergence connue, dont la reponse
 * propre est de fournir une table couvrant l'horizon.
 */
describe.skipIf(!fixturesReellesPresentes)('golden - OP-3 compte d exploitation (81 annees de LEON)', () => {
  const leon = fixture('op-3-pls', 'exploitation_leon.json');
  const entrees = fixture('op-3-pls', 'entrees.json');
  const C = leon.compte;
  const ref = entrees.referentiel_amortissement;
  const DERNIERE_ANNEE_TABLE_GE = 2088;

  const annuites = entrees.prets.flatMap((p) =>
    tableauAmortissement({
      montant_eur: p.montant_eur, taux: p.taux, duree_ans: p.duree_ans,
      progressivite: p.progressivite ?? 0, annee_premiere_echeance: p.annee_premiere_echeance,
      revisabilite: p.revisabilite, livret_a_origine: ref.livret_a_origine,
      livret_a_par_annee: ref.livret_a_par_annee,
      differe_ans: p.differe_ans, differe_type: p.differe_type,
    }).map((l) => ({ annee: l.annee, annuite_eur: l.annuite_eur })),
  );

  const compte = compteExploitation({
    annee_mise_en_location: 2028,
    duree_ans: C.length,
    // Loyer et gestion de l'annee 1, indexes a 2 % : c'est la trajectoire plate
    // du classeur (ParaGEN!CT22:DD102).
    loyers_logements_annuels_eur: C[0].total_recettes * 1000,
    frais_gestion_annuels_eur: C[0].frais_gestion * 1000,
    nb_logements: 1,
    shab_m2: leon.shab_tranche_m2,
    gros_entretien_par_annee: leon.table_gros_entretien_eur_par_m2,
    annuites,
    // Les prets NON CDC ont leur colonne propre chez LEON (Q-9).
    annuites_fonds_propres: C.filter((c) => c.annuites_complementaires).map((c) => ({
      annee: c.annee, montant_eur: c.annuites_complementaires * 1000,
    })),
    charges_diverses: [
      { code: 'autres', libelle: 'Autres dépenses', assiette: 'forfait', valeur: 0,
        montants_par_annee: Object.fromEntries(
          C.filter((c) => c.autres_depenses != null).map((c) => [c.annee, c.autres_depenses]),
        ) },
    ],
    tfpb_par_annee: C.filter((c) => c.impots_fonciers > 0).map((c) => ({
      annee: c.annee, montant_eur: c.impots_fonciers * 1000,
    })),
    trajectoires: { loyers_irl: 0.02, gestion: 0.02, tfpb: 0 },
  });

  /** Ecart ABSOLU maximal d'un poste : la divergence est un arrondi, pas un ratio. */
  const ecartMax = (duMoteur, deLeon) => {
    let pire = 0;
    let comparees = 0;
    C.forEach((c, i) => {
      if (c.annee > DERNIERE_ANNEE_TABLE_GE) return;
      pire = Math.max(pire, Math.abs(duMoteur(compte.lignes[i]) - deLeon(c)));
      comparees++;
    });
    return { pire, comparees };
  };

  // Le moteur arrondit chaque poste a l'euro, LEON garde sa precision en kEUR :
  // un demi-euro d'ecart est le maximum atteignable sans erreur de calcul.
  const ARRONDI = 0.5;

  it('couvre les 61 annees ou la table de gros entretien existe', () => {
    expect(ecartMax((l) => l.total_produits_eur, (c) => c.total_recettes * 1000).comparees).toBe(61);
  });

  it('reproduit les recettes, indexees a 2 %', () => {
    expect(ecartMax((l) => l.total_produits_eur, (c) => c.total_recettes * 1000).pire)
      .toBeLessThanOrEqual(ARRONDI);
  });

  it('reproduit les annuites de prets CDC agregees', () => {
    expect(ecartMax((l) => l.annuites_eur, (c) => (c.annuites_construction + c.annuites_foncier) * 1000).pire)
      .toBeLessThanOrEqual(ARRONDI);
  });

  it('reproduit les frais de gestion', () => {
    expect(ecartMax((l) => l.frais_gestion_eur, (c) => c.frais_gestion * 1000).pire)
      .toBeLessThanOrEqual(ARRONDI);
  });

  it('reproduit le gros entretien, table annuelle et montee en charge comprises', () => {
    // Q-19 : le gros entretien n'est pas un taux indexe. Les quatre premieres
    // annees montent de 8,05 a 17,23 EUR/m2, ce qu'aucune indexation ne donne.
    expect(ecartMax((l) => l.gros_entretien_eur, (c) => c.gros_entretien * 1000).pire)
      .toBeLessThanOrEqual(ARRONDI);
    const t = leon.table_gros_entretien_eur_par_m2;
    expect(t[3].eur_par_m2 / t[0].eur_par_m2).toBeGreaterThan(2);
  });

  it('reproduit l entree en taxe fonciere', () => {
    expect(ecartMax((l) => l.tfpb_eur, (c) => c.impots_fonciers * 1000).pire)
      .toBeLessThanOrEqual(ARRONDI);
    // LEON exonere jusqu'en 2053 inclus et taxe a partir de 2054, soit 26 ans
    // apres la mise en location et non 25 : ecart a eclaircir (Q-14 bis).
    expect(C.find((c) => c.impots_fonciers > 0).annee).toBe(2054);
  });

  it('reproduit le total des charges et le solde annuel', () => {
    expect(ecartMax((l) => l.total_charges_eur, (c) => c.total_depenses * 1000).pire)
      .toBeLessThanOrEqual(ARRONDI);
    expect(ecartMax((l) => l.autofinancement_eur, (c) => c.solde * 1000).pire)
      .toBeLessThanOrEqual(ARRONDI);
  });

  it('tombe exactement sur l annee 1 de LEON', () => {
    const l = compte.lignes[0];
    expect(l.total_produits_eur).toBe(30036);
    expect(l.total_charges_eur).toBe(39072);
    expect(l.autofinancement_eur).toBe(-9036);
  });
});
