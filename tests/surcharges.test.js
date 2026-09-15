// @ts-check
/**
 * MODIFICATIONS DU MODELE : ce qu'un administrateur change dans le classeur
 * des calculs doit changer le calcul du moteur, et rien d'autre.
 *
 *  - sans modification, le moteur calcule avec le modele du depot, a l'identique ;
 *  - une formule reecrite, une ligne inseree changent les resultats du moteur
 *    lui-meme, pas seulement l'affichage ;
 *  - le modele du depot n'est jamais touche ;
 *  - une modification incoherente est refusee avec un message lisible.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MODELE, modeleDe } from '../src/formules/modele.js';
import { compilerGrandeur } from '../src/formules/classeur.js';
import { sansSurcharge, nombreSurcharges } from '../src/formules/surcharges.js';
import { calculerAvecClasseur } from '../src/moteur.js';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const lire = (f) => JSON.parse(readFileSync(join(racine, 'referentiels', f), 'utf8'));
const REFERENTIELS = {
  baremes: lire('baremes_her_2027.json'),
  trajectoires: lire('trajectoires_her_2027.json'),
  nomenclature_pdr: lire('nomenclature_pdr.json'),
};

/** Operation inventee a deux tranches, avec un prix de revient. */
const ENTREES = {
  identite: { nom: 'Essai', zone_ABC: 'A', zone_123: 1, type_operation: 'Neuf' },
  dates: { date_debut_travaux: '2026-03-01', duree_chantier_mois: 24, duree_simulation_ans: 40 },
  lots: [
    { code_produit: 'PLAI', nb_logements: 6, shab_m2: 380, surfaces_annexes_m2: 40 },
    { code_produit: 'PLUS', nb_logements: 10, shab_m2: 690, surfaces_annexes_m2: 80 },
  ],
  postes_bilan: [
    { id: 'cf_acquisition', chapitre: 'charge_fonciere', libelle: 'Terrain', montant_ht_eur: 700000, taux_tva: 0.055 },
    { id: 'bat_travaux', chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 2100000, taux_tva: 0.1 },
    { id: 'hon_architecte', chapitre: 'honoraires', libelle: 'Architecte', montant_ht_eur: 180000, taux_tva: 0.2 },
  ],
  subventions: [],
  prets: [],
  fonds_propres_par_produit: {},
  exploitation: { taux_vacance_impayes: 0.02, frais_gestion_pct_loyers: 0.07 },
};

const calcul = (surcharges) =>
  calculerAvecClasseur(structuredClone(ENTREES), { ...REFERENTIELS, surcharges_modele: surcharges });

describe('modifications du modele', () => {
  it('sans modification, calcule avec le modele du depot', () => {
    expect(sansSurcharge(undefined)).toBe(true);
    expect(sansSurcharge({ formules: {}, ajouts: [], niveaux: {} })).toBe(true);
    expect(modeleDe(undefined)).toBe(MODELE);
    expect(modeleDe({ formules: {} })).toBe(MODELE);
    const { resultats, classeur } = calcul(undefined);
    expect(classeur.modele).toBe(MODELE);
    expect(resultats).toEqual(calcul({ formules: {}, ajouts: [], niveaux: {} }).resultats);
  });

  it('une formule reecrite change le calcul du moteur', () => {
    const avant = calcul(undefined);
    const apres = calcul({ formules: { taux_vacance: '0.1' } });
    expect(apres.classeur.valeur('taux_vacance')).toBe(0.1);
    expect(avant.classeur.valeur('taux_vacance')).toBe(0.02);
    expect(apres.resultats).not.toEqual(avant.resultats);
    // Le modele du depot n'a pas bouge.
    expect(MODELE.grandeur('taux_vacance').formule).not.toBe('0.1');
  });

  it('une ligne inseree se calcule et se cite', () => {
    const s = {
      ajouts: [{ id: 'taux_essai', domaine: 'exploitation', apres: 'taux_vacance', libelle: 'Taux d’essai', unite: 'taux', constante: 0.05 }],
      formules: { taux_vacance: 'taux_essai * 2' },
    };
    const { classeur } = calcul(s);
    expect(classeur.valeur('taux_essai')).toBe(0.05);
    expect(classeur.valeur('taux_vacance')).toBe(0.1);
    const ids = [...classeur.modele.grandeurs.keys()];
    expect(ids.indexOf('taux_essai')).toBe(ids.indexOf('taux_vacance') + 1);
    expect(classeur.modele.grandeur('taux_essai').ajoutee).toBe(true);
    expect(nombreSurcharges(s)).toBe(2);
  });

  it('retient l’importance choisie pour une ligne', () => {
    const m = modeleDe({ niveaux: { taux_vacance: 'cle' } });
    expect(m.grandeur('taux_vacance').niveau).toBe('cle');
    expect(MODELE.grandeur('taux_vacance').niveau).not.toBe('cle');
  });

  it('refuse une modification incoherente', () => {
    expect(() => modeleDe({ formules: { grandeur_inconnue: '1' } })).toThrow(/inconnue/);
    expect(() => modeleDe({ formules: { nb_logements_lot: '1' } })).toThrow(/n’est pas calculée par une formule/);
    expect(() => modeleDe({ niveaux: { taux_vacance: 'majeur' } })).toThrow(/Importance inconnue/);
    const ajout = { domaine: 'exploitation', libelle: 'X', unite: 'eur', constante: 1 };
    expect(() => modeleDe({ ajouts: [{ ...ajout, id: 'Deux mots' }] })).toThrow(/invalide/);
    expect(() => modeleDe({ ajouts: [{ ...ajout, id: 'taux_vacance' }] })).toThrow(/existe déjà/);
    expect(() => modeleDe({ ajouts: [{ ...ajout, id: 'x_y', domaine: 'nulle_part' }] })).toThrow(/Domaine inconnu/);
    // Une formule qui cite un nom inconnu se revele a la compilation.
    const m = modeleDe({ formules: { taux_vacance: 'taux_inexistant * 2' } });
    expect(() => compilerGrandeur(m, m.grandeur('taux_vacance'))).toThrow();
  });
});
