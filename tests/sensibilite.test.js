// @ts-check
/**
 * R-SENS - Analyse de sensibilite.
 *
 * Le module ne modelise rien : il relance le moteur sur des entrees decalees.
 * Les oracles sont donc des INVARIANTS - le point central vaut la reference, un
 * levier qui alourdit degrade, la tornade classe par poids - et non des valeurs
 * cibles, qui ne feraient que recopier le moteur.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { calculer } from '../src/moteur.js';
import {
  LEVIERS,
  INDICATEURS,
  balayerLevier,
  plage,
  tornade,
  chercherEquilibre,
} from '../src/sensibilite.js';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const lire = (f) => JSON.parse(readFileSync(join(racine, 'referentiels', f), 'utf8'));

const REFERENTIELS = {
  baremes: lire('baremes_her_2027.json'),
  trajectoires: lire('trajectoires_her_2027.json'),
  nomenclature_pdr: lire('nomenclature_pdr.json'),
  departements: lire('departements.json'),
  zonage_abc_communes: lire('zonage_abc_communes.json'),
};

/** Operation minimale mais complete : deux tranches, des postes, une subvention. */
const ENTREES = {
  identite: {
    nom: 'Sensibilité',
    commune: 'Ambérieu-en-Bugey',
    departement: 'Ain (01)',
    zone_ABC: 'B1',
    zone_123: '1',
    type_operation: 'VEFA',
  },
  dates: { date_debut_travaux: '2026-01-01', duree_chantier_mois: 24, duree_simulation_ans: 40 },
  lots: [
    { code_produit: 'PLAI', nb_logements: 6, shab_m2: 380, annexes_m2: 48 },
    { code_produit: 'PLUS', nb_logements: 8, shab_m2: 520, annexes_m2: 64 },
  ],
  postes_bilan: [
    { id: 'cf_acquisition', chapitre: 'charge_fonciere', numero: 1, libelle: 'Acquisition', montant_ht_eur: 640000 },
    { id: 'bat_travaux', chapitre: 'batiment', numero: 20, libelle: 'Travaux', montant_ht_eur: 1180000 },
    { id: 'hon_architecte', chapitre: 'honoraires', numero: 30, libelle: 'Architecte', montant_ht_eur: 118000 },
  ],
  subventions: [{ libelle: 'État', montant_eur: 60000, affectation: null }],
  prets: [],
  exploitation: { taux_vacance_impayes: 0.02, frais_gestion_pct_loyers: 0.07, gros_entretien_eur_m2: 5 },
};

const reference = calculer(ENTREES, REFERENTIELS);

describe('plage de variations', () => {
  it('porte toujours le point central, et il vaut zero', () => {
    for (const n of [3, 4, 5, 7]) {
      const p = plage(0.1, n);
      expect(p.length % 2).toBe(1);
      expect(p[(p.length - 1) / 2]).toBe(0);
    }
  });

  it('est symetrique et atteint ses bornes', () => {
    const p = plage(0.05, 5);
    expect(p[0]).toBeCloseTo(-0.05, 12);
    expect(p.at(-1)).toBeCloseTo(0.05, 12);
    expect(p[0] + p.at(-1)).toBeCloseTo(0, 12);
  });
});

describe('balayage d un levier', () => {
  it('rend le resultat de reference sur la variation nulle', () => {
    const { points } = balayerLevier(ENTREES, REFERENTIELS, 'cout_batiment', [0]);
    expect(points[0].erreur).toBeNull();
    expect(points[0].resultat.indicateurs.prix_revient_ttc_eur).toBe(
      reference.indicateurs.prix_revient_ttc_eur,
    );
  });

  it('ne cumule pas les variations d un point au suivant', () => {
    // Deux fois +10 % d affilee doivent donner deux fois le MEME prix de
    // revient, et non un effet compose.
    const { points } = balayerLevier(ENTREES, REFERENTIELS, 'prix_revient', [0.1, 0.1]);
    expect(points[0].resultat.indicateurs.prix_revient_ttc_eur).toBe(
      points[1].resultat.indicateurs.prix_revient_ttc_eur,
    );
  });

  it('fait monter le prix de revient avec le cout des travaux', () => {
    const { points } = balayerLevier(ENTREES, REFERENTIELS, 'cout_batiment', plage(0.05, 5));
    const prix = points.map((p) => p.resultat.indicateurs.prix_revient_ttc_eur);
    for (let k = 1; k < prix.length; k++) expect(prix[k]).toBeGreaterThan(prix[k - 1]);
  });

  it('ne touche que le chapitre vise', () => {
    // +50 % sur le batiment ne doit pas bouger la charge fonciere.
    const { points } = balayerLevier(ENTREES, REFERENTIELS, 'cout_batiment', [0.5]);
    const avant = reference.bilan.chapitres.charge_fonciere.ht_eur;
    expect(points[0].resultat.bilan.chapitres.charge_fonciere.ht_eur).toBe(avant);
    expect(points[0].resultat.bilan.chapitres.batiment.ht_eur).toBeGreaterThan(
      reference.bilan.chapitres.batiment.ht_eur,
    );
  });

  it('laisse les entrees d origine INTACTES', () => {
    const empreinte = JSON.stringify(ENTREES);
    balayerLevier(ENTREES, REFERENTIELS, 'prix_revient', plage(0.2, 5));
    expect(JSON.stringify(ENTREES)).toBe(empreinte);
  });

  it('laisse les referentiels d origine intacts', () => {
    const empreinte = JSON.stringify(REFERENTIELS.trajectoires);
    balayerLevier(ENTREES, REFERENTIELS, 'livret_a', plage(0.01, 5));
    expect(JSON.stringify(REFERENTIELS.trajectoires)).toBe(empreinte);
  });

  it('degrade l autofinancement quand la vacance augmente', () => {
    const { points } = balayerLevier(ENTREES, REFERENTIELS, 'vacance_impayes', [-0.01, 0.01]);
    const bas = points[0].resultat.exploitation.indicateurs.resultat_cumule_final_eur;
    const haut = points[1].resultat.exploitation.indicateurs.resultat_cumule_final_eur;
    expect(haut).toBeLessThan(bas);
  });

  it('refuse un levier inconnu', () => {
    expect(() => balayerLevier(ENTREES, REFERENTIELS, 'inconnu', [0])).toThrow(/Levier inconnu/);
  });
});

describe('tornade', () => {
  const t = tornade(ENTREES, REFERENTIELS, { indicateur: 'autofinancement_cumule' });

  it('rend une barre par levier', () => {
    expect(t.barres.length).toBe(LEVIERS.length);
  });

  it('classe par poids decroissant', () => {
    const ecarts = t.barres.map((b) => b.ecart ?? -1);
    for (let k = 1; k < ecarts.length; k++) expect(ecarts[k]).toBeLessThanOrEqual(ecarts[k - 1]);
  });

  it('donne la meme reference que le moteur', () => {
    expect(t.reference).toBe(reference.exploitation.indicateurs.resultat_cumule_final_eur);
  });

  it('encadre la reference sur un levier monotone', () => {
    const b = t.barres.find((x) => x.code === 'vacance_impayes');
    expect(b).toBeDefined();
    expect(Math.min(b.bas, b.haut)).toBeLessThanOrEqual(t.reference);
    expect(Math.max(b.bas, b.haut)).toBeGreaterThanOrEqual(t.reference);
  });

  it('accepte de ne balayer qu une partie des leviers', () => {
    const partielle = tornade(ENTREES, REFERENTIELS, {
      indicateur: 'autofinancement_cumule',
      leviers: ['cout_batiment', 'prix_revient'],
    });
    expect(partielle.barres.map((b) => b.code).sort()).toEqual(['cout_batiment', 'prix_revient']);
    // A amplitude egale, le prix de revient ENTIER pese plus que le seul
    // batiment : il le contient.
    expect(partielle.barres[0].code).toBe('prix_revient');
  });

  it('refuse un indicateur inconnu', () => {
    expect(() => tornade(ENTREES, REFERENTIELS, { indicateur: 'inconnu' })).toThrow(
      /Indicateur inconnu/,
    );
  });
});

describe('catalogues', () => {
  it('n a pas deux leviers ni deux indicateurs de meme code', () => {
    expect(new Set(LEVIERS.map((l) => l.code)).size).toBe(LEVIERS.length);
    expect(new Set(INDICATEURS.map((i) => i.code)).size).toBe(INDICATEURS.length);
  });

  it('declare une amplitude strictement positive pour chaque levier', () => {
    for (const l of LEVIERS) expect(l.amplitude).toBeGreaterThan(0);
  });

  it('lit chaque indicateur sans lever sur un resultat complet', () => {
    for (const i of INDICATEURS) {
      const v = i.lire(reference);
      expect(v === null || Number.isFinite(v)).toBe(true);
    }
  });
});

describe('recherche d equilibre', () => {
  it('trouve la subvention qui ramene les fonds propres a une cible', () => {
    const r = chercherEquilibre(ENTREES, REFERENTIELS, {
      levier: 'subventions',
      objectif: 'fonds_propres',
    });
    expect(r.applique).toBe(true);
    if (r.trouve) {
      // La solution DOIT verifier l objectif : on relit le resultat qu elle
      // porte plutot que de croire la fonction sur parole.
      expect(Math.abs(r.objectif.lire(r.resultat) - r.cible)).toBeLessThanOrEqual(1);
      // Zero iteration est une reponse valide : la cible etait deja atteinte.
      if (r.iterations === 0) expect(r.variation).toBe(0);
    } else {
      expect(r.raison).toBeTruthy();
    }
  });

  it('rend une variation nulle quand la cible est deja atteinte', () => {
    const fp = reference.indicateurs.fonds_propres_eur;
    const r = chercherEquilibre(ENTREES, REFERENTIELS, {
      levier: 'prix_revient',
      objectif: 'fonds_propres',
      cible: fp,
    });
    expect(r.trouve).toBe(true);
    expect(r.variation).toBe(0);
    expect(r.iterations).toBe(0);
  });

  it('atteint un autofinancement cumule vise', () => {
    const cible = reference.exploitation.indicateurs.resultat_cumule_final_eur + 50000;
    const r = chercherEquilibre(ENTREES, REFERENTIELS, {
      levier: 'prix_revient',
      objectif: 'autofinancement_cumule',
      cible,
      tolerance: 500,
    });
    expect(r.trouve).toBe(true);
    expect(Math.abs(r.objectif.lire(r.resultat) - cible)).toBeLessThanOrEqual(500);
    // Moins cher, donc moins d annuites : la variation doit etre NEGATIVE.
    expect(r.variation).toBeLessThan(0);
  });

  it('dit quand la cible est hors de portee, et ce qu il est possible d atteindre', () => {
    const r = chercherEquilibre(ENTREES, REFERENTIELS, {
      levier: 'subventions',
      objectif: 'autofinancement_cumule',
      cible: 1e12,
    });
    expect(r.trouve).toBe(false);
    expect(r.applique).toBe(true);
    expect(r.atteignable).toHaveLength(2);
    expect(r.atteignable[0]).toBeLessThanOrEqual(r.atteignable[1]);
  });

  it('distingue un levier sans prise d une cible hors de portee', () => {
    const sansSubvention = { ...ENTREES, subventions: [] };
    const r = chercherEquilibre(sansSubvention, REFERENTIELS, {
      levier: 'subventions',
      objectif: 'fonds_propres',
    });
    expect(r.trouve).toBe(false);
    expect(r.applique).toBe(false);
    expect(r.raison).toMatch(/prise/);
  });

  it('laisse les entrees d origine intactes', () => {
    const empreinte = JSON.stringify(ENTREES);
    chercherEquilibre(ENTREES, REFERENTIELS, { levier: 'prix_revient', objectif: 'fonds_propres' });
    expect(JSON.stringify(ENTREES)).toBe(empreinte);
  });

  it('refuse un objectif inconnu', () => {
    expect(() =>
      chercherEquilibre(ENTREES, REFERENTIELS, { levier: 'prix_revient', objectif: 'inconnu' }),
    ).toThrow(/Objectif inconnu/);
  });
});
