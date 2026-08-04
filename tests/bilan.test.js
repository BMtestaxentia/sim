// @ts-check
/**
 * R-TVA (prix de revient / LASM), R-SUB (subventions), R-FIN (plan de
 * financement) et R-FISC (fiscalite). Oracles recalcules a la main.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ventilerPoste, tauxLASM, prixDeRevient, ventilerParQuotePart } from '../src/bilan.js';
import { agregerSubventions, surchargeFonciere, subventionEtat } from '../src/subventions.js';
import {
  soldeAFinancer,
  foncierFinancable,
  quotiteFoncier,
  pretsCDCTheoriques,
  controleEquilibre,
} from '../src/financement.js';
import {
  exonerationTFPB,
  taxeAmenagement,
  versementSousDensite,
  tfpbAnnee,
} from '../src/fiscalite.js';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const baremes = JSON.parse(readFileSync(join(RACINE, 'referentiels', 'baremes_2025.json'), 'utf8'));

const POSTES = [
  { chapitre: 'charge_fonciere', libelle: 'Acquisition VEFA', montant_ht_eur: 1000000, taux_tva: 0.055 },
  { chapitre: 'charge_fonciere', libelle: 'Frais de notaire', montant_ht_eur: 20000, taux_tva: 0.055 },
  { chapitre: 'honoraires', libelle: 'Honoraires', montant_ht_eur: 50000, taux_tva: 0.2 },
];

describe('R-TVA — prix de revient et livraison a soi-meme', () => {
  it('R-TVA-1 : ventilation HT / TVA / TTC au taux de saisie', () => {
    expect(ventilerPoste(POSTES[0])).toEqual({ ht_eur: 1000000, tva_eur: 55000, ttc_eur: 1055000 });
  });

  it('R-TVA-2 : PLUS/PLAI utilise le taux reduit de la simulation (10 %), pas 5,5 %', () => {
    expect(tauxLASM('PLUS', baremes)).toBe(0.1);
    expect(tauxLASM('PLAI', baremes)).toBe(0.1);
    expect(tauxLASM('PLS', baremes)).toBe(0.1);
    expect(tauxLASM('LIBRE', baremes)).toBe(0.2);
  });

  it('R-TVA-2 : le TTC final recalcule chaque poste au taux LASM', () => {
    const b = prixDeRevient({ code_produit: 'PLS', postes: POSTES }, baremes);
    expect(b.total_ht_eur).toBe(1070000);
    // TTC de saisie : 1 055 000 + 21 100 + 60 000
    expect(b.total_ttc_eur).toBe(1136100);
    // TTC final LASM a 10 % sur tous les postes
    expect(b.total_ttc_lasm_eur).toBe(Math.round(1070000 * 1.1));
  });

  it('un poste hors champ LASM garde sa TVA de saisie', () => {
    const b = prixDeRevient(
      { code_produit: 'PLS', postes: [{ ...POSTES[2], hors_lasm: true }] },
      baremes,
    );
    expect(b.total_ttc_lasm_eur).toBe(60000); // 50 000 x 1,2, pas x 1,1
  });

  it('R-TVA-4 : la modulation s ajoute au prix de revient finançable', () => {
    const b = prixDeRevient(
      { code_produit: 'PLS', postes: POSTES, modulation_ttc_eur: 15000 },
      baremes,
    );
    expect(b.total_ttc_module_eur).toBe(b.total_ttc_lasm_eur + 15000);
  });

  it('les chapitres sont totalises separement', () => {
    const b = prixDeRevient({ code_produit: 'PLS', postes: POSTES }, baremes);
    expect(b.chapitres.charge_fonciere.ht_eur).toBe(1020000);
    expect(b.chapitres.honoraires.ht_eur).toBe(50000);
  });

  it('R-TVA-3 : ventilation par quote-part', () => {
    const r = ventilerParQuotePart(1000, { PLUS: 0.6, PLAI: 0.4 });
    expect(r.PLUS).toBeCloseTo(600, 9);
    expect(r.PLAI).toBeCloseTo(400, 9);
  });
});

describe('R-SUB — subventions', () => {
  it('R-SUB-3 : separe gratuites et non gratuites, ventile par affectation', () => {
    const r = agregerSubventions(
      [
        { libelle: 'Etat', montant_eur: 100000, gratuite: true, affectation: 'PLUS' },
        { libelle: 'Region', montant_eur: 50000, affectation: 'PLAI' },
      ],
      { PLUS: 0.6, PLAI: 0.4 },
    );
    expect(r.gratuites_eur).toBe(100000);
    expect(r.non_gratuites_eur).toBe(50000);
    expect(r.par_produit.PLUS).toBe(100000);
    expect(r.par_produit.PLAI).toBe(50000);
  });

  it('une subvention sans affectation propre est ventilee par quote-part', () => {
    const r = agregerSubventions([{ libelle: 'Ville', montant_eur: 1000 }], { PLUS: 0.6, PLAI: 0.4 });
    expect(r.par_produit.PLUS).toBe(600);
    expect(r.par_produit.PLAI).toBe(400);
  });

  it('R-SUB-2 : pas de SSF sans depassement', () => {
    const r = surchargeFonciere(
      { valeur_fonciere_eur: 100000, valeur_de_base_eur_m2: 1473, su_ssf_m2: 500 },
      baremes,
    );
    expect(r.subvention_eur).toBe(0);
    expect(r.eligible).toBe(false);
  });

  it('R-SUB-2 : depassement plafonne puis subventionne au taux du neuf', () => {
    // reference = 1473 x 100 = 147 300 ; foncier 300 000 -> depassement 152 700
    const r = surchargeFonciere(
      { valeur_fonciere_eur: 300000, valeur_de_base_eur_m2: 1473, su_ssf_m2: 100, type: 'neuf' },
      baremes,
    );
    expect(r.reference_eur).toBe(147300);
    expect(r.depassement_eur).toBe(152700);
    // Sous le seuil de participation : MIN(1 x 147 300 ; 0,5 x 152 700) = 76 350
    expect(r.depassement_plafonne_eur).toBe(76350);
    expect(r.subvention_eur).toBe(2 * 76350);
  });

  it('R-SUB-2 : le flag d eligibilite coupe le calcul', () => {
    const r = surchargeFonciere(
      { valeur_fonciere_eur: 300000, valeur_de_base_eur_m2: 1473, su_ssf_m2: 100, eligible: false },
      baremes,
    );
    expect(r.subvention_eur).toBe(0);
  });

  it('R-SUB-1 : forfait Etat selon le mode', () => {
    expect(subventionEtat({ mode: 'logement', forfait_eur: 5000, nb_logements: 6 })).toBe(30000);
    expect(subventionEtat({ mode: 'su', forfait_eur: 10, su_m2: 545.8 })).toBe(5458);
    expect(subventionEtat({ mode: 'forfait', forfait_eur: 12345 })).toBe(12345);
  });
});

describe('R-FIN — plan de financement', () => {
  it('R-FIN-3 : solde = PR - (subventions + FP + autres prets)', () => {
    expect(
      soldeAFinancer({
        prix_revient_ttc_module_eur: 1000000,
        subventions_eur: 100000,
        fonds_propres_eur: 50000,
        autres_prets_eur: 20000,
      }),
    ).toBe(830000);
  });

  it('R-FIN-2 : le foncier finançable est reduit par les financements gratuits', () => {
    // 500 000 x (1 - 100 000 / 1 000 000) = 450 000
    expect(
      foncierFinancable({
        charge_fonciere_eur: 500000,
        financements_gratuits_eur: 100000,
        prix_revient_operation_eur: 1000000,
      }),
    ).toBe(450000);
  });

  it('quotites VEFA lues par zone ABC', () => {
    expect(quotiteFoncier('B1', baremes)).toBe(0.3);
    expect(quotiteFoncier('B1', baremes, 'valeur_comptable_terrain_vefa')).toBe(0.13);
  });

  it('R-FIN-4 : le pret foncier est borne par le foncier finançable', () => {
    const r = pretsCDCTheoriques({ solde_eur: 800000, foncier_financable_eur: 300000 });
    expect(r.pret_foncier_eur).toBe(300000);
    expect(r.pret_batiment_eur).toBe(500000);
    expect(r.total_cdc_eur).toBe(800000);
  });

  it('R-FIN-4 : le pret foncier ne depasse jamais le solde', () => {
    const r = pretsCDCTheoriques({ solde_eur: 200000, foncier_financable_eur: 900000 });
    expect(r.pret_foncier_eur).toBe(200000);
    expect(r.pret_batiment_eur).toBe(0);
  });

  it('R-FIN-4 : option d arrondi aux milliers superieurs', () => {
    const r = pretsCDCTheoriques({
      solde_eur: 800500,
      foncier_financable_eur: 300100,
      arrondir_milliers: true,
    });
    expect(r.pret_foncier_eur).toBe(301000);
  });

  it('R-FIN-4 : le prefinancement se retranche du pret batiment', () => {
    const r = pretsCDCTheoriques({
      solde_eur: 800000,
      foncier_financable_eur: 300000,
      prefinancement_eur: 20000,
    });
    expect(r.pret_batiment_eur).toBe(480000);
  });

  it('R-FIN-1 : equilibre exact', () => {
    const r = controleEquilibre({
      prix_revient_ttc_module_eur: 1000000,
      subventions_eur: 200000,
      fonds_propres_eur: 100000,
      prets_eur: 700000,
    });
    expect(r.equilibre).toBe(true);
    expect(r.ecart_eur).toBe(0);
    expect(r.alertes).toHaveLength(0);
  });

  it('R-FIN-1 : sur et sous-financement sont signales, jamais absorbes', () => {
    expect(
      controleEquilibre({ prix_revient_ttc_module_eur: 1000000, prets_eur: 1000500 }).alertes[0],
    ).toMatch(/surfinancement/i);
    expect(
      controleEquilibre({ prix_revient_ttc_module_eur: 1000000, prets_eur: 999000 }).alertes[0],
    ).toMatch(/sous-financement/i);
  });

  it('R-FIN-5 : alerte si le ratio de prets CDC passe sous le minimum reglementaire', () => {
    const r = controleEquilibre(
      {
        prix_revient_ttc_module_eur: 1000000,
        subventions_eur: 600000,
        prets_eur: 400000,
        prets_cdc_eur: 400000,
      },
      baremes,
    );
    expect(r.ratio_prets_cdc).toBeCloseTo(0.4, 12);
    expect(r.alertes.some((a) => /ratio/i.test(a))).toBe(true);
  });
});

describe('R-FISC — fiscalite', () => {
  it('R-FISC-1 : exoneration de 25 ans par defaut, duree parametrable (I-7)', () => {
    expect(exonerationTFPB({ annee_mise_en_location: 2028 }, baremes).annee_debut_tfpb).toBe(2053);
    expect(
      exonerationTFPB({ annee_mise_en_location: 2028, duree_exoneration_ans: 15 }, baremes)
        .annee_debut_tfpb,
    ).toBe(2043);
  });

  it('R-FISC-2 : assiette de taxe d amenagement avec abattement de 50 %', () => {
    const r = taxeAmenagement({ sdp_m2: 1000, taux_commune: 0.05, taux_departement: 0.025 }, baremes);
    expect(r.valeur_forfaitaire_eur_m2).toBe(930);
    expect(r.assiette_eur).toBe(465000); // 1000 x 0,5 x 930
    expect(r.montant_eur).toBe(Math.round(465000 * 0.075));
  });

  it('R-FISC-2 : valeur forfaitaire majoree en Ile-de-France', () => {
    expect(taxeAmenagement({ sdp_m2: 1000, idf: true }, baremes).valeur_forfaitaire_eur_m2).toBe(1054);
  });

  it('R-FISC-3 : pas de VSD sans seuil de densite institue', () => {
    expect(
      versementSousDensite({
        valeur_terrain_eur: 500000,
        sdp_m2: 500,
        surface_terrain_m2: 2000,
        seuil_densite: 0,
      }, baremes),
    ).toBe(0);
  });

  it('R-FISC-3 : VSD plafonne a 25 % de la valeur du terrain', () => {
    const r = versementSousDensite({
      valeur_terrain_eur: 500000,
      sdp_m2: 100,
      surface_terrain_m2: 2000,
      seuil_densite: 0.5,
    }, baremes);
    expect(r).toBe(125000); // plafond atteint
  });

  it('R-FISC-3 : nul si la densite atteint le seuil', () => {
    expect(
      versementSousDensite({
        valeur_terrain_eur: 500000,
        sdp_m2: 1500,
        surface_terrain_m2: 2000,
        seuil_densite: 0.5,
      }, baremes),
    ).toBe(0);
  });

  it('TFPB : nulle pendant l exoneration, puis indexee', () => {
    const commun = { annee_debut_tfpb: 2053, nb_logements: 6, montant_par_logement_eur: 345 };
    expect(tfpbAnnee({ ...commun, annee: 2052 })).toBe(0);
    expect(tfpbAnnee({ ...commun, annee: 2053 })).toBe(2070); // 6 x 345
    expect(tfpbAnnee({ ...commun, annee: 2054, taux_indexation: 0.05 })).toBe(Math.round(2070 * 1.05));
  });
});
