// @ts-check
/**
 * Adaptation du referentiel de trajectoires macro vers la forme consommee par
 * le moteur.
 *
 * Le fichier `referentiels/trajectoires_axentia_2026.json` stocke une LIGNE PAR
 * ANNEE (`trajectoires: [{annee, loyers_irl, tfpb, livret_a, ...}]`), forme
 * naturelle pour un referentiel versionne et relisible. Les modules de calcul,
 * eux, consomment un DICTIONNAIRE PAR POSTE (`{2028: 0.02, 2029: 0.021}`), forme
 * naturelle pour une indexation annee par annee.
 *
 * Sans cette conversion, `trajectoires.loyers_irl` vaut `undefined`, l'indexation
 * retombe silencieusement a 0 et le profil AXENTIA n'est jamais applique : c'est
 * un defaut qui ne leve aucune erreur et ne se voit que sur les montants. D'ou
 * ce module dedie et son test qui charge le fichier reel.
 *
 * Unites : taux en fraction, annees civiles entieres.
 */

/** Postes portes par une ligne de trajectoire (tout sauf l'annee elle-meme). */
const POSTES = [
  'gros_entretien',
  'gestion',
  'vacance_impayes',
  'loyers_irl',
  'frais_financiers',
  'produits_financiers',
  'tfpb',
  'livret_a',
  'rel',
  'crl',
];

/**
 * @typedef {Object} TrajectoiresMoteur
 * @property {string} [profil]
 * @property {string} [source]
 * @property {number|undefined} taux_reference_livret_a  LA d'origine des prets (LA_0)
 * @property {Record<number, number>} livret_a_par_annee
 * @property {number} annee_min
 * @property {number} annee_max
 * @property {Record<string, Record<number, number>>} par_poste
 */

/**
 * Convertit le referentiel versionne en trajectoires exploitables par le moteur.
 *
 * Les annees postérieures a la derniere ligne ne sont PAS extrapolees ici : les
 * consommateurs (`facteurIndexation`, `livretAPourAnnee`) reconduisent d'eux-memes
 * la derniere valeur connue, comme le VLOOKUP approche de LEON. C'est important
 * car l'horizon des prets fonciers (60 ans) depasse celui de la table.
 *
 * @param {any} referentiel contenu de trajectoires_axentia_2026.json
 * @returns {TrajectoiresMoteur}
 */
export function adapterTrajectoires(referentiel) {
  const lignes = referentiel?.trajectoires;
  if (!Array.isArray(lignes) || lignes.length === 0) {
    throw new Error(
      "Referentiel de trajectoires invalide : cle `trajectoires` absente ou vide. " +
        'Attendu : [{annee, loyers_irl, tfpb, livret_a, ...}].',
    );
  }

  /** @type {Record<string, Record<number, number>>} */
  const parPoste = {};
  for (const poste of POSTES) parPoste[poste] = {};

  let anneeMin = Infinity;
  let anneeMax = -Infinity;

  for (const ligne of lignes) {
    const annee = Number(ligne.annee);
    if (!Number.isInteger(annee)) {
      throw new Error(`Ligne de trajectoire sans annee civile exploitable : ${JSON.stringify(ligne)}`);
    }
    anneeMin = Math.min(anneeMin, annee);
    anneeMax = Math.max(anneeMax, annee);
    for (const poste of POSTES) {
      const v = ligne[poste];
      // `null` est une valeur legitime du referentiel (poste non renseigne cette
      // annee-la) : on ne l'inscrit pas, la reconduction fera son office.
      if (typeof v === 'number') parPoste[poste][annee] = v;
    }
  }

  return {
    profil: referentiel.profil,
    source: referentiel.source,
    // LA de reference des prets. Le referentiel ne porte aujourd'hui que
    // `taux_livret_a_courant` ; la matrice LEON utilise `ParaGEN!DD20` (« Taux
    // reference LA »), qui en differe. Ecart ouvert : QUESTIONS_SPEC Q-7 et Q-8.
    taux_reference_livret_a: referentiel.taux_reference_livret_a ?? referentiel.taux_livret_a_courant,
    livret_a_par_annee: parPoste.livret_a,
    annee_min: anneeMin,
    annee_max: anneeMax,
    par_poste: parPoste,
  };
}

/**
 * Vrai si l'objet est deja au format attendu par le moteur (deja adapte).
 * Permet aux appelants de passer indifferemment le fichier brut ou son adaptation.
 * @param {any} t
 * @returns {boolean}
 */
export function dejaAdaptees(t) {
  return Boolean(t && typeof t === 'object' && t.par_poste && t.livret_a_par_annee);
}

/**
 * Normalise une entree de trajectoires : accepte le fichier referentiel brut,
 * un objet deja adapte, ou un objet vide (aucune indexation).
 * @param {any} t
 * @returns {TrajectoiresMoteur}
 */
export function normaliserTrajectoires(t) {
  if (dejaAdaptees(t)) return t;
  if (Array.isArray(t?.trajectoires)) return adapterTrajectoires(t);
  // Forme libre `{loyers_irl: 0.02, ...}` utilisee par les tests et les exemples :
  // on la laisse passer telle quelle, les consommateurs acceptent un taux constant.
  return {
    profil: undefined,
    source: undefined,
    taux_reference_livret_a: t?.taux_reference_livret_a ?? t?.taux_livret_a_courant,
    livret_a_par_annee: t?.livret_a_par_annee ?? {},
    annee_min: NaN,
    annee_max: NaN,
    par_poste: t ?? {},
  };
}
