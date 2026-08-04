// @ts-check
/**
 * Orchestration bout-en-bout : `calculer(entrees, referentiels)`.
 *
 * Verifie l'enchainement complet surfaces -> loyers -> bilan -> subventions ->
 * financement -> amortissement -> exploitation -> indicateurs, et surtout la
 * PURETE du moteur (meme entree, meme sortie ; aucune mutation des entrees).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { calculer, VERSION_MOTEUR } from '../src/moteur.js';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const baremes = JSON.parse(readFileSync(join(RACINE, 'referentiels', 'baremes_2025.json'), 'utf8'));

/** Operation de reference : 6 logements PLS en VEFA, calquee sur BERGERAC. */
const ENTREES = {
  identite: { nom: 'Operation de test', produit: 'PLS', zone_123: 2, zone_ABC: 'B1', type_operation: 'Vefa' },
  dates: { annee_mise_en_location: 2028, duree_simulation_ans: 40 },
  lots: [{ code_produit: 'PLS', nb_logements: 6, shab_m2: 400, surfaces_annexes_m2: 40 }],
  postes_bilan: [
    { chapitre: 'charge_fonciere', libelle: 'Acquisition VEFA', montant_ht_eur: 600000, taux_tva: 0.055 },
    { chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 30000, taux_tva: 0.1 },
  ],
  subventions: [{ libelle: 'Ville', montant_eur: 20000, gratuite: true }],
  fonds_propres_eur: 50000,
  prets: [
    {
      code: 'PLS_CONSTRUCTION',
      nature: 'construction',
      montant_eur: 494023,
      taux: 0.0351,
      progressivite: 0,
      duree_ans: 40,
      annee_premiere_echeance: 2028,
      revisabilite: 'SIMPLE',
      livret_a_origine: 0.024,
      livret_a_par_annee: { 2028: 0.02 },
    },
  ],
  exploitation: {
    frais_gestion_pct_loyers: 0.07,
    taux_vacance_impayes: 0.02,
    gros_entretien_eur_m2: 5,
    trajectoires: { loyers_irl: 0.02, gros_entretien: 0.023 },
  },
  options: {},
};

const REFERENTIELS = { baremes, trajectoires: {} };

describe('moteur — orchestration bout-en-bout', () => {
  const r = calculer(ENTREES, REFERENTIELS);

  it('renvoie un resultat structure et versionne', () => {
    expect(r.version_moteur).toBe(VERSION_MOTEUR);
    for (const cle of [
      'surfaces', 'loyers', 'bilan', 'subventions', 'financement',
      'amortissements', 'fiscalite', 'exploitation', 'indicateurs', 'alertes',
    ]) {
      expect(r, `bloc ${cle} attendu`).toHaveProperty(cle);
    }
  });

  it('chaine les surfaces jusqu au loyer', () => {
    // SU = 400 + 0,5 x 40 = 420
    expect(r.surfaces.par_produit.PLS).toBe(420);
    expect(r.surfaces.quotes_parts.PLS).toBe(1);
    // PLS zone B1 = 10,07 EUR/m2, CS = 0,77 x (1 + 20 x 6 / 420)
    expect(r.loyers[0].cs).toBeCloseTo(0.77 * (1 + (20 * 6) / 420), 4);
    expect(r.loyers[0].loyer_annuel_eur).toBeGreaterThan(0);
  });

  it('calcule le prix de revient au taux de livraison a soi-meme', () => {
    expect(r.bilan.taux_lasm).toBe(0.1);
    expect(r.bilan.total_ht_eur).toBe(630000);
    expect(r.bilan.total_ttc_lasm_eur).toBe(693000);
  });

  it('produit un tableau d amortissement par pret mobilise', () => {
    expect(r.amortissements).toHaveLength(1);
    expect(r.amortissements[0].tableau).toHaveLength(40);
    // Revisabilite SIMPLE : le taux suit le LA (3,51 % + 2 % - 2,4 % = 3,11 %)
    expect(r.amortissements[0].tableau[0].taux).toBeCloseTo(0.0311, 10);
    expect(r.amortissements[0].tableau.at(-1)?.crd_eur).toBeCloseTo(0, 4);
  });

  it('deroule le compte d exploitation sur l horizon demande', () => {
    expect(r.exploitation.lignes).toHaveLength(40);
    expect(r.exploitation.lignes[0].annee).toBe(2028);
    // Les annuites du pret alimentent bien les charges.
    expect(r.exploitation.lignes[0].annuites_eur).toBeGreaterThan(0);
  });

  it('signale le desequilibre du plan de financement plutot que de l absorber', () => {
    expect(r.financement.equilibre).toHaveProperty('ecart_eur');
    expect(typeof r.financement.equilibre.equilibre).toBe('boolean');
    if (!r.financement.equilibre.equilibre) {
      expect(r.alertes.some((a) => /financement/i.test(a))).toBe(true);
    }
  });

  it('expose des indicateurs de synthese exploitables par une UI', () => {
    expect(r.indicateurs.nb_logements).toBe(6);
    expect(r.indicateurs.su_m2).toBe(420);
    expect(r.indicateurs.prix_revient_par_logement_eur).toBe(Math.round(693000 / 6));
    expect(r.indicateurs.rmo).toBeGreaterThan(0);
    expect(r.indicateurs.annee_debut_tfpb).toBe(2053); // 2028 + 25
  });

  it('est PUR : deux appels identiques donnent des resultats identiques', () => {
    const a = calculer(ENTREES, REFERENTIELS);
    const b = calculer(ENTREES, REFERENTIELS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('ne mute pas les entrees', () => {
    const avant = JSON.stringify(ENTREES);
    calculer(ENTREES, REFERENTIELS);
    expect(JSON.stringify(ENTREES)).toBe(avant);
  });

  it('exige une annee de mise en location explicite (aucune date systeme implicite)', () => {
    expect(() => calculer({ ...ENTREES, dates: {} }, REFERENTIELS)).toThrow(/mise_en_location/);
  });
});
