// @ts-check
/**
 * Exemple executable : une simulation PLS complete de bout en bout.
 *
 *   node exemples/simulation_pls.js          # synthese lisible
 *   node exemples/simulation_pls.js --json   # resultat brut, pour brancher une UI
 *
 * Sert de contrat d'interface : c'est exactement ce qu'une UI aura a appeler et
 * a afficher. Les donnees sont fictives (calquees sur la structure BERGERAC),
 * aucune donnee reelle AXENTIA ici.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { calculer } from '../src/moteur.js';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const lire = (p) => JSON.parse(readFileSync(join(RACINE, p), 'utf8'));

const referentiels = {
  baremes: lire('referentiels/baremes_2025.json'),
  trajectoires: lire('referentiels/trajectoires_axentia_2026.json'),
};

/** @type {any} */
const entrees = {
  identite: {
    nom: 'Exemple 6 logements PLS',
    produit: 'PLS',
    zone_123: 2,
    zone_ABC: 'B1',
    type_operation: 'Vefa',
  },
  dates: { annee_mise_en_location: 2028, duree_simulation_ans: 40 },
  lots: [{ code_produit: 'PLS', nb_logements: 6, shab_m2: 400, surfaces_annexes_m2: 40 }],
  postes_bilan: [
    // Montant cale pour que le plan de financement s'equilibre exactement :
    // (642 780 + 12 000 + 18 000) x 1,10 = 740 058 = subventions + FP + prets.
    { chapitre: 'charge_fonciere', libelle: 'Acquisition VEFA', montant_ht_eur: 642780, taux_tva: 0.055 },
    { chapitre: 'charge_fonciere', libelle: 'Frais de notaire', montant_ht_eur: 12000, taux_tva: 0.055 },
    { chapitre: 'honoraires', libelle: 'Honoraires techniques', montant_ht_eur: 18000, taux_tva: 0.2 },
  ],
  subventions: [{ libelle: 'Ville', montant_eur: 20000, gratuite: true }],
  fonds_propres_eur: 50000,
  prets: [
    {
      code: 'PLS_CONSTRUCTION',
      libelle: 'PLS construction',
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
    {
      code: 'PLS_FONCIER',
      libelle: 'PLS foncier',
      nature: 'foncier',
      montant_eur: 176035,
      taux: 0.0351,
      progressivite: 0,
      duree_ans: 50,
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
    trajectoires: { loyers_irl: 0.02, gros_entretien: 0.023, tfpb: 0.05 },
  },
};

const r = calculer(entrees, referentiels);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(r, null, 2));
} else {
  const eur = (v) => (v === null || v === undefined ? '-' : v.toLocaleString('fr-FR') + ' EUR');
  const pct = (v) => (v === null || v === undefined ? '-' : (v * 100).toFixed(2) + ' %');

  console.log(`\n=== ${entrees.identite.nom} — moteur v${r.version_moteur} ===\n`);

  console.log('PROGRAMME');
  console.log(`  Logements          ${r.indicateurs.nb_logements}`);
  console.log(`  SHAB / SU          ${r.indicateurs.shab_m2} m2 / ${r.indicateurs.su_m2} m2`);
  for (const l of r.loyers) {
    console.log(
      `  Loyer ${l.code_produit.padEnd(8)} CS ${l.cs} -> ${l.loyer_pratique_eur_m2} EUR/m2/mois` +
        `  (${eur(l.loyer_annuel_eur)}/an)`,
    );
  }

  console.log('\nPRIX DE REVIENT');
  for (const [nom, c] of Object.entries(r.bilan.chapitres)) {
    console.log(`  ${nom.padEnd(18)} HT ${eur(c.ht_eur).padStart(14)}   TTC LASM ${eur(c.ttc_lasm_eur)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(18)} HT ${eur(r.bilan.total_ht_eur).padStart(14)}   TTC LASM ${eur(r.bilan.total_ttc_lasm_eur)}`);
  console.log(`  Par logement       ${eur(r.indicateurs.prix_revient_par_logement_eur)}`);
  console.log(`  Par m2 SHAB        ${eur(r.indicateurs.prix_revient_par_m2_shab_eur)}`);

  console.log('\nPLAN DE FINANCEMENT');
  console.log(`  Subventions        ${eur(r.subventions.total_avec_ssf_eur)}`);
  console.log(`  Fonds propres      ${eur(entrees.fonds_propres_eur)} (${pct(r.indicateurs.taux_fonds_propres)})`);
  for (const a of r.amortissements) {
    const t = a.tableau;
    console.log(
      `  ${a.libelle.padEnd(18)} ${eur(a.montant_eur).padStart(14)}  ` +
        `${t.length} ans, taux ${pct(t[0].taux)}, 1re annuite ${eur(Math.round(t[0].annuite_eur))}`,
    );
  }
  console.log(`  Equilibre          ecart ${eur(r.financement.equilibre.ecart_eur)}`);

  console.log('\nEXPLOITATION');
  const l0 = r.exploitation.lignes[0];
  console.log(`  Annee 1 (${l0.annee})     produits ${eur(l0.total_produits_eur)}, charges ${eur(l0.total_charges_eur)}, resultat ${eur(l0.resultat_eur)}`);
  console.log(`  Premiere annee positive       ${r.exploitation.totaux.premiere_annee_positive ?? 'jamais'}`);
  console.log(`  Cumul positif a partir de     ${r.exploitation.totaux.annee_retour_cumul_positif ?? 'jamais'}`);
  console.log(`  Reconstitution des FP         ${r.indicateurs.annee_reconstitution_fonds_propres ?? 'non atteinte'}`);
  console.log(`  Debut TFPB                    ${r.indicateurs.annee_debut_tfpb}`);
  console.log(`  RMO                           ${pct(r.indicateurs.rmo)}`);

  if (r.alertes.length) {
    console.log('\nALERTES');
    for (const a of r.alertes) console.log(`  - ${a}`);
  }
  console.log('');
}
