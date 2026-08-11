// @ts-check
/**
 * CAZERES 2868 - FOYER PLS, fixture de CONTROLE d'AGDE.
 *
 * Meme profil de gestion, meme annexe, meme montage : 16 lots, VEFA, PLS en
 * double revisabilite, redevance forfaitaire. Mais des montants differents, une
 * mise en location differente (31/03/2027 contre 01/12/2026) et surtout un plan
 * de financement oppose : ici AUCUNE subvention et 98 % de prets, contre 89 %
 * de prets et 193 kEUR de subventions a AGDE.
 *
 * Une fixture seule ne dit pas si un accord vient de la regle ou du hasard des
 * chiffres. Ce fichier ne re-teste donc pas la mecanique - `golden_agde_foyer`
 * s'en charge - mais ce que les deux operations doivent avoir EN COMMUN si les
 * regles identifiees sur AGDE en sont bien :
 *
 * - la valeur comptable du terrain a 25 % de l'acquisition VEFA TTC (Q-26) ;
 * - les frais de gestion a 0,3 % du prix de revient TTC (Q-17) ;
 * - la taxe fonciere a mise en location + 25 ans (E-10) ;
 * - l'annuite de reconstitution des fonds propres, 30 ans au taux de
 *   remuneration ;
 * - les trajectoires d'indexation de la redevance et des charges, qui doivent
 *   etre CALENDAIRES et donc les memes annees civiles sur les deux operations ;
 * - la 51e echeance fantome de LEON sur le pret de 50 ans (E-13).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tableauAmortissement } from '../src/amortissement.js';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} dossier @param {string} fichier */
function fixture(dossier, fichier) {
  return JSON.parse(readFileSync(join(RACINE, 'fixtures', dossier, fichier), 'utf8'));
}

describe('golden - CAZERES 2868 FOYER PLS (controle d AGDE)', () => {
  const entrees = fixture('cazeres_2868_foyer_pls', 'entrees.json');
  const attendus = fixture('cazeres_2868_foyer_pls', 'attendus.json');
  const agde = fixture('agde_2402_foyer_pls', 'attendus.json');
  const agdeEntrees = fixture('agde_2402_foyer_pls', 'entrees.json');

  const RED = attendus.redevance_forfaitaire_par_annee;
  const SERIE = attendus.resultat_et_autofinancement_par_annee;
  const AGDE_RED = agde.redevance_forfaitaire_par_annee;
  const PREMIERE = entrees.dates.annee_premiere_echeance;

  const tables = entrees.prets.map((p) =>
    tableauAmortissement({
      montant_eur: p.montant_eur,
      taux: p.taux,
      progressivite: p.progressivite,
      duree_ans: p.duree_ans,
      annee_premiere_echeance: PREMIERE,
      revisabilite: p.revisabilite,
      livret_a_origine: entrees.livret_a_origine,
      livret_a_par_annee: entrees.livret_a_par_annee,
    }),
  );

  it('le bilan se reconstitue depuis ses quatre postes', () => {
    const B = entrees.bilan;
    const ht = B.prix_vefa_ht_eur + B.frais_notaire_eur + B.rmo_eur + B.frais_financiers_eur;
    const ttc = B.prix_vefa_ttc_eur + B.frais_notaire_eur + B.rmo_eur + B.frais_financiers_eur;
    expect(Math.abs(ht - attendus.bilan.total_ht_eur)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(ttc - attendus.bilan.total_ttc_eur)).toBeLessThanOrEqual(0.01);
  });

  it('le plan de financement s equilibre sans aucune subvention', () => {
    const F = attendus.plan_financement;
    const ressources =
      F.total_prets_eur + F.total_subventions_eur + F.avance_tresorerie_remuneree_eur;
    expect(Math.abs(ressources - attendus.bilan.total_ttc_eur)).toBeLessThanOrEqual(0.01);
    expect(F.total_subventions_eur).toBe(0);
    // 98 % de prets : le cas oppose a AGDE, ou ils ne font que 89 %.
    expect(F.pct_prets).toBeGreaterThan(0.97);
    expect(agde.plan_financement.pct_prets).toBeLessThan(0.9);
  });

  it('reproduit les 50 annees d annuites agregees', () => {
    let comparees = 0;
    let pire = 0;
    for (const a of RED) {
      if (!a.annuites_keur) continue;
      // 2078 est la 51e echeance de LEON : hors contrat, traitee plus bas.
      if (a.annee > PREMIERE + 49) continue;
      const somme =
        tables.reduce((s, t) => s + (t.find((l) => l.annee === a.annee)?.annuite_eur ?? 0), 0) /
        1000;
      pire = Math.max(pire, Math.abs(somme - a.annuites_keur) / a.annuites_keur);
      comparees++;
    }
    expect(comparees).toBe(50);
    expect(pire).toBeLessThanOrEqual(1e-12);
  });

  it('confirme E-13 sur une seconde operation, au centime', () => {
    // Le montant de la 51e echeance n'est pas seulement « en trop » : il vaut
    // EXACTEMENT l'exces de capital amorti sur les 60 annees. Le lien est donc
    // etabli, et non plus seulement constate.
    const derniere = RED.filter((a) => a.annuites_keur > 0).at(-1);
    expect(derniere.annee).toBe(PREMIERE + 50);

    const totalAnnuites = RED.reduce((s, a) => s + a.annuites_keur * 1000, 0);
    const totalInterets = SERIE.reduce((s, l) => s + (l.interets_emprunts_eur ?? 0), 0);
    const exces = totalAnnuites - totalInterets - attendus.plan_financement.total_prets_eur;
    expect(exces).toBeCloseTo(derniere.annuites_keur * 1000, 1);
    expect(exces).toBeCloseTo(attendus._anomalie_51e_echeance.montant_eur, 1);

    // Le moteur, lui, s'arrete a la 50e et solde exactement.
    for (const [i, t] of tables.entries()) {
      expect(t.at(-1)?.annee).toBe(PREMIERE + entrees.prets[i].duree_ans - 1);
      expect(t.at(-1)?.crd_eur).toBeCloseTo(0, 4);
    }
  });

  it('la valeur comptable du terrain vaut 25 % de l acquisition VEFA TTC (Q-26)', () => {
    const q = entrees.hypotheses_exploitation.terrain_sur_montant_acquisition_vefa_ttc;
    expect(q * entrees.bilan.prix_vefa_ttc_eur).toBeCloseTo(
      attendus.indicateurs.valeur_comptable_terrain_eur,
      6,
    );
    // Et la meme quotite sur AGDE : deux operations en zone B1, 25 % toutes les
    // deux, la ou la table par zone donne 13 %.
    expect(agdeEntrees.hypotheses_exploitation.terrain_sur_montant_acquisition_vefa_ttc).toBe(q);
    expect(entrees.identite.zone_ABC).toBe(agdeEntrees.identite.zone_ABC);
  });

  it('les frais de gestion valent 0,3 % du prix de revient TTC (Q-17)', () => {
    const taux = entrees.hypotheses_exploitation.frais_gestion_pct_prix_revient;
    expect((taux * attendus.bilan.total_ttc_eur) / 16).toBeCloseTo(
      entrees.hypotheses_exploitation.frais_gestion_par_lot_eur,
      6,
    );
    // 440,08 EUR par lot ici contre 415,49 a AGDE : c'est bien l'assiette qui
    // est constante, pas le montant. Un forfait par lot ne pourrait pas donner
    // deux valeurs differentes sur le meme profil.
    expect(entrees.hypotheses_exploitation.frais_gestion_par_lot_eur).not.toBeCloseTo(
      agdeEntrees.hypotheses_exploitation.frais_gestion_par_lot_eur,
      2,
    );
  });

  it('la taxe fonciere entre en 2052, soit mise en location + 25 ans (E-10)', () => {
    const mel = 2027;
    const entree = mel + entrees.hypotheses_exploitation.duree_exoneration_tfpb_ans;
    expect(entree).toBe(2052);
    const av = RED.find((a) => a.annee === entree - 1);
    const ap = RED.find((a) => a.annee === entree);
    expect(ap.tfpb_teom_keur / av.tfpb_teom_keur).toBeGreaterThan(3.9);
    // Aucune rupture avant : seule la TEOM court.
    for (const a of RED.filter((x) => x.annee > 2028 && x.annee < entree)) {
      const p = RED.find((x) => x.annee === a.annee - 1);
      expect(a.tfpb_teom_keur / p.tfpb_teom_keur, `${a.annee}`).toBeLessThan(1.05);
    }
  });

  it('reproduit l annuite de reconstitution des fonds propres', () => {
    const {
      avance_tresorerie_remuneree_eur: capital,
      taux_remuneration: taux,
      duree_reconstitution_ans: duree,
    } = entrees.fonds_propres;
    const annuite = (capital * taux) / (1 - (1 + taux) ** -duree);
    expect(annuite / 1000).toBeCloseTo(RED[0].annuites_fp_keur, 6);
    const servies = RED.filter((a) => a.annuites_fp_keur > 0);
    expect(servies).toHaveLength(duree);
  });

  it('les trajectoires d indexation sont CALENDAIRES, donc communes aux deux operations', () => {
    // C'est le vrai apport du controle. Les deux operations n'ont pas la meme
    // annee de mise en location : si les trajectoires etaient relatives a
    // l'operation (« +1,7 % les deux premieres indexations »), elles
    // tomberaient sur des annees civiles differentes. Elles tombent sur les
    // memes, donc elles viennent du PROFIL et non de l'operation.
    const taux = (serie, cle, annee) => {
      const a = serie.find((x) => x.annee === annee);
      const p = serie.find((x) => x.annee === annee - 1);
      return a[cle] / p[cle] - 1;
    };
    // Redevance : +1,7 % en 2029 sur les deux, +1,8 % en 2030 sur les deux.
    expect(taux(RED, 'redevance_eur', 2029)).toBeCloseTo(0.017, 10);
    expect(taux(AGDE_RED, 'redevance_eur', 2029)).toBeCloseTo(0.017, 10);
    expect(taux(RED, 'redevance_eur', 2030)).toBeCloseTo(0.018, 10);
    expect(taux(AGDE_RED, 'redevance_eur', 2030)).toBeCloseTo(0.018, 10);
    // Charges : +1,8 % en 2029 sur les deux.
    expect(taux(RED, 'frais_gestion_keur', 2029)).toBeCloseTo(0.018, 10);
    expect(taux(AGDE_RED, 'frais_gestion_keur', 2029)).toBeCloseTo(0.018, 10);
    // Et les deux trajectoires restent DISTINCTES l'une de l'autre en 2028,
    // ou AGDE porte +1,7 % sur la redevance contre +2,0 % sur les charges.
    expect(taux(AGDE_RED, 'redevance_eur', 2028)).toBeCloseTo(0.017, 10);
    expect(taux(AGDE_RED, 'frais_gestion_keur', 2028)).toBeCloseTo(0.02, 10);
  });

  it('LEON decale la premiere echeance quand la mise en location n est pas au 1er janvier (Q-28)', () => {
    // Mise en location au 31/03/2027, premiere echeance en 2028 ; AGDE, mise en
    // location au 01/12/2026, premiere echeance en 2027. Deux operations de
    // plus qui amortissent a partir de la premiere annee civile COMPLETE, et
    // non l'annee de mise en location. Le moteur, lui, applique desormais
    // MEL + 0 par arbitrage metier : l'ecart est reel et documente en Q-28.
    expect(PREMIERE).toBe(2028);
    expect(RED.find((a) => a.annee === 2027).annuites_keur).toBe(0);
    expect(agdeEntrees.dates.annee_premiere_echeance).toBe(2027);
    expect(AGDE_RED.find((a) => a.annee === 2026).annuites_keur).toBe(0);
  });
});
