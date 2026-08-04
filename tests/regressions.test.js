// @ts-check
/**
 * Tests de non-regression sur cinq defauts constates par execution du moteur
 * le 04/08/2026, dont aucun ne levait d'erreur : ils se voyaient seulement sur
 * les montants. Ce fichier existe pour qu'ils ne reviennent pas silencieusement.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { calculer } from '../src/moteur.js';
import { coefficientStructure } from '../src/loyers.js';
import { adapterTrajectoires, normaliserTrajectoires } from '../src/trajectoires.js';
import { calendrierOperation, decalerMois } from '../src/calendrier.js';
import { resoudreTaux, resoudreDuree, pretsDefautResolus, produitsOrdonnes } from '../src/produits.js';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const baremes = JSON.parse(readFileSync(join(RACINE, 'referentiels', 'baremes_2025.json'), 'utf8'));
const fichierTrajectoires = JSON.parse(
  readFileSync(join(RACINE, 'referentiels', 'trajectoires_axentia_2026.json'), 'utf8'),
);
const REFERENTIELS = { baremes, trajectoires: fichierTrajectoires };

const BASE = {
  identite: { produit: 'PLS', zone_123: 2, zone_ABC: 'B1' },
  dates: { annee_mise_en_location: 2028, duree_simulation_ans: 10 },
  lots: [{ code_produit: 'PLS', nb_logements: 29, shab_m2: 1180, surfaces_annexes_m2: 0 }],
  postes_bilan: [{ chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 1100000, taux_tva: 0.1 }],
  fonds_propres_eur: 100000,
};
const PRET_CDC = {
  code: 'CDC', nature: 'construction', montant_eur: 500000, taux: 0.03,
  duree_ans: 40, annee_premiere_echeance: 2028, revisabilite: 'TAUX FIXE',
};

describe('V1 — un pret « autre » n est compte qu une fois dans les ressources', () => {
  const r = calculer(
    {
      ...BASE,
      prets: [
        PRET_CDC,
        { code: 'ALS', nature: 'autre', montant_eur: 100000, taux: 0.01, duree_ans: 25, annee_premiere_echeance: 2028, revisabilite: 'TAUX FIXE' },
      ],
    },
    REFERENTIELS,
  );

  it('somme les ressources sans doublon', () => {
    // 100 000 FP + 500 000 CDC + 100 000 ALS
    expect(r.financement.equilibre.ressources_eur).toBe(700000);
    expect(r.financement.total_prets_eur).toBe(600000);
  });

  it('exclut les prets non CDC du ratio reglementaire R-FIN-5', () => {
    expect(r.financement.total_prets_cdc_eur).toBe(500000);
    // 500 000 / 1 210 000 = 41,3 % et non 49,6 %
    expect(r.financement.equilibre.ratio_prets_cdc).toBeCloseTo(500000 / 1210000, 10);
  });
});

describe('V2 — le profil de trajectoires du referentiel est reellement applique', () => {
  it('convertit le fichier (une ligne par annee) en dictionnaires par poste', () => {
    const t = adapterTrajectoires(fichierTrajectoires);
    expect(t.par_poste.loyers_irl[2026]).toBe(0.023);
    expect(t.livret_a_par_annee[2026]).toBe(0.0225);
    expect(t.profil).toBe('AXENTIA HER 2026 (PMT 2025)');
  });

  it('indexe effectivement les loyers, au lieu de retomber a zero', () => {
    const r = calculer({ ...BASE, prets: [PRET_CDC] }, REFERENTIELS);
    const an1 = r.exploitation.lignes[0].loyers_logements_eur;
    const an5 = r.exploitation.lignes[4].loyers_logements_eur;
    expect(an5).toBeGreaterThan(an1);
    expect(r.profil_trajectoires).toBe('AXENTIA HER 2026 (PMT 2025)');
  });

  it('accepte indifferemment le fichier brut, un objet deja adapte ou une forme libre', () => {
    const adapte = adapterTrajectoires(fichierTrajectoires);
    expect(normaliserTrajectoires(adapte)).toBe(adapte);
    expect(normaliserTrajectoires(fichierTrajectoires).par_poste.tfpb[2026]).toBe(0.05);
    expect(normaliserTrajectoires({ loyers_irl: 0.02 }).par_poste.loyers_irl).toBe(0.02);
  });

  it('refuse un referentiel de trajectoires malforme plutot que de l ignorer', () => {
    expect(() => adapterTrajectoires({ trajectoires: [] })).toThrow(/trajectoires/i);
    expect(() => adapterTrajectoires({})).toThrow(/trajectoires/i);
  });
});

describe('V3 — le coefficient de structure porte sur la tranche, pas sur la ligne de saisie', () => {
  it('donne le meme CS quel que soit le decoupage de la saisie', () => {
    const attendu = coefficientStructure({ nb_logements: 29, su_m2: 1180 }, baremes);
    const enUneLigne = calculer({ ...BASE, prets: [PRET_CDC] }, REFERENTIELS);
    const enDeuxLignes = calculer(
      {
        ...BASE,
        lots: [
          { code_produit: 'PLS', nb_logements: 15, shab_m2: 600 },
          { code_produit: 'PLS', nb_logements: 14, shab_m2: 580 },
        ],
        prets: [PRET_CDC],
      },
      REFERENTIELS,
    );
    expect(enUneLigne.loyers[0].cs).toBe(attendu);
    expect(enDeuxLignes.loyers).toHaveLength(1); // une ligne de loyer PAR TRANCHE
    expect(enDeuxLignes.loyers[0].cs).toBe(attendu);
    expect(enDeuxLignes.loyers[0].loyer_annuel_eur).toBe(enUneLigne.loyers[0].loyer_annuel_eur);
  });

  it('restitue les tranches dans l ordre canonique', () => {
    const r = calculer(
      {
        ...BASE,
        identite: { produit: 'PLUS', zone_123: 2, zone_ABC: 'B1' },
        lots: [
          { code_produit: 'PLS', nb_logements: 5, shab_m2: 200 },
          { code_produit: 'PLAI', nb_logements: 5, shab_m2: 200 },
          { code_produit: 'PLUS', nb_logements: 5, shab_m2: 200 },
        ],
        prets: [PRET_CDC],
      },
      REFERENTIELS,
    );
    expect(r.surfaces.tranches).toEqual(['PLAI', 'PLUS', 'PLS']);
    expect(r.alertes.some((a) => /tranches/i.test(a))).toBe(true); // LASM unique signale
  });
});

describe('V4 — les prets CDC theoriques sont calculables sans saisie', () => {
  it('ne leve plus « Duree de pret invalide » quand aucun pret n est saisi', () => {
    const r = calculer({ ...BASE, prets: [] }, REFERENTIELS);
    expect(r.amortissements.length).toBeGreaterThan(0);
    const t = r.amortissements[0].tableau;
    expect(t).toHaveLength(40); // duree PLS construction (R-AMT-1)
    expect(t.at(-1)?.crd_eur).toBeCloseTo(0, 4);
  });

  it('resout taux et durees depuis les cles declaratives de produits.js', () => {
    expect(resoudreTaux('LA+1.11', 0.017)).toBeCloseTo(0.0281, 10);
    expect(resoudreTaux('LA-0.20', 0.017)).toBeCloseTo(0.015, 10);
    expect(resoudreTaux('fixe', 0.017)).toBe(null);
    expect(resoudreDuree('40')).toBe(40);
    expect(resoudreDuree('zone_abc:B2|C->50,sinon->60', 'B2')).toBe(50);
    expect(resoudreDuree('zone_abc:B2|C->50,sinon->60', 'B1')).toBe(60);
    expect(() => resoudreDuree('zone_abc:B2|C->50,sinon->60')).toThrow(/zone/i);
  });

  it('expose les prets par defaut d un produit', () => {
    const p = pretsDefautResolus('PLUS', { zone_ABC: 'C', livret_a_reference: 0.017 });
    expect(p).toHaveLength(2);
    expect(p.find((x) => x.nature === 'construction')?.duree_ans).toBe(40);
    expect(p.find((x) => x.nature === 'foncier')?.duree_ans).toBe(50);
    expect(p[0].taux).toBeCloseTo(0.023, 10); // LA + 0,60
  });
});

describe('V5 — barèmes de loyer des produits', () => {
  it('tous les produits du perimetre V1 resolvent leur bareme', () => {
    for (const p of produitsOrdonnes().filter((x) => x.v1)) {
      expect(
        () => calculer({ ...BASE, identite: { produit: p.code, zone_123: 2, zone_ABC: 'B1' },
          lots: [{ code_produit: p.code, nb_logements: 5, shab_m2: 300 }], prets: [PRET_CDC] }, REFERENTIELS),
        `produit ${p.code}`,
      ).not.toThrow();
    }
  });

  it('LOC/LLI est declare mais son bareme est absent du referentiel (hors V1, connu)', () => {
    expect(() =>
      calculer({ ...BASE, identite: { produit: 'LOC', zone_123: 2, zone_ABC: 'B1' },
        lots: [{ code_produit: 'LOC', nb_logements: 5, shab_m2: 300 }], prets: [PRET_CDC] }, REFERENTIELS),
    ).toThrow(/bareme de loyer absent/i);
  });
});

describe('alertes de bord', () => {
  it('signale les annuites qui tombent au-dela de l horizon de simulation', () => {
    const r = calculer(
      {
        ...BASE,
        dates: { annee_mise_en_location: 2028, duree_simulation_ans: 30 },
        prets: [{ code: 'F', libelle: 'Pret foncier', nature: 'foncier', montant_eur: 200000,
          taux: 0.03, duree_ans: 60, annee_premiere_echeance: 2028, revisabilite: 'TAUX FIXE' }],
      },
      REFERENTIELS,
    );
    const alerte = r.alertes.find((a) => /horizon de simulation/i.test(a));
    expect(alerte).toBeDefined();
    expect(alerte).toMatch(/2087/); // derniere echeance du pret
  });
});

describe('calendrier de l operation', () => {
  it('derive livraison et mise en location du debut des travaux', () => {
    const c = calendrierOperation({ date_debut_travaux: '2026-01-01', duree_chantier_mois: 24 });
    expect(c.date_livraison).toBe('2028-01-01');
    expect(c.date_mise_en_location).toBe('2028-01-02');
    expect(c.annee_mise_en_location).toBe(2028);
    expect(c.origine.date_livraison).toBe('calcule');
  });

  it('accepte une date de livraison surchargee (contractuelle en VEFA)', () => {
    const c = calendrierOperation({
      date_debut_travaux: '2026-01-01', duree_chantier_mois: 24, date_livraison: '2027-09-30',
    });
    expect(c.date_livraison).toBe('2027-09-30');
    expect(c.origine.date_livraison).toBe('saisie');
    expect(c.annee_mise_en_location).toBe(2027);
  });

  it('accepte la forme minimale : une simple annee', () => {
    expect(calendrierOperation({ annee_mise_en_location: 2030 }).annee_mise_en_location).toBe(2030);
  });

  it('decale en mois calendaires et non en tranches de 30 jours', () => {
    expect(decalerMois('2026-01-31', 1)).toBe('2026-02-28'); // retombe sur la fin du mois
    expect(decalerMois('2027-12-15', 3)).toBe('2028-03-15'); // franchit l annee
  });

  it('refuse un calendrier incomplet plutot que d inventer une date', () => {
    expect(() => calendrierOperation({})).toThrow(/calendrier incomplet/i);
    expect(() => calculer({ ...BASE, dates: {}, prets: [] }, REFERENTIELS)).toThrow(/calendrier/i);
  });
});
