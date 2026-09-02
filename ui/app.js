// @ts-check
/**
 * Interface de montage d'operation : saisie, plan de financement, parametres.
 *
 * Importe `src/moteur.js` TEL QUEL : le moteur est de l'ESM pur, il tourne dans
 * le navigateur sans build ni transpilation (exigence CLAUDE.md §3).
 *
 * Cette couche ne contient AUCUNE regle de calcul et NE RECALCULE RIEN. Tout
 * nombre affiche, totaux compris, vient du resultat du moteur. Un total recalcule
 * ici derive du total du moteur des qu'un arrondi entre en jeu, et donne deux
 * chiffres differents pour la meme grandeur sur le meme ecran.
 *
 * Ergonomie reprise de la maquette LEON REWORK : ecrans separes, unites dans les
 * libelles, blocs du general au particulier, notes de renvoi prefixees d'un
 * engrenage. Correction du seul defaut de la maquette : elle ne distingue pas le
 * saisi du calcule, ici tout champ calcule est grise et non focusable.
 *
 * Un seul fichier a dessein : le generateur de la version autonome concatene tout
 * dans une portee unique et refuse les collisions de noms racine.
 */
import { calculer } from '../src/moteur.js';
import { produitsOrdonnes, ORDRE_PRODUITS } from '../src/produits.js';
import { arrondirEnConservantLaSomme } from '../src/arrondis.js';
import { ecartsParametrage } from '../src/parametrage.js';
import { tauxLASM } from '../src/bilan.js';
import { sommerComptes, indicateursExploitation } from '../src/exploitation.js';
import {
  LEVIERS,
  INDICATEURS,
  OBJECTIFS,
  balayerLevier,
  chercherEquilibre,
  indicateurDe,
  levierDe,
  objectifDe,
  optimiser,
  plage,
  scenarios,
  tornade,
} from '../src/sensibilite.js';
// Le depot est importe par NOMS et non en bloc : le generateur de la version
// autonome concatene les modules dans une portee unique, ou un espace de noms
// (`depot.lister`) n'existerait plus. Les noms y sont donc prefixes.
import {
  listerSimulations, lireSimulation, ecrireSimulation, ajouterSimulation,
  supprimerSimulation, renommerSimulation, simulationCourante, ouvrirSimulation,
  reprendreHeritage,
} from './depot.js';

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

// __REFERENTIELS_DEBUT__ (bloc remplace par des litteraux dans la version autonome)
const referentiels = {
  baremes: await (await fetch('../referentiels/baremes_her_2027.json')).json(),
  // Profil EN VIGUEUR (HER 2027). Le profil precedent reste au depot : les
  // golden tests s'y adossent, ils reproduisent la matrice qui le portait.
  trajectoires: await (await fetch('../referentiels/trajectoires_her_2027.json')).json(),
  nomenclature_pdr: await (await fetch('../referentiels/nomenclature_pdr.json')).json(),
  zonage_abc: await (await fetch('../referentiels/zonage_abc_communes.json')).json(),
  departements: await (await fetch('../referentiels/departements.json')).json(),
};
// __REFERENTIELS_FIN__

/**
 * Postes de prix de revient : la nomenclature complete est PRESENTE d'emblee,
 * on ne remplit que les lignes utiles. C'est la logique de la maquette : on
 * cherche sa ligne dans une liste connue plutot que de la creer et de la nommer,
 * ce qui garantit que deux operations restent comparables poste a poste.
 *
 * Un montant vide vaut « poste non utilise » et non zero : ces lignes ne sont
 * pas transmises au moteur.
 */
function nomenclatureEnPostes(valeursInitiales = {}) {
  const tauxDefaut = referentiels.baremes.tva.taux_reduit_simulation;
  return referentiels.nomenclature_pdr.chapitres.flatMap((ch) =>
    ch.postes.map((p) => ({
      id: p.id,
      numero: p.numero,
      chapitre: ch.code,
      libelle: p.libelle,
      montant_ht_eur: valeursInitiales[p.id]?.montant_ht_eur ?? null,
      taux_tva: valeursInitiales[p.id]?.taux_tva ?? tauxDefaut,
      // R-TVA-2 : un poste HORS CHAMP de la livraison a soi-meme garde son TTC
      // de saisie au lieu d'etre recalcule au taux du produit. La propriete
      // n'est posee que quand elle est vraie, pour que les quarante-cinq autres
      // postes restent des objets identiques a ce qu'ils etaient.
      ...(valeursInitiales[p.id]?.hors_lasm ? { hors_lasm: true } : {}),
    })),
  );
}

/** Typologies proposees a la saisie, reprises de l'onglet LOTS de la maquette. */
const TYPOLOGIES = ['T1', "T1'", 'T1 bis', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

/**
 * Repartit une surface TOTALE entre N lots, en conservant exactement la somme.
 *
 * Diviser puis arrondir chaque part ferait deriver le total (six lots de
 * 66,666 m2 donnent 399,96 et non 400) : le reliquat de centimetres carres est
 * distribue aux premiers lots. C'est la meme discipline que
 * `arrondirEnConservantLaSomme` cote moteur, appliquee aux surfaces.
 *
 * @param {{code_produit: string, nombre: number, shab_totale: number,
 *          annexes_totales?: number, typologie?: string, batiment?: string,
 *          etage?: string}} p
 * @returns {Array<Object>} lots, un par logement
 */
function repartirEnLots({ code_produit, nombre, shab_totale, annexes_totales = 0, typologie = '', batiment = '', etage = '' }) {
  const n = Math.max(1, Math.round(nombre));
  const partager = (total) => {
    const centiemes = Math.round((Number(total) || 0) * 100);
    const base = Math.floor(centiemes / n);
    const reste = centiemes - base * n;
    return Array.from({ length: n }, (_, i) => (base + (i < reste ? 1 : 0)) / 100);
  };
  const shab = partager(shab_totale);
  const annexes = partager(annexes_totales);
  return Array.from({ length: n }, (_, i) => ({
    code_produit,
    // Chaque lot est UN logement : c'est ce qui alimente le nombre de logements
    // de la tranche, donc le coefficient de structure.
    nb_logements: 1,
    typologie,
    batiment,
    etage,
    shab_m2: shab[i],
    surfaces_annexes_m2: annexes[i],
  }));
}

// ---------------------------------------------------------------- charges diverses

/** Catalogue des cotisations et charges diverses, lu au referentiel (Q-16). */
const CATALOGUE_CHARGES = referentiels.baremes.charges_exploitation?.postes ?? [];

/** Assiettes exprimees en TAUX : la saisie et l'affichage se font en pourcentage. */
const ASSIETTES_EN_TAUX = new Set([
  'produits_locatifs_bruts',
  'produits_locatifs_nets',
  'prix_revient_ttc',
]);

/** Libelles d'assiette, pour que la colonne dise sur QUOI porte la valeur. */
const LIBELLES_ASSIETTE = {
  logement: 'par logement et par an',
  produits_locatifs_bruts: 'des produits locatifs bruts',
  produits_locatifs_nets: 'des produits locatifs nets',
  shab: 'par m² SHAB et par an',
  prix_revient_ttc: 'du prix de revient TTC',
  forfait: 'forfait annuel',
};

// ---------------------------------------------------------------- etat initial

/**
 * Operation de depart, calquee sur la structure OP-3.
 *
 * Aucun taux de Livret A n'est fige ici : le moteur applique celui du referentiel.
 * Une valeur codee a cet endroit ecraserait le referentiel et ferait diverger deux
 * prets pourtant identiques a l'ecran.
 */
const etat = {
  identite: {
    nom: 'Opération de test',
    // Groupe : le PROJET auquel la simulation appartient. Une meme operation
    // se simule souvent plusieurs fois - variantes de programme, de montage,
    // d'hypotheses - et ces essais n'ont de sens que rassembles.
    groupe: 'OP-3 LLS 6',
    commune: 'OP-3',
    departement: 'Dordogne (24)',
    produit: 'PLS',
    zone_123: 2,
    zone_ABC: 'B1',
    type_operation: 'VEFA',
  },
  dates: {
    date_debut_travaux: '2026-01-01',
    duree_chantier_mois: 24,
    date_livraison: null,
    // 50 ans : l'horizon standard du compte d'exploitation (CLAUDE.md §4),
    // qui couvre aussi la duree des prets fonciers de l'operation de depart.
    duree_simulation_ans: 50,
  },
  // Un lot = un logement. Le coefficient de structure et le loyer restent
  // calcules par le moteur sur la TRANCHE entiere (R-SURF-2) : le decoupage en
  // lots est une commodite de saisie, il n'influe sur aucun calcul.
  lots: repartirEnLots({ code_produit: 'PLS', nombre: 6, shab_totale: 400, annexes_totales: 40, typologie: 'T2', batiment: 'A' }),
  // Quatorze postes renseignes sur les quarante-six de la nomenclature, soit
  // l'ordre de grandeur d'une operation reelle : assez pour que les chapitres,
  // les sous-totaux et les jauges aient tous de la matiere, pas au point de
  // laisser croire qu'il faut tout remplir.
  postes_bilan: nomenclatureEnPostes({
    // I - Charge fonciere
    cf_acquisition: { montant_ht_eur: 642780, taux_tva: 0.055 },
    cf_sondages: { montant_ht_eur: 6500, taux_tva: 0.2 },
    cf_vrd: { montant_ht_eur: 48000, taux_tva: 0.1 },
    cf_branchements: { montant_ht_eur: 14500, taux_tva: 0.1 },
    cf_taxe_assainissement: { montant_ht_eur: 9200, taux_tva: 0 },
    cf_notaire: { montant_ht_eur: 12000, taux_tva: 0.055 },
    cf_taxes_amenagement: { montant_ht_eur: 21400, taux_tva: 0 },
    // II - Batiment
    bat_travaux: { montant_ht_eur: 1180000, taux_tva: 0.1 },
    bat_actualisation: { montant_ht_eur: 34000, taux_tva: 0.1 },
    bat_aleas: { montant_ht_eur: 29500, taux_tva: 0.1 },
    // III - Honoraires
    hon_architecte: { montant_ht_eur: 18000, taux_tva: 0.2 },
    hon_bureau_etudes: { montant_ht_eur: 42000, taux_tva: 0.2 },
    hon_controleur: { montant_ht_eur: 11800, taux_tva: 0.2 },
    hon_assurances: { montant_ht_eur: 16300, taux_tva: 0.2 },
  }),
  // Parametres de loyer PAR TRANCHE : c'est leur niveau naturel, le CS et le
  // plafond ne se calculent qu'a ce niveau.
  loyers_par_produit: {
    PLS: { marge_majoration: 0, marge_locale_eur_m2: 0, loyer_sortie_force: null },
  },
  subventions: [{ libelle: 'Ville', montant_eur: 20000, affectation: 'PLS' }],
  // Aucun apport fige : il se preremplit a la part du referentiel (5 % du prix
  // de revient, 2 % en redevance transparente). Un montant en dur ici aurait
  // masque cette regle dans l'operation de demonstration, qui est justement ce
  // qu'on ouvre pour la decouvrir.
  fonds_propres_par_produit: {},
  // R-FIN-7 : taux d'apport surcharge, tranche par tranche. Vide, c'est la
  // part du referentiel qui s'applique.
  taux_apport_par_produit: {},
  // R-FIN-7 : regime des fonds propres, tranche par tranche.
  remuneration_fonds_propres: {},
  // R-EXP-7 : regime de produits par tranche, loyers ou redevance.
  regimes_par_produit: {},
  // R-TRESO-2 : indexation des depenses de chantier, hypothese de simulation.
  tresorerie: {},
  mode_prets: 'saisis',
  // Les prets CDC de chaque tranche sont crees a la volee par
  // `pretsCDCParDefaut`, en montant AUTOMATIQUE : rien n'est fige au depart.
  prets: [],
  exploitation: {
    frais_gestion_pct_loyers: 0.07,
    taux_vacance_impayes: 0.02,
    gros_entretien_eur_m2: 5,
    // Q-16 : le catalogue du referentiel est presente en entier, tout inactif.
    // Une simulation ne doit jamais changer de resultat parce qu'un poste a ete
    // ajoute au referentiel entre deux ouvertures.
    charges_diverses: CATALOGUE_CHARGES.map((c) => ({ code: c.code, actif: false, valeur: c.valeur })),
    mode: 'loyers',
    mode_redevance: 'forfaitaire',
    redevance_annuelle_eur: null,
    redevance_annee_valeur: null,
  },
  // Profils de parametres (R-PARAM). Le premier est le referentiel du depot :
  // surcharge vide, non modifiable, il sert de point de comparaison. Les
  // surcharges sont portees par la SIMULATION et non par un reglage global -
  // une grille tarifaire modifiee doit voyager avec le dossier, sinon le meme
  // fichier rejoue ailleurs ne donnerait pas les memes annuites.
  // AXENTIA HER 2027 EST le referentiel du depot : ses valeurs sont dans
  // `baremes_her_2027.json` et `trajectoires_her_2027.json`, pas dans une
  // surcharge. Ce profil de base ne surcharge donc rien, et n'est pas
  // modifiable - editer un parametre en derive une copie.
  profils: [
    { id: 'referentiel', nom: 'AXENTIA HER 2027 (référentiel)', parametrage: {} },
  ],
  profil_actif: 'referentiel',
  options: {},
};

// ---------------------------------------------------------------- mise en forme

const fEuro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fNombre = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });

const nul = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
const eur = (v) => (nul(v) ? '-' : fEuro.format(v));
/**
 * Pourcentage en ecriture francaise : « 97,3 % » et non « 97.3 % ».
 * `toFixed` produit un point decimal, seul reliquat anglo-saxon d'un ecran ou
 * tous les autres nombres passent par `Intl`. Un formateur par nombre de
 * decimales, memoise : en construire un a chaque appel coute cher en boucle.
 */
const FORMATS_PCT = {};
const pct = (v, d = 2) => {
  if (nul(v)) return '-';
  FORMATS_PCT[d] ??= new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
  return `${FORMATS_PCT[d].format(v * 100)} %`;
};
const nb = (v) => (nul(v) ? '-' : fNombre.format(v));

/**
 * Palette des barres emplois/ressources. Elle passe par les tokens de la charte
 * (`--cat-N`, accents d'etat) et non par des hexadecimaux : une couleur ecrite
 * en dur ici resterait celle du theme sombre quand on bascule en clair.
 * Lue au calcul et non a la declaration, pour suivre le theme courant.
 */
// Teintes choisies pour se DISTINGUER LES UNES DES AUTRES a l'interieur d'une
// meme barre, pas pour se ressembler : deux bleus voisins rendaient deux
// chapitres indiscernables. Emplois et ressources formant deux listes separees,
// une meme teinte peut servir dans les deux sans creer de confusion.
const TOKENS_COULEUR = {
  // Emplois : bleu, ambre, vert, violet, corail, gris.
  charge_fonciere: '--cat-1',
  batiment: '--cat-2',
  honoraires: '--success-accent',
  frais_divers: '--purple-accent',
  frais_financiers: '--coral-accent',
  modulation: '--cat-6',
  // Ressources : vert, ambre, bleu, violet, corail.
  subventions: '--success-accent',
  fonds_propres: '--cat-2',
  pret_construction: '--cat-1',
  pret_foncier: '--purple-accent',
  pret_autre: '--coral-accent',
};
const couleur = (cle) =>
  getComputedStyle(document.documentElement).getPropertyValue(TOKENS_COULEUR[cle] ?? '--cat-6').trim() ||
  '#94a3b8';
/** Proxy de compatibilite : `COULEURS.batiment` reste ecrit tel quel dans les vues. */
const COULEURS = new Proxy({}, { get: (_, cle) => couleur(String(cle)) });

/**
 * Identite couleur d'une TRANCHE, stable d'un ecran a l'autre : l'onglet, le
 * bloc, la ligne de pret, la ligne de lot et la colonne du prix de revient d'un
 * meme produit portent la meme teinte.
 *
 * La correspondance est EXPLICITE, et non deduite du rang du produit dans
 * l'ordre canonique : deduite, elle rebattait toutes les couleurs des qu'un
 * produit s'ajoutait a la liste - l'arrivee des foyers avait ainsi repeint le
 * LLI et le libre. Un produit garde desormais sa couleur pour de bon.
 *
 * Un foyer prend la teinte de son financement : FPLUS est un PLUS pose sur un
 * batiment collectif, pas une sixieme famille.
 */
const CAT_PAR_PRODUIT = {
  PLAI: 'plai',
  FPLAI: 'plai',
  PLUS: 'plus',
  PLUS33: 'plus',
  FPLUS: 'plus',
  PLS: 'pls',
  FPLS: 'pls',
  LOC: 'lli',
  LIBRE: 'libre',
  REHAB: 'rehab',
};

/**
 * Deux roles, deux jetons, pour une meme identite :
 * - `catProduit` est le TRAIT et le TEXTE. Il doit tenir sur le fond de la page,
 *   donc il s'assombrit en theme clair.
 * - `catFondProduit` est le FOND. C'est le pastel d'origine, identique dans les
 *   deux themes : c'est lui qui porte la teinte que l'on reconnait.
 * Les confondre obligeait a choisir entre une couleur lisible et une couleur
 * juste ; les separer permet d'avoir les deux.
 */
const catProduit = (code) => `var(--prod-${CAT_PAR_PRODUIT[code] ?? 'autre'})`;
const catFondProduit = (code) => `var(--prod-${CAT_PAR_PRODUIT[code] ?? 'autre'}-fond)`;

/**
 * FAMILLES de produits, deduites de la palette : un foyer PLAI est un PLAI, un
 * PLUS 33 % est un PLUS. La couleur le dit deja, et une liste qui separerait
 * PLAI de FPLAI demanderait de cocher deux cases pour une seule realite de
 * financement. Derivee de la palette plutot que reecrite, pour qu'ajouter un
 * produit a une couleur suffise a l'y ranger.
 */
const FAMILLES_PRODUIT = (() => {
  /** @type {Map<string, string[]>} */
  const par = new Map();
  for (const code of ORDRE_PRODUITS) {
    const cle = CAT_PAR_PRODUIT[code] ?? 'autre';
    if (!par.has(cle)) par.set(cle, []);
    par.get(cle).push(code);
  }
  // Le libelle de la famille est celui de son PREMIER produit dans l'ordre
  // canonique : PLAI pour {PLAI, FPLAI}, PLUS pour {PLUS, PLUS33, FPLUS}.
  return [...par.entries()].map(([cle, codes]) => ({ cle, codes, chef: codes[0] }));
})();

/**
 * Libelles de chapitre DERIVES de la nomenclature, jamais recopies : une table
 * codee ici finirait par en diverger. C'est ainsi que « Frais financiers », le
 * cinquieme chapitre, manquait a la restitution.
 */
const CHAPITRES = Object.fromEntries(
  referentiels.nomenclature_pdr.chapitres.map((c) => [c.code, c.libelle]),
);

const OPTIONS_REVISABILITE = ['DOUBLE', 'D. LIMITEE', 'SIMPLE', 'TAUX FIXE'];
const OPTIONS_DIFFERE = [
  { v: 2, l: "2 - intérêts seuls" },
  { v: 1, l: "1 - rien n'est dû" },
];
/**
 * Taux de TVA PAR DEFAUT d'une tranche : celui que le moteur resout pour son
 * produit (R-TVA-2). Il preselectionne la cellule ; la LISTE proposee, elle,
 * vient de `tauxAdmis` et couvre tout le parametrage, sans filtre par produit.
 */
function tauxProduit(code) {
  // Le taux resolu par le MOTEUR, qui a deja fusionne le profil de parametres :
  // le relire au referentiel brut ignorerait un taux regle a l'ecran.
  const t = dernierResultat?.bilan?.taux_lasm_par_tranche?.[code];
  if (t !== undefined) return t;
  try {
    return tauxLASM(code, referentiels.baremes, { qpv: etat.identite?.qpv === true });
  } catch {
    return referentiels.baremes.tva.taux_normal;
  }
}
/**
 * Taux de TVA proposes a la saisie : TOUS ceux que le parametrage connait,
 * quel que soit le produit de la tranche (decision metier du 17/08/2026 - la
 * liste par produit obligeait a passer par « hors bareme » pour des cas
 * legitimes, un PLUS en QPV a 5,5 % par exemple). Zero reste propose, c'est le
 * poste hors champ. La lecture passe par le profil : un taux regle dans
 * l'ecran d'administration apparait ici tel quel.
 */
function tauxAdmis() {
  const brut = referentiels.baremes.tva;
  const lu = (chemin, defaut) => {
    const s = surchargeDe(`baremes.tva.${chemin}`);
    return s === undefined || s === null || s === '' ? defaut : Number(s);
  };
  const taux = [
    0,
    lu('taux_normal', brut.taux_normal),
    lu('taux_reduit_simulation', brut.taux_reduit_simulation),
    lu('taux_reduit_social', brut.taux_reduit_social),
    lu('plus_en_qpv.taux', brut.plus_en_qpv?.taux),
  ];
  for (const [code, v] of Object.entries(brut.lasm_par_produit ?? {})) {
    if (typeof v !== 'number') continue;
    taux.push(lu(`lasm_par_produit.${code}`, v));
  }
  return [...new Set(taux.filter((v) => Number.isFinite(v)))].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- utilitaires

function ecrireChemin(cible, chemin, valeur) {
  const cles = chemin.split('.');
  let ref = cible;
  for (let i = 0; i < cles.length - 1; i++) {
    const cle = cles[i];
    // Cree les niveaux manquants : `postes_bilan.3.montants_ht_par_produit.PLS`
    // doit pouvoir s'ecrire meme si le dictionnaire de tranches n'existe pas
    // encore. Sans cela la frappe leve au lieu d'ecrire.
    //
    // Le niveau cree est un TABLEAU quand la cle suivante est un indice. Un
    // objet `{2: 12}` la ou le referentiel porte une liste ferait remplacer la
    // liste entiere a la fusion, et les quatre autres zones d'un bareme
    // disparaitraient pour une seule corrigee.
    if (ref[cle] === undefined || ref[cle] === null) {
      ref[cle] = /^\d+$/.test(cles[i + 1]) ? [] : {};
    }
    ref = ref[cle];
  }
  ref[cles.at(-1)] = valeur;
}

function lireChemin(cible, chemin) {
  return chemin.split('.').reduce((o, cle) => (o == null ? undefined : o[cle]), cible);
}

/** Echappe le texte destine a un attribut HTML (les libelles sont libres). */
function att(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

const valNum = (v) => (nul(v) ? '' : v);

/**
 * Montants a la saisie : groupes par milliers, « 642 780 » et non « 642780 ».
 *
 * Un `<input type="number">` ne peut PAS l'afficher - il refuse toute valeur
 * contenant un espace et vide la case. Les cellules de montant sont donc du
 * TEXTE, avec `inputmode` pour garder le pave numerique sur mobile, et le
 * groupement se fait ici. Corollaire : ce que le navigateur nous rend est une
 * chaine ecrite a la francaise, qu'il faut relire avant de la donner au moteur.
 */
const fMontantSaisie = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
const valMontant = (v) => (nul(v) ? '' : att(fMontantSaisie.format(v)));

/**
 * Relit un montant saisi. Tolere les espaces de groupement sous leurs trois
 * formes - l'espace fine insecable qu'`Intl` produit en francais, l'insecable
 * ordinaire d'un copier-coller depuis Excel, l'espace simple d'une frappe - et
 * la virgule decimale.
 * @returns {number|null|undefined} le montant, `null` si la case est vide,
 *   `undefined` si la frappe n'est pas encore un nombre (« 12- », « , »).
 */
function lireMontant(texte) {
  const net = String(texte ?? '').replace(/[\s   ]/g, '').replace(',', '.');
  if (net === '') return null;
  const n = Number(net);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * La TVA occupe une colonne par tranche : on doit pouvoir la replier.
 *
 * L'etat vit ICI et non dans la case a cocher : l'attribut `checked` du HTML ne
 * decide que de la valeur initiale, et le navigateur restaure parfois l'etat
 * d'un rechargement par-dessus. La colonne disparaissait alors sans raison.
 */
let tvaVisible = true;
const afficherTVA = () => tvaVisible;

/**
 * Zonage deduit de la commune et du departement.
 *
 * Le zonage n'est pas une opinion : il est fixe par arrete, et il commande le
 * loyer plafond, donc le loyer de sortie, donc tout l'equilibre. Le referentiel
 * ne contient que des communes ATTESTEES ; une commune inconnue est dite comme
 * telle et laissee a la saisie, plutot que devinee depuis son departement.
 *
 * @param {string} commune
 * @param {string} departement peut valoir « Dordogne (24) » : seuls les chiffres comptent
 * @returns {{zone_123: number, zone_ABC: string, nom: string, source: string}|null}
 */
function codeDepartement(departement) {
  if (!departement) return null;
  // Le departement est stocke sous la forme « Nom (code) ». Le code se lit
  // ENTRE PARENTHESES et non par les premiers chiffres rencontres : la Corse
  // s'ecrit 2A et 2B, et « Corse-du-Sud (2A) » donnerait sinon « 2 ».
  return (
    String(departement).match(/\(([0-9AB]{2,3})\)/)?.[1] ??
    String(departement).match(/^[0-9AB]{2,3}$/)?.[0] ??
    null
  );
}

/** Communes d'un departement, triees, telles que les nomme l'arrete. */
function communesDuDepartement(departement) {
  const dep = codeDepartement(departement);
  return dep ? (referentiels.zonage_abc.par_departement[dep] ?? []) : [];
}

/** Forme comparable d'un nom de commune : accents, casse et ponctuation neutralises. */
const normaliserNom = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');

function zonageDeLaCommune(commune, departement) {
  if (!commune) return null;
  const cible = normaliserNom(commune);
  // La comparaison passe par la forme normalisee : la commune est normalement
  // choisie dans la liste, donc exacte, mais une simulation importee peut
  // porter « OP-6 » ou « OP-6 » sans accent.
  const trouvee = communesDuDepartement(departement).find((c) => normaliserNom(c[1]) === cible);
  return trouvee ? { code_insee: trouvee[0], nom: trouvee[1], zone_ABC: trouvee[2] } : null;
}

/**
 * Repartit des parts en garantissant a chacune une hauteur LISIBLE.
 *
 * Une jauge verticale etiquetee pose un probleme que la barre seule n'a pas :
 * un poste a 2 % occupe quinze pixels, ou aucun texte ne tient. Plutot que de
 * masquer ces postes - c'est justement eux qu'on cherche parfois -, on releve
 * chaque part sous le minimum et on reduit les autres a proportion.
 *
 * L'operation se repete : relever les petites reduit les grandes, dont
 * certaines peuvent a leur tour passer sous le minimum. Elle converge, chaque
 * tour ne pouvant qu'ajouter des parts au groupe des relevees.
 *
 * La colonne des etiquettes cesse alors de suivre exactement la barre : c'est
 * le prix a payer, et la pastille de couleur retablit le lien.
 *
 * @param {number[]} parts fractions de la hauteur totale, somme <= 1
 * @param {number} [mini]  hauteur minimale garantie, en fraction
 * @returns {number[]} parts ajustees, de meme somme
 */
function repartirLisible(parts, mini = 0.1) {
  const n = parts.length;
  if (!n) return [];
  const total = parts.reduce((s, p) => s + p, 0);
  // Trop de postes pour que le minimum tienne : tout le monde a la meme part.
  if (n * mini >= total) return parts.map(() => total / n);

  const releve = parts.map(() => false);
  for (let tour = 0; tour < n; tour++) {
    const fixe = parts.reduce((s, p, i) => s + (releve[i] ? mini : 0), 0);
    const libre = parts.reduce((s, p, i) => s + (releve[i] ? 0 : p), 0);
    const dispo = total - fixe;
    let change = false;
    parts.forEach((p, i) => {
      if (!releve[i] && libre > 0 && (p / libre) * dispo < mini) {
        releve[i] = true;
        change = true;
      }
    });
    if (!change) break;
  }

  const fixe = parts.reduce((s, p, i) => s + (releve[i] ? mini : 0), 0);
  const libre = parts.reduce((s, p, i) => s + (releve[i] ? 0 : p), 0);
  const dispo = Math.max(0, total - fixe);
  return parts.map((p, i) => (releve[i] ? mini : libre > 0 ? (p / libre) * dispo : 0));
}

/** Une ligne de prix de revient est-elle saisie tranche par tranche ? */
const estVentile = (p) => Boolean(p.montants_ht_par_produit);

/**
 * Total HT d'une ligne, miroir exact de `montantHTPoste` cote moteur. Une ligne
 * ventilee dont toutes les tranches sont vides reste VIDE et ne vaut pas zero :
 * la nuance decide de son affichage en « non renseignee ».
 */
function totalPoste(p) {
  if (!p.montants_ht_par_produit) return p.montant_ht_eur;
  const valeurs = Object.values(p.montants_ht_par_produit);
  return valeurs.every(nul) ? null : valeurs.reduce((s, v) => s + (v ?? 0), 0);
}

/**
 * Une ligne ventilee porte-t-elle une repartition SUR MESURE, c'est-a-dire
 * differente de ce que la cle de surface utile donnerait ?
 *
 * C'est la seule information qui compte avant de regrouper : regrouper une
 * ligne au prorata ne perd rien, on saurait la reconstruire ; regrouper une
 * ligne repartie a la main perd un arbitrage que rien ne retrouvera.
 */
function ventilationSurMesure(p, quotesParts) {
  if (!estVentile(p)) return false;
  const codes = tranchesActives();
  const total = totalPoste(p);
  if (nul(total)) return false;
  const attendu = arrondirEnConservantLaSomme(
    codes.map((c) => (quotesParts[c] ?? 1 / codes.length) * total),
  );
  // Un euro de tolerance : l'arrondi de la repartition ne doit pas se faire
  // passer pour une saisie manuelle.
  return codes.some((c, i) => Math.abs((p.montants_ht_par_produit?.[c] ?? 0) - attendu[i]) > 1);
}

/**
 * Ventile une ligne sur les tranches au prorata de surface utile, ou la
 * regroupe en un total unique.
 *
 * La repartition passe par `arrondirEnConservantLaSomme` : sans elle, trois
 * tranches sur un montant impair perdraient des centimes et le total ventile
 * cesserait d'egaler le total saisi.
 */
function basculerVentilation(p, ventiler, quotesParts) {
  const codes = tranchesActives();
  if (!ventiler) {
    // Regroupement : le total constate devient le montant global, et les
    // montants par tranche disparaissent pour qu'il n'en reste qu'une version.
    const total = totalPoste(p);
    p.montant_ht_eur = total;
    delete p.montants_ht_par_produit;
    delete p.taux_tva_par_produit;
    return;
  }
  const total = totalPoste(p);
  // Une ligne VIDE se ventile en cases vides, pas en zeros : elle doit rester
  // « non renseignee » - sinon basculer toute la nomenclature la remplirait de
  // zeros, et le filtre des lignes vides ne masquerait plus rien.
  const parts = nul(total)
    ? codes.map(() => null)
    : arrondirEnConservantLaSomme(codes.map((c) => (quotesParts[c] ?? 1 / codes.length) * total));
  p.montants_ht_par_produit = Object.fromEntries(codes.map((c, i) => [c, parts[i]]));
  // Le taux de la ligne devient le taux de depart de chaque tranche : la
  // ventilation ne doit rien changer au calcul tant qu'on ne le modifie pas.
  p.taux_tva_par_produit = Object.fromEntries(codes.map((c) => [c, p.taux_tva ?? 0]));
}

/**
 * Fraction vers pourcentage POUR LA SAISIE, sans trainee flottante : 0,0034 x 100
 * vaut 0,33999999999999997 en binaire, et c'est cela que le champ affichait.
 * `toPrecision(12)` coupe le bruit bien en deca de la precision d'un taux.
 */
const enPourcent = (v) => (nul(v) ? null : Number((v * 100).toPrecision(12)));

// ---------------------------------------------------------------- rendu de structure

/** Liste des departements, remplie une fois : elle ne depend d'aucune saisie. */
function rendreSelectDepartement() {
  const sel = document.getElementById('select-departement');
  if (!sel || sel.children.length) return;
  sel.innerHTML =
    '<option value=""></option>' +
    referentiels.departements.departements
      .map((d) => `<option value="${att(d.libelle)}">${att(d.libelle)}</option>`)
      .join('');
}

function rendreChampsStatiques(racine = document) {
  if (racine === document) rendreSelectDepartement();
  for (const el of racine.querySelectorAll('[data-champ]')) {
    const champ = /** @type {HTMLInputElement} */ (el);
    if (champ.closest('tbody') || champ.closest('.liste')) continue;
    const v = lireChemin(etat, champ.dataset.champ ?? '');
    // Le mode d'exploitation est une CHAINE pilotee par une case a cocher :
    // `Boolean('loyers')` vaut vrai, il faut donc tester la valeur elle-meme.
    if (champ.dataset.type === 'mode-redevance') champ.checked = v === 'redevance';
    else if (champ.type === 'checkbox') champ.checked = Boolean(v);
    else if (champ.dataset.type === 'pourcentage') champ.value = nul(v) ? '' : String(enPourcent(v));
    else champ.value = nul(v) ? '' : String(v);
  }
}

/**
 * Structure des tables de saisie. Appelee seulement quand le NOMBRE ou l'IDENTITE
 * des lignes change : la reconstruire a chaque frappe detruit le focus et coupe la
 * saisie d'un decimal au moment du separateur.
 */
/** Produits presents au programme, dans l'ordre canonique. */
function tranchesActives() {
  const utilises = new Set(etat.lots.map((l) => l.code_produit));
  return produitsOrdonnes().filter((p) => utilises.has(p.code)).map((p) => p.code);
}

/** Libelle affichable d'un produit. */
function libelleProduit(code) {
  return produitsOrdonnes().find((p) => p.code === code)?.libelle ?? code;
}

/**
 * Onglets et ecrans de tranche : un par produit present au programme.
 *
 * Ils sont GENERES a partir des lots, pas declares : ajouter un lot PLAI fait
 * apparaitre l'onglet PLAI, retirer le dernier le fait disparaitre. Chaque
 * tranche y porte ses marges de loyer, ses prets, ses subventions et ses fonds
 * propres.
 */
/**
 * Elague TOUT ce qui se rattache a un produit absent du programme.
 *
 * Le programme est la source de verite : une tranche existe parce que des lots
 * la portent. Or beaucoup de donnees sont indexees par produit - marges de
 * loyer, fonds propres, regime de redevance, ventilation du prix de revient,
 * prets, affectation des subventions - et elles survivaient a la disparition
 * du produit. Transformer tout son PLAI en PLS laissait des montants de prix
 * de revient PLAI, des prets PLAI et un plan de financement PLAI, invisibles a
 * l'ecran mais bien presents dans les totaux. C'est la source des valeurs
 * fantomes.
 *
 * La regle est desormais sans exception : ce qui n'a plus de tranche n'existe
 * plus. Elle s'applique a chaque rafraichissement de structure, donc a chaque
 * geste qui touche au programme.
 *
 * CE QUE CELA COUTE : retirer le dernier lot d'une tranche efface ses prets et
 * ses marges, et les remettre ne les rendra pas - la tranche renaitra avec ses
 * valeurs par defaut. C'est le prix a payer pour qu'aucun chiffre ne survive a
 * ce qui le justifiait, et c'est le bon arbitrage : un montant fantome dans un
 * plan de financement est une faute, une ressaisie n'est qu'une corvee.
 *
 * Les SUBVENTIONS font exception a la suppression : leur affectation est une
 * metadonnee facultative, pas leur nature. On efface donc l'affectation devenue
 * caduque et on garde la ligne, qui redevient non affectee - supprimer une
 * somme saisie par l'utilisateur serait autrement plus grave.
 */
function elaguerProduitsAbsents() {
  const actifs = new Set(tranchesActives());
  const purger = (dico) => {
    if (!dico || typeof dico !== 'object') return;
    for (const code of Object.keys(dico)) if (!actifs.has(code)) delete dico[code];
  };

  purger(etat.loyers_par_produit);
  purger(etat.fonds_propres_par_produit);
  purger(etat.taux_apport_par_produit);
  purger(etat.remuneration_fonds_propres);
  purger(etat.regimes_par_produit);

  for (const p of etat.postes_bilan ?? []) {
    purger(p.montants_ht_par_produit);
    purger(p.taux_tva_par_produit);
    // Un poste ventile dont plus aucune tranche ne subsiste redevient global :
    // laisser un dictionnaire vide le ferait passer pour ventile a zero.
    if (p.montants_ht_par_produit && !Object.keys(p.montants_ht_par_produit).length) {
      delete p.montants_ht_par_produit;
      delete p.taux_tva_par_produit;
    }
  }

  // Un pret sans produit est un pret d'operation (collecteur, ALS...) : il
  // n'appartient a aucune tranche et survit.
  etat.prets = (etat.prets ?? []).filter((p) => !p.produit || actifs.has(p.produit));

  for (const s of etat.subventions ?? []) {
    if (s.affectation && !actifs.has(s.affectation)) delete s.affectation;
  }
}

/**
 * R-FIN-3 - Chaque tranche presente au programme porte un pret CDC foncier et un
 * pret CDC construction, crees des son apparition et en montant AUTOMATIQUE.
 *
 * Ils disparaissent avec elle : voir `elaguerProduitsAbsents`.
 */
function pretsCDCParDefaut(codes) {
  for (const code of codes) {
    for (const [nature, libelle] of [
      ['foncier', 'Prêt CDC foncier'],
      ['construction', 'Prêt CDC construction'],
    ]) {
      const existe = etat.prets.some((p) => p.produit === code && p.nature === nature);
      if (existe) continue;
      etat.prets.push({
        code: `CDC_${nature.toUpperCase()}_${code}`,
        libelle: `${libelle} ${code}`,
        nature,
        produit: code,
        // Pret STRUCTURANT de la tranche : il ne se supprime pas, c'est lui qui
        // porte l'equilibre. Mettre son montant a zero suffit a le neutraliser.
        principal: true,
        // Montant laisse au calcul : il s'ajuste au besoin de la tranche.
        montant_auto: true,
        montant_eur: null,
        // Taux, duree et revisabilite viennent du produit (R-AMT-1) tant qu'ils
        // ne sont pas saisis : on ne les fige pas ici.
      });
    }
  }
}

function rendreStructureTranches() {
  const codes = tranchesActives();
  const defautFP = referentiels.baremes.fonds_propres ?? {};
  for (const code of codes) {
    etat.loyers_par_produit[code] ??= { marge_majoration: 0, loyer_sortie_force: null };
    // R-FIN-7 : non remuneres par defaut. Les valeurs de taux et de duree sont
    // preremplies depuis le referentiel pour que cocher la case suffise, sans
    // etre appliquees tant que la case ne l'est pas.
    etat.remuneration_fonds_propres[code] ??= {
      // L'apport par defaut prend la forme d'une avance de tresorerie
      // REMUNEREE : c'est la regle de montage, et elle vaut dans les deux
      // regimes. La reconstitution, elle, reste un choix.
      remuneres: defautFP.apport?.remuneres_par_defaut ?? false,
      reconstitues: false,
      taux: defautFP.taux_remuneration_defaut ?? 0,
      duree_reconstitution_ans: defautFP.duree_reconstitution_defaut_ans ?? 30,
    };
  }
  pretsCDCParDefaut(codes);

  $('#onglets-tranches').innerHTML = codes
    .map(
      (c) =>
        `<button type="button" class="onglet onglet--tranche" role="tab" data-ecran="tranche-${c}"
          aria-selected="false" style="--cat:${catProduit(c)}">${att(libelleProduit(c))}</button>`,
    )
    .join('');

  $('#ecrans-tranches').innerHTML = codes
    .map((code) => {
      const L = etat.loyers_par_produit[code];
      // R-EXP-7 : regime de produits de la tranche. « loyers » par defaut, ce
      // qui laisse une operation ordinaire se comporter exactement comme avant.
      const REG = etat.regimes_par_produit?.[code] ?? { mode: 'loyers' };
      const RFP = etat.remuneration_fonds_propres[code] ?? { remuneres: false };
      const prets = etat.prets.map((p, i) => ({ p, i })).filter(({ p }) => (p.produit ?? code) === code);
      const subs = etat.subventions.map((s, i) => ({ s, i })).filter(({ s }) => s.affectation === code);

      // Loyer et fonds propres sont montes en variable pour pouvoir se placer
      // APRES les subventions et les prets. L'ordre de l'ecran suit celui du
      // montage : on cherche d'abord ce qui finance la tranche, on regarde
      // ensuite ce qu'elle rapporte et ce qu'elle coute en capital propre.
      const colonnesLoyerFP = `
        <div class="colonnes">
          <section class="bloc bloc--tranche">
            <!-- R-EXP-7 : une tranche encaisse SOIT un loyer, SOIT une
                 redevance, jamais les deux. Le regime se choisit donc ici, et il
                 remplace le contenu de l'encart plutot que d'ajouter un bloc a
                 cote : deux encarts dont un seul compte laisseraient croire que
                 les montants s'additionnent. Le choix est de TRANCHE, un foyer
                 en redevance pouvant cotoyer des logements familiaux en loyers
                 dans la meme operation. -->
            <h2 class="bloc__titre">
              Produits de la tranche ${att(libelleProduit(code))}
              <span class="bloc__outils"><span class="choix">
                ${[
                  { v: 'loyers', l: 'Loyer au m²' },
                  { v: 'redevance', l: 'Redevance' },
                ]
                  .map(
                    (o) => `<button type="button" class="choix__option ${REG.mode === o.v ? 'choix__option--actif' : ''}"
                      data-poser-champ="regimes_par_produit.${code}.mode" data-valeur="${o.v}"
                      data-type-valeur="texte">${o.l}</button>`,
                  )
                  .join('')}
              </span></span>
            </h2>
            ${
              REG.mode === 'redevance'
                ? `<div class="champs champs--serres">
              <div class="champ champ--choix"><span>Régime</span>
                <span class="choix">
                  ${[
                    { v: 'forfaitaire', l: 'Forfaitaire', a: 'Montant négocié, indexé depuis son année de valeur' },
                    { v: 'transparence', l: 'En transparence', a: 'Refacturation des charges : le résultat de la tranche est nul' },
                  ]
                    .map(
                      (o) => `<button type="button" class="choix__option ${(REG.mode_redevance ?? 'forfaitaire') === o.v ? 'choix__option--actif' : ''}"
                        data-poser-champ="regimes_par_produit.${code}.mode_redevance" data-valeur="${o.v}"
                        data-type-valeur="texte" title="${att(o.a)}">${o.l}</button>`,
                    )
                    .join('')}
                </span></div>
              ${
                (REG.mode_redevance ?? 'forfaitaire') === 'forfaitaire'
                  ? `<label class="champ"><span>Redevance annuelle (€)</span>
                      <input type="text" inputmode="decimal" data-champ="regimes_par_produit.${code}.redevance_annuelle_eur"
                        data-type="montant" value="${valMontant(REG.redevance_annuelle_eur)}" /></label>
                     <label class="champ"><span>Année de valeur</span>
                      <input type="number" step="1" data-champ="regimes_par_produit.${code}.redevance_annee_valeur"
                        data-type="nombre" value="${valNum(REG.redevance_annee_valeur)}"
                        placeholder="mise en location" /></label>`
                  : ''
              }
            </div>
            <p class="aide" data-aide-redevance="${code}"></p>`
                : `<div class="champs champs--serres">
              <label class="champ">
                <span>Majoration (%)</span>
                <input type="number" step="0.1" data-champ="loyers_par_produit.${code}.marge_majoration" data-type="pourcentage" value="${valNum(enPourcent(L.marge_majoration))}" />
              </label>
              <label class="champ">
                <span>Loyer forcé (€/m²/mois)</span>
                <input type="number" step="0.01" min="0" data-champ="loyers_par_produit.${code}.loyer_sortie_force" data-type="nombre" value="${valNum(L.loyer_sortie_force)}" />
              </label>
            </div>
            <!-- La chaine de calcul du loyer en JETONS et non en table : c'est la
                 meme grammaire que les prets, et cinq lignes de tableau pour
                 cinq nombres pesaient plus que ce qu'elles montraient. -->
            <div class="jetons jetons--chaine" data-jetons-loyer="${code}"></div>`
            }
          </section>

          <section class="bloc bloc--tranche">
            <h2 class="bloc__titre">Fonds propres</h2>
            <div class="liste">
              <!-- Meme grammaire que le montant d'un pret : non saisi, l'apport
                   est CALCULE (part du referentiel sur le prix de revient) et se
                   lit en filigrane, bordure pointillee. Saisi, il fige, et un
                   bouton rend la main au calcul. Un champ vide qui vaudrait zero
                   en silence serait la pire des trois lectures. -->
              <div class="ligne ligne--ressource ligne--fp ${
                nul(etat.fonds_propres_par_produit[code]) ? 'fp--auto' : ''
              }">
                <div class="pret__entete">
                  <span class="ressource__libelle">Apport de la tranche</span>
                  <input type="text" inputmode="decimal" class="pret__montant"
                    data-champ="fonds_propres_par_produit.${code}" data-type="montant"
                    data-apport-auto="${code}"
                    value="${valMontant(etat.fonds_propres_par_produit[code])}" />
                  <!-- Bouton TOUJOURS emis, masque par CSS tant qu'on est en
                       automatique : saisir un montant ne reconstruit pas la
                       table - cela couterait le focus a la premiere frappe -
                       donc le rendu conditionnel ne le ferait jamais paraitre. -->
                  <span class="pret__actions">
                    <button type="button" class="bouton--auto" data-apport-rendre-auto="${code}"
                      title="Revenir au montant calculé">auto</button>
                  </span>
                </div>
                <div class="jetons">
                  <!-- La part se SAISIT, elle ne fait pas que s'afficher : les
                       5 % sont une regle de place qu'une operation negocie, et
                       un programme mixte ne la negocie pas au meme niveau sur
                       toutes ses tranches. Champ vide = part du referentiel,
                       lue en filigrane ; zero reste une valeur legitime, une
                       tranche sans apport, donc seul le vide rend la main.
                       Le champ est masque des qu'un MONTANT est saisi : c'est
                       alors lui qui fait foi, et proposer un taux qui ne
                       commande plus rien serait un mensonge d'interface. -->
                  <span class="jeton jeton--saisi"><span class="jeton__cle">part du prix de revient</span><input
                    type="number" step="0.1" min="0" class="jeton__champ"
                    data-champ="taux_apport_par_produit.${code}" data-type="pourcentage"
                    data-part-fp-saisie="${code}" aria-label="Part du prix de revient en fonds propres"
                    value="${valNum(enPourcent(etat.taux_apport_par_produit?.[code]))}" /><span
                    class="jeton__unite">%</span></span>
                  <span class="jeton jeton--fige" data-part-fp-figee="${code}" hidden><span class="jeton__cle">part du prix de revient</span><span class="jeton__valeur" data-part-fp="${code}">-</span></span>
                  <span class="jeton"><span class="jeton__cle">reconstitution</span><span class="jeton__valeur" data-reconstitution-fp="${code}">-</span></span>
                  ${
                    RFP.remuneres || RFP.reconstitues
                      ? `<span class="jeton"><span class="jeton__cle">charge annuelle</span><span class="jeton__valeur" data-annuite-fp="${code}">-</span></span>`
                      : ''
                  }
                </div>
              </div>
            </div>
            <!-- DEUX options independantes, et les quatre combinaisons se
                 rencontrent : remuneres sans etre reconstitues (interets servis,
                 capital laisse dans l'operation), reconstitues sans etre
                 remuneres, les deux, ou ni l'un ni l'autre.

                 Les champs conditionnels sont TOUJOURS rendus, seulement masques
                 quand leur case est decochee : leur place est reservee d'avance
                 et les deux intitules ne bougent plus. Les faire apparaitre et
                 disparaitre deplacait « Reconstitues » d'un champ entier a
                 chaque clic, et il fallait rechercher des yeux la case qu'on
                 venait de cocher. -->
            <div class="options-fp">
              <label class="champ champ--interrupteur">
                <input type="checkbox" data-champ="remuneration_fonds_propres.${code}.remuneres"
                  data-type="booleen" data-structure="1" ${RFP.remuneres ? 'checked' : ''} />
                <span>Rémunérés</span>
              </label>
              <label class="champ champ--serre ${RFP.remuneres ? '' : 'champ--reserve'}">
                <span>Taux (%)</span>
                <input type="number" step="0.01" min="0" data-champ="remuneration_fonds_propres.${code}.taux"
                  data-type="pourcentage" value="${valNum(enPourcent(RFP.taux))}"
                  ${RFP.remuneres ? '' : 'disabled tabindex="-1"'} />
              </label>
              <label class="champ champ--interrupteur">
                <input type="checkbox" data-champ="remuneration_fonds_propres.${code}.reconstitues"
                  data-type="booleen" data-structure="1" ${RFP.reconstitues ? 'checked' : ''} />
                <span>Reconstitués</span>
              </label>
              <label class="champ champ--serre ${RFP.reconstitues ? '' : 'champ--reserve'}">
                <span>Durée (ans)</span>
                <input type="number" step="1" min="1" data-champ="remuneration_fonds_propres.${code}.duree_reconstitution_ans"
                  data-type="nombre" value="${valNum(RFP.duree_reconstitution_ans)}"
                  ${RFP.reconstitues ? '' : 'disabled tabindex="-1"'} />
              </label>
            </div>
            <p class="aide" data-aide-fp="${code}"></p>
          </section>
        </div>`;

      return `
      <main class="ecran ecran--tranche" id="ecran-tranche-${code}" role="tabpanel" hidden style="--cat:${catProduit(code)}">
        <!-- Jauges verticales : l'equilibre de la tranche encadre sa saisie.
             A gauche ce qu'elle coute, a droite ce qui la finance, a la meme
             echelle. Un desequilibre se voit sans quitter l'ecran. -->
        <div class="jauge" data-jauge="emplois" data-tranche="${code}" title="Emplois"></div>
        <div class="ecran__corps">
        <div class="indicateurs indicateurs--tranche" data-recap-tranche="${code}"></div>

        <section class="bloc bloc--tranche">
          <h2 class="bloc__titre">
            Subventions de la tranche
            <button type="button" class="bouton bouton--ajout" data-ajouter-tranche="subventions" data-produit="${code}">+ subvention</button>
          </h2>
          <div class="liste">
            ${
              subs.length
                ? subs
                    .map(
                      ({ s, i }) => `<div class="ligne ligne--ressource">
                <!-- La part du prix de revient vit SUR la ligne, a droite du
                     montant : c'est la lecture immediate du montant saisi, pas
                     une metadonnee de second rang. -->
                <div class="pret__entete">
                  <input type="text" class="ressource__libelle" data-champ="subventions.${i}.libelle" value="${att(s.libelle)}" />
                  <input type="text" inputmode="decimal" class="pret__montant" data-champ="subventions.${i}.montant_eur"
                    data-type="montant" value="${valMontant(s.montant_eur)}" />
                  <span class="jeton"><span class="jeton__cle">part du prix de revient</span><span class="jeton__valeur" data-part-sub="${i}">-</span></span>
                  <span class="pret__actions">
                    <button type="button" class="bouton--supprimer" data-supprimer="subventions" data-index="${i}"
                      data-nom="${att(s.libelle)}" title="Supprimer">×</button>
                  </span>
                </div>
              </div>`,
                    )
                    .join('')
                : '<p class="aide">Aucune subvention sur cette tranche.</p>'
            }
          </div>
        </section>

        <section class="bloc">
          <h2 class="bloc__titre">
            Prêts de la tranche
            <button type="button" class="bouton bouton--ajout" data-ajouter-tranche="prets" data-produit="${code}">+ prêt</button>
          </h2>
          <div class="liste">
            ${
              prets.length
                ? prets.map(({ p, i }) => gabaritPret(p, i)).join('')
                : '<p class="aide">Aucun prêt saisi sur cette tranche.</p>'
            }
            <!-- Prets DERIVES d'une regle : le CPLS n'est pas saisi, il nait du
                 plafonnement du PLS a 55 %. Il se lit, il ne se modifie pas. -->
            <div class="liste" data-prets-derives="${code}"></div>
          </div>
        </section>

        ${colonnesLoyerFP}
        </div>
        <div class="jauge" data-jauge="ressources" data-tranche="${code}" title="Ressources"></div>
      </main>`;
    })
    .join('');
}

/**
 * R-FIN-7 - Taux d'apport en fonds propres applicable au montage courant.
 *
 * En redevance TRANSPARENTE, l'apport prend la forme d'une avance de tresorerie
 * remuneree et se limite a 2 % : le gestionnaire refacture les charges, il n'y a
 * pas lieu d'immobiliser davantage. Hors transparence - redevance forfaitaire ou
 * loyers ordinaires - il est de 5 %.
 */
function tauxApportFP() {
  const a = referentiels.baremes.fonds_propres?.apport ?? {};
  const transparence =
    etat.exploitation?.mode === 'redevance' && etat.exploitation?.mode_redevance === 'transparence';
  return (transparence ? a.taux_redevance_transparence : a.taux_defaut) ?? 0;
}

/** Apport theorique d'une tranche : taux du montage x son prix de revient TTC. */
function apportTheoriqueFP(code) {
  const ttc = dernierResultat?.bilan?.par_tranche?.[code]?.total_ttc_eur;
  return ttc > 0 ? Math.round(ttc * tauxApportFP()) : null;
}

/**
 * Changement de regime : la part d'apport passe de 5 % a 2 % ou l'inverse.
 *
 * Les tranches laissees en AUTOMATIQUE suivent d'elles-memes - c'est ce que veut
 * dire automatique, et leur bordure pointillee l'annonce. On ne demande donc
 * rien pour elles. Les tranches SAISIES, en revanche, ne bougeront pas : ce sont
 * elles qui pourraient surprendre, et ce sont les seules sur lesquelles on
 * propose quelque chose. Refuser les laisse telles quelles.
 */
async function proposerReajustementApports(ancienTaux) {
  const nouveauTaux = tauxApportFP();
  if (nouveauTaux === ancienTaux) return;
  const saisies = Object.keys(etat.fonds_propres_par_produit).filter(
    (c) => !nul(etat.fonds_propres_par_produit[c]) && apportTheoriqueFP(c) !== null,
  );
  if (!saisies.length) return;
  const ok = await confirmerBoite(
    'Montants saisis en fonds propres',
    `L’apport passe de ${pct(ancienTaux, 1)} à ${pct(nouveauTaux, 1)} du prix de revient. ` +
      `${saisies.length} tranche(s) portent un montant saisi, qui ne suivra pas. ` +
      `Les remettre au montant calculé ? Annuler les laisse tels quels.`,
    'Recalculer',
    false,
  );
  if (!ok) return;
  for (const c of saisies) delete etat.fonds_propres_par_produit[c];
  // Le rafraichissement se fait ICI et non chez l'appelant : la boite est
  // asynchrone, l'appelant a deja redessine l'ecran depuis longtemps quand la
  // reponse arrive. Sans cela les montants remis en automatique resteraient
  // affiches a leur ancienne valeur jusqu'a la frappe suivante.
  rafraichirTout();
}

/**
 * Prets deplies. Etat purement visuel : il vit ici et non dans `etat`, qui est
 * clone tel quel pour alimenter le moteur et l'export JSON.
 * @type {Set<number>}
 */
const pretsDeplies = new Set();

/**
 * Souvenir de la description de taux ABANDONNEE quand on change d'indexation.
 *
 * Basculer en taux fixe efface la marge et le plancher, et l'inverse efface le
 * taux : le pret ne doit etre decrit qu'une fois. Mais celui qui essaie les
 * deux ne doit pas ressaisir sa marge a chaque aller-retour, ni surtout voir un
 * ZERO s'inscrire la ou le champ etait VIDE : vide, la marge herite du produit,
 * et zero est une toute autre chose. Etat d'ecran, par index, comme le depli.
 * @type {Map<number, {spread?: number, taux_plancher?: number, taux?: number}>}
 */
const cacheModeTaux = new Map();

/**
 * Champs qui CARACTERISENT un pret, par opposition a ceux qui l'identifient
 * (libelle, nature, produit) ou le dimensionnent (montant). C'est la liste que
 * remet a zero le bouton de reinitialisation, et elle sert aussi a savoir si le
 * pret s'ecarte de ses defauts.
 */
const CHAMPS_CARACTERISTIQUES_PRET = [
  'spread', 'taux', 'taux_plancher', 'duree_ans', 'revisabilite', 'progressivite',
  'profil_amortissement', 'differe_ans', 'differe_type', 'periodicite',
  'annee_premiere_echeance',
];

/** Un pret s'ecarte-t-il des caracteristiques par defaut de son produit ? */
function pretModifie(p) {
  return CHAMPS_CARACTERISTIQUES_PRET.some((k) => !nul(p[k]));
}

/**
 * Jeton de metadonnee : etiquette en petites capitales, valeur en clair.
 * `champ` marque la valeur pour qu'un rendu ulterieur la remplisse depuis le
 * resultat du moteur, sans reconstruire la ligne.
 */
const jeton = (cle, valeur, champ, titre) =>
  `<span class="jeton"${titre ? ` title="${att(titre)}"` : ''}><span class="jeton__cle">${att(cle)}</span>` +
  `<span class="jeton__valeur"${champ ? ` data-jeton="${champ}"` : ''}>${att(valeur)}</span></span>`;

/**
 * Bloc d'un pret, sur le modele des lignes de financement d'ExNihilo : une
 * ligne compacte toujours lisible (libelle, montant, nature, jetons de
 * synthese) et le detail de saisie replie par defaut.
 *
 * Sept champs deplies en permanence pour six prets faisaient quarante-deux
 * cases a l'ecran : on ne voyait plus le plan de financement, seulement des
 * formulaires.
 */
/**
 * Presets proposes sur un pret ajoute, tant qu'il est VIERGE.
 *
 * Un pret nait avec des caracteristiques neutres - 2 %, 40 ans, taux fixe - que
 * personne ne veut vraiment : ce sont des valeurs d'attente, pas un montage. Les
 * presets posent d'un clic celles d'un produit reel (Action Logement, Booster,
 * PHB 2.0...) et il ne reste que le montant a saisir.
 *
 * Ils disparaissent des que le pret porte un montant : a partir de la, il est
 * monte, et lui proposer encore d'ecraser ses caracteristiques serait offrir de
 * defaire ce qu'on vient de faire. Le detail deplie reste modifiable a la main.
 */
function presetsDisponibles(p, i) {
  // Un pret qui PORTE deja un modele n'en propose plus : ses caracteristiques
  // sont posees, et lui offrir d'en appliquer un autre reviendrait a proposer
  // d'ecraser ce qu'on vient de choisir. Le detail deplie reste modifiable a la
  // main, et vider le champ de modele les fait revenir.
  if (p.preset) return '';
  const tous = listePresets();

  // Un GROUPE rassemble les declinaisons d'un meme preteur, une par produit.
  // On n'en propose qu'UNE, celle qui correspond au produit de la tranche : sur
  // une tranche PLS, « Action Logement » ne peut etre qu'Action Logement PLS.
  // Offrir les quatre reviendrait a demander a l'utilisateur de retrouver une
  // information que l'ecran connait deja, avec trois chances sur quatre de se
  // tromper. Le bouton porte alors le nom du GROUPE, pas celui de la variante.
  const vus = new Set();
  const proposes = [];
  for (const x of tous) {
    if (!x.groupe) {
      proposes.push({ id: x.id, libelle: x.libelle, note: x.note });
      continue;
    }
    if (vus.has(x.groupe)) continue;
    const variante = tous.find((v) => v.groupe === x.groupe && v.produits?.includes(p.produit));
    if (!variante) continue;
    vus.add(x.groupe);
    proposes.push({
      id: variante.id,
      libelle: x.groupe,
      note: `${variante.libelle}. ${variante.note ?? ''}`,
    });
  }
  if (!proposes.length) return '';

  return `<span class="pret__presets" title="Appliquer les caractéristiques d’un produit connu">
    ${proposes
      .map(
        (x) => `<button type="button" class="bouton--preset" data-preset-pret="${i}"
          data-preset="${att(x.id)}" title="${att(x.note ?? x.libelle)}">${att(x.libelle)}</button>`,
      )
      .join('')}
  </span>`;
}

/**
 * Detail d'un pret, organise par QUESTION plutot qu'en liste de champs.
 *
 * Dix champs alignes sur deux rangs ne disaient pas lesquels vont ensemble : la
 * marge et le plancher decrivent le meme sujet, la duree et la periodicite un
 * autre, le differe un troisieme. On les groupe donc par la question a laquelle
 * ils repondent - combien ca coute, comment ca se rembourse, quand ca commence -
 * et chaque groupe porte, en clair, ce que le reglage courant produit.
 *
 * Ces phrases ne sont pas de la decoration : un pret se juge sur son annuite et
 * son terme, pas sur la valeur de ses dix parametres. Les lire obligeait a les
 * recomposer de tete a chaque fois.
 *
 * L'indexation devient un CHOIX explicite plutot qu'une deduction de la nature.
 * Auparavant, un champ de marge et un champ de taux pouvaient coexister sans
 * qu'on sache lequel l'emportait - c'est le taux, mais rien ne le disait.
 */
function detailPret(p, i) {
  const indexe = nul(p.taux) || !nul(p.spread);
  const c = (chemin) => `prets.${i}.${chemin}`;
  // Le differe EFFECTIF, saisie ou defaut du chantier : c'est lui qui decide si
  // le choix « pendant le differe » a un objet, pas la seule saisie.
  const differeEffectif =
    !nul(p.differe_mois) || (p.principal && Number(etat.dates?.duree_chantier_mois) > 0);

  /**
   * Choix en SEGMENTS plutot qu'en menu deroulant. Un menu cache ses options :
   * il faut l'ouvrir pour savoir qu'un pret peut s'amortir a capital constant,
   * ou qu'il existe quatre revisabilites. Ici les possibilites sont lisibles
   * sans clic, et le choix courant se voit d'un coup d'oeil - sur un panneau
   * qui sert justement a comparer des montages, cela compte plus que la place
   * economisee.
   */
  // `inactif` DESACTIVE vraiment les boutons, il ne fait pas que les grisier :
  // un groupe eteint mais cliquable dit « sans objet » de l'oeil et accepte le
  // clic de la main, ce qui est la pire des deux lectures.
  const segments = (chemin, options, courante, type, inactif = false) => `
    <span class="choix" role="group">
      ${options
        .map(
          (o) => `<button type="button" class="choix__option ${o.v === courante ? 'choix__option--actif' : ''}"
            data-poser-champ="${chemin}" data-valeur="${att(String(o.v))}" data-type-valeur="${type}"
            ${inactif ? 'disabled' : ''} ${o.aide ? `title="${att(o.aide)}"` : ''}
            aria-pressed="${o.v === courante}">${att(o.l)}${
              o.marque ? `<span class="choix__defaut" data-defaut="${o.marque}"></span>` : ''
            }</button>`,
        )
        .join('')}
    </span>`;

  // Le sous-titre reste possible mais n'est plus utilise : les trois intitules
  // se suffisent, et une glose sous chacun d'eux repetait ce que les libelles
  // de champ disaient deja juste en dessous.
  const groupe = (titre, aide, champs, cleSynthese) => `
    <section class="pret__groupe">
      <h4 class="pret__groupe-titre">${att(titre)}${aide ? `<span class="pret__groupe-aide">${att(aide)}</span>` : ''}</h4>
      <div class="pret__groupe-corps">${champs}</div>
      <p class="pret__synthese" data-synthese="${cleSynthese}">-</p>
    </section>`;

  return `<div class="pret__detail">
    ${groupe(
      'Conditions',
      '',
      `<div class="champ champ--choix"><span>Indexation</span>
        ${segments(
          c('mode_taux'),
          [
            { v: 'indexe', l: 'Livret A + marge', aide: 'Le taux suit le Livret A' },
            { v: 'fixe', l: 'Taux fixe', aide: 'Le taux ne bouge pas de toute la durée' },
          ],
          indexe ? 'indexe' : 'fixe',
          'mode-taux',
        )}</div>
      ${
        indexe
          ? `<label class="champ"><span>Marge sur Livret A (%)</span>
              <input type="number" step="0.01" data-champ="${c('spread')}" data-type="pourcentage"
                data-defaut="spread" value="${valNum(enPourcent(p.spread))}" /></label>
            <label class="champ"><span>Taux plancher (%)</span>
              <input type="number" step="0.01" min="0" data-champ="${c('taux_plancher')}" data-type="pourcentage"
                value="${valNum(enPourcent(p.taux_plancher))}" placeholder="aucun" /></label>
            <!-- Pas de segment « du produit » : la valeur heritee s'affiche
                 comme ACTIVE parmi les quatre, remplie depuis le resultat. Un
                 cinquieme bouton d'heritage obligeait a savoir que DOUBLE et
                 « du produit (DOUBLE) » sont le meme reglage. Le retour au
                 defaut passe par le bouton de reinitialisation du pret. -->
            <div class="champ champ--choix"><span>Révisabilité</span>
              ${segments(
                c('revisabilite'),
                OPTIONS_REVISABILITE.map((v) => ({ v, l: v })),
                p.revisabilite ?? null,
                'texte',
              )}</div>`
          : `<label class="champ"><span>Taux (%)</span>
              <input type="number" step="0.01" data-champ="${c('taux')}" data-type="pourcentage"
                data-defaut="taux" value="${valNum(enPourcent(p.taux))}" /></label>`
      }`,
      'taux',
    )}
    ${groupe(
      'Remboursement',
      '',
      `<label class="champ"><span>Durée (ans)</span>
        <input type="number" step="1" min="1" data-champ="${c('duree_ans')}" data-type="nombre"
          data-defaut="duree" value="${valNum(p.duree_ans)}" /></label>
      <div class="champ champ--choix"><span>Échéance</span>
        ${segments(c('periodicite'), PERIODICITES, p.periodicite ?? 1, 'nombre')}</div>
      <div class="champ champ--choix"><span>Amortissement</span>
        ${segments(
          c('profil_amortissement'),
          [
            { v: 'progressif', l: 'annuité progressive', aide: "L'annuité suit la progressivité, le capital s'ajuste" },
            { v: 'constant', l: 'capital constant', aide: "Le capital est constant, l'annuité décroît" },
          ],
          p.profil_amortissement === 'constant' ? 'constant' : 'progressif',
          'texte',
        )}</div>
      <label class="champ"><span>Progressivité (%)</span>
        <input type="number" step="0.1" data-champ="${c('progressivite')}" data-type="pourcentage"
          data-defaut="progressivite" value="${valNum(enPourcent(p.progressivite))}"
          ${p.profil_amortissement === 'constant' ? 'disabled title="Sans objet : le capital est constant"' : ''} /></label>`,
      'profil',
    )}
    ${groupe(
      'Temporalité',
      '',
      `<label class="champ"><span>1re échéance (année)</span>
        <input type="number" step="1" data-champ="${c('annee_premiere_echeance')}" data-type="nombre"
          data-defaut="echeance" value="${valNum(p.annee_premiere_echeance)}" /></label>
      <!-- Le differe se saisit en MOIS : c'est l'unite du chantier, qui le
           commande. Laisse vide, un pret principal prend la duree du chantier -
           le filigrane le dit, et le rendre explicite le figerait. -->
      <label class="champ"><span>Différé (mois)</span>
        <input type="number" step="1" min="0" data-champ="${c('differe_mois')}" data-type="nombre"
          data-defaut="differe" value="${valNum(p.differe_mois)}" /></label>
      <div class="champ champ--choix ${differeEffectif ? '' : 'champ--eteint'}"><span>Pendant le différé</span>
        ${segments(
          c('differe_type'),
          OPTIONS_DIFFERE.map((o) => ({ v: o.v, l: o.l })),
          p.differe_type ?? 2,
          'nombre',
          !differeEffectif,
        )}</div>`,
      'calendrier',
    )}
  </div>`;
}

function gabaritPret(p, i) {
  const ouvert = pretsDeplies.has(i);
  // Les jetons sont remplis par `remplirCalculs` depuis le resultat : taux,
  // duree et revisabilite d'un pret CDC viennent du PRODUIT tant qu'ils ne sont
  // pas saisis, et les lire dans l'etat n'afficherait que des tirets.
  const jetons = [
    jeton('taux', '-', 'taux'),
    jeton('durée', '-', 'duree'),
    jeton('1re éch.', '-', 'echeance'),
    jeton('révis.', '-', 'revisabilite'),
    // L'echeance ne se montre que si elle n'est pas annuelle : la rappeler sur
    // tous les prets CDC ajouterait un jeton constant a chaque ligne.
    ...(p.periodicite > 1
      ? [jeton('échéance', PERIODICITES.find((x) => x.v === p.periodicite)?.l ?? `${p.periodicite}/an`)]
      : []),
    // La progressivite se lit comme le taux et la duree : depuis le RESULTAT,
    // car un pret CDC non saisi la tient du referentiel. La conditionner a la
    // saisie masquait les -0,5 % par defaut, qui pilotent pourtant l'annuite.
    jeton('progr.', '-', 'progressivite'),
    // Plus de jeton de differe : il a rejoint la vignette de DUREE, qui repond
    // a la meme question - combien de temps ce pret court, et a partir de quand.
    // Le type de differe, lui, reste dans le detail deplie, la ou il se saisit.
  ].join('');

  // Montant AUTOMATIQUE, reserve aux prets STRUCTURANTS de la tranche - les CDC
  // foncier, construction et le CPLS derive. Eux seuls absorbent l'ecart du plan
  // de financement, c'est ce qui donne un sens a leur calcul. Un pret ajoute a
  // cote finance un besoin identifie, pas un solde : son montant est une saisie.
  // Le moteur le voit deja ainsi - il nait avec un montant de zero, donc fige -
  // seul l'affichage le presentait en automatique, avec un bouton qui n'aurait
  // rien eu a recalculer.
  const auto = p.principal === true && p.montant_auto !== false;
  return `
    <div class="ligne ligne--pret ${auto ? 'pret--auto' : ''} ${p.principal ? 'pret--principal' : ''}"
      data-pret="${i}" style="--cat:${catProduit(p.produit)}">
      <div class="pret__entete">
        <input type="text" class="pret__libelle" data-champ="prets.${i}.libelle" value="${att(p.libelle)}" />
        <input type="text" inputmode="decimal" class="pret__montant" data-champ="prets.${i}.montant_eur"
          data-type="montant" data-montant-pret="${i}" value="${valMontant(p.montant_eur)}"
          title="${auto ? 'Calculé pour équilibrer la tranche. Saisir un montant le fige.' : 'Montant figé'}" />
        <!-- data-structure : passer un pret en « autre » lui retire son
             indexation sur le Livret A, donc remplace sa cellule de marge par
             une cellule de taux. La ligne doit etre reconstruite pour cela. -->
        <select class="pret__nature" data-champ="prets.${i}.nature" data-structure="1"
          ${p.principal ? 'disabled' : ''}
          title="${p.principal ? 'La nature d’un prêt structurant ne se change pas' : ''}">
          ${['construction', 'foncier', 'autre'].map((n) => `<option value="${n}" ${n === p.nature ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
        <!-- Le retour au calcul n'existe QUE pour les prets structurants : eux
             seuls absorbent l'ecart du plan de financement. Un pret ajoute a
             cote finance un besoin identifie, il n'y a rien a y recalculer. -->
        ${
          p.principal
            ? `<button type="button" class="bouton--auto" data-remettre-auto="${i}"
                 title="Revenir au montant calculé">↺ auto</button>` +
              // Le bouton de retour aux DEFAUTS ne parait que si le pret s'en
              // ecarte : permanent, il serait un appel a defaire une saisie qui
              // n'existe pas. C'est aussi lui qui dit, d'un coup d'oeil, qu'un
              // pret structurant a ete retouche : un DOUBLE saisi et un DOUBLE
              // herite se ressemblent en tout point ailleurs.
              //
              // Toujours EMIS, masque au remplissage : saisir une marge ne
              // reconstruit pas la ligne, cela couterait le focus a la premiere
              // frappe, donc un rendu conditionnel ne le ferait jamais paraitre.
              `<button type="button" class="bouton--reset" data-reset-pret="${i}" ${pretModifie(p) ? '' : 'hidden'}
                 title="Effacer les réglages saisis et revenir aux caractéristiques du produit">↺ défauts du produit</button>`
            : presetsDisponibles(p, i)
        }
        <span class="pret__actions">
          <button type="button" class="bouton--deplier" data-deplier-pret="${i}"
            aria-expanded="${ouvert}" title="${ouvert ? 'Replier' : 'Déplier'}">${ouvert ? '▴' : '▾'}</button>
          ${
            p.principal
              ? ''
              : `<button type="button" class="bouton--supprimer" data-supprimer="prets" data-index="${i}"
                  data-nom="${att(p.libelle)}" title="Supprimer">×</button>`
          }
        </span>
      </div>
      <div class="jetons">${jetons}</div>
      ${ouvert ? detailPret(p, i) : ''}
    </div>`;
}

/**
 * Q-16 - Table des cotisations et charges diverses. Le catalogue vient du
 * referentiel ; l'ecran n'y ajoute que l'interrupteur et la surcharge de valeur.
 * La colonne « Année 1 » est remplie par `rendreExploitation` depuis le resultat
 * du moteur, jamais recalculee ici.
 */
function rendreStructureCharges() {
  const table = document.getElementById('table-charges-diverses');
  if (!table) return;
  const saisie = etat.exploitation.charges_diverses ?? [];

  table.querySelector('tbody').innerHTML = CATALOGUE_CHARGES.length
    ? CATALOGUE_CHARGES.map((ref) => {
        const i = saisie.findIndex((c) => c.code === ref.code);
        const c = saisie[i] ?? { actif: false, valeur: ref.valeur };
        const taux = ASSIETTES_EN_TAUX.has(ref.assiette);
        const v = c.valeur ?? ref.valeur;
        return `<tr data-charge="${ref.code}">
        <td class="num"><input type="checkbox" data-champ="exploitation.charges_diverses.${i}.actif"
          data-type="booleen" data-structure="1" ${c.actif ? 'checked' : ''} /></td>
        <td>${att(ref.libelle)}</td>
        <td class="discret">${att(LIBELLES_ASSIETTE[ref.assiette] ?? ref.assiette)}</td>
        <td class="cellule-valeur">${
          taux
            ? `<input type="number" step="0.001" min="0"
          data-champ="exploitation.charges_diverses.${i}.valeur" data-type="pourcentage"
          value="${valNum(enPourcent(v))}" ${c.actif ? '' : 'disabled'} />`
            : `<input type="text" inputmode="decimal"
          data-champ="exploitation.charges_diverses.${i}.valeur" data-type="montant"
          value="${valMontant(v)}" ${c.actif ? '' : 'disabled'} />`
        }
          ${taux ? '<span class="unite">%</span>' : '<span class="unite">€</span>'}</td>
        <td class="discret">${ref.index ? att(ref.index) : 'aucune'}</td>
        <td class="num calc" data-charge-montant="${ref.code}"></td>
      </tr>`;
      }).join('')
    : '<tr><td colspan="6" class="vide">Aucun poste au référentiel.</td></tr>';

  rendreBlocRedevance();
  rendreZonage();
}

/**
 * Zonage : deduit de la commune quand elle est au referentiel, saisi sinon.
 *
 * Les deux selects restent presents dans les deux cas - le zonage doit toujours
 * etre lisible et corrigeable - mais l'ecran DIT d'ou vient la valeur. Un champ
 * prerempli sans provenance laisse croire a une saisie de l'utilisateur.
 */
function rendreZonage() {
  // La liste des communes suit le departement choisi : on choisit dans l'arrete
  // plutot que de saisir un nom, ce qui supprime la faute de frappe et rend la
  // correspondance exacte.
  const select = /** @type {HTMLSelectElement} */ (document.getElementById('select-commune'));
  const communes = communesDuDepartement(etat.identite.departement);
  if (select && select.dataset.departement !== String(etat.identite.departement ?? '')) {
    select.dataset.departement = String(etat.identite.departement ?? '');
    select.innerHTML =
      '<option value=""></option>' +
      communes.map((c) => `<option value="${att(c[1])}">${att(c[1])}</option>`).join('');
    // Une commune qui n'appartient pas au departement choisi n'a plus de sens.
    if (etat.identite.commune && !communes.some((c) => c[1] === etat.identite.commune)) {
      etat.identite.commune = null;
    }
    select.value = etat.identite.commune ?? '';
  }

  // La zone A/B/C suit la commune. On ne touche QUE ce select : repasser par
  // `rendreChampsStatiques` reecrirait tous les champs, curseur compris.
  const z = zonageDeLaCommune(etat.identite.commune, etat.identite.departement);
  if (z && etat.identite.zone_ABC !== z.zone_ABC) {
    etat.identite.zone_ABC = z.zone_ABC;
    const el = /** @type {HTMLSelectElement} */ (document.querySelector('[data-champ="identite.zone_ABC"]'));
    if (el) el.value = z.zone_ABC;
  }
}

/**
 * Q-27 - Bloc foyer. Deux regimes, et ils ne se saisissent pas pareil :
 *  - FORFAITAIRE : un montant negocie et son annee de valeur ;
 *  - TRANSPARENCE : rien a saisir, la redevance EST la somme des charges.
 * Afficher un champ « redevance » en transparence laisserait croire qu'il agit.
 */
function rendreBlocRedevance() {
  // Le regime se choisit desormais TRANCHE PAR TRANCHE, dans l'encart des
  // produits de chacune : l'aide accompagne donc chaque encart, et dit ce que
  // le regime choisi implique pour CETTE tranche.
  for (const el of document.querySelectorAll('[data-aide-redevance]')) {
    const code = /** @type {HTMLElement} */ (el).dataset.aideRedevance;
    const r = etat.regimes_par_produit?.[code] ?? {};
    el.textContent =
      (r.mode_redevance ?? 'forfaitaire') === 'transparence'
        ? '⚙ En transparence, le bailleur refacture ses frais : la redevance de cette tranche vaut ' +
          'sa part des charges de l’exercice, au prorata de surface utile (annuités d’emprunt et de ' +
          'fonds propres, gros entretien, gestion, taxe foncière, assurances). Elle suit chaque ' +
          'rupture de charges, les cotisations assises sur elle sont refacturées à leur tour, et la ' +
          'vacance ne s’y applique pas : le risque est porté par le gestionnaire.'
        : '⚙ En forfaitaire, la redevance est un montant négocié, indexé depuis son année de valeur. ' +
          'Elle ne suit pas les charges : vérifié sur l’annexe OP-6, où aucune rupture de charges ' +
          'ne laisse de trace sur 60 ans.';
  }
}

/**
 * Tri de la table des lots : colonne cliquee et sens, ou `null` pour l'ordre de
 * saisie. Etat purement visuel - il ne touche pas a `etat.lots`, qui reste dans
 * son ordre d'origine. C'est ce qui permet au troisieme clic de le retrouver, et
 * aux liaisons de saisie de continuer a pointer le bon lot : une ligne affiche
 * l'index REEL de son lot, quelle que soit sa place a l'ecran.
 * @type {{cle: string, sens: 'asc'|'desc'}|null}
 */
let triLots = null;

/**
 * Lots selectionnes, par index REEL - jamais par rang affiche, sinon un tri
 * deplacerait la selection sous les pieds de l'utilisateur.
 *
 * Etat purement visuel, comme le tri : il ne va ni dans `etat`, ni dans la
 * saisie memorisee, ni au moteur. Une selection est un geste en cours, pas une
 * propriete de l'operation - la retrouver a la reouverture serait une surprise.
 *
 * @type {Set<number>}
 */
const lotsSelectionnes = new Set();

/** Dernier lot coche : origine d'une selection par plage au clic majuscule. */
let dernierLotCoche = null;

/**
 * Champs qu'une modification propage aux autres lignes selectionnees.
 *
 * L'IDENTIFIANT en est exclu, et c'est le seul : c'est la reference du lot au
 * plan de vente. Le recopier sur vingt lignes ne ferait pas gagner une saisie,
 * il rendrait vingt lots indiscernables.
 */
const CHAMPS_LOT_PROPAGEABLES = new Set([
  'batiment', 'etage', 'typologie', 'code_produit', 'shab_m2', 'surfaces_annexes_m2',
]);

/**
 * Etat visuel de la selection : lignes teintees, case d'en-tete a trois etats,
 * et rappel de ce qu'une modification va toucher. Sans ce rappel, propager une
 * valeur sur des lignes hors de l'ecran ressemblerait a un bug.
 */
function rendreSelectionLots() {
  const n = lotsSelectionnes.size;
  const tous = /** @type {HTMLInputElement|null} */ (document.getElementById('select-tous-lots'));
  if (tous) {
    tous.checked = n > 0 && n === etat.lots.length;
    tous.indeterminate = n > 0 && n < etat.lots.length;
  }
  const rappel = document.getElementById('rappel-selection-lots');
  if (rappel) {
    rappel.hidden = n < 2;
    rappel.textContent =
      `${n} lots sélectionnés : modifier une cellule de l’un d’eux applique la valeur ` +
      'aux autres. L’ID reste propre à chaque lot.';
  }

  // Suppression groupee : le bouton n'existe QUE tant qu'une selection existe.
  // Une action qui detruit plusieurs lignes d'un coup n'a pas a rester offerte
  // en permanence - elle se propose quand elle a un sens, et disparait ensuite.
  const btn = document.getElementById('btn-supprimer-lots');
  if (btn) {
    btn.hidden = n === 0;
    btn.textContent = `Supprimer ${n} lot${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''}`;
  }
}

/**
 * Reporte une valeur saisie sur toutes les autres lignes selectionnees.
 * Ne fait rien si la ligne modifiee n'est pas elle-meme selectionnee : on ne
 * propage pas depuis l'exterieur d'une selection, ce serait agir a distance.
 * @returns {boolean} vrai si des lignes ont ete touchees
 */
function propagerSurLotsSelectionnes(chemin, valeur) {
  const m = /^lots\.(\d+)\.(\w+)$/.exec(chemin);
  if (!m) return false;
  const source = Number(m[1]);
  const champ = m[2];
  if (lotsSelectionnes.size < 2 || !lotsSelectionnes.has(source)) return false;
  if (!CHAMPS_LOT_PROPAGEABLES.has(champ)) return false;
  let touche = false;
  for (const i of lotsSelectionnes) {
    if (i === source || !etat.lots[i]) continue;
    etat.lots[i][champ] = valeur;
    touche = true;
  }
  return touche;
}

/**
 * Valeur de tri d'un lot, colonne par colonne. Les deux dernieres ne sont pas
 * saisies mais calculees : elles se lisent dans le dernier resultat du moteur,
 * et valent zero tant qu'il n'y en a pas.
 */
const VALEUR_TRI_LOT = {
  numero: (lot, i) => i,
  identifiant: (lot) => lot.identifiant ?? '',
  batiment: (lot) => lot.batiment ?? '',
  etage: (lot) => lot.etage ?? '',
  typologie: (lot) => lot.typologie ?? '',
  // Par rang reglementaire et non par ordre alphabetique : PLAI avant PLUS
  // avant PLS, comme partout ailleurs dans l'outil.
  code_produit: (lot) => ORDRE_PRODUITS.indexOf(lot.code_produit),
  shab_m2: (lot) => Number(lot.shab_m2) || 0,
  surfaces_annexes_m2: (lot) => Number(lot.surfaces_annexes_m2) || 0,
  su: (lot, i) => dernierResultat?.surfaces?.detail?.[i]?.su_m2 ?? 0,
  loyer: (lot, i) => {
    const d = dernierResultat?.surfaces?.detail?.[i];
    const l = dernierResultat?.loyers?.find((x) => x.code_produit === lot.code_produit);
    return d && l ? d.su_m2 * l.loyer_pratique_eur_m2 : 0;
  },
};

/**
 * Lots dans leur ordre d'AFFICHAGE, chacun avec son index reel. Le tri est
 * stable : a valeur egale, les lots restent dans leur ordre de saisie.
 * @returns {Array<{lot: Object, i: number}>}
 */
function ordreAffichageLots() {
  const lignes = etat.lots.map((lot, i) => ({ lot, i }));
  const valeur = triLots && VALEUR_TRI_LOT[triLots.cle];
  if (!valeur) return lignes;
  const signe = triLots.sens === 'desc' ? -1 : 1;
  return lignes.sort((a, b) => {
    const va = valeur(a.lot, a.i);
    const vb = valeur(b.lot, b.i);
    const c =
      typeof va === 'string'
        ? va.localeCompare(String(vb), 'fr', { numeric: true, sensitivity: 'base' })
        : va - vb;
    return c * signe;
  });
}

/** Fleche de tri et etat d'accessibilite sur les entetes cliquables. */
function rendreEntetesTriLots() {
  for (const th of document.querySelectorAll('#table-lots thead th[data-tri]')) {
    const el = /** @type {HTMLElement} */ (th);
    const actif = triLots?.cle === el.dataset.tri;
    el.setAttribute('aria-sort', actif ? (triLots.sens === 'asc' ? 'ascending' : 'descending') : 'none');
    const fleche = el.querySelector('.tri__fleche');
    if (fleche) fleche.textContent = actif ? (triLots.sens === 'asc' ? '▲' : '▼') : '';
  }
}

function rendreStructure() {
  // AVANT toute chose : ce qui n'a plus de tranche disparait. Place ici parce
  // que c'est le point de passage de tout changement de structure - ajout ou
  // suppression de lot, changement de financement, ouverture d'une simulation.
  elaguerProduitsAbsents();

  // --- Programme : une ligne par LOT ---
  const optionsProduit = (selection) =>
    produitsOrdonnes()
      .map((p) => `<option value="${p.code}" ${p.code === selection ? 'selected' : ''} ${p.v1 ? '' : 'disabled'}>${p.libelle}</option>`)
      .join('');

  // Les lots disparus ne restent pas selectionnes : sans cela, supprimer une
  // ligne laisserait une selection fantome qui recevrait les modifications
  // suivantes sans que rien ne l'indique a l'ecran.
  for (const i of [...lotsSelectionnes]) if (!etat.lots[i]) lotsSelectionnes.delete(i);

  const lotsAffiches = ordreAffichageLots();
  $('#table-lots').querySelector('tbody').innerHTML = etat.lots.length
    ? lotsAffiches
        .map(
          // `l` est le rang AFFICHE et non l'index du lot : la grille se
          // parcourt telle qu'elle est vue, tri compris, alors que les liaisons
          // de saisie continuent de pointer le lot reel.
          // La couleur du financement suit le lot : c'est la meme que celle de
          // sa colonne au prix de revient et de sa tranche partout ailleurs.
          // Une table de cinquante lots se relit alors par blocs, sans avoir a
          // lire la colonne « Financement » ligne a ligne.
          ({ lot, i }, l) => `<tr data-lot="${i}" data-rang="${i}"
             style="--cat:${catProduit(lot.code_produit)};--cat-fond:${catFondProduit(lot.code_produit)}"
             class="lot--tranche ${lotsSelectionnes.has(i) ? 'lot--selectionne' : ''}">
        <!-- La poignee a SA colonne, collee au bord : partagee avec la case a
             cocher, elle passait a la ligne et doublait la hauteur des rangs. -->
        <td class="col-poignee"><span class="poignee" draggable="true"
          title="Glisser pour réordonner">⠿</span></td>
        <td class="col-select"><input type="checkbox" class="lot__select" data-select-lot="${i}"
          aria-label="Sélectionner le lot ${i + 1}" ${lotsSelectionnes.has(i) ? 'checked' : ''} /></td>
        <td class="num num-poste">${i + 1}</td>
        <!-- L'ID est la reference du lot au plan de vente ou a l'EDD. Le N° a
             gauche, lui, n'est qu'un rang de saisie : il bouge des qu'on
             supprime une ligne, l'ID non. -->
        <td><input type="text" class="lot__id" data-champ="lots.${i}.identifiant"
          data-l="${l}" data-c="0" value="${att(lot.identifiant)}" placeholder="-" /></td>
        <td><input type="text" data-champ="lots.${i}.batiment" data-l="${l}" data-c="1" value="${att(lot.batiment)}" /></td>
        <td><input type="text" data-champ="lots.${i}.etage" data-l="${l}" data-c="2" value="${att(lot.etage)}" /></td>
        <td><select data-champ="lots.${i}.typologie" data-l="${l}" data-c="3">
          <option value=""></option>
          ${TYPOLOGIES.map((t) => `<option value="${t}" ${t === lot.typologie ? 'selected' : ''}>${t}</option>`).join('')}
        </select></td>
        <td><select data-champ="lots.${i}.code_produit" data-structure="1" data-l="${l}" data-c="4">${optionsProduit(lot.code_produit)}</select></td>
        <td><input type="text" inputmode="decimal" data-champ="lots.${i}.shab_m2" data-type="nombre"
          data-l="${l}" data-c="5" value="${valNum(lot.shab_m2)}" /></td>
        <td><input type="text" inputmode="decimal" data-champ="lots.${i}.surfaces_annexes_m2" data-type="nombre"
          data-l="${l}" data-c="6" value="${valNum(lot.surfaces_annexes_m2)}" /></td>
        <td class="calc" data-calc="su"></td>
        <td class="calc" data-calc="loyer"></td>
        <td class="col-action"><button type="button" class="bouton--supprimer" data-supprimer="lots" data-index="${i}" title="Supprimer">×</button></td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="13" class="vide">Aucun lot. Utiliser le générateur ci-dessus ou « + lot ».</td></tr>';
  rendreEntetesTriLots();
  rendreSelectionLots();
  // Reordonnancement des lots. Il agit sur `etat.lots`, l'ordre REEL, et non
  // sur l'ordre d'affichage : glisser une ligne alors qu'un tri est actif
  // deplacerait un lot a une place qu'on ne verrait pas. Le tri est donc leve.
  poserGlisser(document.getElementById('table-lots'), (de, vers) => {
    if (triLots) triLots = null;
    etat.lots = deplacer(etat.lots, de, vers);
    lotsSelectionnes.clear();
    rafraichirTout();
  });

  // --- Onglets et ecrans de tranche, un par produit present ---
  rendreStructureTranches();
  rendreStructureCharges();

  // Le generateur propose les produits du perimetre V1.
  const selGen = /** @type {HTMLSelectElement} */ (document.getElementById('gen-produit'));
  if (selGen && !selGen.options.length) {
    selGen.innerHTML = produitsOrdonnes()
      .filter((p) => p.v1)
      .map((p) => `<option value="${p.code}">${p.libelle}</option>`)
      .join('');
    /** @type {HTMLSelectElement} */ (document.getElementById('gen-typologie')).innerHTML =
      TYPOLOGIES.map((t) => `<option value="${t}" ${t === 'T2' ? 'selected' : ''}>${t}</option>`).join('');
  }

  rendreTablePrixRevient();
}

/**
 * R-TVA-3 - Table du prix de revient : un total qui se ventile, et une colonne
 * par tranche.
 *
 * Deux modes de saisie coexistent LIGNE PAR LIGNE :
 *  - total global, que le moteur ventile au prorata de surface utile ;
 *  - montants par tranche, quand la depense n'y est pas proportionnelle
 *    (un ascenseur qui ne dessert qu'un batiment). Le total en decoule alors.
 *
 * Les colonnes par tranche n'apparaissent qu'a partir de DEUX tranches : sur une
 * operation mono-produit elles ne feraient que recopier le total.
 */
function rendreTablePrixRevient() {
  const table = $('#table-postes');
  const codes = tranchesActives();
  const parTranche = codes.length > 1;
  const tva = afficherTVA();
  const masquerVides = /** @type {HTMLInputElement} */ (document.getElementById('masquer-vides'))?.checked;
  // La case suit l'etat, jamais l'inverse.
  const caseTVA = /** @type {HTMLInputElement} */ (document.getElementById('afficher-tva'));
  if (caseTVA) caseTVA.checked = tvaVisible;

  // --- En-tete sur DEUX rangees ---
  // La tranche coiffe ses colonnes au lieu d'etre repetee dans chacune : HT et
  // TVA d'un meme produit se lisent alors comme un bloc, et deux tranches
  // voisines ne se confondent plus. Un filet colore ouvre chaque bloc, un fond
  // teinte le porte jusqu'au bas du tableau.
  // Le bloc des tranches s'OUVRE sur un filet colore et se FERME sur le meme :
  // sans le second, la derniere tranche debordait visuellement sur les colonnes
  // de total qui la suivent.
  const finBloc = (c) => (c === codes[codes.length - 1] ? ' col-tranche--fin' : '');
  const groupes = codes
    .map(
      (c) =>
        `<th class="col-groupe${finBloc(c)}" colspan="${tva ? 2 : 1}" ` +
        `data-tranche="${c}" style="--cat:${catProduit(c)};--cat-fond:${catFondProduit(c)}">` +
        `<span class="col-groupe__puce"></span>${att(libelleProduit(c))}</th>`,
    )
    .join('');
  const sousColonnes = codes
    .map(
      (c) =>
        `<th class="num col-tranche col-tranche--debut${tva ? '' : finBloc(c)}" ` +
          `data-tranche="${c}" style="--cat:${catProduit(c)};--cat-fond:${catFondProduit(c)}">HT (€)</th>` +
        (tva
          ? `<th class="num col-tranche${finBloc(c)}" ` +
            `data-tranche="${c}" style="--cat:${catProduit(c)};--cat-fond:${catFondProduit(c)}">TVA</th>`
          : ''),
    )
    .join('');

  // La TVA appartient a la TRANCHE, jamais a l'operation : sa colonne unique
  // n'existe que quand il n'y a pas de colonnes de tranche ou la loger. Des deux
  // tranches, chaque bloc porte la sienne.
  const tvaGlobale = tva && !parTranche;
  const fixes = [
    ['num', 'N°'],
    ['', 'Poste'],
    ['num', 'Total HT (€)'],
    ['', ''],
    ...(tvaGlobale ? [['num', 'TVA']] : []),
  ];
  const fin = [
    ['num calc', 'TVA (€)'],
    ['num calc', 'Total TTC (€)'],
  ];
  const cellulesFixes = (l) =>
    l.map(([cl, t]) => `<th class="${cl}" ${parTranche ? 'rowspan="2"' : ''}>${t}</th>`).join('');

  table.querySelector('thead').innerHTML = parTranche
    ? `<tr>${cellulesFixes(fixes)}${groupes}${cellulesFixes(fin)}</tr><tr>${sousColonnes}</tr>`
    : `<tr>${cellulesFixes(fixes)}${cellulesFixes(fin)}</tr>`;
  const nbCols =
    4 + (tvaGlobale ? 1 : 0) + (parTranche ? codes.length * (tva ? 2 : 1) : 0) + 2;

  // GEOMETRIE FIGEE. Ventiler deplace la saisie de la colonne globale vers les
  // colonnes de tranche, et la TVA avec elle : a largeur libre, les colonnes se
  // redimensionnaient sur leur contenu et toute la table sautait a chaque
  // bascule. Les largeurs sont donc declarees, et seule la colonne des libelles
  // absorbe le reste.
  const col = (l) => `<col style="width:${l}px" />`;
  table.querySelector('colgroup')?.remove();
  table.insertAdjacentHTML(
    'afterbegin',
    `<colgroup>${col(38)}<col />${col(132)}${col(34)}${tvaGlobale ? col(96) : ''}` +
      (parTranche ? codes.map(() => col(124) + (tva ? col(96) : '')).join('') : '') +
      `${col(104)}${col(124)}</colgroup>`,
  );

  // La bascule n'a de sens qu'a partir de deux tranches. Son libelle nomme le
  // TRAJET - d'ou l'on part, vers ou l'on va - plutot que l'action : « ventiler »
  // et « regrouper » demandaient de savoir dans quel etat on se trouvait pour
  // deviner ce que le bouton allait faire.
  const btnTout = /** @type {HTMLButtonElement} */ (document.getElementById('btn-ventiler-tout'));
  if (btnTout) {
    // L'etat se lit sur TOUTES les lignes, comme la bascule les traite toutes :
    // le juger sur les seules lignes remplies faisait dire au bouton l'inverse
    // de ce qu'il allait faire des que le reste de la nomenclature divergeait.
    const toutVentile = etat.postes_bilan.length > 0 && etat.postes_bilan.every(estVentile);
    btnTout.hidden = !parTranche;
    btnTout.textContent = toutVentile ? '↤ Tranche vers global' : '⇥ Global vers tranche';
    btnTout.title = toutVentile
      ? 'Regrouper chaque poste en un montant unique, réparti à la surface utile'
      : 'Éclater chaque montant global sur les tranches, au prorata de la surface utile';
    btnTout.dataset.action = toutVentile ? 'regrouper' : 'ventiler';
  }

  // --- Corps, groupe par chapitre ---
  // Rang de grille : il compte les lignes de POSTE, en sautant les en-tetes de
  // chapitre et les sous-totaux, qui ne se saisissent pas. Le clavier parcourt
  // ainsi la saisie sans buter sur les lignes de structure.
  let rangGrille = 0;
  const lignes = [];
  for (const ch of referentiels.nomenclature_pdr.chapitres) {
    const indices = etat.postes_bilan
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.chapitre === ch.code);
    const visibles = masquerVides ? indices.filter(({ p }) => !nul(totalPoste(p))) : indices;
    // Un chapitre entierement vide disparait quand on masque : inutile de laisser
    // un en-tete et un sous-total a zero.
    if (!visibles.length) continue;

    lignes.push(
      // L'en-tete de chapitre porte de VRAIES cellules de tranche plutot qu'une
      // seule cellule traversante : un bloc de colonnes se ferme par un filet
      // continu, qu'une ligne traversante interrompait a chaque chapitre.
      `<tr class="chapitre-entete">` +
        `<td colspan="${4 + (tvaGlobale ? 1 : 0)}">${ch.numero} - ${att(ch.libelle)}</td>` +
        (parTranche
          ? codes
              .map(
                (c) =>
                  `<td class="col-tranche col-tranche--debut${tva ? '' : finBloc(c)}" data-tranche="${c}" style="--cat:${catProduit(c)}"></td>` +
                  (tva ? `<td class="col-tranche${finBloc(c)}" data-tranche="${c}" style="--cat:${catProduit(c)}"></td>` : ''),
              )
              .join('')
          : '') +
        `<td></td><td></td></tr>`,
    );

    for (const { p, i } of visibles) {
      const l = rangGrille++;
      const ventile = estVentile(p);
      const vide = nul(totalPoste(p));

      // Total : saisissable tant que la ligne n'est pas ventilee, calcule ensuite.
      // Deux verites pour la meme grandeur, ce serait une de trop.
      const celluleTotal = ventile
        ? `<td class="num calc" data-calc="total" title="Somme des tranches">-</td>`
        : `<td><input type="text" inputmode="decimal" data-champ="postes_bilan.${i}.montant_ht_eur"
             data-type="montant" data-l="${l}" data-c="0" value="${valMontant(p.montant_ht_eur)}" /></td>`;

      // Tous les taux du parametrage sont proposes, quel que soit le produit
      // de la tranche. Un taux deja saisi hors liste y est ajoute plutot que
      // perdu en silence - on ne reecrit pas une saisie sans le dire.
      const selectTVA = (chemin, valeur, col, code) => {
        const admis = tauxAdmis();
        const options = admis.includes(valeur) || nul(valeur) ? admis : [...admis, valeur].sort((a, b) => a - b);
        return `<select data-champ="${chemin}" data-type="nombre"${col === undefined ? '' : ` data-l="${l}" data-c="${col}"`}>
          ${options
            .map(
              (v) =>
                `<option value="${v}" ${v === valeur ? 'selected' : ''}${admis.includes(v) ? '' : ' data-hors-bareme="1"'}>` +
                `${pct(v, 1)}${admis.includes(v) ? '' : ' (hors barème)'}</option>`,
            )
            .join('')}
        </select>`;
      };

      const cellulesTranches = parTranche
        ? codes
            .map((c, ic) => {
              const style = `data-tranche="${c}" style="--cat:${catProduit(c)}"`;
              // Colonne 0 = le total ; les tranches suivent, HT puis TVA.
              const col = 1 + ic * (tva ? 2 : 1);
              // `--debut` porte le filet colore : il ouvre le bloc de la
              // tranche, il ne separe pas HT de sa TVA.
              const deb = `col-tranche col-tranche--debut${tva ? '' : finBloc(c)}`;
              if (!ventile) {
                // Ligne non ventilee : le MONTANT n'est qu'un apercu de ce que
                // la cle SU donnerait, en lecture seule. Le TAUX, lui, reste
                // saisissable : il appartient a la tranche, que le montant soit
                // saisi globalement ou tranche par tranche.
                return (
                  `<td class="num calc ${deb}" ${style} data-apercu="${c}"></td>` +
                  (tva
                    ? `<td class="col-tranche${finBloc(c)}" ${style}>${selectTVA(
                        `postes_bilan.${i}.taux_tva_par_produit.${c}`,
                        p.taux_tva_par_produit?.[c] ?? tauxProduit(c),
                        col + 1,
                        c,
                      )}</td>`
                    : '')
                );
              }
              return (
                `<td class="${deb}" ${style}><input type="text" inputmode="decimal"
                   data-champ="postes_bilan.${i}.montants_ht_par_produit.${c}" data-type="montant"
                   data-l="${l}" data-c="${col}"
                   value="${valMontant(p.montants_ht_par_produit?.[c])}" /></td>` +
                (tva
                  ? `<td class="col-tranche${finBloc(c)}" ${style}>${selectTVA(
                      `postes_bilan.${i}.taux_tva_par_produit.${c}`,
                      p.taux_tva_par_produit?.[c] ?? tauxProduit(c),
                      col + 1,
                      c,
                    )}</td>`
                  : '')
              );
            })
            .join('')
        : '';

      lignes.push(`<tr data-poste="${i}" class="${vide ? 'poste--vide' : ''} ${ventile ? 'poste--ventile' : ''}">
        <td class="num num-poste">${p.numero}</td>
        <td class="libelle-poste">${att(p.libelle)}</td>
        ${celluleTotal}
        <td class="col-action">${
          parTranche
            ? `<button type="button" class="bouton--ventiler" data-ventiler="${i}"
                 aria-pressed="${ventile}"
                 title="${ventile ? 'Regrouper en un total unique' : 'Ventiler ce montant sur les tranches'}">${ventile ? '↤' : '⇥'}</button>`
            : ''
        }</td>
        ${tvaGlobale ? `<td class="tva-taux">${selectTVA(`postes_bilan.${i}.taux_tva`, p.taux_tva, 1, codes[0])}</td>` : ''}
        ${cellulesTranches}
        <td class="calc" data-calc="tva"></td>
        <td class="calc" data-calc="ttc"></td>
      </tr>`);
    }

    // Sous-total du chapitre, decline SOUS CHAQUE COLONNE DE TRANCHE : une
    // colonne qu'on ne peut pas additionner ne sert qu'a moitie.
    const sousTotauxTranches = parTranche
      ? codes
          .map(
            (c) =>
              `<td class="num col-tranche col-tranche--debut${tva ? '' : finBloc(c)}" data-tranche="${c}" style="--cat:${catProduit(c)}" data-sous-total="${c}" data-cle="ht_eur"></td>` +
              (tva
                ? `<td class="num col-tranche${finBloc(c)}" data-tranche="${c}" style="--cat:${catProduit(c)}" data-sous-total="${c}" data-cle="tva_eur"></td>`
                : ''),
          )
          .join('')
      : '';
    lignes.push(
      `<tr class="chapitre-total" data-chapitre-total="${ch.code}">
        <td></td><td class="libelle">Sous-total ${att(ch.libelle.toLowerCase())}</td>
        <td class="num" data-total="ht"></td>
        <td></td>
        ${tvaGlobale ? '<td></td>' : ''}
        ${sousTotauxTranches}
        <td class="num" data-total="tva"></td><td class="num" data-total="ttc"></td>
      </tr>`,
    );
  }

  table.querySelector('tbody').innerHTML =
    lignes.join('') ||
    `<tr><td colspan="${nbCols}" class="vide">Aucun poste renseigné. Décocher « Masquer les lignes non renseignées » pour saisir.</td></tr>`;
}


// ---------------------------------------------------------------- rendu des valeurs

/** Remplit les cellules calculees et les pieds de table. Ne touche pas aux champs de saisie. */
function rendreValeurs(r) {
  const ind = r.indicateurs;

  // --- Programme : un lot par ligne ---
  const parProduit = {};
  for (const l of r.loyers) parProduit[l.code_produit] = l;
  // La SU d'un lot vient du moteur (`surfaces.detail`, meme ordre que `lots`) ;
  // son loyer est celui de sa TRANCHE applique a sa surface utile.
  for (const tr of document.querySelectorAll('#table-lots tbody tr[data-lot]')) {
    const i = Number(/** @type {HTMLElement} */ (tr).dataset.lot);
    const lot = r.surfaces.detail[i];
    const c = parProduit[etat.lots[i]?.code_produit];
    const set = (cle, v) => {
      const td = tr.querySelector(`[data-calc="${cle}"]`);
      if (td) td.textContent = v;
    };
    set('su', lot ? nb(lot.su_m2) : '-');
    set('loyer', lot && c ? eur(lot.su_m2 * c.loyer_pratique_eur_m2) : '-');
  }
  $('#table-lots').querySelector('tfoot').innerHTML = etat.lots.length
    ? `<tr>
        <td colspan="6" class="libelle">Total - ${nb(ind.nb_logements)} logements</td>
        <td class="num">${nb(ind.shab_m2)}</td>
        <td class="num">${nb(ind.surfaces_annexes_m2)}</td>
        <td class="num">${nb(ind.su_m2)}</td>
        <td class="num">${eur(ind.loyers_annuels_eur ? ind.loyers_annuels_eur / 12 : 0)}</td>
        <td></td>
      </tr>`
    : '';

  // --- Synthese par tranche ---
  const recap = r.surfaces.recapitulatif ?? {};
  $('#table-synthese-tranches').querySelector('tbody').innerHTML = r.loyers.length
    ? r.loyers
        .map((l) => {
          const t = recap[l.code_produit] ?? {};
          return `<tr data-tranche="${l.code_produit}">
            <td>${att(libelleProduit(l.code_produit))}</td>
            <td class="num">${nb(t.nb_lots)}</td>
            <td class="num">${nb(l.shab_m2)}</td>
            <td class="num">${nb(l.su_m2)}</td>
            <td class="num">${pct(t.quote_part_su, 1)}</td>
            <td class="num">${nb(l.cs)}</td>
            <td class="num">${nb(l.loyer_pratique_eur_m2)}</td>
            <td class="num">${eur(l.loyer_annuel_eur)}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="8" class="vide">Aucune tranche</td></tr>';
  $('#table-synthese-tranches').querySelector('tfoot').innerHTML = r.loyers.length
    ? `<tr><td class="libelle">Total</td><td class="num">${nb(etat.lots.length)}</td>
        <td class="num">${nb(ind.shab_m2)}</td><td class="num">${nb(ind.su_m2)}</td>
        <td class="num">100 %</td><td colspan="2"></td>
        <td class="num">${eur(ind.loyers_annuels_eur)}</td></tr>`
    : '';

  // --- Recapitulatif de l'ecran Operation ---
  $('#recap-operation').innerHTML = [
    { l: 'Logements', v: nb(ind.nb_logements), d: `${etat.lots.length} lot${etat.lots.length > 1 ? 's' : ''} saisi${etat.lots.length > 1 ? 's' : ''}` },
    { l: 'Tranches', v: r.surfaces.tranches.length, d: r.surfaces.tranches.map(libelleProduit).join(', ') || '-' },
    { l: 'Surface utile', v: `${nb(ind.su_m2)} m²`, d: `${nb(ind.shab_m2)} m² SHAB` },
    { l: 'Prix de revient', v: eur(ind.prix_revient_ttc_eur), d: `${eur(ind.prix_revient_par_logement_eur)} / logement` },
    // Sans le RMO : retire du recapitulatif a la demande du metier, comme il
    // l'avait deja ete de l'indicateur du plan de financement.
    { l: 'Loyers annuels', v: eur(ind.loyers_annuels_eur), d: '' },
    { l: 'Mise en location', v: r.calendrier.annee_mise_en_location, d: `${etat.dates.duree_simulation_ans} ans simulés` },
  ]
    .map((i) => `<div class="indicateur"><div class="indicateur__libelle">${i.l}</div>
      <div class="indicateur__valeur">${i.v}</div><div class="indicateur__detail">${i.d}</div></div>`)
    .join('');

  // --- Ecrans de tranche : bandeau et detail du loyer ---
  // Montants de pret CALCULES : ils sont reinjectes dans leur champ de saisie a
  // chaque recalcul, pour que l'ecran montre l'equilibre obtenu. Le champ garde
  // le focus s'il l'a : on n'ecrit jamais par-dessus une frappe en cours.
  for (const input of document.querySelectorAll('[data-montant-pret]')) {
    const el = /** @type {HTMLInputElement} */ (input);
    const i = Number(el.dataset.montantPret);
    if (etat.prets[i]?.montant_auto === false || el === document.activeElement) continue;
    // Un pret calcule a 0 EUR n'est pas amorti, donc absent des amortissements.
    // Il vaut bien zero, et le champ doit le dire : une case vide se lirait
    // comme « pas encore calcule ».
    const a = (r.financement?.prets_resolus ?? []).find((x) => x.code === etat.prets[i]?.code);
    const v = fMontantSaisie.format(Math.round(a?.montant_eur ?? 0));
    if (el.value !== v) el.value = v;
  }

  remplirTauxMarges(r);

  // Jetons de synthese d'un pret : taux, duree et revisabilite viennent du
  // PRODUIT tant qu'ils ne sont pas saisis. C'est donc le resultat qui les porte.
  // On lit `prets_resolus` et non `amortissements` : un pret dont le montant est
  // nul n'est pas amorti, mais son taux et sa duree sont determines. Les lire
  // dans les amortissements n'afficherait que des tirets.
  for (const ligne of document.querySelectorAll('.ligne--pret[data-pret]')) {
    const p = etat.prets[Number(/** @type {HTMLElement} */ (ligne).dataset.pret)];
    const a = (r.financement?.prets_resolus ?? []).find((x) => x.code === p?.code);
    const amorti = (r.amortissements ?? []).find((x) => x.code === p?.code);
    const poser = (champ, v) => {
      const el = ligne.querySelector(`[data-jeton="${champ}"]`);
      if (el) el.textContent = v ?? '-';
    };
    // Le jeton affiche le taux d'ORIGINE : Livret A de reference plus ou moins
    // la marge, borne par le plancher (decision du 11/08/2026). PAS le taux de
    // la premiere echeance, que la trajectoire du Livret A revise deja : la
    // vignette disait 1,80 % quand la synthese composait 1,30 %, et l'ecran
    // semblait se contredire. La revision se lit dans le tableau d'echeances.
    // `taux_applique` vient du moteur et vaut max(nominal, plancher) : un pret
    // Action Logement a -0,75 % nominal s'affiche bien a son 0,25 % plancher.
    const tauxPaye = a?.taux_applique ?? a?.taux;
    poser('taux', nul(tauxPaye) ? '-' : pct(tauxPaye, 2));
    // Le differe se lit DANS la vignette de duree, en mois : c'est la meme
    // question - combien de temps ce pret court, et a partir de quand - et
    // c'est l'unite du chantier, qui le commande. Un jeton separe le renvoyait
    // en fin de ligne, loin de la duree qu'il ampute.
    const dm = a?.differe_mois ?? 0;
    poser(
      'duree',
      nul(a?.duree_ans) ? '-' : `${a.duree_ans} ans${dm ? ` · différé ${dm} mois` : ''}`,
    );
    // Les modeles ne se proposent que sur un pret qui n'en porte pas encore.
    // Le rendu de structure le sait deja - appliquer un modele reconstruit la
    // ligne - mais la garde reste, au cas ou l'etat changerait sans rendu.
    const presets = ligne.querySelector('.pret__presets');
    if (presets) presets.hidden = Boolean(p?.preset);
    const reset = ligne.querySelector('[data-reset-pret]');
    if (reset) reset.hidden = !p || !pretModifie(p);

    // Ce que les reglages PRODUISENT, en clair, sous chaque groupe. Un pret se
    // juge sur son annuite et son terme, pas sur la valeur de ses parametres :
    // les recomposer de tete a chaque lecture etait le vrai cout du panneau.
    const dire = (cle, texte) => {
      const el = ligne.querySelector(`[data-synthese="${cle}"]`);
      if (el) el.textContent = texte;
    };
    const t = amorti?.tableau ?? [];
    if (a) {
      const la = r.financement?.livret_a_reference;
      // Le signe se porte sur l'OPERATEUR : « Livret A 1,50 % + -1,75 % » se
      // lit deux fois avant d'etre compris. Les prets Action Logement sont
      // indexes sous le Livret A, le cas est courant, pas anecdotique.
      const nominal =
        nul(a.spread) || nul(la)
          ? null
          : `Livret A ${pct(la, 2)} ${a.spread < 0 ? '−' : '+'} ${pct(Math.abs(a.spread), 2)}`;
      const plafonne =
        !nul(a.taux_plancher) && !nul(a.taux) && a.taux < a.taux_plancher
          ? `, sous le plancher : le prêt paie ${pct(a.taux_plancher, 2)}`
          : '';
      dire(
        'taux',
        nominal
          ? `${nominal} = ${pct(a.taux, 2)}${plafonne}${
              a.revisabilite && a.revisabilite !== 'TAUX FIXE'
                ? `, révisé chaque année (${a.revisabilite.toLowerCase()})`
                : ''
            }`
          : nul(a.taux)
            ? 'Taux à saisir.'
            : `${pct(a.taux, 2)}, fixe sur toute la durée.`,
      );

      const m = p?.periodicite ?? 1;
      const nom = PERIODICITES.find((x) => x.v === m)?.l ?? `${m} par an`;
      const constant = p?.profil_amortissement === 'constant';
      dire(
        'profil',
        nul(a.duree_ans)
          ? 'Durée à saisir.'
          : `${a.duree_ans * m} échéances ${nom.replace(/e$/, 'es')}` +
            `, ${constant ? 'à capital constant (l’annuité décroît)' : nul(a.progressivite) || a.progressivite === 0 ? 'à annuité constante' : `à annuité progressant de ${pct(a.progressivite, 2)} par an`}` +
            `${t.length ? `, première annuité ${eur(t.find((l) => l.annuite_eur > 0)?.annuite_eur ?? 0)}` : ''}.`,
      );

      const debut = amorti?.annee_premiere_echeance ?? p?.annee_premiere_echeance;
      const d = p?.differe_ans ?? 0;
      dire(
        'calendrier',
        nul(debut) || nul(a.duree_ans)
          ? 'Première échéance et durée à préciser.'
          : `De ${debut} à ${debut + a.duree_ans - 1}` +
            (d
              ? `, dont ${d} an${d > 1 ? 's' : ''} de différé (${
                  p.differe_type === 1 ? 'rien n’est dû' : 'les intérêts restent dus'
                }, le capital ne recule qu’à partir de ${debut + d})`
              : ', sans différé') +
            '.',
      );
    }
    poser('echeance', amorti?.annee_premiere_echeance ?? p?.annee_premiere_echeance ?? '-');
    poser('revisabilite', a?.revisabilite ?? p?.revisabilite ?? '-');
    const progr = a?.progressivite ?? p?.progressivite;
    poser('progressivite', nul(progr) ? '-' : pct(progr, 2));

    // Le detail replie n'existe pas dans le DOM : ces champs ne sont a remplir
    // que quand il est ouvert.
    const defaut = (champ, v) => {
      const el = ligne.querySelector(`[data-defaut="${champ}"]`);
      if (!el) return;
      if (el.tagName === 'OPTION') el.textContent = v ? `- du produit : ${v} -` : '- du produit -';
      // Segment d'heritage : la valeur heritee s'ecrit a cote du libelle, pas a
      // sa place - le bouton doit rester lisible quand rien n'est herite.
      else if (el.classList.contains('choix__defaut')) el.textContent = v ? ` (${v})` : '';
      else /** @type {HTMLInputElement} */ (el).placeholder = v ?? '';
    };
    defaut('taux', nul(a?.taux) ? '' : String(enPourcent(a.taux)));
    defaut('spread', nul(a?.spread) ? '' : String(enPourcent(a.spread)));
    defaut('duree', nul(a?.duree_ans) ? '' : String(a.duree_ans));
    defaut('echeance', amorti?.annee_premiere_echeance ? String(amorti.annee_premiere_echeance) : '');
    // Segments de revisabilite : sans saisie, l'EFFECTIVE vient du produit et
    // s'affiche comme active. Un DOUBLE herite et un DOUBLE saisi se montrent
    // pareil, a dessein : c'est le bouton de reinitialisation qui dit si le
    // pret s'ecarte de ses defauts, pas la couleur d'un segment.
    const idx = /** @type {HTMLElement} */ (ligne).dataset.pret;
    const revEffective = p?.revisabilite ?? a?.revisabilite ?? null;
    for (const b of ligne.querySelectorAll(`[data-poser-champ="prets.${idx}.revisabilite"]`)) {
      const actif = /** @type {HTMLElement} */ (b).dataset.valeur === revEffective;
      b.classList.toggle('choix__option--actif', actif);
      b.setAttribute('aria-pressed', String(actif));
    }
    defaut('progressivite', nul(a?.progressivite) ? '' : String(enPourcent(a.progressivite)));
    defaut('differe', a?.differe_mois ? String(a.differe_mois) : '');

  }

  for (const code of r.surfaces.tranches) {
    const t = recap[code] ?? {};
    const l = r.loyers.find((x) => x.code_produit === code);
    // Bandeau d'indicateurs plutot qu'une phrase : sept nombres alignes dans une
    // phrase se relisent mal, et c'est la premiere chose qu'on regarde en
    // arrivant sur la tranche.
    const bandeau = document.querySelector(`[data-recap-tranche="${code}"]`);
    if (bandeau) {
      const pretsTranche = (r.amortissements ?? []).filter((a) => a.produit === code);
      const totalPrets = pretsTranche.reduce((s, a) => s + a.montant_eur, 0);
      const ressources = totalPrets + (t.subventions_eur ?? 0) + (t.fonds_propres_eur ?? 0);
      const reste = (t.prix_revient_ttc_eur ?? 0) - ressources;
      const tuile = (l, v, d) =>
        `<div class="indicateur"><div class="indicateur__libelle">${l}</div>` +
        `<div class="indicateur__valeur">${v}</div><div class="indicateur__detail">${d}</div></div>`;
      // L'ordre suit celui des jauges qui encadrent l'ecran : le prix de revient
      // a gauche comme la jauge des emplois, les ressources a droite comme la
      // sienne. Ce qui coute et ce qui finance restent du meme cote partout.
      // Quatre tuiles et pas plus : le loyer a le detail de son encart, et le
      // cout unitaire comme l'annuite ont ete retires a la demande du metier -
      // la rangee tient d'autant mieux sur un ecran de portable.
      bandeau.innerHTML = [
        tuile('Prix de revient', eur(t.prix_revient_ttc_eur), 'TTC'),
        tuile('Programme', `${nb(t.nb_logements)} lgts`, `${nb(t.su_m2)} m² SU · ${pct(t.quote_part_su, 1)} de l’opération`),
        tuile(
          reste > 0 ? 'Reste à financer' : 'Financement',
          reste > 0 ? eur(reste) : 'couvert',
          reste > 0 ? 'ressources inférieures au prix de revient' : `${eur(t.fonds_propres_eur)} de fonds propres`,
        ),
        tuile('Ressources', eur(ressources), `${eur(totalPrets)} de prêts · ${eur(t.subventions_eur)} de subventions`),
      ].join('');
    }
    // Chaine de calcul du loyer en jetons, dans l'ordre ou elle se lit :
    // bareme, coefficient de structure, plafond, sortie, annuel.
    const chaine = document.querySelector(`[data-jetons-loyer="${code}"]`);
    if (chaine && l) {
      // Chaine en COLONNE : cinq etapes ne tiennent pas sur les 390 px d'un
      // encart en demi-largeur, et une chaine qui se replie sur deux rangs
      // cesse de se lire comme une chaine - la fleche de liaison se retrouve en
      // fin de rang, pointant vers le vide. Empilee, elle se lit comme le
      // calcul qu'elle est : une etape par ligne, valeurs alignees a droite.
      chaine.innerHTML = [
        ['Barème de zone', `${nb(l.loyer_base_eur_m2)} €/m²`],
        ['Coefficient de structure', nb(l.cs)],
        ['Loyer plafond', `${nb(l.loyer_max_base_eur_m2)} €/m²`],
        [l.force ? 'Loyer de sortie forcé' : 'Loyer de sortie', `${nb(l.loyer_pratique_eur_m2)} €/m²`],
        ['Loyer annuel', eur(l.loyer_annuel_eur)],
      ]
        .map(
          ([k, v], i, t) =>
            `<div class="chaine__etape ${i === t.length - 1 ? 'chaine__etape--fin' : ''}">
              <span class="chaine__cle">${att(k)}</span>
              <span class="chaine__valeur">${att(v)}</span>
            </div>`,
        )
        .join('');
    }

    // Poids de chaque ressource dans le prix de revient de SA tranche : c'est
    // la lecture utile, un montant seul ne dit pas s'il pese.
    const pr = t.prix_revient_ttc_eur ?? 0;
    const partFP = document.querySelector(`[data-part-fp="${code}"]`);
    if (partFP) partFP.textContent = pr > 0 ? pct((t.fonds_propres_eur ?? 0) / pr, 1) : '-';

    // R-FIN-7 : annuite servie si les fonds propres sont remuneres, annee de
    // reconstitution sinon. Les deux repondent a la meme question - quand
    // l'organisme revoit-il son argent - par deux mecaniques differentes.
    const fp = r.exploitation?.fonds_propres_par_tranche?.[code];

    // Apport laisse au calcul : la valeur se lit en filigrane, comme le montant
    // d'un pret automatique. On ecrit un PLACEHOLDER et non une valeur - poser
    // une valeur reviendrait a saisir a la place de l'utilisateur, et le champ
    // ne saurait plus dire s'il a ete rempli ou non.
    const champApport = /** @type {HTMLInputElement|null} */ (
      document.querySelector(`[data-apport-auto="${code}"]`)
    );
    if (champApport && fp) {
      champApport.placeholder =
        fp.montant_auto_eur === null ? '' : fMontantSaisie.format(fp.montant_auto_eur);
      champApport.title = fp.montant_auto
        ? `Calculé : ${pct(fp.taux_apport ?? 0, 1)} du prix de revient TTC de la tranche`
        : 'Montant saisi - le bouton « auto » rend la main au calcul';
      // L'etat auto se pose ICI et non au rendu de structure : taper un montant
      // ne reconstruit pas la table, seul ce passage voit la premiere frappe.
      champApport.closest('.ligne--fp')?.classList.toggle('fp--auto', fp.montant_auto === true);
    }

    // La part se saisit tant que le MONTANT est automatique. Des qu'un montant
    // est saisi, c'est lui qui commande : le champ de taux cede la place a la
    // part CONSTATEE, celle que le montant represente vraiment. Deux jetons et
    // non un champ qu'on desactive : desactive, il continuerait d'afficher un
    // taux qui n'a plus servi a rien.
    const jetonSaisi = document.querySelector(`[data-part-fp-saisie="${code}"]`);
    const jetonFige = document.querySelector(`[data-part-fp-figee="${code}"]`);
    const enAuto = fp?.montant_auto === true;
    if (jetonSaisi) {
      const champ = /** @type {HTMLInputElement} */ (jetonSaisi);
      // Le taux du referentiel se lit en filigrane, jamais comme valeur : posee,
      // elle deviendrait une saisie et cesserait de suivre le referentiel.
      champ.placeholder =
        fp?.taux_apport_reference === null || fp?.taux_apport_reference === undefined
          ? ''
          : String(Math.round(fp.taux_apport_reference * 1000) / 10);
      champ.title = fp?.taux_apport_surcharge
        ? `Part saisie. Vider le champ rend la main au référentiel (${pct(fp.taux_apport_reference ?? 0, 1)}).`
        : `Part du référentiel. Saisir une valeur ici remplace les ${pct(fp?.taux_apport_reference ?? 0, 1)}.`;
      const parent = champ.closest('.jeton');
      if (parent) /** @type {HTMLElement} */ (parent).hidden = !enAuto;
    }
    if (jetonFige) /** @type {HTMLElement} */ (jetonFige).hidden = enAuto;

    const annuite = document.querySelector(`[data-annuite-fp="${code}"]`);
    if (annuite) annuite.textContent = fp?.annuite_eur ? `${eur(fp.annuite_eur)}/an` : '-';
    const recon = document.querySelector(`[data-reconstitution-fp="${code}"]`);
    if (recon) {
      recon.textContent = fp?.reconstitues
        ? `${fp.duree_reconstitution_ans} ans`
        : (r.indicateurs?.annee_reconstitution_fonds_propres ?? 'non atteinte');
    }

    // Prets DERIVES d'une regle et non saisis : le CPLS nait du plafonnement du
    // PLS a 55 % du prix de revient. Il figure dans la liste, en lecture seule,
    // sinon son montant apparaitrait dans les totaux sans ligne pour l'expliquer.
    const derives = document.querySelector(`[data-prets-derives="${code}"]`);
    if (derives) {
      const lignes = (r.financement?.prets_resolus ?? []).filter(
        (p) => p.derive && p.produit === code && p.montant_eur > 0,
      );
      derives.innerHTML = lignes
        .map(
          (p) => `<div class="ligne ligne--pret pret--derive" style="--cat:${catProduit(code)}">
            <div class="pret__entete">
              <span class="pret__libelle">${att(p.libelle)}</span>
              <span class="pret__montant">${eur(p.montant_eur)}</span>
              <span class="pret__nature discret">${att(p.nature)}</span>
            </div>
            <div class="jetons">
              ${jeton('taux', nul(p.taux) ? '-' : pct(p.taux, 2))}
              ${jeton('durée', nul(p.duree_ans) ? '-' : `${p.duree_ans} ans`)}
              ${jeton('origine', 'plafond PLS 55 %')}
            </div>
          </div>`,
        )
        .join('');
    }

    // Jauges verticales : les emplois de la tranche a gauche, ses ressources a
    // droite, A LA MEME ECHELLE. Mises a l'echelle de leur propre total, deux
    // barres de hauteur egale masqueraient justement le desequilibre qu'elles
    // sont censees montrer.
    const emploisTr = Object.entries(r.bilan.chapitres ?? {})
      .map(([nom, ch]) => ({
        libelle: CHAPITRES[nom] ?? nom,
        montant: ch.par_tranche?.[code]?.ttc_lasm_eur ?? 0,
        couleur: couleur(nom),
      }))
      .filter((s) => s.montant > 0);
    const ressourcesTr = [
      { libelle: 'Subventions', montant: t.subventions_eur ?? 0, couleur: couleur('subventions') },
      { libelle: 'Fonds propres', montant: t.fonds_propres_eur ?? 0, couleur: couleur('fonds_propres') },
      ...(r.amortissements ?? [])
        .filter((a) => a.produit === code)
        .map((a) => ({
          libelle: a.libelle,
          montant: a.montant_eur,
          couleur: couleur(`pret_${a.nature}`),
        })),
    ].filter((s) => s.montant > 0);

    const somme = (l) => l.reduce((s, x) => s + x.montant, 0);
    const echelle = Math.max(somme(emploisTr), somme(ressourcesTr), 1);
    const remplirJauge = (quoi, segments) => {
      const el = document.querySelector(`[data-jauge="${quoi}"][data-tranche="${code}"]`);
      if (!el) return;
      const part = (s) => ((s.montant / echelle) * 100).toFixed(3);
      // Deux couches superposees : la barre, rognee pour garder ses coins
      // arrondis, et les etiquettes, qui doivent au contraire deborder. Une
      // seule couche ne peut pas faire les deux.
      const barre = segments
        .map(
          (s) =>
            `<span style="flex:0 0 ${part(s)}%;background:${s.couleur}"` +
            ` title="${att(s.libelle)} : ${eur(s.montant)}"></span>`,
        )
        .join('');
      // TOUS les postes sont etiquetes, y compris ceux de 2 %. Le texte etant
      // HORIZONTAL, une ligne tient dans 3 % de la hauteur : le minimum garanti
      // reste donc petit, et les etiquettes suivent leur segment de tres pres.
      const hauteurs = repartirLisible(segments.map((s) => s.montant / echelle), 0.032);
      const etiquettes = segments
        .map(
          (s, k) =>
            `<span style="flex:0 0 ${(hauteurs[k] * 100).toFixed(3)}%">` +
            `<i><b style="background:${s.couleur}"></b>${att(s.libelle)} - ${eur(s.montant)}</i></span>`,
        )
        .join('');
      el.innerHTML = `<span class="jauge__barre">${barre}</span><span class="jauge__etiquettes">${etiquettes}</span>`;
    };
    remplirJauge('emplois', emploisTr);
    remplirJauge('ressources', ressourcesTr);

    // Le regime se dit en toutes lettres : quatre combinaisons, et celle qui
    // sert des interets sans jamais rendre le capital merite d'etre nommee.
    const aideFP = document.querySelector(`[data-aide-fp="${code}"]`);
    if (aideFP) {
      aideFP.textContent = fp?.remuneres
        ? fp.reconstitues
          ? `⚙ Rémunérés à ${pct(fp.taux_remuneration, 2)} et reconstitués sur ${fp.duree_reconstitution_ans} ans : ` +
            'l’opération verse une annuité constante qui couvre l’intérêt et le remboursement, ' +
            'puis s’arrête au terme.'
          : `⚙ Rémunérés à ${pct(fp.taux_remuneration, 2)} sans reconstitution : l’opération sert l’intérêt ` +
            'chaque année mais ne rend jamais le capital, qui reste investi. La charge ne s’arrête pas.'
        : fp?.reconstitues
          ? `⚙ Reconstitués sur ${fp.duree_reconstitution_ans} ans sans rémunération : l’opération rend le ` +
            'capital par parts égales, sans le rémunérer.'
          : '⚙ Ni rémunérés ni reconstitués : aucune charge annuelle. Ils se reconstituent sur ' +
            'l’autofinancement dégagé, à l’année indiquée ci-dessus. La charge est une charge ' +
            'd’exploitation, elle ne change jamais le plan de financement.';
    }
  }

  for (const el of document.querySelectorAll('[data-part-sub]')) {
    const s = etat.subventions[Number(/** @type {HTMLElement} */ (el).dataset.partSub)];
    const pr = recap[s?.affectation]?.prix_revient_ttc_eur ?? 0;
    el.textContent = pr > 0 ? pct((Number(s?.montant_eur) || 0) / pr, 1) : '-';
  }

  // --- Postes : le detail vient du moteur, apparie par IDENTIFIANT et non par
  // rang, puisque les postes vides ne lui sont pas transmis. ---
  const b = r.bilan;
  const detailParId = Object.fromEntries((b.postes ?? []).filter((d) => d.id).map((d) => [d.id, d]));
  // Le detail GLOBAL porte TVA et TTC ; seul le detail VENTILE porte la
  // repartition par tranche. Les deux sont necessaires, il faut donc les deux
  // index : lire `par_tranche` sur le detail global renvoyait toujours vide.
  const ventileParId = Object.fromEntries(
    (b.ventilation?.postes ?? []).filter((d) => d.id).map((d) => [d.id, d]),
  );
  for (const tr of document.querySelectorAll('#table-postes tbody tr[data-poste]')) {
    const i = Number(/** @type {HTMLElement} */ (tr).dataset.poste);
    const idPoste = etat.postes_bilan[i]?.id;
    const d = detailParId[idPoste];
    const v = ventileParId[idPoste];
    const set = (cle, v) => {
      const td = tr.querySelector(`[data-calc="${cle}"]`);
      if (td) td.textContent = v;
    };
    // La ventilation fait foi des qu'elle existe : elle seule additionne les
    // TVA reellement dues tranche par tranche. Le detail global n'applique
    // qu'un taux unique, et divergerait du total affiche en pied de table.
    set('tva', v ? eur(v.tva_eur) : d ? eur(d.tva_eur) : '');
    set('ttc', v ? eur(v.ttc_eur) : d ? eur(d.ttc_eur) : '');
    // Total d'une ligne ventilee : il vient du moteur et se met a jour a chaque
    // frappe dans une cellule de tranche, sans rendu de structure.
    set('total', v ? eur(v.ht_eur) : d ? eur(d.ht_eur) : '');
    // Apercu de ce que la cle SU donnerait sur une ligne encore globale.
    for (const td of tr.querySelectorAll('[data-apercu]')) {
      const t = v?.par_tranche?.[/** @type {HTMLElement} */ (td).dataset.apercu];
      td.textContent = t ? eur(t.ht_eur) : '';
    }
    // Une ligne cesse d'etre grisee des qu'elle porte un montant, sans attendre
    // un rendu de structure : sinon elle reste visuellement « non renseignee ».
    tr.classList.toggle('poste--vide', nul(totalPoste(etat.postes_bilan[i] ?? {})));
  }

  // Sous-totaux de chapitre, tires des chapitres du moteur.
  for (const tr of document.querySelectorAll('#table-postes [data-chapitre-total]')) {
    const code = /** @type {HTMLElement} */ (tr).dataset.chapitreTotal;
    const c = b.chapitres[code];
    const set = (cle, v) => {
      const td = tr.querySelector(`[data-total="${cle}"]`);
      if (td) td.textContent = v;
    };
    set('ht', c ? eur(c.ht_eur) : eur(0));
    set('tva', c ? eur(c.tva_eur) : eur(0));
    set('ttc', c ? eur(c.ttc_eur) : eur(0));
    // Declinaison par tranche : la somme des cellules vaut le sous-total, le
    // moteur s'en charge (total impose a `arrondirEnConservantLaSomme`).
    for (const td of tr.querySelectorAll('[data-sous-total]')) {
      const e = /** @type {HTMLElement} */ (td);
      const t = c?.par_tranche?.[e.dataset.sousTotal];
      td.textContent = t ? eur(t[e.dataset.cle]) : '';
    }
  }
  const renseignes = etat.postes_bilan.filter((p) => !nul(totalPoste(p))).length;
  const ventiles = etat.postes_bilan.filter((p) => estVentile(p) && !nul(totalPoste(p))).length;
  // Le pied suit la largeur variable de l'en-tete : les colonnes de tranche
  // apparaissent et disparaissent avec le programme. Le compte est RECALCULE et
  // non lu sur le `thead`, qui tient desormais sur deux rangees.
  const codesTr = tranchesActives();
  const tvaVisible = afficherTVA();
  const parTr = codesTr.length > 1;
  const nbCols = 4 + (tvaVisible ? 1 : 0) + (parTr ? codesTr.length * (tvaVisible ? 2 : 1) : 0) + 2;
  const finTr = (c) => (c === codesTr[codesTr.length - 1] ? ' col-tranche--fin' : '');
  // Meme regle qu'au corps : la colonne de TVA globale n'existe que faute de
  // colonnes de tranche ou la loger. La TVA appartient a la tranche.
  const tvaGlobaleTr = tvaVisible && !parTr;
  const totauxTranches = parTr
    ? codesTr
        .map(
          (c) =>
            `<td class="num col-tranche col-tranche--debut${tvaVisible ? '' : finTr(c)}" data-tranche="${c}" style="--cat:${catProduit(c)}">${eur(b.par_tranche?.[c]?.total_ht_eur)}</td>` +
            (tvaVisible ? `<td class="num col-tranche${finTr(c)}" data-tranche="${c}" style="--cat:${catProduit(c)}">${eur(b.par_tranche?.[c]?.total_tva_eur)}</td>` : ''),
        )
        .join('')
    : '';

  $('#table-postes').querySelector('tfoot').innerHTML = `<tr>
      <td></td><td class="libelle">Prix de revient total</td>
      <td class="num">${eur(b.total_ht_eur)}</td><td></td>
      ${tvaGlobaleTr ? '<td></td>' : ''}
      ${totauxTranches}
      <td class="num">${eur(b.total_tva_eur)}</td>
      <td class="num">${eur(b.total_ttc_eur)}</td>
    </tr>
    <tr>
      <td></td><td class="libelle">Base finançable (TTC)</td>
      <td colspan="${2 + (tvaGlobaleTr ? 1 : 0)}"></td>
      ${
        parTr
          ? codesTr
              .map(
                (c) =>
                  `<td class="col-tranche col-tranche--debut${tvaVisible ? '' : finTr(c)}" data-tranche="${c}" style="--cat:${catProduit(c)}"></td>` +
                  (tvaVisible ? `<td class="col-tranche${finTr(c)}" data-tranche="${c}" style="--cat:${catProduit(c)}"></td>` : ''),
              )
              .join('')
          : ''
      }
      <td></td>
      <td class="num">${eur(b.total_ttc_module_eur)}</td>
    </tr>
    <tr class="resume-saisie">
      <td></td><td colspan="${3 + (tvaGlobaleTr ? 1 : 0)}" style="font-weight:400;color:var(--text-tertiary);border-top:none">
        ${renseignes} poste${renseignes > 1 ? 's' : ''} renseigné${renseignes > 1 ? 's' : ''}
        sur ${etat.postes_bilan.length} de la nomenclature${
          ventiles ? ` · ${ventiles} ventilé${ventiles > 1 ? 's' : ''} à la main` : ''
        }
      </td>
      ${
        // Meme la ligne de resume porte ses cellules de tranche : le filet du
        // bloc doit descendre jusqu'a la derniere ligne du tableau, sinon il
        // s'arrete en l'air.
        parTr
          ? codesTr
              .map(
                (c) =>
                  `<td class="col-tranche col-tranche--debut${tvaVisible ? '' : finTr(c)}" data-tranche="${c}" style="--cat:${catProduit(c)};border-top:none"></td>` +
                  (tvaVisible ? `<td class="col-tranche${finTr(c)}" data-tranche="${c}" style="--cat:${catProduit(c)};border-top:none"></td>` : ''),
              )
              .join('')
          : ''
      }
      <td style="border-top:none"></td><td style="border-top:none"></td>
    </tr>`;
  // --- Repartition du prix de revient, sur l'ecran Prix de revient ---
  const vent = r.bilan.ventilation;
  const tvp = $('#table-ventilation-pdr');
  if (vent && tvp) {
    tvp.querySelector('tbody').innerHTML = Object.entries(vent.par_tranche)
      .map(
        ([code, t]) => `<tr data-tranche="${code}"><td>${att(libelleProduit(code))}</td><td class="num">${nb(t.su_m2)}</td>
          <td class="num">${pct(t.part_su, 1)}</td><td class="num">${eur(t.total_ht_eur)}</td>
          <td class="num">${pct(t.taux_lasm, 1)}</td><td class="num">${eur(t.total_ttc_lasm_eur)}</td></tr>`,
      )
      .join('');
    tvp.querySelector('tfoot').innerHTML = `<tr><td class="libelle">Total</td>
      <td class="num">${nb(ind.su_m2)}</td><td class="num">100 %</td>
      <td class="num">${eur(vent.total_ht_eur)}</td><td></td>
      <td class="num">${eur(vent.total_ttc_lasm_eur)}</td></tr>`;
    const taux = [...new Set(Object.values(vent.par_tranche).map((t) => t.taux_lasm))];
    $('#aide-ventilation-pdr').textContent =
      `⚙ Chaque poste est saisi globalement puis réparti au prorata de surface utile, ` +
      `puis chaque tranche applique son propre taux de livraison à soi-même` +
      `${taux.length > 1 ? ` (${taux.map((x) => pct(x, 1)).join(' et ')} ici)` : ''}.`;
  }
  if ($('#bloc-ventilation-pdr')) $('#bloc-ventilation-pdr').hidden = !vent;

  rendreFinancement(r);
  rendreTresorerie(r);
  rendreExploitation(r);
}

/**
 * Encre noire ou blanche selon la LUMINANCE du fond, au seuil ou les deux
 * ratios de contraste WCAG s'egalent (~0,19). Les couleurs de segments sont
 * resolues au rendu et changent avec le theme : en sombre la palette est
 * pastel et reclame une encre sombre, en clair plusieurs teintes s'assombrissent
 * et repassent a l'encre blanche. Decider par calcul suit les deux cas - un
 * blanc code en dur tombait a 1,9:1 sur le jaune PLS.
 */
function encreSombreSur(couleurCss) {
  const m = couleurCss.trim().match(/^#?([0-9a-f]{6})$/i);
  const [r, g, b] = m
    ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16))
    : (couleurCss.match(/[\d.]+/g) ?? ['255', '255', '255']).slice(0, 3).map(Number);
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) > 0.19;
}

function rendreBarre(element, segments, echelle) {
  element.innerHTML = segments
    .filter((s) => s.montant > 0)
    .map((s) => {
      const etiquette = s.montant / echelle > 0.07 ? `<span>${eur(s.montant)}</span>` : '';
      const encre = encreSombreSur(s.couleur) ? ' segment--encre-sombre' : '';
      return `<div class="segment${encre}" style="flex-grow:${s.montant};background:${s.couleur}" title="${att(s.libelle)} : ${eur(s.montant)}">${etiquette}</div>`;
    })
    .join('');
  const total = segments.reduce((t, s) => t + Math.max(0, s.montant), 0);
  if (total < echelle) element.insertAdjacentHTML('beforeend', `<div style="flex-grow:${echelle - total}"></div>`);
}

/**
 * Perimetre affiche sur le plan de financement : l'operation entiere, ou une
 * seule tranche. Une operation mixte n'a pas UN plan de financement mais autant
 * de plans qu'elle porte de produits, et c'est a ce niveau que se juge un
 * equilibre - une tranche peut etre sous-financee quand l'ensemble tombe juste.
 */
let vueFinancement = 'consolide';

/**
 * Reduit le resultat au perimetre demande. Toutes les valeurs viennent du
 * MOTEUR : la ventilation des subventions non affectees, notamment, est une
 * regle de calcul (`financement.par_tranche`), pas une commodite d'affichage.
 * La refaire ici serait la deuxieme occasion de s'en ecarter.
 */
function perimetreFinancement(r) {
  const ind = r.indicateurs;
  const eq = r.financement.equilibre;
  const tranches = r.surfaces?.tranches ?? [];
  // Le perimetre retombe sur le consolide des que la tranche choisie disparait
  // du programme : un ecran fige sur une tranche effacee n'afficherait rien.
  const code = tranches.includes(vueFinancement) ? vueFinancement : null;

  if (!code) {
    const emplois = Object.entries(r.bilan.chapitres).map(([c, v]) => ({
      libelle: CHAPITRES[c] ?? c,
      montant: v.ttc_lasm_eur,
      ht: v.ht_eur,
      couleur: COULEURS[c] ?? COULEURS.frais_divers,
    }));
    if (r.bilan.modulation_ttc_eur) {
      emplois.push({ libelle: 'Modulation', montant: r.bilan.modulation_ttc_eur, ht: null, couleur: COULEURS.modulation });
    }
    return {
      code: null,
      emplois,
      total_emplois: ind.prix_revient_ttc_eur,
      ht_eur: r.bilan.total_ht_eur,
      nb_logements: ind.nb_logements,
      shab_m2: ind.shab_m2,
      su_m2: ind.su_m2,
      loyers_annuels_eur: ind.loyers_annuels_eur,
      prix_revient_par_logement_eur: ind.prix_revient_par_logement_eur,
      prix_revient_par_m2_shab_eur: ind.prix_revient_par_m2_shab_eur,
      subventions_eur: ind.subventions_eur,
      // En consolide, chaque subvention compte pour son montant entier : c'est
      // la ventilation qui n'a pas lieu d'etre, pas la ligne.
      subventions: (r.financement.subventions_detail ?? []).map((l) => ({
        libelle: l.libelle,
        montant_eur: l.montant_eur,
        montant_total_eur: l.montant_eur,
        affectation: l.affectation,
        ventilee: false,
      })),
      fonds_propres_eur: ind.fonds_propres_eur,
      taux_fonds_propres: ind.taux_fonds_propres,
      amortissements: r.amortissements,
      total_prets_eur: r.financement.total_prets_eur,
      total_prets_cdc_eur: r.financement.total_prets_cdc_eur,
      ratio_prets_cdc: eq.ratio_prets_cdc,
      total_ressources: ind.ressources_eur,
      ecart_eur: eq.ecart_eur,
    };
  }

  const t = r.financement.par_tranche?.[code] ?? {};
  const l = r.loyers?.find((x) => x.code_produit === code) ?? {};
  const emplois = Object.entries(t.chapitres ?? {})
    .filter(([, v]) => v)
    .map(([c, v]) => ({
      libelle: CHAPITRES[c] ?? c,
      montant: v.ttc_lasm_eur,
      ht: v.ht_eur,
      couleur: COULEURS[c] ?? COULEURS.frais_divers,
    }));
  const amortissements = r.amortissements.filter((a) => a.produit === code);
  const cdc = amortissements.filter((a) => a.nature !== 'autre').reduce((s, a) => s + a.montant_eur, 0);
  const ht = emplois.reduce((s, e) => s + (e.ht ?? 0), 0);
  const pr = t.prix_revient_ttc_eur ?? 0;
  return {
    code,
    emplois,
    total_emplois: pr,
    ht_eur: ht,
    nb_logements: l.nb_logements ?? 0,
    shab_m2: l.shab_m2 ?? 0,
    su_m2: l.su_m2 ?? 0,
    loyers_annuels_eur: l.loyer_annuel_eur ?? 0,
    prix_revient_par_logement_eur: l.nb_logements ? Math.round(pr / l.nb_logements) : null,
    prix_revient_par_m2_shab_eur: l.shab_m2 ? Math.round(pr / l.shab_m2) : null,
    subventions_eur: t.subventions_eur ?? 0,
    subventions: t.subventions ?? [],
    fonds_propres_eur: t.fonds_propres_eur ?? 0,
    taux_fonds_propres: pr ? (t.fonds_propres_eur ?? 0) / pr : 0,
    amortissements,
    total_prets_eur: t.total_prets_eur ?? 0,
    total_prets_cdc_eur: Math.round(cdc),
    ratio_prets_cdc: pr ? cdc / pr : 0,
    total_ressources: t.ressources_eur ?? 0,
    ecart_eur: t.ecart_eur ?? 0,
  };
}

/** Selecteur de perimetre : consolide, puis une entree par tranche. */
function rendrePerimetreFinancement(r) {
  const barre = document.getElementById('vue-financement');
  if (!barre) return;
  const tranches = r.surfaces?.tranches ?? [];
  // A une seule tranche, le consolide EST la tranche : proposer un choix entre
  // deux vues identiques ne ferait qu'encombrer.
  barre.hidden = tranches.length < 2;
  if (barre.hidden) return;
  const actif = tranches.includes(vueFinancement) ? vueFinancement : 'consolide';
  barre.innerHTML =
    `<button type="button" class="bascule__option ${actif === 'consolide' ? 'bascule__option--actif' : ''}"
       data-vue-financement="consolide">Consolidé</button>` +
    tranches
      .map(
        (c) => `<button type="button" class="bascule__option ${actif === c ? 'bascule__option--actif' : ''}"
          data-vue-financement="${att(c)}" style="--cat:${catProduit(c)}">
          <span class="bascule__puce"></span>${att(libelleProduit(c))}</button>`,
      )
      .join('');
}

function rendreFinancement(r) {
  rendrePerimetreFinancement(r);
  const p = perimetreFinancement(r);

  // Ordre de MONTAGE : les subventions d'abord, ce qu'on va chercher ; les
  // prets ensuite, ce qu'on emprunte ; les fonds propres en dernier, parce
  // qu'ils bouchent ce qui reste. C'est aussi l'ordre dans lequel on les
  // decide, et le solde se lit alors au bout de la barre.
  const ressources = [];
  if (p.subventions_eur) ressources.push({ libelle: 'Subventions', montant: p.subventions_eur, couleur: COULEURS.subventions });
  // Les prets se lisent en DEUX postes et non un par ligne. Sept lignes de prets
  // pour deux subventions donnaient a la legende le detail d'un tableau
  // d'emprunts, alors qu'elle repond a une seule question : d'ou vient l'argent.
  // Les prets structurants d'une tranche - CDC foncier, construction, CPLS - ne
  // se choisissent pas un par un, ils sortent du meme calcul d'equilibre : les
  // separer n'apprend rien. Le detail reste entier dans le tableau des prets.
  const cumulerPrets = (libelle, lot, couleur) => {
    const montant = lot.reduce((s, a) => s + a.montant_eur, 0);
    if (montant > 0) ressources.push({ libelle, montant, couleur });
  };
  // Pluriel dans les deux cas : ce sont des POSTES de la legende, pas des prets.
  // Un intitule qui change de nombre selon le contenu de la ligne se lit comme
  // un decompte, et on se met a chercher combien de prets se cachent derriere.
  cumulerPrets(
    'Prêts principaux',
    p.amortissements.filter((a) => a.principal),
    COULEURS.pret_construction,
  );
  cumulerPrets(
    'Autres prêts',
    p.amortissements.filter((a) => !a.principal),
    COULEURS.pret_autre,
  );
  if (p.fonds_propres_eur) {
    ressources.push({
      libelle: 'Fonds propres',
      montant: p.fonds_propres_eur,
      couleur: COULEURS.fonds_propres,
    });
  }

  // Les totaux viennent du moteur ; l'echelle des barres, elle, est un choix de
  // presentation et peut se deduire des segments.
  const echelle = Math.max(p.total_emplois, p.total_ressources, 1);

  rendreBarre($('#barre-emplois'), p.emplois, echelle);
  rendreBarre($('#barre-ressources'), ressources, echelle);
  $('#total-emplois').textContent = eur(p.total_emplois);
  $('#total-ressources').textContent = eur(p.total_ressources);
  // Une legende PAR COTE, et le poids de chaque poste dans SON total : la part
  // d'un pret se lit dans les ressources, pas dans le prix de revient.
  //
  // Le cote emplois porte DEUX montants par chapitre, le HT et le TTC apres
  // livraison a soi-meme : c'est l'ecart entre les deux qui fait la TVA de
  // l'operation, et le lire ailleurs obligeait a tenir deux listes identiques
  // a l'ecran. Une ligne d'entete nomme les colonnes, sans quoi deux nombres
  // cote a cote ne se distinguent pas.
  const legende = (segments, total, avecHT = false) => {
    const entete = avecHT
      ? `<div class="legende__item legende__item--entete" aria-hidden="true">
        <span></span><span></span><span>HT</span><span>TTC</span><span>Part</span></div>`
      : '';
    return (
      entete +
      segments
        .filter((s) => s.montant > 0)
        .map(
          (s) => `<div class="legende__item"><span class="legende__puce" style="background:${s.couleur}"></span>
        <span class="legende__libelle">${att(s.libelle)}</span>
        ${avecHT ? `<span class="legende__ht">${nul(s.ht) ? '-' : eur(s.ht)}</span>` : ''}
        <span class="legende__montant">${eur(s.montant)}</span>
        <span class="legende__part">${total ? pct(s.montant / total, 1) : '-'}</span></div>`,
        )
        .join('')
    );
  };
  $('#legende-emplois').innerHTML = legende(p.emplois, p.total_emplois, true);
  $('#legende-ressources').innerHTML = legende(ressources, p.total_ressources);

  // Sous chaque total, ce que la barre ne peut pas montrer : le total HT et les
  // ratios d'un cote, l'equilibre de l'autre.
  $('#precision-emplois').innerHTML =
    `${eur(p.ht_eur)} HT · ${eur(p.prix_revient_par_logement_eur)} / logement · ` +
    `${eur(p.prix_revient_par_m2_shab_eur)} / m² SHAB`;
  // Le besoin en prets CDC est deja une tuile d'indicateur : le redire ici
  // n'apprendrait rien. Ce que les deux totaux ne disent pas, c'est s'ils sont
  // egaux - a sept chiffres, l'oeil ne le voit pas. C'est donc le controle
  // d'equilibre qui prend la place.
  $('#precision-ressources').innerHTML = p.ecart_eur
    ? `<span class="precision--alerte">Écart de ${eur(p.ecart_eur)} avec les emplois</span>`
    : `<span class="discret">Plan équilibré</span>`;

  const corps = $('#table-prets').querySelector('tbody');
  const pied = $('#table-prets').querySelector('tfoot');
  if (!p.amortissements.length) {
    corps.innerHTML = '<tr><td colspan="9" class="vide">Aucun prêt mobilisé</td></tr>';
    pied.innerHTML = '';
  } else {
    corps.innerHTML = p.amortissements
      .map((a) => {
        const t = a.tableau;
        const total = t.reduce((s, l) => s + l.annuite_eur, 0);
        return `<tr>
          <td>${att(a.libelle)}</td><td class="num">${eur(a.montant_eur)}</td>
          <td class="num">${nul(a.taux_saisi) ? '-' : pct(a.taux_saisi)}</td>
          <td class="num">${pct(t[0].taux)}</td><td class="num">${t.length} ans</td>
          <td class="num">${t[0].annee}</td><td class="num">${eur(t[0].annuite_eur)}</td>
          <td class="num">${eur(t.at(-1).annuite_eur)}</td><td class="num">${eur(total)}</td>
        </tr>`;
      })
      .join('');
    pied.innerHTML = `<tr><td class="libelle">Total</td>
      <td class="num">${eur(p.total_prets_eur)}</td><td colspan="7"></td></tr>`;
  }

  // Subventions ligne par ligne, avec leur poids dans le prix de revient du
  // perimetre affiche. Une ligne VENTILEE porte aussi son montant d'origine :
  // sans lui, on lirait « Agglomération 20 000 € » sans savoir que la
  // subvention en vaut 30 000 dont deux tiers pour une autre tranche.
  $('#liste-subventions').innerHTML = p.subventions.length
    ? `<div class="liste liste--sub">${p.subventions
        .map(
          (s) => `<div class="ligne ligne--sub">
        <span class="sub__libelle">${att(s.libelle)}</span>
        <span class="sub__montant">${eur(s.montant_eur)}</span>
        <span class="sub__part">${p.total_emplois ? pct(s.montant_eur / p.total_emplois, 1) : '-'}</span>
        ${
          s.ventilee
            ? `<span class="sub__origine">ventilée · ${eur(s.montant_total_eur)} au total</span>`
            : s.affectation
              ? `<span class="sub__origine">${att(libelleProduit(s.affectation))}</span>`
              : ''
        }
      </div>`,
        )
        .join('')}</div>
      <div class="sub__total"><span>Total</span><span>${eur(p.subventions_eur)}</span>
        <span>${p.total_emplois ? pct(p.subventions_eur / p.total_emplois, 1) : '-'}</span></div>`
    : '<p class="vide">Aucune subvention sur ce périmètre.</p>';

  const ecarts = p.amortissements.filter((a) => !nul(a.taux_saisi) && Math.abs(a.tableau[0].taux - a.taux_saisi) > 1e-9);
  $('#aide-taux').textContent = ecarts.length
    ? `⚙ Le taux appliqué diffère du taux saisi : la révision Livret A joue dès la première ` +
      `échéance. Profil ${r.profil_trajectoires ?? 'non renseigné'}.`
    : '';

  // Le prix de revient a quitte ces tuiles : la balance le porte deja, en gros
  // et avec ses ratios. Le RMO aussi, retire a la demande du metier.
  //
  // Les deux dernieres tuiles ne s'affichent qu'en consolide : la reconstitution
  // des fonds propres et l'entree en TFPB se lisent sur le compte d'exploitation
  // de l'OPERATION. Les repeter sous une tranche leur ferait dire ce qu'elles ne
  // disent pas.
  const tuiles = [
    { l: 'Coût au m² SHAB', v: eur(p.prix_revient_par_m2_shab_eur), d: `${nb(p.shab_m2)} m² SHAB` },
    { l: 'Surface utile', v: `${nb(p.su_m2)} m²`, d: `${nb(p.nb_logements)} logements` },
    { l: 'Loyers annuels', v: eur(p.loyers_annuels_eur), d: `${nb(p.nb_logements)} logements loués` },
    { l: 'Fonds propres', v: pct(p.taux_fonds_propres), d: eur(p.fonds_propres_eur) },
    { l: 'Prêts CDC', v: pct(p.ratio_prets_cdc), d: eur(p.total_prets_cdc_eur) },
  ];
  if (!p.code) {
    tuiles.push(
      {
        l: 'Reconstitution FP',
        v: r.indicateurs.annee_reconstitution_fonds_propres ?? 'non atteinte',
        d: 'cumul d’autofinancement ≥ fonds propres',
      },
      { l: 'Début TFPB', v: r.indicateurs.annee_debut_tfpb, d: 'fin d’exonération' },
    );
  }
  $('#indicateurs').innerHTML = tuiles
    .map((i) => `<div class="indicateur"><div class="indicateur__libelle">${i.l}</div>
      <div class="indicateur__valeur">${i.v}</div><div class="indicateur__detail">${i.d}</div></div>`)
    .join('');

  rendreControles(r);
}


/**
 * Controles TOUJOURS visibles, y compris satisfaits : masquer un controle qui
 * passe rend l'absence d'alerte indistinguable de l'absence de controle.
 * Les libelles decrivent l'ETAT CONSTATE, jamais une affirmation figee.
 */
function rendreControles(r) {
  const eq = r.financement.equilibre;
  const alerteHorizon = r.alertes.find((a) => /horizon de simulation/i.test(a));
  const alerteLignes = r.alertes.find((a) => /lignes de programme/i.test(a));
  const loyerHorsPlafond = r.loyers.filter((l) => l.force && l.loyer_pratique_eur_m2 > l.loyer_max_base_eur_m2);
  const sansProgramme = !r.indicateurs.nb_logements || !r.indicateurs.su_m2;

  const controles = [
    {
      ok: eq.equilibre,
      libelle: eq.equilibre ? 'Emplois et ressources s’équilibrent' : `Emplois et ressources : écart de ${eur(eq.ecart_eur)}`,
      grave: true,
    },
    {
      ok: !sansProgramme,
      libelle: sansProgramme
        ? 'Programme vide : aucun logement ni surface saisis, les indicateurs sont sans objet'
        : `Programme renseigné : ${nb(r.indicateurs.nb_logements)} logements, ${nb(r.indicateurs.su_m2)} m² SU`,
      grave: true,
    },
    {
      ok: eq.ratio_prets_cdc === null || !r.alertes.some((a) => /ratio prets cdc/i.test(a)),
      libelle: `Ratio prêts CDC ${pct(eq.ratio_prets_cdc)} sur le prix de revient`,
    },
    {
      ok: loyerHorsPlafond.length === 0,
      libelle: loyerHorsPlafond.length
        ? `Loyer forcé au-delà du plafond sur ${loyerHorsPlafond.map((l) => l.code_produit).join(', ')}`
        : 'Loyers de sortie dans le plafond réglementaire',
    },
    {
      ok: !alerteHorizon,
      libelle: alerteHorizon ?? 'Toutes les annuités tombent dans l’horizon de simulation',
    },
    {
      // Depuis la ventilation, le multi-tranches n'est plus une approximation :
      // le controle constate la cle appliquee au lieu de signaler un defaut.
      ok: true,
      libelle: r.bilan.ventilation
        ? `Prix de revient ventilé au prorata de surface utile sur ` +
          `${r.surfaces.tranches.length} tranche${r.surfaces.tranches.length > 1 ? 's' : ''} ` +
          `(${r.surfaces.tranches.join(', ')})`
        : 'Aucune tranche à ventiler',
    },
    {
      ok: !alerteLignes,
      libelle: alerteLignes ?? 'Une ligne de programme par tranche de financement',
    },
  ];

  const passes = controles.filter((c) => c.ok).length;
  const echecs = controles.length - passes;

  $('#controles').innerHTML = controles
    .map((c) => {
      const classe = c.ok ? 'ok' : c.grave ? 'erreur' : 'alerte';
      const libelleEtat = c.ok ? 'OK' : c.grave ? 'Erreur' : 'Alerte';
      return `<li class="controle controle--${classe}"><span class="controle__etat">${libelleEtat}</span>
        <span class="controle__texte">${att(c.libelle)}</span></li>`;
    })
    .join('');

  // Toute alerte du moteur non reprise par un controle est affichee telle quelle :
  // aucun message du moteur ne doit se perdre en route.
  const reprises = [alerteHorizon, alerteLignes].filter(Boolean);
  const restantes = r.alertes.filter((a) => !reprises.includes(a) && !/ratio prets cdc/i.test(a));
  $('#messages-moteur').innerHTML = restantes.length
    ? `<p class="aide" style="margin-top:14px"><strong>Autres messages du moteur</strong></p>
       <ul class="alertes">${restantes.map((a) => `<li>${att(a)}</li>`).join('')}</ul>`
    : '';

  const bandeau = $('#bandeau-controle');
  const bloquant = controles.some((c) => !c.ok && c.grave);
  bandeau.className = `bandeau ${bloquant ? 'bandeau--erreur' : echecs ? 'bandeau--alerte' : 'bandeau--ok'}`;
  bandeau.innerHTML =
    `<span class="bandeau__principal">${eq.equilibre ? 'Plan de financement équilibré' : `Écart de ${eur(eq.ecart_eur)}`}</span>` +
    `<span class="bandeau__detail">${passes} contrôle${passes > 1 ? 's' : ''} sur ${controles.length} ` +
    `${passes > 1 ? 'passés' : 'passé'}${echecs ? `, ${echecs} à examiner` : ''}.</span>`;
}

/**
 * Date ISO en date lisible. Le champ de livraison est un `input[type=date]`, que
 * le navigateur affiche au format local ; la mise en location, elle, est
 * CALCULEE et reste en texte pour ne pas se laisser modifier. Sans conversion,
 * les deux dates voisines s'affichaient dans deux formats differents.
 */
const dateLisible = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso ?? '');
};

/**
 * Montant de TFPB du referentiel, en filigrane du champ de simulation. Sans
 * lui, un champ vide laisserait croire a une taxe nulle alors que le compte en
 * porte bien une - c'est exactement la question qui s'est posee.
 */
function rendreFiligraneTFPB(r) {
  const champ = /** @type {HTMLInputElement|null} */ (document.getElementById('tfpb-simulation'));
  if (!champ) return;
  const ref = referentiels.baremes.constantes_reglementaires?.tfpb?.montant_par_logement_eur;
  champ.placeholder = nul(ref) ? '' : String(ref);
  champ.title = nul(ref)
    ? ''
    : `Référentiel : ${eur(ref)} par logement et par an. Laisser vide pour le reprendre.`;

  // Dire QUAND la taxe commence a courir. Une exoneration de vingt-cinq ans
  // rend la ligne nulle sur la moitie du compte, et on cherche alors le montant
  // sans le trouver - c'est ce qui s'est produit.
  // Meme convention pour l indexation du chantier : le referentiel en
  // filigrane, la saisie par-dessus.
  const idx = /** @type {HTMLInputElement|null} */ (document.getElementById('indexation-chantier'));
  if (idx) {
    const ti = referentiels.baremes.tresorerie?.taux_indexation;
    idx.placeholder = nul(ti) ? '' : String(enPourcent(ti));
    idx.title = nul(ti) ? '' : `Référentiel : ${pct(ti, 2)} par an. Laisser vide pour le reprendre.`;
  }

  const aide = document.getElementById('aide-tfpb');
  if (!aide) return;
  const premiere = r?.exploitation?.lignes?.find((l) => (l.tfpb_eur ?? 0) > 0);
  aide.textContent = premiere
    ? `⚙ Exonérée jusqu’en ${premiere.annee - 1} : la taxe entre au compte en ${premiere.annee}, ` +
      `pour ${eur(premiere.tfpb_eur)}, puis suit la trajectoire. La durée d’exonération tient au produit.`
    : "⚙ Exonérée sur toute la durée de simulation : aucune taxe n’entre au compte. La durée d’exonération tient au produit.";
}

function rendreCalendrier(r) {
  const c = r.calendrier;
  $('#date-mel').value = dateLisible(c?.date_mise_en_location);
  const champ = /** @type {HTMLInputElement} */ (document.querySelector('[data-champ="dates.date_livraison"]'));
  const deduite = c?.origine?.date_livraison === 'calcule';
  champ.classList.toggle('champ--calcule', deduite);
  if (deduite && champ !== document.activeElement) champ.value = c?.date_livraison ?? '';
}

/** Vide l'ecran de restitution : mieux vaut rien qu'un resultat perime presente comme valide. */
/**
 * Efface TOUT ce que le resultat du moteur a produit.
 *
 * La liste des zones a vider n'est plus tenue ici : chaque conteneur porte
 * l'attribut `data-restitution` dans le HTML, et cette fonction les balaie
 * tous. Une liste dans le code derivait a chaque ecran ajoute, et l'oubli ne
 * se voyait pas - c'est ainsi qu'une simulation vierge affichait encore la
 * tresorerie, les totaux de lots et le plan de financement du dossier
 * precedent. Un chiffre qui survit a ce qui l'a produit est pire qu'une case
 * vide : on le croit vrai.
 *
 * La regle pour la suite : toute zone remplie par le resultat porte
 * `data-restitution`. Rien d'autre a faire.
 */
function viderRestitution(message) {
  for (const zone of document.querySelectorAll('[data-restitution]')) {
    const el = /** @type {HTMLElement} */ (zone);
    if (el.tagName === 'TABLE') {
      // Une table de restitution se vide corps ET pied ; son en-tete est du
      // balisage, il reste.
      for (const partie of ['tbody', 'tfoot']) {
        const p = el.querySelector(partie);
        if (p) p.innerHTML = '';
      }
      continue;
    }
    el.innerHTML = '';
  }

  // Les tables de SAISIE ne peuvent pas etre marquees en bloc : leur corps est
  // de la saisie, qui reste, alors que leur pied est un total, qui doit partir.
  // Sans cela le prix de revient gardait le total de l operation precedente
  // sous une grille vide - un chiffre juste pour un dossier qui n existe plus.
  for (const sel of ['#table-lots tfoot', '#table-postes tfoot']) {
    const pied = document.querySelector(sel);
    if (pied) pied.innerHTML = '';
  }

  // Cellules posees une a une dans les tables de saisie : apercus de
  // ventilation, montants calcules, parts de subvention et de fonds propres.
  // `data-total` et `data-sous-total` sont les sous-totaux de chapitre du prix
  // de revient : poses cellule par cellule dans une table de saisie, ils ne
  // partent pas avec un conteneur.
  for (const el of document.querySelectorAll(
    '[data-apercu], [data-calc], [data-part-sub], [data-part-fp], [data-taux-marge], [data-total], [data-sous-total]',
  )) {
    el.textContent = '';
  }

  // Le bandeau de controle dit POURQUOI il n'y a pas de resultat : il est le
  // seul a ne pas rester vide.
  const bandeau = $('#bandeau-controle');
  if (bandeau) {
    bandeau.className = 'bandeau bandeau--erreur';
    bandeau.innerHTML = `<span class="bandeau__principal">Aucun résultat</span>
      <span class="bandeau__detail">${att(message)}</span>`;
  }
  const totalE = $('#total-emplois');
  if (totalE) totalE.textContent = '-';
  const totalR = $('#total-ressources');
  if (totalR) totalR.textContent = '-';
}


// ---------------------------------------------------------------- ecran exploitation

// La vue JALONS a ete retiree : elle condensait les periodes intermediaires en
// moyennes annuelles, ce qui donnait deux lectures du meme compte sans que rien
// ne dise laquelle faisait foi. La table se lit annee par annee, un point.

/**
 * Graphe du resultat annuel et du cumul, en SVG ecrit a la main.
 *
 * Deux axes : barres du resultat de l'annee sur l'axe principal, ligne du cumul
 * sur un axe secondaire mis a sa propre echelle. Les ruptures calculees par le
 * moteur sont tracees en reperes verticaux annotes : ce sont elles qui
 * expliquent la forme de la courbe, sans quoi le lecteur ne peut que constater.
 */
function grapheExploitation(lignes, evenements) {
  if (!lignes.length) return '<p class="aide">Aucune année à représenter.</p>';

  const L = 1000;
  const H = 260;
  // La marge haute loge les etiquettes de repere, sur trois rangs au plus quand
  // des annees voisines se bousculent : 4 px de garde, puis 11 px par rang.
  const marge = { haut: 38, bas: 34, gauche: 8, droite: 8 };
  const largeurTrace = L - marge.gauche - marge.droite;
  const hauteurTrace = H - marge.haut - marge.bas;

  const resultats = lignes.map((l) => l.autofinancement_eur);
  // DEUX cumuls, comme LEON les met cote a cote : l'autofinancement, qui est de
  // la tresorerie - il rembourse du capital - et le resultat comptable, qui
  // porte les dotations aux amortissements a la place. Ils divergent d'autant
  // plus que l'operation est jeune, et c'est precisement ce que le lecteur vient
  // chercher : une operation peut etre deficitaire au compte de resultat tout en
  // degageant du cash, et l'inverse.
  const cumuls = lignes.map((l) => l.cumul_autofinancement_eur);
  const cumulsCompta = lignes.map((l) => l.cumul_resultat_comptable_eur ?? 0);
  const maxRes = Math.max(...resultats, 0);
  const minRes = Math.min(...resultats, 0);
  const etendueRes = maxRes - minRes || 1;
  // UNE SEULE echelle pour les deux courbes. Leur donner chacune la sienne les
  // ferait paraitre voisines quand elles sont eloignees, et l'ecart entre les
  // deux est tout l'interet de les tracer ensemble.
  const maxCum = Math.max(...cumuls, ...cumulsCompta, 0);
  const minCum = Math.min(...cumuls, ...cumulsCompta, 0);
  const etendueCum = maxCum - minCum || 1;

  const pas = largeurTrace / lignes.length;
  const largeurBarre = Math.max(1, pas * 0.68);
  const yRes = (v) => marge.haut + hauteurTrace * (1 - (v - minRes) / etendueRes);
  const yCum = (v) => marge.haut + hauteurTrace * (1 - (v - minCum) / etendueCum);
  const xCentre = (i) => marge.gauche + pas * (i + 0.5);

  const barres = lignes
    .map((l, i) => {
      const y0 = yRes(0);
      const y1 = yRes(l.autofinancement_eur);
      const haut = Math.max(1, Math.abs(y1 - y0));
      const classe = l.autofinancement_eur < 0 ? 'negatif' : 'positif';
      return `<rect class="graphe__barre--${classe}" x="${(xCentre(i) - largeurBarre / 2).toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${largeurBarre.toFixed(1)}" height="${haut.toFixed(1)}"><title>${l.annee} : autofinancement ${eur(l.autofinancement_eur)}, cumulé ${eur(l.cumul_autofinancement_eur)} · résultat comptable cumulé ${eur(l.cumul_resultat_comptable_eur ?? 0)}</title></rect>`;
    })
    .join('');

  const traceDe = (valeurs) =>
    valeurs.map((v, i) => `${xCentre(i).toFixed(1)},${yCum(v).toFixed(1)}`).join(' ');
  const trace = traceDe(cumuls);
  const traceCompta = traceDe(cumulsCompta);

  // Reperes verticaux. Deux ecueils, tous deux visibles des qu'une operation
  // porte six prets :
  //  - PLUSIEURS evenements tombent la meme annee - cinq prets qui s'eteignent
  //    en 2068 tracaient cinq traits confondus et cinq fois le meme millesime ;
  //  - deux annees VOISINES se chevauchent - « 2067 » et « 2068 » se
  //    superposaient en un « 2062068 » illisible.
  // Un trait par ANNEE regle le premier, un etagement des etiquettes le second.
  const parAnnee = new Map();
  for (const e of evenements) {
    if (!parAnnee.has(e.annee)) parAnnee.set(e.annee, []);
    parAnnee.get(e.annee).push(e.libelle);
  }

  // Largeur d'un millesime a la fonte du graphe, en unites du viewBox. Deux
  // etiquettes plus proches que cela se toucheraient : la seconde descend d'un
  // cran. Trois rangs suffisent - au-dela, les traits eux-memes se confondent
  // et c'est la legende sous le graphe qui prend le relais.
  const largeurEtiquette = 30;
  const RANGS = 3;
  const dernierX = new Array(RANGS).fill(-Infinity);

  const reperes = [...parAnnee.entries()]
    .map(([annee, libelles]) => ({ annee, libelles, i: lignes.findIndex((l) => l.annee === annee) }))
    .filter((e) => e.i >= 0)
    .sort((a, b) => a.i - b.i)
    .map((e) => {
      const x = xCentre(e.i);
      let rang = dernierX.findIndex((d) => x - d >= largeurEtiquette);
      if (rang < 0) rang = RANGS - 1;
      dernierX[rang] = x;
      const xa = x.toFixed(1);
      // Le trait porte le detail en infobulle : l'annee seule ne dit pas ce qui
      // s'y passe, et cinq echeances groupees le disent encore moins.
      const detail = `${e.annee} : ${e.libelles.join(', ').toLowerCase()}`;
      return `<line class="graphe__repere" x1="${xa}" y1="${marge.haut}" x2="${xa}" y2="${marge.haut + hauteurTrace}"><title>${att(detail)}</title></line>
        <text class="graphe__texte graphe__texte--repere" x="${xa}" y="${(marge.haut - 4 - rang * 11).toFixed(1)}" text-anchor="middle">${att(e.annee)}${
          e.libelles.length > 1 ? `<tspan class="graphe__compteur"> ×${e.libelles.length}</tspan>` : ''
        }<title>${att(detail)}</title></text>`;
    })
    .join('');

  // Reperes d'annee en pied : premiere, milieu, derniere, et les ruptures.
  const anneesPied = new Set([lignes[0].annee, lignes[Math.floor(lignes.length / 2)].annee, lignes.at(-1).annee]);
  const axe = lignes
    .map((l, i) =>
      anneesPied.has(l.annee)
        ? `<text class="graphe__texte" x="${xCentre(i).toFixed(1)}" y="${H - 14}" text-anchor="middle">${l.annee}</text>`
        : '',
    )
    .join('');

  return `<svg viewBox="0 0 ${L} ${H}" role="img"
      aria-label="Autofinancement annuel en barres, cumuls d’autofinancement et de résultat comptable en lignes, de ${lignes[0].annee} à ${lignes.at(-1).annee}">
      <line class="graphe__zero" x1="${marge.gauche}" y1="${yRes(0).toFixed(1)}" x2="${L - marge.droite}" y2="${yRes(0).toFixed(1)}" />
      ${barres}
      <polyline class="graphe__cumul graphe__cumul--comptable" points="${traceCompta}" />
      <polyline class="graphe__cumul" points="${trace}" />
      ${reperes}${axe}
      <text class="graphe__texte" x="${marge.gauche}" y="${H - 2}">Autofinancement de l’année, échelle ${eur(minRes)} à ${eur(maxRes)}</text>
      <text class="graphe__texte" x="${L - marge.droite}" y="${H - 2}" text-anchor="end">Cumuls, échelle commune ${eur(minCum)} à ${eur(maxCum)}</text>
    </svg>`;
}

/**
 * Nature d'un evenement du compte, en deux mots. Le `code` vient du moteur ; le
 * libelle du badge, lui, appartient a l'ecran - c'est un raccourci de lecture,
 * pas une donnee. Un code inconnu retombe sur son propre nom plutot que de
 * disparaitre : mieux vaut un badge etrange qu'une rupture invisible.
 */
const NATURES_EVENEMENT = {
  pret: { court: 'PRÊT', pluriel: 'PRÊTS' },
  tfpb: { court: 'TFPB', pluriel: 'TFPB' },
};

/**
 * Badges de rupture d'une ligne du compte, un par NATURE. Chacun annonce ce
 * dont il s'agit et combien, et porte le detail en infobulle. Leur hauteur ne
 * depend pas du nombre d'evenements : c'est tout l'objet du regroupement.
 * @param {Array<{code?: string, libelle: string}>} evenements
 */
function badgesEvenements(evenements = []) {
  const parNature = new Map();
  for (const brut of evenements) {
    // La vue JALONS reçoit des libelles nus (`jalonsExploitation` les aplatit),
    // la vue annuelle des evenements entiers. On accepte les deux plutot que de
    // changer une sortie du moteur pour un besoin d'affichage.
    const e = typeof brut === 'string' ? { libelle: brut } : brut;
    const code = e.code ?? (/échéance/i.test(e.libelle) ? 'pret' : 'tfpb');
    if (!parNature.has(code)) parNature.set(code, []);
    parNature.get(code).push(e.libelle);
  }
  return [...parNature.entries()]
    .map(([code, libelles]) => {
      const n = NATURES_EVENEMENT[code] ?? { court: code, pluriel: code };
      // Le compte n'apparait qu'a partir de deux : « prêt 1 » se lirait comme
      // le nom d'un pret, alors qu'il n'y en a qu'un et qu'on le nomme au survol.
      const texte = libelles.length > 1 ? `${n.pluriel} ${libelles.length}` : n.court;
      return `<span class="evenement evenement--${att(code)}" title="${att(libelles.join(' · '))}">${att(texte)}</span>`;
    })
    .join('');
}

/**
 * R-TRESO - Courbe du chantier, vue financeur.
 *
 * Trois traces sur la meme echelle, parce que c'est leur ECART qui interesse :
 * le cumul des depenses, ce que les ressources hors prets couvrent, et le besoin
 * qui reste entre les deux. Trois graphes separes auraient demande de comparer
 * de tete des hauteurs sur des echelles differentes.
 */
function grapheTresorerie(t) {
  const l = t.lignes;
  if (l.length < 2) return '<p class="aide">Aucun chantier à représenter.</p>';

  const L = 1000;
  const H = 300;
  const marge = { haut: 16, bas: 34, gauche: 74, droite: 14 };
  const largeur = L - marge.gauche - marge.droite;
  const hauteur = H - marge.haut - marge.bas;

  // Deux series, deux STOCKS en euros : elles partagent donc leur axe. Melanger
  // un stock et un flux - un solde et une depense mensuelle - aurait demande
  // deux echelles, et deux echelles sur un meme cadre se lisent de travers.
  const series = [
    { cle: 'solde_eur', libelle: 'Trésorerie disponible', classe: 'treso__solde' },
    { cle: 'besoin_eur', libelle: 'Besoin cumulé de financement', classe: 'treso__besoin' },
  ];
  const valeurs = series.flatMap((s) => l.map((p) => p[s.cle]));
  const brutHaut = Math.max(0, ...valeurs);
  const brutBas = Math.min(0, ...valeurs);
  // Echelle arrondie a un pas rond : des graduations a 1 234 567 EUR ne se
  // comparent pas d'un coup d'oeil, contrairement a des centaines de milliers.
  const pas = 10 ** Math.floor(Math.log10(Math.max(brutHaut - brutBas, 1))) / 2;
  const haut = Math.ceil(brutHaut / pas) * pas;
  const bas = Math.floor(brutBas / pas) * pas;
  const etendue = haut - bas || 1;

  const x = (i) => marge.gauche + (largeur * i) / (l.length - 1);
  const y = (v) => marge.haut + hauteur * (1 - (v - bas) / etendue);
  const yZero = y(0);

  const points = (cle) => l.map((p, i) => `${x(i).toFixed(1)},${y(p[cle]).toFixed(1)}`).join(' ');

  // L'aire de la tresorerie se colore de part et d'autre de ZERO : au-dessus
  // l'operation a de quoi payer, en dessous elle est a decouvert. Deux zones de
  // decoupe sur une meme aire, plutot que deux chemins calcules aux
  // intersections - le trace reste exact et le code lisible.
  const aire =
    `M ${x(0).toFixed(1)},${yZero.toFixed(1)} L ${points('solde_eur').replaceAll(' ', ' L ')} ` +
    `L ${x(l.length - 1).toFixed(1)},${yZero.toFixed(1)} Z`;

  // Graduations : cinq au plus, sur des multiples du pas.
  const graduations = [];
  for (let v = bas; v <= haut + 1e-6; v += pas) graduations.push(v);
  const echelle = graduations.length > 6 ? graduations.filter((_, i) => i % 2 === 0) : graduations;

  // Une date sur cinq environ, pour que l'axe reste lisible sur trente mois.
  const pasX = Math.max(1, Math.ceil(l.length / 6));
  const dates = l.map((p, i) => ({ p, i })).filter(({ i }) => i % pasX === 0 || i === l.length - 1);

  const pic = l.find((p) => p.mois === t.indicateurs.mois_pic);
  const xPic = x(l.indexOf(pic));

  return `<svg viewBox="0 0 ${L} ${H}" role="img"
      aria-label="Trésorerie disponible et besoin cumulé de financement, de ${l[0].date} à ${l.at(-1).date}">
    <defs>
      <clipPath id="treso-haut"><rect x="0" y="${marge.haut}" width="${L}" height="${Math.max(0, yZero - marge.haut).toFixed(1)}" /></clipPath>
      <clipPath id="treso-bas"><rect x="0" y="${yZero.toFixed(1)}" width="${L}" height="${Math.max(0, marge.haut + hauteur - yZero).toFixed(1)}" /></clipPath>
    </defs>
    ${echelle
      .map(
        (v) => `<line class="graphe__grille" x1="${marge.gauche}" y1="${y(v).toFixed(1)}" x2="${L - marge.droite}" y2="${y(v).toFixed(1)}" />
        <text class="graphe__texte" x="${marge.gauche - 8}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${eur(v)}</text>`,
      )
      .join('')}
    <path class="treso__aire treso__aire--positive" d="${aire}" clip-path="url(#treso-haut)" />
    <path class="treso__aire treso__aire--negative" d="${aire}" clip-path="url(#treso-bas)" />
    <line class="graphe__zero" x1="${marge.gauche}" y1="${yZero.toFixed(1)}" x2="${L - marge.droite}" y2="${yZero.toFixed(1)}" />
    <polyline class="treso__besoin" points="${points('besoin_eur')}" />
    <polyline class="treso__solde" points="${points('solde_eur')}" />
    <line class="graphe__repere" x1="${xPic.toFixed(1)}" y1="${marge.haut}" x2="${xPic.toFixed(1)}" y2="${(marge.haut + hauteur).toFixed(1)}" />
    <text class="graphe__texte graphe__texte--repere" x="${xPic.toFixed(1)}" y="${marge.haut - 4}" text-anchor="middle">besoin maximal</text>
    ${l
      .map((p, i) => `<circle class="treso__point" cx="${x(i).toFixed(1)}" cy="${y(p.solde_eur).toFixed(1)}" r="9">
        <title>${p.date} : trésorerie ${eur(p.solde_eur)}, besoin cumulé ${eur(p.besoin_eur)}, dépense ${eur(p.depenses_eur)}</title></circle>`)
      .join('')}
    ${dates
      .map(({ p, i }) => {
        // Les dates des EXTREMITES s'ancrent par leur bord : centrees, la
        // moitie de la premiere et de la derniere sortait du cadre.
        const ancre = i === 0 ? 'start' : i === l.length - 1 ? 'end' : 'middle';
        return `<text class="graphe__texte" x="${x(i).toFixed(1)}" y="${H - 12}" text-anchor="${ancre}">${p.date.slice(0, 7)}</text>`;
      })
      .join('')}
  </svg>`;
}

function rendreTresorerie(r) {
  const t = r.tresorerie;
  const bloc = document.getElementById('recap-tresorerie');
  if (!bloc) return;
  if (!t) {
    bloc.innerHTML = '';
    $('#aide-tresorerie').textContent =
      '⚙ Renseigner une date de début des travaux et une durée de chantier pour suivre la trésorerie de la phase travaux.';
    $('#graphe-tresorerie').innerHTML = '';
    $('#table-tresorerie').querySelector('tbody').innerHTML = '';
    return;
  }

  const i = t.indicateurs;
  const tuile = (l, v, d) =>
    `<div class="indicateur"><div class="indicateur__libelle">${l}</div>` +
    `<div class="indicateur__valeur">${v}</div><div class="indicateur__detail">${d}</div></div>`;
  bloc.innerHTML = [
    tuile('Durée', `${t.lignes.length} mois`, `de ${t.lignes[0].date.slice(0, 7)} à ${t.lignes.at(-1).date.slice(0, 7)}`),
    tuile('Échéance mensuelle', eur(i.echeance_nominale_eur), 'nominale, avant indexation'),
    tuile(
      'Dépensé',
      eur(i.total_depenses_eur),
      i.surcout_indexation_eur
        ? `dont ${eur(i.surcout_indexation_eur)} d’indexation à ${pct(i.taux_indexation, 2)}`
        : 'sans indexation',
    ),
    tuile('Mobilisé à l’OS', eur(i.total_subventions_eur + i.total_fonds_propres_eur),
      `${eur(i.total_subventions_eur)} de subventions · ${eur(i.total_fonds_propres_eur)} de fonds propres`),
    tuile('Besoin maximal', eur(i.besoin_maximal_eur), `atteint au mois ${i.mois_pic}`),
    tuile('Tiré sur les prêts', eur(i.total_tirages_eur), 'au fil de l’eau, jamais d’avance'),
  ].join('');

  $('#aide-tresorerie').textContent =
    '⚙ Le coût est réparti à parts égales sur les mois de chantier, et chaque mensualité est ' +
    'indexée de sa propre durée : seules les sommes dues sont indexées. Les subventions sont ' +
    'mobilisables dès l’ordre de service, et les prêts se tirent à hauteur du manque du mois, ' +
    'jamais d’avance : tirer plus tôt ferait courir des intérêts intercalaires sur de l’argent ' +
    'qui dort. Le besoin maximal est ce que le préfinancement doit couvrir.';

  $('#graphe-tresorerie').innerHTML = grapheTresorerie(t);
  $('#legende-tresorerie').innerHTML =
    '<span class="treso__cle treso__cle--solde"></span> trésorerie disponible ' +
    '<span class="treso__cle treso__cle--besoin"></span> besoin cumulé de financement ' +
    '<span class="treso__note">Survoler un point donne le détail du mois.</span>';

  $('#table-tresorerie').querySelector('tbody').innerHTML = t.lignes
    .map(
      (l) => `<tr class="${l.mois === i.mois_pic ? 'ligne--rupture' : ''}">
      <td>M+${l.mois}<span class="treso__date">${l.date.slice(0, 7)}</span></td>
      <td class="num">${eur(l.nominal_eur)}</td>
      <!-- Quatre decimales : a deux, le coefficient du premier mois s'affichait
           « 1,00 » et celui du deuxieme aussi, alors que c'est justement leur
           progression qui explique le surcout. -->
      <td class="num">${l.coefficient === 1 ? '-' : l.coefficient.toFixed(4).replace('.', ',')}</td>
      <td class="num">${eur(l.depenses_eur)}</td>
      <td class="num">${eur(l.cumul_depenses_eur)}</td>
      <td class="num">${l.subventions_eur ? eur(l.subventions_eur) : '-'}</td>
      <td class="num">${l.fonds_propres_eur ? eur(l.fonds_propres_eur) : '-'}</td>
      <td class="num">${l.tirage_eur ? eur(l.tirage_eur) : '-'}</td>
      <td class="num">${eur(l.cumul_tirages_eur)}</td>
      <td class="num">${eur(l.besoin_eur)}</td>
    </tr>`,
    )
    .join('');
  $('#table-tresorerie').querySelector('tfoot').innerHTML = `<tr>
    <td class="libelle">Total</td>
    <td></td><td></td>
    <td class="num">${eur(i.total_depenses_eur)}</td><td></td>
    <td class="num">${eur(i.total_subventions_eur)}</td>
    <td class="num">${eur(i.total_fonds_propres_eur)}</td>
    <td class="num">${eur(i.total_tirages_eur)}</td><td></td><td></td>
  </tr>`;
}

/**
 * Tranches ECARTEES du compte d'exploitation.
 *
 * Meme choix qu'a l'export : on memorise les ecartees et non les retenues.
 * Un programme gagne et perd des tranches au fil de la saisie, et une liste
 * de retenues aurait fige la vue sur celles qui existaient au moment ou on
 * l a ouverte. Une tranche nouvelle entre donc au compte, il faut un geste
 * pour la retirer.
 */
const tranchesHorsCompte = new Set();

/** Tranches presentes au compte, dans l ordre canonique. */
function tranchesAuCompte(r) {
  const toutes = Object.keys(r?.exploitation?.par_tranche ?? {});
  const gardees = toutes.filter((c) => !tranchesHorsCompte.has(c));
  // Tout ecarter ne montrerait plus rien : le dernier retrait n est pas honore.
  return gardees.length ? gardees : toutes;
}

/**
 * Compte a montrer, pour le perimetre choisi.
 *
 * Toutes les tranches retenues, c est le CONSOLIDE tel que le moteur le
 * calcule - et non leur somme : les deux different sur l impot, et tant que
 * la bascule n'est pas decidee, la vue d'ensemble doit rester celle qui fait
 * foi. Une partie des tranches, c est leur somme, indicateurs recalcules sur
 * le prix de revient de ces tranches-la.
 *
 * Les champs propres a l'operation - postes absents, charges actives, fonds
 * propres par tranche - sont conserves par-dessus : ils decrivent le montage
 * et ne changent pas avec le perimetre.
 */
function perimetreExploitation(r) {
  const toutes = Object.keys(r.exploitation?.par_tranche ?? {});
  const retenues = tranchesAuCompte(r);
  if (!toutes.length || retenues.length === toutes.length) return r.exploitation;
  const compte = sommerComptes(retenues.map((c) => r.exploitation.par_tranche[c]));
  if (!compte) return r.exploitation;
  const prixRevient = retenues.reduce(
    (s, c) => s + (r.bilan?.par_tranche?.[c]?.total_ttc_module_eur ?? 0),
    0,
  );
  compte.indicateurs = indicateursExploitation(compte.lignes, {
    prix_revient_ttc_eur: prixRevient,
  });
  compte.jalons = r.exploitation.jalons;
  return { ...r.exploitation, ...compte };
}

/**
 * Pastilles de perimetre du compte, sur le modele de celles de l'export : on
 * en coche autant qu on veut, et « Tout » les rallume toutes.
 *
 * Elles ne paraissent qu'a partir de DEUX tranches : le total EST la tranche
 * quand il n y en a qu une.
 */
function rendrePerimetreExploitation(r) {
  const barre = document.getElementById('perimetre-exploitation');
  if (!barre) return;
  const tranches = Object.keys(r.exploitation?.par_tranche ?? {});
  const cache = tranches.length < 2;
  barre.closest('.barre-perimetre')?.toggleAttribute('hidden', cache);
  if (cache) {
    barre.innerHTML = '';
    return;
  }
  const retenues = new Set(tranchesAuCompte(r));
  const tout = retenues.size === tranches.length;
  barre.innerHTML =
    `<button type="button" class="pastille-tranche${
      tout ? ' pastille-tranche--active' : ''
    }" data-perimetre-compte="tout" aria-pressed="${tout}"
      title="Présenter toutes les tranches">Tout</button>` +
    tranches
      .map(
        (c) => `<button type="button" class="pastille-tranche${
          retenues.has(c) ? ' pastille-tranche--active' : ''
        }" data-perimetre-compte="${att(c)}" aria-pressed="${retenues.has(c)}"
          style="--cat:${catProduit(c)};--cat-fond:${catFondProduit(c)}"
          title="Ajouter ou retirer cette tranche du compte">${att(libelleProduit(c))}</button>`,
      )
      .join('');
}

function rendreExploitation(r) {
  rendrePerimetreExploitation(r);
  const e = perimetreExploitation(r);
  const ind = e.indicateurs;

  // Le bandeau de tete de l'ecran a ete retire. Il melait trois choses de
  // natures differentes - un verdict sur l'operation, les bornes de la
  // simulation, l'etat d'avancement du moteur - et la derniere n'a rien a
  // faire sous les yeux de qui monte une operation. Le nombre d exercices
  // deficitaires reste lisible : la table le montre ligne par ligne, et les
  // tuiles portent les indicateurs.
  const deficit = ind.exercices_deficitaires > 0;

  // Colonne « Année 1 » de la table des charges diverses : remplie depuis le
  // resultat du moteur, jamais recalculee ici (les taux portent sur des loyers
  // que seul le moteur connait).
  const detailAn1 = e.lignes[0]?.detail_charges_diverses ?? [];
  for (const cel of document.querySelectorAll('[data-charge-montant]')) {
    const d = detailAn1.find((x) => x.code === cel.getAttribute('data-charge-montant'));
    cel.textContent = d ? eur(d.montant_eur) : '-';
  }

  // --- Tuiles ---
  $('#tuiles-exploitation').innerHTML = [
    {
      l: 'Autofinancement cumulé',
      v: eur(ind.resultat_cumule_final_eur),
      d: `sur ${e.lignes.length} ans, annuités payées`,
    },
    {
      // Le TRI mesure ce que rapporte l'argent immobilise : mise de depart
      // egale au prix de revient, puis les autofinancements annuels.
      l: 'TRI de l’opération',
      v: nul(ind.tri) ? 'non défini' : pct(ind.tri, 2),
      d: nul(ind.tri)
        ? 'les flux ne remboursent jamais la mise'
        : 'prix de revient, puis autofinancements',
    },
    {
      l: 'Creux du cumul',
      v: eur(ind.creux_cumul_eur),
      d: `atteint en ${ind.annee_creux_cumul}`,
    },
    {
      l: 'Exercices déficitaires',
      v: ind.exercices_deficitaires,
      d: deficit ? `de ${ind.premiere_annee_deficitaire} à ${ind.derniere_annee_deficitaire}` : 'aucun sur l’horizon',
    },
    {
      l: 'Taux de marge année 1',
      v: pct(ind.taux_marge_annee_1, 1),
      d: `moyenne ${pct(ind.taux_marge_moyen, 1)} sur ${ind.annees_moyenne_marge} ans`,
    },
    {
      l: 'Reconstitution des fonds propres',
      v: ind.annee_reconstitution_fonds_propres ?? 'non atteinte',
      d: `cumul ≥ ${eur(e.fonds_propres_eur)}`,
    },
    {
      l: 'Début de la taxe foncière',
      v: r.indicateurs.annee_debut_tfpb,
      d: 'fin d’exonération',
    },
  ]
    .map((t) => `<div class="indicateur"><div class="indicateur__libelle">${t.l}</div>
      <div class="indicateur__valeur">${t.v}</div><div class="indicateur__detail">${t.d}</div></div>`)
    .join('');

  // --- Graphe ---
  $('#graphe-exploitation').innerHTML = grapheExploitation(e.lignes, e.evenements);
  // La legende suit le graphe : un poste par ANNEE, ses evenements a la suite.
  // Repeter le millesime autant de fois qu'il y a d'echeances donnait une phrase
  // ou « 2068 » revenait cinq fois sans qu'on voie qu'il s'agissait de la meme
  // annee.
  const parAnneeGraphe = new Map();
  for (const x of e.evenements) {
    if (!parAnneeGraphe.has(x.annee)) parAnneeGraphe.set(x.annee, []);
    parAnneeGraphe.get(x.annee).push(x.libelle.toLowerCase());
  }
  $('#aide-graphe').textContent = parAnneeGraphe.size
    ? `⚙ Repères verticaux : ${[...parAnneeGraphe.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([annee, l]) => `${annee} : ${l.join(', ')}`)
        .join(' · ')}.`
    : '';

  // --- Tableau ---
  const rangs = e.lignes.map((l) => ({
          type: 'annee',
          libelle: String(l.annee),
          ...l,
          // L'evenement entier et non son seul libelle : son `code` sert a le
          // ranger par nature, ce qu'une chaine de texte ne permet qu'a coups
          // d'expressions regulieres sur des libelles faits pour etre lus.
          evenements: e.evenements.filter((x) => x.annee === l.annee),
        }));

  const montant = (v) => `<td class="num ${v < 0 ? 'montant--negatif' : ''}">${eur(v)}</td>`;
  $('#table-exploitation').querySelector('tbody').innerHTML = rangs
    .map((j) => {
      const autresCharges = j.total_charges_eur - j.annuites_eur;
      // Un badge PAR NATURE d'evenement, et non un par evenement : cinq
      // echeances la meme annee faisaient cinq etiquettes empilees, et la ligne
      // enflait a proportion. Un badge dit ce dont il s'agit et combien il y en
      // a - « prêts 5 », « TFPB » - le detail se lit au survol. Sa hauteur est
      // fixe : la colonne des annees reste une colonne.
      const marques = badgesEvenements(j.evenements);
      const classe = j.type === 'moyenne' ? 'ligne--moyenne' : marques ? 'ligne--rupture' : '';
      // Vue TRESORERIE a gauche, vue COMPTABLE dans son bloc a droite.
      const comptable = (v) =>
        nul(v)
          ? '<td class="num col-comptable">-</td>'
          : `<td class="num col-comptable ${v < 0 ? 'montant--negatif' : ''}">${eur(v)}</td>`;
      return `<tr class="${classe}">
        <td>${att(j.libelle)}${marques}</td>
        ${montant(j.total_produits_eur)}${montant(j.annuites_eur)}${montant(autresCharges)}
        ${montant(j.autofinancement_eur)}${montant(j.cumul_autofinancement_eur)}
        <td class="num">${pct(j.taux_marge, 1)}</td>
        <td class="num col-comptable col-comptable--debut">${nul(j.interets_eur) ? '-' : eur(j.interets_eur)}</td>
        <td class="num col-comptable">${nul(j.dotation_amortissements_eur) ? '-' : eur(j.dotation_amortissements_eur)}</td>
        ${comptable(j.resultat_comptable_eur)}
      </tr>`;
    })
    .join('');

  const t = e.totaux;
  $('#table-exploitation').querySelector('tfoot').innerHTML = `<tr>
      <td class="libelle">Cumul sur ${e.lignes.length} ans</td>
      ${montant(t.produits_eur)}${montant(t.annuites_eur)}
      ${montant(t.charges_eur - t.annuites_eur)}${montant(t.autofinancement_eur)}
      <td></td><td></td>
      <td class="num col-comptable col-comptable--debut">${eur(t.interets_eur)}</td>
      <td class="num col-comptable">${nul(t.dotation_amortissements_eur) ? '-' : eur(t.dotation_amortissements_eur)}</td>
      ${
        nul(t.resultat_comptable_eur)
          ? '<td class="num col-comptable">-</td>'
          : `<td class="num col-comptable ${t.resultat_comptable_eur < 0 ? 'montant--negatif' : ''}">${eur(t.resultat_comptable_eur)}</td>`
      }
    </tr>`;

  $('#aide-exploitation').textContent =
    `⚙ ${e.lignes.length} exercices, de ${e.lignes[0]?.annee} à ${e.lignes.at(-1)?.annee}. ` +
    `La dernière année porte une marge exceptionnelle : les prêts y sont soldés.`;

}

// ---------------------------------------------------------------- ecran parametres

/**
 * PROFILS DE PARAMETRES (R-PARAM).
 *
 * Un profil est un jeu nomme de surcharges du referentiel : la grille CDC du
 * mois, un scenario macro prudent, les plafonds d'un millesime a venir. En
 * choisir un rechiffre toute la simulation.
 *
 * Le profil « Referentiel du depot » est la reference : surcharge vide,
 * non modifiable. Editer un parametre alors qu'il est actif ne l'abime pas, cela
 * DERIVE un nouveau profil - on ne peut pas perdre le point de comparaison par
 * inadvertance.
 *
 * La persistance viendra plus tard (CLAUDE.md §2 : pas de base pour l'instant) :
 * les profils vivent donc dans l'etat de la simulation et partent avec son
 * export JSON. La structure, elle, est deja celle qu'une table `profils`
 * attendra - un identifiant, un nom, un arbre de surcharges.
 */
const PROFIL_REFERENTIEL = 'referentiel';

/** Profil actif, ou le profil de reference a defaut. */
function profilActif() {
  return etat.profils.find((p) => p.id === etat.profil_actif) ?? etat.profils[0];
}

/**
 * Remplit les selecteurs de profil DISSEMINES dans l'application - celui de
 * l'ecran Operation aujourd'hui, d'autres demain. Le choix du profil
 * appartient a tout utilisateur, son parametrage reste a l'onglet admin ; le
 * meme geste ecrit au meme endroit (`etat.profil_actif`).
 *
 * Appele a chaque recalcul : c'est l'unique point de passage de tous les
 * changements d'etat, renommages et duplications de profils compris. La
 * signature evite de reconstruire des options identiques, et un selecteur
 * tenu par le focus n'est jamais reecrit sous les doigts de l'utilisateur.
 */
function remplirSelectsProfil() {
  const actif = profilActif()?.id ?? '';
  const signature = JSON.stringify([actif, etat.profils.map((p) => [p.id, p.nom])]);
  for (const sel of document.querySelectorAll('select[data-selecteur-profil]')) {
    const s = /** @type {HTMLSelectElement} */ (sel);
    if (s.dataset.signature === signature || document.activeElement === s) continue;
    s.innerHTML = etat.profils
      .map((p) => `<option value="${att(p.id)}" ${p.id === actif ? 'selected' : ''}>${att(p.nom)}</option>`)
      .join('');
    s.dataset.signature = signature;
  }
}

/** Surcharges du profil actif : c'est ce que le moteur recoit. */
function parametrageActif() {
  return profilActif()?.parametrage ?? {};
}

/** Identifiant sans collision, sans horloge : le moteur comme l'UI restent deterministes. */
function idProfil() {
  let n = etat.profils.length + 1;
  while (etat.profils.some((p) => p.id === `profil-${n}`)) n++;
  return `profil-${n}`;
}

/**
 * Ecrit une surcharge dans le profil actif. Si c'est le referentiel qui est
 * actif, on en derive d'abord une copie : la reference doit rester intacte.
 * @returns {Object} le profil reellement modifie
 */
/**
 * Le profil ACTIF, modifie tel quel.
 *
 * Il derivait auparavant une copie « Profil personnalisé » des qu'on touchait
 * au referentiel, pour ne pas perdre le point de comparaison. Mauvaise
 * economie : on choisissait un profil, on le reglait, et l'ecran en affichait
 * un autre - le reglage n'allait pas ou l'on croyait. Le point de comparaison
 * n'est de toute facon jamais perdu, il est dans le FICHIER de referentiel, et
 * « ↺ tout » y ramene. Ce qui protege une modification, desormais, c'est de la
 * SAUVEGARDER explicitement, pas d'en detourner la destination.
 */
function profilModifiable() {
  return profilActif();
}

/** Un profil porte-t-il des modifications non sauvegardees ? */
function profilNonSauve(p) {
  return JSON.stringify(p.parametrage ?? {}) !== JSON.stringify(p.parametrage_sauve ?? {});
}

/** Lit une surcharge dans le profil actif, par chemin pointe. */
function surchargeDe(chemin) {
  let n = parametrageActif();
  for (const cle of chemin.split('.')) {
    if (n === null || n === undefined) return undefined;
    n = n[cle];
  }
  return n;
}

/** Section ouverte dans le rail, et filtre de recherche courant. */
let sectionParametres = 'prets';
let rechercheParametre = '';

/**
 * Lecture de la page « Explication des calculs » : `simple` pour tout le
 * monde, `support` pour la maintenance. Un SEUL texte source decrit chaque
 * calcul sous ses deux faces ; l'interrupteur choisit laquelle on lit, il ne
 * change ni l'ordre ni le decoupage. Memorise : on ne rechoisit pas sa lecture
 * a chaque ouverture.
 */
const CLE_LECTURE_CALCULS = 'moteur-sim.calculs.lecture';
let lectureCalculs = (() => {
  try {
    return localStorage.getItem(CLE_LECTURE_CALCULS) === 'support' ? 'support' : 'simple';
  } catch {
    return 'simple';
  }
})();

/**
 * DOCUMENTATION VIVANTE DU MOTEUR.
 *
 * Chaque etape porte deux redactions du MEME calcul : `simple` pour le metier,
 * `support` pour la maintenance. Les deux vivent cote a cote pour qu'elles ne
 * puissent pas diverger : corriger une formule sans corriger son explication
 * demanderait de mentir deux fois dans le meme objet.
 *
 * `formule` est ecrite avec les mots de l'ecran, jamais avec des noms de
 * variables : c'est ce qui la rend lisible a qui ne lit pas de code. La
 * variante technique, quand elle existe, vit dans `support.formule`.
 *
 * REGLE D'ENTRETIEN : toute modification d'un module de `src/` qui change une
 * formule doit se retrouver ici. Les lignes citees en `support.source` sont
 * indicatives et vieillissent ; le nom de la fonction, lui, fait foi.
 */
const MODELE_CALCULS = [
  {
    id: "chaine",
    titre: "La chaîne de calcul",
    accroche: "Une simulation se calcule toujours dans le même ordre, et cet ordre n’est pas négociable : chaque étape a besoin du résultat de la précédente. C’est pourquoi une surface mal saisie ne fausse pas seulement les surfaces, mais tout ce qui suit.",
    etapes: [
      {
        titre: "Le paramétrage se fige",
        regles: ["R-PARAM"],
        simple: "Rien n’est calculé tant que le jeu de valeurs de référence n’est pas arrêté. Le moteur part des barèmes livrés avec l’outil (loyers plafonds par zone, taux de TVA, marges de prêts, charges d’exploitation), puis il pose par-dessus les valeurs du profil que vous avez choisi dans l’écran Opération. Une case laissée vide dans le profil ne remplace rien : c’est la valeur du barème qui sert. Une case remplie remplace celle du barème, et elle seule. Le résultat de cette superposition s’appelle le barème effectif, et c’est le seul que le calcul verra ensuite : aucun module ne peut aller chercher une autre version du même chiffre ailleurs. C’est ce qui garantit que deux écrans qui affichent « taux de TVA » affichent bien le même.",
        formule: "valeur retenue = SI(profil renseigné ; valeur du profil ; valeur du barème)\n\nExemple, taux de TVA du PLAI :\n  barème du dépôt ............ 5,50 %\n  profil AXENTIA HER 2027 .... (vide)\n  valeur retenue ............. 5,50 %\n\nExemple, Livret A de référence :\n  barème du dépôt ............ 2,40 %\n  profil AXENTIA HER 2027 .... 1,50 %\n  valeur retenue ............. 1,50 %",
        support: {
          fonction: "fusionner",
          signature: "fusionner(base, surcharge) → nouvel objet (n’altère jamais ses arguments)",
          code: "baremes = fusionner(referentiels.baremes, entrees.parametrage?.baremes)",
          referentiel: "referentiels/baremes_her_2027.json = base · entrees.parametrage = surcharge",
          alimente: "tous les modules : chacun ne voit que ce barème effectif",
          tests: "tests/parametrage.test.js",
          source: "src/parametrage.js:66",
          texte: "Fusion profonde du référentiel et de `entrees.parametrage`. Les objets fusionnent clé à clé ; les tableaux positionnels par index, ce qui permet de ne redonner qu’une zone d’un barème ; les tableaux dont tous les éléments portent un `id` sont traités comme des listes, la surcharge y faisant autorité sur la composition : c’est ce qui permet de supprimer un modèle de prêt. Ne mute jamais ses arguments.",
          formule: "baremes = fusionner(referentiels.baremes, entrees.parametrage?.baremes)"
        },
        piege: "Une valeur vide ne surcharge rien, elle rend la valeur du barème. Effacer une cellule n’impose donc pas zéro : c’est le seul moyen de revenir au référentiel.",
        entrees: [
          [
            "Barème du dépôt",
            "referentiels/baremes_her_2027.json, versionné dans le dépôt, jamais modifié depuis l’écran"
          ],
          [
            "Profil de paramètres",
            "écran Opération > Profil de paramètres, réglé dans Paramètres > Admin"
          ],
          [
            "Valeur vide",
            "une case effacée revient au barème : c’est le seul moyen d’annuler une surcharge"
          ]
        ]
      },
      {
        titre: "Le calendrier se déduit",
        regles: ["R-AMT-3"],
        simple: "Trois dates commandent toute la simulation, et deux d’entre elles se déduisent de la troisième. Vous saisissez le début des travaux et la durée du chantier en mois. La livraison est le début des travaux décalé d’autant de mois. La mise en location tombe le lendemain de la livraison. L’année de mise en location est simplement l’année de cette date, et c’est elle qui commande trois choses à la fois : la première année du compte d’exploitation, la première échéance des prêts, et le point de départ des 25 ans d’exonération de taxe foncière. Vous pouvez saisir directement la livraison ou la mise en location pour figer un calendrier contractuel, une VEFA par exemple : l’écran grise alors les dates qu’il a calculées et laisse en clair celles que vous avez imposées.",
        formule: "livraison = début des travaux + durée du chantier (en mois)\nmise en location = livraison + 1 jour\nannée de mise en location = ANNEE(mise en location)\n\nExemple :\n  début des travaux .......... 01/01/2026\n  durée du chantier .......... 24 mois\n  livraison .................. 01/01/2028\n  mise en location ........... 02/01/2028\n  année de mise en location .. 2028",
        support: {
          fonction: "calendrierOperation",
          signature: "calendrierOperation(entrees) → { date_livraison, date_mise_en_location, annee_mise_en_location, duree_chantier_mois, origine }",
          code: "date_livraison = decalerMois(date_debut_travaux, duree_chantier_mois) ; date_mise_en_location = livraison + 1 jour",
          referentiel: "aucun : tout vient de entrees.dates",
          alimente: "annee_mise_en_location → anneePremiereEcheance, compteExploitation, exonerationTFPB",
          tests: "tests/moteur.test.js",
          source: "src/calendrier.js:83",
          texte: "Retourne aussi `origine`, un dictionnaire date → \"saisie\" | \"calcule\", que l’interface lit pour griser les dates dérivées sans réimplémenter la règle. Lève si ni l’année de mise en location, ni une date de mise en location, ni le couple début de travaux + durée de chantier ne sont renseignés."
        },
        piege: "L’année de mise en location commande l’entrée en exploitation, la première échéance des prêts et le décompte de l’exonération de taxe foncière. La décaler d’un an décale trois choses à la fois.",
        entrees: [
          ["Début des travaux", "écran Opération > Calendrier, saisi"],
          ["Durée du chantier (mois)", "écran Opération > Calendrier, saisi"],
          ["Livraison", "calculé, ou saisi pour figer une VEFA"],
          ["Mise en location", "calculé, ou saisi"],
          [
            "Durée de simulation (ans)",
            "écran Opération > Calendrier, saisi : le nombre d’années du compte d’exploitation"
          ]
        ]
      }
    ]
  },
  {
    id: "surfaces",
    titre: "Surfaces et loyers",
    accroche: "Tout part de la surface utile. Elle sert deux fois : à calculer le loyer plafond, et à partager entre les tranches tout ce qui est commun à l’opération. Une surface fausse fausse donc à la fois les recettes et la répartition des dépenses.",
    etapes: [
      {
        titre: "La surface utile",
        regles: ["R-SURF-1"],
        simple: "La surface utile est la surface sur laquelle le loyer plafond se calcule. Ce n’est pas la surface habitable : la réglementation y ajoute la moitié des surfaces annexes (balcons, celliers, caves, garages dans la limite réglementaire), parce qu’une annexe a de la valeur d’usage mais moins qu’une pièce à vivre. Le coefficient de 0,5 n’est pas un choix de l’outil, c’est la règle. Le résultat est arrondi à deux décimales. Si vous connaissez la surface utile exacte de la convention et voulez l’imposer, vous pouvez la forcer : elle court-circuite alors tout le calcul.",
        formule: "surface utile = surface habitable + 0,5 × surfaces annexes\n\nExemple, un T3 :\n  surface habitable .......... 65,00 m²\n  balcon ..................... 8,00 m²\n  cave ....................... 4,00 m²\n  surfaces annexes ........... 12,00 m²\n  surface utile .............. 65,00 + 0,5 × 12,00 = 71,00 m²",
        support: {
          fonction: "surfaceUtile",
          signature: "surfaceUtile({ shab_m2, surfaces_annexes_m2 = 0, su_forcee_m2, arrondir = true }, referentiels) → m² arrondis à 2 décimales",
          code: "su = shab_m2 + k * surfaces_annexes_m2   (su_forcee_m2 court-circuite tout)",
          referentiel: "constantes_reglementaires.coefficient_surface_annexes.valeur → k, soit 0,5",
          alimente: "coefficientStructure, quotesPartsSU, loyerProduit",
          tests: "tests/loyers.test.js",
          source: "src/loyers.js:35",
          texte: "Le coefficient 0,5 vient du référentiel (`constantes_reglementaires.coefficient_surface_annexes.valeur`), il n’est pas codé en dur. `su_forcee_m2` court-circuite le calcul dès qu’elle n’est ni `undefined` ni `null`, donc une surface forcée à 0 est retenue et donne une surface utile nulle. L’option `arrondir: false` sert à sommer les lots sans dérive."
        },
        piege: "L’arrondi à deux décimales se fait à la TRANCHE, jamais au lot : six lots de 70,005 m² arrondis un à un donneraient 420,06 m² au lieu de 420 m².",
        entrees: [
          ["Surface habitable (SHAB)", "écran Programme, saisie lot par lot"],
          ["Surfaces annexes", "écran Programme, saisies lot par lot"],
          [
            "Coefficient 0,5",
            "Paramètres > Constantes réglementaires > coefficient_surface_annexes (règle réglementaire, à ne pas modifier sans raison)"
          ]
        ]
      },
      {
        titre: "Le coefficient de structure",
        regles: ["R-SURF-2"],
        simple: "Le coefficient de structure corrige le loyer plafond selon la taille moyenne des logements. Deux opérations de même surface totale n’ont pas le même coût de construction selon qu’elles font dix grands logements ou vingt petits : plus il y a de logements pour une même surface, plus il y a de cuisines, de salles d’eau, de portes palières. Le coefficient monte donc quand les logements sont petits, et il descend quand ils sont grands. Il se calcule sur la tranche entière, jamais lot par lot. Un foyer utilise un facteur de 38 au lieu de 20, parce que ses chambres sont bien plus petites qu’un logement familial. Le résultat est arrondi à quatre décimales.",
        formule: "coefficient de structure = 0,77 × (1 + 20 × nombre de logements ÷ surface utile)\nen foyer, le 20 devient 38\n\nExemple A, 20 logements pour 1 200 m² (60 m² moyens) :\n  0,77 × (1 + 20 × 20 ÷ 1 200) = 0,77 × 1,3333 = 1,0267\n\nExemple B, 10 logements pour 1 200 m² (120 m² moyens) :\n  0,77 × (1 + 20 × 10 ÷ 1 200) = 0,77 × 1,1667 = 0,8983\n\nÀ surface identique, les petits logements portent un loyer au m² supérieur de 14 %.",
        support: {
          fonction: "coefficientStructure",
          signature: "coefficientStructure({ nb_logements, su_m2, foyer = false, arrondir = true }, referentiels) → coefficient arrondi à 4 décimales",
          code: "cs = cfg.metropole_habitat.base * (1 + (facteur * nb_logements) / su_m2)   avec facteur = foyer ? cfg.foyers.facteur_nl : cfg.metropole_habitat.facteur_nl",
          referentiel: "constantes_reglementaires.coefficient_structure.metropole_habitat.base (0,77) et .facteur_nl (20) · .foyers.facteur_nl (38)",
          alimente: "loyerProduit → loyer plafond → recettes du compte d’exploitation",
          tests: "tests/loyers.test.js",
          source: "src/loyers.js:64",
          texte: "Base et facteurs viennent de `constantes_reglementaires.coefficient_structure`. En foyer, seul le FACTEUR change : la base 0,77 reste celle de la métropole, le référentiel ne donnant pas de base propre aux foyers. Arrondi à 4 décimales. Garde-fou : une surface utile nulle ou négative renvoie 0."
        },
        piege: "Le coefficient se calcule sur la TRANCHE entière, pas ligne à ligne : le calculer par lot donnerait des coefficients différents selon le découpage de saisie, donc des loyers faux. Et si la surface utile est nulle, le coefficient vaut 0, ce qui annule le loyer sans aucune alerte.",
        entrees: [
          [
            "Nombre de logements",
            "écran Programme, somme des lots de la tranche"
          ],
          [
            "Surface utile",
            "calculée à l’étape précédente, somme sur la tranche"
          ],
          [
            "Base 0,77 et facteur 20",
            "Paramètres > Constantes réglementaires > coefficient_structure.metropole_habitat"
          ],
          [
            "Facteur foyer 38",
            "Paramètres > Constantes réglementaires > coefficient_structure.foyers"
          ]
        ]
      },
      {
        titre: "La clé de répartition entre tranches",
        regles: ["R-SURF-3", "R-TVA-3"],
        simple: "Une opération porte souvent plusieurs produits : du PLAI, du PLUS, du PLS. Or beaucoup de dépenses se saisissent globalement, pour l’opération entière : le terrain, les honoraires d’architecte, les frais financiers. Il faut donc une clé pour dire quelle part revient à chaque tranche, et cette clé est la surface utile. Une tranche qui représente 30 % de la surface utile de l’opération porte 30 % de chaque dépense commune. La même clé sert aussi à répartir les subventions non affectées et à redresser les besoins de financement, ce qui garantit qu’une opération ne se répartit pas d’une façon dans un écran et d’une autre ailleurs.",
        formule: "quote-part d’une tranche = surface utile de la tranche ÷ surface utile totale\n\nExemple, opération de 3 000 m² :\n  PLAI ....  600 m² → 600 ÷ 3 000 = 20,0 %\n  PLUS .... 1 800 m² → 1 800 ÷ 3 000 = 60,0 %\n  PLS .....  600 m² → 600 ÷ 3 000 = 20,0 %\n                                    ────────\n                                     100,0 %\n\nUn honoraire global de 150 000 € se répartit alors en 30 000 / 90 000 / 30 000 €.",
        support: {
          fonction: "quotesPartsSU",
          signature: "quotesPartsSU(su_par_produit) → { code_produit: part }, somme = 1",
          code: "qp[code] = total > 0 ? su / total : 0",
          referentiel: "aucun : clé dérivée des seules surfaces saisies",
          alimente: "prixDeRevientVentile, agregerSubventions, redresserBesoins, compteExploitation",
          tests: "tests/loyers.test.js",
          source: "src/loyers.js:78",
          texte: "Fractions exactes, aucun arrondi : la conservation de la somme est assurée plus tard par `arrondirEnConservantLaSomme`. Si le total est nul ou négatif, toutes les parts valent 0 et les montants ventilés tombent à zéro silencieusement."
        },
        piege: "Clé UNIQUE pour toute l’opération, décidée le 05/08/2026 : « on ventile tout en surface utile ». Il n’existe pas de clé par chapitre ni par poste.",
        entrees: [
          ["Surface utile par tranche", "calculée depuis l’écran Programme"],
          ["Surface utile totale", "somme des tranches"]
        ]
      },
      {
        titre: "Du plafond de zone au loyer pratiqué",
        regles: ["R-LOYER-1", "R-LOYER-2", "R-LOYER-5"],
        simple: "Le loyer se construit en quatre temps, et chaque temps a sa source. On part du plafond de zone : un montant en euros par m² de surface utile et par mois, fixé par arrêté et propre au couple produit/zone. On lui ajoute, s’il y en a une, la marge locale de majoration, plafonnée. On multiplie le tout par le coefficient de structure de la tranche, ce qui donne le loyer plafond réellement applicable. Enfin, vous pouvez pratiquer un loyer inférieur au plafond : c’est le loyer de sortie. Le loyer annuel qui alimente le compte d’exploitation est ce loyer de sortie multiplié par la surface utile et par douze mois.",
        formule: "loyer de base ....... = plafond de zone × coefficient de millésime + marge locale\nloyer plafond ....... = loyer de base × coefficient de structure\nloyer pratiqué ...... = SI(loyer de sortie saisi ; loyer de sortie ; loyer plafond)\nloyer annuel ........ = loyer pratiqué × surface utile × 12\n\nExemple, PLUS en zone 2, 20 logements, 1 200 m² de SU :\n  plafond de zone ............ 6,49 €/m²/mois\n  marge locale ............... 0,00\n  loyer de base .............. 6,49 €/m²/mois\n  coefficient de structure ... 1,0267\n  loyer plafond .............. 6,49 × 1,0267 = 6,66 €/m²/mois\n  loyer pratiqué ............. 6,66 €/m²/mois\n  loyer annuel ............... 6,66 × 1 200 × 12 = 95 904 €",
        support: {
          fonction: "loyerDeBase, loyerProduit",
          signature: "loyerProduit({ code_produit, su_m2, nb_logements, zones, marge_locale_eur_m2, marge_majoration, loyer_sortie_force, foyer, coefficient_millesime }, referentiels) → { cs, loyer_base_eur_m2, loyer_max_base_eur_m2, loyer_pratique_eur_m2, loyer_mensuel_eur, loyer_annuel_eur }",
          code: "loyer = loyerMaxZone(code_produit, zones, referentiels) * coefficient_millesime + marge_locale_eur_m2",
          referentiel: "baremes_loyers.PRODUIT.ZONE · constantes_reglementaires.MAJORATION du produit",
          alimente: "loyer_annuel_eur → compteExploitation (recettes)",
          tests: "tests/loyers.test.js",
          source: "src/loyers.js:125 et 186",
          texte: "Le zonage applicable est une propriété du PRODUIT : PLUS et PLAI se lisent en zones 1/2/3, PLS et intermédiaire en zones A/B/C (`produit().zonage`). Le coefficient de millésime ne porte que sur le plafond de zone, pas sur la marge locale, qui est une saisie en euros du jour. Un `loyer_sortie_force` remplace le loyer pratiqué et lève le drapeau `force`."
        },
        piege: "Trois arrondis se suivent dans cette chaîne (loyer de base, loyer plafond, loyer pratiqué), si bien que la recette annuelle n’est pas exactement 12 × surface × le produit exact des facteurs. L’écart se compte en quelques euros par an sur une grosse tranche, et il est assumé : c’est ainsi que LEON calcule.",
        entrees: [
          [
            "Plafond de zone",
            "Paramètres > Loyers > loyers_max_zone_123, en €/m² SU/mois. PLUS zone 2 = 6,49 · PLAI zone 2 = 5,77"
          ],
          ["Zone 1/2/3", "écran Opération, déduite de la commune ou forcée"],
          [
            "Coefficient de millésime",
            "Paramètres > Loyers, revalorisation si le barème est plus ancien que la mise en location"
          ],
          [
            "Marge locale",
            "écran de la tranche, saisie, plafonnée par produit"
          ],
          ["Coefficient de structure", "calculé à l’étape 2"],
          [
            "Loyer de sortie",
            "écran de la tranche, saisi si l’on pratique sous le plafond"
          ]
        ]
      },
      {
        titre: "Les cas particuliers du loyer",
        regles: ["R-LOYER-3", "R-LOYER-7"],
        simple: "Deux situations échappent au barème de zone. La réhabilitation d’abord : son plafond n’est pas celui du logement neuf, c’est celui inscrit dans la convention APL en vigueur, éventuellement majoré de l’impact des travaux. Le moteur prend donc ce plafond tel que vous le saisissez et n’applique aucun coefficient de structure — il le fige à 1 — parce qu’il n’y a pas lieu de corriger d’une taille de logement un loyer déjà négocié. Les annexes ensuite : garages et stationnements peuvent être loués à part, pour un montant forfaitaire mensuel qui ne dépend ni de la surface ni du coefficient. Ces loyers-là s’ajoutent aux recettes sans passer par le calcul au m².",
        formule: "En réhabilitation :\n  loyer plafond = plafond de la convention APL (saisi tel quel)\n  coefficient de structure = 1 (neutralisé)\n\nAnnexes louées séparément :\n  recette annexes = Σ (nombre × loyer mensuel unitaire × 12)\n\nExemple :\n  12 garages × 45 €/mois × 12 = 6 480 €/an",
        support: {
          fonction: "loyerProduit (branche loyer_par_convention), loyerAnnexesSeparees",
          signature: "loyerProduit(...) quand le produit porte loyer_par_convention → cs figé à 1 · loyerAnnexesSeparees(annexes) → euros annuels",
          code: "plafond = arrondiLoyer(loyer_plafond_convention_eur_m2 ?? 0) ; pratique = arrondiLoyer(loyer_sortie_force ?? plafond)",
          referentiel: "produits.js → drapeau loyer_par_convention (REHAB) ; aucun barème de zone n’est lu",
          alimente: "compteExploitation (recettes), au même titre qu’un loyer barémé",
          tests: "tests/loyers.test.js",
          source: "src/loyers.js:186 et 256",
          texte: "La majoration PLUS 33 % s’applique APRÈS l’ajout de la marge locale : elle multiplie donc aussi la marge. Arbitrage I-6 : ×1,33 partout, jamais +0,33. En branche conventionnelle, `marge_majoration` et `coefficient_millesime` sont ignorés et le coefficient de structure est forcé à 1."
        },
        piege: "Une réhabilitation dont le plafond de convention n’est pas saisi produit une recette nulle. Le moteur le signale en alerte (`controlesLoyer`) mais ne bloque pas le calcul. Attention aussi au double compte : une cave peut être à la fois dans les surfaces annexes et louée séparément.",
        entrees: [
          [
            "Plafond de convention",
            "écran de la tranche, saisi, en €/m²/mois"
          ],
          [
            "Produit REHAB",
            "défini dans produits.js avec le drapeau loyer_par_convention"
          ],
          [
            "Annexes séparées",
            "écran de la tranche, nombre et loyer mensuel unitaire"
          ]
        ]
      }
    ]
  },
  {
    id: "prix-revient",
    titre: "Prix de revient et TVA",
    accroche: "Le même bilan se lit de deux façons. La première est le coût réel, avec la TVA que l’entreprise facture. La seconde recalcule tout au taux de la livraison à soi-même du produit : c’est celle que retient l’administration, et c’est elle qui sert d’assiette au plan de financement.",
    etapes: [
      {
        titre: "La livraison à soi-même",
        regles: ["R-TVA-2"],
        simple: "Un organisme HLM qui construit pour lui-même doit se facturer la TVA à lui-même : c’est la livraison à soi-même. Le taux dépend du produit de financement, pas de la nature de la dépense. Le PLAI relève de 5,5 %, le PLUS et le PLS de 10 %, le logement libre de 20 %. Un cas particulier : le PLUS situé en quartier prioritaire de la ville, ou sous convention de renouvellement urbain, bascule à 5,5 % — ce n’est pas un autre produit, c’est le même PLUS avec la case QPV cochée. Concrètement, ce taux transforme chaque montant hors taxes saisi en montant TTC, et c’est ce TTC qui devient le prix de revient à financer.",
        formule: "taux LASM = SI(produit = PLUS ET QPV ; 5,5 % ; taux du produit)\nmontant TTC = montant HT × (1 + taux LASM)\n\nBarème :\n  PLAI ................ 5,5 %\n  PLUS ................ 10 %   (5,5 % si QPV)\n  PLS ................. 10 %\n  LLI / PLI ........... 10 %\n  LIBRE ............... 20 %\n\nExemple, 1 000 000 € HT en PLUS hors QPV :\n  1 000 000 × 1,10 = 1 100 000 € TTC",
        support: {
          fonction: "tauxLASM",
          signature: "tauxLASM(code_produit, referentiels, contexte = { qpv }) → taux en fraction. Lève si le produit n’a ni entrée dédiée ni clé de repli",
          code: "si PLUS et contexte.qpv → tva.plus_en_qpv.taux ; sinon tva.lasm_par_produit[code_produit] ; sinon tva[def.cle_lasm]",
          referentiel: "tva.lasm_par_produit.PRODUIT · tva.plus_en_qpv.taux · tva.CLE_LASM du produit en repli",
          alimente: "prixDeRevient et prixDeRevientVentile → prix de revient TTC",
          tests: "tests/bilan.test.js",
          source: "src/bilan.js:105",
          texte: "Priorité : PLUS + qpv → `tva.plus_en_qpv.taux`, puis `tva.lasm_par_produit[code]`, puis `tva[produit().cle_lasm]`, sinon exception. La bascule QPV n’est câblée que pour le code `PLUS` exactement : ni FPLUS ni PLUS33 n’en bénéficient par ce chemin."
        },
        piege: "Un poste marqué hors champ de la livraison à soi-même garde son TTC de saisie : son taux n’est pas remplacé par celui du produit. C’est ce qui permet de traiter les postes sans TVA (taxes, certains honoraires).",
        entrees: [
          ["Taux par produit", "Paramètres > TVA > lasm_par_produit"],
          ["Taux QPV", "Paramètres > TVA > plus_en_qpv.taux"],
          ["Case QPV", "écran Opération, propriété de l’opération"],
          ["Montants HT", "écran Prix de revient, saisis poste par poste"]
        ]
      },
      {
        titre: "Saisir globalement, ventiler au prorata",
        regles: ["R-TVA-1", "R-TVA-3"],
        simple: "Chaque poste de dépense peut se saisir de deux façons. Soit globalement, pour l’opération entière, et le moteur le répartit entre les tranches au prorata de leur surface utile — c’est le cas normal du terrain ou des honoraires. Soit tranche par tranche, quand vous connaissez le détail réel — le bouton de ventilation de la ligne fait passer d’un mode à l’autre. Un point qui surprend souvent : le taux de TVA, lui, reste toujours propre à la tranche, même quand le montant est saisi globalement. La raison est simple : le taux dépend du produit de financement, or une même dépense de terrain sert à la fois du PLAI à 5,5 % et du PLUS à 10 %. Le moteur applique donc à chaque part le taux de sa tranche.",
        formule: "part d’une tranche = montant global × quote-part de surface utile\nmontant TTC de la tranche = part HT × (1 + taux LASM de la tranche)\n\nExemple, terrain de 500 000 € HT, opération 20 % PLAI / 80 % PLUS :\n  PLAI : 500 000 × 20 % = 100 000 HT → × 1,055 = 105 500 TTC\n  PLUS : 500 000 × 80 % = 400 000 HT → × 1,10  = 440 000 TTC\n                                        ─────────────────────\n  total .............................. 500 000 HT   545 500 TTC\n  taux moyen de l’opération .......... 9,10 %\n\nSi seul le TTC est connu : HT = TTC ÷ (1 + taux).",
        support: {
          fonction: "prixDeRevientVentile, montantHTPoste, tauxTVAPoste",
          signature: "prixDeRevientVentile({ postes, quotes_parts, codes_produits, modulation_ttc_eur, qpv }, referentiels) → { par_tranche, total_ht_eur, total_ttc_lasm_eur, cle_ventilation }",
          code: "montantHTPoste : ht = ttc / (1 + taux) quand seul le TTC est saisi · tauxTVAPoste : taux du poste, sinon taux LASM du produit",
          referentiel: "tva.lasm_par_produit via tauxLASM · quotes-parts issues de quotesPartsSU",
          alimente: "soldeAFinancer, foncierFinancable, compteExploitation (assiettes en % du prix de revient)",
          tests: "tests/bilan.test.js",
          source: "src/bilan.js:245, 64 et 78",
          texte: "Dès que `montants_ht_par_produit` existe, c’est lui qui fait foi et le montant global en découle. Attention : un objet vide `{}` est truthy, donc un poste portant `montants_ht_par_produit: {}` renvoie 0 et ignore `montant_ht_eur` en silence."
        },
        piege: "Un montant ventilé à la main vers un produit absent du programme est compté dans le total de la ligne mais dans aucune tranche : le détail cesse alors de s’additionner au total, sans alerte.",
        entrees: [
          [
            "Montant du poste",
            "écran Prix de revient, saisi en HT ou en TTC"
          ],
          [
            "Mode de saisie",
            "bouton de ventilation de la ligne : global ou par tranche"
          ],
          ["Quote-part de surface utile", "calculée au chapitre Surfaces"],
          [
            "Taux de TVA",
            "proposé selon le produit, modifiable ligne par ligne"
          ]
        ]
      },
      {
        titre: "Les arrondis de la ventilation",
        regles: ["R-TVA-3", "R-CONV"],
        simple: "Répartir un montant entre trois tranches et arrondir chaque part à l’euro fait presque toujours perdre ou gagner quelques euros au total. Trois parts de 3,33 € arrondies donnent 9 €, pour un total réel de 10 €. Sur un prix de revient, cet écart se voit immédiatement à l’écran et décrédibilise toute la restitution. Le moteur répartit donc le reliquat : il arrondit chaque part à l’euro inférieur, puis distribue les euros manquants aux parts dont la décimale était la plus grande. Le total affiché est ainsi toujours exactement la somme des lignes affichées. Quand un sous-total a déjà été arrondi ailleurs et fait autorité, c’est lui qu’on impose comme cible, pour que la ligne s’additionne à l’écran.",
        formule: "1. part arrondie à l’euro inférieur pour chacune\n2. reliquat = total à atteindre − somme des parts arrondies\n3. le reliquat va aux plus grandes décimales, une unité à la fois\n\nExemple, 10 000 € à répartir en 33,33 % / 33,33 % / 33,34 % :\n  parts exactes ....... 3 333,00   3 333,00   3 334,00\n  parts brutes ........ 3 333,33   3 333,33   3 333,34\n  arrondi inférieur ... 3 333      3 333      3 333     → somme 9 999\n  reliquat de 1 € ..... au plus grand reste (le troisième)\n  résultat ............ 3 333      3 333      3 334     → somme 10 000 ✓",
        support: {
          fonction: "arrondirEnConservantLaSomme (appelée par prixDeRevientVentile)",
          signature: "arrondirEnConservantLaSomme(valeurs, totalImpose) → entiers de même longueur dont la somme vaut exactement le total",
          code: "bas = valeurs.map(Math.floor) ; le reliquat va aux plus grands restes, puis à égalité dans l’ordre fourni",
          referentiel: "aucun",
          alimente: "toute ventilation affichée : le total à l’écran s’additionne réellement",
          tests: "tests/bilan.test.js, tests/regressions.test.js",
          source: "src/bilan.js:245",
          texte: "Le croisement chapitre × tranche impose comme total le sous-total de CHAPITRE déjà arrondi, pour que la ligne s’additionne à l’écran. Un même arrondi ne peut satisfaire la ligne et la colonne simultanément : l’écart d’un euro est structurel et documenté dans le code."
        },
        piege: "Cet écart d’un euro est normal et attendu. Ce n’est pas un bug à signaler.",
        entrees: [
          [
            "Valeurs exactes",
            "les parts non arrondies issues de la ventilation"
          ],
          [
            "Total imposé",
            "le sous-total déjà arrondi, quand il fait autorité"
          ]
        ]
      },
      {
        titre: "La modulation et la base d’amortissement",
        regles: ["R-TVA-4"],
        simple: "Deux notions se calculent au bout du prix de revient. La modulation d’abord : c’est un ajustement forfaitaire du prix de revient TTC, en plus ou en moins, qu’on utilise pour caler une simulation sur un chiffre connu sans retoucher chaque poste. La base d’amortissement comptable ensuite : le bâtiment s’amortit, le terrain non, puisqu’il ne s’use pas. On retire donc du prix de revient TTC la valeur comptable du terrain, et c’est le reste qui sera étalé sur la durée des composants. Attention sur ce point : les annexes LEON appliquent 25 % du montant d’acquisition en VEFA, là où la table par zone du référentiel donne d’autres quotités. La question reste ouverte, et l’écart peut être important.",
        formule: "prix de revient TTC = Σ postes TTC + modulation\nvaleur comptable du terrain = montant du terrain × quotité\nbase d’amortissement = prix de revient TTC − valeur comptable du terrain\n\nExemple, VEFA de 2 062 430,70 € TTC, prix de revient 2 215 969,74 € :\n  quotité terrain ............ 25 %\n  valeur comptable terrain ... 2 062 430,70 × 25 % = 515 607,68 €\n  base d’amortissement ....... 2 215 969,74 − 515 607,68 = 1 700 362,06 €",
        support: {
          fonction: "prixDeRevient, valeurComptableTerrain, baseAmortissementComptable",
          signature: "prixDeRevient({ code_produit, postes, modulation_ttc_eur, qpv }, referentiels) → totaux et chapitres · valeurComptableTerrain({ montant_terrain_eur, quotite }) → euros · baseAmortissementComptable({ prix_revient_ttc_eur, valeur_comptable_terrain_eur }) → euros",
          code: "base = prix_revient_ttc_eur - valeur_comptable_terrain_eur",
          referentiel: "quotites_foncier_vefa.valeur_comptable_terrain_vefa par zone. Attention : les annexes LEON appliquent 25 % du montant d’acquisition VEFA, pas la table par zone (question Q-26)",
          alimente: "dotationParComposants → dotation aux amortissements du compte d’exploitation",
          tests: "tests/bilan.test.js",
          source: "src/bilan.js:157, 422 et 440",
          texte: "`valeurComptableTerrain` LÈVE une exception si la quotité ne lui est pas fournie : elle refuse délibérément de choisir une valeur par défaut. La modulation est toujours ventilée au prorata de surface utile, même quand tous les postes ont été ventilés à la main."
        },
        piege: "La quotité de terrain n’est pas tranchée (question Q-26) : les annexes appliquent 25 % du montant d’acquisition, quand la table par zone du référentiel donne 13 % en B1. Le moteur exige donc qu’on la lui donne explicitement.",
        entrees: [
          ["Modulation", "écran Prix de revient, saisie, en TTC"],
          [
            "Montant du terrain",
            "poste de charge foncière du prix de revient"
          ],
          [
            "Quotité de terrain",
            "Paramètres > Foncier > quotites_foncier_vefa (question Q-26 : les annexes appliquent 25 %)"
          ]
        ]
      }
    ]
  },
  {
    id: "prets",
    titre: "Prêts et amortissement",
    accroche: "C’est la partie la plus dense du moteur, et celle qui pèse le plus lourd : sur cinquante ans, une erreur d’un dixième de point sur un taux se compte en dizaines de milliers d’euros. Le principe tient pourtant en une phrase : chaque année, le moteur recalcule l’annuité sur le capital qui reste et le temps qui reste.",
    etapes: [
      {
        titre: "L’annuité, et pourquoi elle progresse",
        regles: ["R-AMT-2"],
        simple: "Une annuité de prêt HLM n’est pas constante. Elle progresse d’un petit pourcentage chaque année — souvent −0,5 %, c’est-à-dire qu’elle décroît — pour coller à l’évolution attendue des loyers. Le calcul part du capital restant dû, du taux de la période et du nombre d’échéances qui restent, et cherche l’annuité qui solde exactement le capital sur ces échéances-là en respectant la progression demandée. C’est la même mécanique qu’une mensualité de crédit classique, avec un terme de plus pour la progression. Quand la progression est nulle, la formule redonne exactement l’annuité constante que tout le monde connaît.",
        formule: "q = (1 + progressivité) ÷ (1 + taux)\nannuité = capital restant dû × (1 + taux) × (1 − q) ÷ (1 − q^échéances restantes)\n\nSi q = 1 (progressivité égale au taux) :\n  annuité = capital × (1 + taux) ÷ échéances restantes\n\nExemple, 1 000 000 € sur 40 ans à 2,61 %, progressivité −0,5 % :\n  q .......................... 0,995 ÷ 1,0261 = 0,96968\n  annuité de la 1re échéance . 44 189 €\n  annuité de la 40e ......... 36 214 €   (elle a décru de 0,5 % par an)",
        support: {
          fonction: "facteurAnnuite",
          signature: "facteurAnnuite(tx, rev, m) → facteur à multiplier par le capital restant dû. tx = taux de la période, rev = progression de l’annuité, m = échéances restantes",
          code: "q = (1 + rev) / (1 + tx) ; si q vaut 1 → (1 + tx) / m ; sinon ((1 + tx) * (1 - q)) / (1 - q ** m)",
          referentiel: "aucun : forme fermée pure, aucune itération",
          alimente: "tableauAmortissement, à chaque échéance",
          tests: "tests/amortissement.test.js",
          source: "src/amortissement.js:100",
          texte: "Quand q vaut exactement 1 (progressivité égale au taux), la forme générale se dérobe : le moteur bascule sur la limite mathématique (1+taux)/m, là où LEON affiche #DIV/0! (écart E-6). À la dernière échéance m vaut 1 et le facteur vaut (1 + taux) : l’annuité finale solde exactement le capital et ses intérêts, sans qu’aucun cas particulier n’ait été codé."
        },
        piege: "Quand q est inférieur à 1, l’annuité progresse moins vite que le capital ne coûte, et le prêt s’amortit. C’est cette comparaison, et non la progressivité seule, qui décide du profil du prêt.",
        entrees: [
          [
            "Capital restant dû",
            "le montant du prêt la 1re année, puis le solde des années suivantes"
          ],
          [
            "Taux de la période",
            "Livret A + marge du produit, révisé chaque année"
          ],
          [
            "Progressivité",
            "vignette du prêt, −0,5 % par défaut sur les prêts CDC"
          ],
          [
            "Échéances restantes",
            "durée du prêt moins les échéances déjà payées"
          ]
        ]
      },
      {
        titre: "Le ré-amortissement annuel",
        regles: ["R-AMT-4"],
        simple: "Le moteur ne calcule pas une annuité une fois pour toutes qu’il reconduirait ensuite. Chaque année, il repart du capital effectivement restant dû, du taux de l’année et du nombre d’années qui restent, et il recalcule. C’est important : si le Livret A monte, le taux monte, et l’annuité de l’année suivante est recalculée pour solder quand même le prêt à la date prévue. Ce ré-amortissement est ce qui fait qu’un prêt à taux révisable se termine exactement à son terme, quelle que soit la trajectoire des taux. La dernière année n’est pas un cas particulier codé à part : quand il ne reste qu’une échéance, la formule donne naturellement le capital restant plus ses intérêts.",
        formule: "Pour chaque année N :\n  taux N ......... = f(Livret A de l’année N)\n  échéances rest. = durée totale − (N − 1)\n  annuité N ...... = CRD × facteur(taux N ; progressivité ; échéances restantes)\n  intérêts N ..... = CRD × taux N\n  amortissement N  = annuité N − intérêts N\n  CRD suivant .... = CRD − amortissement N\n\nDernière échéance (échéances restantes = 1) :\n  annuité = CRD × (1 + taux)  →  le prêt est soldé, CRD = 0",
        support: {
          fonction: "tableauAmortissement",
          signature: "tableauAmortissement(pret) → [{ annee, taux, annuite_eur, interets_eur, amortissement_eur, crd_eur }]. pret : { montant_eur, taux, progressivite, duree_ans, annee_premiere_echeance, revisabilite, differe_ans, differe_type, livret_a_origine, livret_a_par_annee, profil, taux_plancher, echeances_par_an }",
          code: "annuite = crd * facteurAnnuite(tx, rev, m) ; interets = crd * tx ; crd -= (annuite - interets)",
          referentiel: "prets_cdc.marges pour le taux · trajectoires.par_annee pour le Livret A",
          alimente: "compteExploitation (charge d’annuités), plan de financement, trésorerie",
          tests: "tests/amortissement.test.js, tests/golden.test.js",
          source: "src/amortissement.js:315",
          texte: "Correction majeure apportée au dictionnaire v0.1, qui décrivait une progression géométrique. Attention : `premiereAnnuite` (R-AMT-2) n’est JAMAIS appelée par `tableauAmortissement`. S’en servir pour prédire l’annuité 1 d’un prêt révisable donnerait un chiffre juste seulement si le Livret A n’a pas bougé (Q-5, close)."
        },
        piege: "Aucune valeur du tableau n’est arrondie (règle R-CONV). Seul le test de fin de prêt arrondit le capital restant dû à quatre décimales, comme LEON.",
        entrees: [
          [
            "Livret A par année",
            "Paramètres > Trajectoires macro, année par année"
          ],
          [
            "Livret A d’origine",
            "Paramètres > Prêts, le taux de référence du profil (1,50 % en HER 2027)"
          ],
          [
            "Durée du prêt",
            "vignette du prêt, 40 ans en travaux et 50 à 60 ans en foncier"
          ]
        ]
      },
      {
        titre: "Les quatre révisabilités",
        regles: ["R-AMT-4"],
        simple: "Un prêt CDC est indexé sur le Livret A, mais il y a quatre façons de l’être et elles ne donnent pas le même échéancier. En TAUX FIXE, rien ne bouge : le taux du contrat s’applique jusqu’au bout. En SIMPLE, seul le taux suit le Livret A ; la progression de l’annuité, elle, reste celle du contrat. En DOUBLE — le cas des PLAI, PLUS et PLS chez AXENTIA — le taux et la progression de l’annuité suivent tous deux le Livret A. En DURÉE LIMITÉE, c’est comme le DOUBLE mais la révision de l’annuité ne peut jamais être négative. La différence entre SIMPLE et DOUBLE peut représenter plusieurs points de pourcentage sur l’annuité au bout de vingt ans.",
        formule: "écart = (Livret A de l’année − Livret A d’origine) ÷ (1 + taux du contrat)\n\ntaux appliqué  = (1 + taux du contrat) × (1 + écart) − 1   [sauf TAUX FIXE]\n\nrévision de l’annuité selon la révisabilité :\n  TAUX FIXE ....... taux figé, progression = progressivité du contrat\n  SIMPLE .......... progression = progressivité du contrat\n  DOUBLE .......... progression = (1 + progressivité) × (1 + écart) − 1\n  D. LIMITÉE ...... progression = MAX(formule DOUBLE ; 0)\n\nExemple, contrat à 2,61 %, Livret A d’origine 1,50 %, Livret A 2027 = 2,10 % :\n  écart .......... (2,10 − 1,50) ÷ 1,0261 = +0,585 %\n  taux appliqué .. 2,61 % → 3,21 %",
        support: {
          fonction: "tableauAmortissement, normaliserRevisabilite",
          signature: "normaliserRevisabilite(libelle) → DOUBLE, D. LIMITEE, SIMPLE ou TAUX FIXE. Tout libellé inconnu retombe sur SIMPLE",
          code: "tx = (1 + taux) * (1 + ecartLA) - 1 ; en DOUBLE le même écart s’applique aussi à la progressivité",
          referentiel: "trajectoires.par_annee.ANNEE.livret_a · le Livret A d’origine vient du profil",
          alimente: "tableauAmortissement : le taux ET l’annuité de chaque échéance",
          tests: "tests/amortissement.test.js, tests/golden.test.js",
          source: "src/amortissement.js:315 et 63",
          texte: "La simplification `taux = t + ΔLA` est une identité EXACTE. Celle de la progression ne l’est pas : `rev = p + (1+p)·ΔLA/(1+t)` et non `p + ΔLA`. Contrôle numérique du dictionnaire : p = −0,5 %, ΔLA = −0,4 point, t = 2 % donnent −0,890196 % et non −0,9 %. Écarts LEON E-3 et E-5 : LEON révise parfois le taux d’un prêt à taux fixe et oublie parfois de tester DOUBLE ; le moteur applique partout la garde correcte."
        },
        piege: "Tout se joue sur l’ÉCART au Livret A d’origine, jamais sur sa valeur absolue. Si le Livret A de l’année égale celui d’origine, aucune révision n’a lieu, quelle que soit la révisabilité. Et si le Livret A d’origine n’est pas renseigné, il vaut zéro : l’écart devient le Livret A tout entier et la révision est massive.",
        entrees: [
          [
            "Révisabilité",
            "vignette du prêt, DOUBLE par défaut sur les prêts CDC"
          ],
          [
            "Livret A d’origine",
            "Paramètres > Prêts, taux de référence du profil"
          ],
          ["Trajectoire du Livret A", "Paramètres > Trajectoires macro"],
          ["Taux du contrat", "Livret A d’origine + marge du produit"]
        ]
      },
      {
        titre: "Différés, profil constant et taux plancher",
        regles: ["R-AMT-6", "R-AMT-7", "R-AMT-9"],
        simple: "Trois réglages modifient la forme de l’échéancier sans toucher au capital. Le différé retarde le début du remboursement : en type 2 vous payez les intérêts sans entamer le capital ; en type 1 vous ne payez rien du tout, ce qui n’est pas un bug mais le fonctionnement réel du PHB 2.0, dont les vingt premières années sont à taux zéro. Le profil constant remplace l’annuité progressive par un remboursement de capital constant, l’annuité totale décroissant alors régulièrement. Le taux plancher, enfin, empêche le taux de descendre sous une valeur : les prêts Action Logement en ont besoin, leur marge de −2,25 % appliquée à un Livret A à 1,50 % donnerait un taux négatif de −0,75 %.",
        formule: "différé type 2 : intérêts payés, capital intact\n  annuité = capital × taux\ndifféré type 1 : rien n’est appelé\n  annuité = 0, capital inchangé\n\nprofil constant :\n  amortissement = capital initial ÷ nombre d’échéances\n  annuité = amortissement + capital restant × taux\n\ntaux plancher :\n  taux appliqué = MAX(taux calculé ; taux plancher)\n\nExemple, Action Logement : Livret A 1,50 % − marge 2,25 % = −0,75 %\n  taux plancher 0,25 % → taux appliqué = 0,25 %",
        support: {
          fonction: "differeEnPeriodes, tableauAmortissement (branches profil et plancher)",
          signature: "differeEnPeriodes({ differe_ans, differe_mois, echeances_par_an }) → nombre de périodes différées",
          code: "type 1 → aucun intérêt appelé, CRD inchangé · type 2 → intérêts payés, capital intact · plancher : tx = Math.max(txBrut, taux_plancher)",
          referentiel: "presets_prets.presets[].differe_ans, .differe_type, .taux_plancher, .profil",
          alimente: "tableauAmortissement : décale le début de l’amortissement du capital",
          tests: "tests/amortissement.test.js",
          source: "src/amortissement.js:236 et 315",
          texte: "Le différé se saisit en mois ou en années, `differe_mois` primant dès qu’il est défini. Conversion : `Math.round(mois × périodicité / 12)`. Le plancher borne le TAUX APPLIQUÉ, jamais la marge : sans plancher déclaré, un taux négatif reste négatif, ce qui rend visible un modèle mal renseigné au lieu de le corriger en silence."
        },
        piege: "Sur un prêt annuel, un différé de 30 mois devient 3 ans : la demi-échéance n’existe pas, un prêt annuel ne peut pas commencer à s’amortir en juin. Sur un prêt trimestriel, les mêmes 30 mois donnent exactement 10 échéances, et c’est tout l’intérêt de la saisie en mois.",
        entrees: [
          ["Différé (ans ou mois)", "vignette du prêt > Temporalité"],
          [
            "Type de différé",
            "vignette du prêt : 1 (rien n’est dû) ou 2 (intérêts seuls)"
          ],
          [
            "Profil d’amortissement",
            "vignette du prêt : échéances prioritaires ou capital constant"
          ],
          ["Taux plancher", "vignette du prêt, ou modèle de prêt en admin"]
        ]
      },
      {
        titre: "Les échéances infra-annuelles",
        regles: ["R-AMT-8"],
        simple: "Certains prêts ne se remboursent pas une fois par an mais quatre — les prêts Action Logement sont trimestriels. Le moteur calcule alors l’échéancier période par période, avec un taux ramené à la période, puis agrège les quatre échéances d’une même année civile avant de les restituer. Le taux de période n’est pas le taux annuel divisé par quatre : c’est sa racine quatrième, parce que les intérêts se composent. La différence est faible sur une échéance mais elle ne l’est plus sur quarante ans.",
        formule: "taux de période = (1 + taux annuel) ^ (1 ÷ échéances par an) − 1\nnombre de périodes = durée en années × échéances par an\n\nExemple, 2,61 % annuel en trimestriel :\n  taux trimestriel = 1,0261 ^ 0,25 − 1 = 0,6461 %\n  (et non 2,61 ÷ 4 = 0,6525 %)\n\nL’année civile affichée est la somme des 4 échéances de l’année.",
        support: {
          fonction: "tableauPeriodique",
          signature: "tableauPeriodique(pret) → lignes infra-annuelles, agrégées par année civile avant restitution",
          code: "tx_periode = (1 + taux) ** (1 / echeances_par_an) - 1",
          referentiel: "presets_prets.presets[].echeances_par_an (4 pour un prêt trimestriel)",
          alimente: "tableauAmortissement, qui délègue dès que echeances_par_an dépasse 1",
          tests: "tests/amortissement.test.js",
          source: "src/amortissement.js:242",
          texte: "Chemin de code séparé de la boucle annuelle, laissée intacte pour qu’aucun prêt annuel ne change de comportement, c’est elle qui porte les golden tests. Un `periodicite: 1` explicite reproduit exactement le prêt annuel (vérifié par test)."
        },
        piege: "Le taux est divisé (convention proportionnelle) mais la progressivité est répartie en racine (convention actuarielle). Ce n’est pas une incohérence : la progressivité est contractuellement ANNUELLE, il faut donc qu’elle reste de −0,5 % par an et ne devienne pas −2 %. La convention proportionnelle du taux, elle, est un choix documenté que les fiches produit ne précisent pas.",
        entrees: [
          [
            "Échéances par an",
            "vignette du prêt > Remboursement, 1 par défaut, 4 en trimestriel"
          ],
          ["Taux annuel", "le taux du contrat, révisé selon la révisabilité"]
        ]
      },
      {
        titre: "La première échéance",
        regles: ["R-AMT-3"],
        simple: "La première échéance tombe l’année de la mise en location. Le prêt est mobilisé à la livraison et s’amortit dans la foulée, les intérêts de la période de chantier étant déjà portés par le préfinancement. Cette règle a été arbitrée par le métier le 11 août 2026. Il faut savoir qu’elle diverge de ce que font les annexes LEON : sur les quatre annexes dont nous disposons, l’amortissement démarre en réalité la première année civile complète, soit un an plus tard quand la mise en location ne tombe pas un 1er janvier. Sur une opération livrée en décembre, cela signifie que le moteur porte une annuité pleine sur une année qui ne compte qu’un mois de loyer. La question reste ouverte sous la référence Q-28.",
        formule: "année de la 1re échéance = année de mise en location\n\nExemples :\n  mise en location 02/01/2028 → 1re échéance en 2028\n  mise en location 01/12/2026 → 1re échéance en 2026\n\nCe que font les annexes LEON (règle non retenue) :\n  1re année civile complète, soit 2027 dans le second cas",
        support: {
          fonction: "anneePremiereEcheance",
          signature: "anneePremiereEcheance(annee_mise_en_location, _options) → année",
          code: "return annee_mise_en_location   (mise en location + 0, arbitrage métier du 11/08/2026)",
          referentiel: "aucun. Le second paramètre est conservé pour ne pas casser les appels si la règle redevenait paramétrable",
          alimente: "tableauAmortissement : l’année de la première ligne",
          tests: "tests/amortissement.test.js. Voir la question Q-28 : les quatre annexes LEON disent mise en location + 1",
          source: "src/amortissement.js:86",
          texte: "Arbitrage métier du 11/08/2026 (Q-4, Q-28) contre le dictionnaire v0.1, qui lisait « année(DAT) + 1 ». Le décalage de démembrement est devenu sans objet ; la signature le tolère encore pour ne pas casser les appelants."
        },
        piege: "Question Q-28 rouverte le 11/08/2026 : les quatre annexes LEON disponibles démarrent en réalité à la première année civile COMPLÈTE, ce qui vaut mise en location + 1 sauf quand elle tombe un 1ᵉʳ janvier. La règle appliquée ici reste MEL + 0 tant que l’arbitrage n’a pas été revu.",
        entrees: [
          [
            "Année de mise en location",
            "calculée au calendrier, ou forcée sur le prêt"
          ],
          [
            "Année de 1re échéance",
            "vignette du prêt > Temporalité, saisissable pour forcer"
          ]
        ]
      },
      {
        titre: "Le préfinancement",
        regles: ["R-FIN-6"],
        simple: "Pendant le chantier, l’organisme décaisse sans percevoir de loyer. Le préfinancement couvre ce décalage : les fonds sont tirés au fur et à mesure des besoins, et les intérêts courent depuis chaque tirage jusqu’à la fin de la période. Ces intérêts ne sont pas payés au fil de l’eau, ils sont capitalisés — ajoutés au capital — et c’est ce capital gonflé qui sera amorti ensuite. Chaque tirage est capitalisé sur sa propre durée, en base 365 jours réels : un tirage du premier mois porte deux ans d’intérêts, un tirage du dernier mois presque aucun.",
        formule: "pour chaque tirage :\n  capitalisé = montant × (1 + taux) ^ (jours jusqu’à la fin ÷ 365)\n\nnominal ............... = Σ montants tirés\ncapital constitué ..... = Σ capitalisés\nintérêts intercalaires  = capital constitué − nominal\n\nExemple, 2 tirages, taux 2,61 %, fin au 31/12/2027 :\n  500 000 € le 01/01/2026 → 730 j → 500 000 × 1,0261^2,00 = 526 428 €\n  500 000 € le 01/01/2027 → 365 j → 500 000 × 1,0261^1,00 = 513 050 €\n  nominal 1 000 000 € · capital constitué 1 039 478 € · intérêts 39 478 €",
        support: {
          fonction: "prefinancement",
          signature: "prefinancement({ tirages, taux, date_fin, capitaliser = true }) → { nominal_eur, interets_eur, capital_constitue_eur }",
          code: "capitalise += montant_eur * (1 + taux) ** ((jourFin - jourTirage) / 365)",
          referentiel: "aucun : taux et tirages viennent de la saisie et de la trésorerie de chantier",
          alimente: "pretsCDCTheoriques (le préfinancement se retranche du besoin) et le poste de frais financiers",
          tests: "tests/amortissement.test.js",
          source: "src/amortissement.js:496",
          texte: "Capitalisation actuarielle en base exact/365, convention lue dans SimPLUS!FA15. La date de fin par défaut est celle du DERNIER tirage (Q-3, close) et non la mise en location : le dernier tirage ne porte donc aucun intérêt sauf à passer une date de fin explicite."
        },
        piege: "Ne pas capitaliser les intérêts ne les supprime pas : le coût existe toujours, il n’est simplement pas incorporé au capital du prêt.",
        entrees: [
          [
            "Échéancier des tirages",
            "issu de la trésorerie de chantier, mois par mois"
          ],
          [
            "Taux de préfinancement",
            "vignette du prêt, ou taux du prêt lui-même"
          ],
          [
            "Date de fin",
            "fin de la période de préfinancement, en principe la mise en location"
          ]
        ]
      }
    ]
  },
  {
    id: "tresorerie",
    titre: "Trésorerie de chantier",
    accroche: "Le compte d’exploitation démarre à la mise en location. Entre l’ordre de service et la livraison, l’opération ne fait que dépenser, et ses financements n’arrivent pas au même rythme. Ce module répond à une seule question : l’opération a-t-elle de quoi payer ses factures pendant les travaux ?",
    etapes: [
      {
        titre: "Deux indexations qui se suivent",
        regles: ["R-TRESO-2"],
        simple: "Le coût des travaux que vous saisissez a une date de valeur : c’est le prix à un moment donné. Entre cette date et le chantier réel, les prix montent. Le moteur applique donc deux indexations qui se suivent. La première amène le coût de sa date de valeur jusqu’au démarrage du chantier. La seconde continue de l’indexer mois après mois pendant le chantier, puisqu’une dépense du 24e mois se paie plus cher qu’une du 1er. Les deux utilisent le même taux annuel, ramené au prorata du temps écoulé. Sans cette double indexation, une opération étudiée deux ans à l’avance serait systématiquement sous-évaluée.",
        formule: "coût au démarrage = coût saisi × (1 + taux) ^ (mois entre date de valeur et OS ÷ 12)\ndépense du mois M = dépense de base × (1 + taux) ^ (M ÷ 12)\n\nExemple, 2 000 000 € valeur 01/01/2025, chantier 01/01/2026 → 24 mois, taux 2 % :\n  révision jusqu’à l’OS ... 2 000 000 × 1,02^1,00 = 2 040 000 €\n  dépense du mois 1 ....... 85 000 × 1,02^0,08 = 85 142 €\n  dépense du mois 24 ...... 85 000 × 1,02^2,00 = 88 434 €",
        support: {
          fonction: "tresorerieChantier",
          signature: "tresorerieChantier({ date_debut_travaux, duree_chantier_mois, cout_total_eur, date_valeur_cout, taux_indexation, subventions_eur, fonds_propres_eur, tirer_les_prets, jalons, mode_tirage }) → { flux, indicateurs, echeance_nominale_eur }",
          code: "cout_indexe = cout_total_eur * (1 + taux_indexation) ** (mois écoulés / 12)",
          referentiel: "tresorerie.taux_indexation · tresorerie.jalons_vefa.jalons · tresorerie.mode_tirage",
          alimente: "l’écran Trésorerie et l’échéancier de tirages passé à prefinancement",
          tests: "tests/tresorerie.test.js",
          source: "src/tresorerie.js:72",
          texte: "Base 365,25 jours, celle du classeur métier « Indexeur coût travaux ». Attention : le préfinancement (R-FIN-6) utilise 365. Les deux bases coexistent volontairement, ne pas les uniformiser sans arbitrage métier."
        },
        piege: "La première échéance tombe un mois APRÈS l’ordre de service : un chantier ne facture pas le jour où il commence.",
        entrees: [
          [
            "Coût total de l’opération",
            "prix de revient TTC, ou montant saisi dans l’écran Trésorerie"
          ],
          ["Date de valeur du coût", "écran Trésorerie, saisie"],
          [
            "Taux d’indexation",
            "Paramètres > Trésorerie > taux_indexation (2 % par défaut)"
          ],
          ["Durée du chantier", "écran Opération > Calendrier"]
        ]
      },
      {
        titre: "Le barème d’appels de fonds en VEFA",
        regles: ["R-TRESO-3"],
        simple: "En VEFA, on ne paie pas le promoteur mois par mois : on l’appelle à des jalons d’avancement, selon un barème légal. Le moteur retient ce barème par défaut — 25 % à l’achèvement des fondations, puis les paliers réglementaires jusqu’à la livraison — et vous pouvez le modifier dans l’écran d’administration, y compris insérer, supprimer et réordonner des jalons. Chaque jalon porte un avancement, exprimé en pourcentage du chantier, et une part, exprimée en pourcentage du coût. L’avancement se convertit en mois : un jalon à 50 % d’avancement d’un chantier de 24 mois tombe au mois 12. Un jalon posé au-delà de la livraison y est ramené, la trésorerie de chantier s’arrêtant là. Le total des parts doit faire 100 %, et l’écran le signale en rouge si ce n’est pas le cas.",
        formule: "mois du jalon = ARRONDI(avancement × durée du chantier)\nappel du jalon = coût indexé × part\n\nBarème par défaut (VEFA) :\n  fondations ......... avancement  25 %  →  part 25 %\n  mise hors d’eau .... avancement  50 %  →  part 25 %\n  achèvement ......... avancement  75 %  →  part 25 %\n  livraison .......... avancement 100 %  →  part 25 %\n                                          ─────────\n                                            100 %\n\nChantier de 24 mois : appels aux mois 6, 12, 18 et 24.",
        support: {
          fonction: "tresorerieChantier (branche jalons)",
          signature: "jalons : [{ libelle, avancement, part }]. L’avancement place le jalon dans le chantier, la part dit combien on appelle",
          code: "mois = Math.round(avancement * duree_chantier_mois) ; un jalon au-delà de la livraison y est ramené",
          referentiel: "tresorerie.jalons_vefa.jalons (barème légal VEFA, éditable en admin)",
          alimente: "la courbe de dépenses de l’écran Trésorerie",
          tests: "tests/tresorerie.test.js",
          source: "src/tresorerie.js:72",
          texte: "Les jalons d’avancement supérieur ou égal à 1 (réserves, conformité, garantie de parfait achèvement) sont ramenés au dernier mois : les ignorer ferait manquer environ 5 % du prix de revient. Plusieurs jalons de même rang s’additionnent sur le même mois."
        },
        piege: "Rien ne vérifie que les parts du barème somment à 100 %. Un barème incomplet fait que le total des dépenses n’atteint pas le coût révisé, sans erreur ni alerte. Sous barème, certains mois portent aussi une dépense nulle, ce qui n’arrive jamais à parts égales.",
        entrees: [
          [
            "Jalons",
            "Paramètres > Admin > Appels de fonds, tableau modifiable"
          ],
          [
            "Type d’opération",
            "écran Opération : les jalons ne s’appliquent qu’en VEFA"
          ],
          ["Durée du chantier", "écran Opération > Calendrier"]
        ]
      },
      {
        titre: "Tirer le prêt en une fois ou au fil de l’eau",
        regles: ["R-TRESO-4"],
        simple: "Deux façons de mobiliser les prêts pendant le chantier, et elles ne coûtent pas la même chose. Le tirage intégral encaisse tout le prêt dès le premier mois après l’ordre de service : la trésorerie est confortable, mais les intérêts courent sur la totalité pendant toute la durée du chantier. Le tirage au fil de l’eau n’appelle que ce dont on a besoin chaque mois : les intérêts intercalaires sont bien plus faibles, mais il faut suivre les appels. Les subventions, elles, sont toujours mobilisables dès l’ordre de service. Ce choix se règle dans les paramètres et change directement le montant des frais financiers.",
        formule: "mode intégral :\n  recette du mois 1 = montant total des prêts\n  recette des mois suivants = 0\n\nmode au fil de l’eau :\n  recette du mois M = dépense du mois M − subventions déjà perçues\n\nDans les deux cas :\n  subventions perçues intégralement au mois 0 (ordre de service)",
        support: {
          fonction: "tresorerieChantier (boucle des flux)",
          signature: "flux : [{ mois, date, depense_eur, recette_eur, solde_eur, cumul_eur }], un enregistrement par mois de chantier",
          code: "cumul += recette_eur - depense_eur   à chaque pas de la boucle mensuelle",
          referentiel: "tresorerie.mode_tirage : integral tire tout le prêt au premier mois, sinon au fil de l’eau",
          alimente: "le graphique et le tableau de l’écran Trésorerie",
          tests: "tests/tresorerie.test.js",
          source: "src/tresorerie.js:72",
          texte: "Le mode par défaut est `integral`. La branche au fil de l’eau se déclenche sur `mode_tirage !== \"integral\"` : toute valeur inconnue y bascule silencieusement. L’échéancier `tirages` produit ici est directement consommable par `prefinancement()`."
        },
        piege: "Subventions et fonds propres sont réputés mobilisables dès l’ordre de service, donc comptés avant la première dépense. C’est un arbitrage métier, pas une règle comptable.",
        entrees: [
          ["Mode de tirage", "Paramètres > Trésorerie > mode_tirage"],
          ["Montant des prêts", "plan de financement de l’opération"],
          ["Subventions", "écran de la tranche, mobilisables dès l’OS"]
        ]
      },
      {
        titre: "Le besoin de préfinancement",
        regles: ["R-TRESO"],
        simple: "Mois après mois, le moteur cumule ce qui sort et ce qui rentre. Le cumul devient négatif dès que les dépenses dépassent les recettes, et c’est ce creux qu’il faut financer. Le besoin maximal de préfinancement est le point le plus bas de cette courbe, pris en valeur absolue — c’est le montant qu’il faut avoir mobilisé pour ne jamais être à découvert. L’écran affiche aussi le mois où ce pic tombe, parce que c’est là que se joue la négociation du préfinancement. Ce besoin alimente ensuite directement le calcul des intérêts intercalaires.",
        formule: "cumul du mois M = cumul du mois M−1 + recettes M − dépenses M\nbesoin maximal = |MIN(tous les cumuls)|  si ce minimum est négatif, sinon 0\nmois du pic = le mois où ce minimum est atteint\n\nExemple :\n  mois  6 : cumul  −180 000 €\n  mois 12 : cumul  −420 000 €  ← pic\n  mois 18 : cumul  −310 000 €\n  mois 24 : cumul       0 €\n  besoin maximal = 420 000 €, atteint au mois 12",
        support: {
          fonction: "tresorerieChantier (indicateurs)",
          signature: "indicateurs : { besoin_maximal_eur, mois_du_pic, total_depenses_eur, total_recettes_eur }",
          code: "besoin_maximal_eur = le PIC du cumul négatif, pris en valeur absolue (un Math.min y avait renvoyé 0 sur toute opération normale)",
          referentiel: "aucun : dérivé des flux",
          alimente: "les tuiles de l’écran Trésorerie",
          tests: "tests/tresorerie.test.js",
          source: "src/tresorerie.js:72",
          texte: "Le mois du pic est le PREMIER à atteindre le maximum (comparaison stricte). Sans jalons ni indexation, le pic tombe toujours au dernier mois, le besoin cumulé étant croissant. `besoin_maximal_eur` est borné à zéro."
        },
        piege: "Le surcoût d’indexation affiché se compte par rapport au coût INITIAL : il inclut donc la révision de départ, et sera toujours supérieur à celle-ci.",
        entrees: [
          ["Dépenses mensuelles", "calculées aux étapes 1 et 2"],
          ["Recettes mensuelles", "calculées à l’étape 3"],
          ["Fonds propres", "écran de la tranche, mobilisables dès l’OS"]
        ]
      }
    ]
  },
  {
    id: "financement",
    titre: "Plan de financement",
    accroche: "Deux colonnes qui doivent s’égaler à l’euro près : d’un côté les emplois, ce que l’opération coûte ; de l’autre les ressources, ce qui la finance. L’écart entre les deux est toujours affiché, jamais absorbé en douce par une variable d’ajustement.",
    etapes: [
      {
        titre: "L’équilibre, et le sens de l’écart",
        regles: ["R-FIN-1"],
        simple: "Une opération est équilibrée quand ce qu’elle coûte est exactement couvert par ce qui la finance. Les ressources sont la somme de trois choses : les subventions, les fonds propres et les prêts. On les compare au prix de revient TTC. Le signe de l’écart se lit dans un sens précis : un écart positif signifie qu’on a mobilisé plus de ressources que nécessaire, un écart négatif qu’il manque de l’argent. Le moteur signale aussi si la part des prêts CDC descend sous le minimum réglementaire. Un écart d’un euro ou moins est de l’arrondi de présentation et n’est pas signalé.",
        formule: "ressources = subventions + fonds propres + prêts\nécart = ressources − prix de revient TTC\n\n  écart > 0 ...... surfinancement, il faut réduire une ressource\n  écart = 0 ...... équilibre\n  écart < 0 ...... reste à financer\n\nExemple, opération OP-4 :\n  prêts PLS ................ 1 978 651 €   (89,3 %)\n  subventions .............. 193 000 €     ( 8,7 %)\n  avance de trésorerie ..... 44 319 €      ( 2,0 %)\n                             ───────────\n  ressources ............... 2 215 970 €\n  prix de revient TTC ...... 2 215 970 €\n  écart .................... 0 € ✓",
        support: {
          fonction: "controleEquilibre",
          signature: "controleEquilibre({ prix_revient_ttc_module_eur, subventions_eur, fonds_propres_eur, prets_eur, prets_cdc_eur }, referentiels) → { ressources_eur, ecart_eur, alertes }",
          code: "ressources = subventions_eur + fonds_propres_eur + prets_eur ; ecart = arrondiEuro(ressources - prix_revient_ttc_module_eur)",
          referentiel: "constantes_reglementaires.quotite_cdc_min pour l’alerte de quotité",
          alimente: "le bandeau d’équilibre du plan de financement",
          tests: "tests/moteur.test.js",
          source: "src/financement.js:287",
          texte: "L’équilibre est jugé APRÈS arrondi à l’euro : un écart de 0,40 € est déclaré équilibré. Un second contrôle vérifie que les prêts CDC atteignent au moins 50 % du prix de revient (`controle_ratio_prets_cdc_min`), mais seulement si des prêts CDC existent."
        },
        piege: "Deux sources d’écart résiduel sont normales : l’arrondi au millier supérieur des prêts théoriques, qui peut surfinancer de près de 2 000 €, et un excédent de tranche que le moteur n’a pas su redistribuer.",
        entrees: [
          ["Prix de revient TTC", "calculé au chapitre Prix de revient"],
          ["Subventions", "écran de la tranche, ligne par ligne"],
          ["Fonds propres", "écran de la tranche"],
          [
            "Prêts",
            "écran de la tranche, saisis ou calculés en mode CDC théorique"
          ],
          ["Quotité CDC minimale", "Paramètres > Constantes réglementaires"]
        ]
      },
      {
        titre: "Le droit à prêt foncier",
        regles: ["R-FIN-2"],
        simple: "Le prêt foncier de la Caisse des Dépôts ne peut pas dépasser un plafond, et ce plafond n’est pas la charge foncière brute. La règle du prêteur : on part de la charge foncière, on en retire la part déjà couverte par les subventions, et on applique la quote-part de la tranche. Le point important est que la réduction se calcule sur l’opération ENTIÈRE, puis se répartit : une subvention fléchée sur une seule tranche réduit donc le droit à prêt foncier de toutes les tranches. C’est contre-intuitif mais c’est bien la formule de la calculette CDC, et c’est le prêteur qui fixe la règle de son propre prêt.",
        formule: "réduction = subventions totales ÷ prix de revient de l’opération\nfoncier finançable = charge foncière × (1 − réduction) × quote-part de la tranche\n\nExemple :\n  charge foncière ............ 800 000 €\n  subventions ................ 193 000 €\n  prix de revient opération .. 2 215 970 €\n  réduction .................. 193 000 ÷ 2 215 970 = 8,71 %\n  foncier finançable ......... 800 000 × 91,29 % = 730 320 €\n  (× quote-part si plusieurs tranches)",
        support: {
          fonction: "foncierFinancable",
          signature: "foncierFinancable({ charge_fonciere_eur, subventions_eur, prix_revient_operation_eur, quote_part_su }) → euros",
          code: "reduction = subventions_eur / prix_revient_operation_eur ; retour = charge_fonciere_eur * (1 - reduction) * quote_part_su",
          referentiel: "aucun : la formule est celle de la calculette CDC, feuille Construction cellule AT37",
          alimente: "pretsCDCTheoriques : plafonne le prêt foncier",
          tests: "tests/moteur.test.js",
          source: "src/financement.js:206",
          texte: "Arbitrage Q-30 du 06/08/2026 : ce sont TOUTES les subventions qui abattent, y compris la surcharge foncière, et non les seuls financements gratuits comme l’annonçait le dictionnaire. C’est le prêteur qui fixe la règle de son propre prêt, et la calculette CDC le confirme (Construction!AT37)."
        },
        piege: "Le calcul est GLOBAL puis réparti au prorata des surfaces utiles : une subvention fléchée sur une seule tranche réduit le droit à prêt foncier de toute l’opération, pas seulement celui de la tranche qui la reçoit.",
        entrees: [
          ["Charge foncière", "chapitre I du prix de revient"],
          [
            "Subventions totales",
            "toutes les subventions du plan, gratuites ou non (arbitrage Q-30)"
          ],
          ["Prix de revient de l’opération", "toutes tranches confondues"],
          ["Quote-part de surface utile", "calculée au chapitre Surfaces"]
        ]
      },
      {
        titre: "Les prêts CDC théoriques",
        regles: ["R-FIN-4"],
        simple: "Quand vous ne saisissez aucun prêt, le moteur les calcule pour vous. Il part du solde à financer — le prix de revient moins tout ce qui n’est pas du prêt — puis le partage en deux : un prêt foncier, plafonné au droit calculé à l’étape précédente, et un prêt travaux qui prend le reste. Le préfinancement se retranche du prêt travaux, puisqu’il a déjà servi à couvrir une partie du besoin. Vous pouvez forcer l’un ou l’autre montant, et une option arrondit les prêts au millier supérieur, comme le fait le prêteur.",
        formule: "solde à financer = prix de revient TTC − subventions − fonds propres − autres prêts\n\nprêt foncier  = MIN(solde à financer ; foncier finançable)\nprêt travaux  = solde à financer − préfinancement − prêt foncier\n\n(les deux sont bornés à zéro, et arrondis au millier supérieur si l’option est active)\n\nExemple :\n  prix de revient TTC ........ 2 215 970 €\n  − subventions .............. 193 000 €\n  − fonds propres ............ 44 319 €\n  = solde à financer ......... 1 978 651 €\n  foncier finançable ......... 606 891 €\n  → prêt foncier ............. 606 891 €\n  → prêt travaux ............. 1 371 760 €",
        support: {
          fonction: "soldeAFinancer, pretsCDCTheoriques",
          signature: "soldeAFinancer({ prix_revient_ttc_module_eur, subventions_eur, fonds_propres_eur, autres_prets_eur }) → euros · pretsCDCTheoriques({ solde_eur, foncier_financable_eur, prefinancement_eur, arrondir_milliers, pret_foncier_force_eur, pret_batiment_force_eur }) → { foncier_eur, batiment_eur }",
          code: "foncier = Math.max(0, Math.min(solde_eur, foncier_financable_eur)) ; batiment = solde_eur - prefinancement_eur - foncier",
          referentiel: "options.arrondir_prets_milliers_sup",
          alimente: "tableauAmortissement, quand aucun prêt n’est saisi (mode CDC théorique)",
          tests: "tests/moteur.test.js",
          source: "src/financement.js:24 et 245",
          texte: "Option `arrondir_milliers` (SimPLUS!AR26) : chaque prêt est arrondi au millier SUPÉRIEUR, d’où un surfinancement possible de près de 2 000 € sur les deux. Des montants forcés court-circuitent le bornage ET l’arrondi. L’option PLUS Horizen n’est pas implémentée (Q-12, hors périmètre V1)."
        },
        piege: "Les intérêts de préfinancement sont déduits du seul prêt bâtiment, jamais du foncier.",
        entrees: [
          [
            "Mode de prêts",
            "écran de la tranche : saisis, ou CDC théoriques"
          ],
          ["Foncier finançable", "calculé à l’étape précédente"],
          ["Préfinancement", "calculé au chapitre Prêts"],
          ["Arrondi au millier", "option de la simulation"]
        ]
      },
      {
        titre: "Les quotités réglementaires",
        regles: ["R-FIN-5", "R-FIN-8", "R-FIN-9"],
        simple: "Deux quotités encadrent les prêts, et elles ne se comportent pas pareil. Pour le PLS, la Caisse des Dépôts impose une fourchette de 51 à 55 % du prix de revient. Au-dessus de 55 %, le surplus bascule automatiquement en CPLS, un prêt complémentaire. En dessous de 51 %, le moteur lève une alerte mais ne corrige rien : c’est un choix de montage qui vous appartient. Pour le logement intermédiaire, la règle est un plafond simple : l’ensemble des prêts ne peut dépasser 90 % du prix de revient de la tranche, le solde devant venir en fonds propres ou en subventions. Le dépassement est chiffré et signalé.",
        formule: "PLS :\n  plafond = 55 % × prix de revient de la tranche\n  plancher = 51 % × prix de revient de la tranche\n  si PLS > plafond  →  PLS = plafond, et CPLS = PLS saisi − plafond\n  si PLS < plancher →  alerte, aucune correction\n\nLLI :\n  plafond = 90 % × prix de revient de la tranche\n  si total des prêts > plafond → dépassement chiffré et signalé\n\nExemple, tranche PLS de 2 000 000 € financée à 1 200 000 € :\n  55 % = 1 100 000 € → PLS = 1 100 000 €, CPLS = 100 000 €",
        support: {
          fonction: "scinderPLS, plafondPretsLLI",
          signature: "scinderPLS({ montant_pls_eur, prix_revient_eur, plafond = 0.55, plancher = 0.51 }) → { pls_eur, cpls_eur, alerte } · plafondPretsLLI({ total_prets_eur, prix_revient_eur, plafond = 0.9 })",
          code: "au-delà du plafond le surplus bascule en CPLS ; sous le plancher une alerte est levée sans rien corriger",
          referentiel: "valeurs par défaut portées par la signature elle-même, surchargeables par la saisie",
          alimente: "le plan de financement et ses alertes",
          tests: "tests/moteur.test.js",
          source: "src/financement.js:55 et 89",
          texte: "Q-15 et Q-33, closes le 06/08/2026. Le plafond se corrige, le plancher s’alerte. L’excès PLS se prélève d’abord sur le prêt construction, puis sur le foncier. Le plafond LLI porte sur TOUS les prêts de la tranche, y compris hors CDC (contrôle AT32 de la calculette)."
        },
        piege: "Le contrôle de 50 % de l’équilibre et le plancher PLS de 51 % sont deux règles DIFFÉRENTES : le premier est un ratio global sur l’ensemble des prêts CDC, le second est propre au PLS de sa tranche. Leurs valeurs proches prêtent à confusion.",
        entrees: [
          [
            "Fourchette PLS 51-55 %",
            "calculette CDC production LS, guide d’utilisation"
          ],
          ["Plafond LLI 90 %", "règle du produit intermédiaire"],
          [
            "Prix de revient de la tranche",
            "calculé au chapitre Prix de revient"
          ]
        ]
      },
      {
        titre: "Le redressement des tranches surfinancées",
        regles: ["R-FIN-3"],
        simple: "Quand plusieurs tranches se partagent une opération, il arrive qu’une tranche se retrouve surfinancée et une autre sous-financée, simplement parce que les subventions et les fonds propres ne se répartissent pas selon la même clé que les dépenses. Le redressement remet chaque besoin au prorata de la quote-part de surface utile de sa tranche, pour qu’aucune ne porte plus que sa part. Sans cela, on obtiendrait des prêts théoriques négatifs sur une tranche et excessifs sur l’autre.",
        formule: "besoin redressé d’une tranche = besoin total de l’opération × quote-part de surface utile\n\nExemple, besoin total 1 000 000 €, opération 30 % PLAI / 70 % PLUS :\n  PLAI ... 300 000 €\n  PLUS ... 700 000 €\n\n(et non le besoin brut de chaque tranche, qui pourrait être négatif)",
        support: {
          fonction: "redresserBesoins",
          signature: "redresserBesoins(besoins, quotesParts) → besoins redressés par tranche",
          code: "chaque besoin est ramené au prorata de la quote-part de surface utile de sa tranche",
          referentiel: "aucun : les quotes-parts viennent de quotesPartsSU",
          alimente: "pretsCDCTheoriques, tranche par tranche",
          tests: "tests/moteur.test.js",
          source: "src/financement.js:181",
          texte: "La borne de trois tours reprend celle de la calculette CDC. Si aucune tranche positive ne subsiste, l’excédent reste acquis à l’opération et ressort en surfinancement dans le contrôle d’équilibre."
        },
        entrees: [
          ["Besoins par tranche", "solde à financer de chaque tranche"],
          ["Quotes-parts", "calculées au chapitre Surfaces"]
        ]
      },
      {
        titre: "Les fonds propres ont un coût",
        regles: ["R-FIN-7"],
        simple: "Les fonds propres ne sont pas gratuits. Dans un montage en redevance, on les apporte sous forme d’avance de trésorerie rémunérée : l’organisme se paie un intérêt sur l’argent qu’il a immobilisé, et il reconstitue le capital sur une durée donnée. Le calcul est exactement celui d’un prêt : une annuité constante qui rembourse le capital et sert l’intérêt sur la durée de reconstitution. Cette annuité entre dans les charges du compte d’exploitation, au même titre qu’une annuité de prêt. Quand le taux est nul, l’annuité est simplement le capital divisé par la durée.",
        formule: "annuité = capital × taux ÷ (1 − (1 + taux) ^ −durée)\nsi taux = 0 :\n  annuité = capital ÷ durée\n\nExemple, opération OP-4 :\n  avance de trésorerie ....... 44 318,74 €\n  taux de rémunération ....... 2,50 %\n  durée de reconstitution .... 30 ans\n  annuité .................... 44 318,74 × 2,5 % ÷ (1 − 1,025^−30)\n                             = 2 117,44 € par an pendant 30 ans",
        support: {
          fonction: "annuiteFondsPropres",
          signature: "annuiteFondsPropres({ montant_eur, taux = 0, duree_ans = 0 }) → euros par an",
          code: "annuite = (montant_eur * taux) / (1 - (1 + taux) ** -duree_ans)   — taux nul : montant / durée",
          referentiel: "fonds_propres.remuneration.taux et .duree_reconstitution_ans",
          alimente: "compteExploitation : charge d’annuité de fonds propres",
          tests: "tests/moteur.test.js, tests/golden_agde_foyer.test.js",
          source: "src/financement.js:131",
          texte: "Le taux n’est retenu que si `remuneres === true`, la durée que si `reconstitues === true` (comparaisons strictes) : un taux saisi sans cocher la case est ignoré silencieusement."
        },
        piege: "Une durée de zéro ne veut pas dire « durée nulle » mais « pas de reconstitution » : la charge devient un intérêt perpétuel, pas une division par zéro.",
        entrees: [
          [
            "Montant des fonds propres",
            "écran de la tranche, 2 % du prix de revient en redevance, 5 % en loyers"
          ],
          [
            "Taux de rémunération",
            "Paramètres > Fonds propres > remuneration.taux"
          ],
          [
            "Durée de reconstitution",
            "Paramètres > Fonds propres, 30 ans par défaut"
          ]
        ]
      },
      {
        titre: "Subventions et surcharge foncière",
        regles: ["R-SUB-1", "R-SUB-2", "R-SUB-3"],
        simple: "Une subvention affectée à une tranche lui revient en totalité. Une subvention non affectée se répartit entre les tranches au prorata de leur surface utile, comme n’importe quelle ressource commune. Le moteur distingue par ailleurs les subventions dites gratuites, qui n’appellent aucune contrepartie, des autres. La surcharge foncière est un cas à part : c’est une subvention destinée à compenser un foncier anormalement cher, plafonnée selon la zone et selon l’écart entre le prix du terrain et une valeur de référence.",
        formule: "subvention affectée .... → intégralement à sa tranche\nsubvention non affectée  → × quote-part de surface utile de chaque tranche\n\ntotal des subventions = Σ affectées + Σ non affectées réparties\n\nExemple :\n  AGGLO 48 000 € affectée au PLS ........ PLS : 48 000 €\n  État 100 000 € non affectée ........... PLAI : 20 000 € · PLUS : 80 000 €\n  (opération 20 % PLAI / 80 % PLUS)",
        support: {
          fonction: "agregerSubventions, surchargeFonciere",
          signature: "agregerSubventions(subventions, quotes_parts) → { total_eur, par_tranche, gratuites_eur } · surchargeFonciere(...) → droit à surcharge foncière",
          code: "une subvention affectée va entière à sa tranche ; sans affectation elle se répartit au prorata des quotes-parts",
          referentiel: "subventions.ssf et ses plafonds par zone",
          alimente: "soldeAFinancer et foncierFinancable",
          tests: "tests/moteur.test.js",
          source: "src/subventions.js:30 et 82",
          texte: "Le plafond se resserre quand les collectivités participent PEU : sous 40 % du dépassement, on retient le plus petit des deux plafonds. Une affectation « PLUS-PLAI » n’est pas reconnue comme une clé de produit et se ventile donc sur TOUS les produits présents, contrairement à ce que laisse entendre la JSDoc."
        },
        piege: "Le coefficient de 2 en neuf n’est pas un pourcentage : la subvention vaut deux fois le dépassement plafonné. Et le plafonnement joue à l’inverse de l’intuition, c’est quand les collectivités participent peu qu’il se resserre.",
        entrees: [
          [
            "Subventions",
            "écran de la tranche, avec libellé, montant et affectation"
          ],
          ["Quotes-parts", "calculées au chapitre Surfaces"],
          [
            "Plafonds de surcharge foncière",
            "Paramètres > Subventions, par zone"
          ]
        ]
      },
      {
        titre: "Fiscalité : exonération et taxe d’aménagement",
        regles: ["R-FISC-1", "R-FISC-2"],
        simple: "Le logement social neuf est exonéré de taxe foncière sur les propriétés bâties pendant 25 ans à compter de la mise en location. La 26e année, la taxe entre en charge d’un coup dans le compte d’exploitation, et le saut est brutal : la ligne quadruple, parce que jusque-là elle ne portait que la taxe d’enlèvement des ordures ménagères. Le moteur compte les 25 ans à partir de l’année de mise en location, conformément au CGI. À noter que la matrice LEON est incohérente sur ce point : elle en compte 26 sur l’opération de OP-3 et 25 sur celle d’OP-4. C’est la règle du CGI qui a été retenue. La taxe d’aménagement, elle, se paie une fois, au moment du permis, et entre au prix de revient.",
        formule: "année d’entrée en TFPB = année de mise en location + durée d’exonération\n\nExemple, mise en location en 2026 :\n  2026 + 25 = 2051  →  première année taxée\n  de 2026 à 2050, seule la TEOM est due\n\nDurées par produit :\n  logement social (PLAI, PLUS, PLS) ... 25 ans (CGI art. 1384 A)\n  logement intermédiaire .............. 20 ans (CGI art. 1384-0 A)\n  logement libre ...................... 0 an",
        support: {
          fonction: "exonerationTFPB, taxeAmenagement",
          signature: "exonerationTFPB({ annee_mise_en_location, duree_exoneration_ans }, referentiels) → { annee_debut_tfpb, duree_exoneration_ans }",
          code: "annee_debut_tfpb = annee_mise_en_location + duree",
          referentiel: "constantes_reglementaires.tfpb.duree_exoneration_defaut_ans (25) · taxe_amenagement.valeur_forfaitaire et ses taux",
          alimente: "compteExploitation : l’année où la taxe foncière entre en charge",
          tests: "tests/moteur.test.js, tests/golden_agde_foyer.test.js",
          source: "src/fiscalite.js:26 et 51",
          texte: "La durée est une propriété du PRODUIT (Q-14, close) : elle s’applique tranche par tranche via une série annuelle, une opération mixte n’ayant pas UNE fin d’exonération. Valeurs forfaitaires : 892 €/m² hors Île-de-France, 1 011 € en Île-de-France, lues au référentiel et non codées en dur."
        },
        piege: "L’abattement de 50 % ne porte que sur la surface de plancher, jamais sur le forfait par place de stationnement. Et si les taux de la commune et du département ne sont pas saisis, la taxe ressort à zéro alors que son assiette ne l’est pas.",
        entrees: [
          ["Année de mise en location", "calculée au calendrier"],
          [
            "Durée d’exonération",
            "propriété du produit, dans produits.js ; une durée saisie sur la simulation prime"
          ],
          [
            "Montant de TFPB",
            "Paramètres > Charges d’exploitation, 345 €/logement par défaut"
          ],
          [
            "Taxe d’aménagement",
            "Paramètres > Fiscalité, valeur forfaitaire et taux communal"
          ]
        ]
      }
    ]
  },
  {
    id: "exploitation",
    titre: "Compte d’exploitation",
    accroche: "Cinquante à soixante exercices déroulés année par année. Chaque poste porte sa propre trajectoire d’indexation, et aucune n’est figée dans le code : ce sont des données. Le compte produit deux soldes qui ne disent pas la même chose, et les confondre est l’erreur de lecture la plus fréquente.",
    etapes: [
      {
        titre: "L’ordre d’une année",
        regles: ["R-EXP"],
        simple: "Chaque année du compte se calcule dans un ordre qui n’est pas négociable, parce que certaines charges dépendent des produits et que les produits, en mode transparence, dépendent des charges. Le moteur commence donc par ce qui ne dépend de rien : les annuités de prêts, la taxe foncière, le gros entretien, les charges au forfait. Il calcule ensuite les produits — loyers ou redevance — desquels il retire la vacance et les impayés. Il peut alors calculer les charges assises sur ces produits : les frais de gestion quand ils sont en pourcentage des loyers, les cotisations CGLLS et ANCOLS. Vient l’impôt sur les sociétés, qui a besoin du résultat. Et enfin les deux soldes.",
        formule: "Ordre de calcul d’une année :\n\n  1. charges fixes ...... annuités + TFPB + TEOM + gros entretien + assurance\n  2. produits bruts ..... loyers (ou redevance) + annexes + divers\n     produits nets ...... produits bruts × (1 − taux de vacance et impayés)\n  3. charges assises .... frais de gestion en % + CGLLS + ANCOLS\n     (calculées sur les produits, donc après l’étape 2)\n  4. impôt .............. taux × MAX(0 ; résultat fiscal)\n  5. soldes ............. autofinancement, puis résultat comptable\n\nExemple, année 2 d’OP-4 :\n  redevance ............... 101 504 €\n  − annuités .............. 84 779 €\n  − TFPB et TEOM .......... 1 957 €\n  − assurance ............. 304 €\n  − frais de structure .... 2 075 €\n  = autofinancement ....... 12 389 €",
        support: {
          fonction: "compteExploitation",
          signature: "compteExploitation(e) → { lignes, indicateurs }. lignes : une par année, chacune portant produits, charges, annuités et soldes",
          code: "boucle sur duree_ans depuis annee_mise_en_location ; chaque poste passe par facteurIndexation avant d’entrer dans les totaux",
          referentiel: "charges_exploitation.postes · trajectoires · impot_societes · amortissement_comptable",
          alimente: "l’écran Exploitation et tous ses indicateurs",
          tests: "tests/exploitation.test.js, tests/golden.test.js",
          source: "src/exploitation.js:113",
          texte: "La liste des charges diverses est parcourue DEUX fois : une première passe sépare ce qui est chiffrable sans connaître les produits (`chargesFixes`, qui ne sert qu’au socle de transparence) d’un taux à appliquer plus tard ; la seconde recalcule tout et produit la valeur publiée."
        },
        piege: "Les arrondis à l’euro ne sont posés qu’à la sortie de chaque ligne. Tous les enchaînements internes, y compris le cumul d’autofinancement d’une année sur l’autre, travaillent en pleine précision.",
        entrees: [
          [
            "Annuités",
            "calculées au chapitre Prêts, agrégées sur tous les prêts de la tranche"
          ],
          [
            "Taux de vacance et impayés",
            "Paramètres > Hypothèses d’exploitation"
          ],
          [
            "Postes de charges",
            "Paramètres > Charges d’exploitation, activés par la saisie"
          ],
          [
            "Durée de simulation",
            "écran Opération > Calendrier, 50 à 60 ans"
          ]
        ]
      },
      {
        titre: "L’indexation par trajectoire",
        regles: ["R-EXP"],
        simple: "Aucun montant du compte d’exploitation n’est constant sur soixante ans. Chaque poste suit sa propre trajectoire d’indexation, année par année : les loyers suivent l’IRL, les frais de gestion leur propre indice, la taxe foncière le sien. Le moteur multiplie donc le montant de la première année par le produit des taux de toutes les années écoulées depuis. Un point à connaître : une année absente de la trajectoire reconduit le dernier taux connu, elle ne remet pas l’indexation à zéro. C’est ce qui permet de saisir une trajectoire détaillée sur dix ans puis de laisser le moteur prolonger.",
        formule: "montant de l’année N = montant de l’année 1 × Π (1 + taux de chaque année écoulée)\n\nExemple, redevance de 101 504 € en 2027, trajectoire +1,7 % puis +1,8 % :\n  2028 ... 101 504 × 1,017 = 103 229 €\n  2029 ... 103 229 × 1,017 = 104 984 €\n  2030 ... 104 984 × 1,018 = 106 874 €\n  2031 ... 106 874 × 1,018 = 108 798 €   (le 1,8 % se reconduit)",
        support: {
          fonction: "facteurIndexation, adapterTrajectoires",
          signature: "facteurIndexation(trajectoire, annee_debut, annee) → facteur multiplicatif. trajectoire : un taux constant, ou un dictionnaire année → taux",
          code: "pour a de annee_debut+1 à annee : si trajectoire[a] existe il devient le taux courant, puis f *= 1 + taux. Une année absente reconduit le dernier taux connu",
          referentiel: "trajectoires.par_annee.ANNEE.POSTE",
          alimente: "chaque poste indexé du compte d’exploitation",
          tests: "tests/exploitation.test.js",
          source: "src/exploitation.js:34 et src/trajectoires.js:56",
          texte: "Quatre clés seulement sont consommées en dur : `loyers_irl`, `gestion`, `gros_entretien`, `tfpb`. Les autres postes de la liste (rel, vacance_impayes, crl…) ne le sont que via le champ `index` d’une charge diverse. Le REL est indexé par `gestion`, pas par une trajectoire `rel`."
        },
        piege: "La reconduction ne fonctionne que VERS L’AVANT. Si les premières années suivant la mise en location manquent dans la table, elles sont indexées à 0 % et non au premier taux connu. Et une clé mal orthographiée donne un facteur 1, sans alerte.",
        entrees: [
          [
            "Trajectoires par poste",
            "Paramètres > Trajectoires macro, année par année"
          ],
          [
            "Montant de l’année 1",
            "loyer calculé, redevance saisie, ou valeur de barème du poste"
          ],
          ["Année de départ", "année de mise en location"]
        ]
      },
      {
        titre: "Les six assiettes de charges",
        regles: ["R-EXP"],
        simple: "Un poste de charge n’est pas codé en dur dans le moteur : il est décrit par une assiette, une valeur et une trajectoire d’indexation, et le moteur ne connaît que les assiettes. Il y en a six. Par logement : une valeur en euros multipliée par le nombre de logements, c’est le cas de la TEOM à 117 € et de l’assurance à 75 €. Par m² de surface habitable : le gros entretien. En pourcentage des produits bruts : les cotisations, avant vacance. En pourcentage des produits nets : après vacance. En pourcentage du prix de revient TTC : les frais de gestion. En forfait : un montant annuel indépendant du programme. Ajouter un poste ne demande donc pas de toucher au code. Important : aucun poste du catalogue n’est actif par défaut, c’est votre saisie qui l’active.",
        formule: "selon l’assiette du poste :\n\n  logement ................. montant = valeur × nombre de logements\n  shab ..................... montant = valeur × surface habitable\n  produits_locatifs_bruts .. montant = taux × produits avant vacance\n  produits_locatifs_nets ... montant = taux × produits après vacance\n  prix_revient_ttc ......... montant = taux × prix de revient TTC\n  forfait .................. montant = valeur\n\npuis, dans tous les cas :\n  montant de l’année N = montant × facteur d’indexation\n\nCatalogue livré :\n  TEOM ................ 117 €/logement\n  Assurance PNO ....... 75 €/logement\n  CGLLS ............... 0,34 % des produits bruts\n  ANCOLS .............. taux des produits bruts\n  Frais de structure .. par logement",
        support: {
          fonction: "resoudreChargesExploitation",
          signature: "resoudreChargesExploitation(saisie = [], baremes = {}) → [{ code, libelle, assiette, valeur, index, annee_debut, annee_fin }]",
          code: "la saisie ACTIVE un poste du catalogue ; aucun poste du référentiel n’est actif par défaut, sans quoi ajouter un poste changerait toutes les simulations",
          referentiel: "charges_exploitation.postes : le catalogue, chaque poste décrit par assiette / valeur / index",
          alimente: "compteExploitation : la liste des charges diverses de chaque année",
          tests: "tests/exploitation.test.js",
          source: "src/exploitation.js:667",
          texte: "Une septième voie existe hors typedef : `montants_par_annee`, dictionnaire année → montant qui prime sur tout, assiette comprise, et ne s’indexe pas. C’est la réponse à Q-20, la colonne « autres dépenses » de LEON faite de 51 valeurs saisies sans formule. Une assiette inconnue lève une erreur en première passe."
        },
        piege: "Aucun poste n’est actif par défaut : c’est la saisie qui les active. Sans quoi ajouter un poste au référentiel changerait le résultat de toutes les simulations existantes.",
        entrees: [
          [
            "Catalogue des postes",
            "Paramètres > Charges d’exploitation > postes"
          ],
          [
            "Activation",
            "écran de la tranche : un poste non coché n’est pas appliqué"
          ],
          [
            "Bornes de période",
            "année de début et de fin, pour un poste temporaire"
          ]
        ]
      },
      {
        titre: "Les trois assiettes des frais de gestion",
        regles: ["R-EXP"],
        simple: "Les frais de gestion peuvent se calculer de trois façons, et le choix change beaucoup le résultat. En pourcentage du prix de revient TTC : c’est la règle retenue, 0,3 % du prix de revient, ce que fait réellement LEON. En pourcentage des loyers : une commission sur les recettes. En forfait par logement : un montant fixe. Le point de confusion vient de ce que LEON AFFICHE les frais de gestion en euros par logement — 415,49 € par lot sur l’opération d’OP-4 — mais ne les CALCULE jamais ainsi : c’est 0,3 % du prix de revient divisé par le nombre de lots. C’est un coût de structure rapporté à la taille de l’opération, pas une commission sur les recettes.",
        formule: "assiette prix de revient (retenue) :\n  frais de gestion = 0,3 % × prix de revient TTC × facteur d’indexation\n\nassiette loyers :\n  frais de gestion = taux × produits locatifs\n\nassiette forfait :\n  frais de gestion = valeur × nombre de logements\n\nExemple, OP-4, 16 lots, prix de revient 2 215 969,74 € :\n  0,003 × 2 215 969,74 = 6 647,91 € pour l’opération\n  6 647,91 ÷ 16 = 415,49 € par lot  ← la valeur affichée par LEON",
        support: {
          fonction: "compteExploitation (fraisGestionForfait puis arbitrage final)",
          signature: "trois assiettes possibles : % du prix de revient TTC, % des loyers, forfait par logement",
          code: "frais_gestion_pct_prix_revient > 0 ? taux * prix_revient_ttc_eur * index : frais_gestion_annuels_eur * nb_logements * index",
          referentiel: "charges_exploitation.frais_gestion_pct_prix_revient (0,003) · .frais_gestion_annuels_eur",
          alimente: "les charges du compte d’exploitation",
          tests: "tests/exploitation.test.js, tests/golden_agde_foyer.test.js (question Q-17)",
          source: "src/exploitation.js:311 et 493",
          texte: "Q-17, close le 11/08/2026 sur les matrices BOURGES, CHAMBERY et OP-4. La variante en % des loyers n’est PAS multipliée par l’indice de gestion : son indexation vient de celle des loyers. Les trois assiettes ne suivent donc pas la même inflation."
        },
        piege: "Les tests de sélection portent sur « strictement positif » : un taux à zéro fait basculer sur l’assiette suivante. Il n’est donc pas possible de forcer des frais de gestion nuls par un taux à zéro.",
        entrees: [
          [
            "Taux de 0,3 %",
            "Paramètres > Charges d’exploitation > frais_gestion_pct_prix_revient"
          ],
          ["Prix de revient TTC", "calculé au chapitre Prix de revient"],
          ["Nombre de logements", "écran Programme"]
        ]
      },
      {
        titre: "Redevance forfaitaire ou en transparence",
        regles: ["R-EXP-7"],
        simple: "Un foyer ne perçoit pas un loyer au m² mais une redevance, et il y a deux façons de la fixer. La redevance forfaitaire est un montant négocié : vous le saisissez pour la première année et il s’indexe ensuite, sans aucun lien avec les charges. C’est le cas des opérations d’OP-4 et de OP-5. La redevance en transparence, au contraire, se recompose depuis les charges : on refacture au gestionnaire ce que l’opération coûte. Le calcul est alors circulaire, puisque certaines charges se calculent en pourcentage des produits — donc de la redevance qu’on cherche. Le moteur résout cette circularité par une formule fermée, il n’itère pas.",
        formule: "redevance forfaitaire :\n  redevance de l’année N = montant saisi × facteur d’indexation\n\nredevance en transparence :\n  socle .... = annuités + TFPB + gros entretien + charges fixes\n  k ........ = somme des taux assis sur les produits\n  redevance = quote-part × (socle + k × produits connus)\n              ÷ (1 − quote-part × k)\n\nLa division par (1 − quote-part × k) est la résolution de la circularité :\nsans elle, il faudrait itérer jusqu’à convergence.",
        support: {
          fonction: "compteExploitation (blocs redevanceForfait et redevanceTransparence)",
          signature: "mode : loyers ou redevance · mode_redevance : forfaitaire ou transparence",
          code: "transparence : num = quotePart * (socle + k * connus - tauxNets * vacance * connus) ; den = 1 - quotePart * k ; redevance = num / den",
          referentiel: "regimes_par_produit.PRODUIT.mode et .mode_redevance",
          alimente: "les produits du compte d’exploitation, à la place des loyers",
          tests: "tests/exploitation.test.js, tests/golden_agde_foyer.test.js",
          source: "src/exploitation.js:380 et 443",
          texte: "Q-27, largement close. La forme fermée résout R = Q × (C₀ + k·(L+R) − tauxNets·v·L). Le socle n’inclut PAS l’impôt sur les sociétés, calculé après et donc jamais refacturé. Si le dénominateur devient négatif ou nul, le moteur retombe silencieusement sur quote-part × socle : la valeur publiée n’est alors plus la solution de l’équation."
        },
        piege: "La vacance et les impayés ne s’appliquent PAS à la part en transparence : le gestionnaire doit ces frais que les places soient occupées ou non. La redevance forfaitaire, elle, y est bien soumise.",
        entrees: [
          [
            "Mode de redevance",
            "écran de la tranche : forfaitaire ou transparence"
          ],
          [
            "Montant de l’année 1",
            "écran de la tranche, saisi en forfaitaire"
          ],
          [
            "Quote-part de transparence",
            "part des charges refacturée, 100 % en transparence totale"
          ],
          ["Trajectoire d’indexation", "Paramètres > Trajectoires macro"]
        ]
      },
      {
        titre: "Un régime par tranche",
        regles: ["R-EXP-7"],
        simple: "Une opération peut mélanger les régimes : une tranche en loyers classiques et une tranche de foyer en redevance, dans le même compte d’exploitation. Chaque tranche déclare donc son régime, et le compte agrège. La quote-part de surface utile joue ici un rôle précis : elle dit quelle part des charges communes une tranche en transparence refacture. Une tranche en transparence à 40 % de la surface utile ne refacture que 40 % des annuités et de la taxe foncière, le reste restant à la charge de l’organisme.",
        formule: "produits totaux de l’année = Σ sur les tranches :\n  si mode = loyers      → loyer annuel indexé\n  si mode = redevance   → redevance forfaitaire ou en transparence\n\nla quote-part de la tranche pondère les charges qu’elle refacture\n\nExemple, opération mixte :\n  tranche PLUS (60 % SU) en loyers ....... 95 904 €\n  tranche FPLS (40 % SU) en redevance .... 68 000 €\n  produits totaux ........................ 163 904 €",
        support: {
          fonction: "compteExploitation (bloc tranches_produits)",
          signature: "produits_par_tranche : [{ code, mode, mode_redevance, redevance_annuelle_eur, loyers_annuels_eur, quote_part }]",
          code: "une tranche en loyers et une tranche en redevance coexistent : chacune apporte ses produits, la quote-part dit quelle part des charges la transparence refacture",
          referentiel: "regimes_par_produit",
          alimente: "le total des produits de chaque année",
          tests: "tests/exploitation.test.js",
          source: "src/exploitation.js:414",
          texte: "Dès que la liste par tranche est non vide, elle écrase complètement les entrées globales de mode et de redevance. Toute valeur de `mode` autre que la chaîne exacte `redevance` est traitée comme des loyers."
        },
        piege: "Bascule de comportement à connaître : en mode global foyer, les loyers d’annexes et les loyers divers sont annulés ; en mode par tranche, ils sont toujours comptés, même si toutes les tranches sont en redevance.",
        entrees: [
          [
            "Régime par tranche",
            "écran de la tranche, interrupteur loyer / redevance"
          ],
          ["Quotes-parts", "calculées au chapitre Surfaces"]
        ]
      },
      {
        titre: "L’impôt sur les sociétés",
        regles: ["R-EXP-4"],
        simple: "Le logement social conventionné relève du service d’intérêt général et n’est pas soumis à l’impôt sur les sociétés. Le logement intermédiaire, lui, l’est. C’est donc une propriété des produits présents au programme, pas un réglage d’opération : une seule tranche imposable suffit à rendre l’impôt dû. Le calcul part du résultat comptable, retire les charges déductibles et les dotations aux amortissements, et applique le taux. Un résultat négatif ne génère pas d’impôt négatif : l’impôt est borné à zéro. Des crédits d’impôt de taxe foncière peuvent venir en déduction sur les premières années.",
        formule: "soumis à l’IS = VRAI si au moins un produit du programme y est soumis\n\nrésultat fiscal = produits − charges déductibles − dotations aux amortissements\nimpôt = taux × MAX(0 ; résultat fiscal) − crédits d’impôt\n\nExemple :\n  résultat fiscal .... 40 000 €\n  taux ............... 25 %\n  impôt .............. 10 000 €\n\n  résultat fiscal .... −15 000 €\n  impôt .............. 0 €   (jamais négatif)",
        support: {
          fonction: "compteExploitation (bloc IS)",
          signature: "soumis_is se déduit des produits présents au programme, sauf si la saisie tranche explicitement",
          code: "resultat_fiscal = produits - charges déductibles - dotations ; impot = taux * Math.max(0, resultat_fiscal)",
          referentiel: "impot_societes.taux, .produits_soumis, .part_fixe_gros_entretien, .credit_impot_tfpb_lli",
          alimente: "le solde après impôt et l’autofinancement",
          tests: "tests/exploitation.test.js",
          source: "src/exploitation.js:517",
          texte: "Absence de report déficitaire calée sur ParaGEN!GD30 = NON. Une clé inconnue dans la liste des déductibles est silencieusement ignorée, ce qui gonfle l’impôt sans signal. Attention : `gros_entretien` et `part_fixe_gros_entretien` sont deux clés distinctes, les lister toutes deux déduit deux fois."
        },
        piege: "L’assiette part des loyers NETS, pas des produits totaux : la quote-part de subventions et les produits financiers n’y entrent pas. Et l’impôt est traité comme une charge ordinaire, il pèse donc sur les deux soldes.",
        entrees: [
          [
            "Produits soumis",
            "Paramètres > Impôt sur les sociétés > produits_soumis"
          ],
          ["Taux d’IS", "Paramètres > Impôt sur les sociétés > taux"],
          [
            "Part fixe de gros entretien",
            "Paramètres > Impôt sur les sociétés, part déductible"
          ],
          [
            "Crédits d’impôt TFPB",
            "Paramètres > Impôt sur les sociétés, pour le logement intermédiaire"
          ]
        ]
      },
      {
        titre: "Les deux soldes",
        regles: ["R-EXP-2"],
        simple: "Le compte produit deux soldes qui ne disent pas la même chose et qu’il ne faut pas confondre. L’autofinancement est un solde de TRÉSORERIE : ce qui reste en caisse une fois les recettes encaissées et les charges payées, annuités comprises. C’est lui qui dit si l’opération tient financièrement. Le résultat comptable est un solde de COMPTABILITÉ : il ignore le remboursement du capital, qui n’est pas une charge, mais il intègre la dotation aux amortissements, qui n’est pas un décaissement. Une opération peut très bien afficher un autofinancement positif et un résultat comptable négatif pendant des années : c’est même le cas normal du logement social neuf.",
        formule: "autofinancement = produits − charges (annuités comprises)\ncumul = cumul de l’année précédente + autofinancement\n\nrésultat comptable = produits\n                   − charges hors remboursement de capital\n                   − dotation aux amortissements\n                   + quote-part de subventions virée au résultat\n\nExemple, année 2 d’OP-4 :\n  autofinancement ....... +12 389 €   (la trésorerie tient)\n  résultat comptable .... −15 588 €   (les amortissements pèsent)",
        support: {
          fonction: "compteExploitation (bloc des soldes)",
          signature: "chaque ligne porte total_produits_eur, total_charges_eur, autofinancement_eur et son cumul",
          code: "autofinancement = total_produits_eur - total_charges_eur ; cumul += autofinancement",
          referentiel: "aucun : pure agrégation",
          alimente: "les indicateurs et le graphique de l’écran Exploitation",
          tests: "tests/exploitation.test.js, tests/golden.test.js",
          source: "src/exploitation.js:552",
          texte: "Le résultat comptable n’est PAS publié si la dotation aux amortissements est inconnue : les champs valent null plutôt qu’un nombre qui ne voudrait rien dire. La disponibilité est décidée une fois pour tout le compte, jamais année par année."
        },
        piege: "Les produits financiers d’une année reposent sur le cumul d’autofinancement arrêté à la FIN de l’année précédente : ils sont donc nuls en année 1. Un cumul négatif ne produit pas d’intérêts débiteurs, le moteur ne modélise pas de coût de portage.",
        entrees: [
          ["Produits", "calculés aux étapes 5 et 6"],
          ["Charges", "calculées aux étapes 1, 3 et 4"],
          ["Annuités", "chapitre Prêts"],
          ["Dotation aux amortissements", "étape suivante"]
        ]
      },
      {
        titre: "L’amortissement par composants",
        regles: ["R-EXP-5"],
        simple: "Un immeuble ne s’amortit pas d’un bloc, parce que ses parties n’ont pas la même durée de vie. La structure tient cinquante ans, la toiture et les menuiseries vingt-cinq, les équipements et agencements quinze. Chaque composant reçoit donc une quote-part de la base d’amortissement et s’amortit linéairement sur sa propre durée. La dotation totale décroît par paliers : elle chute une première fois quand les équipements s’éteignent à quinze ans, une seconde à vingt-cinq. Cette dotation n’est pas un décaissement, elle n’entre que dans le résultat comptable, jamais dans l’autofinancement.",
        formule: "pour chaque composant :\n  dotation annuelle = base d’amortissement × quote-part ÷ durée\n\ndotation totale de l’année N = Σ des composants encore en cours\n\nGrille collectif :\n  structure ....... 50 % sur 50 ans\n  toiture ......... 8 %  sur 25 ans\n  menuiseries ..... 12 % sur 25 ans\n  équipements ..... 15 % sur 15 ans\n  agencements ..... 15 % sur 15 ans\n\nExemple, base de 1 700 000 € :\n  années 1 à 15 ... 17 000 + 5 440 + 8 160 + 17 000 + 17 000 = 64 600 €\n  années 16 à 25 .. 17 000 + 5 440 + 8 160 = 30 600 €\n  années 26 à 50 .. 17 000 €",
        support: {
          fonction: "dotationParComposants",
          signature: "dotationParComposants(base_eur, composants, annee_debut, duree, { continuer }) → dotation année par année",
          code: "chaque composant s’amortit linéairement sur sa durée ; la dotation décroît par paliers à mesure qu’ils s’éteignent",
          referentiel: "amortissement_comptable.composants.collectif ou .individuel · .duree_defaut_ans en repli",
          alimente: "la dotation aux amortissements du compte d’exploitation, et par elle le résultat",
          tests: "tests/exploitation.test.js (question Q-34 sur la grille à retenir)",
          source: "src/exploitation.js:743",
          texte: "Aucune vérification que les quote-parts somment à 1 : une grille incomplète sous-amortit sans alerte. L’option `continuer` remet le composant à neuf indéfiniment, si bien que le cumul des dotations dépasse alors la base amortissable."
        },
        entrees: [
          ["Base d’amortissement", "calculée au chapitre Prix de revient"],
          [
            "Grille de composants",
            "Paramètres > Amortissement comptable, selon collectif ou individuel"
          ],
          [
            "Durée par défaut",
            "Paramètres > Amortissement comptable, en repli si aucune grille"
          ]
        ]
      },
      {
        titre: "Les indicateurs de synthèse",
        regles: ["R-EXP-3"],
        simple: "Trois indicateurs résument soixante ans de compte. Le taux de rentabilité interne est le taux qui annule la valeur actuelle nette de la série des flux : c’est le rendement de l’opération, tous flux confondus. Le moteur le cherche par dichotomie, en resserrant un intervalle jusqu’à trouver le taux qui équilibre, et il renvoie une absence de valeur si la série ne change jamais de signe — un TRI n’a alors pas de sens. L’année de reconstitution des fonds propres est la première année où l’autofinancement cumulé repasse au-dessus du montant apporté : c’est la date à laquelle l’organisme a récupéré sa mise. Le cumul d’autofinancement, enfin, dit ce que l’opération aura rapporté au total.",
        formule: "TRI : le taux r tel que  Σ flux(N) ÷ (1 + r)^N = 0\n  cherché par dichotomie entre −99 % et +100 %, 200 itérations\n  renvoie « non calculable » si tous les flux ont le même signe\n\nannée de reconstitution = première année où :\n  autofinancement cumulé ≥ fonds propres apportés\n\nExemple, OP-4 :\n  TRI sur 60 ans ......................... 2,40 %\n  fonds propres apportés ................. 44 319 €\n  cumul d’autofinancement à 60 ans ....... 5 843 784 €",
        support: {
          fonction: "tauxRentabiliteInterne, indicateursExploitation, anneeReconstitutionFondsPropres",
          signature: "tauxRentabiliteInterne(flux) → taux, ou null si la série ne change jamais de signe · indicateursExploitation(lignes, contexte) → agrégats · anneeReconstitutionFondsPropres(lignes, fonds_propres_eur) → année ou null",
          code: "TRI par bissection sur la valeur actuelle nette, bornes -0,99 et 1, 200 itérations",
          referentiel: "aucun : dérivé des flux du compte",
          alimente: "les tuiles de l’écran Exploitation",
          tests: "tests/exploitation.test.js",
          source: "src/exploitation.js:774, 792 et 708",
          texte: "La dernière année est écartée des moyennes de marge : le dernier prêt étant soldé, elle affiche une marge exceptionnelle sans aucun sens économique. Le taux de marge moyen est une moyenne ARITHMÉTIQUE des taux annuels, pas une marge pondérée."
        },
        piege: "Question Q-33 non arbitrée : l’année de reconstitution des fonds propres retient le PREMIER franchissement du seuil. Le cumul n’étant pas monotone (il peut redescendre après une rupture comme la fin d’exonération), deux autres définitions sont défendables et donneraient une autre année.",
        entrees: [
          [
            "Série des flux",
            "produite par le compte d’exploitation, année par année"
          ],
          ["Fonds propres apportés", "plan de financement de la tranche"],
          ["Durée de simulation", "écran Opération > Calendrier"]
        ]
      }
    ]
  },
  {
    id: "conventions",
    titre: "Arrondis et conventions",
    accroche: "Les arrondis ne sont pas un détail de présentation : appliqués au mauvais endroit, ils font dériver un total de plusieurs euros sur une opération entière. Le moteur les concentre donc en un seul module, et ne les applique qu’aux frontières que le dictionnaire désigne.",
    etapes: [
      {
        titre: "Où le moteur arrondit",
        regles: ["R-CONV"],
        simple: "Le moteur arrondit à des endroits précis et toujours les mêmes, et jamais au milieu d’un calcul. Une surface s’arrondit à deux décimales, un loyer au m² à deux décimales, un coefficient de structure à quatre, un montant du bilan à l’euro entier, un capital restant dû à quatre décimales pour le test d’extinction du prêt. Tous ces arrondis vivent dans un seul fichier, ce qui permet de vérifier d’un coup d’œil la politique entière. Une subtilité : l’arrondi ajoute un epsilon avant d’arrondir, sinon la représentation binaire des décimaux ferait que 1,005 s’arrondirait à 1,00 au lieu de 1,01. Une autre : un montant nul est normalisé, pour qu’un solde à zéro ne s’affiche jamais « −0 € » selon le sens d’où il vient.",
        formule: "arrondi(valeur ; décimales) = ARRONDI(valeur + ε ; décimales)\n\n  surface ................... 2 décimales\n  loyer au m² ............... 2 décimales\n  coefficient de structure .. 4 décimales\n  montant du bilan .......... 0 décimale (euro entier)\n  capital restant dû ........ 4 décimales\n  prêt au millier supérieur . ARRONDI.SUP(montant ÷ 1000) × 1000\n\nSans l’epsilon : 1,005 → 1,00 (car stocké 1,00499999…)\nAvec l’epsilon : 1,005 → 1,01 ✓",
        support: {
          fonction: "arrondiSurface, arrondiLoyer, arrondiCS, arrondiEuro, arrondiCRD",
          signature: "arrondi(valeur, decimales) et ses cinq spécialisations : surface 2 décimales, loyer 2, coefficient 4, euro entier, CRD 4",
          code: "Math.round((valeur + Number.EPSILON) * f) / f   — l’epsilon neutralise le bruit flottant, 1.005 donne bien 1.01. arrondiEuro normalise en plus le zéro négatif",
          referentiel: "aucun : la politique d’arrondi est du code, pas une donnée",
          alimente: "toutes les frontières de calcul du moteur",
          tests: "tests/fondations.test.js",
          source: "src/arrondis.js",
          texte: "Toutes s’appuient sur `arrondi(valeur, décimales)`, qui ajoute `Number.EPSILON` avant `Math.round` pour neutraliser le bruit flottant (1.005 → 1.01 et non 1.00). `arrondiEuro` normalise en outre le zéro négatif : un résidu à −1e−13 s’arrondirait en `-0`, que JSON sérialise « -0 » et que l’écran afficherait « -0 € »."
        },
        piege: "La surface utile est arrondie à la TRANCHE et non au lot : arrondir lot par lot ferait dériver le total de l’opération.",
        entrees: [
          [
            "Politique d’arrondi",
            "src/arrondis.js — c’est du code, pas une donnée paramétrable"
          ],
          [
            "Arrondi des prêts",
            "option de la simulation : arrondir au millier supérieur"
          ]
        ]
      },
      {
        titre: "Répartir sans perdre un euro",
        regles: ["R-CONV", "R-TVA-3"],
        simple: "Le même problème que celui de la ventilation du prix de revient se pose partout où une somme se répartit : mensualités de trésorerie, ventilation par tranche, séries annuelles. Arrondir chaque part indépendamment fait dériver le total, et l’écart se voit à l’écran. La règle est unique dans tout le moteur : on arrondit à l’entier inférieur, on calcule ce qui manque, et on distribue les unités manquantes aux parts qui avaient la plus grande décimale. À égalité de décimale, on suit l’ordre d’origine, ce qui rend le résultat parfaitement reproductible d’un calcul à l’autre. La méthode fonctionne aussi sur des valeurs négatives, le reliquat se distribuant alors dans l’autre sens.",
        formule: "1. planchers = ENT(chaque valeur)\n2. reliquat = total visé − Σ planchers\n3. trier par décimale décroissante, puis par ordre d’origine\n4. ajouter 1 (ou retirer 1 si le reliquat est négatif) aux premiers\n\nExemple, 2 000 000 € sur 24 mois :\n  2 000 000 ÷ 24 = 83 333,33 par mois\n  24 × 83 333 = 1 999 992  →  il manque 8 €\n  les 8 premiers mois portent 83 334 €, les 16 autres 83 333 €\n  total = 2 000 000 € ✓",
        support: {
          fonction: "arrondirEnConservantLaSomme",
          signature: "arrondirEnConservantLaSomme(valeurs, totalImpose) → entiers dont la somme vaut exactement totalImpose, ou l’arrondi de la somme exacte si aucun total n’est imposé",
          code: "reliquat = total - somme des planchers ; distribué une unité à la fois aux plus grands restes, dans le sens du signe",
          referentiel: "aucun",
          alimente: "prixDeRevientVentile, la trésorerie mensuelle, toute série affichée qui doit s’additionner",
          tests: "tests/fondations.test.js, tests/bilan.test.js",
          source: "src/arrondis.js:90",
          texte: "Méthode du plus grand reste, déterministe à égalité (tri stable sur l’index). Accepte un `totalImpose` quand la somme à respecter a déjà été arrondie ailleurs et fait autorité : ventiler un sous-total de chapitre doit retomber sur le sous-total AFFICHÉ, pas sur l’arrondi de la somme exacte. Gère les reliquats négatifs en distribuant dans l’autre sens."
        },
        entrees: [
          ["Valeurs à répartir", "les parts exactes, non arrondies"],
          [
            "Total visé",
            "la somme à respecter, imposée si elle a déjà été arrondie ailleurs"
          ]
        ]
      }
    ]
  }
];;

/** Postes de trajectoire, dans l'ordre d'affichage. */
const POSTES_TRAJECTOIRE = [
  { cle: 'loyers_irl', libelle: 'Loyers / IRL' },
  { cle: 'gros_entretien', libelle: 'Gros entretien et renouvellement' },
  { cle: 'gestion', libelle: 'Gestion' },
  { cle: 'tfpb', libelle: 'TFPB' },
  { cle: 'livret_a', libelle: 'Livret A' },
];

/**
 * MODELE des parametres reglables, decrit en DONNEES et non en HTML.
 *
 * Un seul endroit declare ce qui existe ; le rendu, la recherche, le comptage
 * des modifications et la remise a zero s'en deduisent. Ecrire le HTML groupe
 * par groupe obligeait a repeter la meme mecanique dix fois, et a l'oublier une
 * fois sur deux.
 *
 * Deux formes de champ seulement :
 * - `champs` : des grandeurs independantes, rendues en grille de cartes ;
 * - `matrices` : une grandeur declinee par zone, rendue en table serree.
 */
function modeleParametres() {
  const b = referentiels.baremes;
  const cr = b.constantes_reglementaires;
  const cs = cr.coefficient_structure;

  /** Raccourci de declaration d'un champ scalaire. */
  const ch = (chemin, libelle, valeur, type = 'nombre', detail = '') => ({
    chemin, libelle, valeur, type, detail,
  });

  /**
   * Matrice « une ligne par grandeur, une colonne par zone ».
   *
   * `coin` place un champ dans la cellule vide en haut a gauche - la seule case
   * de la table qui ne designe ni une ligne ni une colonne, et donc la seule
   * qui puisse qualifier la table entiere. Le millesime d'un bareme y a sa
   * place naturelle : il vaut pour toutes les valeurs en dessous, et le lire
   * a cote d'elles evite d'aller le chercher dans un encart separe.
   */
  const matrice = (racine, titre, zones, lignes, type, coin) => ({
    titre,
    zones,
    coin,
    lignes: lignes.map(([cle, libelle]) => ({
      libelle,
      cellules: zones.map((z, i) => ({
        chemin: `${racine}.${cle}.${i}`,
        libelle: `${libelle} ${z}`,
        valeur: lireChemin(b, `${racine.replace(/^baremes\./, '')}.${cle}`)[i],
        type,
      })),
    })),
  });

  return [
    {
      // Section FANTOME : elle n'a ni champs ni matrices, son contenu est du
      // markup statique dans la page. Elle n'existe ici que pour tenir sa place
      // au rail, avec le meme libelle et le meme resume que les autres.
      id: 'hypotheses',
      rubrique: 'exploitation',
      titre: 'Compte d’exploitation',
      resume: 'Gestion, vacance, gros entretien, cotisations',
      aide: '',
    },
    {
      // Section FANTOME elle aussi, mais d'une autre nature : elle ne regle
      // rien. C'est la documentation vivante du moteur - tous les calculs et
      // leurs enchainements - rendue depuis `MODELE_CALCULS`. Ouverte a tous,
      // comme les hypotheses : comprendre ce que l'outil calcule n'est pas un
      // privilege d'administrateur.
      id: 'calculs',
      rubrique: 'calculs',
      titre: 'Explication des calculs',
      resume: 'Chaque formule, en clair et en code',
      aide: '',
    },
    {
      // UNE seule section pour tous les prets : les marges CDC et les modeles
      // repondent a la meme question - a quelles conditions emprunte-t-on - et
      // les separer obligeait a chercher dans deux rubriques selon le preteur.
      //
      // Deux formes cote a cote, parce que les deux objets n'ont pas la meme
      // forme : les prets CDC par defaut ne se decrivent QUE par leur marge (le
      // reste tient au produit et a la zone, une duree de pret foncier valant 50
      // ou 60 ans selon B2/C), la ou un modele decrit un produit entier. Poser
      // les CDC en lignes de la table des modeles aurait demande une colonne de
      // duree qu'on aurait laissee vide, ou pire, remplie a tort.
      id: 'presets',
      titre: 'Modèles de prêt',
      resume: 'Marges CDC, Action Logement, PHB 2.0…',
      aide:
        'Le taux d’un prêt CDC vaut Livret A + marge, la marge étant propre au produit. Les ' +
        'modèles, eux, décrivent un produit entier : ils se posent d’un clic sur un prêt ajouté ' +
        'à une tranche, et seul le montant reste à saisir. Les valeurs viennent des fiches ' +
        'produit des prêteurs : modifiez-les si votre convention diffère, ajoutez les vôtres.',
      presets: true,
      // Le LIVRET A DE REFERENCE, et lui seul, reste hors de la table : ce
      // n'est pas la propriete d'un modele mais le socle de tous les prets
      // indexes, et il vit dans les TRAJECTOIRES, pas dans les baremes. Le
      // poser ici, en tete des modeles, le met la ou on le cherche - au-dessus
      // des marges qui s'y ajoutent - sans pretendre qu'il appartient a l'un
      // d'eux. Les marges, elles, ont rejoint la table.
      champs: [
        ch(
          'trajectoires.taux_reference_livret_a',
          'Livret A de référence',
          referentiels.trajectoires?.taux_reference_livret_a,
          'pourcentage',
          'socle de tous les prêts indexés',
        ),
      ],
    },
    {
      id: 'jalons',
      titre: 'Appels de fonds VEFA',
      resume: 'Échéancier légal des dépenses',
      aide:
        'En VEFA, le promoteur appelle des fonds à l’avancement selon un barème légal, et non par ' +
        'mensualités égales : 25 % à la signature change le besoin de trésorerie dès le premier ' +
        'mois. Ce barème ne s’applique qu’aux opérations dont le type est VEFA ; ailleurs, le coût ' +
        'se répartit à parts égales sur les mois de chantier.',
      jalons: true,
    },
    {
      id: 'loyers',
      titre: 'Loyers plafonds',
      resume: 'Barèmes par zone, et leur millésime',
      aide:
        "Le millésime, en haut à gauche de chaque table, est celui des valeurs qu'elle contient. " +
        "Le moteur rattrape l'écart jusqu'à la mise en location en indexant les plafonds à l'IRL " +
        'de la trajectoire. La marge locale, saisie en euros du jour, reste intacte.',
      matrices: [
        matrice(
          'baremes.loyers_max_zone_123',
          'Zonage 1/2/3 (€/m² SU/mois)',
          b.loyers_max_zone_123.zones.map((z) => z.replace('zone_', '')),
          [['PLUS', 'PLUS'], ['PLAI', 'PLAI'], ['LIBRE', 'Libre']],
          'nombre',
          ch(
            'baremes.loyers_max_zone_123.annee_reference',
            'Millésime du barème 1/2/3',
            b.loyers_max_zone_123.annee_reference,
            'annee',
          ),
        ),
        matrice(
          'baremes.loyers_max_zone_ABC',
          'Zonage A/B/C (€/m² SU/mois)',
          b.loyers_max_zone_ABC.zones,
          [['PLS', 'PLS'], ['PLI', 'PLI / LLI']],
          'nombre',
          ch(
            'baremes.loyers_max_zone_ABC.annee_reference',
            'Millésime du barème A/B/C',
            b.loyers_max_zone_ABC.annee_reference,
            'annee',
          ),
        ),
      ],
    },
    {
      id: 'tva',
      titre: 'TVA',
      resume: 'Taux appliqué au prix de revient',
      aide:
        'Le taux du produit détermine le TTC de sa tranche. Les taux réduit et normal servent ' +
        "aux postes qui ne relèvent pas d'un produit.",
      // Une colonne de taux et rien d'autre : la table les empile, donc les rend
      // comparables d'un coup d'oeil, ce qu'une grille de cartes ne fait pas.
      matrices: [
        {
          titre: 'Taux par produit',
          zones: ['Taux'],
          lignes: [
            ['baremes.tva.taux_reduit_simulation', 'Taux réduit', b.tva.taux_reduit_simulation],
            ['baremes.tva.taux_normal', 'Taux normal', b.tva.taux_normal],
            ...Object.entries(b.tva.lasm_par_produit)
              .filter(([, v]) => typeof v === 'number')
              .map(([cle, v]) => [`baremes.tva.lasm_par_produit.${cle}`, cle.replace(/_/g, ' '), v]),
          ].map(([chemin, libelle, valeur]) => ({
            libelle,
            cellules: [{ chemin, libelle, valeur, type: 'pourcentage' }],
          })),
        },
      ],
    },
    {
      id: 'trajectoires',
      titre: 'Trajectoires macro',
      resume: `${referentiels.trajectoires.trajectoires.length} années indexées`,
      aide:
        "Indexation annuelle des recettes et des charges. Au-delà de la dernière année connue, " +
        'la dernière valeur est reconduite.',
      trajectoires: true,
    },
    {
      id: 'constantes',
      titre: 'Constantes réglementaires',
      resume: 'Surfaces, structure, majorations, SSF, TFPB',
      aide:
        'Seules figurent ici les constantes que le moteur lit réellement : un paramètre affiché ' +
        "mais inutilisé donnerait le sentiment de piloter ce qui ne bouge pas.",
      champs: [
        ch('baremes.constantes_reglementaires.coefficient_surface_annexes.valeur', 'Coefficient des surfaces annexes', cr.coefficient_surface_annexes.valeur, 'nombre', 'SU = SHAB + k × annexes'),
        ch('baremes.constantes_reglementaires.coefficient_structure.metropole_habitat.base', 'Coefficient de structure - base', cs.metropole_habitat.base, 'nombre'),
        ch('baremes.constantes_reglementaires.coefficient_structure.metropole_habitat.facteur_nl', 'Coefficient de structure - facteur logements', cs.metropole_habitat.facteur_nl, 'nombre'),
        ch('baremes.constantes_reglementaires.coefficient_structure.foyers.facteur_nl', 'Coefficient de structure - foyers', cs.foyers.facteur_nl, 'nombre'),
        ch('baremes.constantes_reglementaires.majoration_plus_33', 'Majoration PLUS 33 %', cr.majoration_plus_33, 'pourcentage'),
        ch('baremes.constantes_reglementaires.majoration_loyers_depassement_plafonds.valeur', 'Majoration en dépassement de plafond', cr.majoration_loyers_depassement_plafonds.valeur, 'pourcentage'),
        ch('baremes.constantes_reglementaires.marge_locale_plafond_defaut.valeur', 'Plafond de marge locale', cr.marge_locale_plafond_defaut.valeur, 'pourcentage'),
        ch('baremes.constantes_reglementaires.majoration_lcr.seuil_bas', 'LCR - seuil bas', cr.majoration_lcr.seuil_bas, 'nombre', '% de surface'),
        ch('baremes.constantes_reglementaires.majoration_lcr.seuil_haut', 'LCR - seuil haut', cr.majoration_lcr.seuil_haut, 'nombre', '% de surface'),
        ch('baremes.constantes_reglementaires.majoration_lcr.majoration_au_dessus', 'LCR - majoration au-delà', cr.majoration_lcr.majoration_au_dessus, 'pourcentage'),
        ch('baremes.constantes_reglementaires.controle_ratio_prets_cdc_min.valeur', 'Ratio minimum de prêts CDC', cr.controle_ratio_prets_cdc_min.valeur, 'pourcentage'),
        ch('baremes.constantes_reglementaires.tfpb.montant_par_logement_eur', 'TFPB par logement', cr.tfpb.montant_par_logement_eur, 'montant', '€/an'),
        ch('baremes.constantes_reglementaires.tfpb.duree_exoneration_defaut_ans', "Exonération TFPB par défaut", cr.tfpb.duree_exoneration_defaut_ans, 'nombre', 'ans'),
        ch('baremes.constantes_reglementaires.ssf.seuil_participation_collectivites', 'SSF - seuil de participation', cr.ssf.seuil_participation_collectivites, 'pourcentage'),
        ch('baremes.constantes_reglementaires.ssf.part_max_depassement', 'SSF - part max du dépassement', cr.ssf.part_max_depassement, 'pourcentage'),
      ],
    },
    {
      id: 'fonds-propres',
      titre: 'Fonds propres',
      resume: 'Rémunération et reconstitution',
      aide: 'Valeurs par défaut des deux options de la tranche.',
      champs: [
        ch('baremes.fonds_propres.taux_remuneration_defaut', 'Taux de rémunération', b.fonds_propres.taux_remuneration_defaut, 'pourcentage'),
        ch('baremes.fonds_propres.duree_reconstitution_defaut_ans', 'Durée de reconstitution', b.fonds_propres.duree_reconstitution_defaut_ans, 'nombre', 'ans'),
      ],
    },
    {
      id: 'foncier',
      titre: 'Foncier et fiscalité',
      resume: 'Quotités VEFA, taxe d’aménagement',
      aide:
        'Les quotités déterminent la part du prix de revient réputée foncière, donc le droit à ' +
        'prêt foncier, en VEFA et en acquisition-amélioration.',
      champs: [
        ch('baremes.taxe_amenagement.hors_idf', "Taxe d'aménagement hors Île-de-France", b.taxe_amenagement.hors_idf, 'montant', '€/m²'),
        ch('baremes.taxe_amenagement.idf', "Taxe d'aménagement Île-de-France", b.taxe_amenagement.idf, 'montant', '€/m²'),
        ch('baremes.taxe_amenagement.abattement_logement_social', 'Abattement logement social', b.taxe_amenagement.abattement_logement_social, 'pourcentage'),
        ch('baremes.versement_sous_densite.plafond_valeur_terrain', 'VSD - plafond sur la valeur du terrain', b.versement_sous_densite.plafond_valeur_terrain, 'pourcentage'),
        ch('baremes.versement_sous_densite.part_valeur_terrain', 'VSD - part de la valeur du terrain', b.versement_sous_densite.part_valeur_terrain, 'pourcentage'),
      ],
      matrices: [
        matrice(
          'baremes.quotites_foncier_vefa',
          'Quotités de charge foncière forfaitaire',
          b.quotites_foncier_vefa.zones,
          [
            ['terrain_vefa', 'Terrain VEFA'],
            ['terrain_acq_amelioration', 'Terrain acquisition-amélioration'],
            ['valeur_comptable_terrain_vefa', 'Valeur comptable du terrain'],
            ['ssf_pge_acq_amelioration', 'Assiette SSF / PGE'],
          ],
          'pourcentage',
        ),
      ],
    },
  ];
}

/** Tous les champs d'une section, matrices comprises : sert au comptage et a la recherche. */
function champsDeSection(s) {
  return [
    ...(s.champs ?? []),
    ...(s.matrices ?? []).flatMap((m) => [
      ...(m.coin ? [m.coin] : []),
      ...m.lignes.flatMap((l) => l.cellules),
    ]),
  ];
}

/** Nombre de champs surcharges dans une section. */
function nbModifies(s) {
  // Les modeles ne se comptent pas champ par champ : c'est la LISTE entiere qui
  // est surchargee des qu'on y touche. On compte donc les modeles qui different
  // du referentiel, ajouts et suppressions compris - le nombre repond a « qu'ai
  // je change ici », pas a « combien de cellules ai-je remplies ».
  if (s.jalons) {
    const sj = surchargeDe('baremes.tresorerie.jalons_vefa.jalons');
    if (!sj) return 0;
    const bj = referentiels.baremes.tresorerie?.jalons_vefa?.jalons ?? [];
    const parId = new Map(bj.map((x) => [x.id, JSON.stringify(x)]));
    return (
      sj.filter((x) => parId.get(x.id) !== JSON.stringify(x)).length +
      bj.filter((x) => !sj.some((y) => y.id === x.id)).length
    );
  }
  if (s.presets) {
    // Les champs de la section comptent AUSSI : le Livret A de reference y
    // figure, et l'oublier faisait afficher « aucune modification » a un profil
    // dont on venait de changer le socle de tous les prets indexes.
    const champs = (s.champs ?? []).filter((c) => !nul(surchargeDe(c.chemin))).length;
    const surcharge = surchargeDe('baremes.presets_prets.presets');
    if (!surcharge) return champs;
    const base = referentiels.baremes.presets_prets?.presets ?? [];
    const parId = new Map(base.map((x) => [x.id, JSON.stringify(x)]));
    const changes = surcharge.filter((x) => parId.get(x.id) !== JSON.stringify(x)).length;
    const retires = base.filter((x) => !surcharge.some((y) => y.id === x.id)).length;
    // L'ORDRE compte comme une modification a lui seul : reordonner ne change
    // aucune valeur, mais le profil n'est plus celui du referentiel et le dire
    // « aucune modification » a cote d'un bouton de sauvegarde actif se
    // contredisait a l'ecran.
    const ordre =
      changes + retires === 0 &&
      surcharge.map((x) => x.id).join() !== base.map((x) => x.id).join()
        ? 1
        : 0;
    return champs + changes + retires + ordre;
  }
  if (s.trajectoires) {
    return Object.values(parametrageActif().trajectoires?.par_annee ?? {}).reduce(
      (t, postes) => t + Object.values(postes ?? {}).filter((v) => !nul(v)).length,
      0,
    );
  }
  return champsDeSection(s).filter((c) => !nul(surchargeDe(c.chemin))).length;
}

/** Un champ repond-il a la recherche ? Recherche sans accent ni casse. */
const sansAccent = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function correspond(champ) {
  if (!rechercheParametre) return true;
  return sansAccent(`${champ.libelle} ${champ.detail ?? ''}`).includes(sansAccent(rechercheParametre));
}

/**
 * Carte d'un parametre : libelle, saisie, et la valeur du referentiel juste
 * dessous. Une carte plutot qu'une ligne de table : quinze constantes en table
 * a trois colonnes, c'etait mille six cents pixels de large dont neuf dixiemes
 * de vide, et un ecran de defilement pour les lire.
 */
function carteParametre(c, origine) {
  const s = surchargeDe(c.chemin);
  const modifie = !nul(s);
  const format = (v) =>
    nul(v)
      ? ''
      : c.type === 'pourcentage'
        ? pct(v, 2)
        : c.type === 'montant'
          ? eur(v)
          : // Un millesime n'est pas une quantite : le grouper par milliers le
            // ferait lire « 2 025 ».
            c.type === 'annee'
            ? String(v)
            : nb(v);
  const enPct = c.type === 'pourcentage';
  const saisie =
    c.type === 'montant'
      ? `<input type="text" inputmode="decimal" data-champ="${c.chemin}" data-type="montant"
           placeholder="${att(fMontantSaisie.format(c.valeur ?? 0))}" value="${valMontant(s)}" />`
      : `<input type="number" step="${enPct ? '0.01' : c.type === 'annee' ? '1' : 'any'}"
           data-champ="${c.chemin}" data-type="${enPct ? 'pourcentage' : 'nombre'}"
           placeholder="${att(String(enPct ? enPourcent(c.valeur) : (c.valeur ?? '')))}"
           value="${valNum(enPct ? enPourcent(s) : s)}" />`;
  return `
    <div class="para-carte ${modifie ? 'para-carte--modifiee' : ''}">
      ${origine ? `<span class="para-carte__origine">${att(origine)}</span>` : ''}
      <label class="para-carte__libelle">${att(c.libelle)}</label>
      <div class="para-carte__saisie">
        ${saisie}
        ${enPct ? '<span class="unite">%</span>' : c.detail ? `<span class="unite">${att(c.detail)}</span>` : ''}
      </div>
      <div class="para-carte__pied">
        <span class="para-carte__ref">${modifie ? `référentiel ${format(c.valeur)}` : format(c.valeur)}${
          // Le taux resultant se lit sous la marge, et suit la frappe : c'est
          // lui que le pret paiera, la marge n'en etant que la part variable.
          c.cle_marge ? ` · taux <b data-taux-marge="${att(c.cle_marge)}">-</b>` : ''
        }</span>
        ${modifie ? `<button type="button" class="para-carte__annuler" data-annuler="${att(c.chemin)}" title="Revenir au référentiel">↺</button>` : ''}
      </div>
    </div>`;
}

/** Matrice zone x grandeur : la table est ici la bonne forme, une carte par cellule ne l'est pas. */
/**
 * Cellule d'une grille de saisie. Les coordonnees `data-l` / `data-c` sont ce
 * qui permet a la navigation clavier et au collage de se reperer : sans elles,
 * il faudrait redecouvrir la geometrie du tableau a chaque touche.
 */
function celluleGrille(chemin, valeurRef, type, l, c) {
  const s = surchargeDe(chemin);
  const enPct = type === 'pourcentage';
  const aff = (v) => (nul(v) ? '' : enPct ? enPourcent(v) : v);
  // Cellule en TEXTE et non en `number` : sur un champ numerique, le navigateur
  // refuse de dire ou se trouve le curseur (`selectionStart` vaut null), et les
  // fleches horizontales ne peuvent alors plus distinguer « je corrige un
  // chiffre » de « je change de cellule ». En texte, la distinction se fait.
  return `<td class="cellule-valeur ${nul(s) ? '' : 'surchargee'}">
    <input type="text" inputmode="decimal" data-champ="${chemin}"
      data-type="${enPct ? 'pourcentage' : 'nombre'}" data-l="${l}" data-c="${c}"
      placeholder="${att(String(aff(valeurRef)))}" value="${valNum(aff(s))}" /></td>`;
}

/**
 * Coin haut-gauche d'une matrice : la seule case qui ne designe ni une ligne ni
 * une colonne, donc la seule qui puisse qualifier la table entiere. Le millesime
 * d'un bareme s'y lit a cote des valeurs qu'il date.
 *
 * Meme convention que `celluleGrille` : la valeur du referentiel est un
 * PLACEHOLDER, seule une surcharge est une valeur. Sans cela, le champ afficherait
 * le referentiel comme s'il avait ete saisi, et le vider ne voudrait plus rien
 * dire. Le coin reste hors de la navigation au clavier, qui n'adresse que les
 * valeurs de la grille.
 */
function coinGrille(coin) {
  if (!coin) return '<th class="grille__coin"></th>';
  const s = surchargeDe(coin.chemin);
  return `<th class="grille__coin ${nul(s) ? '' : 'surchargee'}">
    <input type="text" inputmode="numeric" class="grille__coin-champ"
      data-champ="${coin.chemin}" data-type="nombre"
      title="${att(coin.libelle)}" aria-label="${att(coin.libelle)}"
      placeholder="${att(String(coin.valeur ?? ''))}" value="${valNum(s)}" /></th>`;
}

/**
 * Colonnes d'un modele de pret. Le chemin pointe la liste du REFERENTIEL : un
 * modele modifie devient donc une surcharge de profil, exactement comme un
 * bareme - changer de profil change les modeles, ce qui est le comportement
 * attendu d'une convention de prêteur negociee par l'organisme.
 */
const COLONNES_PRESET = [
  { cle: 'libelle', libelle: 'Modèle', type: 'texte', largeur: 190 },
  // Sur quelles tranches le modele est proposable. Une liste a cocher plutot
  // qu'un champ libre : les produits sont un ensemble ferme, et une faute de
  // frappe rendrait le modele invisible sans rien dire.
  { cle: 'produits', libelle: 'Tranches', type: 'produits', largeur: 150 },
  // Un groupe rassemble les declinaisons d'un meme preteur : l'ecran de tranche
  // n'en propose qu'une, celle du produit de la tranche. Laisser la colonne vide
  // fait du modele un modele autonome, propose partout.
  { cle: 'groupe', libelle: 'Groupe', type: 'texte', largeur: 130 },
  { cle: 'spread', libelle: 'Marge / LA', type: 'pourcentage' },
  { cle: 'taux', libelle: 'Taux fixe', type: 'pourcentage' },
  { cle: 'taux_plancher', libelle: 'Plancher', type: 'pourcentage' },
  { cle: 'duree_ans', libelle: 'Durée', type: 'nombre' },
  { cle: 'differe_ans', libelle: 'Différé', type: 'nombre' },
  { cle: 'progressivite', libelle: 'Progr.', type: 'pourcentage' },
  { cle: 'revisabilite', libelle: 'Révisabilité', type: 'revisabilite' },
  { cle: 'profil_amortissement', libelle: 'Amortissement', type: 'profil' },
  { cle: 'periodicite', libelle: 'Échéance', type: 'periodicite', largeur: 120 },
];

/**
 * Liste EFFECTIVE des modeles de pret : celle du profil actif si elle a ete
 * touchee, celle du referentiel sinon.
 *
 * `referentiels` porte le referentiel BRUT ; les surcharges vivent a cote, dans
 * le profil, et ne sont fusionnees que pour le moteur. Les autres parametres
 * s'en accommodent - ils affichent la surcharge comme valeur et le referentiel
 * en filigrane - mais une LISTE n'a pas de filigrane : on montre celle qui fait
 * foi, sans quoi ajouter un modele n'aurait aucun effet visible.
 */
function listePresets() {
  return surchargeDe('baremes.presets_prets.presets') ?? referentiels.baremes.presets_prets?.presets ?? [];
}

/** Nombre d'echeances par an, nomme. Le moteur ne connait que le nombre. */
const PERIODICITES = [
  { v: 1, l: 'annuelle' },
  { v: 2, l: 'semestrielle' },
  { v: 4, l: 'trimestrielle' },
  { v: 12, l: 'mensuelle' },
];

/**
 * Colonnes d'un jalon d'appel de fonds. Deux natures de donnee, et la table le
 * dit : la PART est legale et ne se discute pas ; l'AVANCEMENT est une
 * hypothese de calendrier, le bareme disant a quel stade technique le fonds est
 * appelable, jamais a quel mois.
 */
const COLONNES_JALON = [
  { cle: 'libelle', libelle: 'Stade', type: 'texte', largeur: 320 },
  { cle: 'part', libelle: 'Part du prix de revient', type: 'pourcentage' },
  { cle: 'avancement', libelle: 'Avancement du chantier', type: 'pourcentage' },
];

/** Liste EFFECTIVE des jalons : surcharge du profil, ou referentiel. */
function listeJalons() {
  return (
    surchargeDe('baremes.tresorerie.jalons_vefa.jalons') ??
    referentiels.baremes.tresorerie?.jalons_vefa?.jalons ??
    []
  );
}

/** Table des jalons VEFA : une ligne par stade, ajout, suppression, glisser. */
function tableJalons() {
  const liste = listeJalons();
  const visibles = liste
    .map((x, i) => ({ x, i }))
    .filter(({ x }) => correspond({ libelle: x.libelle ?? '' }));
  if (!visibles.length && rechercheParametre) return '';

  const total = liste.reduce((s, x) => s + (Number(x.part) || 0), 0);
  const cellule = (x, i, c) => {
    const chemin = `baremes.tresorerie.jalons_vefa.jalons.${i}.${c.cle}`;
    if (c.type === 'texte') {
      return `<td><input type="text" data-champ="${chemin}" value="${att(x[c.cle] ?? '')}" /></td>`;
    }
    return `<td class="num"><input type="text" inputmode="decimal" data-champ="${chemin}"
      data-type="pourcentage" value="${valNum(enPourcent(x[c.cle]))}" placeholder="-" /></td>`;
  };

  return `
    <div class="para-matrice">
      <h4>Appels de fonds
        <button type="button" class="bouton bouton--ajout" id="btn-ajouter-jalon">+ jalon</button>
      </h4>
      <div class="table-defilante"><table class="grille grille--presets" id="table-jalons">
        <thead><tr>
          <th class="col-poignee"></th>
          ${COLONNES_JALON.map((c) => `<th${c.largeur ? ` style="min-width:${c.largeur}px"` : ''}>${att(c.libelle)}</th>`).join('')}
          <th></th>
        </tr></thead>
        <tbody>${visibles
          .map(
            ({ x, i }) => `<tr data-rang="${i}">
              <td class="col-poignee"><span class="poignee" draggable="true"
                title="Glisser pour réordonner">⠿</span></td>
              ${COLONNES_JALON.map((c) => cellule(x, i, c)).join('')}
              <td class="col-action"><button type="button" class="bouton--supprimer"
                data-supprimer-jalon="${i}" data-nom="${att(x.libelle)}" title="Supprimer">×</button></td>
            </tr>`,
          )
          .join('')}</tbody>
        <tfoot><tr>
          <td></td><td class="libelle">Total</td>
          <!-- Le total DOIT faire 100 % : au-dessous, une part du prix de revient
               n'est jamais appelee ; au-dessus, on appelle plus que le coût. -->
          <td class="num ${Math.abs(total - 1) > 1e-9 ? 'montant--negatif' : ''}">${pct(total, 1)}</td>
          <td></td><td></td>
        </tr></tfoot>
      </table></div>
      <p class="grille__aide">Barème légal des appels de fonds en VEFA : les parts ne se discutent
        pas, l’avancement est une hypothèse de calendrier. Un jalon posté au-delà de la livraison
        y est ramené, la trésorerie de chantier s’y arrêtant.</p>
    </div>`;
}

/** Table des modeles de pret : une ligne par modele, ajout et suppression. */
function tablePresets() {
  const liste = listePresets();
  const visibles = liste
    .map((x, i) => ({ x, i }))
    .filter(({ x }) => correspond({ libelle: `${x.libelle} ${x.note ?? ''}` }));
  if (!visibles.length && rechercheParametre) return '';

  const cellule = (x, i, c) => {
    // La MARGE d'un modele CDC n'est pas la sienne : c'est celle de la grille
    // des prets, que le moteur lit aussi pour les prets par defaut. La cellule
    // pointe donc `prets_cdc.marges`, si bien qu'une seule valeur sert aux
    // deux. La dupliquer aurait cree deux marges pour un meme pret, et l'une
    // des deux aurait fini par mentir.
    const chemin = c.cle === 'spread' && x.cle_marge
      ? `baremes.prets_cdc.marges.${x.cle_marge}.valeur`
      : `baremes.presets_prets.presets.${i}.${c.cle}`;
    const v =
      c.cle === 'spread' && x.cle_marge
        ? (surchargeDe(chemin) ?? referentiels.baremes.prets_cdc?.marges?.[x.cle_marge]?.valeur)
        : x[c.cle];

    if (c.type === 'produits') {
      // Liste a cocher repliee dans un `details` : natif, sans script, et le
      // resume dit l'essentiel sans qu'on ait a l'ouvrir.
      // Une case par PRODUIT : un foyer PLAI partage la couleur du PLAI mais
      // n'est pas le meme financement, et un modele peut viser l'un sans
      // l'autre. Le regroupement par famille ne sert qu'a la couleur.
      const choisis = new Set(Array.isArray(v) ? v : []);
      const resume = choisis.size
        ? ORDRE_PRODUITS.filter((p) => choisis.has(p)).map((p) => libelleProduit(p)).join(', ')
        : 'toutes';
      return `<td><details class="tranches-choix">
        <summary title="${att(resume)}">${att(resume)}</summary>
        <div class="tranches-choix__liste">
          ${ORDRE_PRODUITS.map(
            (p) => `<label><input type="checkbox" data-produit-preset="${i}" data-produit="${p}"
              ${choisis.has(p) ? 'checked' : ''} /> <span style="--cat:${catProduit(p)}"
              class="tranches-choix__pastille"></span>${att(libelleProduit(p))}</label>`,
          ).join('')}
        </div>
      </details></td>`;
    }
    if (c.type === 'periodicite') {
      return `<td><select data-champ="${chemin}" data-type="nombre">
        ${PERIODICITES.map((o) => `<option value="${o.v}" ${o.v === (v ?? 1) ? 'selected' : ''}>${o.l}</option>`).join('')}
      </select></td>`;
    }
    if (c.type === 'revisabilite' || c.type === 'profil') {
      const options =
        c.type === 'revisabilite' ? OPTIONS_REVISABILITE : ['progressif', 'constant'];
      return `<td><select data-champ="${chemin}">
        ${options.map((o) => `<option value="${o}" ${o === v ? 'selected' : ''}>${att(o)}</option>`).join('')}
      </select></td>`;
    }
    if (c.type === 'texte') {
      return `<td><input type="text" data-champ="${chemin}" value="${att(v ?? '')}" /></td>`;
    }
    const aff = c.type === 'pourcentage' ? enPourcent(v) : v;
    return `<td class="num"><input type="text" inputmode="decimal" data-champ="${chemin}"
      data-type="${c.type === 'pourcentage' ? 'pourcentage' : 'nombre'}"
      value="${valNum(aff)}" placeholder="-" /></td>`;
  };

  return `
    <div class="para-matrice">
      <h4>Modèles disponibles
        <button type="button" class="bouton bouton--ajout" id="btn-ajouter-preset">+ modèle</button>
      </h4>
      <div class="table-defilante"><table class="grille grille--presets" id="table-presets">
        <thead><tr>
          <th class="col-poignee"></th>
          ${COLONNES_PRESET.map((c) => `<th${c.largeur ? ` style="min-width:${c.largeur}px"` : ''}>${att(c.libelle)}</th>`).join('')}
          <th></th>
        </tr></thead>
        <tbody>${visibles
          .map(({ x, i }) => {
            // Un modele qui vise une seule FAMILLE en prend la couleur, comme
            // les lignes de lots. La famille et non le code : {PLAI, FPLAI} est
            // une seule couleur, et exiger un code unique aurait laisse en gris
            // tous les modeles couvrant un produit et son foyer. Sur plusieurs
            // familles ou sur toutes, aucune couleur ne serait juste.
            const viseees = FAMILLES_PRODUIT.filter((f) =>
              f.codes.some((cd) => (x.produits ?? []).includes(cd)),
            );
            const cible = viseees.length === 1 ? viseees[0].chef : null;
            return `<tr data-rang="${i}" ${cible ? `class="preset--tranche" style="--cat-fond:${catFondProduit(cible)};--cat:${catProduit(cible)}"` : ''}>
              <td class="col-poignee"><span class="poignee" draggable="true"
                title="Glisser pour réordonner">⠿</span></td>
              ${COLONNES_PRESET.map((c) => cellule(x, i, c)).join('')}
              <td class="col-action">${
                // Un modele PRINCIPAL decrit un pret structurant : il ne se
                // supprime pas, il se regle. Le supprimer priverait la tranche
                // du pret qui absorbe son equilibre.
                x.principal
                  ? '<span class="preset__verrou" title="Prêt structurant : il se règle, il ne se supprime pas">⚿</span>'
                  : `<button type="button" class="bouton--supprimer"
                      data-supprimer-preset="${i}" data-nom="${att(x.libelle)}" title="Supprimer">×</button>`
              }</td>
            </tr>`;
          })
          .join('')}</tbody>
      </table></div>
      <p class="grille__aide">Une cellule vide vaut « sans objet » : un prêt à taux fixe n’a pas
        de marge, un prêt indexé n’a pas de taux fixe. La durée d’un prêt foncier se déduit
        de la zone (50 ans en B2 et C, 60 ans ailleurs) : la renseigner ici la fige.</p>
    </div>`;
}

/**
 * GLISSER-DEPOSER de lignes, partage par la table des lots et celle des modeles.
 *
 * Une seule mecanique pour les deux : la ligne porte son index d'origine, le
 * survol dit ou elle tomberait, et le depot appelle le reordonnancement de la
 * table concernee. Deux implementations auraient diverge a la premiere
 * retouche, et le geste doit se sentir identique d'un tableau a l'autre.
 *
 * Le `dragstart` n'est pose que sur la POIGNEE : rendre la ligne entiere
 * deplacable empecherait de selectionner du texte dans ses champs, ce qui est
 * l'usage courant sur une table de saisie.
 */
let ligneGlissee = null;

function poserGlisser(table, reordonner) {
  if (!table || table.dataset.glisserPose) return;
  table.dataset.glisserPose = '1';

  table.addEventListener('dragstart', (ev) => {
    const tr = /** @type {HTMLElement} */ (ev.target).closest('tr[data-rang]');
    if (!tr) return;
    ligneGlissee = Number(tr.dataset.rang);
    tr.classList.add('ligne--glissee');
    ev.dataTransfer.effectAllowed = 'move';
    // Firefox refuse de demarrer un glisser sans donnee attachee.
    ev.dataTransfer.setData('text/plain', String(ligneGlissee));
  });

  table.addEventListener('dragover', (ev) => {
    if (ligneGlissee === null) return;
    const tr = /** @type {HTMLElement} */ (ev.target).closest('tr[data-rang]');
    if (!tr) return;
    ev.preventDefault();
    // La ligne se pose AVANT ou APRES selon le cote survole : sans ce partage,
    // deposer sur la moitie basse d'une ligne l'insererait au-dessus d'elle et
    // le resultat surprendrait une fois sur deux.
    const r = tr.getBoundingClientRect();
    const apres = ev.clientY > r.top + r.height / 2;
    for (const a of table.querySelectorAll('.ligne--cible-avant, .ligne--cible-apres')) {
      a.classList.remove('ligne--cible-avant', 'ligne--cible-apres');
    }
    tr.classList.add(apres ? 'ligne--cible-apres' : 'ligne--cible-avant');
  });

  table.addEventListener('drop', (ev) => {
    const tr = /** @type {HTMLElement} */ (ev.target).closest('tr[data-rang]');
    if (!tr || ligneGlissee === null) return;
    ev.preventDefault();
    const r = tr.getBoundingClientRect();
    const cible = Number(tr.dataset.rang) + (ev.clientY > r.top + r.height / 2 ? 1 : 0);
    const depart = ligneGlissee;
    ligneGlissee = null;
    if (cible === depart || cible === depart + 1) {
      rafraichirTout();
      return;
    }
    reordonner(depart, cible > depart ? cible - 1 : cible);
  });

  table.addEventListener('dragend', () => {
    ligneGlissee = null;
    for (const a of table.querySelectorAll('.ligne--glissee, .ligne--cible-avant, .ligne--cible-apres')) {
      a.classList.remove('ligne--glissee', 'ligne--cible-avant', 'ligne--cible-apres');
    }
  });
}

/** Deplace un element d'une liste, du rang `de` au rang `vers`. */
function deplacer(liste, de, vers) {
  const copie = [...liste];
  const [x] = copie.splice(de, 1);
  copie.splice(vers, 0, x);
  return copie;
}

/** Rappel des gestes disponibles, une fois par grille. */
const AIDE_GRILLE =
  '⌨ Flèches pour se déplacer, Entrée pour descendre, Tab pour avancer. ' +
  'Un bloc copié depuis un tableur se colle tel quel à partir de la cellule sélectionnée.';

function tableMatrice(m) {
  // Le filtre porte sur les LIBELLES - celui de la ligne et le titre de la
  // matrice - pas sur les cellules, qui n'en ont pas : l'ancien test les
  // interrogeait et aucune ligne de matrice ne repondait jamais en recherche.
  const lignes = m.lignes.filter((l) => correspond({ libelle: `${m.titre} ${l.libelle}` }));
  if (!lignes.length) return '';
  return `
    <div class="para-matrice">
      <h4>${att(m.titre)}</h4>
      <div class="table-defilante"><table class="grille" data-grille>
        <thead><tr>
          ${coinGrille(m.coin)}
          ${m.zones.map((z) => `<th>${att(z)}</th>`).join('')}
        </tr></thead>
        <tbody>${lignes
          .map(
            (l, il) =>
              `<tr><td class="grille__entete">${att(l.libelle)}</td>` +
              l.cellules.map((c, ic) => celluleGrille(c.chemin, c.valeur, c.type, il, ic)).join('') +
              `</tr>`,
          )
          .join('')}</tbody>
      </table></div>
      <p class="grille__aide">${AIDE_GRILLE}</p>
    </div>`;
}

/**
 * Trajectoires : cinquante et une annees x cinq postes, soit deux cent
 * cinquante cases. On ne les saisit pas une a une - chaque colonne porte un
 * « tout » qui applique une valeur a l'ensemble des annees, et la grille reste
 * dessous pour les exceptions, repliee par defaut.
 */
let trajectoireDepliee = false;
function sectionTrajectoires() {
  const lignes = referentiels.trajectoires.trajectoires;
  const surcharges = parametrageActif().trajectoires?.par_annee ?? {};
  const visibles = trajectoireDepliee ? lignes : lignes.slice(0, 10);

  const enTete = POSTES_TRAJECTOIRE.map(
    (p) => `<th>${p.libelle}
      <button type="button" class="para-tout" data-appliquer-poste="${p.cle}"
        title="Appliquer une même valeur à toutes les années">tout</button></th>`,
  ).join('');

  return `
    <div class="para-matrice">
      <h4>Année par année
        <button type="button" class="bouton--discret" id="deplier-trajectoire">
          ${trajectoireDepliee ? 'Replier' : `Tout afficher (${lignes.length} années)`}</button>
      </h4>
      <div class="table-defilante"><table class="grille" data-grille>
        <thead><tr><th>Année</th>${enTete}</tr></thead>
        <tbody>${visibles
          .map(
            (l, il) =>
              `<tr><td class="grille__entete">${l.annee}</td>` +
              POSTES_TRAJECTOIRE.map((p, ic) =>
                celluleGrille(`trajectoires.par_annee.${l.annee}.${p.cle}`, l[p.cle], 'pourcentage', il, ic),
              ).join('') +
              `</tr>`,
          )
          .join('')}</tbody>
      </table></div>
      <p class="grille__aide">${AIDE_GRILLE}</p>
    </div>`;
}

/**
 * Taux resultant de chaque marge, sous sa carte. Rempli a part du reste : la
 * carte se redessine au changement de section sans que le moteur soit relance,
 * et le taux resterait alors a un tiret.
 */
function remplirTauxMarges(r) {
  if (!r) return;
  for (const cellule of document.querySelectorAll('[data-taux-marge]')) {
    const cle = /** @type {HTMLElement} */ (cellule).dataset.tauxMarge;
    const m = r.financement?.marges_prets?.[cle];
    cellule.textContent = nul(m?.valeur) || nul(r.financement?.livret_a_reference)
      ? '-'
      : pct(r.financement.livret_a_reference + m.valeur, 2);
  }
}

/** Barre de tete : profil actif et ses actions. */
function rendreBarreProfil() {
  const profil = profilActif();
  const total = modeleParametres().reduce((t, s) => t + nbModifies(s), 0);
  const estRef = profil.id === PROFIL_REFERENTIEL;
  const aSauver = profilNonSauve(profil);
  $('#para-profil').innerHTML = `
    <select id="select-profil" aria-label="Profil de paramètres">
      ${etat.profils
        .map((p) => `<option value="${att(p.id)}" ${p.id === profil.id ? 'selected' : ''}>${att(p.nom)}</option>`)
        .join('')}
    </select>
    <span class="para-tete__etat ${aSauver ? 'para-tete__etat--modifie' : ''}">
      ${
        total === 0
          ? 'aucune modification'
          : `${total} modification${total > 1 ? 's' : ''}${aSauver ? ' non sauvegardée' + (total > 1 ? 's' : '') : ''}`
      }
    </span>
    <span class="para-tete__actions">
      <!-- La sauvegarde ne parait que s'il y a quelque chose a sauver : un
           bouton toujours actif ne dit plus rien de l'etat du profil. -->
      <button type="button" class="bouton bouton--ajout" data-profil="sauvegarder" ${aSauver ? '' : 'hidden'}>Sauvegarder</button>
      <button type="button" class="bouton bouton--discret" data-profil="dupliquer">Dupliquer</button>
      <button type="button" class="bouton bouton--discret" data-profil="renommer">Renommer</button>
      <button type="button" class="bouton bouton--discret" data-profil="reinitialiser" ${total ? '' : 'disabled'}>↺ tout</button>
      <button type="button" class="bouton bouton--discret" data-profil="supprimer" ${estRef ? 'disabled' : ''}>Supprimer</button>
    </span>`;
}

/**
 * Rendu de la page « Explication des calculs ».
 *
 * Un SEUL texte source par calcul (MODELE_CALCULS), deux lectures :
 *   - `simple`  : ce que le calcul fait, dans les mots du metier ;
 *   - `support` : la meme chose avec le nom de la fonction, son fichier et sa
 *                 ligne, pour qui doit la maintenir.
 * L'interrupteur ne change ni l'ordre ni le decoupage : on lit la meme page
 * sous deux angles, et non deux pages qui pourraient diverger.
 */
/**
 * Cale la rangee de tete des calculs sous la barre de profil, au pixel.
 *
 * Les deux barres sont collantes : la barre de profil a 58 px du haut, la
 * rangee de tete juste dessous. Une valeur en dur laissait passer un filet de
 * texte de cinq pixels entre les deux - et ce filet changeait de hauteur des
 * que la barre de profil se repliait sur un ecran etroit. On mesure donc sa
 * hauteur reelle plutot que de la supposer.
 */
function calerTeteCalculs() {
  const tete = document.querySelector('.para-tete');
  if (!tete) return;
  // 58 px : la hauteur du bandeau d'application, ou la barre de profil vient
  // se coller. `getBoundingClientRect` donne la hauteur fractionnaire, que
  // `offsetHeight` arrondit - et c'est justement l'arrondi qui laissait passer
  // un demi-pixel de contenu.
  const haut = 58 + tete.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--haut-calculs', `${haut}px`);
}
window.addEventListener('resize', calerTeteCalculs);

/**
 * Etape actuellement en tete de fenetre, et sa distance au haut de l'ecran.
 *
 * Sert d'ancre au changement de lecture : les deux vues n'ont pas la meme
 * hauteur, la seule facon de ne pas perdre le lecteur est de reposer SON
 * etape la ou elle etait. On prend la premiere qui commence sous la barre
 * collante ; si aucune n'y est - on est tout en bas de la page - on prend la
 * derniere visible, sans quoi le bas de page n'aurait aucune ancre.
 */
function etapeEnTete() {
  const etapes = [...document.querySelectorAll('[data-calc-etape]')];
  if (!etapes.length) return null;
  const tete = document.querySelector('.calc-tete');
  const plancher = tete ? tete.getBoundingClientRect().bottom : 0;
  const choisie =
    etapes.find((e) => e.getBoundingClientRect().bottom > plancher) ?? etapes.at(-1);
  return {
    cle: /** @type {HTMLElement} */ (choisie).dataset.calcEtape,
    decalage: choisie.getBoundingClientRect().top,
  };
}

function rendreCalculs() {
  const support = lectureCalculs === 'support';
  const panneau = document.getElementById('para-calculs');
  if (!panneau) return;

  // La CLE d une etape est celle de son chapitre et de son rang : elle ne
  // depend ni de la lecture choisie ni du texte, donc elle survit au changement
  // de vue. C est l ancre de defilement de etapeEnTete.
  const etape = (e, n, idChapitre) => {
    const t = e.support ?? {};
    return `
      <article class="calc-etape" data-calc-etape="${att(idChapitre)}-${n}">
        <div class="calc-etape__rang">${n}</div>
        <div class="calc-etape__corps">
          <h4>${att(e.titre)}${(e.regles ?? [])
            .map((r) => `<span class="calc-regle">${att(r)}</span>`)
            .join('')}</h4>
          <p class="calc-etape__texte">${att(support && t.texte ? t.texte : e.simple)}</p>
          ${
            e.formule
              ? `<p class="calc-formule">${att(support && t.formule ? t.formule : e.formule)}</p>`
              : ''
          }
          ${
            // D'ou viennent les valeurs. Present dans les DEUX lectures : c'est
            // la question que tout le monde se pose devant un chiffre, et la
            // reponse - « ecran Programme », « Parametres > TVA » - est aussi
            // utile au gestionnaire qu'au developpeur.
            (e.entrees ?? []).length
              ? `<div class="calc-entrees">
                  <p class="calc-entrees__titre">D’où viennent les valeurs</p>
                  <dl>${e.entrees
                    .map(
                      ([terme, source]) =>
                        `<dt>${att(terme)}</dt><dd>${att(source)}</dd>`,
                    )
                    .join('')}</dl>
                </div>`
              : ''
          }
          ${
            support && t.source
              ? `<p class="calc-source"><code>${att(t.fonction ?? '')}</code>` +
                `<span class="calc-source__ou">${att(t.source)}</span></p>`
              : ''
          }
          ${
            // Fiche de maintenance : de quoi MODIFIER le calcul, pas seulement
            // le comprendre. La signature dit comment l'appeler, le code ce
            // qu'il fait vraiment, le referentiel ou changer une valeur SANS
            // toucher au code, la chaine ce qui casse si on s'y trompe, et les
            // tests le filet a relancer apres coup.
            support && (t.signature || t.code || t.referentiel || t.alimente || t.tests)
              ? `<dl class="calc-fiche">${[
                  ['Signature', t.signature, 'calc-fiche__mono'],
                  ['Dans le code', t.code, 'calc-fiche__mono'],
                  ['Référentiel', t.referentiel, ''],
                  ['Alimente', t.alimente, ''],
                  ['Tests', t.tests, 'calc-fiche__mono'],
                ]
                  .filter(([, v]) => v)
                  .map(
                    ([cle, v, classe]) =>
                      `<dt>${att(cle)}</dt><dd class="${classe}">${att(v)}</dd>`,
                  )
                  .join('')}</dl>`
              : ''
          }
          ${e.piege ? `<p class="calc-piege">${att(e.piege)}</p>` : ''}
        </div>
      </article>`;
  };

  // La recherche traverse cette page comme les autres : un chapitre ne parait
  // que s'il porte une etape qui repond. Elle porte sur TOUT le texte de
  // l'etape, formule et piege compris : « vacance » n'apparait que dans une
  // formule, et ne pas la trouver la ou elle est ecrite serait incomprehensible.
  const retenue = (ch, e) =>
    correspond({
      libelle: [
        ch.titre,
        e.titre,
        e.simple,
        e.formule ?? '',
        e.piege ?? '',
        e.support?.texte ?? '',
        e.support?.fonction ?? '',
        e.support?.source ?? '',
        // La fiche de maintenance est cherchable elle aussi : on trouve une
        // etape par le nom d'une cle de referentiel ou par son fichier de test,
        // ce qui est souvent le point d'entree quand on vient du code.
        e.support?.signature ?? '',
        e.support?.code ?? '',
        e.support?.referentiel ?? '',
        e.support?.alimente ?? '',
        e.support?.tests ?? '',
        (e.entrees ?? []).flat().join(' '),
        (e.regles ?? []).join(' '),
      ].join(' '),
    });

  const chapitres = MODELE_CALCULS.map((ch) => ({ ch, etapes: ch.etapes.filter((e) => retenue(ch, e)) }))
    .filter(({ etapes }) => etapes.length)
    .map(
      ({ ch, etapes }) => `
        <section class="bloc para-section calc-chapitre">
          <h3>${att(ch.titre)}</h3>
          <p class="para-source">${att(ch.accroche)}</p>
          <div class="calc-etapes">${etapes.map((e, i) => etape(e, i + 1, ch.id)).join('')}</div>
        </section>`,
    )
    .join('');

  // Le titre et l'interrupteur sur une seule rangee, et cette rangee COLLE en
  // haut au defilement : la page fait plusieurs ecrans de long, et c'est en
  // plein milieu d'un chapitre qu'on veut basculer entre les deux lectures.
  // Seule la rangee est collante, pas le bandeau : un bandeau entier fige a
  // l'ecran mangerait la moitie de la hauteur utile.
  panneau.innerHTML =
    `<div class="calc-tete">
      <h3>Explication des calculs</h3>
      <div class="choix calc-lecture" role="group" aria-label="Niveau de détail">
        <button type="button" class="choix__option ${support ? '' : 'choix__option--actif'}"
          data-lecture="simple">En clair</button>
        <button type="button" class="choix__option ${support ? 'choix__option--actif' : ''}"
          data-lecture="support">Support technique</button>
      </div>
    </div>` +
    (chapitres ||
      `<section class="bloc"><p class="vide">Aucun calcul ne correspond à « ${att(rechercheParametre)} ».</p></section>`);
}

function rendreParametres() {
  const sections = modeleParametres();
  rendreBarreProfil();

  // En recherche, le rail s'efface et une VISU TEMPORAIRE prend toute la
  // largeur : tous les parametres qui repondent au nom tape, quelle que soit
  // leur categorie, chacun etiquete de sa section d'origine. Vider la barre
  // ramene la vue par sections exactement ou elle etait.
  const enRecherche = rechercheParametre.trim().length > 0;
  document.querySelector('.para-corps')?.classList.toggle('para-corps--recherche', enRecherche);

  // Le rail est groupe en RUBRIQUES : d'un cote les hypotheses de la
  // simulation, de l'autre les baremes et regles de l'organisme. Les deux se
  // reglaient au meme endroit sans rien qui les distingue, alors qu'ils n'ont
  // ni la meme portee - l'une suit l'operation, l'autre le profil - ni le meme
  // public.
  const item = (s) => {
    const n = nbModifies(s);
    const actif = s.id === sectionParametres && !enRecherche;
    return `<button type="button" class="para-rail__item ${actif ? 'para-rail__item--actif' : ''}"
      data-section="${s.id}">
      <span class="para-rail__titre">${att(s.titre)}</span>
      <span class="para-rail__resume">${att(s.resume)}</span>
      ${n ? `<span class="para-rail__compteur">${n}</span>` : ''}
    </button>`;
  };
  const rubrique = (titre, lot) =>
    lot.length
      ? `<p class="para-rail__rubrique">${att(titre)}</p>${lot.map(item).join('')}`
      : '';
  $('#para-rail').innerHTML =
    rubrique(
      "Hypothèses d'exploitation",
      sections.filter((s) => s.rubrique === 'exploitation'),
    ) +
    rubrique('Calculs', sections.filter((s) => s.rubrique === 'calculs')) +
    rubrique(
      'Admin',
      sections.filter((s) => s.rubrique !== 'exploitation' && s.rubrique !== 'calculs'),
    );

  const bloc = (s) => {
    const champs = (s.champs ?? []).filter(correspond);
    const matrices = (s.matrices ?? []).map(tableMatrice).filter(Boolean);
    const traj = s.trajectoires && !enRecherche ? sectionTrajectoires() : '';
    if (s.jalons) {
      const t = tableJalons();
      return t
        ? `<section class="bloc para-section">
            <h3>${att(s.titre)}</h3>
            <p class="para-source">${att(s.aide)}</p>
            ${t}
          </section>`
        : '';
    }
    if (s.presets) {
      const t = tablePresets();
      if (!t && !champs.length) return '';
      return `<section class="bloc para-section">
        <h3>${att(s.titre)}</h3>
        <p class="para-source">${att(s.aide)}</p>
        ${
          champs.length
            ? `<div class="para-matrice"><h4>Socle des prêts indexés</h4>
                <div class="para-grille">${champs.map(carteParametre).join('')}</div></div>`
            : ''
        }
        ${t}
      </section>`;
    }
    if (!champs.length && !matrices.length && !traj) return '';
    return `
      <section class="bloc para-section">
        <h3>${att(s.titre)}</h3>
        <p class="para-source">${att(s.aide)}</p>
        ${champs.length ? `<div class="para-grille">${champs.map(carteParametre).join('')}</div>` : ''}
        ${matrices.join('')}
        ${traj}
      </section>`;
  };

  const panneauHypotheses = document.getElementById('para-hypotheses');

  if (enRecherche) {
    // ---- Visu temporaire de recherche : liste a plat, toutes categories ----
    // Un titre de section qui repond ramene TOUS ses parametres : chercher
    // « prêt » doit sortir la grille CDC entiere, pas seulement les champs
    // dont le libelle porte le mot.
    const suspendue = (fn) => {
      const q = rechercheParametre;
      rechercheParametre = '';
      const h = fn();
      rechercheParametre = q;
      return h;
    };
    const morceaux = [];
    let nbResultats = 0;
    const origine = (titre) => `<p class="para-resultat__origine">${att(titre)}</p>`;

    for (const s of sections.filter((x) => x.id !== 'hypotheses')) {
      const titreRepond = correspond({ libelle: s.titre });
      const champs = (s.champs ?? []).filter((c) => titreRepond || correspond(c));
      if (champs.length) {
        nbResultats += champs.length;
        morceaux.push(
          `<div class="para-grille">${champs.map((c) => carteParametre(c, s.titre)).join('')}</div>`,
        );
      }
      const matrices = (s.matrices ?? [])
        .map((m) => (titreRepond ? suspendue(() => tableMatrice(m)) : tableMatrice(m)))
        .filter(Boolean);
      if (matrices.length) {
        nbResultats += (s.matrices ?? []).reduce(
          (n, m) =>
            n +
            (titreRepond
              ? m.lignes.length
              : m.lignes.filter((l) => correspond({ libelle: `${m.titre} ${l.libelle}` })).length),
          0,
        );
        morceaux.push(origine(s.titre) + matrices.join(''));
      }
      if (s.presets) {
        const t = titreRepond ? suspendue(tablePresets) : tablePresets();
        if (t) {
          nbResultats += titreRepond
            ? listePresets().length
            : listePresets().filter((x) => correspond({ libelle: `${x.libelle} ${x.note ?? ''}` })).length;
          morceaux.push(origine(s.titre) + t);
        }
      }
      if (s.jalons) {
        const t = titreRepond ? suspendue(tableJalons) : tableJalons();
        if (t) {
          nbResultats += titreRepond
            ? listeJalons().length
            : listeJalons().filter((x) => correspond({ libelle: x.libelle ?? '' })).length;
          morceaux.push(origine(s.titre) + t);
        }
      }
      // La table annuelle repond par le nom d'un de ses postes (Livret A,
      // IRL, TFPB...) ou par le titre de sa section : c'est elle, entiere,
      // qui est alors le parametre a montrer.
      if (
        s.trajectoires &&
        (titreRepond || POSTES_TRAJECTOIRE.some((p) => correspond({ libelle: p.libelle })))
      ) {
        nbResultats += 1;
        morceaux.push(origine(s.titre) + sectionTrajectoires());
      }
    }

    // Les hypotheses d'exploitation sont du markup statique : leurs champs qui
    // repondent sont CLONES dans les resultats - meme data-champ, donc meme
    // ecriture par delegation - et le panneau d'origine reste cache. Il est
    // resynchronise depuis l'etat quand la recherche se vide.
    panneauHypotheses.hidden = true;
    const hypos = [...panneauHypotheses.querySelectorAll('label.champ')].filter((ch) => {
      const libelle = ch.querySelector(':scope > span')?.textContent ?? '';
      return ch.querySelector('[data-champ]') && correspond({ libelle });
    });
    if (hypos.length) {
      nbResultats += hypos.length;
      morceaux.push(
        origine("Hypothèses d'exploitation") +
          `<div class="champs" id="resultats-hypotheses"></div>`,
      );
    }

    $('#contenu-parametres').innerHTML = nbResultats
      ? `<section class="bloc para-section para-resultats">
          <h3>${nbResultats} paramètre${nbResultats > 1 ? 's' : ''} pour « ${att(rechercheParametre.trim())} »</h3>
          ${morceaux.join('')}
        </section>`
      : `<section class="bloc"><p class="vide">Aucun paramètre ne correspond à « ${att(rechercheParametre)} ».</p></section>`;

    const cible = document.getElementById('resultats-hypotheses');
    if (cible) {
      for (const ch of hypos) cible.appendChild(ch.cloneNode(true));
      // Les valeurs viennent de l'ETAT, pas des champs d'origine : un champ
      // clone puis modifie laisse son original en retard le temps de la
      // recherche, et l'etat est la seule source qui ne ment pas.
      rendreChampsStatiques(cible);
    }
  } else {
    // Les hypotheses sont du markup statique : on les MONTRE, on ne les
    // regenere pas.
    panneauHypotheses.hidden = sectionParametres !== 'hypotheses';

    const affichees = sections.filter(
      (s) => s.id === sectionParametres && s.id !== 'hypotheses' && s.id !== 'calculs',
    );
    $('#contenu-parametres').innerHTML = affichees.map(bloc).filter(Boolean).join('');
  }

  // La page des calculs se rend dans son propre panneau : en recherche elle
  // parait des qu'une etape repond, sinon quand sa section est ouverte.
  const panneauCalculs = document.getElementById('para-calculs');
  if (panneauCalculs) {
    const visible = enRecherche || sectionParametres === 'calculs';
    panneauCalculs.hidden = !visible;
    if (visible) {
      rendreCalculs();
      // La barre de profil vient d'etre redessinee : sa hauteur peut avoir
      // change (un nom de profil plus long, un compteur qui apparait), et la
      // rangee de tete se cale dessus.
      calerTeteCalculs();
    }
    // En recherche, le panneau ne doit pas afficher son en-tete si rien ne
    // repond : `rendreCalculs` a alors produit le message d'absence, que le
    // bloc de resultats porte deja. On masque dans ce cas.
    if (enRecherche && panneauCalculs.querySelector('.vide')) panneauCalculs.hidden = true;
  }
  remplirTauxMarges(dernierResultat);
  // Reordonnancement des modeles. La table est reconstruite a chaque rendu :
  // les ecouteurs se reposent donc ici, et la garde `data-glisser-pose` evite
  // de les empiler sur une table qui aurait survecu.
  poserGlisser(document.getElementById('table-presets'), (de, vers) => {
    ecrireSaisie('baremes.presets_prets.presets', deplacer(listePresets(), de, vers));
    rafraichirTout();
  });
  poserGlisser(document.getElementById('table-jalons'), (de, vers) => {
    ecrireSaisie('baremes.tresorerie.jalons_vefa.jalons', deplacer(listeJalons(), de, vers));
    rafraichirTout();
  });
}


// ---------------------------------------------------------------- boucle de calcul

let dernierResultat = null;

/** Saisies obligatoires : on refuse de calculer avec un zero implicite. */
function champsManquants() {
  const m = [];
  const d = etat.dates;
  if (nul(d.duree_simulation_ans)) m.push('durée de simulation');
  if (!d.date_livraison && (nul(d.date_debut_travaux) || nul(d.duree_chantier_mois))) {
    m.push('calendrier (début des travaux et durée de chantier, ou date de livraison)');
  }
  if (!etat.lots.length) m.push('au moins un lot au programme');
  etat.lots.forEach((l, i) => {
    if (nul(l.shab_m2)) m.push(`SHAB du lot ${i + 1}`);
  });
  if (etat.mode_prets === 'saisis') {
    etat.prets.forEach((p, i) => {
      const nom = p.libelle || `prêt ${i + 1}`;
      // Un pret CDC rattache a une tranche tire son taux et sa duree du produit
      // (R-AMT-1), et son montant du besoin d'equilibre : exiger leur saisie
      // reclamerait ce que le moteur sait deja. Seul un pret « autre », ou un
      // pret sans tranche, doit etre entierement decrit.
      // Une MARGE suffit : le taux en decoule (Livret A + marge). Un modele de
      // pret ne pose souvent que la marge, et reclamer le taux par-dessus
      // reviendrait a demander deux fois la meme grandeur.
      const resolu = (Boolean(p.produit) && p.nature !== 'autre') || !nul(p.spread);
      if (nul(p.taux) && !resolu) m.push(`taux du ${nom}`);
      if (nul(p.duree_ans) && !resolu) m.push(`durée du ${nom}`);
      if (nul(p.montant_eur) && p.montant_auto !== true) m.push(`montant du ${nom}`);
    });
  }
  return m;
}

function recalculer() {
  const pastille = $('#etat-calcul');
  const erreur = $('#erreur');

  // Unique point de passage pour la memorisation : TOUT ce qui touche a l'etat
  // finit par recalculer, y compris les gestes qui ne sont pas des frappes -
  // bascule de ventilation, ajout de pret, changement de profil. L'accrocher
  // aux seuls evenements de saisie en aurait laisse la moitie de cote. La
  // saisie se memorise meme incomplete : c'est un brouillon, pas un depot.
  memoriserSaisie();

  // Le zonage se deduit de la commune, qui se saisit lettre par lettre : il doit
  // etre reevalue a chaque frappe, et non au seul rendu de structure. Il doit
  // aussi l'etre AVANT le calcul, puisqu'il en change les loyers plafonds.
  rendreZonage();
  remplirSelectsProfil();

  const manquants = champsManquants();
  if (manquants.length) {
    erreur.hidden = false;
    erreur.textContent = `Saisie incomplète : ${manquants.join(', ')}.`;
    pastille.textContent = 'incomplet';
    pastille.className = 'pastille pastille--calcul';
    viderRestitution('Saisie incomplète.');
    return;
  }

  try {
    // Le moteur est pur : on peut l'appeler a chaque frappe sans effet de bord.
    // En mode « CDC theoriques », l'absence de pret saisi declenche le calcul
    // theorique (R-FIN-4).
    const entrees = structuredClone(etat);
    // R-PARAM - Le moteur ne connait pas les profils, seulement LE parametrage
    // a appliquer. Les resoudre ici garde le moteur ignorant d'une notion qui
    // ne le regarde pas, et l'export JSON conserve la liste complete.
    entrees.parametrage = structuredClone(parametrageActif());
    if (etat.mode_prets === 'theoriques') entrees.prets = [];
    // Un poste sans montant vaut « non utilise » : il ne doit pas entrer dans le
    // bilan, sinon la nomenclature entiere y figurerait a zero.
    entrees.postes_bilan = entrees.postes_bilan.filter((p) => !nul(p.montant_ht_eur));
    const r = calculer(entrees, referentiels);
    dernierResultat = r;
    erreur.hidden = true;
    rendreCalendrier(r);
    rendreFiligraneTFPB(r);
    rendreValeurs(r);
    pastille.textContent = 'à jour';
    pastille.className = 'pastille pastille--ok';
  } catch (e) {
    dernierResultat = null;
    erreur.hidden = false;
    erreur.textContent = `Calcul impossible : ${/** @type {Error} */ (e).message}`;
    pastille.textContent = 'erreur';
    pastille.className = 'pastille pastille--calcul';
    viderRestitution(/** @type {Error} */ (e).message);
  }
}

/** Reconstruit la structure de saisie puis recalcule (ajout, suppression, changement de produit). */
/**
 * Reconstruit la structure de saisie puis recalcule.
 *
 * Les ecrans de TRANCHE sont regeneres a chaque passage, donc leur attribut
 * `hidden` repart a sa valeur par defaut : sans memoriser l'ecran actif, tout
 * rafraichissement structurel depuis un ecran de tranche (deplier un pret,
 * cocher une charge) renverrait l'utilisateur sur l'ecran Operation.
 */
function rafraichirTout() {
  const actif = document.querySelector('[data-ecran][aria-selected="true"]');
  const cible = /** @type {HTMLElement|null} */ (actif)?.dataset.ecran;
  rendreStructure();
  if (cible) afficherEcran(cible);
  recalculer();
  // La STRUCTURE lit parfois le resultat du moteur - le taux de TVA par defaut
  // d'une tranche, par exemple, qui vient du bareme fusionne. Rendue avant le
  // calcul, elle affiche celui du coup precedent. On la redessine donc une fois
  // le resultat connu, et seulement si ce resultat a change quelque chose
  // qu'elle porte : sans cette garde, chaque frappe couterait deux rendus.
  const empreinte = JSON.stringify(dernierResultat?.bilan?.taux_lasm_par_tranche ?? null);
  if (empreinte !== empreinteTauxTVA) {
    empreinteTauxTVA = empreinte;
    rendreStructure();
    if (cible) afficherEcran(cible);
    recalculer();
  }
}

/** Derniers taux de TVA par tranche rendus : voir `rafraichirTout`. */
let empreinteTauxTVA = null;

/**
 * Positionne le curseur du bandeau sur l'onglet actif.
 *
 * Le curseur est un element UNIQUE (#onglets-curseur) qui glisse d'un onglet a
 * l'autre : le mouvement relie l'ecran quitte a l'ecran atteint, la ou un fond
 * qui s'eteint ici et se rallume la ne raconte rien. Il est mesure plutot que
 * stylise parce que les onglets de tranche naissent et meurent avec le
 * programme : aucune position n'est connue d'avance.
 *
 * Sur un onglet de tranche, il prend la couleur de la tranche - la meme
 * identite que partout ailleurs dans l'application.
 */
function positionnerCurseurOnglets() {
  const nav = document.getElementById('onglets');
  const curseur = document.getElementById('onglets-curseur');
  if (!nav || !curseur) return;
  const actif = /** @type {HTMLElement|null} */ (nav.querySelector('.onglet[aria-selected="true"]'));
  if (!actif) {
    curseur.style.opacity = '0';
    return;
  }
  // offsetLeft/offsetTop sont relatifs au rail (position: relative), y compris
  // pour les onglets de tranche imbriques dans leur span : le curseur suit donc
  // le defilement horizontal du rail sans correction.
  curseur.style.opacity = '1';
  curseur.style.transform = `translate(${actif.offsetLeft}px, ${actif.offsetTop}px)`;
  curseur.style.width = `${actif.offsetWidth}px`;
  curseur.style.height = `${actif.offsetHeight}px`;
  const tranche = actif.classList.contains('onglet--tranche');
  curseur.classList.toggle('onglets__curseur--tranche', tranche);
  if (tranche) curseur.style.setProperty('--cat', actif.style.getPropertyValue('--cat'));
  else curseur.style.removeProperty('--cat');
  // Un onglet sorti du rail par le defilement doit y revenir : le curseur ne
  // sert a rien sous un onglet invisible.
  actif.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  // Le rail ne se saisit que s'il a de quoi defiler : un curseur de prehension
  // sur un rail complet promet un geste qui ne ferait rien.
  nav.classList.toggle('rail--glissable', nav.scrollWidth > nav.clientWidth + 1);
}

/**
 * DEFILEMENT AU GLISSER sur un rail horizontal.
 *
 * Le rail des onglets defile deja, mais sans barre visible - elle se lisait
 * comme un soulignement sous les onglets et brouillait l'onglet actif. Restait
 * la molette, et rien ne disait qu'il y avait quelque chose a aller voir. On
 * attrape donc le rail et on le tire.
 *
 * Le geste ne devient un DEFILEMENT qu'au-dela de quelques pixels : en deca il
 * reste un clic, et l'onglet s'ouvre normalement. Passe ce seuil, le clic de
 * fin est avale - sans quoi relacher la souris sur un onglet l'activerait alors
 * qu'on n'a fait que le faire passer sous le curseur.
 *
 * Le tactile est laisse de cote : il fait deja defiler d'un doigt, avec
 * l'inertie que le systeme sait rendre et que ce code ne saurait pas imiter.
 */
function poserDefilementAuGlisser(rail) {
  if (!rail || rail.dataset.glisserPose) return;
  rail.dataset.glisserPose = '1';
  const SEUIL = 4;
  let actif = false;
  let deplace = false;
  let departX = 0;
  let departScroll = 0;

  rail.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.pointerType === 'touch') return;
    if (rail.scrollWidth <= rail.clientWidth + 1) return;
    actif = true;
    deplace = false;
    departX = ev.clientX;
    departScroll = rail.scrollLeft;
  });

  rail.addEventListener('pointermove', (ev) => {
    if (!actif) return;
    const dx = ev.clientX - departX;
    if (!deplace) {
      if (Math.abs(dx) < SEUIL) return;
      deplace = true;
      rail.classList.add('rail--glisse');
      // La capture garde le geste meme quand le curseur sort du rail : sans
      // elle, tirer un peu vite lachait le rail en cours de route.
      try {
        rail.setPointerCapture(ev.pointerId);
      } catch {
        /* le navigateur refuse la capture : le glisser marche quand meme tant
           que le curseur reste sur le rail */
      }
    }
    rail.scrollLeft = departScroll - dx;
    ev.preventDefault();
  });

  const finir = (ev) => {
    if (!actif) return;
    actif = false;
    if (!deplace) return;
    rail.classList.remove('rail--glisse');
    try {
      rail.releasePointerCapture(ev.pointerId);
    } catch {
      /* deja relachee */
    }
    const avaler = (e) => {
      e.stopPropagation();
      e.preventDefault();
    };
    rail.addEventListener('click', avaler, { capture: true });
    // Le clic suit immediatement le relachement ; le retrait differe d'un tour
    // de boucle le laisse passer, puis desarme. Sans ce retrait, un glisser
    // fini hors d'un onglet - donc sans clic - avalerait le clic SUIVANT.
    setTimeout(() => rail.removeEventListener('click', avaler, { capture: true }), 0);
  };
  rail.addEventListener('pointerup', finir);
  rail.addEventListener('pointercancel', finir);
}

poserDefilementAuGlisser(document.getElementById('onglets'));

// Le rail change de largeur avec la fenetre et au chargement des polices :
// dans les deux cas les onglets se deplacent sous un curseur devenu faux.
window.addEventListener('resize', positionnerCurseurOnglets);
if (document.fonts?.ready) document.fonts.ready.then(positionnerCurseurOnglets);

/** Bascule l'affichage vers un ecran, onglets et panneaux d'un seul tenant. */
function afficherEcran(cible) {
  const existe = document.getElementById(`ecran-${cible}`);
  // La tranche affichee peut avoir disparu entre-temps (dernier lot supprime) :
  // on retombe alors sur le programme plutot que sur une page blanche.
  const vise = existe ? cible : 'programme';
  for (const o of document.querySelectorAll('[data-ecran]')) {
    o.setAttribute('aria-selected', String(/** @type {HTMLElement} */ (o).dataset.ecran === vise));
  }
  positionnerCurseurOnglets();
  for (const e of document.querySelectorAll('.ecran')) {
    /** @type {HTMLElement} */ (e).hidden = e.id !== `ecran-${vise}`;
  }
  if (vise === 'sensibilite') rendreSensibilite();

  // L'ecran affiche se retient : recharger la page pour reprendre au programme
  // alors qu'on travaillait sur l'exploitation coute une navigation a chaque
  // fois. Il est memorise a part de la saisie - c'est une position de lecture,
  // pas une donnee d'operation, et il ne doit pas disparaitre avec une
  // reinitialisation.
  try {
    localStorage.setItem(CLE_ECRAN, vise);
  } catch {
    /* voir memoriserSaisie */
  }
  if (vise === 'parametres') rendreParametres();
  // L'apercu est un CLONE des ecrans : il se refait a chaque arrivee sur
  // l'onglet, sinon il montrerait le dossier tel qu'il etait la fois d'avant.
  if (vise === 'exports') rendreApercuExport();
}

/**
 * Theme clair ou sombre. Le sombre est celui de l'application ; le clair sert a
 * l'impression et a la videoprojection, ou un fond noir passe mal.
 * Persiste dans localStorage quand il est disponible - la version autonome
 * ouverte en file:// y a droit aussi.
 */
const CLE_THEME = 'moteur-sim.theme';
function appliquerTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const b = document.getElementById('btn-theme');
  if (b) {
    b.textContent = theme === 'clair' ? '☾' : '☀';
    b.setAttribute('aria-label', theme === 'clair' ? 'Passer en thème sombre' : 'Passer en thème clair');
    b.title = b.getAttribute('aria-label') ?? '';
  }
  try {
    localStorage.setItem(CLE_THEME, theme);
  } catch {
    // Stockage indisponible (navigation privee, restrictions file://) : le
    // theme reste actif pour la session, seule la memoire est perdue.
  }
}
function themeInitial() {
  try {
    const t = localStorage.getItem(CLE_THEME);
    if (t === 'clair' || t === 'sombre') return t;
  } catch {
    /* voir appliquerTheme */
  }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'clair' : 'sombre';
}

// ------------------------------------------------------------- persistance

/**
 * Memorisation de la saisie d’une ouverture a l’autre.
 *
 * Le moteur reste pur : rien n est stocke de son cote, on ne persiste que la
 * SAISIE - l’operation et les profils de parametres. Les resultats se
 * recalculent a l’ouverture, ce qui garantit qu’une saisie memorisee hier ne
 * ressort pas avec les chiffres d’hier si le moteur a change depuis.
 *
 * Le STOCKAGE lui-meme n est plus ici : il appartient au depot (ui/depot.js),
 * qui porte les cles, leur version et la reprise de l’ancienne simulation
 * unique. Ce fichier ne connait qu un identifiant de simulation ouverte.
 */

/** Ecran affiche. Memorise a part : c'est une position de lecture, pas une donnee. */
const CLE_ECRAN = 'moteur-sim.ecran';

/** Les seules racines memorisees : ce que l'utilisateur a saisi, rien d'autre. */
const RACINES_PERSISTEES = [
  'identite', 'dates', 'lots', 'postes_bilan', 'loyers_par_produit', 'subventions',
  'fonds_propres_par_produit', 'taux_apport_par_produit', 'remuneration_fonds_propres',
  'regimes_par_produit', 'tresorerie',
  'mode_prets', 'prets',
  'exploitation', 'profils', 'profil_actif', 'options',
];

let sauvegardeEnAttente = null;

/**
 * Ecrit la saisie, une fois les frappes retombees. Sauver a chaque caractere
 * serait un acces disque par touche pour un etat qui n'aura de sens qu'une fois
 * le nombre entier.
 */
/** La simulation ouverte : c'est elle que la saisie ecrit. */
let idSimulationOuverte = null;

/**
 * La simulation TELLE QU'ELLE ETAIT a l'ouverture.
 *
 * La saisie s'enregistre toute seule, ce qui protege d'une fermeture d'onglet
 * ou d'une coupure. Mais « enregistre en continu » et « valide » ne sont pas
 * la meme chose : on essaie une variante, on veut pouvoir la jeter. Cet
 * instantane est le point de retour, et c'est lui qui rend « abandonner les
 * modifications » possible sans renoncer a l'enregistrement automatique.
 */
let etatAuChargement = null;

/** Y a-t-il des modifications depuis l'ouverture du dossier ? */
function modificationsEnAttente() {
  if (!idSimulationOuverte || !etatAuChargement) return false;
  return JSON.stringify(simulationCourantePayload()) !== etatAuChargement;
}

/**
 * Recharger ou fermer l'onglet avec des modifications en attente demande
 * confirmation.
 *
 * La saisie s'enregistre toute seule, donc rien n'est perdu au sens strict -
 * mais « enregistre » n'est pas « valide ». On essaie une variante, on ferme
 * la fenetre par reflexe, et l'essai devient la version de reference sans
 * qu'on l'ait voulu. Ce garde-fou laisse le temps de choisir.
 *
 * Le navigateur impose son propre libelle : on ne peut ni le personnaliser ni
 * le remplacer par la boite de l'application, une page ne pouvant pas retenir
 * une fermeture derriere un dialogue qu'elle dessine elle-meme.
 */
window.addEventListener('beforeunload', (ev) => {
  if (!modificationsEnAttente()) return;
  ev.preventDefault();
  // `returnValue` reste exige par plusieurs navigateurs pour declencher la
  // demande, meme si sa valeur n'est plus affichee nulle part.
  ev.returnValue = '';
});

/** Ce qui part au depot : la saisie, et rien d'autre. */
function simulationCourantePayload() {
  return Object.fromEntries(RACINES_PERSISTEES.map((c) => [c, etat[c]]));
}

function memoriserSaisie() {
  clearTimeout(sauvegardeEnAttente);
  sauvegardeEnAttente = setTimeout(() => {
    if (!idSimulationOuverte) return;
    const fiche = ecrireSimulation(idSimulationOuverte, simulationCourantePayload());
    // Le depot rend null quand le stockage a refuse - quota depasse, navigation
    // privee. On le DIT : une saisie qu'on croit enregistree et qui ne l'est
    // pas est la pire des issues.
    if (!fiche) {
      const e = $('#erreur');
      e.hidden = false;
      e.textContent =
        'Enregistrement impossible : le stockage du navigateur est plein ou indisponible. ' +
        'Exportez la simulation pour ne rien perdre.';
      return;
    }
    majNomSimulationOuverte(fiche.nom);
  }, 400);
}

/** Le nom de la simulation ouverte, dans la marque de l'en-tete. */
function majNomSimulationOuverte(nom) {
  const el = document.getElementById('nom-simulation-ouverte');
  if (!el) return;
  // Aucune simulation ouverte : le bouton le DIT, plutot que d'afficher le nom
  // de la derniere - on croirait travailler dessus.
  el.textContent = idSimulationOuverte ? nom || 'Simulation sans nom' : 'Aucune simulation';
  el.closest('.entete__dossier')?.classList.toggle('entete__dossier--vide', !idSimulationOuverte);
}

/**
 * Relit la saisie memorisee et la pose sur l'etat de depart. Les racines sont
 * REMPLACEES et non fusionnees : une liste de prets memorisee doit rester celle
 * qui a ete saisie, pas se melanger a celle de la demonstration.
 */
/**
 * Pose une simulation du depot sur l'etat de travail.
 *
 * Les racines sont REMPLACEES et non fusionnees : les prets d'une simulation
 * ouverte doivent etre les siens, pas un melange avec ceux de la precedente.
 * Les racines absentes gardent leur valeur de demonstration, ce qui permet
 * d'ouvrir une simulation ancienne a laquelle une racine a ete ajoutee depuis.
 */
function poserSimulation(sim) {
  if (!sim || typeof sim !== 'object' || !sim.identite) return false;
  for (const cle of RACINES_PERSISTEES) {
    if (sim[cle] !== undefined) etat[cle] = sim[cle];
  }
  // Un profil actif qui ne designe plus rien laisserait l'ecran sans
  // parametres : on retombe sur le premier profil connu.
  if (!etat.profils?.some((p) => p.id === etat.profil_actif)) {
    etat.profil_actif = etat.profils?.[0]?.id ?? 'referentiel';
  }
  return true;
}

/**
 * Ouvre une simulation : elle devient celle que la saisie ecrit.
 * @param {string} id
 * @param {boolean} [versEcran] basculer sur l'ecran Operation apres ouverture
 */
function ouvrirSimulationDansEcran(id, versEcran = true) {
  const sim = lireSimulation(id);
  if (!poserSimulation(sim)) {
    informerBoite('Simulation illisible', 'Son contenu est corrompu ou incomplet : elle n’a pas pu être ouverte.');
    return false;
  }
  idSimulationOuverte = ouvrirSimulation(id);
  // Point de retour du dossier : ce a quoi  abandonner les modifications 
  // ramenera. Pose APRES la mise en etat, pour refleter ce qui est a l ecran.
  etatAuChargement = JSON.stringify(simulationCourantePayload());
  majNomSimulationOuverte(sim.identite?.nom);
  majAccesMontage();
  // Les champs STATIQUES - identite, calendrier, hypotheses - ne sont ecrits
  // que par `rendreChampsStatiques` : `rafraichirTout` ne redessine que les
  // tables. Sans cet appel, ouvrir une simulation laisse a l'ecran le nom, la
  // version et les dates de la PRECEDENTE, et la premiere frappe les recopie
  // dans la nouvelle. C'est une corruption silencieuse, pas un defaut
  // d'affichage.
  rendreChampsStatiques();
  rafraichirTout();
  if (versEcran) afficherEcran('operation');
  return true;
}

/**
 * Reprend le travail LA OU IL EN ETAIT : meme dossier, meme ecran, meme
 * saisie.
 *
 * Un rechargement n'est pas une decision de l'utilisateur - c'est un F5, une
 * mise a jour, un plantage du navigateur. Le renvoyer a la bibliotheque lui
 * ferait rouvrir son dossier et retrouver son onglet a chaque fois. La saisie
 * etant enregistree en continu, il n'y a rien a perdre a la reprendre.
 *
 * Aucun dossier ouvert reste un etat valide : on arrive alors sur la
 * bibliotheque, et rien ne s'ecrit tant qu'on n'a rien ouvert.
 *
 * @returns {boolean} vrai si un dossier a ete rouvert
 */
function restaurerSaisie() {
  // Reprise de l'ancienne cle unique, une seule fois : sans elle, la mise a
  // jour de l'outil ferait disparaitre le travail en cours de chacun.
  reprendreHeritage();

  const vise = simulationCourante();
  const existe = vise && listerSimulations().some((f) => f.id === vise);
  if (!existe) {
    fermerSimulation();
    return false;
  }
  const sim = lireSimulation(vise);
  if (!poserSimulation(sim)) {
    fermerSimulation();
    return false;
  }
  idSimulationOuverte = vise;
  // Le point de retour repart de l'etat RESTAURE : ce qui etait enregistre
  // avant le rechargement est acquis, pas « en attente ». Sans cela, le seul
  // fait de recharger armerait la confirmation de fermeture.
  etatAuChargement = JSON.stringify(simulationCourantePayload());
  majNomSimulationOuverte(sim.identite?.nom);
  majAccesMontage();
  return true;
}

/**
 * Referme la simulation ouverte.
 *
 * @param {'enregistrer'|'abandonner'} issue ce qu'on fait des modifications
 */
function fermerSimulation(issue = 'enregistrer') {
  clearTimeout(sauvegardeEnAttente);
  if (idSimulationOuverte) {
    // « Abandonner » reecrit l'instantane d'ouverture par-dessus ce que
    // l'enregistrement automatique a depose entre-temps : c'est le seul moyen
    // de defaire des modifications deja ecrites.
    const aEcrire =
      issue === 'abandonner' && etatAuChargement
        ? JSON.parse(etatAuChargement)
        : simulationCourantePayload();
    ecrireSimulation(idSimulationOuverte, aEcrire);
  }
  idSimulationOuverte = null;
  etatAuChargement = null;
  ouvrirSimulation(null);
  majNomSimulationOuverte(null);
  majAccesMontage();
}

/**
 * Les onglets de montage n'ont de sens qu'avec un dossier ouvert.
 *
 * Sans cette garde, on saisirait dans le vide : `memoriserSaisie` refuse
 * d'ecrire sans simulation ouverte, et le travail serait perdu au premier
 * rechargement sans qu'aucun message ne l'ait annonce.
 */
function majAccesMontage() {
  const actif = Boolean(idSimulationOuverte);
  document.body.classList.toggle('sans-simulation', !actif);
  for (const o of document.querySelectorAll('#onglets .onglet')) {
    const b = /** @type {HTMLButtonElement} */ (o);
    b.disabled = !actif;
    b.title = actif ? '' : 'Ouvrez une simulation pour accéder au montage';
  }
}

// ---------------------------------------------------------------- bibliotheque

/** Filtre texte de la liste des simulations. */
let rechercheSimulation = '';
/**
 * Filtres par colonne, indexes par l'identifiant du select qui les porte.
 *
 * Un seul aujourd'hui, le produit : la recherche libre couvre deja le numero,
 * le nom et la commune, et empiler des menus pour des colonnes deja
 * cherchables coutait une rangee entiere de bandeau. La forme reste ouverte,
 * ajouter un filtre n'est qu'une ligne ici et un `select` dans la page.
 */
const filtresBiblio = { 'filtre-groupe': '', 'filtre-produit': '' };
/** Colonne de tri et sens. Par defaut le numero decroissant : le dernier cree en tete. */
const triBiblio = { colonne: 'numero', ascendant: false };
let pageBiblio = 0;
let taillePageBiblio = 100;

/** Date et heure de derniere modification : « 19/08/2026 à 14:32 ». */
function dateHeureLisible(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} à ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Poids lisible : une simulation se compte en kilo-octets, la bibliotheque parfois en mega. */
function poidsLisible(octets) {
  if (octets < 1024) return `${octets} o`;
  if (octets < 1024 * 1024) return `${(octets / 1024).toFixed(1)} Ko`;
  return `${(octets / (1024 * 1024)).toFixed(2)} Mo`;
}

/**
 * La bibliotheque : un TABLEAU, pas une grille de cartes.
 *
 * Le parc vise quelques milliers de dossiers. A cette echelle, une carte par
 * simulation est illisible - on ne compare pas, on ne trie pas, on defile
 * pendant des minutes. Un tableau dense, filtrable et triable est la seule
 * forme qui tienne : c'est le tableur que les gestionnaires connaissent deja.
 *
 * Trois mecanismes portent l'echelle :
 *   - les FILTRES reduisent l'ensemble avant tout rendu ;
 *   - le TRI se fait sur les fiches, jamais sur le DOM ;
 *   - la PAGINATION borne le nombre de lignes reellement construites. Cinq
 *     mille lignes de douze colonnes feraient soixante mille noeuds : le
 *     navigateur tient, mais chaque frappe dans la recherche coute alors une
 *     seconde. On n'en construit qu'une page.
 */
function rendreBibliotheque() {
  const zone = document.getElementById('biblio-liste');
  if (!zone) return;
  const toutes = listerSimulations();

  // --- Listes deroulantes peuplees depuis les fiches ---------------------
  // Ne proposer que des valeurs qui existent : un filtre « Commune » offrant
  // les 35 000 communes de France serait inutilisable, et proposer un produit
  // absent du parc fait chercher pour rien.
  const options = (id, valeurs, libelle = (v) => v) => {
    const sel = /** @type {HTMLSelectElement} */ (document.getElementById(id));
    if (!sel) return;
    const garde = sel.value;
    const listees = [...new Set(valeurs.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
    const premier = sel.options[0]?.outerHTML ?? '';
    sel.innerHTML = premier + listees.map((v) => `<option value="${att(v)}">${att(libelle(v))}</option>`).join('');
    // Une valeur filtree qui n'existe plus - dernier dossier de cette commune
    // supprime - laisserait une liste vide sans rien dire.
    sel.value = listees.includes(garde) ? garde : '';
    if (sel.value !== garde) filtresBiblio[id] = '';
  };
  options('filtre-groupe', toutes.map((f) => f.groupe));
  options('filtre-produit', toutes.flatMap((f) => f.produits ?? []), libelleProduit);

  // Liste d'autocompletion du champ Groupe de l'ecran Operation. Sans elle,
  // rattacher une simulation a un projet existant demande de retaper son
  // nom a l’identique : deux orthographes couperaient le projet en deux,
  // et le regroupement ne servirait plus a rien.
  const connus = document.getElementById('groupes-connus');
  if (connus) {
    connus.innerHTML = [...new Set(toutes.map((f) => f.groupe).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b))
      .map((g) => `<option value="${att(g)}"></option>`)
      .join('');
  }

  // --- Filtrage ----------------------------------------------------------
  const q = sansAccent(rechercheSimulation.trim());
  const fiches = toutes.filter((f) => {
    if (filtresBiblio['filtre-groupe'] && f.groupe !== filtresBiblio['filtre-groupe']) return false;
    if (filtresBiblio['filtre-produit'] && !(f.produits ?? []).includes(filtresBiblio['filtre-produit'])) return false;
    if (!q) return true;
    return sansAccent(`${f.numero} ${f.nom} ${f.groupe} ${f.commune} ${f.type_operation}`).includes(q);
  });

  // --- Tri ---------------------------------------------------------------
  const valeurTri = (f) => {
    switch (triBiblio.colonne) {
      case 'numero': return Number(f.numero) || 0;
      case 'nom': return sansAccent(f.nom);
      case 'groupe': return sansAccent(f.groupe);
      case 'commune': return sansAccent(f.commune);
      case 'type': return sansAccent(f.type_operation);
      case 'zone': return sansAccent(f.zone_ABC);
      case 'logements': return Number(f.nb_logements) || 0;
      case 'lots': return Number(f.nb_lots) || 0;
      case 'poids': return Number(f.octets) || 0;
      case 'modifie': return String(f.modifie_le);
      default: return Number(f.numero) || 0;
    }
  };
  fiches.sort((a, b) => {
    const x = valeurTri(a);
    const y = valeurTri(b);
    const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
    return triBiblio.ascendant ? c : -c;
  });

  // --- Pagination --------------------------------------------------------
  const pages = Math.max(1, Math.ceil(fiches.length / taillePageBiblio));
  if (pageBiblio >= pages) pageBiblio = pages - 1;
  if (pageBiblio < 0) pageBiblio = 0;
  const debut = pageBiblio * taillePageBiblio;
  const page = fiches.slice(debut, debut + taillePageBiblio);

  const compte = document.getElementById('biblio-compte');
  if (compte) {
    compte.textContent =
      fiches.length === toutes.length
        ? `${toutes.length} ligne${toutes.length > 1 ? 's' : ''}`
        : `${fiches.length} sur ${toutes.length}`;
  }
  const pied = document.getElementById('biblio-pagination');
  if (pied) {
    pied.hidden = fiches.length <= taillePageBiblio;
    const p = document.getElementById('biblio-page');
    if (p) p.textContent = `page ${pageBiblio + 1} sur ${pages} · lignes ${debut + 1} à ${Math.min(debut + taillePageBiblio, fiches.length)}`;
  }

  if (!fiches.length) {
    zone.innerHTML = toutes.length
      ? '<p class="vide">Aucune simulation ne correspond aux filtres.</p>'
      : '<p class="vide">La bibliothèque est vide.</p>';
    return;
  }

  // --- Rendu -------------------------------------------------------------
  const fleche = (col) =>
    triBiblio.colonne === col ? `<span class="biblio-tri">${triBiblio.ascendant ? '▲' : '▼'}</span>` : '';
  const th = (col, libelle, classe = '') =>
    `<th class="${classe}" data-tri-biblio="${col}" role="button" tabindex="0"
       aria-sort="${triBiblio.colonne === col ? (triBiblio.ascendant ? 'ascending' : 'descending') : 'none'}">${att(libelle)}${fleche(col)}</th>`;

  const ligne = (f) => {
    const ouverte = f.id === idSimulationOuverte;
    const pastilles = (f.produits ?? [])
      .map(
        (c) =>
          `<span class="biblio-produit" style="--cat:${catProduit(c)};--cat-fond:${catFondProduit(c)}"
             title="${att(libelleProduit(c))}">${att(libelleProduit(c))}</span>`,
      )
      .join('');
    return `<tr class="${ouverte ? 'biblio-ligne--ouverte' : ''}" data-sim="${att(f.id)}">
      <td class="num biblio-num">${nb(f.numero)}</td>
      <td class="biblio-nom" data-sim-ouvrir="${att(f.id)}" role="button" tabindex="0" title="Ouvrir">
        <span class="biblio-nom__texte">${att(f.nom)}</span>
        ${ouverte ? '<span class="pastille pastille--ok">ouverte</span>' : ''}
      </td>
      <td class="biblio-groupe">${
        f.groupe ? `<span class="biblio-groupe__jeton">${att(f.groupe)}</span>` : ''
      }</td>
      <td>${att(f.commune)}</td>
      <td class="biblio-discret">${att(f.zone_ABC)}</td>
      <td class="biblio-discret">${att(f.type_operation)}</td>
      <td class="biblio-produits">${pastilles}</td>
      <td class="num">${nb(f.nb_logements)}</td>
      <td class="num">${nb(f.nb_lots)}</td>
      <td class="num biblio-discret">${poidsLisible(f.octets ?? 0)}</td>
      <td class="biblio-discret">${att(dateHeureLisible(f.modifie_le))}</td>
      <td class="biblio-actions">
        <button type="button" class="biblio-action" data-sim-ouvrir="${att(f.id)}" title="Ouvrir">Ouvrir</button>
        <button type="button" class="biblio-action" data-sim-renommer="${att(f.id)}" title="Renommer">Renommer</button>
        <button type="button" class="biblio-action" data-sim-dupliquer="${att(f.id)}" title="Dupliquer">Dupliquer</button>
        <button type="button" class="biblio-action" data-sim-exporter="${att(f.id)}" title="Exporter en JSON">Exporter</button>
        <button type="button" class="bouton--supprimer" data-sim-supprimer="${att(f.id)}"
          data-nom="${att(f.nom)}" title="Supprimer">×</button>
      </td>
    </tr>`;
  };

  zone.innerHTML = `
    <div class="table-defilante biblio-table">
      <table class="tableau tableau--entete-figee">
        <thead><tr>
          ${th('numero', 'N°', 'num')}
          ${th('nom', 'Simulation')}
          ${th('groupe', 'Groupe')}
          ${th('commune', 'Commune')}
          ${th('zone', 'Zone')}
          ${th('type', 'Type')}
          <th>Produits</th>
          ${th('logements', 'Lgts', 'num')}
          ${th('lots', 'Lots', 'num')}
          ${th('poids', 'Poids', 'num')}
          ${th('modifie', 'Modifiée le')}
          <th></th>
        </tr></thead>
        <tbody>${page.map(ligne).join('')}</tbody>
      </table>
    </div>`;
}

/** Enregistre l'etat courant AVANT de changer de simulation : rien ne se perd. */
function viderFileDeSauvegarde() {
  clearTimeout(sauvegardeEnAttente);
  if (idSimulationOuverte) ecrireSimulation(idSimulationOuverte, simulationCourantePayload());
}

/** Telecharge une simulation en JSON : le format d'echange, et la sauvegarde de secours. */
function exporterSimulation(id) {
  const sim = lireSimulation(id);
  if (!sim) return;
  const nom = (sim.identite?.nom || 'simulation').replace(/[^\w\-. ]+/g, '_').trim();
  const blob = new Blob([JSON.stringify(sim, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${nom}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- exports

/**
 * Composition de chaque export : les ecrans repris, dans l'ordre du document.
 * Un export est une VUE du dossier, pas un format : c'est le choix des
 * sections qui le definit.
 */
const EXPORTS = {
  'prix-revient': {
    titre: 'Prix de revient',
    ecrans: ['prix-revient'],
  },
  financier: {
    titre: 'Dossier financier',
    ecrans: ['prix-revient', 'financement', 'exploitation'],
  },
  complet: {
    titre: 'Dossier complet',
    ecrans: ['operation', 'programme', 'prix-revient', 'financement', 'tresorerie', 'exploitation'],
  },
};

/** Export choisi. Le premier de la liste par defaut. */
let exportChoisi = 'prix-revient';

/**
 * Tranches ecartees du document, par leur code produit.
 *
 * C'est bien l'ENSEMBLE DES EXCLUES qui est memorise, et non celui des
 * retenues : un programme gagne et perd des tranches au fil de la saisie, et
 * une liste de retenues aurait fige l'export sur celles qui existaient au
 * moment ou on l'a ouvert. Une tranche nouvelle est presentee par defaut,
 * ce qui est le comportement attendu ; il faut un geste pour la retirer.
 */
const tranchesEcartees = new Set();

/** Tranches presentees dans le document, dans l ordre canonique. */
function tranchesRetenues() {
  const actives = tranchesActives();
  const gardees = actives.filter((c) => !tranchesEcartees.has(c));
  // Tout ecarter ne montrerait plus rien : le dernier retrait n'est pas
  // honore, et le selecteur le signale en gardant sa pastille allumee.
  return gardees.length ? gardees : actives;
}

/**
 * Pastilles de tranche de la barre d'export.
 *
 * Elles ne s'affichent qu'a partir de DEUX tranches : sur une operation
 * mono-produit, un selecteur qui n'a qu'un choix est un faux choix.
 */
function rendreChoixTranches() {
  const zone = document.getElementById('choix-tranches');
  if (!zone) return;
  const actives = tranchesActives();
  zone.hidden = actives.length < 2;
  if (zone.hidden) {
    zone.innerHTML = '';
    return;
  }
  const retenues = new Set(tranchesRetenues());
  zone.innerHTML = actives
    .map(
      (c) =>
        `<button type="button" class="pastille-tranche${
          retenues.has(c) ? ' pastille-tranche--active' : ''
        }" data-tranche-export="${att(c)}" aria-pressed="${retenues.has(c)}"
          style="--cat:${catProduit(c)};--cat-fond:${catFondProduit(c)}"
          title="Présenter ou retirer cette tranche du document">${att(libelleProduit(c))}</button>`,
    )
    .join('');
}

/**
 * Remplace les champs de saisie par leur VALEUR, en texte.
 *
 * Deux raisons, et la premiere est un piege : `cloneNode` copie l'attribut
 * `value` et non la propriete. Une valeur posee par le code - ce qui est le cas
 * de presque tout ici - ne survit donc pas au clonage, et l'apercu afficherait
 * des cases vides. La seconde est de forme : un cadre de saisie dans un
 * document fait croire a un formulaire a remplir.
 */
function figerSaisies(racine) {
  for (const champ of racine.querySelectorAll('input, select, textarea')) {
    const el = /** @type {HTMLInputElement|HTMLSelectElement} */ (champ);
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      const marque = document.createElement('span');
      marque.textContent = el.checked ? 'oui' : 'non';
      marque.className = 'doc__valeur';
      el.replaceWith(marque);
      continue;
    }
    const texte =
      el instanceof HTMLSelectElement ? (el.selectedOptions[0]?.textContent ?? '') : el.value;
    const span = document.createElement('span');
    // Le placeholder porte souvent la valeur par defaut - un montant calcule,
    // un taux du referentiel. Une case vide dans un document ne dit rien ;
    // la valeur qui s'appliquera, si.
    span.textContent = texte || el.getAttribute('placeholder') || '';
    span.className = 'doc__valeur';
    el.replaceWith(span);
  }
}

/**
 * Construit l'apercu du document.
 *
 * L'apercu N'EST PAS une representation de l'export : c'est l'export. Le PDF
 * imprime ce conteneur et rien d'autre, si bien qu'aucun ecart n'est possible
 * entre ce qu'on voit et ce qu'on obtient. C'est la seule facon de tenir la
 * promesse d'un apercu.
 */
/**
 * Fixe la largeur des colonnes du prix de revient.
 *
 * Sans cela le tableau se met en page sur son CONTENU : a quatre tranches la
 * colonne des libelles est etranglee, a une seule elle devient un desert, et
 * le meme document change de visage selon ce qu on a coche. Le lecteur, lui,
 * doit retrouver la meme piece a chaque fois.
 *
 * Deux colonnes ont une part FIXE - le numero et le libelle, dont le contenu
 * ne depend pas du nombre de tranches. Le reste se partage au poids : un
 * montant vaut plus large qu un taux, et les colonnes de bout un peu plus
 * que les autres, leurs intitules etant les plus longs. Les parts sont des
 * POURCENTAGES : le tableau occupe donc toute la largeur, une tranche ou
 * quatre.
 *
 * Les colonnes se lisent sur une ligne de poste et non sur l en-tete, dont
 * les cellules sont fusionnees sur deux rangees et par blocs de tranche.
 */
function normaliserColonnes(table) {
  const rangee = table.querySelector('tbody tr[data-poste]');
  if (!rangee) return;
  const cellules = [...rangee.children];
  if (cellules.length < 4) return;

  const PART_NUMERO = 4;
  const PART_LIBELLE = 24;
  const poids = cellules.map((c, i) => {
    if (i <= 1) return 0;
    // Un taux de TVA se saisit par une liste : trois caracteres a afficher,
    // contre onze pour un montant.
    if (c.querySelector('select')) return 0.75;
    return i === cellules.length - 1 ? 1.35 : 1.2;
  });
  const somme = poids.reduce((s, p) => s + p, 0);
  if (!somme) return;
  const reste = 100 - PART_NUMERO - PART_LIBELLE;

  table.querySelector('colgroup')?.remove();
  const parts = cellules.map((c, i) =>
    i === 0 ? PART_NUMERO : i === 1 ? PART_LIBELLE : (reste * poids[i]) / somme,
  );
  table.insertAdjacentHTML(
    'afterbegin',
    `<colgroup>${parts.map((p) => `<col style="width:${p.toFixed(3)}%" />`).join('')}</colgroup>`,
  );
  // `fixed` fait autorite sur le `colgroup` : sans lui le navigateur elargit
  // encore une colonne dont le contenu deborde, et la mise en page repart a
  // la merci du contenu.
  table.style.tableLayout = 'fixed';
  // Ces parts sont une PREMIERE APPROXIMATION, posee sans que la table soit
  // encore dans la page - donc sans rien pouvoir mesurer. La marque demande
  // leur revision au contenu reel, une fois le document monte.
  table.dataset.ajusterColonnes = '1';
}

/**
 * Largeur d un texte dans une police donnee, sans passer par la mise en page.
 *
 * Un canvas mesure sans rien inserer dans le document, donc sans declencher de
 * calcul de style ni de reflow : on peut interroger des centaines de cellules
 * sans que la page tressaille.
 */
const mesurerTexte = (() => {
  const ctx = document.createElement('canvas').getContext('2d');
  return (texte, police) => {
    if (!ctx) return texte.length * 6;
    ctx.font = police;
    return ctx.measureText(texte).width;
  };
})();

/** Police d un element, dans la forme abregee qu attend un canvas. */
function policeDe(el) {
  const s = getComputedStyle(el);
  return `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
}

/**
 * LARGEUR DES COLONNES, AJUSTEE A CE QU ELLES PORTENT VRAIMENT.
 *
 * Le partage au poids qui precede lisait une ligne de POSTE, ou la colonne de
 * TVA ne montre qu un taux - « 10,0 % », quatre caracteres - et lui donnait la
 * part la plus mince. Mais la meme colonne porte, sur la ligne de total, la
 * TVA de la tranche : « 271 320 € », deux fois plus large et en gras. Sur une
 * operation a quatre tranches les nombres du total se touchaient, faute de
 * quarante-trois pixels pour en loger cinquante-sept.
 *
 * On mesure donc, colonne par colonne, le plus large de CE QU ELLE CONTIENT,
 * en-tetes et pied compris, chacun a sa vraie police. Les colonnes de chiffres
 * recoivent alors ce qu elles reclament, et la colonne des LIBELLES absorbe la
 * difference : c est la seule qui ait de la marge, et ses libelles se coupent
 * en deux lignes sans dommage la ou un montant tronque est une faute.
 *
 * Une rangee n est indexee que si ses cellules couvrent EXACTEMENT toutes les
 * colonnes. C est la garde contre les rangees a `rowspan` - la rangee des
 * sous-colonnes du prix de revient commence a la quatrieme colonne alors que
 * son premier enfant est, pour elle, le rang zero, et l indexer decalerait
 * toutes les mesures d un bloc.
 */
function ajusterColonnesDuDocument(racine) {
  for (const table of racine.querySelectorAll('table[data-ajuster-colonnes]')) {
    const cols = [...table.querySelectorAll('colgroup col')];
    const largeur = table.getBoundingClientRect().width;
    if (cols.length < 4 || !largeur) continue;

    const besoins = new Array(cols.length).fill(0);
    const polices = new Map();
    for (const tr of table.querySelectorAll('thead tr, tbody tr, tfoot tr')) {
      const cellules = [...tr.children];
      const couverture = cellules.reduce((s, c) => s + (c.colSpan || 1), 0);
      if (couverture !== cols.length) continue;
      let rang = 0;
      for (const cell of cellules) {
        const span = cell.colSpan || 1;
        const texte = span === 1 ? cell.textContent.trim() : '';
        if (texte) {
          // La police se retient par rangee ET par sorte de cellule : le pied
          // est en gras, les en-tetes aussi, et les interroger cellule par
          // cellule couterait un calcul de style par nombre affiche.
          const cle = `${tr.className}|${cell.tagName}|${cell.className}`;
          if (!polices.has(cle)) polices.set(cle, policeDe(cell));
          besoins[rang] = Math.max(besoins[rang], mesurerTexte(texte, polices.get(cle)));
        }
        rang += span;
      }
    }

    // Marge interieure d une cellule, prise sur le rendu, plus un pixel de
    // garde : une colonne calee au pixel pres sur son contenu le voit deborder
    // au premier arrondi de rendu.
    const modele = table.querySelector('tbody td') ?? table.querySelector('td');
    const st = modele ? getComputedStyle(modele) : null;
    const marge = st ? parseFloat(st.paddingLeft) + parseFloat(st.paddingRight) + 1 : 8;

    const NUMERO = 0;
    const LIBELLE = 1;
    const chiffres = besoins.map((b, i) => (i === NUMERO || i === LIBELLE ? 0 : b + marge));
    const totalChiffres = chiffres.reduce((s, b) => s + b, 0);
    if (!totalChiffres) continue;
    const largeurNumero = Math.max(besoins[NUMERO] + marge, largeur * 0.03);
    // La colonne des libelles prend ce qui reste, entre un plancher - en deca
    // duquel « Travaux de construction » se hacherait en quatre lignes - et un
    // plafond, pour qu une operation a une seule tranche ne lui donne pas la
    // moitie du tableau.
    const libelle = Math.min(
      largeur * 0.28,
      Math.max(largeur * 0.14, largeur - largeurNumero - totalChiffres),
    );
    // Reste a partager entre les colonnes de chiffres, AU PRORATA DE LEUR
    // BESOIN. Si le compte ne tombe pas juste, chacune est reduite dans la
    // meme proportion : le debordement, s il subsiste, se repartit au lieu de
    // frapper la colonne que le modele de poids avait sous-estimee.
    const echelle = (largeur - largeurNumero - libelle) / totalChiffres;
    const parts = besoins.map((_, i) =>
      i === NUMERO ? largeurNumero : i === LIBELLE ? libelle : chiffres[i] * echelle,
    );
    cols.forEach((col, i) => {
      col.style.width = `${((parts[i] / largeur) * 100).toFixed(3)}%`;
    });
  }
}

/**
 * Retire une COLONNE entiere d une table, en-tete et pied compris.
 *
 * La cellule a retirer se cherche en comptant les colonnes, jamais par le
 * rang de l enfant : une rangee peut commencer par une cellule fusionnee - le
 * titre d'un chapitre, un intitule de total - et son n-ieme enfant se trouve
 * alors bien plus loin que la n-ieme colonne. On y detruisait une cellule de
 * donnees en croyant retirer une colonne de commande, et le compte retombait
 * juste par compensation : rien ne se voyait, jusqu au jour ou la cellule
 * visee disparaissait par ailleurs.
 *
 * Une cellule qui couvre plusieurs colonnes en cede une ; une cellule simple
 * disparait.
 */
function retirerColonne(table, index) {
  // PREMIERE rangee d en-tete seulement. Les suivantes ne commencent pas a
  // la colonne zero : les colonnes fixes du prix de revient les enjambent par
  // un `rowspan`, si bien que la rangee des sous-colonnes debute a la
  // quatrieme colonne du tableau alors que son premier enfant est, pour elle,
  // le rang zero. Compter ses enfants revenait a viser trois colonnes trop a
  // gauche : on y a retire le « TVA » du PLUS, et tous les intitules de
  // sous-colonne se sont decales d un cran jusqu au bout de la rangee.
  for (const rangee of table.querySelectorAll('thead tr:first-child, tbody tr, tfoot tr')) {
    let colonne = 0;
    for (const cel of [...rangee.children]) {
      const portee = cel.colSpan || 1;
      if (index < colonne + portee) {
        if (portee > 1) cel.colSpan = portee - 1;
        else cel.remove();
        break;
      }
      colonne += portee;
    }
  }
}

/** Nombre de colonnes d une table, lu sur sa rangee la plus large. */
function compterColonnes(table) {
  let n = 0;
  for (const rangee of table.querySelectorAll('tr')) {
    const somme = [...rangee.children].reduce((s, c) => s + (c.colSpan || 1), 0);
    n = Math.max(n, somme);
  }
  return n;
}

/**
 * Retire les colonnes qui n existent que pour la MANIPULATION : poignee de
 * deplacement, case de selection, croix de suppression.
 *
 * Elles etaient jusqu ici seulement VIDEES, faute de pouvoir les retirer sans
 * decaler les lignes par rapport a leur en-tete. Ce n est plus un obstacle, et
 * une colonne vide de trente pixels dans un document est de la place prise aux
 * chiffres.
 *
 * Les rangs se relevent sur une rangee de CORPS, ou chaque cellule occupe une
 * colonne, puis se retirent du plus grand au plus petit pour que les suivants
 * restent valables.
 */
function retirerColonnesDEcran(table) {
  const rangee = table.querySelector('tbody tr');
  if (!rangee) return;
  const rangs = [];
  let colonne = 0;
  for (const cel of rangee.children) {
    const portee = cel.colSpan || 1;
    if (portee === 1 && /col-(poignee|select|action)/.test(cel.className)) rangs.push(colonne);
    colonne += portee;
  }
  for (const r of rangs.reverse()) retirerColonne(table, r);
}

/**
 * Pose le titre du bloc DANS le `thead` de sa table, et le retire du bloc.
 *
 * Un groupe d en-tete se repete en haut de chaque page imprimee et y reserve
 * sa place. Un titre pose au-dessus de la table, lui, ne parait qu une fois :
 * la deuxieme page du compte d exploitation etait un mur de chiffres sans nom.
 * Son espace haut tient aussi lieu de marge de page, `@page` n en donnant plus
 * - c est le prix a payer pour faire taire l en-tete du navigateur.
 */
function poserBandeauDeTable(table) {
  const tete = table.querySelector('thead');
  const titre = table.closest('.bloc')?.querySelector('.bloc__titre');
  if (!tete || !titre || tete.querySelector('.doc-bandeau')) return;
  // Le premier noeud de texte seulement : un titre porte parfois une legende
  // ou des outils, qui ne sont pas son nom.
  const nom = (titre.childNodes[0]?.textContent ?? '').trim();
  if (!nom) return;
  const bande = document.createElement('tr');
  bande.innerHTML = `<th class="doc-bandeau" colspan="${compterColonnes(table)}">${att(nom)}</th>`;
  tete.insertBefore(bande, tete.firstChild);
  titre.remove();
}

/**
 * Applique a TOUTE table du document ce que le prix de revient a inaugure :
 * pas de colonne de manipulation, un titre qui se repete de page en page, un
 * pied marque comme le total qu il est.
 */
/**
 * Etire la derniere cellule des rangees qui n atteignent pas le bord droit.
 *
 * Le pied de la table des lots couvrait onze colonnes sur treize : sa bande de
 * total s arretait avant le bord, deux colonnes plus tot, sans que personne ne
 * l'ait voulu. Le retrait des colonnes de manipulation pouvait creuser le meme
 * ecart ailleurs. Plutot que de corriger chaque rendu, le document se ferme
 * lui-meme.
 *
 * Seuls le corps et le pied sont touches : l'en-tete se sert de `rowspan`, et
 * une rangee courte y est normale - les sous-colonnes de tranche ne couvrent
 * que leur bloc.
 */
function completerRangees(table, colonnes) {
  for (const rangee of table.querySelectorAll('tbody tr, tfoot tr')) {
    const cellules = [...rangee.children];
    if (!cellules.length) continue;
    const portee = cellules.reduce((s, c) => s + (c.colSpan || 1), 0);
    if (portee < colonnes) cellules[cellules.length - 1].colSpan = (cellules[cellules.length - 1].colSpan || 1) + (colonnes - portee);
  }
}

function adapterTablesAuDocument(racine) {
  for (const table of racine.querySelectorAll('table')) {
    retirerColonnesDEcran(table);
    table.querySelector('tfoot tr')?.classList.add('doc-total');
    completerRangees(table, compterColonnes(table));
    poserBandeauDeTable(table);
  }
}

/**
 * Retire du document les colonnes et les lignes des tranches ecartees.
 *
 * Le filet colore qui ferme un bloc de tranche est porte par la DERNIERE
 * colonne du bloc : retirer la derniere tranche laissait le tableau ouvert
 * sur sa droite. Il est donc repose sur ce qui reste.
 */
function ecarterTranches(racine) {
  const retenues = new Set(tranchesRetenues());
  for (const cel of [...racine.querySelectorAll('[data-tranche]')]) {
    if (!retenues.has(/** @type {HTMLElement} */ (cel).dataset.tranche)) cel.remove();
  }
  for (const rangee of racine.querySelectorAll('tr')) {
    const cellules = [...rangee.querySelectorAll('[data-tranche]')];
    if (!cellules.length) continue;
    for (const c of cellules) c.classList.remove('col-tranche--fin');
    cellules[cellules.length - 1].classList.add('col-tranche--fin');
  }
}

/**
 * RECADRE LE PRIX DE REVIENT SUR UNE TRANCHE.
 *
 * Cadrer le document sur une tranche recalculait deja tout le reste du dossier
 * - emplois, ressources, prets, subventions, compte d'exploitation - mais pas
 * la table du prix de revient, qui gardait les totaux de l'operation entiere a
 * cote de la seule colonne retenue. On lisait donc, sous un en-tete
 * « Perimetre PLUS », un prix de revient total de 6 260 000 EUR quand la
 * colonne PLUS en portait 2 713 198 : deux nombres pour la meme grandeur, dans
 * le meme tableau, et rien pour dire lequel repondait au titre.
 *
 * Les valeurs viennent du MOTEUR et non des cellules affichees : la ventilation
 * porte deja, poste par poste et chapitre par chapitre, la part de chaque
 * tranche. Les relire evite de reconstituer des montants a partir de chaines
 * formatees, et surtout d'en refaire les arrondis - le moteur repartit ses
 * centimes pour que chaque colonne somme juste, ce qu'une addition faite ici
 * casserait.
 *
 * Le TTC retenu est celui de la LIVRAISON A SOI-MEME, comme a l'ecran : c'est
 * lui qui devient le prix de revient a financer.
 */
function recadrerPrixRevientSurTranche(table, code) {
  const v = dernierResultat?.bilan?.ventilation;
  if (!v?.par_tranche?.[code]) return;

  /** Ecrit les trois cellules globales d une rangee, quand elle les porte. */
  const poser = (tr, ht, tva, ttc) => {
    const champ = tr.querySelector('input[data-type="montant"]');
    const celluleHT = tr.querySelector('[data-calc="total"]') ?? tr.querySelector('[data-total="ht"]');
    // Le montant brut, pas le montant formate : la mise en forme du document
    // passe juste apres et le reprendra a son compte.
    if (champ) champ.value = nul(ht) ? '' : String(ht);
    else if (celluleHT) celluleHT.textContent = eur(ht);
    const cible = (sel) => tr.querySelector(sel);
    const cTva = cible('[data-calc="tva"]') ?? cible('[data-total="tva"]');
    const cTtc = cible('[data-calc="ttc"]') ?? cible('[data-total="ttc"]');
    if (cTva) cTva.textContent = eur(tva);
    if (cTtc) cTtc.textContent = eur(ttc);
  };

  for (const tr of table.querySelectorAll('tbody tr[data-poste]')) {
    const t = v.postes?.[Number(tr.dataset.poste)]?.par_tranche?.[code];
    if (t) poser(tr, t.ht_eur, t.tva_eur, t.ttc_lasm_eur);
  }
  for (const tr of table.querySelectorAll('tbody tr[data-chapitre-total]')) {
    const t = v.chapitres?.[/** @type {HTMLElement} */ (tr).dataset.chapitreTotal]?.par_tranche?.[code];
    if (t) poser(tr, t.ht_eur, t.tva_eur, t.ttc_lasm_eur);
  }

  // Le pied : la rangee du total, puis celle de la base financable. Elles se
  // designent par leur RANG et non par leur intitule - celui-ci est du texte
  // d'affichage, et le jour ou il change le recadrage cesserait sans bruit.
  const pied = [...table.querySelectorAll('tfoot tr')];
  const t = v.par_tranche[code];
  const total = pied[0];
  if (total) {
    const cellules = [...total.children];
    // Rangee du total : cellule vide, intitule, HT, colonne de commande, puis
    // les tranches, puis TVA et TTC en queue.
    if (cellules[2]) cellules[2].textContent = eur(t.total_ht_eur);
    if (cellules.length >= 2) {
      cellules[cellules.length - 2].textContent = eur(t.total_tva_eur);
      cellules[cellules.length - 1].textContent = eur(t.total_ttc_lasm_eur);
    }
  }
  const base = pied[1];
  if (base) {
    const cellules = [...base.children];
    cellules[cellules.length - 1].textContent = eur(t.total_ttc_module_eur);
  }
}

/**
 * Retravaille la table du prix de revient POUR LE DOCUMENT.
 *
 * Un PDF n'a pas a etre la photographie de l'ecran. L'ecran est une grille de
 * SAISIE : il porte une colonne de commande, des largeurs figees pour que rien
 * ne saute quand on bascule une ventilation, et quarante-six lignes dont on ne
 * remplit qu'une poignee. Le document, lui, est une piece qu'on lit et qu'on
 * joint a un dossier. Trois corrections en decoulent :
 *
 *   - la colonne de commande DISPARAIT, en-tete comprise. Vide dans un
 *     document, elle ne faisait qu'ecarter les chiffres de leur intitule ;
 *   - les largeurs figees tombent. Elles stabilisent la saisie ; ici elles
 *     ecrasaient la colonne des libelles, au point que « Sous-total charge
 *     fonciere » tenait sur trois lignes ;
 *   - les lignes de chapitre et de sous-total sont marquees, pour que la
 *     structure du bilan se voie sans avoir a etre lue.
 */
function adapterPrixRevientAuDocument(copie) {
  const table = copie.querySelector('#table-postes');
  if (!table) return;

  // La colonne de commande est la QUATRIEME, apres le numero, le libelle et le
  // total. On la retire par sa POSITION et non par une classe : son en-tete
  // n'en porte aucune, et c'est precisement ce qui avait decale les lignes.
  const RANG_COMMANDE = 3;
  table.querySelector('colgroup')?.remove();
  retirerColonne(table, RANG_COMMANDE);

  for (const tr of table.querySelectorAll('tr.chapitre-entete')) tr.classList.add('doc-chapitre');
  for (const tr of table.querySelectorAll('tr.chapitre-total')) tr.classList.add('doc-soustotal');
  table.querySelector('tfoot tr')?.classList.add('doc-total');
  // La marque « poste vide » grise le libelle a l'ecran, pour distinguer ce
  // qui reste a saisir. Elle n'a plus de sens ici : les lignes vides ont
  // disparu du document, et une ligne chiffree affichee en gris se lirait
  // comme une valeur douteuse.
  for (const tr of table.querySelectorAll('tr.poste--vide')) tr.classList.remove('poste--vide');

  // Les tranches ecartees quittent le tableau, colonne entiere : en-tete de
  // groupe, sous-colonnes, cellules et sous-totaux. Elles se designent par
  // leur CODE et non par leur rang - un rang se decale des qu'une colonne
  // part - ni par leur couleur, que deux produits peuvent partager.
  ecarterTranches(table);

  // Un document ne liste pas quarante-six postes dont trente-deux sont vides :
  // il montre ce qui a ete chiffre.
  for (const ligne of table.querySelectorAll('tr[data-poste]')) {
    const chiffree = [...ligne.querySelectorAll('input')].some(
      (c) => /** @type {HTMLInputElement} */ (c).value.trim() !== '',
    );
    if (!chiffree) ligne.remove();
  }

  // ... et un chapitre dont il ne reste aucun poste s en va avec eux. Son
  // titre et son « Sous-total frais divers : 0 € » ne portaient plus de
  // structure, seulement une case du plan comptable restee vide.
  let enTeteCourant = null;
  let postesDuChapitre = 0;
  for (const tr of [...table.querySelectorAll('tbody tr')]) {
    if (tr.classList.contains('chapitre-entete')) {
      enTeteCourant = tr;
      postesDuChapitre = 0;
      continue;
    }
    if (tr.classList.contains('chapitre-total')) {
      if (!postesDuChapitre) {
        enTeteCourant?.remove();
        tr.remove();
      }
      enTeteCourant = null;
      continue;
    }
    postesDuChapitre += 1;
  }

  // BANDEAU DE TETE, dans le `thead` et non au-dessus de la table : un
  // groupe d en-tete se repete en haut de chaque page imprimee ET y reserve
  // sa place. L en-tete du document, lui, etait en `position: fixed` : il se
  // repetait sans rien reserver et recouvrait le tableau des la page deux.
  // Son espace haut tient aussi lieu de marge de page, puisque `@page` n en
  // donne plus - c'est le prix a payer pour faire taire l'en-tete que le
  // navigateur ajoute de lui-meme.
  // Le bandeau de tete est pose par le traitement commun a toutes les tables,
  // qui reprend le titre du bloc - ici « Prix de revient ».
  normaliserColonnes(table);

  // Le document ne compte pas les cases qui restent a remplir. « 14 postes
  // renseignes sur 46 de la nomenclature » parle de la SAISIE et non de
  // l'operation : c'est un reperage utile a l'ecran, une confidence de
  // chantier dans une piece qu on joint a un dossier.
  table.querySelector('tr.resume-saisie')?.remove();

  // LE TOTAL DOIT REPONDRE AU TITRE. Cadre sur une tranche, le document parle
  // d'elle : ses colonnes globales aussi. Cadre sur PLUSIEURS tranches sans
  // etre cadre sur une seule, le reste du dossier - emplois, ressources,
  // prets - reste celui de l'operation : les totaux le restent donc aussi, et
  // le disent, plutot que d'inviter a additionner des colonnes qui ne font pas
  // le compte.
  const perimetre = perimetreDuDocument();
  if (perimetre) {
    recadrerPrixRevientSurTranche(table, perimetre);
  } else if (tranchesRetenues().length < tranchesActives().length) {
    const nommer = (rangee, texte) => {
      const cel = rangee?.querySelector('.libelle');
      if (cel) cel.textContent = texte;
    };
    const pied = [...table.querySelectorAll('tfoot tr')];
    nommer(pied[0], 'Prix de revient total de l’opération');
    nommer(pied[1], 'Base finançable de l’opération (TTC)');
  }

  // Les montants saisis prennent le FORMAT DU DOCUMENT. Une case de saisie
  // n affiche pas l euro - il se repeterait sur quarante-six lignes et gene
  // la frappe - et son texte est cale a gauche, comme dans tout champ. Ici ce
  // sont des montants au meme titre que les sous-totaux : ce qui se lit est
  // une colonne de chiffres, qui se compare a l oeil, pas une colonne de
  // champs. Ils prennent donc la meme ecriture et le meme bord.
  for (const champ of table.querySelectorAll('input[data-type="montant"]')) {
    const saisi = /** @type {HTMLInputElement} */ (champ);
    const v = lireMontant(saisi.value);
    saisi.value = nul(v) ? '' : eur(v);
    saisi.closest('td')?.classList.add('num');
  }
}

/**
 * Date du jour, en ecriture francaise et en heure LOCALE.
 *
 * L'heure a disparu de l'en-tete : un document se date au jour, la minute
 * d edition ne dit rien a qui le lit. La date se prend sur le calendrier
 * local et non sur `toISOString`, qui donne l'UTC - a vingt-trois heures un
 * soir de juillet, le document serait date du lendemain.
 */
function dateDuJour() {
  const d = new Date();
  const jj = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${jj}/${mm}/${d.getFullYear()}`;
}

// ------------------------------------------------------- sensibilite

/*
 * L'ECRAN EST UN DIAGNOSTIC, PAS UNE BOITE A OUTILS.
 *
 * Deux versions precedentes presentaient des instruments - tornade, generateur
 * de scenarios, bouton magique, recherche de cible - et laissaient au lecteur
 * le soin d'en tirer des conclusions. Elles ont ete refusees pour la meme
 * raison : il fallait savoir quoi demander avant d'obtenir quoi que ce soit.
 *
 * Celui-ci calcule tout a l'arrivee et repond dans l'ordre ou l'on se pose
 * les questions :
 *
 *   1. le VERDICT : l'operation tient, tient mais passe par le rouge, ou ne
 *      tient pas - lu dans le resultat deja calcule, peint immediatement ;
 *   2. les POINTS DE BASCULE : pour chaque hypothese, la distance entre sa
 *      valeur actuelle et le point ou l'operation casse. « Bascule a +0,9 pt
 *      de vacance » se cite en comite ; « ce levier pese 258 000 EUR », qui
 *      etait la reponse de la tornade, ne se cite pas ;
 *   3. la TEMPETE : les fragilites les plus proches poussees ensemble, en une
 *      phrase, la ou l'ancienne table de scenarios alignait cent lignes ;
 *   4. les MARGES DE MANOEUVRE : ce que la negociation peut rattraper,
 *      calcule d'office quand l'operation ne tient pas.
 *
 * Les outils survivent, replies en pied de page : viser une valeur precise,
 * croiser des hypotheses choisies.
 *
 * MECANIQUE. Le moteur est synchrone et pur ; l'analyse complete coute de
 * l'ordre de quatre cents passages (mesure : ~5 ms le passage sur une
 * operation a quatre tranches). Elle se deroule donc en PHASES entrecoupees
 * de `setTimeout(0)`, chaque phase peignant ce qu'elle sait, et un JETON
 * d'obsolescence abandonne la suite si le dossier ou la lecture change en
 * cours de route. Le tout est mis en CACHE sur l'identite de `dernierResultat`
 * (le moteur le remplace a chaque recalcul) : revenir sur l'ecran ou deplier
 * une jauge ne recalcule rien.
 */

/** Objectif sur lequel tout l'ecran est mesure (catalogue OBJECTIFS). */
let objectifSensibilite = OBJECTIFS[1].code; // autofinancement_cumule
/** Annee ou lire un cumul. Vide = fin de l'horizon. */
let anneeCumul = null;
/** Cible du seuil de bascule. Vide = la cible par defaut de l'objectif. */
let cibleBascule = null;
/** Reglages de LECTURE, passes a chaque indicateur et a chaque objectif. */
const contexteLecture = () => ({ annee_cumul: anneeCumul });
/** Jauge depliee (code de levier), ou null. */
let levierDeplie = null;
/** Jeton d'obsolescence : incremente a chaque lancement, verifie apres chaque pause. */
let jetonAnalyse = 0;
/**
 * Analyse en cache : { resultat, objectif, cible, annee, tornade, seuils,
 * tempete, marges, balayages: Map<code, points>, finie }.
 * `resultat` est l'OBJET `dernierResultat` au moment du calcul : le moteur en
 * cree un neuf a chaque recalcul, l'identite fait donc office de version.
 */
let analyseSensibilite = null;

/*
 * CONVENTIONS DE PRESENTATION des jauges - de l'affichage, pas du metier,
 * documentees ici plutot que semees dans le code :
 *  - la plage exploree va jusqu'a QUATRE amplitudes du levier : au-dela, ce
 *    n'est plus la meme operation (meme borne que l'optimiseur, R-SENS-3) ;
 *  - une bascule a moins d'UNE amplitude est FRAGILE : l'alea courant suffit
 *    a la franchir. A moins de DEUX, elle est A SURVEILLER. Au-dela, SOLIDE.
 */
const PLAGE_BASCULE_AMPLITUDES = 4;
const SEUIL_FRAGILE_AMPLITUDES = 1;
const SEUIL_SURVEILLER_AMPLITUDES = 2;

/** Mise en forme d une valeur selon l unite de son indicateur. */
function valeurIndicateur(v, unite) {
  if (nul(v)) return '-';
  if (unite === 'eur') return eur(v);
  if (unite === 'taux') return pct(v, 2);
  return nb(v);
}

/** Amplitude d un levier, en toutes lettres : « ± 5 % », « ± 0,5 pt », « ± 5 ans ». */
function amplitudeLisible(levier, amplitude) {
  if (!levier) return '';
  if (levier.unite === 'annees') return `± ${amplitude} ans`;
  // Un decalage de taux se dit en POINTS, pas en pourcent : « ± 0,5 % » sur un
  // taux se lirait comme un demi-pourcent de sa valeur, soit deux cents fois
  // moins que ce que le levier fait vraiment.
  if (levier.unite === 'points') return `± ${pct(amplitude, 1).replace(' %', ' pt')}`;
  return `± ${pct(amplitude, 0)}`;
}

/** Variation signee d un levier, dans l unite du levier : « +3,2 % », « -0,5 pt », « +5 ans ». */
function variationLisible(unite, v) {
  const signe = v > 0 ? '+' : '';
  if (unite === 'annees') return `${signe}${Math.round(v)} ans`;
  if (unite === 'points') return `${signe}${pct(v, 2).replace(' %', ' pt')}`;
  return `${signe}${pct(v, 1)}`;
}

/** Premiere lettre en minuscule, le reste intact : « Livret A » devient « livret A ». */
const minuscule = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** L objectif mesure et la cible de bascule effective. */
const objectifCourant = () => objectifDe(objectifSensibilite) ?? OBJECTIFS[0];
const cibleEffective = () => (nul(cibleBascule) ? objectifCourant().cible_defaut : cibleBascule);

/**
 * L operation SATISFAIT-elle la cible ? `sens` de l objectif dit dans quel
 * sens on veut etre : +1 au-dessus, -1 en dessous.
 */
function satisfaitCible(valeur, objectif, cible) {
  if (nul(valeur)) return false;
  return objectif.sens === 1 ? valeur >= cible : valeur <= cible;
}

// ---------------------------------------------------------------- verdict

/**
 * Verdict a TROIS etats, et pas deux : une operation dont le cumul finit
 * positif mais PLONGE en cours de route tient sur le papier et pas en
 * tresorerie. La distinguer est exactement ce qu un comite demande.
 * Zero passage moteur : tout se lit dans `dernierResultat`.
 */
function rendreVerdictSensibilite() {
  const zone = document.getElementById('verdict-sensibilite');
  const tuiles = document.getElementById('tuiles-sensibilite');
  if (!zone || !tuiles || !dernierResultat) return;
  const ind = dernierResultat.exploitation?.indicateurs ?? {};
  const ctx = contexteLecture();
  const cumul = indicateurDe('autofinancement_cumule')?.lire(dernierResultat, ctx) ?? null;
  const creux = ind.creux_cumul_eur ?? null;
  const deficitaires = ind.exercices_deficitaires ?? 0;
  const derniereAnnee = dernierResultat.exploitation?.lignes?.at(-1)?.annee ?? null;
  const quand = anneeCumul ?? derniereAnnee;

  let classe = 'optim optim--bon';
  let phrase;
  if (nul(cumul)) {
    classe = 'optim optim--hors';
    phrase = `Le cumul d’autofinancement n’est pas lisible${anneeCumul ? ` en ${att(anneeCumul)} : l’année est hors de l’horizon simulé` : ''}.`;
  } else if (cumul < 0) {
    classe = 'optim optim--mauvais';
    phrase =
      `⚠ <strong>L’opération ne tient pas en l’état</strong> : l’autofinancement cumulé ` +
      `finit à <strong>${att(eur(cumul))}</strong>${quand ? ` en ${att(quand)}` : ''}.`;
  } else if ((creux ?? 0) < 0) {
    classe = 'optim optim--hors';
    phrase =
      `<strong>L’opération tient à terme, mais passe par le rouge</strong> : le cumul plonge à ` +
      `<strong>${att(eur(creux))}</strong>${ind.annee_creux_cumul ? ` en ${att(ind.annee_creux_cumul)}` : ''}` +
      `${deficitaires ? ` et ${att(nb(deficitaires))} exercice${deficitaires > 1 ? 's sont déficitaires' : ' est déficitaire'}` : ''}, ` +
      `avant de finir à <strong>${att(eur(cumul))}</strong>${quand ? ` en ${att(quand)}` : ''}.`;
  } else {
    phrase =
      `✓ <strong>L’opération tient</strong> : l’autofinancement cumulé finit à ` +
      `<strong>${att(eur(cumul))}</strong>${quand ? ` en ${att(quand)}` : ''} sans jamais passer en négatif.`;
  }
  zone.className = classe;
  zone.innerHTML =
    `<p class="optim__verdict">${phrase}</p>` +
    // La clause de fragilite se remplit quand les seuils sont connus : elle
    // nomme la menace la plus proche, ou dit qu il n y en a pas.
    `<p class="optim__detail" id="verdict-fragilite" hidden></p>`;

  const t = [
    { l: 'Autofinancement cumulé', v: eur(cumul), d: quand ? `à fin ${quand}` : 'fin d’horizon' },
    {
      l: 'Creux du cumul',
      v: eur(creux),
      d: ind.annee_creux_cumul ? `atteint en ${ind.annee_creux_cumul}` : 'point bas du cumul',
    },
    { l: 'Exercices déficitaires', v: nb(deficitaires), d: 'sur tout l’horizon' },
    { l: 'TRI de l’opération', v: valeurIndicateur(ind.tri, 'taux'), d: 'taux de rentabilité interne' },
    {
      l: 'Fonds propres appelés',
      v: eur(dernierResultat.indicateurs?.fonds_propres_eur),
      d: 'apport au plan de financement',
    },
  ];
  tuiles.innerHTML = t
    .map(
      (i) =>
        `<div class="indicateur"><div class="indicateur__libelle">${att(i.l)}</div>` +
        `<div class="indicateur__valeur">${att(i.v)}</div>` +
        `<div class="indicateur__detail">${att(i.d)}</div></div>`,
    )
    .join('');

  const resume = document.getElementById('lecture-resume');
  if (resume) {
    const o = objectifCourant();
    resume.textContent =
      `Seuils mesurés sur : ${o.libelle.toLowerCase()}` +
      `${anneeCumul ? ` en ${anneeCumul}` : derniereAnnee ? ` en fin d’horizon (${derniereAnnee})` : ''}` +
      `, bascule à ${valeurIndicateur(cibleEffective(), o.unite)}.`;
  }
}

/** Peuple les reglages de lecture, une fois. */
function peuplerReglagesLecture() {
  const sel = document.getElementById('lect-objectif');
  if (sel && !sel.options.length) {
    sel.innerHTML = OBJECTIFS.map(
      (o) => `<option value="${att(o.code)}">${att(o.libelle)}</option>`,
    ).join('');
  }
  if (sel) sel.value = objectifSensibilite;
  const annee = /** @type {HTMLInputElement|null} */ (document.getElementById('lect-annee'));
  if (annee) {
    const lignes = dernierResultat?.exploitation?.lignes ?? [];
    annee.placeholder = lignes.length ? String(lignes.at(-1).annee) : '';
    if (nul(anneeCumul) && document.activeElement !== annee) annee.value = '';
  }
  const cible = /** @type {HTMLInputElement|null} */ (document.getElementById('lect-cible'));
  if (cible && document.activeElement !== cible) {
    cible.placeholder = valeurIndicateur(objectifCourant().cible_defaut, objectifCourant().unite);
    if (nul(cibleBascule)) cible.value = '';
  }
}

// ---------------------------------------------------------------- bascules

/**
 * Point de bascule d UN levier : la variation qui amene l objectif a la cible.
 *
 * Le SENS de recherche depend de l etat de depart : une operation qui tient
 * cherche la degradation qui la fait casser, une operation qui ne tient pas
 * cherche l amelioration qui la remet a flot. La barre de tornade, deja
 * calculee, donne le sens gratuitement : elle porte la valeur de l objectif a
 * -amplitude et a +amplitude.
 */
function calculerBascule(entrees, refs, barre, objectif, cible, reference) {
  const levier = levierDe(barre.code);
  const base = {
    code: barre.code,
    libelle: barre.libelle,
    unite: barre.unite,
    amplitude: barre.amplitude,
    actionnable: levier?.actionnable === true,
    ecart_tornade: barre.ecart,
  };
  if (!barre.applique) return { ...base, applique: false };

  const tient = satisfaitCible(reference, objectif, cible);
  // Une valeur DEGRADE quand elle va contre le sens de l objectif.
  const degrade = (v) => !nul(v) && (objectif.sens === 1 ? v < reference : v > reference);
  const ameliore = (v) => !nul(v) && (objectif.sens === 1 ? v > reference : v < reference);
  const versLeMal = degrade(barre.haut) ? 1 : degrade(barre.bas) ? -1 : 0;
  const versLeBien = ameliore(barre.haut) ? 1 : ameliore(barre.bas) ? -1 : 0;
  const direction = tient ? versLeMal : versLeBien;
  // Aucune direction ne va du cote cherche : le levier ne peut ni casser ni
  // sauver l operation dans sa plage. C est une information, pas une absence.
  if (direction === 0) return { ...base, applique: true, mode: tient ? 'bascule' : 'retour', inerte: true };

  const eq = chercherEquilibre(entrees, refs, {
    levier: barre.code,
    objectif: objectif.code,
    cible,
    contexte: contexteLecture(),
    bornes: [0, direction * PLAGE_BASCULE_AMPLITUDES * barre.amplitude],
    iterations_max: 30,
  });
  if (eq.applique === false) return { ...base, applique: false };
  return {
    ...base,
    applique: true,
    mode: tient ? 'bascule' : 'retour',
    direction,
    trouve: eq.trouve,
    approche: !eq.trouve && !nul(eq.variation) && nul(eq.atteignable),
    variation: eq.variation ?? null,
    valeur: eq.valeur ?? null,
    atteignable: eq.atteignable ?? null,
    resultat: eq.resultat ?? null,
    distance: nul(eq.variation) ? null : Math.abs(eq.variation) / barre.amplitude,
  };
}

/** Badge de proximite d une bascule. */
function badgeBascule(s) {
  // Le levier inerte d abord : « voie de retour » sur un levier sans effet
  // promettrait un chemin qui n existe pas.
  if (s.inerte) return { classe: 'robuste', texte: 'sans effet' };
  if (s.mode === 'retour') return { classe: 'retour', texte: 'voie de retour' };
  if (!s.trouve && !s.approche) return { classe: 'robuste', texte: 'robuste' };
  if (s.distance < SEUIL_FRAGILE_AMPLITUDES) return { classe: 'fragile', texte: 'fragile' };
  if (s.distance < SEUIL_SURVEILLER_AMPLITUDES) return { classe: 'surveiller', texte: 'à surveiller' };
  return { classe: 'solide', texte: 'solide' };
}

/** Phrase de seuil d une jauge : ce qu on cite en reunion. */
function phraseBascule(s, objectif) {
  const o = objectif.libelle.toLowerCase();
  if (s.inerte) {
    // Un levier qui ne deplace pas la grandeur mesuree le dit sans detour :
    // « ne suffit pas a redresser » laissait croire a un effet trop faible,
    // alors qu il n y a pas d effet du tout.
    return `sans effet sur ${o}`;
  }
  if (s.mode === 'retour') {
    if (s.trouve && s.variation === 0) return 'déjà au niveau visé';
    if (s.trouve) return `revient à flot à ${variationLisible(s.unite, s.variation)}`;
    if (s.approche) return `revient à flot vers ${variationLisible(s.unite, s.variation)} (approché)`;
    const borne = s.atteignable
      ? objectif.sens === 1
        ? Math.max(...s.atteignable)
        : Math.min(...s.atteignable)
      : null;
    return `ne suffit pas seul${nul(borne) ? '' : ` : au mieux ${valeurIndicateur(borne, objectif.unite)}`}`;
  }
  if (s.trouve && s.variation === 0) return 'déjà au point de bascule';
  if (s.trouve) return `bascule à ${variationLisible(s.unite, s.variation)}`;
  if (s.approche) return `bascule vers ${variationLisible(s.unite, s.variation)} (approché)`;
  const pire = s.atteignable
    ? objectif.sens === 1
      ? Math.min(...s.atteignable)
      : Math.max(...s.atteignable)
    : null;
  return `pas de bascule jusqu’à ${variationLisible(s.unite, s.direction * PLAGE_BASCULE_AMPLITUDES * s.amplitude)}${
    nul(pire) ? '' : ` · au pire ${valeurIndicateur(pire, objectif.unite)}`
  }`;
}

/** Ordre d affichage : les plus fragiles d abord, les robustes ensuite. */
function comparerBascules(a, b) {
  const rang = (s) => (s.inerte || (!s.trouve && !s.approche) ? 1 : 0);
  if (rang(a) !== rang(b)) return rang(a) - rang(b);
  return (a.distance ?? Infinity) - (b.distance ?? Infinity);
}

/** La liste des jauges, completes ou en cours de calcul. */
function peindreJauges(seuils, enCours) {
  const zone = document.getElementById('jauges-bascule');
  if (!zone) return;
  const objectif = objectifCourant();
  const appliques = seuils.filter((s) => s.applique);
  const tries = [...appliques].sort(comparerBascules);

  const jauge = (s) => {
    // La piste va de l hypothese actuelle (gauche) au bout de la plage
    // exploree (droite). Le trait de bascule se pose au prorata ; les
    // graduations marquent les amplitudes, l alea courant du levier.
    const pos = nul(s.distance) ? null : Math.min(100, (s.distance / PLAGE_BASCULE_AMPLITUDES) * 100);
    const grads = Array.from({ length: PLAGE_BASCULE_AMPLITUDES - 1 }, (_, k) => {
      const x = ((k + 1) / PLAGE_BASCULE_AMPLITUDES) * 100;
      return `<span class="bascule__grad" style="left:${x}%"></span>`;
    }).join('');
    const inverse = s.mode === 'retour';
    if (s.inerte || nul(pos)) {
      return `<span class="bascule__piste"><span class="bascule__zone bascule__zone--${
        inverse ? 'casse' : 'tient'
      }" style="left:0;width:100%"></span>${grads}</span>`;
    }
    return (
      `<span class="bascule__piste">` +
      `<span class="bascule__zone bascule__zone--${inverse ? 'casse' : 'tient'}" style="left:0;width:${pos.toFixed(1)}%"></span>` +
      `<span class="bascule__zone bascule__zone--${inverse ? 'tient' : 'casse'}" style="left:${pos.toFixed(1)}%;width:${(100 - pos).toFixed(1)}%"></span>` +
      `${grads}<span class="bascule__seuil" style="left:${pos.toFixed(1)}%"></span></span>`
    );
  };

  zone.innerHTML =
    tries
      .map((s) => {
        const b = badgeBascule(s);
        const ouverte = levierDeplie === s.code;
        const poids = nul(s.ecart_tornade)
          ? ''
          : `à ${amplitudeLisible(levierDe(s.code), s.amplitude)} : ${valeurIndicateur(s.ecart_tornade, objectif.unite)} d’écart`;
        return (
          `<button type="button" class="bascule__ligne${ouverte ? ' bascule__ligne--ouverte' : ''}" ` +
          `data-bascule="${att(s.code)}" aria-expanded="${ouverte}">` +
          `<span class="bascule__nom">${att(s.libelle)}` +
          `<small>${att(s.actionnable ? 'négociable' : 'subi')}${poids ? ' · ' + att(poids) : ''}</small></span>` +
          `${jauge(s)}` +
          `<span class="bascule__seuil-txt"><span class="bascule__badge bascule__badge--${b.classe}">${att(b.texte)}</span>` +
          `<span>${att(phraseBascule(s, objectif))}</span></span>` +
          `</button>` +
          (ouverte ? `<div class="bascule__depli" data-depli="${att(s.code)}"></div>` : '')
        );
      })
      .join('') +
    (enCours
      ? `<p class="aide">Points de bascule en cours de calcul... ${appliques.length} hypothèse${
          appliques.length > 1 ? 's' : ''
        } examinée${appliques.length > 1 ? 's' : ''}.</p>`
      : '');

  const muets = seuils.filter((s) => s.applique === false);
  const zoneMuets = document.getElementById('bascules-sans-prise');
  if (zoneMuets) {
    zoneMuets.hidden = !muets.length || enCours;
    if (muets.length) {
      zoneMuets.innerHTML =
        `Sans prise sur cette opération : ${muets.map((s) => att(s.libelle)).join(', ')}. ` +
        `<span>Rien n’a été essayé de ce côté-là - l’opération ne porte pas de quoi les faire varier.</span>`;
    }
  }
  if (!enCours && levierDeplie) rendreDepliBascule(levierDeplie);
}

/**
 * Titre et sous-titre de la section des jauges, selon le verdict.
 *
 * « Ne tient pas » ne se dit que sur la cible PAR DEFAUT : sur une cible
 * choisie, l operation peut fort bien tenir sans l atteindre, et le lui
 * reprocher serait faux.
 */
function poserTitreBascules(tient) {
  const titre = document.getElementById('titre-bascules');
  const sous = document.getElementById('soustitre-bascules');
  // Le vocabulaire de SURVIE - tenir, etre a flot - n a de sens que sur les
  // lectures qui la mesurent, cumul et creux, a leur cible par defaut. Sur
  // les fonds propres appeles ou une cible choisie, ne pas l atteindre n est
  // pas une avarie : le ton redevient neutre.
  const lectureDeSurvie =
    (objectifSensibilite === 'autofinancement_cumule' || objectifSensibilite === 'creux_cumul') &&
    nul(cibleBascule);
  const cibleChoisie = !lectureDeSurvie;
  if (titre) {
    titre.textContent = tient
      ? 'Ce que l’opération encaisse'
      : cibleChoisie
        ? 'Ce qui l’amènerait au niveau visé'
        : 'Ce qui la ramènerait à flot';
  }
  if (sous) {
    sous.textContent = tient
      ? 'Chaque hypothèse est poussée jusqu’au point où l’opération casse. Les plus fragiles sont en tête ; cliquez une ligne pour le détail.'
      : cibleChoisie
        ? 'Le niveau visé n’est pas atteint : chaque ligne dit le mouvement qui, à lui seul, y amènerait l’opération.'
        : 'L’opération ne tient pas : chaque ligne dit le mouvement qui, à lui seul, la ramènerait au niveau visé.';
  }
}

/** Clause de fragilite du verdict, une fois les seuils connus. */
function poserClauseFragilite(seuils, tient) {
  const clause = document.getElementById('verdict-fragilite');
  if (!clause) return;
  if (!tient) {
    clause.hidden = true;
    return;
  }
  const fragiles = seuils
    .filter((s) => s.applique && s.mode === 'bascule' && (s.trouve || s.approche))
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  const tete = fragiles[0];
  clause.hidden = false;
  if (!tete) {
    clause.textContent = 'Aucune hypothèse testée ne la fait basculer dans les plages explorées.';
  } else if (tete.distance < SEUIL_FRAGILE_AMPLITUDES) {
    clause.innerHTML =
      `Mais elle est à la merci d’une hypothèse : <strong>${att(minuscule(tete.libelle))}</strong>, ` +
      `${att(variationLisible(tete.unite, tete.variation))} suffit à la faire basculer.`;
  } else {
    clause.innerHTML = `Le point à surveiller : <strong>${att(minuscule(tete.libelle))}</strong>, bascule à ${att(
      variationLisible(tete.unite, tete.variation),
    )}.`;
  }
}

// ---------------------------------------------------------------- tempete

/**
 * Les trois bascules les plus proches, poussees ENSEMBLE d une amplitude dans
 * leur sens defavorable. Une seule phrase, et l ecart a la somme des effets
 * isoles - le moteur n est pas lineaire, et c est ici que cela se voit.
 */
function calculerTempete(entrees, refs, seuils, objectif) {
  const candidats = seuils
    .filter((s) => s.applique && s.mode === 'bascule' && !s.inerte && s.direction)
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
    .slice(0, 3);
  if (candidats.length < 2) return null;
  const r = scenarios(entrees, refs, {
    indicateur: objectif.code,
    contexte: contexteLecture(),
    leviers: candidats.map((s) => ({ code: s.code, crans: [0, s.direction] })),
  });
  if (r.etat === 'trop de combinaisons') return null;
  const complet = r.scenarios.find((s) => s.mouvements.length === candidats.length);
  if (!complet || nul(complet.valeur)) return null;
  return { candidats, reference: r.reference, scenario: complet };
}

function peindreTempete(tempete, objectif) {
  const bloc = document.getElementById('bloc-tempete');
  const zone = document.getElementById('tempete-sensibilite');
  if (!bloc || !zone) return;
  bloc.hidden = !tempete;
  if (!tempete) return;
  const noms = tempete.candidats.map((c) => minuscule(c.libelle));
  const liste =
    noms.length > 1 ? `${noms.slice(0, -1).join(', ')} et ${noms.at(-1)}` : noms[0];
  const s = tempete.scenario;
  const casse = !satisfaitCible(s.valeur, objectif, cibleEffective());
  const inter = s.interaction;
  const detailInter = nul(inter)
    ? ''
    : Math.abs(inter) < Math.max(1, Math.abs(s.ecart ?? 0) * 0.01)
      ? ' Les effets s’additionnent simplement.'
      : (objectif.sens === 1) === inter < 0
        ? ` Ensemble, ces dérives coûtent ${eur(Math.abs(inter))} de plus que la somme de leurs effets pris séparément.`
        : ` L’assemblage coûte ${eur(Math.abs(inter))} de moins que la somme de ses parties.`;
  zone.className = casse ? 'optim optim--hors' : 'optim';
  zone.innerHTML =
    `<p class="optim__detail">Si ${att(liste)} dérapent ensemble d’un cran chacun, ` +
    `${att(objectif.libelle.toLowerCase())} ${casse ? 'tombe' : 'passe'} à ` +
    `<strong>${att(valeurIndicateur(s.valeur, objectif.unite))}</strong>` +
    `${casse ? ' : l’opération ne tient plus' : ''}.${att(detailInter)}</p>`;
}

// ---------------------------------------------------------------- marges

/**
 * Ce que la negociation peut rattraper, en toutes lettres. Calcule d office
 * quand l operation ne satisfait pas la cible ; quand elle tient, le verdict
 * le dit deja et la section reste cachee.
 */
function peindreMarges(marges, objectif) {
  const bloc = document.getElementById('bloc-marges');
  const zone = document.getElementById('marges-sensibilite');
  if (!bloc || !zone) return;
  if (!marges || marges.etat === 'deja') {
    bloc.hidden = true;
    return;
  }
  bloc.hidden = false;
  const ecrire = (v) => valeurIndicateur(v, objectif.unite);
  const mouvement = (m) => `${minuscule(m.libelle)} ${variationLisible(m.unite, m.variation)}`;

  if (marges.etat === 'hors de portee') {
    zone.className = 'optim optim--hors';
    zone.innerHTML =
      `<p class="optim__verdict">⚠ La négociation seule n’y suffit pas, dans les limites explorées.</p>` +
      `<ul class="optim__liste">${marges.pistes
        .map(
          (p) =>
            `<li><span>${att(p.libelle)}</span><span class="num">au mieux ${att(ecrire(p.extreme))}</span></li>`,
        )
        .join('')}</ul>` +
      (marges.sansPrise.length
        ? `<p class="optim__detail">Sans objet sur ce dossier : ${att(marges.sansPrise.join(', ').toLowerCase())}.</p>`
        : '') +
      `<p class="optim__detail">C’est le programme ou les loyers qu’il faut revoir, pas la négociation.</p>`;
    return;
  }

  const gagnantes = marges.pistes.filter((p) => p.trouve);
  const combi = marges.combinaison?.trouve ? marges.combinaison : null;
  const tete = gagnantes[0];
  const meilleure =
    combi && (!tete || combi.effort < tete.effort - 1e-9)
      ? { texte: combi.mouvements.map(mouvement).join(' et '), valeur: combi.valeur }
      : tete
        ? { texte: mouvement(tete), valeur: tete.valeur }
        : null;
  if (!meilleure) {
    bloc.hidden = true;
    return;
  }
  zone.className = 'optim optim--bon';
  zone.innerHTML =
    `<p class="optim__verdict">✓ Le plus court chemin : <strong>${att(meilleure.texte)}</strong>.</p>` +
    `<p class="optim__detail">${att(objectifCourant().libelle)} passe de ${att(ecrire(marges.valeur))} à ` +
    `<strong>${att(ecrire(meilleure.valeur))}</strong>.</p>` +
    `<ul class="optim__liste">${gagnantes
      .map(
        (p) =>
          `<li><span>${att(p.libelle)} seul</span><span class="num">${att(
            variationLisible(p.unite, p.variation),
          )}</span></li>`,
      )
      .join('')}${
      combi
        ? `<li><span>Les deux ensemble</span><span class="num">${att(
            combi.mouvements.map((m) => variationLisible(m.unite, m.variation)).join(' / '),
          )}</span></li>`
        : ''
    }</ul>` +
    (marges.sansPrise.length
      ? `<p class="optim__detail">Sans objet sur ce dossier : ${att(marges.sansPrise.join(', ').toLowerCase())}.</p>`
      : '');
}

// ---------------------------------------------------------------- depli

/**
 * Annee de SORTIE DEFINITIVE du rouge : celle qui suit le dernier cumul
 * negatif. « Premier exercice positif » etait vrai et trompeur sur un cumul
 * qui demarre positif, plonge, puis remonte. Null si le cumul ne passe
 * jamais en negatif.
 */
function anneeSortieDuRouge(resultat) {
  const lignes = resultat?.exploitation?.lignes ?? [];
  const dernierRouge = lignes.findLast((l) => (l.cumul_autofinancement_eur ?? 0) < 0);
  if (!dernierRouge) return null;
  const i = lignes.indexOf(dernierRouge);
  return lignes[i + 1]?.annee ?? null;
}

/**
 * Mini-graphe du cumul : la trajectoire SAISIE en gris, la trajectoire au
 * POINT DE BASCULE en couleur, la ligne de zero en pointille. Aucun passage
 * moteur : les deux resultats sont deja en cache.
 */
function miniGrapheCumul(reference, variante) {
  const serieRef = (reference?.exploitation?.lignes ?? []).map((l) => l.cumul_autofinancement_eur ?? 0);
  const serieVar = (variante?.exploitation?.lignes ?? []).map((l) => l.cumul_autofinancement_eur ?? 0);
  if (serieRef.length < 2) return '';
  const tout = [...serieRef, ...serieVar, 0];
  const min = Math.min(...tout);
  const max = Math.max(...tout);
  const etendue = max - min || 1;
  const L = 600;
  const H = 110;
  const y = (v) => 6 + (H - 12) * (1 - (v - min) / etendue);
  const trace = (serie) =>
    serie
      .map((v, i) => `${((i / (serie.length - 1)) * L).toFixed(1)},${y(v).toFixed(1)}`)
      .join(' ');
  return (
    `<svg class="mini-cumul" viewBox="0 0 ${L} ${H}" role="img" aria-label="Cumul d’autofinancement, saisie et variante au point de bascule">` +
    `<line class="mini-cumul__zero" x1="0" y1="${y(0).toFixed(1)}" x2="${L}" y2="${y(0).toFixed(1)}" />` +
    `<polyline class="mini-cumul__ref" points="${trace(serieRef)}" />` +
    (serieVar.length > 1 ? `<polyline class="mini-cumul__var" points="${trace(serieVar)}" />` : '') +
    `</svg>` +
    `<p class="aide">Cumul d’autofinancement : <span class="mini-cumul__leg mini-cumul__leg--ref">telle que saisie</span>` +
    (serieVar.length > 1 ? ` · <span class="mini-cumul__leg mini-cumul__leg--var">au point de bascule</span>` : '') +
    `</p>`
  );
}

/** Detail d une jauge depliee : synthese, mini-graphe, balayage. */
function rendreDepliBascule(code) {
  const zone = document.querySelector(`[data-depli="${code}"]`);
  const a = analyseSensibilite;
  if (!zone || !a) return;
  const s = a.seuils.find((x) => x.code === code);
  const objectif = objectifDe(a.objectif) ?? OBJECTIFS[0];
  if (!s) return;

  // Balayage en cache par levier : sept points qui ENCADRENT le seuil quand il
  // existe, l amplitude courante sinon.
  if (!a.balayages.has(code)) {
    const portee = Math.max(s.amplitude, Math.abs(s.variation ?? 0) * 1.25);
    a.balayages.set(
      code,
      balayerLevier(etatPourAnalyse(), referentielsPourAnalyse(), code, plage(portee, 7)).points,
    );
  }
  const points = a.balayages.get(code);

  const charnieres = (() => {
    if (!s.resultat) return '';
    const avant = anneeSortieDuRouge(dernierResultat);
    const apres = anneeSortieDuRouge(s.resultat);
    if (avant === apres) return '';
    const dire = (annee) => (nul(annee) ? 'jamais dans le rouge' : `sort du rouge en ${annee}`);
    return `<p class="aide">Cumul : ${att(dire(apres))} à ce niveau, contre ${att(dire(avant))} aujourd’hui.</p>`;
  })();

  const lignesTable = points
    .map((p) => {
      const v = objectif.lire(p.resultat, contexteLecture());
      const tri = indicateurDe('tri')?.lire(p.resultat, contexteLecture());
      const ecart = nul(v) || nul(a.reference) ? null : v - a.reference;
      return `<tr class="${p.variation === 0 ? 'poste--reference' : ''}">
        <td>${att(variationLisible(s.unite, p.variation))}${p.variation === 0 ? ' <em>(saisie)</em>' : ''}</td>
        <td class="num">${p.erreur ? att(p.erreur) : valeurIndicateur(v, objectif.unite)}</td>
        <td class="num ${ecart < 0 ? 'montant--negatif' : ''}">${
          nul(ecart) ? '-' : (ecart > 0 ? '+' : '') + valeurIndicateur(ecart, objectif.unite)
        }</td>
        <td class="num">${valeurIndicateur(tri, 'taux')}</td></tr>`;
    })
    .join('');

  zone.innerHTML =
    (s.trouve && s.resultat && !nul(s.variation) && s.variation !== 0
      ? `<p class="aide">À ${att(variationLisible(s.unite, s.variation))}, ${att(
          objectif.libelle.toLowerCase(),
        )} rejoint le niveau visé (${att(valeurIndicateur(a.cible, objectif.unite))}).</p>`
      : '') +
    miniGrapheCumul(dernierResultat, s.resultat) +
    charnieres +
    `<div class="table-defilante"><table class="tableau">
      <thead><tr><th>Variation</th><th class="num">${att(objectif.libelle)}</th>
      <th class="num">Écart</th><th class="num">TRI</th></tr></thead>
      <tbody>${lignesTable}</tbody></table></div>`;
}

// ---------------------------------------------------------------- pipeline

/** L analyse en cache vaut-elle encore pour ce resultat et cette lecture ? */
function analyseValide() {
  const a = analyseSensibilite;
  return (
    !!a &&
    a.resultat === dernierResultat &&
    a.objectif === objectifSensibilite &&
    a.cible === cibleEffective() &&
    a.annee === anneeCumul
  );
}

/**
 * Le pipeline : verdict tout de suite, puis tornade, seuils un par un,
 * tempete et marges. Chaque etape peint des qu elle sait ; le jeton abandonne
 * la suite si le dossier ou la lecture change en cours de route.
 */
async function lancerAnalyseSensibilite() {
  const jeton = ++jetonAnalyse;
  const objectif = objectifCourant();
  const cible = cibleEffective();
  const resultatDeDepart = dernierResultat;
  const entrees = etatPourAnalyse();
  const refs = referentielsPourAnalyse();
  const pause = () => new Promise((r) => setTimeout(r, 0));
  /**
   * L analyse est perimee dans deux cas qui ne se traitent pas pareil :
   *  - un pipeline PLUS RECENT a pris la main (jeton depasse) : lui vit, on
   *    s efface sans bruit ;
   *  - le RESULTAT MOTEUR a change sous nos pieds - une saisie retouchee, un
   *    parametre deplace - sans que personne ne relance : s arreter la
   *    laisserait l ecran sur « en cours de calcul » pour toujours. On
   *    RELANCE donc l analyse sur le nouveau resultat, si l ecran est
   *    toujours affiche.
   */
  const perime = () => {
    if (jeton !== jetonAnalyse) return true;
    if (dernierResultat === resultatDeDepart) return false;
    const ecran = document.getElementById('ecran-sensibilite');
    if (ecran && !ecran.hidden && dernierResultat) setTimeout(rendreSensibilite, 0);
    return true;
  };

  peindreJauges([], true);
  await pause();
  if (perime()) return;

  // La tornade lue sur l objectif : dix-sept passages, et deux services - le
  // poids de chaque levier, et le SENS dans lequel il degrade.
  const t = tornade(entrees, refs, { indicateur: objectif.code, contexte: contexteLecture() });
  const tient = satisfaitCible(t.reference, objectif, cible);
  poserTitreBascules(tient);
  await pause();
  if (perime()) return;

  const seuils = [];
  const a = {
    resultat: resultatDeDepart,
    objectif: objectif.code,
    cible,
    annee: anneeCumul,
    reference: t.reference,
    seuils,
    balayages: new Map(),
    finie: false,
  };
  analyseSensibilite = a;

  // Les seuils, un levier a la fois, l ecran se remplissant au fil de l eau.
  for (const barre of t.barres) {
    seuils.push(calculerBascule(entrees, refs, barre, objectif, cible, t.reference));
    peindreJauges(seuils, true);
    await pause();
    if (perime()) return;
  }

  peindreJauges(seuils, false);
  poserClauseFragilite(seuils, tient);

  // La tempete, puis les marges : chacune peut coûter quelques dizaines de
  // passages, chacune a sa pause.
  const tempete = calculerTempete(entrees, refs, seuils, objectif);
  peindreTempete(tempete, objectif);
  await pause();
  if (perime()) return;

  const marges = tient
    ? null
    : optimiser(entrees, refs, { objectif: objectif.code, cible, contexte: contexteLecture() });
  peindreMarges(marges, objectif);
  a.tempete = tempete;
  a.marges = marges;
  a.finie = true;
  // Une jauge depliee PENDANT la tempete ou les marges attendait la fin :
  // son contenu ne se remplit que quand l analyse est declaree finie. Un
  // dernier repeint la sert, et ne coute des passages moteur que si un depli
  // est ouvert (le balayage se met alors en cache).
  peindreJauges(seuils, false);
}

function rendreSensibilite() {
  rendreQuestionEquilibre();
  rendreChoixScenarios();
  peuplerReglagesLecture();
  const verdict = document.getElementById('verdict-sensibilite');
  if (!verdict) return;
  if (!dernierResultat) {
    verdict.className = 'optim';
    verdict.innerHTML = '<p class="optim__detail">Aucun résultat : la saisie est incomplète.</p>';
    const jauges = document.getElementById('jauges-bascule');
    if (jauges) jauges.innerHTML = '';
    for (const id of ['bloc-tempete', 'bloc-marges']) {
      const b = document.getElementById(id);
      if (b) b.hidden = true;
    }
    return;
  }
  rendreVerdictSensibilite();
  if (analyseValide()) {
    // Tout est en cache : on repeint sans un seul passage moteur.
    const a = analyseSensibilite;
    const objectif = objectifCourant();
    const tient = satisfaitCible(a.reference, objectif, a.cible);
    poserTitreBascules(tient);
    peindreJauges(a.seuils, !a.finie);
    if (a.finie) {
      poserClauseFragilite(a.seuils, tient);
      peindreTempete(a.tempete, objectif);
      peindreMarges(a.marges, objectif);
    }
    return;
  }
  lancerAnalyseSensibilite();
}

// ------------------------------------------------- outils replies

/** Question posee a la recherche d equilibre, et sa derniere reponse. */
let equilibreObjectif = OBJECTIFS[0].code;
// Le premier levier ACTIONNABLE, pas le premier du catalogue : le selecteur
// ne propose que les actionnables, et un etat qui pointe hors de sa liste fait
// calculer autre chose que ce que l ecran affiche.
let equilibreLevier = (LEVIERS.find((l) => l.actionnable) ?? LEVIERS[0]).code;

/**
 * Prepare la question, sans la resoudre.
 *
 * La recherche coute jusqu'a soixante passages du moteur : elle ne part que
 * sur un geste explicite. Arriver sur l'ecran ne doit pas lancer un calcul
 * dont on n'a pas encore choisi les termes.
 */
function rendreQuestionEquilibre() {
  const o = document.getElementById('eq-objectif');
  const l = document.getElementById('eq-levier');
  if (!o || !l) return;
  if (!o.options.length) {
    o.innerHTML = OBJECTIFS.map(
      (x) => `<option value="${att(x.code)}">${att(x.libelle)}</option>`,
    ).join('');
  }
  if (!l.options.length) {
    // Seuls les leviers ACTIONNABLES : on ne choisit pas le Livret A ni le taux
    // de vacance, on les subit. Les proposer ici laissait croire a une marge de
    // manoeuvre qui n'existe pas. Les jauges, elles, les couvrent tous - la
    // question y est de savoir ce qui casse, non ce qu'on peut faire.
    l.innerHTML = LEVIERS.filter((x) => x.actionnable).map(
      (x) => `<option value="${att(x.code)}">${att(x.libelle)}</option>`,
    ).join('');
  }
  o.value = equilibreObjectif;
  l.value = equilibreLevier;
  // Le bloc ne s ouvre pas sur une ligne vide : il dit ce qu il attend.
  const zone = document.getElementById('eq-reponse');
  if (zone && !zone.textContent.trim()) {
    zone.className = 'equilibre__reponse equilibre__reponse--vide';
    zone.textContent = "Choisissez ce qu’il faut atteindre, puis cliquez sur « Chercher ».";
  }
}

/** Resout la question et ecrit la reponse en toutes lettres. */
function resoudreEquilibre() {
  const zone = document.getElementById('eq-reponse');
  if (!zone || !dernierResultat) return;
  const cible = lireMontant(document.getElementById('eq-cible')?.value);
  if (nul(cible)) {
    zone.className = 'equilibre__reponse equilibre__reponse--vide';
    zone.textContent = 'Indiquez la valeur à atteindre.';
    return;
  }

  const r = chercherEquilibre(etatPourAnalyse(), referentielsPourAnalyse(), {
    levier: equilibreLevier,
    objectif: equilibreObjectif,
    cible,
    contexte: contexteLecture(),
  });
  const ecrire = (v) => valeurIndicateur(v, r.objectif.unite);
  const quand = anneeCumul ? ` en ${anneeCumul}` : '';

  if (!r.applique) {
    zone.className = 'equilibre__reponse equilibre__reponse--sans';
    zone.textContent = `${r.levier.libelle} : ${r.raison}.`;
    return;
  }
  if (!r.trouve) {
    zone.className = 'equilibre__reponse equilibre__reponse--hors';
    zone.innerHTML = r.atteignable
      ? `⚠ Hors de portée. En jouant sur ${att(r.levier.libelle)} seul, ` +
        `${att(r.objectif.libelle.toLowerCase())} ne descend pas sous ` +
        `<strong>${att(ecrire(r.atteignable[0]))}</strong> ni ne monte au-dessus de ` +
        `<strong>${att(ecrire(r.atteignable[1]))}</strong>.`
      : `⚠ ${att(r.raison)}.`;
    return;
  }
  // La version TROUVEE se decrit au-dela de la seule variation : le resultat
  // complet est la, autant dire ce que cette version vaut sur les grandeurs
  // qu un comite regarde.
  const indVersion = r.resultat?.exploitation?.indicateurs;
  const portrait = indVersion
    ? ` <span class="aide">Cette version : creux ${att(eur(indVersion.creux_cumul_eur))}, ` +
      `${att(nb(indVersion.exercices_deficitaires ?? 0))} exercice${(indVersion.exercices_deficitaires ?? 0) > 1 ? 's' : ''} déficitaire${(indVersion.exercices_deficitaires ?? 0) > 1 ? 's' : ''}, ` +
      `TRI ${att(valeurIndicateur(indVersion.tri, 'taux'))}.</span>`
    : '';
  zone.className = 'equilibre__reponse';
  zone.innerHTML =
    r.iterations === 0
      ? `✓ Déjà atteint : ${att(r.objectif.libelle.toLowerCase())} vaut ` +
        `<strong>${att(ecrire(r.valeur))}</strong>, rien à changer.`
      : `✓ Il faut <strong>${att(variationLisible(r.levier.unite, r.variation))}</strong> sur ` +
        `${att(minuscule(r.levier.libelle))} pour amener ` +
        `${att(r.objectif.libelle.toLowerCase())}${quand} à ` +
        `<strong>${att(ecrire(r.valeur))}</strong>.${portrait}`;
}

/** Leviers retenus dans la table des combinaisons, et ordre de classement. */
const leviersScenarios = new Set(LEVIERS.filter((l) => l.actionnable).map((l) => l.code));
let triScenarios = 'resultat';

/** Cases a cocher : un levier par case, l actionnable coche d office. */
function rendreChoixScenarios() {
  const zone = document.getElementById('scen-leviers');
  if (!zone || zone.children.length) return;
  zone.innerHTML = LEVIERS.map(
    (l) =>
      `<label class="case"><input type="checkbox" data-levier-scenario="${att(l.code)}"` +
      `${leviersScenarios.has(l.code) ? ' checked' : ''} /> ${att(l.libelle)}</label>`,
  ).join('');
}

/**
 * Enumere les combinaisons et les classe.
 *
 * Le classement par RESULTAT met toujours en tete le scenario qui pousse tout
 * du bon cote : c'est vrai et sans interet, puisque personne ne l'obtient. Le
 * classement au RAPPORT divise le gain par l'effort et remonte les assemblages
 * qui rapportent le plus par cran negocie - c'est celui qu'on lit quand on
 * prepare une reunion.
 */
function rendreScenarios() {
  const message = document.getElementById('scen-message');
  const table = document.getElementById('table-scenarios');
  if (!message || !table || !dernierResultat) return;

  const choisis = [...leviersScenarios];
  if (!choisis.length) {
    message.className = 'optim optim--hors';
    message.innerHTML = `<p class="optim__verdict">Cochez au moins une hypothèse.</p>`;
    table.querySelector('thead').innerHTML = '';
    table.querySelector('tbody').innerHTML = '';
    return;
  }

  const r = scenarios(etatPourAnalyse(), referentielsPourAnalyse(), {
    indicateur: objectifSensibilite,
    contexte: contexteLecture(),
    leviers: choisis.map((code) => ({ code, crans: [-1, 0, 1] })),
  });

  if (r.etat === 'trop de combinaisons') {
    message.className = 'optim optim--hors';
    message.innerHTML =
      `<p class="optim__verdict">⚠ ${att(nb(r.total))} combinaisons, c’est trop.</p>` +
      `<p class="optim__detail">Chaque hypothèse cochée multiplie la table par trois. ` +
      `Au-delà de ${att(nb(r.max))} combinaisons le calcul prendrait plusieurs minutes : ` +
      `décochez-en pour redescendre. La liste n’est pas tronquée, elle n’est pas calculée - ` +
      `une liste incomplète qu’on croirait entière serait pire que pas de liste.</p>`;
    table.querySelector('thead').innerHTML = '';
    table.querySelector('tbody').innerHTML = '';
    return;
  }

  const unite = r.indicateur.unite;
  const ecrire = (v) => valeurIndicateur(v, unite);
  const signe = (v) => (v > 0 ? '+' : '');
  // Le RAPPORT n'a de sens que sur un scenario qui bouge : celui qui ne touche
  // a rien a un effort nul, et diviser par zero le mettrait en tete de tout.
  const rapport = (s) => (s.effort > 0 && s.ecart !== null ? s.ecart / s.effort : null);
  const sens = r.indicateur.sens;
  const liste = [...r.scenarios];
  if (triScenarios === 'rapport') {
    liste.sort((a, b) => {
      const ra = rapport(a);
      const rb = rapport(b);
      if ((ra === null) !== (rb === null)) return ra === null ? 1 : -1;
      if (ra === null) return 0;
      return sens === 1 ? rb - ra : ra - rb;
    });
  }

  message.className = 'optim';
  message.innerHTML =
    `<p class="optim__detail">${att(nb(r.total))} combinaisons calculées. Référence : ` +
    `<strong>${att(ecrire(r.reference))}</strong>. Les écarts se lisent par rapport à elle.</p>` +
    // Les leviers sans prise sont NOMMES : sans cela on croirait avoir teste
    // une hypothese qui n a jamais bouge.
    (r.sansPrise.length
      ? `<p class="optim__detail">Écartés faute de prise sur cette opération : ` +
        `${att(r.sansPrise.map((s) => s.libelle).join(', '))}.</p>`
      : '');

  table.querySelector('thead').innerHTML =
    `<tr><th>Composition</th><th class="num">Effort</th>` +
    `<th class="num">${att(r.indicateur.libelle)}</th><th class="num">Écart</th>` +
    `<th class="num">Gain par effort</th><th class="num">Effet de seuil</th></tr>`;

  table.querySelector('tbody').innerHTML = liste
    .map((s) => {
      const compo = s.mouvements.length
        ? s.mouvements
            .map(
              (m) =>
                `<span class="scen-mvt scen-mvt--${m.cran > 0 ? 'haut' : 'bas'}">` +
                `${att(m.libelle)} ${signe(m.cran)}${m.cran}</span>`,
            )
            .join(' ')
        : '<em>l’opération telle qu’elle est</em>';
      const rp = rapport(s);
      // L EFFET DE SEUIL ne se lit que sur un assemblage : sur un levier seul
      // il vaut zero par construction, l afficher ferait croire a une mesure.
      const inter =
        s.mouvements.length > 1 && s.interaction !== null
          ? `${signe(s.interaction)}${ecrire(s.interaction)}`
          : '-';
      return (
        `<tr class="${s.mouvements.length ? '' : 'poste--reference'}">` +
        `<td>${compo}</td>` +
        `<td class="num">${s.effort || '-'}</td>` +
        `<td class="num">${att(ecrire(s.valeur))}</td>` +
        `<td class="num ${s.ecart < 0 ? 'montant--negatif' : ''}">${
          s.ecart === null ? '-' : signe(s.ecart) + att(ecrire(s.ecart))
        }</td>` +
        `<td class="num">${rp === null ? '-' : signe(rp) + att(ecrire(rp))}</td>` +
        `<td class="num ${s.interaction < 0 ? 'montant--negatif' : ''}">${att(inter)}</td></tr>`
      );
    })
    .join('');
}

/**
 * Entrees et referentiels tels que le moteur les recoit.
 *
 * L'analyse doit partir de CE QUI EST CALCULE et non de l'etat brut : le
 * parametrage actif, les postes vides ecartes, les prets theoriques. Sans
 * cela sa reference ne serait pas celle affichee a l'ecran, et tout l'exercice
 * porterait a faux.
 */
function etatPourAnalyse() {
  const entrees = structuredClone(etat);
  entrees.parametrage = structuredClone(parametrageActif());
  if (etat.mode_prets === 'theoriques') entrees.prets = [];
  entrees.postes_bilan = entrees.postes_bilan.filter((p) => !nul(p.montant_ht_eur));
  return entrees;
}
const referentielsPourAnalyse = () => referentiels;

function rendreApercuExport() {
  const cible = document.getElementById('apercu-export');
  if (!cible) return;
  const def = EXPORTS[exportChoisi] ?? EXPORTS['prix-revient'];
  const i = etat.identite ?? {};

  const enTete = `
    <header class="doc__entete">
      <div>
        <strong>${att(i.nom || 'Simulation sans nom')}</strong>
        ${i.groupe ? `<span>Projet ${att(i.groupe)}</span>` : ''}
      </div>
      <div class="doc__meta">
        <span>${att([i.commune, i.zone_ABC && `zone ${i.zone_ABC}`, i.type_operation].filter(Boolean).join(' · '))}</span>
        ${
          // Un document cadre sur une tranche DOIT le dire des la premiere
          // ligne : les memes tableaux, aux memes places, avec des montants
          // trois fois moindres, se confondent sinon avec ceux de
          // l'operation entiere.
          perimetreDuDocument()
            ? `<span><strong>Périmètre ${att(libelleProduit(perimetreDuDocument()))}</strong></span>`
            : ''
        }
        <span>${att(def.titre)} · édité le ${att(dateDuJour())}</span>
      </div>
    </header>`;

  cible.innerHTML = enTete;

  // PERIMETRE DU DOCUMENT. Choisir une seule tranche ne masque pas des
  // colonnes : cela change ce que le dossier RACONTE. Emplois, ressources,
  // prets, subventions et fonds propres se recalculent alors pour cette
  // tranche seule - le moteur sait deja le faire, c'est la vue qu'offre le
  // selecteur de l'ecran Financement. On la pose le temps du clonage, puis on
  // rend a l'ecran celle que l'utilisateur y avait laissee.
  const vueAvant = vueFinancement;
  const horsCompteAvant = new Set(tranchesHorsCompte);
  // Le compte suit le meme tri que le reste du document : les tranches
  // ecartees de l export le sont du compte le temps du clonage.
  const ecarteesExport = tranchesActives().filter((c) => !tranchesRetenues().includes(c));
  if (ecarteesExport.length && dernierResultat) {
    tranchesHorsCompte.clear();
    for (const c of ecarteesExport) tranchesHorsCompte.add(c);
    rendreExploitation(dernierResultat);
  }
  if (perimetreDuDocument() && dernierResultat) {
    vueFinancement = perimetreDuDocument();
    rendreFinancement(dernierResultat);
  }

  for (const id of def.ecrans) {
    const source = document.getElementById(`ecran-${id}`);
    if (!source) continue;
    const section = document.createElement('section');
    section.className = 'doc__section';
    const copie = /** @type {HTMLElement} */ (source.cloneNode(true));
    // Les adaptations propres a un ecran se font AVANT le retrait des
    // identifiants, tant qu'on peut encore designer les tables par le leur.
    if (id === 'prix-revient') adapterPrixRevientAuDocument(copie);
    // La repartition par financement est une autre table, sur le meme ecran :
    // elle liste une ligne par tranche et subit donc le meme tri. Son TOTAL
    // reste celui de l'operation entiere - il est marque comme tel plus bas.
    // Le total d une table triee reste celui de l OPERATION : le prix de
    // revient ne change pas parce qu on presente une tranche de moins. Il faut
    // donc le dire, sinon un lecteur additionne les lignes et trouve autre
    // chose.
    if (tranchesRetenues().length < tranchesActives().length) {
      for (const table of copie.querySelectorAll('table')) {
        if (!table.querySelector('tbody [data-tranche]')) continue;
        const pied = table.querySelector('tfoot .libelle');
        if (pied && pied.textContent.trim() === 'Total') pied.textContent = 'Total de l’opération';
      }
    }
    copie.removeAttribute('id');
    copie.removeAttribute('hidden');
    copie.removeAttribute('role');
    // Les identifiants dupliques feraient pointer les `getElementById` de
    // l'application sur la COPIE : tout rendu ulterieur ecrirait dans
    // l'apercu au lieu de l'ecran.
    for (const el of copie.querySelectorAll('[id]')) el.removeAttribute('id');
    // Ce qui sert a agir n'a rien a faire dans un document. Les CELLULES de
    // commande, elles, se vident sans disparaitre : les retirer decalerait les
    // lignes d'une colonne par rapport a leur en-tete, qui n'a pas de classe a
    // laquelle s'accrocher. Une colonne vide de trente pixels vaut mieux qu'un
    // tableau ou les chiffres ne sont plus sous leur intitule.
    for (const el of copie.querySelectorAll(
      '.bouton, .bouton--supprimer, .biblio-action, .poignee, .bloc__outils, .aide, .legende-saisie, .grille__aide, .tri__fleche',
    )) {
      el.remove();
    }
    // Ce qui ne sert qu a SAISIR quitte le document : le generateur de lots,
    // la liste des controles de coherence, le rappel des postes non modelises.
    // Ils parlent de l'outil et de son etat, pas de l'operation.
    for (const bloc of copie.querySelectorAll('[data-ecran-seul]')) bloc.remove();
    // Le selecteur de vue - consolide, puis une tranche apres l autre - est un
    // COMMANDE : dans un document il montre un choix qu on ne peut pas faire.
    // Le verdict des controles part avec lui : « 7 controles sur 7 passes »
    // rend compte d'une saisie, pas d'une operation. On ne presente pas a un
    // directoire le journal de bord de son tableur.
    // Ils se designent par leur MARQUE et non par leur identifiant : celui-ci a
    // deja ete retire de la copie quelques lignes plus haut, pour que les
    // rendus de l application ne viennent pas ecrire dans le document.
    adapterTablesAuDocument(copie);
    // Le tri des tranches vaut pour TOUT l ecran : le prix de revient a ses
    // colonnes, la synthese et la repartition ont leurs lignes.
    ecarterTranches(copie);
    figerSaisies(copie);
    section.appendChild(copie);
    cible.appendChild(section);
  }

  // Les colonnes se revisent ICI et pas pendant l'adaptation : une table qui
  // n'est pas encore dans la page n'a pas de largeur, et on ne peut mesurer ni
  // son contenu ni ses polices. Le document est monte, on peut regarder.
  ajusterColonnesDuDocument(cible);

  if (perimetreDuDocument() && dernierResultat) {
    vueFinancement = vueAvant;
    rendreFinancement(dernierResultat);
  }
  if (ecarteesExport.length && dernierResultat) {
    tranchesHorsCompte.clear();
    for (const c of horsCompteAvant) tranchesHorsCompte.add(c);
    rendreExploitation(dernierResultat);
  }

  const info = document.getElementById('exports-info');
  if (info) {
    const n = compterPages();
    info.textContent = `${n} page${n > 1 ? 's' : ''} · A4 paysage`;
  }
  rendreChoixTranches();
  for (const b of document.querySelectorAll('#choix-export [data-export]')) {
    b.classList.toggle('choix__option--actif', /** @type {HTMLElement} */ (b).dataset.export === exportChoisi);
  }
}

/**
 * Compte les pages que le PDF fera.
 *
 * Il se MESURE sur l'apercu au lieu d'etre estime : l'apercu a la geometrie
 * exacte du document imprime - meme largeur, memes marges - et une hauteur
 * de page vaut 210 mm, la feuille etant en paysage. Ce que le lecteur voit
 * defiler, le PDF le coupera aux memes endroits.
 *
 * Chaque section ouvre une page (`break-before: page`), d'ou le compte
 * section par section plutot que sur la hauteur totale.
 */
/**
 * Tranche sur laquelle le document est cadre, ou `null` s il les presente
 * toutes.
 *
 * Une operation qui n'a qu'une tranche n'est pas « cadree » sur elle : le
 * consolide EST cette tranche, et annoncer un perimetre la ou il n y a pas de
 * choix ne ferait que semer le doute.
 */
function perimetreDuDocument() {
  const retenues = tranchesRetenues();
  return retenues.length === 1 && tranchesActives().length > 1 ? retenues[0] : null;
}

function compterPages() {
  const doc = document.getElementById('apercu-export');
  if (!doc) return 0;
  const PAGE = 210 * 3.779528;
  const sections = [...doc.querySelectorAll('.doc__section')];
  if (!sections.length) return 0;
  const st = getComputedStyle(doc);
  const marges = parseFloat(st.paddingTop) + parseFloat(st.paddingBottom);
  const entete = doc.querySelector('.doc__entete');
  let pages = 0;
  sections.forEach((s, i) => {
    const cs = getComputedStyle(s);
    // La hauteur propre de la section : son remplissage haut n existe qu a
    // l ecran, ou il separe deux sections que l impression separe par une
    // coupure de page.
    let h = s.getBoundingClientRect().height - parseFloat(cs.paddingTop);
    if (i === 0) {
      h += marges;
      if (entete) {
        h += entete.getBoundingClientRect().height;
        h += parseFloat(getComputedStyle(entete).marginBottom);
      }
    } else {
      h += 16 * 3.779528; // la marge haute d une section qui ouvre une page
    }
    pages += Math.max(1, Math.ceil(h / PAGE));
  });
  return pages;
}

/**
 * Edite l'apercu en PDF, par l'impression du navigateur.
 *
 * Sans bibliotheque : le projet s'interdit toute dependance de production
 * (CLAUDE.md §3), la version autonome doit fonctionner hors ligne, et
 * l'impression native produit un document vectoriel dont le texte reste
 * selectionnable - une bibliotheque de rendu aurait donne une image.
 *
 * Le theme passe au CLAIR le temps de l'impression : les navigateurs
 * n'impriment pas les fonds, et en theme sombre on obtiendrait du texte pale
 * sur du blanc, c'est-a-dire une page vide.
 */
function telechargerPDF() {
  if (!idSimulationOuverte) return;
  rendreApercuExport();

  // Le navigateur nomme le fichier d apres le TITRE de la page. Sans cela
  // tous les exports arrivent dans le dossier de telechargement sous le nom
  // de l application, et le deuxieme s appelle « (1) ». On lui donne donc le
  // nom du document et de l operation, le temps de l impression.
  titreAvantImpression = document.title;
  const def = EXPORTS[exportChoisi] ?? EXPORTS['prix-revient'];
  const nomOp = (etat.identite?.nom || '').trim();
  document.title = [def.titre, nomOp].filter(Boolean).join(' - ').replace(/[\\/:*?"<>|]/g, ' ');

  // Le theme ne bascule plus : le document porte sa propre palette, celle du
  // papier, quel que soit celui de l application. L apercu et le PDF sont donc
  // rigoureusement de la meme couleur - ils ne l etaient pas, et c est ce qui
  // faisait passer inapercues les teintes de theme sombre sur fond blanc.
  document.body.classList.add('en-impression');
  // Laisser le navigateur appliquer le theme clair et la mise en page du
  // document avant d'ouvrir la boite, sinon il photographie l'etat precedent.
  //
  // Par un delai et non par `requestAnimationFrame` : celui-ci ne se declenche
  // pas dans un onglet qui n'est pas au premier plan, et l'application
  // resterait alors bloquee en theme clair, sans jamais imprimer.
  setTimeout(() => window.print(), 60);
}

/** Theme a rendre apres l'impression. */
let themeAvantImpression = null;
/** Titre de page a rendre apres l'impression. */
let titreAvantImpression = null;

// `afterprint` se declenche que l'on ait imprime ou annule : l'ecran revient
// dans les deux cas.
window.addEventListener('afterprint', () => {
  document.body.classList.remove('en-impression');
  if (themeAvantImpression) document.documentElement.dataset.theme = themeAvantImpression;
  themeAvantImpression = null;
  if (titreAvantImpression !== null) document.title = titreAvantImpression;
  titreAvantImpression = null;
});

// ---------------------------------------------------------------- dialogues

/**
 * La boite de dialogue de l'application, en remplacement de `confirm`,
 * `prompt` et `alert`.
 *
 * Les boites natives ont trois defauts qui comptent ici : elles ignorent la
 * charte, elles n'offrent jamais plus de deux issues, et elles ne laissent pas
 * la place d'EXPLIQUER ce qu'on s'apprete a faire. Or la plupart des
 * confirmations de cet outil detruisent quelque chose - un profil, un lot, une
 * simulation - et meritent une phrase.
 *
 * Elle rend une promesse : la cle de l'action choisie, ou `null` si
 * l'utilisateur a renonce (Echap, clic sur Annuler, fermeture). Quand la boite
 * porte un champ de saisie, la promesse rend la valeur saisie a la place.
 *
 * @param {Object} p
 * @param {string} p.titre
 * @param {string} [p.texte]
 * @param {{cle: string, libelle: string, style?: 'principal'|'danger'|'discret'}[]} p.actions
 * @param {{libelle?: string, valeur?: string, liste?: string}} [p.saisie]
 * @returns {Promise<string|null>}
 */
function ouvrirBoite({ titre, texte = '', actions, saisie }) {
  const boite = /** @type {HTMLDialogElement} */ (document.getElementById('boite-dialogue'));
  // Pas de boite dans le document : on ne bloque pas l'action pour autant, on
  // retombe sur la premiere issue non destructrice.
  if (!boite) return Promise.resolve(actions[actions.length - 1]?.cle ?? null);

  document.getElementById('boite-titre').textContent = titre;
  const pTexte = document.getElementById('boite-texte');
  pTexte.textContent = texte;
  pTexte.hidden = !texte;

  const champ = document.getElementById('boite-champ');
  const entree = /** @type {HTMLInputElement} */ (document.getElementById('boite-saisie'));
  champ.hidden = !saisie;
  if (saisie) {
    document.getElementById('boite-libelle').textContent = saisie.libelle ?? '';
    entree.value = saisie.valeur ?? '';
    // Une liste d'autocompletion se passe par son identifiant, comme sur un
    // champ ordinaire : la boite ne duplique pas les valeurs, elle pointe.
    if (saisie.liste) entree.setAttribute('list', saisie.liste);
    else entree.removeAttribute('list');
  }

  const zone = document.getElementById('boite-actions');
  zone.innerHTML = actions
    .map(
      (a) =>
        `<button type="button" class="bouton bouton--${a.style ?? 'discret'}" data-boite="${att(a.cle)}">${att(a.libelle)}</button>`,
    )
    .join('');

  return new Promise((resoudre) => {
    const conclure = (valeur) => {
      boite.removeEventListener('click', surClic);
      boite.removeEventListener('cancel', surEchap);
      boite.removeEventListener('submit', surEnvoi);
      boite.close();
      resoudre(valeur);
    };
    const surClic = (ev) => {
      const b = /** @type {HTMLElement} */ (ev.target).closest('[data-boite]');
      if (!b) return;
      const cle = /** @type {HTMLElement} */ (b).dataset.boite;
      // Une action d'annulation rend toujours `null`, saisie ou pas : c'est ce
      // que l'appelant teste pour ne rien faire.
      if (cle === 'annuler') return conclure(null);
      conclure(saisie ? entree.value : cle);
    };
    const surEchap = (ev) => {
      ev.preventDefault();
      conclure(null);
    };
    // Entree valide : sur un champ de saisie, taper puis appuyer sur Entree est
    // le geste naturel, et il ne doit pas fermer la boite sans rien faire.
    const surEnvoi = (ev) => {
      ev.preventDefault();
      const principale = actions.find((a) => a.style === 'principal') ?? actions[actions.length - 1];
      if (principale) conclure(saisie ? entree.value : principale.cle);
    };
    boite.addEventListener('click', surClic);
    boite.addEventListener('cancel', surEchap);
    boite.addEventListener('submit', surEnvoi);
    boite.showModal();
    if (saisie) {
      entree.focus();
      entree.select();
    }
  });
}

/**
 * Confirmation a deux issues. `danger` colore l'action de rouge : elle detruit.
 * @returns {Promise<boolean>}
 */
async function confirmerBoite(titre, texte, libelle = 'Confirmer', danger = true) {
  const r = await ouvrirBoite({
    titre,
    texte,
    actions: [
      { cle: 'annuler', libelle: 'Annuler', style: 'discret' },
      { cle: 'ok', libelle, style: danger ? 'danger' : 'principal' },
    ],
  });
  return r === 'ok';
}

/**
 * Saisie d'une valeur. Rend `null` si l'utilisateur renonce - et non une
 * chaine vide, qu'on ne saurait pas distinguer d'un champ volontairement vide.
 * @returns {Promise<string|null>}
 */
function saisirBoite(titre, { texte = '', libelle = '', valeur = '', liste, action = 'Valider' } = {}) {
  return ouvrirBoite({
    titre,
    texte,
    saisie: { libelle, valeur, liste },
    actions: [
      { cle: 'annuler', libelle: 'Annuler', style: 'discret' },
      { cle: 'ok', libelle: action, style: 'principal' },
    ],
  });
}

/** Message sans alternative : on a compris, on ferme. */
function informerBoite(titre, texte) {
  return ouvrirBoite({ titre, texte, actions: [{ cle: 'ok', libelle: 'Fermer', style: 'principal' }] });
}

// ---------------------------------------------------------------- evenements

document.addEventListener('input', (ev) => {
  const el = /** @type {HTMLInputElement} */ (ev.target);

  // La recherche de parametre ne touche pas a l'etat : elle ne fait que filtrer
  // l'affichage. Elle passe donc AVANT la garde sur `data-champ`, qu'elle n'a
  // pas - c'est un filtre, pas une saisie.
  if (el.id === 'recherche-simulation') {
    rechercheSimulation = el.value;
    // Toute reduction de l'ensemble ramene en premiere page : rester page 7
    // d'une liste qui n'en compte plus que deux afficherait un vide.
    pageBiblio = 0;
    rendreBibliotheque();
    return;
  }

  // Reglages de lecture du diagnostic : chacun invalide l analyse en cache
  // (la cle de validite porte objectif, cible et annee) et relance le pipeline.
  if (el.id === 'lect-objectif') {
    objectifSensibilite = el.value;
    // La cible saisie valait pour l objectif quitte : on rend la main a la
    // cible par defaut du nouveau plutot que de viser 0 EUR de fonds propres
    // parce qu on visait 0 EUR de cumul.
    cibleBascule = null;
    rendreSensibilite();
    return;
  }

  if (el.id === 'scen-tri') {
    triScenarios = el.value;
    rendreScenarios();
    return;
  }

  if (el.id === 'lect-annee') {
    const n = lireMontant(el.value);
    anneeCumul = nul(n) ? null : Math.round(n);
    rendreSensibilite();
    return;
  }

  if (el.id === 'lect-cible') {
    const n = lireMontant(el.value);
    cibleBascule = nul(n) ? null : n;
    rendreSensibilite();
    return;
  }

  if (el.id === 'eq-objectif' || el.id === 'eq-levier' || el.id === 'eq-cible') {
    if (el.id === 'eq-objectif') equilibreObjectif = el.value;
    if (el.id === 'eq-levier') equilibreLevier = el.value;
    // La reponse affichee ne vaut plus pour la nouvelle question : elle
    // s efface plutot que de rester la, juste et hors sujet.
    const zone = document.getElementById('eq-reponse');
    if (zone) {
      zone.className = 'equilibre__reponse equilibre__reponse--vide';
      zone.textContent = 'Cliquez sur « Chercher ».';
    }
    return;
  }

  if (el.id === 'recherche-parametre') {
    const etaitEnRecherche = rechercheParametre.trim().length > 0;
    rechercheParametre = el.value;
    rendreParametres();
    // Sortie de recherche : les champs d'hypotheses ont pu etre modifies via
    // leurs CLONES de la visu temporaire, leurs originaux sont en retard.
    // L'etat fait foi, on les y realigne avant de les remontrer.
    if (etaitEnRecherche && rechercheParametre.trim().length === 0) {
      rendreChampsStatiques(document.getElementById('para-hypotheses') ?? document);
    }
    return;
  }

  // Tranches d'un modele de pret : cocher ou decocher reecrit la LISTE entiere.
  // Elle est ordonnee comme l'ordre canonique des produits, pour que deux
  // modeles visant les memes tranches se lisent pareil quel que soit l'ordre
  // dans lequel on a coche.
  const caseProduit = /** @type {HTMLInputElement} */ (el).dataset?.produitPreset;
  if (caseProduit !== undefined) {
    const i = Number(caseProduit);
    const liste = listePresets();
    const courants = new Set(liste[i]?.produits ?? []);
    const p = /** @type {HTMLElement} */ (el).dataset.produit;
    if (/** @type {HTMLInputElement} */ (el).checked) courants.add(p);
    else courants.delete(p);
    ecrireSaisie(
      'baremes.presets_prets.presets',
      liste.map((x, k) =>
        k === i ? { ...x, produits: ORDRE_PRODUITS.filter((c) => courants.has(c)) } : x,
      ),
    );
    rafraichirTout();
    return;
  }

  const chemin = el.dataset?.champ;
  if (!chemin) return;

  let valeur;
  if (el.dataset.type === 'montant') {
    // Une frappe intermediaire (« 12- », « , ») n'est pas encore un nombre : on
    // la laisse a l'ecran sans rien ecrire, plutot que d'effacer la saisie.
    const m = lireMontant(el.value);
    if (m === undefined) return;
    valeur = m;
  } else if (el.dataset.type === 'nombre' || el.dataset.type === 'pourcentage') {
    // Un champ `number` en cours de frappe (« 40. » avant la decimale) expose une
    // valeur VIDE et signale `badInput`. Sans cette distinction, la frappe serait
    // interpretee comme un effacement et le chiffre deja saisi serait perdu.
    if (el.validity?.badInput) return;
    // Un champ reellement vide reste vide : il ne devient jamais zero silencieusement.
    // La lecture est celle des montants : virgule decimale et espaces de
    // groupement acceptes, ce qu'un collage depuis un tableur francais produit.
    const n = lireMontant(el.value);
    if (n === undefined) return;
    valeur = n === null ? null : el.dataset.type === 'pourcentage' ? n / 100 : n;
  } else if (el.dataset.type === 'mode-redevance') {
    valeur = el.checked ? 'redevance' : 'loyers';
  } else if (el.dataset.type === 'booleen') {
    valeur = el.checked;
  } else {
    valeur = el.value === '' ? null : el.value;
  }

  // Passer de loyers a redevance, ou l'inverse, peut changer la part d'apport
  // en fonds propres au meme titre que le regime de redevance. Meme traitement :
  // on releve le taux avant, on propose apres.
  if (el.dataset.type === 'mode-redevance') {
    const avant = tauxApportFP();
    ecrireSaisie(chemin, valeur);
    proposerReajustementApports(avant);
    rafraichirTout();
    return;
  }

  // Selection multiple : la valeur frappee sur une ligne selectionnee se pose
  // sur toutes les autres. On reconstruit alors la table, pour que les lignes
  // touchees affichent leur nouvelle valeur - et on rend le focus au champ en
  // cours de frappe, qui vient de disparaitre avec l'ancienne table.
  if (propagerSurLotsSelectionnes(chemin, valeur)) {
    ecrireSaisie(chemin, valeur);
    const debut = el.selectionStart;
    rafraichirTout();
    const repris = /** @type {HTMLInputElement|null} */ (
      document.querySelector(`[data-champ="${chemin}"]`)
    );
    if (repris) {
      repris.focus();
      if (debut !== null && repris.setSelectionRange) repris.setSelectionRange(debut, debut);
    }
    return;
  }

  if (ecrireSaisie(chemin, valeur)) {
    // La derivation d'un profil change la barre de profils et les marques de
    // cellule modifiee : il faut reconstruire, une fois.
    rafraichirTout();
    return;
  }
  if (chemin.startsWith('baremes.') || chemin.startsWith('trajectoires.')) {
    recalculer();
    // La barre de profil compte les modifications et porte le bouton de
    // sauvegarde : sans ce rafraichissement, elle affichait encore « aucune
    // modification » alors que le moteur avait deja pris la nouvelle valeur.
    // Elle seule est redessinee - reconstruire l'ecran couterait le focus.
    rendreBarreProfil();
    return;
  }

  // Saisir un montant de pret le FIGE : il sort du calcul d'equilibre. La ligne
  // perd sa classe et le bouton de retour au calcul apparait, sans reconstruire
  // la structure - sinon le premier caractere frappe couterait le focus.
  const iPret = el.dataset.montantPret;
  if (iPret !== undefined && etat.prets[Number(iPret)]?.montant_auto !== false) {
    etat.prets[Number(iPret)].montant_auto = false;
    el.closest('.ligne--pret')?.classList.remove('pret--auto');
  }

  // Un changement de produit ou de chapitre reordonne la restitution : on
  // reconstruit. Sinon on ne met a jour que les valeurs, ce qui preserve le focus.
  if (el.dataset.structure) rafraichirTout();
  else recalculer();
});

// Regroupement des milliers a la SORTIE du champ, jamais pendant la frappe :
// reformater a chaque caractere deplacerait le curseur d'un cran a chaque
// millier franchi. En capture, `blur` ne remontant pas.
document.addEventListener(
  'blur',
  (ev) => {
    const el = /** @type {HTMLInputElement} */ (ev.target);
    if (el?.dataset?.type !== 'montant') return;
    const m = lireMontant(el.value);
    el.value = nul(m) || m === undefined ? '' : fMontantSaisie.format(m);
  },
  true,
);

// ---------------------------------------------------------------- grilles de saisie

/**
 * Range une valeur saisie a sa place. R-PARAM : une surcharge de bareme ou de
 * trajectoire ne va pas dans l'etat de l'operation mais dans le PROFIL actif,
 * et si c'est le referentiel qui est actif, elle en derive d'abord une copie -
 * la reference ne se perd pas par une frappe.
 * @returns {boolean} vrai si un profil vient d'etre derive, l'ecran est alors
 *   a reconstruire.
 */
function ecrireSaisie(chemin, valeur) {
  if (!chemin.startsWith('baremes.') && !chemin.startsWith('trajectoires.')) {
    ecrireChemin(etat, chemin, valeur);
    return false;
  }
  const avant = profilActif().id;
  const profil = profilModifiable();
  ecrireChemin(profil.parametrage, chemin, valeur);
  return avant !== profil.id;
}

/** Champ d'une grille a des coordonnees donnees, ou null s'il n'existe pas. */
function celluleDeGrille(grille, l, c) {
  return /** @type {HTMLInputElement|HTMLSelectElement|null} */ (
    grille.querySelector(`[data-l="${l}"][data-c="${c}"]`)
  );
}

/**
 * Deplace le curseur d'une cellule a l'autre, en SAUTANT les trous.
 *
 * Une grille de saisie n'est pas toujours pleine : dans le prix de revient, une
 * ligne ventilee n'a pas de cellule de total, et une ligne qui ne l'est pas n'a
 * pas de cellules par tranche. S'arreter net sur un trou rendrait la moitie du
 * tableau inatteignable au clavier.
 *
 * @param {Element} grille
 * @param {number} l départ
 * @param {number} c départ
 * @param {number} dl pas vertical
 * @param {number} dc pas horizontal
 * @returns {boolean} vrai si une cellule a ete atteinte
 */
function allerEnGrille(grille, l, c, dl = 0, dc = 0) {
  // Le pas nul (positionnement direct) ne cherche pas plus loin que la case visee.
  const limite = dl === 0 && dc === 0 ? 1 : 200;
  for (let n = 0; n < limite; n++) {
    const cible = celluleDeGrille(grille, l + dl * n, c + dc * n);
    if (cible) {
      cible.focus();
      if (typeof (/** @type {HTMLInputElement} */ (cible).select) === 'function') {
        /** @type {HTMLInputElement} */ (cible).select();
      }
      return true;
    }
    // Hors du tableau : inutile de continuer a chercher.
    if (l + dl * n < -1 || c + dc * n < -1) return false;
  }
  return false;
}

/**
 * Deplacement au clavier dans une grille, aux usages du tableur.
 *
 * Les fleches HORIZONTALES ne changent de cellule que si le curseur est deja au
 * bord du texte : au milieu d'un nombre, elles doivent continuer a deplacer le
 * curseur, sinon on ne peut plus corriger un chiffre.
 * Les fleches VERTICALES, elles, sont interceptees dans tous les cas - sur un
 * champ numerique elles incrementeraient la valeur, ce que personne n'attend
 * d'une fleche dans un tableau.
 */
document.addEventListener('keydown', (ev) => {
  const el = /** @type {HTMLInputElement} */ (ev.target);
  const grille = el?.closest?.('[data-grille]');
  if (!grille || el.dataset.l === undefined) return;

  const l = Number(el.dataset.l);
  const c = Number(el.dataset.c);
  // Une liste deroulante n'a pas de curseur de texte : les fleches VERTICALES y
  // gardent leur role natif, qui est de changer la valeur. Y substituer un
  // deplacement rendrait la liste inutilisable au clavier.
  const liste = el.tagName === 'SELECT';
  const auDebut = liste || (el.selectionStart === 0 && el.selectionEnd === 0);
  const aLaFin = liste || (el.selectionStart === el.value.length && el.selectionEnd === el.value.length);

  let pas = null;
  if ((ev.key === 'ArrowDown' && !liste) || (ev.key === 'Enter' && !ev.shiftKey)) pas = [1, 0];
  else if ((ev.key === 'ArrowUp' && !liste) || (ev.key === 'Enter' && ev.shiftKey)) pas = [-1, 0];
  else if (ev.key === 'ArrowLeft' && auDebut) pas = [0, -1];
  else if (ev.key === 'ArrowRight' && aLaFin) pas = [0, 1];
  else if (ev.key === 'Tab') pas = [0, ev.shiftKey ? -1 : 1];
  if (!pas) return;

  const atteint = allerEnGrille(grille, l + pas[0], c + pas[1], pas[0], pas[1]);
  // Tab en bout de grille rend la main au navigateur : en sortir par la
  // tabulation reste possible.
  if (atteint || ev.key !== 'Tab') ev.preventDefault();
});

/**
 * Interprete une valeur collee SELON LA CELLULE qui la recoit. Une grille de
 * programme melange du texte, des nombres et des listes deroulantes : coller un
 * bloc de tableur n'a de sens que si chaque colonne lit ce qui la concerne.
 *
 * @param {HTMLInputElement|HTMLSelectElement} cible
 * @param {string} texte
 * @returns {any} la valeur a ecrire, ou `undefined` si elle n'est pas exploitable
 */
function valeurCollee(cible, texte) {
  if (cible.tagName === 'SELECT') {
    // On accepte le code (« PLS ») comme le libelle affiche (« LLI ») :
    // un tableur exporte l'un ou l'autre selon qui l'a rempli.
    const norme = sansAccent(texte);
    const opt = [.../** @type {HTMLSelectElement} */ (cible).options].find(
      (o) => sansAccent(o.value) === norme || sansAccent(o.textContent ?? '') === norme,
    );
    return opt ? opt.value : undefined;
  }
  const type = cible.dataset.type;
  if (type === 'nombre' || type === 'pourcentage' || type === 'montant') {
    const v = lireMontant(texte.replace('%', ''));
    if (v === undefined) return undefined;
    return v === null ? null : type === 'pourcentage' ? v / 100 : v;
  }
  return texte === '' ? null : texte;
}

/**
 * Collage d'un bloc venu d'un tableur. Un bareme se recopie depuis Excel : le
 * bloc arrive en colonnes separees par des tabulations et lignes separees par
 * des retours, et se pose a partir de la cellule selectionnee.
 *
 * Les valeurs sont relues a la francaise (virgule decimale, espaces de
 * groupement) : un copier-coller depuis un tableur francais ne doit pas obliger
 * a reformater quoi que ce soit.
 */
document.addEventListener('paste', (ev) => {
  const el = /** @type {HTMLInputElement} */ (ev.target);
  const grille = el?.closest?.('[data-grille]');
  if (!grille || el.dataset.l === undefined) return;

  const texte = ev.clipboardData?.getData('text/plain') ?? '';
  if (!/[\t\n\r]/.test(texte.trim())) return; // une seule valeur : collage normal

  ev.preventDefault();
  const l0 = Number(el.dataset.l);
  const c0 = Number(el.dataset.c);
  const bloc = texte.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').map((r) => r.split('\t'));

  // On ecrit DIRECTEMENT, sans simuler d'evenements de saisie : la premiere
  // cellule ecrite peut deriver un profil ou reordonner une table, ce qui
  // reconstruit l'ecran - les cellules suivantes recevraient alors leurs
  // evenements sur des noeuds detaches, et sept valeurs sur huit se perdraient
  // en silence.
  const idGrille = grille.id;
  let posees = 0;
  let hors = 0;
  for (let i = 0; i < bloc.length; i++) {
    for (let j = 0; j < bloc[i].length; j++) {
      const cible = celluleDeGrille(grille, l0 + i, c0 + j);
      if (!cible) { hors++; continue; }
      const v = valeurCollee(cible, bloc[i][j].trim());
      if (v === undefined) continue;
      ecrireSaisie(cible.dataset.champ, v);
      posees++;
    }
  }

  // Une seule reconstruction en fin de collage, et COMPLETE : un champ affiche
  // l etat, pas ce qu on vient d y taper. Sans elle les valeurs etaient bien
  // enregistrees mais les cases montraient encore les anciennes - le collage
  // avait l air de n avoir rien fait.
  // Le curseur revient ou il etait, sinon coller ferait perdre sa place.
  rafraichirTout();
  const reconstruite = idGrille
    ? document.getElementById(idGrille)
    : document.querySelector('[data-grille]');
  if (reconstruite) allerEnGrille(reconstruite, l0, c0);

  if (hors) {
    informerBoite(
      'Collage partiel',
      `${posees} valeur${posees > 1 ? 's' : ''} collée${posees > 1 ? 's' : ''}. ` +
        `${hors} valeur${hors > 1 ? 's' : ''} débordai${hors > 1 ? 'ent' : 't'} de la grille, ` +
        `${hors > 1 ? 'elles ont' : 'elle a'} été ignorée${hors > 1 ? 's' : ''}.`,
    );
  }
});

document.addEventListener('change', async (ev) => {
  // L'interrupteur de masquage change la STRUCTURE de la table, pas l'etat.
  const id = /** @type {HTMLElement} */ (ev.target).id;
  // Les deux selecteurs de profil - barre admin et ecran Operation - font le
  // meme geste : le profil actif est un reglage d'operation, pas d'ecran.
  // Filtres de la bibliotheque, et taille de page.
  if (Object.prototype.hasOwnProperty.call(filtresBiblio, id)) {
    filtresBiblio[id] = /** @type {HTMLSelectElement} */ (ev.target).value;
    pageBiblio = 0;
    rendreBibliotheque();
    return;
  }
  if (id === 'taille-page') {
    taillePageBiblio = Number(/** @type {HTMLSelectElement} */ (ev.target).value) || 100;
    pageBiblio = 0;
    rendreBibliotheque();
    return;
  }

  // Import d'un fichier de simulation. Le fichier est la monnaie d'echange
  // entre postes tant que le serveur d'entreprise n'existe pas, et il restera
  // le format de sauvegarde de secours ensuite.
  if (id === 'fichier-import') {
    const fichier = /** @type {HTMLInputElement} */ (ev.target).files?.[0];
    if (!fichier) return;
    const lecteur = new FileReader();
    lecteur.onload = () => {
      let sim;
      try {
        sim = JSON.parse(String(lecteur.result));
      } catch {
        informerBoite('Fichier illisible', 'Ce fichier n’est pas un JSON valide.');
        return;
      }
      if (!sim || typeof sim !== 'object' || !sim.identite) {
        informerBoite('Ce n’est pas une simulation', 'La section « identite » est absente du fichier.');
        return;
      }
      viderFileDeSauvegarde();
      const nouvel = ajouterSimulation(sim);
      if (!nouvel) {
        informerBoite('Import impossible', 'Le stockage du navigateur est plein ou indisponible.');
        return;
      }
      rendreBibliotheque();
      ouvrirSimulationDansEcran(nouvel);
    };
    lecteur.readAsText(fichier);
    // Le champ est vide apres coup, sinon reimporter le MEME fichier ne
    // declencherait aucun evenement.
    /** @type {HTMLInputElement} */ (ev.target).value = '';
    return;
  }

  if (id === 'select-profil' || /** @type {HTMLElement} */ (ev.target).matches?.('[data-selecteur-profil]')) {
    etat.profil_actif = /** @type {HTMLSelectElement} */ (ev.target).value;
    rafraichirTout();
    return;
  }
  if (id === 'afficher-tva') tvaVisible = /** @type {HTMLInputElement} */ (ev.target).checked;
  if (id === 'masquer-vides' || id === 'afficher-tva') rafraichirTout();
});

document.addEventListener('click', async (ev) => {
  // Un menu deroulant reste ouvert tant qu on ne le referme pas : `details` ne
  // se ferme QUE sur son propre resume. Un clic ailleurs doit suffire, sinon il
  // flotte au-dessus de l ecran sur lequel on vient de repartir.
  const menuDossier = document.getElementById('menu-dossier');
  if (menuDossier?.open && !(/** @type {HTMLElement} */ (ev.target)).closest?.('#menu-dossier')) {
    menuDossier.open = false;
  }
  const el = /** @type {HTMLElement} */ (ev.target);

  // Un menu de tranches ouvert se ferme des qu'on clique AILLEURS. `details`
  // ne le fait pas de lui-meme : il reste ouvert jusqu'a ce qu'on reclique son
  // resume, si bien qu'on se retrouve avec deux ou trois panneaux flottants
  // au-dessus du tableau. On ferme donc tous ceux qui ne contiennent pas le
  // clic - celui qu'on vient d'ouvrir se contient lui-meme, il survit.
  for (const d of document.querySelectorAll('details.tranches-choix[open]')) {
    if (!d.contains(el)) /** @type {HTMLDetailsElement} */ (d).open = false;
  }

  // --- Bibliotheque de simulations ---
  // La marque ramene a la liste, depuis n'importe quel ecran. Le dossier
  // ouvert le RESTE : on revient consulter la bibliotheque, on ne referme
  // rien. La saisie en attente est ecrite avant, pour que les fiches
  // affichees soient a jour.
  if (el.closest('#btn-marque')) {
    viderFileDeSauvegarde();
    rendreBibliotheque();
    afficherEcran('simulations');
    return;
  }

  // Menu du dossier ouvert : les deux facons de le refermer.
  const actionDossier = el.closest('[data-dossier]');
  if (actionDossier) {
    const quoi = /** @type {HTMLElement} */ (actionDossier).dataset.dossier;
    const menu = /** @type {HTMLDetailsElement} */ (document.getElementById('menu-dossier'));
    if (menu) menu.open = false;
    fermerSimulation(quoi === 'abandonner' ? 'abandonner' : 'enregistrer');
    rendreBibliotheque();
    afficherEcran('simulations');
    return;
  }
  // Le champ de fichier est masque - un `input type=file` brut ne se met pas a
  // la charte - donc rien ne l'ouvrait : le code d'import existait sans qu'on
  // puisse l'atteindre. Ce bouton est sa poignee.
  if (el.closest('#btn-importer')) {
    /** @type {HTMLInputElement} */ ($('#fichier-import')).click();
    return;
  }

  if (el.closest('#btn-nouvelle-sim')) {
    const nom = await saisirBoite('Nouvelle simulation', {
      libelle: 'Nom', valeur: 'Nouvelle opération', action: 'Créer',
    });
    if (nom === null) return;
    viderFileDeSauvegarde();
    // Une simulation neuve est VIERGE : voir ETAT_INITIAL pour ce qu'elle
    // garde et ce qu'elle laisse vide.
    const neuve = structuredClone(ETAT_INITIAL);
    neuve.identite = { ...(neuve.identite ?? {}), nom: nom.trim() || 'Nouvelle opération' };
    const id = ajouterSimulation(neuve);
    if (!id) {
      await informerBoite('Création impossible', 'Le stockage du navigateur est plein ou indisponible.');
      return;
    }
    ouvrirSimulationDansEcran(id);
    return;
  }
  if (el.closest('#btn-vider-filtres')) {
    rechercheSimulation = '';
    for (const c of Object.keys(filtresBiblio)) filtresBiblio[c] = '';
    const r = /** @type {HTMLInputElement} */ (document.getElementById('recherche-simulation'));
    if (r) r.value = '';
    for (const c of Object.keys(filtresBiblio)) {
      const s = /** @type {HTMLSelectElement} */ (document.getElementById(c));
      if (s) s.value = '';
    }
    pageBiblio = 0;
    rendreBibliotheque();
    return;
  }
  if (el.closest('#btn-page-prec')) {
    pageBiblio = Math.max(0, pageBiblio - 1);
    rendreBibliotheque();
    return;
  }
  if (el.closest('#btn-page-suiv')) {
    pageBiblio += 1;
    rendreBibliotheque();
    return;
  }
  // Tri : un clic sur la colonne deja triee inverse le sens.
  const enTeteTri = el.closest('[data-tri-biblio]');
  if (enTeteTri) {
    const col = /** @type {HTMLElement} */ (enTeteTri).dataset.triBiblio;
    if (triBiblio.colonne === col) triBiblio.ascendant = !triBiblio.ascendant;
    else {
      triBiblio.colonne = col;
      // Un tri neuf part dans le sens le plus utile : croissant sur du texte,
      // decroissant sur un nombre ou une date - on cherche le plus gros, le
      // plus recent, le dernier numero.
      triBiblio.ascendant = ['nom', 'groupe', 'commune', 'type', 'zone'].includes(col);
    }
    rendreBibliotheque();
    return;
  }

  const aOuvrir = el.closest('[data-sim-ouvrir]');
  if (aOuvrir) {
    viderFileDeSauvegarde();
    ouvrirSimulationDansEcran(/** @type {HTMLElement} */ (aOuvrir).dataset.simOuvrir);
    return;
  }
  const aRenommer = el.closest('[data-sim-renommer]');
  if (aRenommer) {
    const id = /** @type {HTMLElement} */ (aRenommer).dataset.simRenommer;
    const fiche = listerSimulations().find((f) => f.id === id);
    const nom = await saisirBoite('Renommer la simulation', {
      libelle: 'Nom', valeur: fiche?.nom ?? '', action: 'Renommer',
    });
    if (nom === null || !nom.trim()) return;
    // Si c'est la simulation OUVERTE, l'etat en memoire porte le nom actuel :
    // le renommer au depot seul serait ecrase a la premiere frappe.
    if (id === idSimulationOuverte) {
      etat.identite.nom = nom.trim();
      rendreChampsStatiques();
      majNomSimulationOuverte(nom.trim());
      viderFileDeSauvegarde();
    } else {
      renommerSimulation(id, nom.trim());
    }
    rendreBibliotheque();
    return;
  }
  const aDupliquer = el.closest('[data-sim-dupliquer]');
  if (aDupliquer) {
    const id = /** @type {HTMLElement} */ (aDupliquer).dataset.simDupliquer;
    // La simulation ouverte peut porter des frappes non encore ecrites : on
    // vide la file avant de la relire, sinon la copie serait en retard.
    if (id === idSimulationOuverte) viderFileDeSauvegarde();
    const sim = lireSimulation(id);
    if (!sim) return;
    const copie = ajouterSimulation(sim, `${sim.identite?.nom ?? 'Simulation'} (copie)`);
    if (!copie) {
      await informerBoite('Duplication impossible', 'Le stockage du navigateur est plein ou indisponible.');
      return;
    }
    rendreBibliotheque();
    return;
  }
  const aExporter = el.closest('[data-sim-exporter]');
  if (aExporter) {
    const id = /** @type {HTMLElement} */ (aExporter).dataset.simExporter;
    if (id === idSimulationOuverte) viderFileDeSauvegarde();
    exporterSimulation(id);
    return;
  }
  const aSupprimerSim = el.closest('[data-sim-supprimer]');
  if (aSupprimerSim) {
    const cible = /** @type {HTMLElement} */ (aSupprimerSim);
    const id = cible.dataset.simSupprimer;
    const ok = await confirmerBoite(
      'Supprimer la simulation',
      `« ${cible.dataset.nom} » sera définitivement effacée. Cette action est irréversible.`,
      'Supprimer',
    );
    if (!ok) return;
    const etaitOuverte = id === idSimulationOuverte;
    if (etaitOuverte) clearTimeout(sauvegardeEnAttente);
    supprimerSimulation(id);
    if (etaitOuverte) {
      // On ne reste pas sur une simulation qui n'existe plus. Aucune n'est
      // rouverte a sa place : rien ne dit que la suivante de la liste soit
      // celle qu'on veut, et l'outil sait rester sans dossier ouvert.
      idSimulationOuverte = null;
      ouvrirSimulation(null);
      majNomSimulationOuverte(null);
      majAccesMontage();
      afficherEcran('simulations');
    }
    rendreBibliotheque();
    return;
  }
  // --- Ecran Exports ---
  const pastilleTranche = el.closest('[data-tranche-export]');
  if (pastilleTranche) {
    const c = /** @type {HTMLElement} */ (pastilleTranche).dataset.trancheExport;
    if (tranchesEcartees.has(c)) tranchesEcartees.delete(c);
    else tranchesEcartees.add(c);
    rendreApercuExport();
    return;
  }
  const choixExport = el.closest('#choix-export [data-export]');
  if (choixExport) {
    exportChoisi = /** @type {HTMLElement} */ (choixExport).dataset.export;
    rendreApercuExport();
    return;
  }
  if (el.closest('#btn-telecharger-pdf')) {
    telechargerPDF();
    return;
  }

  // --- Selection de lots ---
  // Le clic majuscule etend la selection depuis la derniere case cochee : c'est
  // le geste attendu sur une liste, et le seul praticable a cinquante lots.
  const caseLot = /** @type {HTMLInputElement|null} */ (el.closest('[data-select-lot]'));
  if (caseLot) {
    const i = Number(caseLot.dataset.selectLot);
    const rangs = ordreAffichageLots().map((x) => x.i);
    const cibles =
      /** @type {MouseEvent} */ (ev).shiftKey && dernierLotCoche !== null
        ? (() => {
            // La plage se lit dans l'ordre AFFICHE : c'est celui que l'on voit,
            // et donc celui que l'on croit selectionner.
            const a = rangs.indexOf(dernierLotCoche);
            const b = rangs.indexOf(i);
            return a < 0 || b < 0 ? [i] : rangs.slice(Math.min(a, b), Math.max(a, b) + 1);
          })()
        : [i];
    for (const c of cibles) {
      if (caseLot.checked) lotsSelectionnes.add(c);
      else lotsSelectionnes.delete(c);
    }
    dernierLotCoche = i;
    for (const tr of document.querySelectorAll('#table-lots tbody tr[data-lot]')) {
      const idx = Number(/** @type {HTMLElement} */ (tr).dataset.lot);
      tr.classList.toggle('lot--selectionne', lotsSelectionnes.has(idx));
      const c = /** @type {HTMLInputElement|null} */ (tr.querySelector('.lot__select'));
      if (c) c.checked = lotsSelectionnes.has(idx);
    }
    rendreSelectionLots();
    return;
  }

  if (el.id === 'select-tous-lots') {
    const tout = /** @type {HTMLInputElement} */ (el).checked;
    lotsSelectionnes.clear();
    if (tout) etat.lots.forEach((_, i) => lotsSelectionnes.add(i));
    dernierLotCoche = null;
    for (const tr of document.querySelectorAll('#table-lots tbody tr[data-lot]')) {
      const idx = Number(/** @type {HTMLElement} */ (tr).dataset.lot);
      tr.classList.toggle('lot--selectionne', tout);
      const c = /** @type {HTMLInputElement|null} */ (tr.querySelector('.lot__select'));
      if (c) c.checked = tout;
    }
    rendreSelectionLots();
    return;
  }

  if (el.closest('#btn-theme')) {
    appliquerTheme(document.documentElement.dataset.theme === 'clair' ? 'sombre' : 'clair');
    // Les barres emplois/ressources portent leurs couleurs en attribut `style`,
    // resolues au moment du rendu : sans recalcul elles garderaient la palette
    // du theme precedent.
    if (dernierResultat) recalculer();
    return;
  }

  const onglet = el.closest('[data-ecran]');
  if (onglet) {
    afficherEcran(/** @type {HTMLElement} */ (onglet).dataset.ecran);
    return;
  }

  // Tri de la table des lots : ascendant, descendant, puis retour a l'ordre de
  // saisie. Trois etats et non deux : sans le troisieme, on ne peut plus revenir
  // a l'ordre dans lequel on a saisi, qui porte lui aussi du sens.
  const enteteTri = el.closest('#table-lots thead th[data-tri]');
  if (enteteTri) {
    const cle = /** @type {HTMLElement} */ (enteteTri).dataset.tri;
    triLots =
      triLots?.cle !== cle
        ? { cle, sens: 'asc' }
        : triLots.sens === 'asc'
          ? { cle, sens: 'desc' }
          : null;
    rafraichirTout();
    return;
  }

  if (el.closest('#deplier-trajectoire')) {
    trajectoireDepliee = !trajectoireDepliee;
    rendreParametres();
    return;
  }

  // Interrupteur de lecture de la page des calculs.
  const lecture = /** @type {HTMLElement|null} */ (el.closest('[data-lecture]'))?.dataset.lecture;
  if (lecture) {
    lectureCalculs = lecture === 'support' ? 'support' : 'simple';
    try {
      localStorage.setItem(CLE_LECTURE_CALCULS, lectureCalculs);
    } catch {
      /* voir memoriserSaisie */
    }
    // La vue support est bien plus longue que la vue claire : re-rendre sans
    // precaution fait glisser la page sous les yeux et l'on perd l'etape qu'on
    // etait en train de lire. On repere donc l'etape en tete de fenetre, on
    // note sa distance au haut de l'ecran, et on la remet exactement la apres
    // le rendu. C'est le contenu qui reste immobile, pas la position de la
    // barre de defilement.
    const repere = etapeEnTete();
    rendreCalculs();
    if (repere) {
      const cible = document.querySelector(`[data-calc-etape="${repere.cle}"]`);
      if (cible) {
        window.scrollTo({ top: window.scrollY + cible.getBoundingClientRect().top - repere.decalage });
      }
    }
    return;
  }

  if (el.closest('#btn-scenarios')) {
    rendreScenarios();
    return;
  }
  const caseScenario = /** @type {HTMLInputElement|null} */ (el.closest('[data-levier-scenario]'));
  if (caseScenario) {
    const code = caseScenario.dataset.levierScenario;
    if (caseScenario.checked) leviersScenarios.add(code);
    else leviersScenarios.delete(code);
    return;
  }
  if (el.closest('#btn-equilibre')) {
    resoudreEquilibre();
    return;
  }
  // Les reglages de lecture se devoilent sur demande : la lecture par defaut
  // est la bonne dans presque tous les cas.
  if (el.closest('#btn-lecture')) {
    const reglages = document.getElementById('reglages-lecture');
    if (reglages) reglages.hidden = !reglages.hidden;
    return;
  }
  const ligneBascule = el.closest('[data-bascule]');
  if (ligneBascule) {
    const code = /** @type {HTMLElement} */ (ligneBascule).dataset.bascule;
    levierDeplie = levierDeplie === code ? null : code;
    // Repeindre les jauges suffit : l analyse est en cache, aucun passage
    // moteur, et le depli se remplit depuis ce cache.
    if (analyseValide()) peindreJauges(analyseSensibilite.seuils, !analyseSensibilite.finie);
    else rendreSensibilite();
    return;
  }
  const perimExp = el.closest('[data-perimetre-compte]');
  if (perimExp) {
    const c = /** @type {HTMLElement} */ (perimExp).dataset.perimetreCompte;
    if (c === 'tout') tranchesHorsCompte.clear();
    else if (tranchesHorsCompte.has(c)) tranchesHorsCompte.delete(c);
    else tranchesHorsCompte.add(c);
    if (dernierResultat) rendreExploitation(dernierResultat);
    return;
  }
  const perim = el.closest('[data-vue-financement]');
  if (perim) {
    vueFinancement = /** @type {HTMLElement} */ (perim).dataset.vueFinancement;
    if (dernierResultat) rendreFinancement(dernierResultat);
    return;
  }

  const rail = el.closest('[data-section]');
  if (rail) {
    sectionParametres = /** @type {HTMLElement} */ (rail).dataset.section;
    rendreParametres();
    // Changer de rubrique, c'est changer de page : on la prend par le haut.
    // `scrollIntoView` ne suffisait pas - en `nearest` il ne bouge pas quand la
    // cible est deja a l'ecran, si bien qu'en arrivant du bas d'une longue
    // section on tombait au milieu de la suivante. Et le panneau vise n'est
    // plus toujours `#contenu-parametres` depuis que les calculs et les
    // hypotheses ont le leur.
    window.scrollTo({ top: 0 });
    return;
  }

  // Retour d'un champ au referentiel : on EFFACE la surcharge au lieu d'y
  // recopier la valeur du depot. Recopier figerait le chiffre du jour, et une
  // mise a jour du referentiel ne s'y propagerait plus.
  const annuler = el.closest('[data-annuler]');
  if (annuler) {
    ecrireChemin(profilActif().parametrage, /** @type {HTMLElement} */ (annuler).dataset.annuler, null);
    rafraichirTout();
    return;
  }

  // Un taux de trajectoire s'applique a TOUTES les annees d'un coup : les poser
  // une a une sur cinquante et une lignes n'est pas une saisie, c'est une corvee.
  const poste = el.closest('[data-appliquer-poste]');
  if (poste) {
    const cle = /** @type {HTMLElement} */ (poste).dataset.appliquerPoste;
    const libelle = POSTES_TRAJECTOIRE.find((p) => p.cle === cle)?.libelle ?? cle;
    const saisi = await saisirBoite(`Appliquer un taux : ${libelle}`, {
      texte: 'Ce taux remplacera la valeur de toutes les années. Laissez vide pour revenir au référentiel.',
      libelle: 'Taux (%)', action: 'Appliquer',
    });
    if (saisi === null) return;
    const v = saisi.trim() === '' ? null : Number(saisi.replace(',', '.')) / 100;
    if (v !== null && !Number.isFinite(v)) return;
    const profil = profilModifiable();
    for (const l of referentiels.trajectoires.trajectoires) {
      ecrireChemin(profil.parametrage, `trajectoires.par_annee.${l.annee}.${cle}`, v);
    }
    rafraichirTout();
    return;
  }

  // --- Profils de parametres ---
  const actionProfil = el.closest('[data-profil]');
  if (actionProfil) {
    const action = /** @type {HTMLElement} */ (actionProfil).dataset.profil;
    const p = profilActif();
    if (action === 'sauvegarder') {
      // Sauver, c'est figer l'etat courant comme nouvelle reference du profil.
      // Le point de comparaison n'est pas perdu pour autant : le FICHIER de
      // referentiel reste la valeur d'origine, et « ↺ tout » y ramene.
      p.parametrage_sauve = structuredClone(p.parametrage ?? {});
    } else if (action === 'dupliquer') {
      const copie = {
        id: idProfil(),
        nom: `${p.nom} (copie)`,
        parametrage: structuredClone(p.parametrage ?? {}),
        parametrage_sauve: structuredClone(p.parametrage ?? {}),
      };
      etat.profils.push(copie);
      etat.profil_actif = copie.id;
    } else if (action === 'renommer') {
      const nom = await saisirBoite('Renommer le profil', {
        libelle: 'Nom', valeur: p.nom, action: 'Renommer',
      });
      if (!nom) return;
      p.nom = nom;
    } else if (action === 'reinitialiser') {
      const ok = await confirmerBoite(
        'Réinitialiser le profil',
        `Toutes les valeurs de « ${p.nom} » reviendront à celles du référentiel.`,
        'Réinitialiser',
      );
      if (!ok) return;
      p.parametrage = { baremes: {}, trajectoires: { par_annee: {} } };
      p.parametrage_sauve = structuredClone(p.parametrage);
    } else if (action === 'supprimer') {
      const ok = await confirmerBoite('Supprimer le profil', `« ${p.nom} » sera effacé.`, 'Supprimer');
      if (!ok) return;
      etat.profils = etat.profils.filter((x) => x.id !== p.id);
      etat.profil_actif = PROFIL_REFERENTIEL;
    }
    rafraichirTout();
    return;
  }

  const remettreAuto = el.closest('[data-remettre-auto]');
  if (remettreAuto) {
    const i = Number(/** @type {HTMLElement} */ (remettreAuto).dataset.remettreAuto);
    etat.prets[i].montant_auto = true;
    etat.prets[i].montant_eur = null;
    rafraichirTout();
    return;
  }

  // Rendre la main au calcul : on EFFACE la saisie plutot que d'y ecrire le
  // montant automatique. Y ecrire le nombre le figerait a nouveau, et il ne
  // suivrait plus ni le prix de revient ni le regime de redevance.
  const rendreAuto = el.closest('[data-apport-rendre-auto]');
  if (rendreAuto) {
    delete etat.fonds_propres_par_produit[
      /** @type {HTMLElement} */ (rendreAuto).dataset.apportRendreAuto
    ];
    rafraichirTout();
    return;
  }

  // Retour d'un pret structurant a ses defauts : on EFFACE les caracteristiques
  // saisies, on ne les remplace pas par leurs valeurs courantes. Effacees,
  // elles suivent a nouveau le produit et le profil de parametres ; recopiees,
  // elles resteraient figees sur les valeurs d'aujourd'hui.
  const resetPret = el.closest('[data-reset-pret]');
  if (resetPret) {
    const i = Number(/** @type {HTMLElement} */ (resetPret).dataset.resetPret);
    const pret = etat.prets[i];
    if (pret) {
      for (const k of CHAMPS_CARACTERISTIQUES_PRET) delete pret[k];
      cacheModeTaux.delete(i);
      rafraichirTout();
    }
    return;
  }

  // Choix en segments : un bouton pose une valeur. Le chemin et le type sont
  // portes par le bouton, si bien qu'un nouveau choix ne demande aucun code -
  // c'est ce qui permet d'en poser cinq dans le detail d'un pret sans cinq
  // gestionnaires.
  const poser = el.closest('[data-poser-champ]');
  if (poser) {
    const d = /** @type {HTMLElement} */ (poser).dataset;
    const brut = d.valeur;
    const valeur =
      d.typeValeur === 'nombre' ? Number(brut) : brut === '' ? null : brut;

    if (d.typeValeur === 'mode-taux') {
      // L'indexation n'est pas un champ : c'est un choix entre deux facons de
      // decrire le taux. On EFFACE l'autre, sans quoi le pret resterait decrit
      // deux fois, dont une seule compte - mais on GARDE en memoire ce qu'on
      // efface : un aller-retour ne doit pas faire ressaisir la marge, et un
      // champ qui etait vide doit REVENIR vide. Y ecrire zero changerait son
      // sens : vide, la marge herite du produit ; a zero, elle vaut zero.
      const j = Number(d.poserChamp.split('.')[1]);
      const pret = etat.prets[j];
      if (pret) {
        const cache = cacheModeTaux.get(j) ?? {};
        if (brut === 'fixe') {
          cache.spread = pret.spread;
          cache.taux_plancher = pret.taux_plancher;
          delete pret.spread;
          delete pret.taux_plancher;
          // Un taux fixe sans taux n'existe pas : sans lui, le mode retomberait
          // sur l'indexation au rendu suivant. Le cache d'abord, un ordre de
          // grandeur a defaut.
          pret.taux = cache.taux ?? pret.taux ?? 0.02;
        } else {
          cache.taux = pret.taux;
          delete pret.taux;
          if (nul(cache.spread)) delete pret.spread;
          else pret.spread = cache.spread;
          if (nul(cache.taux_plancher)) delete pret.taux_plancher;
          else pret.taux_plancher = cache.taux_plancher;
        }
        cacheModeTaux.set(j, cache);
      }
    } else {
      ecrireSaisie(d.poserChamp, valeur);
    }
    rafraichirTout();
    return;
  }

  // --- Jalons d'appels de fonds : ajout et suppression ---
  if (el.id === 'btn-ajouter-jalon') {
    const liste = listeJalons();
    let n = liste.length + 1;
    while (liste.some((x) => x.id === `jalon_${n}`)) n++;
    ecrireSaisie('baremes.tresorerie.jalons_vefa.jalons', [
      ...liste,
      { id: `jalon_${n}`, libelle: `Nouveau stade ${n}`, part: 0, avancement: 0.5 },
    ]);
    rafraichirTout();
    return;
  }

  const supJalon = el.closest('[data-supprimer-jalon]');
  if (supJalon) {
    const i = Number(/** @type {HTMLElement} */ (supJalon).dataset.supprimerJalon);
    const nom = /** @type {HTMLElement} */ (supJalon).dataset.nom;
    if (!(await confirmerBoite('Supprimer le jalon', `« ${nom} » sera retiré du barème d’appels de fonds.`, 'Supprimer'))) return;
    ecrireSaisie(
      'baremes.tresorerie.jalons_vefa.jalons',
      listeJalons().filter((_, k) => k !== i),
    );
    rafraichirTout();
    return;
  }

  // --- Modeles de pret : ajout et suppression ---
  // Ils vivent dans le REFERENTIEL, donc toute modification derive un profil,
  // comme n'importe quel bareme. `ecrireSaisie` s'en charge ; ici on ne fait que
  // poser la liste modifiee au bon chemin.
  if (el.id === 'btn-ajouter-preset') {
    const liste = listePresets();
    let n = liste.length + 1;
    while (liste.some((x) => x.id === `MODELE_${n}`)) n++;
    ecrireSaisie('baremes.presets_prets.presets', [
      ...liste,
      {
        id: `MODELE_${n}`,
        libelle: `Nouveau modèle ${n}`,
        nature: 'autre',
        duree_ans: 40,
        revisabilite: 'TAUX FIXE',
        progressivite: 0,
        profil_amortissement: 'annuite',
        differe_ans: 0,
      },
    ]);
    rafraichirTout();
    return;
  }

  const supPreset = el.closest('[data-supprimer-preset]');
  if (supPreset) {
    const i = Number(/** @type {HTMLElement} */ (supPreset).dataset.supprimerPreset);
    const nom = /** @type {HTMLElement} */ (supPreset).dataset.nom;
    if (!(await confirmerBoite('Supprimer le modèle', `« ${nom} » sera retiré des modèles de prêt.`, 'Supprimer'))) return;
    const liste = listePresets();
    ecrireSaisie(
      'baremes.presets_prets.presets',
      liste.filter((_, k) => k !== i),
    );
    rafraichirTout();
    return;
  }

  // Application d'un preset de pret : on pose TOUTES les caracteristiques du
  // produit d'un coup, sauf le montant. Les champs absents du preset sont
  // EFFACES et non laisses tels quels - un preset decrit un produit entier, en
  // garder des morceaux du precedent produirait un pret qui n'existe pas.
  const preset = el.closest('[data-preset-pret]');
  if (preset) {
    const i = Number(/** @type {HTMLElement} */ (preset).dataset.presetPret);
    const id = /** @type {HTMLElement} */ (preset).dataset.preset;
    const modele = listePresets().find((x) => x.id === id);
    const pret = etat.prets[i];
    if (!modele || !pret) return;
    for (const cle of [
      'taux', 'spread', 'cle_marge', 'taux_plancher', 'duree_ans', 'revisabilite',
      'progressivite', 'profil_amortissement', 'differe_ans', 'differe_type', 'periodicite',
    ]) {
      if (modele[cle] === undefined || modele[cle] === null) delete pret[cle];
      else pret[cle] = modele[cle];
    }
    pret.libelle = modele.libelle;
    pret.nature = modele.nature ?? 'autre';
    pret.preset = modele.id;
    rafraichirTout();
    return;
  }

  const modeRedev = el.closest('[data-mode-redevance]');
  if (modeRedev) {
    // Le regime de redevance commande la part d'apport en fonds propres (2 % en
    // transparence, 5 % sinon). On releve le taux AVANT de basculer, pour savoir
    // ensuite s'il a change et ne demander qu'alors.
    const avant = tauxApportFP();
    etat.exploitation.mode_redevance = /** @type {HTMLElement} */ (modeRedev).dataset.modeRedevance;
    proposerReajustementApports(avant);
    rafraichirTout();
    return;
  }

  const ventiler = el.closest('[data-ventiler]');
  if (ventiler) {
    const i = Number(/** @type {HTMLElement} */ (ventiler).dataset.ventiler);
    const p = etat.postes_bilan[i];
    const qp = dernierResultat?.surfaces?.quotes_parts ?? {};
    // Regrouper une repartition faite a la main la PERD : elle sera refaite au
    // prorata si l'on reventile. On ne detruit pas un arbitrage sans le dire.
    if (
      estVentile(p) &&
      ventilationSurMesure(p, qp) &&
      !(await confirmerBoite(
        'Répartition saisie à la main',
        `« ${p.libelle} » porte une répartition saisie à la main. La regrouper la remplacera ` +
          'par un montant unique, et une nouvelle ventilation repartirait au prorata de ' +
          'surface utile.',
        'Regrouper',
      ))
    ) {
      return;
    }
    basculerVentilation(p, !estVentile(p), qp);
    rafraichirTout();
    return;
  }

  if (el.closest('#btn-ventiler-tout')) {
    const vers = /** @type {HTMLElement} */ (el.closest('#btn-ventiler-tout')).dataset.action === 'ventiler';
    const qp = dernierResultat?.surfaces?.quotes_parts ?? {};
    // TOUTES les lignes basculent, renseignees ou non : le mode de saisie est
    // une propriete de la table, pas de son remplissage. Une ligne vide se
    // ventile en cases vides et reste « non renseignee ».
    const aPerdre = etat.postes_bilan.filter((p) => estVentile(p) && ventilationSurMesure(p, qp));
    if (
      !vers &&
      aPerdre.length &&
      !(await confirmerBoite(
        'Répartitions saisies à la main',
        `${aPerdre.length} ligne${aPerdre.length > 1 ? 's portent' : ' porte'} une répartition ` +
          `saisie à la main (${aPerdre.slice(0, 3).map((p) => p.libelle).join(', ')}` +
          `${aPerdre.length > 3 ? '…' : ''}). ${aPerdre.length > 1 ? 'Les' : 'La'} regrouper ` +
          `${aPerdre.length > 1 ? 'les' : 'la'} remplacera par un montant unique.`,
        'Regrouper',
      ))
    ) {
      return;
    }
    for (const p of etat.postes_bilan) {
      if (estVentile(p) !== vers) basculerVentilation(p, vers, qp);
    }
    rafraichirTout();
    return;
  }

  // Toute la ligne de pret est une zone de depliage, sauf ce qui se manipule :
  // viser un chevron de 30 pixels pour lire un detail est une contrainte
  // inutile. Les champs, listes et boutons gardent leur comportement propre.
  // `.pret__detail` est exclu : une fois le pret ouvert, cliquer dans le blanc
  // entre deux champs le refermerait.
  const ligne = el.closest('.ligne--pret[data-pret]');
  if (ligne && !el.closest('input, select, textarea, button, label, a, .pret__detail')) {
    const i = Number(/** @type {HTMLElement} */ (ligne).dataset.pret);
    if (pretsDeplies.has(i)) pretsDeplies.delete(i);
    else pretsDeplies.add(i);
    rafraichirTout();
    return;
  }

  const deplier = el.closest('[data-deplier-pret]');
  if (deplier) {
    const i = Number(/** @type {HTMLElement} */ (deplier).dataset.deplierPret);
    if (pretsDeplies.has(i)) pretsDeplies.delete(i);
    else pretsDeplies.add(i);
    rafraichirTout();
    return;
  }

  const vue = el.dataset?.vueExploitation;
  if (vue) {
    vueExploitation = vue;
    if (dernierResultat) rendreExploitation(dernierResultat);
    return;
  }

  const mode = el.dataset?.modePrets;
  if (mode) {
    // Le mode ne DETRUIT PAS la saisie : les prets restent dans l'etat et sont
    // simplement ignores le temps du mode theorique.
    etat.mode_prets = mode;
    recalculer();
    return;
  }

  // --- Generateur de lots ---
  if (el.id === 'btn-generer') {
    const lire = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id)).value;
    const nombre = Number(lire('gen-nombre'));
    if (!(nombre > 0)) {
      await informerBoite('Nombre de lots invalide', 'Indiquez un nombre de lots supérieur à zéro.');
      return;
    }
    etat.lots.push(
      ...repartirEnLots({
        code_produit: lire('gen-produit'),
        nombre,
        shab_totale: Number(lire('gen-shab')) || 0,
        annexes_totales: Number(lire('gen-annexes')) || 0,
        typologie: lire('gen-typologie'),
        batiment: lire('gen-batiment'),
      }),
    );
    rafraichirTout();
    return;
  }

  if (el.id === 'btn-supprimer-lots') {
    const cibles = [...lotsSelectionnes].sort((a, b) => b - a);
    if (!cibles.length) return;
    if (!(await confirmerBoite('Supprimer les lots sélectionnés', `${cibles.length} lots seront retirés du programme.`, 'Supprimer'))) return;
    // Du DERNIER index vers le premier : supprimer par le debut decalerait les
    // suivants et l'on effacerait des lots voisins de ceux qu'on visait.
    for (const i of cibles) etat.lots.splice(i, 1);
    lotsSelectionnes.clear();
    dernierLotCoche = null;
    rafraichirTout();
    return;
  }

  if (el.id === 'btn-vider-lots') {
    if (
      etat.lots.length &&
      !(await confirmerBoite('Vider le programme', `Les ${etat.lots.length} lots seront retirés.`, 'Vider'))
    ) {
      return;
    }
    etat.lots = [];
    rafraichirTout();
    return;
  }

  // --- Ajout depuis un ecran de tranche : l'element cree est AFFECTE a la tranche ---
  const cible = el.dataset?.ajouterTranche;
  if (cible) {
    const produit = el.dataset.produit;
    if (cible === 'subventions') {
      etat.subventions.push({ libelle: 'Nouvelle subvention', montant_eur: 0, affectation: produit });
    } else {
      etat.prets.push({
        code: `PRET_${etat.prets.length + 1}`, libelle: 'Nouveau prêt', nature: 'autre', produit,
        montant_eur: 0, taux: 0.02, progressivite: 0, duree_ans: 40,
        annee_premiere_echeance: dernierResultat?.calendrier?.annee_mise_en_location ?? 2028,
        revisabilite: 'TAUX FIXE', differe_ans: 0, differe_type: 2,
      });
    }
    rafraichirTout();
    return;
  }

  const aAjouter = el.dataset?.ajouter;
  if (aAjouter === 'lots') {
    const dernier = etat.lots.at(-1);
    etat.lots.push({
      code_produit: dernier?.code_produit ?? 'PLUS',
      nb_logements: 1,
      typologie: dernier?.typologie ?? '',
      batiment: dernier?.batiment ?? '',
      etage: '',
      shab_m2: null,
      surfaces_annexes_m2: 0,
    });
    rafraichirTout();
    return;
  }

  const aSupprimer = el.dataset?.supprimer;
  if (aSupprimer) {
    const i = Number(el.dataset.index);
    const cible = etat[aSupprimer][i];
    // Confirmation courte : une suppression de pret ou de subvention efface une
    // saisie qui ne se retrouve pas, et le bouton « x » est a deux pixels des
    // champs voisins. Les lots, eux, se regenerent d'un clic.
    if (aSupprimer !== 'lots') {
      const nom = el.dataset.nom || cible?.libelle || `élément ${i + 1}`;
      const quoi = aSupprimer === 'prets' ? 'le prêt' : 'la subvention';
      if (!(await confirmerBoite('Supprimer', `${quoi.charAt(0).toUpperCase()}${quoi.slice(1)} « ${nom} » sera retiré.`, 'Supprimer'))) return;
    }
    etat[aSupprimer].splice(i, 1);
    rafraichirTout();
    return;
  }

});

// ---------------------------------------------------------------- demarrage

appliquerTheme(themeInitial());
/**
 * Modele d'une simulation NEUVE : les reglages par defaut, et rien d'autre.
 *
 * Ce qui est vide : le programme, les postes de prix de revient, les
 * subventions, les prets, les parametres de loyer par tranche. Une operation
 * qu'on cree est une operation qu'on va saisir ; y trouver les six logements
 * et les quatorze postes de la demonstration obligerait a les effacer un par
 * un, et laisserait surtout croire a un chiffrage qui n'a jamais ete fait.
 *
 * Ce qui est garde : les dates par defaut, les hypotheses d'exploitation, le
 * catalogue des charges (tout inactif) et les profils de parametres, qui sont
 * le reglage de l'organisme et non des donnees d'operation. La NOMENCLATURE
 * des postes est gardee elle aussi, sans montants : ses quarante-six lignes
 * sont le cadre de saisie, pas du contenu.
 *
 * Fige a l'ouverture de l'application, avant toute restauration : le prendre
 * ici plutot que de cloner l'etat courant evite qu'une simulation neuve herite
 * du dossier consulte juste avant.
 */
const ETAT_INITIAL = (() => {
  const vierge = structuredClone(simulationCourantePayload());
  vierge.identite = {
    ...vierge.identite,
    nom: '',
    // Le groupe se saisit : rattacher d'office une operation neuve au projet
    // de la demonstration creerait un faux lien entre deux dossiers.
    groupe: '',
    commune: '',
    departement: '',
    // Le type et le zonage ne se DEVINENT pas : proposer VEFA en zone B1 par
    // defaut, c'est proposer un chiffrage. Le zonage se deduira de la commune
    // des qu'elle sera saisie.
    type_operation: '',
    zone_123: null,
    zone_ABC: '',
  };
  vierge.lots = [];
  vierge.postes_bilan = nomenclatureEnPostes();
  vierge.subventions = [];
  vierge.prets = [];
  vierge.loyers_par_produit = {};
  vierge.fonds_propres_par_produit = {};
  vierge.taux_apport_par_produit = {};
  vierge.remuneration_fonds_propres = {};
  vierge.regimes_par_produit = {};
  return vierge;
})();
/**
 * OPERATIONS DE DEMONSTRATION.
 *
 * Les simulations vivent dans le `localStorage`, qui est propre a chaque
 * origine : une bibliotheque vide est donc ce que voit TOUT nouveau visiteur,
 * et un outil qui s'ouvre sur rien ne se decouvre pas. Trois operations sont
 * semees au premier chargement, et seulement au premier - des que la
 * bibliotheque porte quoi que ce soit, on n'y touche plus.
 *
 * Elles sont ENTIEREMENT INVENTEES : noms, montants, programmes. Les communes,
 * elles, sont reelles parce que le zonage s'y lit, et c'est lui qui commande
 * les plafonds de loyer. Aucune ne reprend une operation existante.
 *
 * Les trois couvrent trois lectures differentes de l'outil : une operation
 * locative ordinaire, une operation a deux financements, et une operation
 * mixte a quatre tranches - celle qui donne sa matiere a la tornade et a la
 * table des scenarios.
 */
const EXEMPLES = [
  {
    id: 'tilleuls',
    nom: 'Les Tilleuls',
    groupe: 'Démonstration',
    identite: {
      commune: 'Saint-Nazaire',
      departement: 'Loire-Atlantique (44)',
      zone_ABC: 'B1',
      zone_123: 2,
      type_operation: 'Neuf',
    },
    lots: [
      { code_produit: 'PLAI', nombre: 8, shab_totale: 480, annexes_totales: 64, typologie: 'T2', batiment: 'A' },
      { code_produit: 'PLUS', nombre: 16, shab_totale: 1120, annexes_totales: 128, typologie: 'T3', batiment: 'A' },
    ],
    postes: {
      cf_acquisition: { montant_ht_eur: 780000, taux_tva: 0.055 },
      cf_vrd: { montant_ht_eur: 92000, taux_tva: 0.1 },
      cf_branchements: { montant_ht_eur: 26000, taux_tva: 0.1 },
      cf_notaire: { montant_ht_eur: 18000, taux_tva: 0.055 },
      bat_travaux: { montant_ht_eur: 2640000, taux_tva: 0.1 },
      bat_aleas: { montant_ht_eur: 66000, taux_tva: 0.1 },
      hon_architecte: { montant_ht_eur: 211000, taux_tva: 0.2 },
      hon_bureau_etudes: { montant_ht_eur: 79000, taux_tva: 0.2 },
      hon_controleur: { montant_ht_eur: 24000, taux_tva: 0.2 },
    },
    subventions: [
      { libelle: 'Etat', montant_eur: 96000, affectation: 'PLAI' },
      { libelle: 'Agglomération', montant_eur: 60000, affectation: null },
    ],
  },
  {
    id: 'ateliers',
    nom: 'Cour des Ateliers',
    groupe: 'Démonstration',
    identite: {
      commune: 'Bordeaux',
      departement: 'Gironde (33)',
      zone_ABC: 'A',
      zone_123: 1,
      type_operation: 'VEFA',
    },
    lots: [
      { code_produit: 'PLUS', nombre: 12, shab_totale: 780, annexes_totales: 96, typologie: 'T3', batiment: 'A' },
      { code_produit: 'PLS', nombre: 6, shab_totale: 372, annexes_totales: 48, typologie: 'T2', batiment: 'A' },
    ],
    postes: {
      cf_acquisition: { montant_ht_eur: 2450000, taux_tva: 0.1 },
      cf_notaire: { montant_ht_eur: 34000, taux_tva: 0 },
      cf_taxes_amenagement: { montant_ht_eur: 41000, taux_tva: 0 },
      hon_architecte: { montant_ht_eur: 48000, taux_tva: 0.2 },
      hon_assurances: { montant_ht_eur: 22000, taux_tva: 0.2 },
    },
    subventions: [{ libelle: 'Département', montant_eur: 45000, affectation: null }],
  },
  {
    id: 'verrieres',
    nom: 'Îlot Verrières',
    groupe: 'Démonstration',
    identite: {
      commune: 'Villeurbanne',
      departement: 'Rhône (69)',
      zone_ABC: 'A',
      zone_123: 1,
      type_operation: 'Neuf',
    },
    lots: [
      { code_produit: 'PLAI', nombre: 9, shab_totale: 540, annexes_totales: 72, typologie: 'T2', batiment: 'A' },
      { code_produit: 'PLUS', nombre: 14, shab_totale: 966, annexes_totales: 112, typologie: 'T3', batiment: 'A' },
      { code_produit: 'PLS', nombre: 5, shab_totale: 320, annexes_totales: 40, typologie: 'T2', batiment: 'B' },
      { code_produit: 'LOC', nombre: 6, shab_totale: 396, annexes_totales: 48, typologie: 'T3', batiment: 'B' },
    ],
    postes: {
      cf_acquisition: { montant_ht_eur: 1340000, taux_tva: 0.055 },
      cf_sondages: { montant_ht_eur: 14000, taux_tva: 0.2 },
      cf_vrd: { montant_ht_eur: 118000, taux_tva: 0.1 },
      cf_branchements: { montant_ht_eur: 37000, taux_tva: 0.1 },
      cf_notaire: { montant_ht_eur: 26000, taux_tva: 0.055 },
      bat_travaux: { montant_ht_eur: 3980000, taux_tva: 0.1 },
      bat_actualisation: { montant_ht_eur: 119000, taux_tva: 0.1 },
      bat_aleas: { montant_ht_eur: 99000, taux_tva: 0.1 },
      hon_architecte: { montant_ht_eur: 318000, taux_tva: 0.2 },
      hon_bureau_etudes: { montant_ht_eur: 126000, taux_tva: 0.2 },
      hon_controleur: { montant_ht_eur: 35000, taux_tva: 0.2 },
      hon_assurances: { montant_ht_eur: 48000, taux_tva: 0.2 },
    },
    subventions: [
      { libelle: 'Etat', montant_eur: 108000, affectation: 'PLAI' },
      { libelle: 'Agglomération', montant_eur: 90000, affectation: null },
      { libelle: 'Action logement :', montant_eur: 55000, affectation: null },
    ],
  },
  // EHPAD : le seul montage de la serie qui ne ressemble a aucun autre, et la
  // raison de sa presence. Trois choses n'apparaissent nulle part ailleurs :
  //
  //  - AUCUN PRET. L'operation est portee a 100 % par des fonds propres
  //    remuneres a 2,5 % et reconstitues sur trente ans (R-FIN-7). Sans annuite
  //    d'emprunt pour la couvrir, la charge de fonds propres se lit enfin seule.
  //  - UNE TVA A 5,5 % SUR DU PLS. Un etablissement medico-social releve du 6 du
  //    I de l'article L. 312-1 du CASF, vise par le CGI 278 sexies, la ou le
  //    referentiel donne 10 % au foyer PLS ordinaire. La surcharge passe par un
  //    PROFIL (R-PARAM) : elle voyage avec le dossier et se lit a l'ecran des
  //    parametres, plutot que de se cacher dans le taux de chaque ligne. C'est
  //    la question Q-40.
  //  - UNE REDEVANCE et non des loyers : le regime foyer (R-EXP-7).
  {
    id: 'ehpad',
    nom: 'EHPAD 16 places',
    groupe: 'Démonstration',
    identite: {
      commune: 'Lyon',
      departement: 'Rhône (69)',
      zone_ABC: 'A',
      zone_123: 2,
      type_operation: 'Neuf',
    },
    dates: {
      date_debut_travaux: '2026-08-25',
      duree_chantier_mois: 22,
      date_livraison: '2028-06-05',
      duree_simulation_ans: 61,
    },
    lots: [
      { code_produit: 'FPLS', nombre: 16, shab_totale: 320, annexes_totales: 0, typologie: 'T1', batiment: 'A' },
    ],
    postes: {
      bat_travaux: { montant_ht_eur: 2750000, taux_tva: 0.055 },
      bat_aleas: { montant_ht_eur: 300000, taux_tva: 0.055 },
      hon_architecte: { montant_ht_eur: 305000, taux_tva: 0.055 },
      hon_geometre: { montant_ht_eur: 30000, taux_tva: 0.055 },
      hon_assurances: { montant_ht_eur: 17106.215, taux_tva: 0.055 },
      hon_sps: { montant_ht_eur: 14100, taux_tva: 0.055 },
      hon_conduite_operation: { montant_ht_eur: 36243, taux_tva: 0.055 },
      // Hors champ de la livraison a soi-meme : le TTC reste le HT. Sans ce
      // marqueur les interets prendraient 5,5 % comme le reste, et le prix de
      // revient serait faux de 10 016 EUR.
      ff_interets_prefi: { montant_ht_eur: 182116.69609125, taux_tva: 0, hors_lasm: true },
    },
    subventions: [],
    // Racines que les trois autres exemples n'ont pas besoin de toucher.
    reste: {
      fonds_propres_par_produit: { FPLS: 3824450.61791625 },
      remuneration_fonds_propres: {
        FPLS: { remuneres: true, taux: 0.025, reconstitues: true, duree_reconstitution_ans: 30 },
      },
      regimes_par_produit: {
        FPLS: {
          mode: 'redevance',
          mode_redevance: 'forfaitaire',
          // Redevance d'equilibre : elle couvre exactement les charges, charge
          // de fonds propres comprise. Valeur de l'annee de mise en location.
          redevance_annuelle_eur: 236380.82,
          redevance_annee_valeur: 2028,
        },
      },
      exploitation: {
        // Les frais de gestion s'assoient ici sur le PRIX DE REVIENT, a 0,3 %,
        // et non sur les loyers : c'est l'assiette des operations en redevance.
        frais_gestion_pct_loyers: 0,
        frais_gestion_pct_prix_revient: 0.003,
        taux_vacance_impayes: 0,
        gros_entretien_eur_m2: 0,
        pge_taux: 0.006,
        pge_base_eur: 3642333.921825,
        tfpb_par_logement_eur: 345,
        annee_debut_tfpb: 2053,
        nb_lits: 16,
        mode: 'redevance',
        mode_redevance: 'forfaitaire',
        redevance_annuelle_eur: 236380.82,
        redevance_annee_valeur: 2028,
      },
      profils: [
        { id: 'referentiel', nom: 'AXENTIA HER 2027 (référentiel)', parametrage: {} },
        {
          id: 'ehpad-casf',
          nom: 'AXENTIA HER 2027 · EHPAD (TVA 5,5 %)',
          parametrage: { baremes: { tva: { lasm_par_produit: { FPLS: 0.055 } } } },
          parametrage_sauve: { baremes: { tva: { lasm_par_produit: { FPLS: 0.055 } } } },
        },
      ],
      profil_actif: 'ehpad-casf',
    },
  },
];

/**
 * Seme les exemples, une seule fois, sur une bibliotheque vide.
 *
 * Chacun part de l'etat VIERGE et non de l'operation de demonstration du
 * module : partir d'un etat deja rempli laisserait trainer des postes et des
 * lots qu'on croirait choisis.
 */
const CLE_EXEMPLES_SEMES = 'moteur-sim.exemples-semes';

/**
 * Ce qui a DEJA ete seme, exemple par exemple.
 *
 * Un simple booleen ne suffisait pas, et c'est la lecon d'un ajout : marquer
 * « les exemples ont ete semes » interdit toute arrivee ulterieure, puisque le
 * marqueur d'hier bloque l'exemple d'aujourd'hui. Un REGISTRE d'identifiants
 * tient les deux besoins a la fois : un exemple supprime ne revient pas, un
 * exemple neuf arrive quand meme.
 *
 * L'ancien booleen se migre en registre des trois premiers : un poste qui les
 * avait deja ne doit pas les voir reapparaitre en double.
 */
function registreSemis() {
  let brut = null;
  try {
    brut = localStorage.getItem(CLE_EXEMPLES_SEMES);
  } catch {
    return null; // stockage indisponible : rien a lire, rien a ecrire
  }
  if (brut === null) return [];
  // Le booleen de la premiere version valait pour les trois exemples d'alors.
  if (brut === '1') return ['tilleuls', 'ateliers', 'verrieres'];
  try {
    const l = JSON.parse(brut);
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}

/** Ecrit le registre et rend le compte inchange, pour s'ecrire en une ligne. */
function marquerSemis(ids, poses) {
  try {
    localStorage.setItem(CLE_EXEMPLES_SEMES, JSON.stringify(ids));
  } catch {
    /* stockage indisponible : rien a memoriser, rien a reparer */
  }
  return poses;
}

function semerExemples() {
  const deja = registreSemis();
  if (deja === null) return 0;
  const tous = EXEMPLES.map((e) => e.id);
  // Bibliotheque non vide ET aucun semis connu : ce sont les dossiers de
  // quelqu'un, pas une page neuve. On enregistre tout comme seme sans rien y
  // ajouter, plutot que de deposer quatre demonstrations chez lui.
  if (!deja.length && listerSimulations().length) return marquerSemis(tous, 0);
  const aSemer = EXEMPLES.filter((e) => !deja.includes(e.id));
  if (!aSemer.length) return 0;
  let poses = 0;
  const faits = [...deja];
  for (const ex of aSemer) {
    const sim = structuredClone(ETAT_INITIAL);
    sim.identite = { ...sim.identite, ...ex.identite, nom: ex.nom, groupe: ex.groupe };
    if (ex.dates) sim.dates = { ...sim.dates, ...structuredClone(ex.dates) };
    sim.lots = ex.lots.flatMap((l) => repartirEnLots(l));
    sim.postes_bilan = nomenclatureEnPostes(ex.postes);
    sim.subventions = structuredClone(ex.subventions);
    // Racines supplementaires : un montage en redevance, des fonds propres
    // remuneres ou un profil de parametres derive ne se decrivent pas avec les
    // quatre cles ci-dessus. Elles REMPLACENT la racine, sans fusion : une
    // fusion profonde laisserait trainer les valeurs de l'etat vierge au milieu
    // de celles de l'exemple, et on ne saurait plus lesquelles ont ete voulues.
    for (const [cle, valeur] of Object.entries(ex.reste ?? {})) {
      sim[cle] = structuredClone(valeur);
    }
    if (ajouterSimulation(sim)) {
      poses += 1;
      faits.push(ex.id);
    }
  }
  return marquerSemis(faits, poses);
}

semerExemples();
const dossierRouvert = restaurerSaisie();
// L'ecran quitte se lit AVANT le premier rendu : celui-ci reaffiche l'onglet
// marque dans le HTML, et `afficherEcran` reecrit alors la memoire - on
// perdrait la position en la relisant apres.
const ecranMemorise = (() => {
  try {
    return localStorage.getItem(CLE_ECRAN);
  } catch {
    return null;
  }
})();
rendreChampsStatiques();
rafraichirTout();
rendreBibliotheque();
majAccesMontage();
// On repart exactement d'ou l'on etait : meme dossier, meme onglet. Sans
// dossier ouvert il n'y a qu'un ecran possible, la bibliotheque.
afficherEcran(dossierRouvert ? (ecranMemorise ?? 'operation') : 'simulations');
// Le curseur vient d'etre pose sur l'onglet memorise SANS transition (classe
// `onglets--muet` du HTML) : il apparait en place au lieu de traverser le rail
// au chargement. Elle se retire une fois ce premier placement peint - deux
// trames, la premiere pouvant precede le rendu du style initial.
requestAnimationFrame(() =>
  requestAnimationFrame(() => document.getElementById('onglets')?.classList.remove('onglets--muet')),
);
