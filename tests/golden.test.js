// @ts-check
/**
 * Golden tests : le moteur confronte aux valeurs calculees par LEON lui-meme.
 *
 * Protocole (CLAUDE.md §5) : une fixture = entrees.json (reconstruites depuis la
 * saisie) + attendus.json (valeurs de sortie de LEON). Tolerances : +/-1 EUR sur
 * le bilan et le plan de financement, +/-0,1 % sur les annuites et les lignes
 * d'exploitation. Un ecart au-dela est un bug du moteur OU un bug documente de
 * LEON (docs/ECARTS_LEON.md) — jamais une fixture qu'on ajuste.
 *
 * Couverture actuelle : R-AMT (amortissement). Le reste de la chaine (bilan,
 * loyers, financement, exploitation) viendra avec les modules correspondants.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tableauAmortissement } from '../src/amortissement.js';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} nom @param {string} fichier */
function fixture(nom, fichier) {
  return JSON.parse(readFileSync(join(RACINE, 'fixtures', nom, fichier), 'utf8'));
}

/** Tolerance relative de 0,1 % sur les annuites, avec plancher absolu au centime. */
function tolerance(valeurAttendue) {
  return Math.max(Math.abs(valeurAttendue) * 0.001, 0.01);
}

describe('golden — BERGERAC LLS 6 PLS (matrice LEON 2025-042d)', () => {
  const entrees = fixture('bergerac_lls6_pls', 'entrees.json');
  const attendus = fixture('bergerac_lls6_pls', 'attendus.json');
  const { livret_a_origine, livret_a_par_annee } = entrees.referentiel_amortissement;

  for (const pret of entrees.prets) {
    describe(pret.libelle, () => {
      const obtenu = tableauAmortissement({
        montant_eur: pret.montant_eur,
        taux: pret.taux,
        progressivite: pret.progressivite,
        duree_ans: pret.duree_ans,
        annee_premiere_echeance: pret.annee_premiere_echeance,
        revisabilite: pret.revisabilite,
        differe_ans: pret.differe_ans,
        livret_a_origine,
        livret_a_par_annee,
      });
      const attendu = attendus.prets[pret.code].tableau;

      it('produit une table de meme longueur et sur les memes annees', () => {
        expect(obtenu).toHaveLength(attendu.length);
        expect(obtenu.map((l) => l.annee)).toEqual(attendu.map((l) => l.annee));
      });

      it('applique le taux revise de LEON (SIMPLE : le taux suit le Livret A)', () => {
        for (const [i, ligne] of obtenu.entries()) {
          expect(ligne.taux).toBeCloseTo(attendu[i].taux, 10);
        }
      });

      it('reproduit les annuites a +/-0,1 %', () => {
        for (const [i, ligne] of obtenu.entries()) {
          expect(
            Math.abs(ligne.annuite_eur - attendu[i].annuite_eur),
            `annee ${attendu[i].annee} : ${ligne.annuite_eur} vs ${attendu[i].annuite_eur}`,
          ).toBeLessThanOrEqual(tolerance(attendu[i].annuite_eur));
        }
      });

      it('reproduit interets, amortissement et CRD annee par annee', () => {
        for (const [i, ligne] of obtenu.entries()) {
          const a = attendu[i];
          expect(Math.abs(ligne.interets_eur - a.interets_eur)).toBeLessThanOrEqual(
            tolerance(a.interets_eur),
          );
          expect(Math.abs(ligne.amortissement_eur - a.amortissement_eur)).toBeLessThanOrEqual(
            tolerance(a.amortissement_eur),
          );
          expect(
            Math.abs(ligne.crd_eur - a.crd_eur),
            `CRD annee ${a.annee} : ${ligne.crd_eur} vs ${a.crd_eur}`,
          ).toBeLessThanOrEqual(tolerance(a.crd_eur));
        }
      });

      it('solde exactement le capital emprunte', () => {
        const somme = obtenu.reduce((s, l) => s + l.amortissement_eur, 0);
        expect(somme).toBeCloseTo(pret.montant_eur, 4);
        expect(obtenu.at(-1)?.crd_eur).toBeCloseTo(0, 4);
      });
    });
  }
});
