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
import { prixDeRevientVentile } from '../src/bilan.js';
import { scinderPLS, plafondPretsLLI } from '../src/financement.js';
import { arrondirEnConservantLaSomme } from '../src/arrondis.js';
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
/** Grille tarifaire des prets CDC : les marges ne sont plus dans le code. */
const MARGES = baremes.prets_cdc.marges;

const BASE = {
  identite: { zone_123: 2, zone_ABC: 'B1' },
  dates: { annee_mise_en_location: 2028, duree_simulation_ans: 10 },
  lots: [{ code_produit: 'PLS', nb_logements: 29, shab_m2: 1180, surfaces_annexes_m2: 0 }],
  postes_bilan: [{ chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 1100000, taux_tva: 0.1 }],
  fonds_propres_eur: 100000,
};
const PRET_CDC = {
  code: 'CDC', nature: 'construction', montant_eur: 500000, taux: 0.03,
  duree_ans: 40, annee_premiere_echeance: 2028, revisabilite: 'TAUX FIXE',
};

describe('V1 - un pret « autre » n est compte qu une fois dans les ressources', () => {
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

describe('V2 - le profil de trajectoires du referentiel est reellement applique', () => {
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

describe('V3 - le coefficient de structure porte sur la tranche, pas sur la ligne de saisie', () => {
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
        identite: { zone_123: 2, zone_ABC: 'B1' },
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
    // Le prix de revient est desormais ventile : chaque tranche porte son propre
    // taux de livraison a soi-meme, il n'y a plus d'approximation a signaler.
    expect(r.bilan.ventilation.cle_ventilation).toBe('surface_utile');
    expect(Object.keys(r.bilan.par_tranche).sort()).toEqual(['PLAI', 'PLS', 'PLUS']);
    expect(r.alertes.some((a) => /un seul taux de livraison/i.test(a))).toBe(false);
    // Et la somme des tranches vaut exactement le total.
    const somme = Object.values(r.bilan.par_tranche).reduce((s, t) => s + t.total_ttc_lasm_eur, 0);
    expect(somme).toBe(r.bilan.total_ttc_lasm_eur);
  });
});

describe('V4 - les prets CDC theoriques sont calculables sans saisie', () => {
  it('ne leve plus « Duree de pret invalide » quand aucun pret n est saisi', () => {
    const r = calculer({ ...BASE, prets: [] }, REFERENTIELS);
    expect(r.amortissements.length).toBeGreaterThan(0);
    const t = r.amortissements[0].tableau;
    expect(t).toHaveLength(40); // duree PLS construction (R-AMT-1)
    expect(t.at(-1)?.crd_eur).toBeCloseTo(0, 4);
  });

  it('resout taux et durees depuis les cles declaratives de produits.js', () => {
    // Le taux d'un pret CDC n'est plus ecrit dans le code : c'est le Livret A de
    // reference plus la marge du referentiel, cle par cle.
    expect(resoudreTaux('PLS', 0.017, MARGES)).toBeCloseTo(0.0281, 10);
    expect(resoudreTaux('PLAI', 0.017, MARGES)).toBeCloseTo(0.015, 10);
    expect(resoudreTaux('fixe', 0.017, MARGES)).toBe(null);
    expect(resoudreTaux('', 0.017, MARGES)).toBe(null);
    expect(() => resoudreTaux('INCONNU', 0.017, MARGES)).toThrow(/marge de pret/i);
    // Une marge peut arriver en nombre nu : c'est la forme d'une surcharge de
    // simulation, saisie a l'ecran des parametres.
    expect(resoudreTaux('PLS', 0.017, { PLS: 0.02 })).toBeCloseTo(0.037, 10);
    expect(resoudreDuree('40')).toBe(40);
    expect(resoudreDuree('zone_abc:B2|C->50,sinon->60', 'B2')).toBe(50);
    expect(resoudreDuree('zone_abc:B2|C->50,sinon->60', 'B1')).toBe(60);
    expect(() => resoudreDuree('zone_abc:B2|C->50,sinon->60')).toThrow(/zone/i);
  });

  it('expose les prets par defaut d un produit', () => {
    const p = pretsDefautResolus('PLUS', { zone_ABC: 'C', livret_a_reference: 0.017, marges: MARGES });
    expect(p).toHaveLength(2);
    expect(p.find((x) => x.nature === 'construction')?.duree_ans).toBe(40);
    expect(p.find((x) => x.nature === 'foncier')?.duree_ans).toBe(50);
    expect(p[0].taux).toBeCloseTo(0.023, 10); // LA + 0,60
  });
});

describe('V5 - barèmes de loyer des produits', () => {
  it('tous les produits du perimetre V1 resolvent leur bareme', () => {
    for (const p of produitsOrdonnes().filter((x) => x.v1)) {
      expect(
        () => calculer({ ...BASE, identite: { produit: p.code, zone_123: 2, zone_ABC: 'B1' },
          lots: [{ code_produit: p.code, nb_logements: 5, shab_m2: 300 }], prets: [PRET_CDC] }, REFERENTIELS),
        `produit ${p.code}`,
      ).not.toThrow();
    }
  });

  it('LOC/LLI lit desormais le bareme PLI, il ne leve plus', () => {
    // Le produit pointait vers une cle « LLI » qui n'existe pas au bareme : le
    // barreme du logement intermediaire s'y appelle PLI. Defaut V5 corrige.
    const r = calculer(
      {
        ...BASE, identite: { zone_123: 2, zone_ABC: 'B1' },
        lots: [{ code_produit: 'LOC', nb_logements: 5, shab_m2: 300 }], prets: [PRET_CDC],
      },
      REFERENTIELS,
    );
    expect(r.loyers[0].code_produit).toBe('LOC');
    expect(r.loyers[0].loyer_base_eur_m2).toBeGreaterThan(0);
    // Le LLI ne passe pas par le coefficient de structure : loyer de marche.
    expect(r.loyers[0].cs).toBe(1);
  });

  it('R-AMT-1 : le LLI a ses prets par defaut, releves sur l annexe MULHOUSE', () => {
    // LA + 1,40 %, 35 ans en travaux et 40 en foncier.
    const p = pretsDefautResolus('LOC', { zone_ABC: 'B1', livret_a_reference: 0.017, marges: MARGES });
    expect(p).toHaveLength(2);
    expect(p.find((x) => x.nature === 'construction')?.duree_ans).toBe(35);
    expect(p.find((x) => x.nature === 'foncier')?.duree_ans).toBe(40);
    expect(p[0].taux).toBeCloseTo(0.031, 10);
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

describe('saisie lot par lot - la SU ne derive pas', () => {
  it('donne la meme SU de tranche que la saisie agregee', () => {
    // Six lots issus d'une repartition de 400 m2 SHAB et 40 m2 d'annexes.
    // Arrondir la SU lot par lot avant de sommer donnerait 420,02 au lieu de 420.
    const parLot = Array.from({ length: 6 }, (_, i) => ({
      code_produit: 'PLS',
      nb_logements: 1,
      shab_m2: i < 4 ? 66.67 : 66.66,
      surfaces_annexes_m2: i < 4 ? 6.67 : 6.66,
    }));
    const shabTotal = parLot.reduce((s, l) => s + l.shab_m2, 0);
    const annexesTotal = parLot.reduce((s, l) => s + l.surfaces_annexes_m2, 0);

    const enLots = calculer({ ...BASE, lots: parLot, prets: [PRET_CDC] }, REFERENTIELS);
    const agrege = calculer(
      {
        ...BASE,
        lots: [{ code_produit: 'PLS', nb_logements: 6, shab_m2: shabTotal, surfaces_annexes_m2: annexesTotal }],
        prets: [PRET_CDC],
      },
      REFERENTIELS,
    );

    expect(enLots.indicateurs.su_m2).toBe(agrege.indicateurs.su_m2);
    expect(enLots.indicateurs.nb_logements).toBe(6);
    // Meme coefficient de structure, donc meme loyer : le decoupage en lots est
    // une commodite de saisie et n'influe sur aucun calcul.
    expect(enLots.loyers[0].cs).toBe(agrege.loyers[0].cs);
    expect(enLots.loyers[0].loyer_annuel_eur).toBe(agrege.loyers[0].loyer_annuel_eur);
  });

  it('signale des parametres de loyer divergents entre lots d une meme tranche', () => {
    const r = calculer(
      {
        ...BASE,
        lots: [
          { code_produit: 'PLS', nb_logements: 1, shab_m2: 60, marge_locale_eur_m2: 1 },
          { code_produit: 'PLS', nb_logements: 1, shab_m2: 60, marge_locale_eur_m2: 2 },
        ],
        prets: [PRET_CDC],
      },
      REFERENTIELS,
    );
    expect(r.alertes.some((a) => /plusieurs valeurs de marge_locale/i.test(a))).toBe(true);
  });

  it('prend les parametres de loyer au niveau de la tranche quand ils y sont', () => {
    const sans = calculer({ ...BASE, prets: [PRET_CDC] }, REFERENTIELS);
    const avec = calculer(
      { ...BASE, prets: [PRET_CDC], loyers_par_produit: { PLS: { marge_majoration: 0.05 } } },
      REFERENTIELS,
    );
    expect(avec.loyers[0].loyer_pratique_eur_m2).toBeGreaterThan(sans.loyers[0].loyer_pratique_eur_m2);
    expect(avec.alertes.some((a) => /plusieurs valeurs/i.test(a))).toBe(false);
  });

  it('totalise les fonds propres saisis par tranche', () => {
    const r = calculer(
      { ...BASE, prets: [PRET_CDC], fonds_propres_par_produit: { PLS: 30000, PLAI: 20000 } },
      REFERENTIELS,
    );
    expect(r.indicateurs.fonds_propres_eur).toBe(50000);
  });
});

describe('Pas de produit principal : chaque financement a ses propres regles', () => {
  /** Operation mixte PLUS + PLAI, sans aucun pret saisi : mode CDC theorique. */
  const mixte = (entrees = {}) =>
    calculer(
      {
        identite: { zone_123: 2, zone_ABC: 'B1' },
        dates: { annee_mise_en_location: 2028, duree_simulation_ans: 20 },
        lots: [
          { code_produit: 'PLUS', nb_logements: 6, shab_m2: 400, surfaces_annexes_m2: 40 },
          { code_produit: 'PLAI', nb_logements: 4, shab_m2: 240, surfaces_annexes_m2: 24 },
        ],
        postes_bilan: [
          { chapitre: 'charge_fonciere', libelle: 'Terrain', montant_ht_eur: 300000, taux_tva: 0.2 },
          { chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 1200000, taux_tva: 0.2 },
        ],
        subventions: [{ libelle: 'Subvention', montant_eur: 80000 }],
        fonds_propres_eur: 120000,
        ...entrees,
      },
      { baremes, trajectoires: fichierTrajectoires },
    );

  it('donne a CHAQUE tranche son jeu de prets CDC, foncier et construction', () => {
    const a = mixte().amortissements;
    expect(a).toHaveLength(4);
    for (const code of ['PLUS', 'PLAI']) {
      const natures = a.filter((x) => x.produit === code).map((x) => x.nature).sort();
      expect(natures, code).toEqual(['construction', 'foncier']);
    }
  });

  it('applique a chaque tranche SON taux : un PLUS et un PLAI n empruntent pas pareil', () => {
    const a = mixte().amortissements;
    const taux = (code) => a.find((x) => x.produit === code && x.nature === 'foncier').taux_saisi;
    // PLUS = LA + 0,6 % ; PLAI = LA - 0,2 %. L'ecart de 0,8 point est la regle
    // du produit, il ne doit jamais etre lisse par un « produit principal ».
    expect(taux('PLUS') - taux('PLAI')).toBeCloseTo(0.008, 10);
  });

  it('repartit l enveloppe theorique sans en perdre ni en creer un euro', () => {
    const r = mixte();
    const t = r.financement.prets_cdc_theoriques;
    const somme = r.amortissements.reduce((s, x) => s + x.montant_eur, 0);
    expect(somme).toBeCloseTo(t.pret_foncier_eur + t.pret_batiment_eur, 2);
    // Et chaque nature separement, sinon la repartition compenserait une erreur
    // de foncier par une erreur de construction.
    const parNature = (n) =>
      r.amortissements.filter((x) => x.nature === n).reduce((s, x) => s + x.montant_eur, 0);
    expect(parNature('foncier')).toBeCloseTo(t.pret_foncier_eur, 2);
    expect(parNature('construction')).toBeCloseTo(t.pret_batiment_eur, 2);
  });

  it('repartit au prorata de surface utile, comme le prix de revient', () => {
    const r = mixte();
    const t = r.financement.prets_cdc_theoriques;
    const foncierPLUS = r.amortissements.find((x) => x.produit === 'PLUS' && x.nature === 'foncier');
    const qp = r.surfaces.quotes_parts.PLUS;
    expect(foncierPLUS.montant_eur / t.pret_foncier_eur).toBeCloseTo(qp, 3);
  });

  it('porte le taux de TVA de chaque tranche, pas un taux unique', () => {
    const r = mixte();
    // Les deux tranches lisent leur propre cle au bareme : la structure doit
    // exister meme quand les deux valeurs coincident.
    expect(Object.keys(r.bilan.taux_lasm_par_tranche).sort()).toEqual(['PLAI', 'PLUS']);
  });

  it('ne lit AUCUN produit sur l identite, meme si un ancien appel en passe un', () => {
    // La notion a disparu du moteur. Ce test garde la porte fermee : un
    // `identite.produit` residuel, venu d'une fixture ou d'un appel plus ancien,
    // ne doit rien piloter, ni la TVA, ni les prets, ni les loyers.
    const sans = mixte();
    const avec = mixte({ identite: { zone_123: 2, zone_ABC: 'B1', produit: 'PLS' } });
    expect(avec.indicateurs.prix_revient_ttc_eur).toBe(sans.indicateurs.prix_revient_ttc_eur);
    expect(avec.bilan.taux_lasm_par_tranche).toEqual(sans.bilan.taux_lasm_par_tranche);
    expect(avec.amortissements.map((a) => `${a.produit}:${a.montant_eur}:${a.taux_saisi}`)).toEqual(
      sans.amortissements.map((a) => `${a.produit}:${a.montant_eur}:${a.taux_saisi}`),
    );
    expect(avec.alertes).toEqual(sans.alertes);
  });
});

describe('R-TVA-3 - prix de revient saisi par tranche', () => {
  const SU = { PLAI: 300, PLS: 700 };

  it('ventile au prorata SU en l absence de saisie par tranche', () => {
    const v = prixDeRevientVentile(
      { postes: [{ chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 1000, taux_tva: 0.1 }], su_par_produit: SU },
      baremes,
    );
    expect(v.postes[0].par_tranche.PLAI.ht_eur).toBeCloseTo(300, 6);
    expect(v.postes[0].par_tranche.PLS.ht_eur).toBeCloseTo(700, 6);
    expect(v.postes[0].ventile_a_la_main).toBe(false);
  });

  it('respecte une repartition saisie a la main, meme contraire aux surfaces', () => {
    const v = prixDeRevientVentile(
      {
        postes: [
          {
            chapitre: 'batiment', libelle: 'Ascenseur bâtiment A', taux_tva: 0.1,
            // Depense qui ne concerne QUE le PLAI : le prorata SU la repartirait
            // a tort sur les deux tranches.
            montants_ht_par_produit: { PLAI: 40000, PLS: 0 },
          },
        ],
        su_par_produit: SU,
      },
      baremes,
    );
    const p = v.postes[0];
    expect(p.ventile_a_la_main).toBe(true);
    expect(p.ht_eur).toBe(40000);
    expect(p.par_tranche.PLAI.ht_eur).toBe(40000);
    expect(p.par_tranche.PLS.ht_eur).toBe(0);
    // La part affichee est celle REELLEMENT appliquee, pas la cle de l'operation.
    expect(p.par_tranche.PLAI.part).toBe(1);
    expect(p.par_tranche.PLS.part).toBe(0);
  });

  it('applique un taux de TVA propre a chaque tranche', () => {
    const v = prixDeRevientVentile(
      {
        postes: [
          {
            chapitre: 'batiment', libelle: 'Travaux', taux_tva: 0.1,
            montants_ht_par_produit: { PLAI: 1000, PLS: 1000 },
            taux_tva_par_produit: { PLAI: 0.055 },
          },
        ],
        su_par_produit: SU,
      },
      baremes,
    );
    expect(v.postes[0].par_tranche.PLAI.tva_eur).toBeCloseTo(55, 6);
    // Tranche sans surcharge : le taux de la ligne s'applique.
    expect(v.postes[0].par_tranche.PLS.tva_eur).toBeCloseTo(100, 6);
    expect(v.total_tva_eur).toBe(155);
  });

  it('recompose la TVA de la LIGNE depuis ses tranches, pas au taux global', () => {
    // Defaut constate a l'ecran : la colonne « TVA (EUR) » d'une ligne ventilee
    // affichait total x taux_global, soit 2000 x 10 % = 200, quand la somme
    // reellement due valait 155. La ligne contredisait le pied de table.
    const v = prixDeRevientVentile(
      {
        postes: [
          {
            id: 'travaux', chapitre: 'batiment', libelle: 'Travaux', taux_tva: 0.1,
            montants_ht_par_produit: { PLAI: 1000, PLS: 1000 },
            taux_tva_par_produit: { PLAI: 0.055 },
          },
        ],
        su_par_produit: SU,
      },
      baremes,
    );
    expect(v.postes[0].tva_eur).toBe(155);
    expect(v.postes[0].tva_eur).toBe(v.total_tva_eur);
    expect(v.postes[0].ttc_eur).toBe(2155);
  });

  it('melange les deux modes de saisie dans une meme operation', () => {
    const v = prixDeRevientVentile(
      {
        postes: [
          { chapitre: 'charge_fonciere', libelle: 'Terrain', montant_ht_eur: 1000, taux_tva: 0 },
          { chapitre: 'batiment', libelle: 'Ascenseur', taux_tva: 0, montants_ht_par_produit: { PLAI: 0, PLS: 500 } },
        ],
        su_par_produit: SU,
      },
      baremes,
    );
    expect(v.par_tranche.PLAI.total_ht_eur).toBe(300);
    expect(v.par_tranche.PLS.total_ht_eur).toBe(1200);
    expect(v.total_ht_eur).toBe(1500);
  });

  it('fait FOI sur le total : un montant global concurrent est ignore', () => {
    // Deux verites pour la meme grandeur, c'est une de trop. La saisie par
    // tranche etant la plus fine, c'est elle qui gagne.
    const v = prixDeRevientVentile(
      {
        postes: [
          {
            chapitre: 'batiment', libelle: 'Travaux', taux_tva: 0,
            montant_ht_eur: 999999,
            montants_ht_par_produit: { PLAI: 100, PLS: 200 },
          },
        ],
        su_par_produit: SU,
      },
      baremes,
    );
    expect(v.postes[0].ht_eur).toBe(300);
    expect(v.total_ht_eur).toBe(300);
  });

  it('conserve la somme malgre les arrondis par tranche', () => {
    const v = prixDeRevientVentile(
      {
        postes: [{ chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 1000.01, taux_tva: 0.1 }],
        // Trois tranches egales sur un montant non divisible par trois : le
        // reliquat de centimes doit atterrir quelque part, pas disparaitre.
        su_par_produit: { PLAI: 1, PLUS: 1, PLS: 1 },
      },
      baremes,
    );
    const somme = ['PLAI', 'PLUS', 'PLS'].reduce((s, c) => s + v.par_tranche[c].total_ht_eur, 0);
    expect(somme).toBe(v.total_ht_eur);
    expect(v.total_ht_eur).toBe(1000);
  });
});

describe('R-TVA-3 - sous-totaux de chapitre par tranche', () => {
  const v = () =>
    prixDeRevientVentile(
      {
        postes: [
          { chapitre: 'charge_fonciere', libelle: 'Terrain', montant_ht_eur: 642780, taux_tva: 0.055 },
          { chapitre: 'charge_fonciere', libelle: 'Notaire', montant_ht_eur: 12000, taux_tva: 0.055 },
          { chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 1100000, taux_tva: 0.1 },
        ],
        su_par_produit: { PLAI: 252, PLS: 420 },
      },
      baremes,
    );

  it('croise chaque chapitre avec chaque tranche', () => {
    const ch = v().chapitres.charge_fonciere;
    expect(Object.keys(ch.par_tranche).sort()).toEqual(['PLAI', 'PLS']);
    expect(ch.par_tranche.PLAI.ht_eur).toBeGreaterThan(0);
  });

  it('la LIGNE de sous-total s additionne exactement, c est elle qu on lit', () => {
    // La somme des cellules de tranche doit valoir le sous-total affiche du
    // chapitre. Un ecart d un euro se voit immediatement sur une seule ligne.
    for (const [nom, ch] of Object.entries(v().chapitres)) {
      const somme = Object.values(ch.par_tranche).reduce((s, t) => s + t.ht_eur, 0);
      expect(somme, `${nom} HT`).toBe(ch.ht_eur);
      const sommeTva = Object.values(ch.par_tranche).reduce((s, t) => s + t.tva_eur, 0);
      expect(sommeTva, `${nom} TVA`).toBe(ch.tva_eur);
      const sommeTtc = Object.values(ch.par_tranche).reduce((s, t) => s + t.ttc_eur, 0);
      expect(sommeTtc, `${nom} TTC`).toBe(ch.ttc_eur);
    }
  });

  it('respecte la ventilation manuelle d une ligne dans le sous-total', () => {
    const r = prixDeRevientVentile(
      {
        postes: [
          { chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 1000, taux_tva: 0 },
          { chapitre: 'batiment', libelle: 'Ascenseur A', taux_tva: 0, montants_ht_par_produit: { PLAI: 500, PLS: 0 } },
        ],
        su_par_produit: { PLAI: 500, PLS: 500 },
      },
      baremes,
    );
    const ch = r.chapitres.batiment;
    // 500 (moitie des travaux) + 500 (ascenseur entier) contre 500 seulement.
    expect(ch.par_tranche.PLAI.ht_eur).toBe(1000);
    expect(ch.par_tranche.PLS.ht_eur).toBe(500);
    expect(ch.ht_eur).toBe(1500);
  });
});

describe('arrondirEnConservantLaSomme - total impose', () => {
  it('atteint exactement un total impose different de l arrondi naturel', () => {
    // Somme exacte 10, mais le total a respecter vaut 11 : c'est le cas quand
    // le sous-total a deja ete ajuste pour boucler sur le prix de revient.
    const parts = arrondirEnConservantLaSomme([3.33, 3.33, 3.34], 11);
    expect(parts.reduce((s, v) => s + v, 0)).toBe(11);
  });

  it('sans total impose, garde le comportement d origine', () => {
    const parts = arrondirEnConservantLaSomme([3.33, 3.33, 3.34]);
    expect(parts.reduce((s, v) => s + v, 0)).toBe(10);
  });
});

describe('Q-27 - la vacance en transparence est signalee, pas subie en silence', () => {
  const foyer = (exploitation) =>
    calculer(
      {
        identite: { zone_123: 2, zone_ABC: 'B1' },
        dates: { annee_mise_en_location: 2028, duree_simulation_ans: 5 },
        lots: [{ code_produit: 'PLAI', nb_logements: 44, shab_m2: 1500 }],
        postes_bilan: [{ chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 1000000, taux_tva: 0.1 }],
        fonds_propres_eur: 100000,
        exploitation: { mode: 'redevance', mode_redevance: 'transparence', ...exploitation },
      },
      REFERENTIELS,
    );

  it('sans vacance, la redevance couvre exactement les charges', () => {
    const r = foyer({ annuite_fonds_propres_eur: 4000 });
    for (const l of r.exploitation.lignes) {
      expect(l.redevance_eur, `année ${l.annee}`).toBe(l.total_charges_eur);
      expect(l.resultat_eur, `année ${l.annee}`).toBe(0);
    }
    expect(r.alertes.some((a) => /transparence/.test(a))).toBe(false);
  });

  it('avec vacance, le deficit permanent est annonce', () => {
    const r = foyer({ annuite_fonds_propres_eur: 4000, taux_vacance_impayes: 0.02 });
    // Le deficit vaut exactement le taux de vacance applique a la redevance.
    const l = r.exploitation.lignes[0];
    expect(l.resultat_eur).toBeLessThan(0);
    expect(Math.abs(l.resultat_eur)).toBe(Math.round(l.redevance_eur * 0.02));
    expect(r.alertes.some((a) => /transparence/.test(a) && /vacance/.test(a))).toBe(true);
  });

  it('le mode forfaitaire ne declenche pas cette alerte', () => {
    const r = foyer({
      mode_redevance: 'forfaitaire', redevance_annuelle_eur: 200000, taux_vacance_impayes: 0.02,
    });
    expect(r.alertes.some((a) => /transparence/.test(a))).toBe(false);
  });
});

describe('R-FIN-3 - prets CDC par tranche, ajustes au besoin de financement', () => {
  const op = (surcharges = {}) => ({
    identite: { zone_123: 2, zone_ABC: 'B1' },
    dates: { annee_mise_en_location: 2028, duree_simulation_ans: 20 },
    lots: [
      { code_produit: 'PLUS', nb_logements: 6, shab_m2: 400, surfaces_annexes_m2: 40 },
      { code_produit: 'PLAI', nb_logements: 4, shab_m2: 240, surfaces_annexes_m2: 24 },
    ],
    postes_bilan: [
      { chapitre: 'charge_fonciere', libelle: 'Terrain', montant_ht_eur: 400000, taux_tva: 0.055 },
      { chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 1200000, taux_tva: 0.1 },
    ],
    subventions: [{ libelle: 'État', montant_eur: 80000, affectation: 'PLAI' }],
    fonds_propres_par_produit: { PLUS: 50000, PLAI: 20000 },
    ...surcharges,
  });
  const calc = (s) => calculer(op(s), REFERENTIELS);
  const pret = (r, produit, nature) =>
    r.amortissements.find((a) => a.produit === produit && a.nature === nature);

  it('dote chaque tranche d un pret foncier et d un pret construction, sans rien saisir', () => {
    const r = calc();
    expect(r.amortissements).toHaveLength(4);
    for (const c of ['PLUS', 'PLAI']) {
      expect(pret(r, c, 'foncier'), `${c} foncier`).toBeDefined();
      expect(pret(r, c, 'construction'), `${c} construction`).toBeDefined();
      expect(pret(r, c, 'foncier').montant_calcule).toBe(true);
    }
  });

  it('equilibre le plan par construction', () => {
    expect(calc().financement.equilibre.ecart_eur).toBe(0);
  });

  it('recalcule les prets d une tranche quand SES fonds propres bougent, et elle seule', () => {
    const avant = calc();
    const apres = calc({ fonds_propres_par_produit: { PLUS: 200000, PLAI: 20000 } });
    // 150 000 EUR de fonds propres en plus : autant de pret en moins sur PLUS.
    const dPLUS =
      pret(avant, 'PLUS', 'foncier').montant_eur + pret(avant, 'PLUS', 'construction').montant_eur -
      (pret(apres, 'PLUS', 'foncier').montant_eur + pret(apres, 'PLUS', 'construction').montant_eur);
    expect(dPLUS).toBe(150000);
    // La tranche PLAI n'a pas bouge d'un euro.
    expect(pret(apres, 'PLAI', 'construction').montant_eur).toBe(pret(avant, 'PLAI', 'construction').montant_eur);
    expect(apres.financement.equilibre.ecart_eur).toBe(0);
  });

  it('recalcule aussi quand une subvention de tranche bouge', () => {
    const avant = calc();
    const apres = calc({ subventions: [{ libelle: 'État', montant_eur: 130000, affectation: 'PLAI' }] });
    const dPLAI =
      pret(avant, 'PLAI', 'foncier').montant_eur + pret(avant, 'PLAI', 'construction').montant_eur -
      (pret(apres, 'PLAI', 'foncier').montant_eur + pret(apres, 'PLAI', 'construction').montant_eur);
    expect(dPLAI).toBe(50000);
  });

  it('ventile une subvention NON affectee, au lieu de la perdre', () => {
    // Une subvention sans tranche profite a l'operation entiere. L'oublier
    // ferait emprunter un montant deja finance.
    const sans = calc({ subventions: [] });
    const avec = calc({ subventions: [{ libelle: 'Agglo', montant_eur: 100000 }] });
    const total = (r) => r.amortissements.reduce((s, a) => s + a.montant_eur, 0);
    expect(total(sans) - total(avec)).toBe(100000);
    expect(avec.financement.equilibre.ecart_eur).toBe(0);
  });

  it('un montant saisi FIGE le pret et sort du calcul automatique', () => {
    const r = calc({
      prets: [
        { code: 'F_PLUS', libelle: 'CDC foncier PLUS', nature: 'foncier', produit: 'PLUS', montant_auto: true },
        { code: 'B_PLUS', libelle: 'CDC construction PLUS', nature: 'construction', produit: 'PLUS', montant_eur: 500000 },
        { code: 'F_PLAI', libelle: 'CDC foncier PLAI', nature: 'foncier', produit: 'PLAI', montant_auto: true },
        { code: 'B_PLAI', libelle: 'CDC construction PLAI', nature: 'construction', produit: 'PLAI', montant_auto: true },
      ],
    });
    const force = r.amortissements.find((a) => a.code === 'B_PLUS');
    expect(force.montant_eur).toBe(500000);
    expect(force.montant_calcule).toBe(false);
    // Les autres restent calcules.
    expect(r.amortissements.find((a) => a.code === 'F_PLAI').montant_calcule).toBe(true);
  });

  it('plafonne le pret foncier a la charge fonciere financable de la tranche', () => {
    const r = calc();
    for (const c of ['PLUS', 'PLAI']) {
      const foncier = pret(r, c, 'foncier').montant_eur;
      const chargeFonciere = r.bilan.chapitres.charge_fonciere.par_tranche[c].ttc_lasm_eur;
      expect(foncier, `${c}`).toBeLessThanOrEqual(chargeFonciere);
    }
  });

  it('n invente pas de pret quand la tranche est deja financee', () => {
    // Fonds propres superieurs au prix de revient : le besoin est nul, pas negatif.
    const r = calc({ fonds_propres_par_produit: { PLUS: 5000000, PLAI: 5000000 } });
    expect(r.amortissements.every((a) => a.montant_eur === 0 || a.nature === 'autre')).toBe(true);
    expect(r.alertes.some((a) => /Surfinancement/i.test(a))).toBe(true);
  });
});

describe('R-FIN-2 - assiette CDC du droit a pret foncier (Q-30, arbitrage 06/08/2026)', () => {
  const op = (subventions) => ({
    identite: { zone_123: 2, zone_ABC: 'B1' },
    dates: { annee_mise_en_location: 2028, duree_simulation_ans: 20 },
    lots: [
      { code_produit: 'PLUS', nb_logements: 6, shab_m2: 400, surfaces_annexes_m2: 40 },
      { code_produit: 'PLAI', nb_logements: 4, shab_m2: 240, surfaces_annexes_m2: 24 },
    ],
    postes_bilan: [
      { chapitre: 'charge_fonciere', libelle: 'Terrain', montant_ht_eur: 900000, taux_tva: 0.055 },
      { chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 900000, taux_tva: 0.1 },
    ],
    subventions,
    fonds_propres_par_produit: { PLUS: 20000, PLAI: 10000 },
  });
  const calc = (s) => calculer(op(s), REFERENTIELS);
  const foncier = (r) =>
    r.amortissements.filter((a) => a.nature === 'foncier').reduce((s, a) => s + a.montant_eur, 0);

  it('une subvention NON gratuite reduit le droit a pret foncier', () => {
    // Sous la regle LEON, seules les subventions gratuites comptaient : le
    // foncier n'aurait pas bouge. La CDC ne fait pas cette distinction.
    const sans = calc([]);
    const avec = calc([{ libelle: 'Département', montant_eur: 200000, gratuite: false }]);
    expect(foncier(avec)).toBeLessThan(foncier(sans));
  });

  it('gratuite ou non, une subvention du meme montant a le meme effet', () => {
    const g = calc([{ libelle: 'A', montant_eur: 200000, gratuite: true }]);
    const ng = calc([{ libelle: 'A', montant_eur: 200000, gratuite: false }]);
    expect(foncier(ng)).toBe(foncier(g));
  });

  it('une subvention flechee sur UNE tranche reduit le droit de TOUTE l operation', () => {
    // Le droit a pret foncier se calcule globalement puis se repartit au prorata
    // SU (calculette CDC, AT37 puis M49) : flecher ne concentre pas l effet.
    const flechee = calc([{ libelle: 'A', montant_eur: 200000, affectation: 'PLAI' }]);
    const globale = calc([{ libelle: 'A', montant_eur: 200000 }]);
    expect(foncier(flechee)).toBe(foncier(globale));
  });

  it('foncier et construction d une tranche somment exactement au besoin', () => {
    // Arrondir les deux separement laissait fuir un euro, le reste etant
    // calcule sur un foncier non arrondi.
    const r = calc([{ libelle: 'A', montant_eur: 123457, affectation: 'PLAI' }]);
    expect(r.financement.equilibre.ecart_eur).toBe(0);
    for (const c of ['PLUS', 'PLAI']) {
      const somme = r.amortissements
        .filter((a) => a.produit === c)
        .reduce((s, a) => s + a.montant_eur, 0);
      expect(Number.isInteger(somme), `${c} : ${somme}`).toBe(true);
    }
  });
});

describe('R-FIN-7 - remuneration et reconstitution des fonds propres', () => {
  // Les QUATRE combinaisons existent : l'annexe MULHOUSE 3308 les porte toutes
  // dans une seule operation (PLS remunere et reconstitue, CD remunere seul,
  // LIB reconstitue seul, PLUS ni l'un ni l'autre).
  const op = (regime) => ({
    identite: { zone_123: 2, zone_ABC: 'B1' },
    dates: { annee_mise_en_location: 2028, duree_simulation_ans: 40 },
    lots: [{ code_produit: 'PLS', nb_logements: 6, shab_m2: 400, surfaces_annexes_m2: 40 }],
    postes_bilan: [{ chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 1000000, taux_tva: 0.1 }],
    fonds_propres_par_produit: { PLS: 300000 },
    remuneration_fonds_propres: { PLS: regime },
  });
  const calc = (regime) => calculer(op(regime), REFERENTIELS);
  const charge = (r, annee) => r.exploitation.lignes.find((l) => l.annee === annee).annuite_fonds_propres_eur;

  it('ni remuneres ni reconstitues : aucune charge', () => {
    const r = calc({});
    expect(charge(r, 2028)).toBe(0);
    expect(r.exploitation.fonds_propres_par_tranche.PLS.remuneres).toBe(false);
    expect(r.exploitation.fonds_propres_par_tranche.PLS.reconstitues).toBe(false);
  });

  it('REMUNERES SEULEMENT : interets servis, capital jamais rendu', () => {
    // Cas du produit CD de l'annexe : un taux, pas de duree.
    const r = calc({ remuneres: true, taux: 0.025 });
    expect(charge(r, 2028)).toBe(7500); // 300 000 x 2,5 %
    // La charge ne s'arrete jamais : le capital reste dans l'operation.
    expect(charge(r, 2067)).toBe(7500);
    const fp = r.exploitation.fonds_propres_par_tranche.PLS;
    expect(fp.remuneres).toBe(true);
    expect(fp.reconstitues).toBe(false);
  });

  it('RECONSTITUES SEULEMENT : capital rendu, sans remuneration', () => {
    // Cas du produit LIB de l'annexe : une duree, pas de taux.
    const r = calc({ reconstitues: true, duree_reconstitution_ans: 30 });
    expect(charge(r, 2028)).toBe(10000); // 300 000 / 30
    expect(charge(r, 2057)).toBe(10000); // 30e annee
    expect(charge(r, 2058)).toBe(0); // capital rendu
    const fp = r.exploitation.fonds_propres_par_tranche.PLS;
    expect(fp.remuneres).toBe(false);
    expect(fp.reconstitues).toBe(true);
  });

  it('LES DEUX : annuite d amortissement classique, qui s arrete au terme', () => {
    const r = calc({ remuneres: true, taux: 0.025, reconstitues: true, duree_reconstitution_ans: 30 });
    const attendu = Math.round((300000 * 0.025) / (1 - 1.025 ** -30));
    expect(charge(r, 2028)).toBe(attendu); // 14 333 EUR
    expect(charge(r, 2057)).toBe(attendu);
    expect(charge(r, 2058)).toBe(0);
    // Elle est bien SUPERIEURE aux interets seuls et au capital seul.
    expect(attendu).toBeGreaterThan(7500);
    expect(attendu).toBeGreaterThan(10000);
  });

  it('deux tranches de regimes differents cohabitent, chacune avec SA duree', () => {
    // C'est ce cas qui interdit un scalaire assorti d'une duree unique : l'une
    // sert des interets a perpetuite, l'autre rembourse sur trente ans.
    const r = calculer(
      {
        ...op({}),
        lots: [
          { code_produit: 'PLS', nb_logements: 6, shab_m2: 400 },
          { code_produit: 'PLAI', nb_logements: 4, shab_m2: 240 },
        ],
        fonds_propres_par_produit: { PLS: 300000, PLAI: 300000 },
        remuneration_fonds_propres: {
          PLS: { remuneres: true, taux: 0.025 },
          PLAI: { reconstitues: true, duree_reconstitution_ans: 30 },
        },
      },
      REFERENTIELS,
    );
    expect(charge(r, 2028)).toBe(7500 + 10000);
    // Au-dela de trente ans, seul le PLS continue de peser.
    expect(charge(r, 2058)).toBe(7500);
  });

  it('la charge pese sur le resultat sans toucher au plan de financement', () => {
    const sans = calc({});
    const avec = calc({ remuneres: true, taux: 0.025, reconstitues: true, duree_reconstitution_ans: 30 });
    expect(sans.exploitation.lignes[0].resultat_eur - avec.exploitation.lignes[0].resultat_eur)
      .toBe(charge(avec, 2028));
    expect(avec.financement.equilibre.ressources_eur).toBe(sans.financement.equilibre.ressources_eur);
    expect(avec.amortissements.map((a) => a.montant_eur)).toEqual(
      sans.amortissements.map((a) => a.montant_eur),
    );
  });

  it('la remuneration des fonds propres sort des postes non modelises', () => {
    expect(calc({}).exploitation.postes_absents.some((p) => /fonds propres/i.test(p))).toBe(false);
  });
});

describe('R-FIN-8 - scission PLS / CPLS (calculette CDC)', () => {
  it('laisse le PLS intact dans la fourchette 51-55 %', () => {
    const s = scinderPLS({ montant_pls_eur: 530000, prix_revient_eur: 1000000 });
    expect(s.pls_eur).toBe(530000);
    expect(s.cpls_eur).toBe(0);
    expect(s.sous_plancher).toBe(false);
  });

  it('bascule en CPLS ce qui depasse 55 %', () => {
    const s = scinderPLS({ montant_pls_eur: 800000, prix_revient_eur: 1000000 });
    expect(s.pls_eur).toBe(550000);
    expect(s.cpls_eur).toBe(250000);
    expect(s.pls_eur + s.cpls_eur).toBe(800000); // rien ne se perd
    expect(s.part_pls).toBeCloseTo(0.55, 10);
  });

  it('signale un PLS sous le plancher de 51 % sans y toucher', () => {
    // Un PLS trop faible releve du montage, pas du calcul : on le dit, on ne le
    // gonfle pas.
    const s = scinderPLS({ montant_pls_eur: 400000, prix_revient_eur: 1000000 });
    expect(s.pls_eur).toBe(400000);
    expect(s.cpls_eur).toBe(0);
    expect(s.sous_plancher).toBe(true);
  });

  it('cree une ligne CPLS dans le plan et alerte', () => {
    const r = calculer(
      {
        identite: { zone_123: 2, zone_ABC: 'B1' },
        dates: { annee_mise_en_location: 2028, duree_simulation_ans: 20 },
        lots: [{ code_produit: 'PLS', nb_logements: 10, shab_m2: 700 }],
        postes_bilan: [{ chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 1000000, taux_tva: 0.1 }],
        fonds_propres_par_produit: { PLS: 10000 },
      },
      REFERENTIELS,
    );
    const cpls = r.amortissements.find((a) => a.code === 'CPLS');
    expect(cpls).toBeDefined();
    const pls = r.amortissements.filter((a) => a.produit === 'PLS' && a.code !== 'CPLS');
    const pr = r.bilan.par_tranche.PLS.total_ttc_module_eur;
    // Le PLS restant ne depasse plus 55 % du prix de revient de sa tranche.
    expect(pls.reduce((s, a) => s + a.montant_eur, 0)).toBeLessThanOrEqual(Math.round(pr * 0.55) + 1);
    expect(r.alertes.some((a) => /CPLS/.test(a))).toBe(true);
    // Et le plan reste equilibre : le CPLS n'est pas une ressource en plus.
    expect(r.financement.equilibre.ecart_eur).toBe(0);
  });
});

describe('R-FIN-9 - plafond de financement du LLI a 90 %', () => {
  it('ne signale rien sous le plafond', () => {
    const c = plafondPretsLLI({ total_prets_eur: 850000, prix_revient_eur: 1000000 });
    expect(c.depassement_eur).toBe(0);
    expect(c.plafond_eur).toBe(900000);
  });

  it('chiffre le depassement au-dela de 90 %', () => {
    const c = plafondPretsLLI({ total_prets_eur: 950000, prix_revient_eur: 1000000 });
    expect(c.depassement_eur).toBe(50000);
    expect(c.part).toBeCloseTo(0.95, 10);
  });

  it('alerte sur une operation LLI sans fonds propres suffisants', () => {
    const r = calculer(
      {
        identite: { zone_123: 2, zone_ABC: 'B1' },
        dates: { annee_mise_en_location: 2028, duree_simulation_ans: 20 },
        lots: [{ code_produit: 'LOC', nb_logements: 10, shab_m2: 700 }],
        postes_bilan: [{ chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 1000000, taux_tva: 0.1 }],
        fonds_propres_par_produit: { LOC: 1000 },
      },
      REFERENTIELS,
    );
    expect(r.alertes.some((a) => /90 %/.test(a) && /LLI/.test(a))).toBe(true);
  });
});

describe('R-FISC-1 - duree d exoneration de TFPB par produit (Q-14 close)', () => {
  const op = (lots) => ({
    identite: { zone_123: 2, zone_ABC: 'B1' },
    dates: { annee_mise_en_location: 2028, duree_simulation_ans: 40 },
    lots,
    postes_bilan: [{ chapitre: 'batiment', libelle: 'Travaux', montant_ht_eur: 1000000, taux_tva: 0.1 }],
    fonds_propres_par_produit: {},
  });

  it('25 ans en logement social, 20 en intermediaire, 0 en libre', () => {
    const r = calculer(
      op([
        { code_produit: 'PLUS', nb_logements: 5, shab_m2: 350 },
        { code_produit: 'LOC', nb_logements: 5, shab_m2: 350 },
      ]),
      REFERENTIELS,
    );
    expect(r.fiscalite.tfpb.par_tranche.PLUS.duree_exoneration_ans).toBe(25);
    expect(r.fiscalite.tfpb.par_tranche.LOC.duree_exoneration_ans).toBe(20);
  });

  it('chaque tranche sort d exoneration a SA date', () => {
    const r = calculer(
      op([
        { code_produit: 'PLUS', nb_logements: 5, shab_m2: 350 },
        { code_produit: 'LOC', nb_logements: 5, shab_m2: 350 },
      ]),
      REFERENTIELS,
    );
    const tfpb = (annee) => r.exploitation.lignes.find((l) => l.annee === annee).tfpb_eur;
    expect(tfpb(2047)).toBe(0); // 19e annee : les deux exonerees
    expect(tfpb(2048)).toBeGreaterThan(0); // 20e : le LLI entre
    const auLLI = tfpb(2048);
    expect(tfpb(2053)).toBeGreaterThan(auLLI); // 25e : le PLUS s'ajoute
  });

  it('une duree posee sur la simulation prime sur celle du produit', () => {
    const r = calculer(
      { ...op([{ code_produit: 'PLUS', nb_logements: 5, shab_m2: 350 }]), options: { duree_exoneration_tfpb_ans: 15 } },
      REFERENTIELS,
    );
    expect(r.fiscalite.tfpb.par_tranche.PLUS.duree_exoneration_ans).toBe(15);
    expect(r.indicateurs.annee_debut_tfpb).toBe(2043);
  });
});

describe('R-FIN-8 - la scission PLS ne cree jamais de pret negatif', () => {
  // Defaut constate a l'ecran : sur une operation a forte charge fonciere, le
  // foncier absorbait tout le besoin et la construction restait a zero.
  // Retirer l'exces du seul pret construction le rendait NEGATIF (-263 026 EUR).
  // Le test precedent ne regardait que le total, qui lui restait juste.
  const forteChargeFonciere = {
    identite: { zone_123: 2, zone_ABC: 'B1' },
    dates: { annee_mise_en_location: 2028, duree_simulation_ans: 20 },
    lots: [{ code_produit: 'PLS', nb_logements: 6, shab_m2: 400, surfaces_annexes_m2: 40 }],
    postes_bilan: [
      { chapitre: 'charge_fonciere', libelle: 'Terrain', montant_ht_eur: 650000, taux_tva: 0.055 },
      { chapitre: 'honoraires', libelle: 'Honoraires', montant_ht_eur: 18000, taux_tva: 0.2 },
    ],
    subventions: [{ libelle: 'Ville', montant_eur: 20000, affectation: 'PLS' }],
    fonds_propres_par_produit: { PLS: 50000 },
  };

  const r = calculer(forteChargeFonciere, REFERENTIELS);

  it('AUCUN pret n a un montant negatif', () => {
    for (const a of r.financement.prets_resolus) {
      expect(a.montant_eur, `${a.libelle} : ${a.montant_eur}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('preleve l exces sur la construction puis sur le foncier, sans le creuser', () => {
    const cpls = r.financement.prets_resolus.find((p) => p.code === 'CPLS');
    expect(cpls).toBeDefined();
    expect(cpls.derive).toBe(true);
    // La construction etait a zero : c'est donc le foncier qui a cede la place.
    const foncier = r.financement.prets_resolus.find((p) => p.nature === 'foncier' && p.produit === 'PLS');
    expect(foncier.montant_eur).toBeGreaterThan(0);
  });

  it('le plan reste equilibre et le PLS sous son plafond', () => {
    expect(r.financement.equilibre.ecart_eur).toBe(0);
    const pr = r.bilan.par_tranche.PLS.total_ttc_module_eur;
    const pls = r.financement.prets_resolus
      .filter((p) => p.produit === 'PLS' && p.code !== 'CPLS' && p.nature !== 'autre')
      .reduce((s, p) => s + p.montant_eur, 0);
    expect(pls).toBeLessThanOrEqual(Math.round(pr * 0.55) + 1);
  });
});

describe('R-AMT-1 - marges CDC : referentiel versionne et surcharge par simulation', () => {
  // Le Livret A de reference du referentiel AXENTIA vaut 1,70 %.
  const LA = 0.017;
  const cdcDe = (r, nature) =>
    r.financement.prets_resolus.find((p) => p.produit === 'PLS' && p.nature === nature);

  it('applique la marge du referentiel, sans marge ecrite dans le code', () => {
    const r = calculer({ ...BASE, prets: [] }, REFERENTIELS);
    // 1,70 % + 1,11 % = 2,81 %, sur les deux prets de la tranche.
    expect(cdcDe(r, 'construction').taux).toBeCloseTo(LA + 0.0111, 10);
    expect(cdcDe(r, 'foncier').taux).toBeCloseTo(LA + 0.0111, 10);
    expect(cdcDe(r, 'construction').spread).toBeCloseTo(0.0111, 10);
    expect(r.financement.livret_a_reference).toBe(LA);
  });

  it('une marge surchargee par la simulation deplace le taux des prets CDC', () => {
    const r = calculer(
      { ...BASE, prets: [], parametrage: { marges_prets: { PLS: 0.02 } } },
      REFERENTIELS,
    );
    expect(cdcDe(r, 'construction').taux).toBeCloseTo(LA + 0.02, 10);
    expect(r.financement.marges_prets.PLS.valeur).toBe(0.02);
    expect(r.financement.marges_prets.PLS.surchargee).toBe(true);
    // Les autres marges restent celles du referentiel, avec leur tracabilite.
    expect(r.financement.marges_prets.PLUS.valeur).toBe(0.006);
    expect(r.financement.marges_prets.PLUS.surchargee).toBeUndefined();
  });

  it('ne laisse pas une surcharge vide effacer la marge du referentiel', () => {
    // Vider la cellule a l'ecran envoie `null` : la marge doit revenir au
    // referentiel, pas rendre le pret inamortissable.
    for (const vide of [null, undefined, '', NaN]) {
      const r = calculer(
        { ...BASE, prets: [], parametrage: { marges_prets: { PLS: vide } } },
        REFERENTIELS,
      );
      expect(cdcDe(r, 'construction').taux, `surcharge ${String(vide)}`)
        .toBeCloseTo(LA + 0.0111, 10);
    }
  });

  it('une marge saisie sur UN pret ne deplace que celui-la', () => {
    const r = calculer(
      {
        ...BASE,
        prets: [
          { code: 'CDC_BATIMENT_PLS', nature: 'construction', produit: 'PLS',
            montant_auto: true, spread: 0.008 },
          { code: 'CDC_FONCIER_PLS', nature: 'foncier', produit: 'PLS', montant_auto: true },
        ],
      },
      REFERENTIELS,
    );
    expect(cdcDe(r, 'construction').taux).toBeCloseTo(LA + 0.008, 10);
    expect(cdcDe(r, 'foncier').taux).toBeCloseTo(LA + 0.0111, 10);
  });

  it('un taux saisi en clair prime sur la marge : un pret hors fonds d epargne n est pas indexe', () => {
    const r = calculer(
      {
        ...BASE,
        prets: [
          { code: 'CDC_BATIMENT_PLS', nature: 'construction', produit: 'PLS',
            montant_auto: true, spread: 0.008, taux: 0.045 },
        ],
      },
      REFERENTIELS,
    );
    expect(cdcDe(r, 'construction').taux).toBe(0.045);
  });
});
