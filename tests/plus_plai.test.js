// @ts-check
/**
 * PLUS et PLAI - le perimetre V1 declare, et le seul produit qu'AUCUNE fixture
 * ne couvre encore.
 *
 * Ces tests ne sont PAS des golden tests : ils ne comparent rien a LEON, faute
 * d'annexe PLUS/PLAI exportee. Ils verifient que la chaine complete traverse ce
 * produit sans rien laisser d'indefini, et que les regles qui lui sont propres
 * (coefficient de structure, bareme par zone 1/2/3, prets CDC par defaut,
 * majoration PLUS 33 %) produisent des valeurs coherentes et stables.
 *
 * Leur role est de faire echouer le jour ou une regression casse PLUS/PLAI,
 * plutot que de le decouvrir en branchant l'annexe. Quand elle arrivera, ces
 * tests restent valables et un golden test viendra s'ajouter a cote.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { calculer } from '../src/moteur.js';
import { coefficientStructure, loyerMaxZone } from '../src/loyers.js';
import { pretsDefautResolus } from '../src/produits.js';
import { tauxLASM } from '../src/bilan.js';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const baremes = JSON.parse(readFileSync(join(RACINE, 'referentiels', 'baremes_her_2027.json'), 'utf8'));
const trajectoires = JSON.parse(
  readFileSync(join(RACINE, 'referentiels', 'trajectoires_axentia_2026.json'), 'utf8'),
);
const REFERENTIELS = { baremes, trajectoires };

/** Grille tarifaire des prets CDC : les marges ne sont plus dans le code. */
const MARGES = baremes.prets_cdc.marges;

/** Operation type : 30 logements PLUS et 10 PLAI, VEFA zone 2 / B1. */
function operation(surcharges = {}) {
  return {
    identite: { nom: 'Test PLUS-PLAI', zone_123: 2, zone_ABC: 'B1', type_operation: 'VEFA' },
    dates: { annee_mise_en_location: 2028, duree_simulation_ans: 40 },
    lots: [
      { code_produit: 'PLUS', nb_logements: 30, shab_m2: 1800, surfaces_annexes_m2: 200 },
      { code_produit: 'PLAI', nb_logements: 10, shab_m2: 600, surfaces_annexes_m2: 60 },
    ],
    postes_bilan: [
      { chapitre: 'charge_fonciere', libelle: 'Acquisition VEFA', montant_ht_eur: 4200000, taux_tva: 0.055 },
      { chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 1800000, taux_tva: 0.1 },
      { chapitre: 'honoraires', libelle: 'Honoraires', montant_ht_eur: 260000, taux_tva: 0.2 },
    ],
    subventions: [
      { libelle: 'État', montant_eur: 180000, gratuite: true, affectation: 'PLAI' },
      { libelle: 'Agglomération', montant_eur: 90000, gratuite: true },
    ],
    fonds_propres_eur: 400000,
    prets: [],
    exploitation: { frais_gestion_pct_loyers: 0.07, taux_vacance_impayes: 0.02, gros_entretien_eur_m2: 5 },
    // R-LOYER-9 neutralise : ces tests portent sur la LECTURE du bareme, pas sur
    // le rattrapage de son millesime. Revalorise, le plafond ne serait plus
    // comparable a la valeur lue directement au referentiel.
    options: { revaloriser_loyers_plafonds: false },
    ...surcharges,
  };
}

describe('PLUS / PLAI - la chaine complete traverse le perimetre V1', () => {
  const r = calculer(operation(), REFERENTIELS);

  it('produit un resultat complet, sans valeur indefinie dans les indicateurs', () => {
    for (const [cle, v] of Object.entries(r.indicateurs)) {
      expect(v, `indicateurs.${cle}`).not.toBeUndefined();
      if (typeof v === 'number') expect(Number.isFinite(v), `indicateurs.${cle}`).toBe(true);
    }
  });

  it('agrege les deux tranches et les restitue dans l ordre reglementaire', () => {
    expect(r.surfaces.tranches).toEqual(['PLAI', 'PLUS']);
    expect(r.indicateurs.nb_logements).toBe(40);
    // SU = SHAB + 0,5 x annexes, par tranche
    expect(r.surfaces.par_produit.PLUS).toBe(1900);
    expect(r.surfaces.par_produit.PLAI).toBe(630);
  });

  it('applique le coefficient de structure a chaque tranche', () => {
    const plus = r.loyers.find((l) => l.code_produit === 'PLUS');
    const plai = r.loyers.find((l) => l.code_produit === 'PLAI');
    expect(plus.cs).toBe(coefficientStructure({ nb_logements: 30, su_m2: 1900 }, baremes));
    expect(plai.cs).toBe(coefficientStructure({ nb_logements: 10, su_m2: 630 }, baremes));
    // Le PLAI, plus petit et plus dense en logements, porte un CS superieur.
    expect(plai.cs).toBeGreaterThan(plus.cs);
  });

  it('lit le bareme de loyer sur le zonage 1/2/3, propre a PLUS et PLAI', () => {
    const plus = r.loyers.find((l) => l.code_produit === 'PLUS');
    const plai = r.loyers.find((l) => l.code_produit === 'PLAI');
    expect(plus.loyer_base_eur_m2).toBe(loyerMaxZone('PLUS', { zone_123: 2 }, baremes));
    expect(plai.loyer_base_eur_m2).toBe(loyerMaxZone('PLAI', { zone_123: 2 }, baremes));
    // Le PLAI est plus social, donc son plafond de loyer est inferieur.
    expect(plai.loyer_base_eur_m2).toBeLessThan(plus.loyer_base_eur_m2);
  });

  it('ventile le prix de revient au prorata SU et applique le meme taux de LASM', () => {
    const v = r.bilan.ventilation;
    expect(v.cle_ventilation).toBe('surface_utile');
    expect(v.parts.PLUS).toBeCloseTo(1900 / 2530, 12);
    expect(v.parts.PLAI).toBeCloseTo(630 / 2530, 12);
    // PLUS et PLAI partagent le taux reduit de la simulation (R-TVA-2).
    expect(v.par_tranche.PLUS.taux_lasm).toBe(tauxLASM('PLUS', baremes));
    expect(v.par_tranche.PLAI.taux_lasm).toBe(tauxLASM('PLAI', baremes));
    const somme = Object.values(v.par_tranche).reduce((s, t) => s + t.total_ttc_lasm_eur, 0);
    expect(somme).toBe(v.total_ttc_lasm_eur);
  });

  it('mobilise les prets CDC theoriques quand aucun pret n est saisi', () => {
    expect(r.amortissements.length).toBeGreaterThan(0);
    for (const a of r.amortissements) {
      expect(a.tableau.length).toBeGreaterThan(0);
      expect(a.tableau.at(-1)?.crd_eur).toBeCloseTo(0, 4);
      // R-AMT-3 : premiere echeance l'annee suivant la mise en location.
      expect(a.tableau[0].annee).toBe(2029);
    }
  });

  it('resout les caracteristiques de pret par defaut du dictionnaire (R-AMT-1)', () => {
    const la = 0.017;
    const plus = pretsDefautResolus('PLUS', { zone_ABC: 'B1', livret_a_reference: la, marges: MARGES });
    const plai = pretsDefautResolus('PLAI', { zone_ABC: 'B1', livret_a_reference: la, marges: MARGES });
    // PLUS : LA + 0,60 point ; PLAI : LA - 0,20 point.
    expect(plus.find((p) => p.nature === 'construction').taux).toBeCloseTo(la + 0.006, 10);
    expect(plai.find((p) => p.nature === 'construction').taux).toBeCloseTo(la - 0.002, 10);
    // Construction 40 ans, foncier 60 ans hors zones B2 et C.
    expect(plus.find((p) => p.nature === 'construction').duree_ans).toBe(40);
    expect(plus.find((p) => p.nature === 'foncier').duree_ans).toBe(60);
    expect(pretsDefautResolus('PLUS', { zone_ABC: 'C', livret_a_reference: la, marges: MARGES })
      .find((p) => p.nature === 'foncier').duree_ans).toBe(50);
  });

  it('ventile les subventions selon leur affectation', () => {
    // La subvention Etat est affectee au PLAI, celle de l agglomeration est
    // repartie au prorata des surfaces utiles.
    expect(r.subventions.par_produit.PLAI).toBeGreaterThan(180000);
    expect(r.subventions.gratuites_eur).toBe(270000);
    expect(r.indicateurs.subventions_eur).toBe(270000);
  });

  it('deroule le compte d exploitation sur l horizon demande', () => {
    expect(r.exploitation.lignes).toHaveLength(40);
    expect(r.exploitation.lignes[0].annee).toBe(2028);
    expect(r.exploitation.indicateurs.resultat_cumule_final_eur).toBeTypeOf('number');
  });

  it('applique l exoneration de taxe fonciere de 25 ans', () => {
    expect(r.indicateurs.annee_debut_tfpb).toBe(2053);
    const avant = r.exploitation.lignes.filter((l) => l.annee < 2053);
    expect(avant.every((l) => l.tfpb_eur === 0)).toBe(true);
  });

  it('reste PUR : deux appels identiques donnent le meme resultat', () => {
    expect(JSON.stringify(calculer(operation(), REFERENTIELS))).toBe(
      JSON.stringify(calculer(operation(), REFERENTIELS)),
    );
  });
});

describe('PLUS 33 % - majoration multiplicative (arbitrage I-6)', () => {
  it('applique x1,33 au loyer de base, et non +0,33', () => {
    const r = calculer(
      operation({
        identite: { nom: 'Test PLUS33', zone_123: 2, zone_ABC: 'B1', type_operation: 'VEFA' },
        lots: [{ code_produit: 'PLUS33', nb_logements: 30, shab_m2: 1800, surfaces_annexes_m2: 200 }],
        options: { revaloriser_loyers_plafonds: false },
      }),
      REFERENTIELS,
    );
    const base = loyerMaxZone('PLUS', { zone_123: 2 }, baremes);
    expect(r.loyers[0].loyer_base_eur_m2).toBeCloseTo(base * 1.33, 2);
    expect(r.loyers[0].loyer_base_eur_m2).not.toBeCloseTo(base + 0.33, 2);
  });
});

describe('PLUS / PLAI - robustesse de la saisie', () => {
  it('une operation mono-PLAI ne casse rien', () => {
    const r = calculer(
      operation({
        identite: { nom: 'PLAI seul', zone_123: 1, zone_ABC: 'A', type_operation: 'Neuf' },
        lots: [{ code_produit: 'PLAI', nb_logements: 12, shab_m2: 700, surfaces_annexes_m2: 0 }],
      }),
      REFERENTIELS,
    );
    expect(r.surfaces.tranches).toEqual(['PLAI']);
    expect(r.loyers[0].loyer_annuel_eur).toBeGreaterThan(0);
  });

  it('equilibre par construction en mode prets CDC theoriques', () => {
    // Sans pret saisi, les prets theoriques sont dimensionnes pour couvrir le
    // solde : le plan s'equilibre quel que soit le niveau de fonds propres.
    for (const fp of [400000, 4000000]) {
      const r = calculer(operation({ fonds_propres_eur: fp, prets: [] }), REFERENTIELS);
      expect(r.financement.equilibre.equilibre, `fonds propres ${fp}`).toBe(true);
    }
  });

  it('signale le desequilibre des que les prets sont saisis', () => {
    const r = calculer(
      operation({
        prets: [
          {
            code: 'CDC', libelle: 'PLUS construction', nature: 'construction',
            montant_eur: 1000000, taux: 0.023, duree_ans: 40,
            annee_premiere_echeance: 2029, revisabilite: 'DOUBLE',
          },
        ],
      }),
      REFERENTIELS,
    );
    expect(r.financement.equilibre.equilibre).toBe(false);
    expect(r.financement.equilibre.ecart_eur).toBeLessThan(0); // sous-financement
    expect(r.alertes.some((a) => /financement/i.test(a))).toBe(true);
  });

  it('refuse une zone incoherente avec le produit plutot que de calculer faux', () => {
    expect(() =>
      calculer(
        operation({
          identite: { nom: 'Zone absente', zone_ABC: 'B1', type_operation: 'VEFA' },
        }),
        REFERENTIELS,
      ),
    ).toThrow(/zone/i);
  });
});
