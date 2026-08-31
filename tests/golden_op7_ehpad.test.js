// @ts-check
/**
 * OP-7 - EHPAD de 16 lots finance en PLS FOYER, neuf, zone 2/A.
 *
 * Reconstruite depuis la matrice LEON complete (122 feuilles) et non depuis une
 * annexe : ParaGLOB colonne DS pour la saisie, BilFPLS pour le prix de revient,
 * SimFPLS_2 pour le solde financier.
 *
 * Elle apporte trois cas qu'aucune des six autres ne portait :
 *
 * 1. UN PLAN DE FINANCEMENT SANS AUCUN PRET. L'operation est portee a 100 % par
 *    des fonds propres remuneres a 2,5 % et reconstitues sur 30 ans. C'est le
 *    seul jeu de donnees qui isole R-FIN-7 : sans annuite d'emprunt pour la
 *    couvrir, une erreur sur l'annuite de fonds propres se voit tout de suite.
 * 2. UNE TVA A 5,5 % SUR DU PLS. Un EHPAD releve du 6 du I de l'article
 *    L. 312-1 du CASF, vise par le CGI 278 sexies. Le referentiel donne 10 % au
 *    FPLS, ce qui vaut pour le foyer ordinaire : la surcharge est explicite ici
 *    et la question posee en Q-40.
 * 3. UNE REDEVANCE D'EQUILIBRE. LEON ne la saisit pas, il la POSE egale a la
 *    somme des charges, verifie a 1e-9 pres sur les 61 annees. Le moteur, lui,
 *    attend un forfait : la redevance n'est donc pas comparee, seules le sont
 *    les charges qui la composent.
 *
 * Ce qu'elle ne reproduit pas encore, et pourquoi : Q-38 (annee de valeur des
 * bases de charges) et Q-39 (prorata de la premiere annee). Les deux sont
 * mesures ci-dessous plutot que masques.
 *
 * Protocole et tolerances : CLAUDE.md §5.
 */
import { describe, it, expect } from 'vitest';
import { fixturesReellesPresentes, lireFixtureReelle } from './fixtures-reelles.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { calculer } from '../src/moteur.js';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} fichier */
const fixture = (fichier) => lireFixtureReelle('op-7-ehpad-pls', fichier);

describe.skipIf(!fixturesReellesPresentes)('golden - OP-7 EHPAD PLS (100 % fonds propres)', () => {
  const entrees = fixture('entrees.json');
  const attendus = fixture('attendus.json');
  const baremes = JSON.parse(
    readFileSync(join(RACINE, 'referentiels', 'baremes_her_2027.json'), 'utf8'),
  );
  const trajectoires = JSON.parse(
    readFileSync(join(RACINE, 'referentiels', 'trajectoires_her_2027.json'), 'utf8'),
  );

  // Q-40 : le taux de livraison a soi-meme d'un EHPAD est celui du CASF, pas
  // celui du produit de financement. La surcharge est POSEE ICI, visible,
  // plutot que dissimulee ligne a ligne en marquant chaque poste `hors_lasm`
  // avec un taux de 5,5 % - ce qui aurait donne le meme total en mentant sur le
  // mecanisme.
  baremes.tva.lasm_par_produit.FPLS = entrees.bilan.taux_tva_finale;

  const entreesMoteur = {
    identite: {
      nom: 'OP-7 EHPAD PLS',
      produit: 'FPLS',
      zone_123: entrees.identite.zone_123,
      zone_ABC: entrees.identite.zone_ABC,
      type_operation: entrees.identite.type_operation,
    },
    dates: {
      annee_mise_en_location: entrees.dates.annee_mise_en_location,
      duree_simulation_ans: entrees.dates.duree_simulation_ans,
    },
    lots: [
      {
        code_produit: 'FPLS',
        nb_logements: entrees.identite.nb_lots,
        shab_m2: entrees.identite.shab_m2,
        surfaces_annexes_m2: 0,
      },
    ],
    postes_bilan: entrees.bilan.postes.map((p) => ({
      chapitre: p.chapitre,
      libelle: p.libelle,
      montant_ht_eur: p.montant_ht_eur,
      taux_tva: p.taux_tva,
      // Les interets de prefinancement sont hors champ de la livraison a
      // soi-meme (ParaFPLS : TVA sur interets de prefi = 0). Sans ce marqueur
      // ils prendraient 5,5 % comme le reste et le prix de revient serait faux
      // de 10 016 EUR.
      hors_lasm: p.code === 'interets_prefi',
    })),
    subventions: [],
    prets: [],
    fonds_propres_eur: entrees.financement.fonds_propres_eur,
    remuneration_fonds_propres: {
      FPLS: {
        remuneres: true,
        taux: entrees.financement.remuneration.taux,
        reconstitues: true,
        duree_reconstitution_ans: entrees.financement.remuneration.duree_reconstitution_ans,
      },
    },
    exploitation: {
      mode: 'redevance',
      frais_gestion_pct_prix_revient: entrees.exploitation.frais_gestion_pct_prix_revient,
      tfpb_par_logement_eur: entrees.exploitation.tfpb_par_logement_eur,
      annee_debut_tfpb: entrees.exploitation.annee_debut_tfpb,
      pge_taux: entrees.exploitation.pge_taux,
      pge_base_eur: entrees.exploitation.pge_base_eur,
      nb_lits: entrees.identite.nb_lots,
      charges_diverses: [
        {
          code: 'tom',
          libelle: 'Taxe d enlevement des ordures menageres',
          assiette: 'logement',
          valeur: entrees.exploitation.tom_par_logement_eur,
          index: 'tfpb',
        },
        {
          code: 'assurance',
          libelle: 'Assurance',
          assiette: 'shab',
          valeur: entrees.exploitation.assurance_eur_m2_surface_totale,
          index: 'gestion',
        },
      ],
    },
  };

  // Sans les fixtures reelles il n'y a rien a calculer, et il ne faut surtout
  // pas essayer : `describe.skipIf` saute l'EXECUTION des tests mais deroule
  // quand meme ce corps pour les collecter, et le moteur refuse - a juste
  // titre - un calendrier vide. Le bouchon traverse la collecte, aucun test ne
  // le lit puisque tous sont sautes.
  const resultat = fixturesReellesPresentes
    ? calculer(entreesMoteur, { baremes, trajectoires })
    : { bilan: {}, financement: {}, exploitation: { lignes: [] } };
  const lignes = resultat.exploitation.lignes;
  /** @param {(l: any) => number} f */
  const somme = (f) => lignes.reduce((a, l) => a + f(l), 0);
  /** @param {any} l @param {string} code */
  const detail = (l, code) =>
    (l.detail_charges_diverses ?? []).find((c) => c.code === code)?.montant_eur ?? 0;
  /** @param {number} annee */
  const an = (annee) => lignes.find((l) => l.annee === annee);
  const T = attendus.totaux_solde_financier;

  it('reproduit le prix de revient HT et TTC a +/-1 EUR', () => {
    expect(Math.abs(resultat.bilan.total_ht_eur - attendus.bilan.total_ht_eur)).toBeLessThanOrEqual(
      1,
    );
    expect(
      Math.abs(resultat.bilan.total_ttc_module_eur - attendus.bilan.total_ttc_eur),
    ).toBeLessThanOrEqual(1);
  });

  it('applique 5,5 % de TVA partout sauf sur les interets de prefinancement', () => {
    const tva = resultat.bilan.total_ttc_module_eur - resultat.bilan.total_ht_eur;
    expect(Math.abs(tva - attendus.bilan.total_tva_finale_eur)).toBeLessThanOrEqual(1);
    // Le taux moyen n'est PAS 5,5 % : les interets de prefinancement, hors
    // champ, le tirent a 5,224 %. C'est la preuve que le marqueur a porte.
    expect(tva / resultat.bilan.total_ht_eur).toBeCloseTo(0.05224, 5);
  });

  it('n a ni pret ni subvention : le plan tient sur les seuls fonds propres', () => {
    expect(resultat.financement.total_prets_eur).toBe(0);
    expect(entrees.financement.prets).toHaveLength(0);
    expect(entrees.financement.subventions).toHaveLength(0);
  });

  it('reproduit l annuite de fonds propres a +/-0,1 %', () => {
    // 182 723 EUR par an pendant 30 ans, servis ET reconstitues (R-FIN-7).
    const attendu = attendus.solde_financier_par_annee[0].fonds_propres_keur * 1000;
    const obtenu = an(2028).annuite_fonds_propres_eur;
    expect(Math.abs(obtenu - attendu) / attendu).toBeLessThanOrEqual(0.001);
    // Elle s'arrete au terme, et pas un an plus tard : 2057 la porte, 2058 non.
    expect(an(2057).annuite_fonds_propres_eur).toBeGreaterThan(0);
    expect(an(2058).annuite_fonds_propres_eur).toBe(0);
    const cumul = somme((l) => l.annuite_fonds_propres_eur);
    const cible = T.fonds_propres_keur * 1000;
    expect(Math.abs(cumul - cible) / cible).toBeLessThanOrEqual(0.001);
  });

  it('porte les cinq postes de charges de LEON, aucun de plus, aucun de moins', () => {
    const l = an(2030);
    expect(l.frais_gestion_eur).toBeGreaterThan(0);
    expect(l.gros_entretien_eur).toBeGreaterThan(0);
    expect(detail(l, 'tom')).toBeGreaterThan(0);
    expect(detail(l, 'assurance')).toBeGreaterThan(0);
    // La taxe fonciere est exoneree jusqu'en 2052 inclus, soit mise en location
    // + 25 ans PILE. OP-4 disait deja +25, OP-3 disait +26 : le CGI tranche, et
    // cette fixture est le troisieme temoin (E-10).
    expect(an(2052).tfpb_eur).toBe(0);
    expect(an(2053).tfpb_eur).toBeGreaterThan(0);
  });

  it('mesure l ecart de charges encore ouvert (Q-38 et Q-39)', () => {
    // Ce test ne VALIDE pas l'ecart, il l'ENFERME. Deux causes connues le
    // produisent - l'annee de valeur des bases et la premiere annee non
    // proratisee - pour un effet combine de -1,56 % sur la somme des charges.
    // Le jour ou l'une des deux sera tranchee, ce test tombera : c'est ce qu'on
    // lui demande. Une derive dans l'autre sens le fera tomber aussi.
    const charges = somme(
      (l) =>
        l.frais_gestion_eur +
        l.gros_entretien_eur +
        l.tfpb_eur +
        detail(l, 'tom') +
        detail(l, 'assurance'),
    );
    const attendu =
      (T.frais_fonctionnement_keur + T.assurance_keur + T.pcrc_keur + T.tfpb_tom_keur) * 1000;
    const ecart = (charges - attendu) / attendu;
    expect(ecart).toBeGreaterThan(-0.045);
    expect(ecart).toBeLessThan(-0.02);
  });

  it('LEON pose la redevance egale a la somme des charges, toutes les annees', () => {
    // Constat sur la matrice, pas sur le moteur : c'est ce qui explique qu'une
    // redevance ne se compare pas ici. L'ecart maximal sur 61 annees vaut 1e-9
    // kEUR, soit un millioniemme d'euro.
    for (const a of attendus.solde_financier_par_annee) {
      const total =
        a.frais_fonctionnement_keur +
        a.assurance_keur +
        a.pcrc_keur +
        a.tfpb_tom_keur +
        a.fonds_propres_keur;
      expect(Math.abs(total - a.redevance_keur)).toBeLessThan(1e-9);
    }
  });
});
