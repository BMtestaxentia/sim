// @ts-check
/**
 * AGDE 2402 - FOYER PLS en colocation, 16 lots, VEFA zone 3/B1.
 *
 * Premiere fixture de foyer qui porte la chaine ENTIERE : bilan, plan de
 * financement, amortissement, amortissement comptable et compte en redevance.
 * Orleans validait l'amortissement et la redevance sans le bilan ; Mulhouse le
 * bilan sans la redevance. Celle-ci ferme le tour.
 *
 * Trois choses la rendent precieuse :
 *
 * 1. sa trajectoire de Livret A est LUE DANS L'ANNEXE (colonne K du tableau de
 *    redevance), donc les annuites en double revisabilite sont reproductibles ;
 * 2. elle porte une avance de tresorerie remuneree - le montage a 2 % de fonds
 *    propres des operations en redevance - reconstituee sur 30 ans a 2,5 % ;
 * 3. sa taxe fonciere entre en 2051, soit mise en location + 25 ans PILE, ce qui
 *    CONTREDIT Bergerac (+26) et donne raison au CGI. Voir E-10.
 *
 * Elle expose aussi un defaut de LEON que le moteur ne reproduit pas : une 51e
 * echeance sur un pret de 50 ans (E-13).
 *
 * Protocole et tolerances : CLAUDE.md §5, comme `golden.test.js`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compteExploitation } from '../src/exploitation.js';
import { calculer } from '../src/moteur.js';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} fichier */
function fixture(fichier) {
  return JSON.parse(readFileSync(join(RACINE, 'fixtures', 'agde_2402_foyer_pls', fichier), 'utf8'));
}

describe('golden - AGDE 2402 FOYER PLS (chaine complete en redevance)', () => {
  const entrees = fixture('entrees.json');
  const attendus = fixture('attendus.json');
  const baremes = JSON.parse(
    readFileSync(join(RACINE, 'referentiels', 'baremes_her_2027.json'), 'utf8'),
  );
  const trajectoires = JSON.parse(
    readFileSync(join(RACINE, 'referentiels', 'trajectoires_axentia_2026.json'), 'utf8'),
  );

  const B = entrees.bilan;
  const F = attendus.plan_financement;
  const RED = attendus.redevance_forfaitaire_par_annee;
  const SERIE = attendus.resultat_et_autofinancement_par_annee;

  const entreesMoteur = {
    identite: { nom: 'AGDE COLOC PLS', zone_123: 3, zone_ABC: 'B1', type_operation: 'VEFA' },
    dates: { annee_mise_en_location: 2026, duree_simulation_ans: 60 },
    lots: [{ code_produit: 'FPLS', nb_logements: 16, shab_m2: 423.7, surfaces_annexes_m2: 0 }],
    // Quatre postes, un seul taxable. Le prix de VEFA porte 10 % de TVA ; les
    // trois autres sont hors champ de la livraison a soi-meme (TTC = HT dans
    // l'annexe), comme sur les fixtures Mulhouse - voir Q-24.
    postes_bilan: [
      {
        chapitre: 'charge_fonciere',
        libelle: 'Prix de VEFA',
        montant_ht_eur: B.prix_vefa_ht_eur,
        taux_tva: B.taux_tva_vefa,
        hors_lasm: true,
      },
      {
        chapitre: 'charge_fonciere',
        libelle: 'Frais de notaire',
        montant_ht_eur: B.frais_notaire_eur,
        taux_tva: 0,
        hors_lasm: true,
      },
      {
        chapitre: 'honoraires',
        libelle: 'RMO',
        montant_ht_eur: B.rmo_eur,
        taux_tva: 0,
        hors_lasm: true,
      },
      {
        chapitre: 'frais_financiers',
        libelle: 'Frais financiers',
        montant_ht_eur: B.frais_financiers_eur,
        taux_tva: 0,
        hors_lasm: true,
      },
    ],
    subventions: entrees.subventions.map((s) => ({
      libelle: s.libelle,
      montant_eur: s.montant_eur,
    })),
    fonds_propres_eur: entrees.fonds_propres.avance_tresorerie_remuneree_eur,
    prets: entrees.prets.map((p) => ({
      code: p.code,
      libelle: p.libelle,
      nature: p.nature,
      montant_eur: p.montant_eur,
      taux: p.taux,
      progressivite: p.progressivite,
      duree_ans: p.duree_ans,
      revisabilite: p.revisabilite,
      annee_premiere_echeance: entrees.dates.annee_premiere_echeance,
      livret_a_origine: entrees.livret_a_origine,
      livret_a_par_annee: entrees.livret_a_par_annee,
    })),
  };

  const resultat = calculer(entreesMoteur, { baremes, trajectoires });

  it('reproduit le prix de revient HT et TTC a +/-1 EUR', () => {
    expect(
      Math.abs(resultat.bilan.total_ttc_module_eur - attendus.bilan.total_ttc_eur),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(resultat.bilan.total_ht_eur - attendus.bilan.total_ht_eur)).toBeLessThanOrEqual(
      1,
    );
  });

  it('reproduit le taux de TVA moyen de l operation', () => {
    // 9,24 % : la seule TVA de l'operation est celle du prix de VEFA a 10 %,
    // diluee par trois postes hors champ.
    const tva = resultat.bilan.total_ttc_module_eur / resultat.bilan.total_ht_eur - 1;
    expect(tva).toBeCloseTo(attendus.bilan.taux_tva_moyen, 6);
  });

  it('reproduit le prix de revient par lot et les frais financiers par lot', () => {
    const parLot = resultat.bilan.total_ttc_module_eur / 16;
    expect(Math.abs(parLot - attendus.bilan.prix_revient_ttc_par_lot_eur)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(B.frais_financiers_eur / 16 - attendus.bilan.frais_financiers_par_lot_eur),
    ).toBeLessThanOrEqual(0.01);
  });

  it('equilibre le plan de financement', () => {
    expect(Math.abs(resultat.financement.equilibre.ecart_eur)).toBeLessThanOrEqual(1);
    expect(Math.abs(resultat.financement.total_prets_eur - F.total_prets_eur)).toBeLessThanOrEqual(
      1,
    );
    expect(resultat.indicateurs.subventions_eur).toBe(F.total_subventions_eur);
    expect(
      Math.abs(resultat.indicateurs.ressources_eur - F.total_financements_eur),
    ).toBeLessThanOrEqual(1);
  });

  it('reproduit les parts prets / subventions / fonds propres', () => {
    const pr = resultat.bilan.total_ttc_module_eur;
    expect(resultat.financement.total_prets_eur / pr).toBeCloseTo(F.pct_prets, 6);
    expect(resultat.indicateurs.subventions_eur / pr).toBeCloseTo(F.pct_subventions, 6);
    expect(resultat.indicateurs.taux_fonds_propres).toBeCloseTo(F.pct_fonds_propres, 6);
  });

  it('compte les deux PLS dans la quotite CDC', () => {
    expect(resultat.financement.total_prets_cdc_eur).toBe(F.total_prets_eur);
  });

  // ---------------------------------------------------------------------------
  // Amortissement : 90 echeances contre l'annexe, sur une trajectoire de Livret A
  // reelle et non plate (1,6 % en 2026, puis 2,1 / 2,0 / 2,2 %).
  describe('amortissement (double revisabilite, progressivite -0,5 %)', () => {
    const tables = resultat.amortissements;
    const parCode = Object.fromEntries(tables.map((a) => [a.code, a.tableau]));

    it('demarre en 2027 et couvre 50 puis 40 echeances', () => {
      expect(parCode.PLS_FONCIER).toHaveLength(50);
      expect(parCode.PLS_TRAVAUX).toHaveLength(40);
      expect(parCode.PLS_FONCIER[0].annee).toBe(2027);
      expect(parCode.PLS_TRAVAUX.at(-1)?.annee).toBe(2066);
    });

    it('le taux vaut le Livret A d origine plus la marge', () => {
      for (const p of entrees.prets) {
        expect(p.taux, p.libelle).toBeCloseTo(entrees.livret_a_origine + p.marge, 10);
      }
    });

    it('reproduit les 50 annees d annuites agregees', () => {
      let comparees = 0;
      let pire = 0;
      for (const a of RED) {
        if (!a.annuites_keur) continue;
        // 2077 est la 51e echeance de LEON : hors contrat, traitee plus bas.
        if (a.annee > 2076) continue;
        const somme =
          tables.reduce(
            (s, t) => s + (t.tableau.find((l) => l.annee === a.annee)?.annuite_eur ?? 0),
            0,
          ) / 1000;
        pire = Math.max(pire, Math.abs(somme - a.annuites_keur) / a.annuites_keur);
        comparees++;
      }
      expect(comparees).toBe(50);
      // L'accord est au bruit flottant, pas « juste dans la tolerance » de
      // 0,1 % : tout ecart visible ici signale une regression reelle.
      expect(pire).toBeLessThanOrEqual(1e-12);
    });

    it('reproduit la rupture de 2067 : extinction du pret travaux 40 ans', () => {
      const av = RED.find((a) => a.annee === 2066);
      const ap = RED.find((a) => a.annee === 2067);
      expect(av.annuites_keur).toBeGreaterThan(90);
      expect(ap.annuites_keur).toBeLessThan(26);
      const moteur2067 = parCode.PLS_FONCIER.find((l) => l.annee === 2067).annuite_eur;
      expect(Math.abs(moteur2067 / 1000 - ap.annuites_keur) / ap.annuites_keur).toBeLessThanOrEqual(
        1e-12,
      );
    });

    it('chaque pret solde exactement son capital', () => {
      for (const p of entrees.prets) {
        const t = parCode[p.code];
        const somme = t.reduce((s, l) => s + l.amortissement_eur, 0);
        expect(Math.abs(somme - p.montant_eur), p.libelle).toBeLessThanOrEqual(0.01);
        expect(t.at(-1)?.crd_eur).toBeCloseTo(0, 4);
      }
    });

    it('n emet pas la 51e echeance fantome de LEON (E-13)', () => {
      // LEON paie encore 24 091,50 EUR en 2077 sur un pret de 50 ans dont la
      // derniere echeance contractuelle tombe en 2076, et cette 51e ligne ne
      // porte AUCUN interet : c'est du capital pur sur un solde deja nul.
      const l2077 = SERIE.find((l) => l.annee === 2077);
      expect(l2077.annuites_eur).toBeCloseTo(24091.5, 1);
      expect(l2077.interets_emprunts_eur).toBe(0);

      // La preuve que c'est un defaut et non une regle : sur les 60 annees,
      // LEON amortit 24 091,50 EUR de capital DE PLUS qu'il n'en a prete.
      const totalAnnuites = RED.reduce((s, a) => s + a.annuites_keur * 1000, 0);
      const totalInterets = SERIE.reduce((s, l) => s + l.interets_emprunts_eur, 0);
      expect(totalAnnuites - totalInterets - F.total_prets_eur).toBeCloseTo(24091.5, 1);

      // Le moteur, lui, s'arrete a 2076 et son capital amorti est exact.
      expect(parCode.PLS_FONCIER.some((l) => l.annee === 2077)).toBe(false);
      const capitalMoteur = tables.reduce(
        (s, a) => s + a.tableau.reduce((x, l) => x + l.amortissement_eur, 0),
        0,
      );
      expect(Math.abs(capitalMoteur - F.total_prets_eur)).toBeLessThanOrEqual(0.01);
    });
  });

  // ---------------------------------------------------------------------------
  it('reproduit la valeur comptable du terrain et la base d amortissement (Q-26)', () => {
    // L'annexe AFFICHE la quotite : « TERRAIN SUR MONTANT ACQ VEFA TTC = 0,25 ».
    // Elle porte sur le prix de VEFA TTC et non sur le prix de revient : la base
    // d'amortissement est donc PR TTC moins 25 % de la seule acquisition.
    const avecAmort = calculer(
      {
        ...entreesMoteur,
        amortissement_comptable: {
          montant_terrain_eur: B.prix_vefa_ttc_eur,
          quotite_terrain: entrees.hypotheses_exploitation.terrain_sur_montant_acquisition_vefa_ttc,
        },
      },
      { baremes, trajectoires },
    );
    const a = avecAmort.indicateurs.amortissement_comptable;
    expect(
      Math.abs(a.valeur_comptable_terrain_eur - attendus.indicateurs.valeur_comptable_terrain_eur),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(a.base_eur - attendus.indicateurs.base_amortissement_eur)).toBeLessThanOrEqual(
      1,
    );
  });

  // ---------------------------------------------------------------------------
  // Compte d'exploitation en redevance forfaitaire.
  //
  // Comme sur Orleans (Q-27), les trajectoires ci-dessous sont IDENTIFIEES sur
  // les series de sortie et non transcrites d'une saisie : elles vivent donc
  // dans le test et non dans `entrees.json`. Ce que l'annexe etablit ici, et qui
  // n'etait pas acquis :
  //
  // - la redevance et les charges suivent DEUX trajectoires DISTINCTES
  //   (+1,7 % puis +1,8 % contre +2,0 % puis +1,8 %). Une trajectoire unique,
  //   comme sur Orleans, n'est donc pas une regle du mode redevance ;
  // - l'annee 1 ne compte qu'UN MOIS - mise en location au 01/12/2026. Le
  //   rapport annee 2 / annee 1 vaut 12,42 sur les charges, soit douze mois
  //   indexes de 2,1 % ; la comparaison porte donc sur 2027 a 2085.
  describe('compte en redevance forfaitaire', () => {
    const TRAJ_REDEVANCE = { 2028: 0.017, 2030: 0.018 };
    const TRAJ_CHARGES = { 2028: 0.02, 2029: 0.018 };
    const AN2 = RED.find((a) => a.annee === 2027);

    // L'annexe agrege TFPB et TEOM dans une seule colonne. Les deux s'y
    // separent sans ambiguite : la TEOM court des l'annee 1, la TFPB n'apparait
    // qu'en 2051. La base de TFPB ci-dessous est donc IDENTIFIEE - le residu de
    // la colonne en 2051 une fois la TEOM indexee retiree, ramene en euros
    // 2027 - et non transcrite d'une saisie. Elle vaut 358,28 EUR par lot la ou
    // le bareme affiche 345 : l'ecart est celui de l'indexation entre l'annee
    // de valeur du bareme et 2027, la meme que la TEOM subit (117 -> 122,34).
    const TEOM_BASE_2027_EUR = AN2.tfpb_teom_keur * 1000;
    const TFPB_BASE_2027_EUR = 5732.465013;
    const ANNEE_ENTREE_TFPB = 2051;

    const annuites = resultat.amortissements.flatMap((a) =>
      a.tableau.map((l) => ({ annee: l.annee, annuite_eur: l.annuite_eur })),
    );

    const compte = compteExploitation({
      annee_mise_en_location: 2027,
      duree_ans: 59,
      mode: 'redevance',
      redevance_annuelle_eur: AN2.redevance_eur,
      index_redevance: 'redevance',
      loyers_logements_annuels_eur: 0,
      // Les montants de l'annexe sont des totaux d'operation : ils passent en
      // forfait plutot que par les assiettes « par logement », qui exigeraient
      // de re-deriver un effectif que la donnee porte deja.
      nb_logements: 0,
      annee_debut_tfpb: 9999,
      annuites,
      charges_diverses: [
        {
          code: 'gestion',
          libelle: 'Frais de gestion',
          assiette: 'forfait',
          valeur: AN2.frais_gestion_keur * 1000,
          index: 'charges',
        },
        {
          code: 'teom',
          libelle: 'TEOM',
          assiette: 'forfait',
          valeur: TEOM_BASE_2027_EUR,
          index: 'charges',
        },
        {
          code: 'tfpb',
          libelle: 'Taxe fonciere',
          assiette: 'forfait',
          valeur: TFPB_BASE_2027_EUR,
          index: 'charges',
          annee_debut: ANNEE_ENTREE_TFPB,
        },
        {
          code: 'assurance',
          libelle: 'Assurance',
          assiette: 'forfait',
          valeur: AN2.assurance_keur * 1000,
          index: 'charges',
        },
      ],
      trajectoires: { redevance: TRAJ_REDEVANCE, charges: TRAJ_CHARGES, gestion: TRAJ_CHARGES },
    });

    const lignes = Object.fromEntries(compte.lignes.map((l) => [l.annee, l]));
    const poste = (l, code) =>
      l.detail_charges_diverses.find((d) => d.code === code)?.montant_eur ?? 0;

    /**
     * Ecart maximal sur les annees 2027 a 2085, relatif ET absolu.
     *
     * Les deux sont necessaires : le moteur arrondit chaque poste a l'euro
     * quand LEON garde sa precision en kEUR. Sur une redevance a 100 kEUR le
     * demi-euro d'arrondi ne se voit pas ; sur une assurance a 300 EUR il pese
     * 0,16 %, soit plus que la tolerance de 0,1 %. Juger un petit poste au
     * ratio reviendrait a exiger du moteur une precision que son propre arrondi
     * lui interdit.
     */
    const ecartMax = (calcule, attendu) => {
      let pire = 0;
      let pireAbs = 0;
      let comparees = 0;
      for (const a of RED) {
        if (a.annee < 2027) continue;
        const cible = attendu(a);
        if (!cible) continue;
        const ecart = Math.abs(calcule(lignes[a.annee]) - cible);
        pire = Math.max(pire, ecart / Math.abs(cible));
        pireAbs = Math.max(pireAbs, ecart);
        comparees++;
      }
      return { pire, pireAbs, comparees };
    };

    /** Arrondi a l'euro du moteur : l'ecart absolu maximal atteignable sans bug. */
    const ARRONDI = 0.5;

    it('reproduit 59 annees de redevance depuis le seul montant de l annee 2', () => {
      const { pire, comparees } = ecartMax(
        (l) => l.redevance_eur,
        (a) => a.redevance_eur,
      );
      expect(comparees).toBe(59);
      expect(pire).toBeLessThanOrEqual(0.001);
    });

    it('reproduit frais de gestion et TFPB sur la trajectoire des charges', () => {
      const gestion = ecartMax(
        (l) => poste(l, 'gestion'),
        (a) => a.frais_gestion_keur * 1000,
      );
      expect(gestion.comparees).toBe(59);
      expect(gestion.pire).toBeLessThanOrEqual(0.001);

      // TFPB et TEOM sont agregees dans une seule colonne de l'annexe : la
      // comparaison porte sur leur somme, sur les 59 annees, rupture de 2051
      // comprise.
      const fiscal = ecartMax(
        (l) => poste(l, 'teom') + poste(l, 'tfpb'),
        (a) => a.tfpb_teom_keur * 1000,
      );
      expect(fiscal.comparees).toBe(59);
      expect(fiscal.pire).toBeLessThanOrEqual(0.001);
    });

    it('reproduit l assurance au demi-euro, seul arrondi que le moteur y ajoute', () => {
      // Poste de 300 a 860 EUR par an : l'arrondi a l'euro y pese jusqu'a
      // 0,16 %, au-dessus de la tolerance relative. C'est bien l'arrondi et
      // rien d'autre, l'ecart absolu ne depassant jamais le demi-euro sur 59
      // annees.
      const { pireAbs, comparees } = ecartMax(
        (l) => poste(l, 'assurance'),
        (a) => a.assurance_keur * 1000,
      );
      expect(comparees).toBe(59);
      expect(pireAbs).toBeLessThanOrEqual(ARRONDI);
    });

    it('les frais de gestion valent bien 0,3 % du prix de revient TTC (Q-17)', () => {
      // 0,003 x 2 215 969,74 / 16 = 415,49 EUR par lot, la valeur AFFICHEE par
      // l'annexe. C'est l'assiette « prix de revient TTC », pas un forfait.
      const base = 0.003 * attendus.bilan.total_ttc_eur;
      expect(base / 16).toBeCloseTo(entrees.hypotheses_exploitation.frais_gestion_par_lot_eur, 6);
      // L'annee 2 les porte deja indexes : superieurs a l'assiette nue, mais de
      // moins d'un exercice d'indexation.
      const rapport = (AN2.frais_gestion_keur * 1000) / base;
      expect(rapport).toBeGreaterThan(1);
      expect(rapport).toBeLessThan(1.1);
    });

    it('la redevance et les charges suivent DEUX trajectoires distinctes', () => {
      // Garde-fou : si l'on unifiait les deux trajectoires, 2028 et 2029
      // decrocheraient immediatement. Le mode redevance n'impose pas un index
      // unique, contrairement a ce que suggerait Orleans seule.
      const an = (a) => RED.find((x) => x.annee === a);
      expect(an(2028).redevance_eur / an(2027).redevance_eur).toBeCloseTo(1.017, 10);
      expect(an(2028).frais_gestion_keur / an(2027).frais_gestion_keur).toBeCloseTo(1.02, 10);
    });

    it('la taxe fonciere entre en 2051, soit mise en location + 25 ans PILE (E-10)', () => {
      // Contre-exemple direct a Bergerac, ou LEON exonerait 26 ans. AGDE est
      // mise en location en 2026 et taxee des 2051 : la regle du moteur,
      // `annee_mise_en_location + duree_exoneration`, est celle du CGI 1384 A,
      // et c'est bien celle-la que LEON applique ici.
      const av = RED.find((a) => a.annee === 2050);
      const ap = RED.find((a) => a.annee === 2051);
      expect(ap.tfpb_teom_keur / av.tfpb_teom_keur).toBeGreaterThan(3.9);
      expect(2026 + entrees.hypotheses_exploitation.duree_exoneration_tfpb_ans).toBe(
        ANNEE_ENTREE_TFPB,
      );
      // Et aucune rupture avant : la TEOM seule court des l'annee 1.
      for (const a of RED.filter((x) => x.annee > 2027 && x.annee < 2051)) {
        const p = RED.find((x) => x.annee === a.annee - 1);
        expect(a.tfpb_teom_keur / p.tfpb_teom_keur, `${a.annee}`).toBeLessThan(1.05);
      }
      // La rupture doit etre PRODUITE par le moteur, pas seulement toleree.
      expect(poste(lignes[2050], 'tfpb')).toBe(0);
      expect(poste(lignes[2051], 'tfpb')).toBeGreaterThan(0);
      expect(poste(lignes[2050], 'teom')).toBeGreaterThan(0);
    });

    it('reproduit l annuite de reconstitution des fonds propres (30 ans a 2,5 %)', () => {
      // L'avance de tresorerie remuneree se rembourse comme un pret : annuite
      // constante sur 30 ans au taux de remuneration. Elle sort du plan de
      // financement, pas d'une saisie.
      const {
        avance_tresorerie_remuneree_eur: capital,
        taux_remuneration: taux,
        duree_reconstitution_ans: duree,
      } = entrees.fonds_propres;
      const annuite = (capital * taux) / (1 - (1 + taux) ** -duree);
      expect(annuite / 1000).toBeCloseTo(RED[0].annuites_fp_keur, 6);
      const servies = RED.filter((a) => a.annuites_fp_keur > 0);
      expect(servies).toHaveLength(30);
      expect(servies.at(-1)?.annee).toBe(2055);
    });
  });
});
