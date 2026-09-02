// @ts-check
/**
 * R-PARAM - Surcharge des referentiels par la simulation.
 *
 * Le contrat tient en trois points : une surcharge partielle ne detruit rien,
 * une surcharge vide rend la valeur du referentiel, et le referentiel charge en
 * memoire n'est jamais modifie - sans quoi une simulation contaminerait la
 * suivante.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fusionner, surchargerTrajectoires, ecartsParametrage } from '../src/parametrage.js';
import { normaliserTrajectoires } from '../src/trajectoires.js';
import { calculer } from '../src/moteur.js';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const baremes = JSON.parse(readFileSync(join(RACINE, 'referentiels', 'baremes_her_2027.json'), 'utf8'));
const fichierTrajectoires = JSON.parse(
  readFileSync(join(RACINE, 'referentiels', 'trajectoires_axentia_2026.json'), 'utf8'),
);
const REFERENTIELS = { baremes, trajectoires: fichierTrajectoires };
/** Plafond PLS en zone B1, lu au referentiel : il change a chaque millesime. */
const PLAFOND_PLS_B1 = baremes.loyers_max_zone_ABC.PLS[2];
/** Millesime du bareme de loyers, idem. */
const MILLESIME = baremes.loyers_max_zone_ABC.annee_reference;

const BASE = {
  identite: { zone_123: 2, zone_ABC: 'B1' },
  dates: { annee_mise_en_location: 2028, duree_simulation_ans: 10 },
  lots: [{ code_produit: 'PLS', nb_logements: 29, shab_m2: 1180, surfaces_annexes_m2: 0 }],
  postes_bilan: [{ chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 1100000, taux_tva: 0.1 }],
  fonds_propres_eur: 100000,
  prets: [],
  // R-LOYER-9 neutralise par defaut dans ce fichier : les tests de surcharge
  // comparent des plafonds a leur valeur au referentiel, que le rattrapage du
  // millesime rendrait incomparables. Les tests de R-LOYER-9, eux, le reactivent.
  options: { revaloriser_loyers_plafonds: false },
};

describe('fusionner - composition d une surcharge partielle', () => {
  it('remplace une valeur simple sans toucher a ses voisines', () => {
    const r = fusionner({ a: 1, b: 2, c: 3 }, { b: 20 });
    expect(r).toEqual({ a: 1, b: 20, c: 3 });
  });

  it('descend dans les objets imbriques', () => {
    const r = fusionner({ tva: { normal: 0.2, reduit: 0.1 } }, { tva: { reduit: 0.055 } });
    expect(r).toEqual({ tva: { normal: 0.2, reduit: 0.055 } });
  });

  it('fusionne les tableaux PAR INDEX : une zone se corrige seule', () => {
    // C'est ce qui permet de ne redonner que la zone B1 d'un bareme de loyers
    // sans recopier les quatre autres.
    expect(fusionner([7.32, 6.42, 5.95, 7.77], [null, null, 6.1])).toEqual([7.32, 6.42, 6.1, 7.77]);
  });

  it('une surcharge VIDE rend la valeur du referentiel', () => {
    // Effacer une cellule a l'ecran ne doit ni imposer zero ni casser le calcul.
    for (const vide of [null, undefined, '', NaN]) {
      expect(fusionner({ a: 1 }, { a: vide }), `surcharge ${String(vide)}`).toEqual({ a: 1 });
    }
    expect(fusionner({ a: 1 }, null)).toEqual({ a: 1 });
    expect(fusionner({ a: 1 }, {})).toEqual({ a: 1 });
    // Zero, lui, est une valeur : une marge nulle doit pouvoir se saisir.
    expect(fusionner({ a: 1 }, { a: 0 })).toEqual({ a: 0 });
  });

  it('ajoute une cle absente du referentiel plutot que de la perdre', () => {
    expect(fusionner({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('ne modifie NI le referentiel NI la surcharge', () => {
    const ref = { tva: { normal: 0.2 }, zones: [1, 2] };
    const sur = { tva: { normal: 0.21 }, zones: [9] };
    fusionner(ref, sur);
    expect(ref).toEqual({ tva: { normal: 0.2 }, zones: [1, 2] });
    expect(sur).toEqual({ tva: { normal: 0.21 }, zones: [9] });
  });
});

describe('surchargerTrajectoires - table creuse par annee', () => {
  const t = normaliserTrajectoires(fichierTrajectoires);

  it('ne rend pas un nouvel objet quand il n y a rien a surcharger', () => {
    expect(surchargerTrajectoires(t, undefined)).toBe(t);
    expect(surchargerTrajectoires(t, { par_annee: {} })).not.toBe(t);
  });

  it('corrige une annee sans toucher aux autres', () => {
    const s = surchargerTrajectoires(t, { par_annee: { 2030: { loyers_irl: 0.031 } } });
    expect(s.par_poste.loyers_irl[2030]).toBe(0.031);
    expect(s.par_poste.loyers_irl[2031]).toBe(t.par_poste.loyers_irl[2031]);
    expect(s.par_poste.gestion[2030]).toBe(t.par_poste.gestion[2030]);
    // L'original reste intact : deux simulations d'affilee ne se contaminent pas.
    expect(t.par_poste.loyers_irl[2030]).not.toBe(0.031);
  });

  it('deplace le Livret A dans SES DEUX tables a la fois', () => {
    // L'amortissement le lit dans `livret_a_par_annee`, l'exploitation dans
    // `par_poste` : n'en changer qu'une ne deplacerait que la moitie du resultat.
    const s = surchargerTrajectoires(t, { par_annee: { 2030: { livret_a: 0.04 } } });
    expect(s.livret_a_par_annee[2030]).toBe(0.04);
    expect(s.par_poste.livret_a[2030]).toBe(0.04);
  });

  it('surcharge le Livret A de reference des prets', () => {
    const s = surchargerTrajectoires(t, { taux_reference_livret_a: 0.03 });
    expect(s.taux_reference_livret_a).toBe(0.03);
    expect(surchargerTrajectoires(t, { taux_reference_livret_a: null }).taux_reference_livret_a)
      .toBe(t.taux_reference_livret_a);
  });
});

describe('ecartsParametrage - tracabilite', () => {
  it('liste les chemins reellement modifies, et eux seuls', () => {
    const e = ecartsParametrage(
      { tva: { normal: 0.2, reduit: 0.1 } },
      { tva: { normal: 0.21, reduit: null } },
    );
    expect(e).toEqual([{ chemin: 'tva.normal', referentiel: 0.2, applique: 0.21 }]);
  });

  it('ne signale pas une saisie identique au referentiel', () => {
    expect(ecartsParametrage({ a: 5 }, { a: 5 })).toEqual([]);
  });
});

describe('R-PARAM de bout en bout : la surcharge change le resultat', () => {
  it('un loyer plafond surcharge deplace les recettes', () => {
    const ref = calculer(BASE, REFERENTIELS);
    // Zone B1 du bareme A/B/C = index 2, PLS a 10,07 EUR/m2.
    const sur = calculer(
      { ...BASE, parametrage: { baremes: { loyers_max_zone_ABC: { PLS: [null, null, 12] } } } },
      REFERENTIELS,
    );
    expect(sur.loyers[0].loyer_base_eur_m2).toBe(12);
    expect(sur.indicateurs.loyers_annuels_eur).toBeGreaterThan(ref.indicateurs.loyers_annuels_eur);
    // Les autres zones du meme bareme n'ont pas bouge.
    expect(sur.parametrage.baremes_ecarts).toEqual([
      { chemin: 'loyers_max_zone_ABC.PLS.2', referentiel: PLAFOND_PLS_B1, applique: 12 },
    ]);
  });

  it('un taux de TVA surcharge deplace le prix de revient', () => {
    const ref = calculer(BASE, REFERENTIELS);
    const sur = calculer(
      { ...BASE, parametrage: { baremes: { tva: { lasm_par_produit: { PLS: 0.2 } } } } },
      REFERENTIELS,
    );
    expect(sur.bilan.total_ttc_lasm_eur).toBeGreaterThan(ref.bilan.total_ttc_lasm_eur);
  });

  it('une trajectoire surchargee deplace le compte d exploitation', () => {
    const annees = {};
    for (let a = 2028; a <= 2040; a++) annees[a] = { loyers_irl: 0.05 };
    const ref = calculer(BASE, REFERENTIELS);
    const sur = calculer({ ...BASE, parametrage: { trajectoires: { par_annee: annees } } }, REFERENTIELS);
    const derniere = (r) => r.exploitation.lignes.at(-1).loyers_logements_eur;
    expect(derniere(sur)).toBeGreaterThan(derniere(ref));
    expect(sur.parametrage.trajectoires_surchargees).toBe(13);
  });

  it('le referentiel n est pas contamine d une simulation a l autre', () => {
    calculer(
      { ...BASE, parametrage: { baremes: { loyers_max_zone_ABC: { PLS: [null, null, 12] } } } },
      REFERENTIELS,
    );
    expect(baremes.loyers_max_zone_ABC.PLS[2]).toBe(PLAFOND_PLS_B1);
    expect(calculer(BASE, REFERENTIELS).loyers[0].loyer_base_eur_m2).toBe(PLAFOND_PLS_B1);
  });
});

describe('R-LOYER-9 - millesime du bareme de loyers', () => {
  /** Meme operation, mais avec la revalorisation dans son etat par defaut. */
  const AVEC = { ...BASE, options: {} };
  const SANS = BASE;
  /** Annees a rattraper entre le millesime du bareme et la mise en location. */
  const ANNEES = [];
  for (let a = MILLESIME + 1; a <= 2028; a++) ANNEES.push(a);
  const cumulIRL = () => {
    const t = normaliserTrajectoires(fichierTrajectoires).par_poste.loyers_irl;
    return ANNEES.reduce((c, a) => c * (1 + (t[a] ?? 0)), 1);
  };

  it('revalorise PAR DEFAUT du millesime a la mise en location', () => {
    const cumul = cumulIRL();
    const avec = calculer(AVEC, REFERENTIELS);
    const sans = calculer(SANS, REFERENTIELS);
    expect(sans.loyers[0].loyer_base_eur_m2).toBe(PLAFOND_PLS_B1); // le plafond du bareme
    expect(avec.loyers[0].loyer_base_eur_m2).toBeCloseTo(Math.round(PLAFOND_PLS_B1 * cumul * 100) / 100, 2);
    expect(avec.indicateurs.loyers_annuels_eur).toBeGreaterThan(sans.indicateurs.loyers_annuels_eur);
  });

  it('nomme l ecart avec LEON, qui applique le bareme tel quel', () => {
    const a = calculer(AVEC, REFERENTIELS).alertes
      .find((x) => new RegExp('revalorises du millesime ' + MILLESIME).test(x));
    expect(a).toBeDefined();
    expect(a).toMatch(/Ecart assume avec LEON/);
  });

  it('desactivee, chiffre ce que le millesime perime coute', () => {
    const a = calculer(SANS, REFERENTIELS).alertes
      .find((x) => new RegExp('Bareme de loyers ' + MILLESIME).test(x));
    expect(a).toBeDefined();
    expect(a).toMatch(new RegExp(ANNEES.length + ' ans? de revalorisation'));
    expect(a).toMatch(/EUR de loyers annuels/);
  });

  it('ne touche QUE le plafond de zone, pas la marge locale', () => {
    // La marge locale est une saisie en euros du jour : elle n'a pas de
    // millesime a rattraper, et doit donc s'ajouter apres revalorisation.
    const cumul = cumulIRL();
    const r = calculer(
      { ...AVEC, loyers_par_produit: { PLS: { marge_locale_eur_m2: 1 } } },
      REFERENTIELS,
    );
    expect(r.loyers[0].loyer_base_eur_m2).toBeCloseTo(Math.round((PLAFOND_PLS_B1 * cumul + 1) * 100) / 100, 2);
  });

  it('se tait quand le bareme est au millesime de la mise en location', () => {
    const r = calculer(
      {
        ...AVEC,
        parametrage: {
          baremes: {
            loyers_max_zone_123: { annee_reference: 2028 },
            loyers_max_zone_ABC: { annee_reference: 2028 },
          },
        },
      },
      REFERENTIELS,
    );
    expect(r.alertes.some((x) => /millesime|Bareme de loyers/.test(x))).toBe(false);
    expect(r.loyers[0].loyer_base_eur_m2).toBe(PLAFOND_PLS_B1);
  });
});

describe('R-PARAM - listes a identifiants', () => {
  const base = [
    { id: 'A', libelle: 'Alpha', duree_ans: 40 },
    { id: 'B', libelle: 'Beta', duree_ans: 30 },
    { id: 'C', libelle: 'Gamma', duree_ans: 25 },
  ];

  it('permet de RETIRER un element, ce que la fusion par index interdit', () => {
    // Par index, la base reapparaitrait au-dela de la longueur de la surcharge
    // et la suppression serait sans effet.
    const r = fusionner(base, [base[0], base[2]]);
    expect(r.map((x) => x.id)).toEqual(['A', 'C']);
  });

  it('fusionne par IDENTIFIANT et non par rang', () => {
    // Meme reordonne, chaque element retrouve sa base : une surcharge partielle
    // sur B ne doit pas aller se poser sur A parce qu'il a change de place.
    const r = fusionner(base, [{ id: 'B', duree_ans: 35 }, { id: 'A' }]);
    expect(r[0]).toEqual({ id: 'B', libelle: 'Beta', duree_ans: 35 });
    expect(r[1]).toEqual({ id: 'A', libelle: 'Alpha', duree_ans: 40 });
  });

  it('accepte un element entierement nouveau', () => {
    const r = fusionner(base, [...base, { id: 'D', libelle: 'Delta', duree_ans: 20 }]);
    expect(r).toHaveLength(4);
    expect(r[3].libelle).toBe('Delta');
  });

  it('laisse les tableaux POSITIONNELS fusionner par index', () => {
    // Un bareme de zones n'a pas d'identifiant : une surcharge partielle doit
    // continuer de ne toucher que les rangs qu'elle donne.
    expect(fusionner([7.4, 6.49, 6.01, 7.85], [, , 6.5])).toEqual([7.4, 6.49, 6.5, 7.85]);
  });

  it('ne TRONQUE pas la liste quand la surcharge ne corrige que ses premiers rangs', () => {
    // C'est le cas de l'ecran des modeles de pret : corriger le libelle des
    // deux premiers ecrit un correctif de DEUX elements partiels, sans
    // identifiant. Il ne doit toucher que ces deux rangs - les seize autres
    // modeles n'ont pas bouge, ils ne sont pas pour autant supprimes.
    const r = fusionner(base, [{ libelle: 'Alpha bis' }, { libelle: 'Beta bis' }]);
    expect(r).toHaveLength(base.length);
    expect(r[0].libelle).toBe('Alpha bis');
    expect(r[1].libelle).toBe('Beta bis');
    // Les rangs corriges gardent le RESTE de leurs champs : un correctif de
    // libelle ne doit pas emporter la duree ni le taux.
    expect(r[0].id).toBe(base[0].id);
    expect(r[2]).toEqual(base[2]);
  });

  it('ne laisse pas une surcharge vide effacer la liste', () => {
    expect(fusionner(base, [])).toEqual(base);
  });
});
