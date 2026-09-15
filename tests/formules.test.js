// @ts-check
/**
 * Noyau des formules : le langage, le classeur, l'explication.
 *
 * Ces tests ne portent sur aucune regle metier. Ils verrouillent la mecanique
 * sur laquelle TOUTES les regles reposent desormais : un defaut ici fausserait
 * chaque grandeur du moteur en meme temps.
 */
import { describe, it, expect } from 'vitest';
import { analyser, decouper } from '../src/formules/langage.js';
import { creerModele, Classeur, compilerGrandeur } from '../src/formules/classeur.js';

describe('langage - analyse', () => {
  it('lit nombres, textes et constantes', () => {
    expect(analyser('12.5')).toEqual({ t: 'nb', v: 12.5 });
    expect(analyser("'l''annee'")).toEqual({ t: 'txt', v: "l'annee" });
    expect(analyser('VRAI')).toMatchObject({ t: 'cst', v: true });
    expect(analyser('VIDE')).toMatchObject({ t: 'cst', v: null });
  });

  it('respecte les priorites de JavaScript', () => {
    // a + b * c
    expect(analyser('a + b * c')).toMatchObject({ t: 'bin', op: '+', b: { t: 'bin', op: '*' } });
    // -x ^ 2 = -(x ^ 2)
    expect(analyser('-x ^ 2')).toMatchObject({ t: 'neg', a: { t: 'bin', op: '^' } });
    // puissance associative a droite
    expect(analyser('a ^ b ^ c')).toMatchObject({ t: 'bin', op: '^', b: { t: 'bin', op: '^' } });
    // soustraction associative a gauche
    expect(analyser('a - b - c')).toMatchObject({ t: 'bin', op: '-', a: { t: 'bin', op: '-' } });
    // exposant negatif
    expect(analyser('(1 + t) ^ -n')).toMatchObject({ t: 'bin', op: '^', b: { t: 'neg' } });
  });

  it('accepte les symboles de l ecran', () => {
    expect(analyser('a × b ÷ c − d')).toEqual(analyser('a * b / c - d'));
    expect(analyser('a ≤ b')).toEqual(analyser('a <= b'));
  });

  it('lit les indices nommes', () => {
    expect(analyser('crd[annee: annee - 1]')).toMatchObject({
      t: 'nom',
      nom: 'crd',
      index: [{ dim: 'annee', expr: { t: 'bin', op: '-' } }],
    });
  });

  it('lit les agregats, avec DANS et QUAND', () => {
    expect(analyser('SOMME(x POUR lot QUAND tranche_lot = tranche)')).toMatchObject({
      t: 'agr',
      nom: 'SOMME',
      parcours: [{ variable: 'lot', dans: null, quand: { t: 'bin', op: '=' } }],
    });
    expect(analyser('PRODUIT(1 + t POUR a DANS SUITE(1; 3))')).toMatchObject({
      t: 'agr',
      parcours: [{ variable: 'a', dans: { t: 'fn', nom: 'SUITE' } }],
    });
  });

  it('lit plusieurs POUR a la suite, en boucles imbriquees', () => {
    expect(analyser('SOMME(x POUR a POUR b DANS l QUAND b > a)')).toMatchObject({
      t: 'agr',
      parcours: [
        { variable: 'a', dans: null, quand: null },
        { variable: 'b', dans: { t: 'nom', nom: 'l' }, quand: { t: 'bin', op: '>' } },
      ],
    });
  });

  it('refuse ce qui ne se lit pas', () => {
    expect(() => analyser('a +')).toThrow();
    expect(() => analyser('SI(a; b')).toThrow();
    expect(() => analyser('a $ b')).toThrow();
    expect(() => analyser('SOMME(a; b POUR x)')).toThrow(/premier argument/);
    expect(() => decouper("'ouvert")).toThrow(/non ferme/);
  });
});

/** Petit modele de demonstration : des lots, des tranches, des annees. */
const DOMAINES = [
  {
    domaine: 'essai',
    dimensions: {
      lot: { libelle: 'Lot', valeurs: 'INDICES(lots)', etiquette: 'nom_lot' },
      tranche: { libelle: 'Tranche', valeurs: 'codes' },
      annee: { libelle: 'Année', valeurs: 'SUITE(debut; debut + 2)' },
      an: { libelle: 'Année civile' },
    },
    grandeurs: {
      lots: { libelle: 'Lots', saisie: 'lots' },
      codes: { libelle: 'Tranches', saisie: 'codes' },
      debut: { libelle: 'Début', saisie: 'debut' },
      nom_lot: { libelle: 'Nom', sur: ['lot'], saisie: 'lots[lot].nom' },
      shab_lot: { libelle: 'SHAB', unite: 'm2', sur: ['lot'], saisie: 'lots[lot].shab' },
      tranche_lot: { libelle: 'Tranche du lot', sur: ['lot'], saisie: 'lots[lot].code' },
      coef: { libelle: 'Coefficient', parametre: 'coef' },
      su_lot: { libelle: 'SU', sur: ['lot'], formule: 'shab_lot * coef' },
      su_tranche: {
        libelle: 'SU de la tranche',
        sur: ['tranche'],
        formule: 'SOMME(su_lot POUR lot QUAND tranche_lot = tranche)',
      },
      su_totale: { libelle: 'SU totale', formule: 'SOMME(su_tranche POUR tranche)' },
      qp: { libelle: 'Quote-part', sur: ['tranche'], formule: 'su_tranche / su_totale' },
      cumul: {
        libelle: 'Cumul',
        sur: ['annee'],
        formule: 'SI(annee = debut; 1; cumul[annee: annee - 1] * 2)',
      },
      hors: { libelle: 'Hors', formule: 'cumul[annee: debut - 1]' },
      prudent: { libelle: 'Prudent', formule: 'SI(su_totale > 0; 1; 1 / 0)' },
      boucle_a: { libelle: 'A', formule: 'boucle_b + 1' },
      boucle_b: { libelle: 'B', formule: 'boucle_a + 1' },
      parts: { libelle: 'Parts', sur: ['tranche'], formule: 'REPARTIR(su_tranche / 3 POUR tranche)' },
      premier_grand: {
        libelle: 'Premier grand lot',
        formule: 'PREMIER(lot POUR lot QUAND shab_lot > 50)',
      },
      su_croisee: {
        libelle: 'SU croisée',
        formule: 'SOMME(su_lot POUR tranche POUR lot QUAND tranche_lot = tranche)',
      },
      taux_an: { libelle: 'Taux de l année', sur: ['an'], parametre: 'taux[an]' },
      taux_lu: { libelle: 'Taux lu', formule: 'taux_an[an: 2030]' },
      mauvaise: { libelle: 'Mauvaise', formule: 'su_lot' },
    },
  },
];

const CONTEXTE = {
  entrees: {
    lots: [
      { nom: 'A', shab: 40, code: 'PLAI' },
      { nom: 'B', shab: 60, code: 'PLUS' },
      { nom: 'C', shab: 20, code: 'PLAI' },
    ],
    codes: ['PLAI', 'PLUS'],
    debut: 2028,
  },
  baremes: { coef: 1.5, taux: { 2030: 0.02 } },
};

describe('classeur - evaluation', () => {
  const modele = creerModele(DOMAINES);
  const c = new Classeur(modele, CONTEXTE);

  it('lit les saisies et les parametres', () => {
    expect(c.valeur('shab_lot', { lot: 1 })).toBe(60);
    expect(c.valeur('coef')).toBe(1.5);
    expect(c.valeur('taux_lu')).toBe(0.02);
  });

  it('decline une formule sur une dimension, et agrege avec QUAND', () => {
    expect(c.valeur('su_lot', { lot: 0 })).toBe(60);
    expect(c.valeur('su_tranche', { tranche: 'PLAI' })).toBe(90);
    expect(c.valeur('su_totale')).toBe(180);
    expect(c.valeur('qp', { tranche: 'PLUS' })).toBe(0.5);
  });

  it('lit une autre valeur de la dimension, et rend INDEFINI hors dimension', () => {
    expect(c.valeur('cumul', { annee: 2030 })).toBe(4);
    expect(c.valeur('hors')).toBeUndefined();
  });

  it('parcourt plusieurs variables avec un seul accumulateur', () => {
    // Tranche par tranche, lot par lot : 60 + 30 (PLAI) puis 90 (PLUS).
    expect(c.valeur('su_croisee')).toBe(180);
    const e = c.expliquer('su_croisee');
    expect(e.arbre.v).toBe(180);
    expect(e.arbre.termes.map((x) => x.cle)).toEqual([['PLAI', 0], ['PLAI', 2], ['PLUS', 1]]);
  });

  it('n evalue que la branche retenue', () => {
    expect(c.valeur('prudent')).toBe(1);
  });

  it('signale une dependance circulaire au lieu de boucler', () => {
    expect(() => c.valeur('boucle_a')).toThrow(/circulaire/);
  });

  it('repartit sans perdre un euro', () => {
    // 90/3 = 30 et 90/3 = 30 : repartition exacte, puis un cas a reste.
    const parts = ['PLAI', 'PLUS'].map((t) => c.valeur('parts', { tranche: t }));
    expect(parts.reduce((s, v) => s + v, 0)).toBe(60);
  });

  it('s arrete au premier terme qui remplit la condition', () => {
    expect(c.valeur('premier_grand')).toBe(1);
  });

  it('refuse une dimension non liee a la compilation', () => {
    expect(() => compilerGrandeur(modele, modele.grandeur('mauvaise'))).toThrow(/lot/);
  });

  it('laisse forcer une cellule, dont la formule n est alors pas lue', () => {
    const f = new Classeur(modele, CONTEXTE);
    f.fixer('su_tranche', { tranche: 'PLAI' }, 1000);
    // 1 000 forces sur le PLAI, 60 x 1,5 = 90 calcules sur le PLUS.
    expect(f.valeur('su_totale')).toBe(1090);
  });

  it('laisse forcer les valeurs d une dimension', () => {
    const f = new Classeur(modele, CONTEXTE);
    f.fixerDimension('tranche', ['PLUS']);
    expect(f.valeur('su_totale')).toBe(90);
  });

  it('etiquette une valeur de dimension', () => {
    expect(c.etiquette('lot', 2)).toBe('C');
    expect(c.etiquette('tranche', 'PLAI')).toBe('PLAI');
  });
});

describe('classeur - explication', () => {
  const modele = creerModele(DOMAINES);
  const c = new Classeur(modele, CONTEXTE);

  it('rejoue la formule et retombe sur la valeur calculee', () => {
    for (const [id, indices] of [
      ['qp', { tranche: 'PLAI' }],
      ['su_totale', {}],
      ['cumul', { annee: 2030 }],
      ['parts', { tranche: 'PLUS' }],
      ['premier_grand', {}],
    ]) {
      const e = c.expliquer(/** @type {string} */ (id), /** @type {any} */ (indices));
      expect(e.arbre.v, id).toBe(e.v);
    }
  });

  it('decrit chaque bloc : reference, operateur, agregat', () => {
    const e = c.expliquer('qp', { tranche: 'PLUS' });
    expect(e.nature).toBe('formule');
    expect(e.arbre).toMatchObject({
      t: 'bin',
      op: '/',
      a: { t: 'ref', id: 'su_tranche', dims: { tranche: 'PLUS' }, v: 90 },
      b: { t: 'ref', id: 'su_totale', v: 180 },
      v: 0.5,
    });
    const s = c.expliquer('su_tranche', { tranche: 'PLAI' });
    expect(s.arbre.t).toBe('agr');
    expect(s.arbre.termes.map((x) => x.cle)).toEqual([0, 2]);
  });

  it('montre la branche ecartee sans la calculer', () => {
    const e = c.expliquer('prudent');
    expect(e.arbre.args[2].ecarte).toBe(true);
  });

  it('dit d ou vient une saisie', () => {
    const e = c.expliquer('shab_lot', { lot: 1 });
    expect(e).toMatchObject({ nature: 'saisie', chemin: 'lots[1].shab', v: 60 });
  });
});
