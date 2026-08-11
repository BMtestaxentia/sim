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
 * Operation de depart, calquee sur la structure BERGERAC.
 *
 * Aucun taux de Livret A n'est fige ici : le moteur applique celui du referentiel.
 * Une valeur codee a cet endroit ecraserait le referentiel et ferait diverger deux
 * prets pourtant identiques a l'ecran.
 */
const etat = {
  identite: {
    nom: 'Opération de test',
    version: 'V1 - Faisabilité',
    commune: 'Bergerac',
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
  // R-FIN-7 : regime des fonds propres, tranche par tranche.
  remuneration_fonds_propres: {},
  // R-EXP-7 : regime de produits par tranche, loyers ou redevance.
  regimes_par_produit: {},
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
 * Taux de TVA qu'une ligne de prix de revient peut porter sur une tranche.
 *
 * Le taux social est propre au PRODUIT : 5,5 % existe sur du PLAI, pas sur du
 * PLS. Proposer la meme liste partout laissait saisir un taux inexistant, et
 * c'est ainsi qu'une tranche PLS se retrouvait a 5,5 %. La regle vit dans le
 * moteur (R-TVA-2), l'ecran ne fait que la lire.
 *
 * Memoise : la liste ne depend que du produit et du referentiel, et la table du
 * prix de revient la redemande une fois par cellule.
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
function tauxAdmis(code) {
  const normal = referentiels.baremes.tva.taux_normal;
  if (!code) return [0, normal];
  return [...new Set([0, normal, tauxProduit(code)])].sort((a, b) => a - b);
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
  // porter « ORLEANS » ou « Orleans » sans accent.
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

function rendreChampsStatiques() {
  rendreSelectDepartement();
  for (const el of document.querySelectorAll('[data-champ]')) {
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
 * R-FIN-3 - Chaque tranche presente au programme porte un pret CDC foncier et un
 * pret CDC construction, crees des son apparition et en montant AUTOMATIQUE.
 *
 * On ne les supprime PAS quand la tranche disparait : l'utilisateur peut avoir
 * retire un lot par erreur, et retrouver ses caracteristiques de pret en
 * revenant en arriere vaut mieux que les ressaisir. Le moteur ignore un pret
 * dont la tranche n'existe plus.
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
                  <span class="jeton"><span class="jeton__cle">part du prix de revient</span><span class="jeton__valeur" data-part-fp="${code}">-</span></span>
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
                <div class="pret__entete">
                  <input type="text" class="ressource__libelle" data-champ="subventions.${i}.libelle" value="${att(s.libelle)}" />
                  <input type="text" inputmode="decimal" class="pret__montant" data-champ="subventions.${i}.montant_eur"
                    data-type="montant" value="${valMontant(s.montant_eur)}" />
                  <span class="pret__actions">
                    <button type="button" class="bouton--supprimer" data-supprimer="subventions" data-index="${i}"
                      data-nom="${att(s.libelle)}" title="Supprimer">×</button>
                  </span>
                </div>
                <div class="jetons"><span class="jeton"><span class="jeton__cle">part du prix de revient</span><span class="jeton__valeur" data-part-sub="${i}">-</span></span></div>
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
function proposerReajustementApports(ancienTaux) {
  const nouveauTaux = tauxApportFP();
  if (nouveauTaux === ancienTaux) return;
  const saisies = Object.keys(etat.fonds_propres_par_produit).filter(
    (c) => !nul(etat.fonds_propres_par_produit[c]) && apportTheoriqueFP(c) !== null,
  );
  if (!saisies.length) return;
  const ok = confirm(
    `L’apport en fonds propres passe de ${pct(ancienTaux, 1)} à ${pct(nouveauTaux, 1)} ` +
      `du prix de revient.\n\n` +
      `${saisies.length} tranche(s) portent un montant saisi, qui ne suivra pas. ` +
      `Les remettre au montant calculé ? Annuler les laisse tels quels.`,
  );
  if (!ok) return;
  for (const c of saisies) delete etat.fonds_propres_par_produit[c];
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
      <label class="champ"><span>Différé (ans)</span>
        <input type="number" step="1" min="0" data-champ="${c('differe_ans')}" data-type="nombre"
          value="${valNum(p.differe_ans)}" /></label>
      <div class="champ champ--choix ${p.differe_ans ? '' : 'champ--eteint'}"><span>Pendant le différé</span>
        ${segments(
          c('differe_type'),
          OPTIONS_DIFFERE.map((o) => ({ v: o.v, l: o.l })),
          p.differe_type ?? 2,
          'nombre',
          !p.differe_ans,
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
    // Le TYPE de differe ne se met pas dans le jeton : c'est un detail de
    // mecanique - interets dus ou non - qui se lit dans le detail deplie, la ou
    // il se saisit. Sur la ligne repliee, il encombrait sans repondre a la
    // question qu'on se pose, qui est de savoir quand le pret commence a
    // s'amortir.
    ...(p.differe_ans ? [jeton('différé', `${p.differe_ans} ans`)] : []),
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
          'Elle ne suit pas les charges : vérifié sur l’annexe Orléans, où aucune rupture de charges ' +
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
        <td class="col-select"><input type="checkbox" class="lot__select" data-select-lot="${i}"
          aria-label="Sélectionner le lot ${i + 1}" ${lotsSelectionnes.has(i) ? 'checked' : ''} />
          <span class="poignee" draggable="true" title="Glisser pour réordonner">⠿</span></td>
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
        <td><button type="button" class="bouton--supprimer" data-supprimer="lots" data-index="${i}" title="Supprimer">×</button></td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="12" class="vide">Aucun lot. Utiliser le générateur ci-dessus ou « + lot ».</td></tr>';
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
        `<th class="col-groupe${finBloc(c)}" colspan="${tva ? 2 : 1}" style="--cat:${catProduit(c)}">` +
        `<span class="col-groupe__puce"></span>${att(libelleProduit(c))}</th>`,
    )
    .join('');
  const sousColonnes = codes
    .map(
      (c) =>
        `<th class="num col-tranche col-tranche--debut${tva ? '' : finBloc(c)}" style="--cat:${catProduit(c)}">HT (€)</th>` +
        (tva ? `<th class="num col-tranche${finBloc(c)}" style="--cat:${catProduit(c)}">TVA</th>` : ''),
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
    ['num calc', 'TTC saisie (€)'],
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
                  `<td class="col-tranche col-tranche--debut${tva ? '' : finBloc(c)}" style="--cat:${catProduit(c)}"></td>` +
                  (tva ? `<td class="col-tranche${finBloc(c)}" style="--cat:${catProduit(c)}"></td>` : ''),
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

      // Les taux proposes sont ceux qui EXISTENT pour la tranche visee : le taux
      // social est propre au produit, 5,5 % n'a pas de sens sur du PLS. Un taux
      // deja saisi hors liste y est ajoute plutot que perdu en silence - on ne
      // reecrit pas une saisie sans le dire, la validation le signale.
      const selectTVA = (chemin, valeur, col, code) => {
        const admis = tauxAdmis(code);
        const options = admis.includes(valeur) || nul(valeur) ? admis : [...admis, valeur].sort((a, b) => a - b);
        return `<select data-champ="${chemin}" data-type="nombre"${col === undefined ? '' : ` data-l="${l}" data-c="${col}"`}>
          ${options
            .map(
              (v) =>
                `<option value="${v}" ${v === valeur ? 'selected' : ''}${admis.includes(v) ? '' : ' data-hors-bareme="1"'}>` +
                `${(v * 100).toFixed(1)} %${admis.includes(v) ? '' : ' (hors barème)'}</option>`,
            )
            .join('')}
        </select>`;
      };

      const cellulesTranches = parTranche
        ? codes
            .map((c, ic) => {
              const style = `style="--cat:${catProduit(c)}"`;
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
        ${tvaGlobale ? `<td>${selectTVA(`postes_bilan.${i}.taux_tva`, p.taux_tva, 1, codes[0])}</td>` : ''}
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
              `<td class="num col-tranche col-tranche--debut${tva ? '' : finBloc(c)}" style="--cat:${catProduit(c)}" data-sous-total="${c}" data-cle="ht_eur"></td>` +
              (tva
                ? `<td class="num col-tranche${finBloc(c)}" style="--cat:${catProduit(c)}" data-sous-total="${c}" data-cle="tva_eur"></td>`
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
          return `<tr>
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
    // Sans le RMO : retire du recapitulatif a la demande de Bastien, comme il
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
    poser('duree', nul(a?.duree_ans) ? '-' : `${a.duree_ans} ans`);
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
      // Le loyer se lit deja en detail dans son encart, chaine de calcul
      // comprise : le redire ici prenait deux tuiles sur six pour rien. A leur
      // place, deux grandeurs qui n'apparaissent NULLE PART ailleurs sur
      // l'ecran de tranche - le cout unitaire, qui est la mesure a laquelle on
      // compare deux operations, et l'annuite, qui est ce que la tranche paiera
      // vraiment chaque annee.
      const parLogement = t.nb_logements ? (t.prix_revient_ttc_eur ?? 0) / t.nb_logements : null;
      const parM2 = t.shab_m2 ? (t.prix_revient_ttc_eur ?? 0) / t.shab_m2 : null;
      const annuite1 = pretsTranche.reduce(
        (s, a) => s + (a.tableau?.find((x) => x.annuite_eur > 0)?.annuite_eur ?? 0),
        0,
      );
      const nbPrets = pretsTranche.filter((a) => a.montant_eur > 0).length;
      bandeau.innerHTML = [
        tuile('Prix de revient', eur(t.prix_revient_ttc_eur), 'TTC'),
        tuile('Programme', `${nb(t.nb_logements)} lgts`, `${nb(t.su_m2)} m² SU · ${pct(t.quote_part_su, 1)} de l’opération`),
        tuile(
          'Coût par logement',
          parLogement === null ? '-' : eur(parLogement),
          parM2 === null ? '' : `${eur(parM2)} / m² SHAB`,
        ),
        tuile(
          'Annuité',
          annuite1 ? eur(annuite1) : '-',
          nbPrets ? `1re échéance · ${nbPrets} prêt${nbPrets > 1 ? 's' : ''}` : 'aucun prêt mobilisé',
        ),
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
            `<td class="num col-tranche col-tranche--debut${tvaVisible ? '' : finTr(c)}" style="--cat:${catProduit(c)}">${eur(b.par_tranche?.[c]?.total_ht_eur)}</td>` +
            (tvaVisible ? `<td class="num col-tranche${finTr(c)}" style="--cat:${catProduit(c)}">${eur(b.par_tranche?.[c]?.total_tva_eur)}</td>` : ''),
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
                  `<td class="col-tranche col-tranche--debut${tvaVisible ? '' : finTr(c)}" style="--cat:${catProduit(c)}"></td>` +
                  (tvaVisible ? `<td class="col-tranche${finTr(c)}" style="--cat:${catProduit(c)}"></td>` : ''),
              )
              .join('')
          : ''
      }
      <td></td>
      <td class="num">${eur(b.total_ttc_module_eur)}</td>
    </tr>
    <tr>
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
                  `<td class="col-tranche col-tranche--debut${tvaVisible ? '' : finTr(c)}" style="--cat:${catProduit(c)};border-top:none"></td>` +
                  (tvaVisible ? `<td class="col-tranche${finTr(c)}" style="--cat:${catProduit(c)};border-top:none"></td>` : ''),
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
        ([code, t]) => `<tr><td>${att(libelleProduit(code))}</td><td class="num">${nb(t.su_m2)}</td>
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
  rendreExploitation(r);
}

function rendreBarre(element, segments, echelle) {
  element.innerHTML = segments
    .filter((s) => s.montant > 0)
    .map((s) => {
      const etiquette = s.montant / echelle > 0.07 ? `<span>${eur(s.montant)}</span>` : '';
      return `<div class="segment" style="flex-grow:${s.montant};background:${s.couleur}" title="${att(s.libelle)} : ${eur(s.montant)}">${etiquette}</div>`;
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
  // et avec ses ratios. Le RMO aussi, retire a la demande de Bastien.
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
function viderRestitution(message) {
  const bandeau = $('#bandeau-controle');
  bandeau.className = 'bandeau bandeau--erreur';
  bandeau.innerHTML = `<span class="bandeau__principal">Aucun résultat</span>
    <span class="bandeau__detail">${att(message)}</span>`;
  for (const sel of [
    '#barre-emplois', '#barre-ressources', '#legende-emplois', '#legende-ressources',
    '#precision-emplois', '#precision-ressources', '#liste-subventions',
    '#indicateurs', '#controles',
    '#messages-moteur', '#tuiles-exploitation', '#graphe-exploitation', '#postes-absents',
  ]) {
    $(sel).innerHTML = '';
  }
  $('#table-exploitation').querySelector('tbody').innerHTML = '';
  $('#table-exploitation').querySelector('tfoot').innerHTML = '';
  $('#bandeau-exploitation').className = 'bandeau bandeau--erreur';
  $('#bandeau-exploitation').innerHTML = `<span class="bandeau__principal">Aucun résultat</span>`;
  $('#aide-graphe').textContent = '';
  $('#aide-exploitation').textContent = '';
  $('#total-emplois').textContent = '-';
  $('#total-ressources').textContent = '-';
  $('#table-prets').querySelector('tbody').innerHTML = '';
  $('#table-prets').querySelector('tfoot').innerHTML = '';
  $('#aide-taux').textContent = '';
}

// ---------------------------------------------------------------- ecran exploitation

/** Vue courante du compte : annee par annee (defaut) ou jalons condenses. */
let vueExploitation = 'annuel';

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
  const cumuls = lignes.map((l) => l.cumul_autofinancement_eur);
  const maxRes = Math.max(...resultats, 0);
  const minRes = Math.min(...resultats, 0);
  const etendueRes = maxRes - minRes || 1;
  const maxCum = Math.max(...cumuls, 0);
  const minCum = Math.min(...cumuls, 0);
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
      return `<rect class="graphe__barre--${classe}" x="${(xCentre(i) - largeurBarre / 2).toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${largeurBarre.toFixed(1)}" height="${haut.toFixed(1)}"><title>${l.annee} : résultat ${eur(l.autofinancement_eur)}, cumul ${eur(l.cumul_autofinancement_eur)}</title></rect>`;
    })
    .join('');

  const trace = lignes.map((l, i) => `${xCentre(i).toFixed(1)},${yCum(l.cumul_autofinancement_eur).toFixed(1)}`).join(' ');

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
      aria-label="Résultat annuel en barres et cumul en ligne, de ${lignes[0].annee} à ${lignes.at(-1).annee}">
      <line class="graphe__zero" x1="${marge.gauche}" y1="${yRes(0).toFixed(1)}" x2="${L - marge.droite}" y2="${yRes(0).toFixed(1)}" />
      ${barres}
      <polyline class="graphe__cumul" points="${trace}" />
      ${reperes}${axe}
      <text class="graphe__texte" x="${marge.gauche}" y="${H - 2}">Résultat de l’année, échelle ${eur(minRes)} à ${eur(maxRes)}</text>
      <text class="graphe__texte" x="${L - marge.droite}" y="${H - 2}" text-anchor="end">Cumul, échelle ${eur(minCum)} à ${eur(maxCum)}</text>
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

function rendreExploitation(r) {
  const e = r.exploitation;
  const ind = e.indicateurs;

  // --- Bandeau ---
  const bandeau = $('#bandeau-exploitation');
  const deficit = ind.exercices_deficitaires > 0;
  bandeau.className = `bandeau ${deficit ? 'bandeau--alerte' : 'bandeau--ok'}`;
  bandeau.innerHTML =
    `<span class="bandeau__principal">${
      deficit
        ? `${ind.exercices_deficitaires} exercice${ind.exercices_deficitaires > 1 ? 's' : ''} déficitaire${ind.exercices_deficitaires > 1 ? 's' : ''}`
        : 'Aucun exercice déficitaire'
    }</span>` +
    `<span class="bandeau__detail">${e.lignes.length} années simulées, de ${e.lignes[0]?.annee} à ` +
    `${e.lignes.at(-1)?.annee}${deficit ? `, de ${ind.premiere_annee_deficitaire} à ${ind.derniere_annee_deficitaire}` : ''}. ` +
    `${
      e.mode === 'redevance'
        ? `Produits en redevance ${etat.exploitation.mode_redevance === 'transparence' ? 'en transparence' : 'forfaitaire'} (mode foyer). `
        : ''
    }` +
    `Compte partiel : ${e.postes_absents.length} familles de postes ne sont pas encore modélisées.</span>`;

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
  for (const b of document.querySelectorAll('[data-vue-exploitation]')) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-vue-exploitation') === vueExploitation));
  }
  const rangs =
    vueExploitation === 'jalons'
      ? e.jalons
      : e.lignes.map((l) => ({
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
    vueExploitation === 'jalons'
      ? `⚙ Les années de rupture et les premières années sont détaillées, les périodes intermédiaires ` +
        `sont présentées en moyenne annuelle. Basculer sur « Année par année » pour le détail complet.`
      : `⚙ ${e.lignes.length} exercices, de ${e.lignes[0]?.annee} à ${e.lignes.at(-1)?.annee}. ` +
        `La dernière année porte une marge exceptionnelle : les prêts y sont soldés.`;

  $('#postes-absents').innerHTML = e.postes_absents.map((p) => `<li>${att(p)}</li>`).join('');
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
function carteParametre(c) {
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
  const lignes = m.lignes.filter((l) => l.cellules.some(correspond));
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

function rendreParametres() {
  const sections = modeleParametres();
  rendreBarreProfil();

  // En recherche, le rail s'efface : on cherche a travers tout, pas dans une
  // section. Le compteur de resultats prend sa place.
  const enRecherche = rechercheParametre.trim().length > 0;

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
    ) + rubrique('Admin', sections.filter((s) => s.rubrique !== 'exploitation'));

  const bloc = (s) => {
    const champs = (s.champs ?? []).filter(correspond);
    const matrices = (s.matrices ?? []).map(tableMatrice).filter(Boolean);
    const traj = s.trajectoires && !enRecherche ? sectionTrajectoires() : '';
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

  // Les hypotheses sont du markup statique : on les MONTRE, on ne les regenere
  // pas. En recherche, elles paraissent si l'un de leurs intitules repond -
  // les exclure aurait fait mentir le « aucun resultat » affiche a cote.
  const panneauHypotheses = document.getElementById('para-hypotheses');
  const hypothesesVisees = enRecherche
    ? [...panneauHypotheses.querySelectorAll('.champ > span, h3, h4')].some((e) =>
        correspond({ libelle: e.textContent ?? '' }),
      )
    : sectionParametres === 'hypotheses';
  panneauHypotheses.hidden = !hypothesesVisees;

  const affichees = (enRecherche ? sections : sections.filter((s) => s.id === sectionParametres))
    .filter((s) => s.id !== 'hypotheses');
  const html = affichees.map(bloc).filter(Boolean).join('');

  $('#contenu-parametres').innerHTML =
    html || hypothesesVisees
      ? html
      : `<section class="bloc"><p class="vide">Aucun paramètre ne correspond à « ${att(rechercheParametre)} ».</p></section>`;
  remplirTauxMarges(dernierResultat);
  // Reordonnancement des modeles. La table est reconstruite a chaque rendu :
  // les ecouteurs se reposent donc ici, et la garde `data-glisser-pose` evite
  // de les empiler sur une table qui aurait survecu.
  poserGlisser(document.getElementById('table-presets'), (de, vers) => {
    ecrireSaisie('baremes.presets_prets.presets', deplacer(listePresets(), de, vers));
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
    $('#version-moteur').textContent = `v${r.version_moteur}`;
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

/** Bascule l'affichage vers un ecran, onglets et panneaux d'un seul tenant. */
function afficherEcran(cible) {
  const existe = document.getElementById(`ecran-${cible}`);
  // La tranche affichee peut avoir disparu entre-temps (dernier lot supprime) :
  // on retombe alors sur le programme plutot que sur une page blanche.
  const vise = existe ? cible : 'programme';
  for (const o of document.querySelectorAll('[data-ecran]')) {
    o.setAttribute('aria-selected', String(/** @type {HTMLElement} */ (o).dataset.ecran === vise));
  }
  for (const e of document.querySelectorAll('.ecran')) {
    /** @type {HTMLElement} */ (e).hidden = e.id !== `ecran-${vise}`;
  }
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
 * Memorisation de la saisie d'une ouverture a l'autre.
 *
 * Le moteur reste pur : rien n'est stocke de son cote, on ne persiste que la
 * SAISIE - l'operation et les profils de parametres. Les resultats se
 * recalculent a l'ouverture, ce qui garantit qu'une saisie memorisee hier ne
 * ressort pas avec les chiffres d'hier si le moteur a change depuis.
 *
 * La cle porte une VERSION. Une saisie memorisee decrit une structure ; quand
 * celle-ci evolue - un poste ajoute a la nomenclature, une entree renommee -
 * la relire telle quelle ferait revivre l'ancienne structure par-dessus la
 * nouvelle, en silence. On prefere repartir de l'operation de demonstration :
 * bumper cette version est le geste qui accompagne un changement de structure.
 */
const CLE_SAISIE = 'moteur-sim.saisie.v1';

/** Ecran affiche. Memorise a part : c'est une position de lecture, pas une donnee. */
const CLE_ECRAN = 'moteur-sim.ecran';

/** Les seules racines memorisees : ce que l'utilisateur a saisi, rien d'autre. */
const RACINES_PERSISTEES = [
  'identite', 'dates', 'lots', 'postes_bilan', 'loyers_par_produit', 'subventions',
  'fonds_propres_par_produit', 'remuneration_fonds_propres', 'regimes_par_produit',
  'mode_prets', 'prets',
  'exploitation', 'profils', 'profil_actif', 'options',
];

let sauvegardeEnAttente = null;

/**
 * Ecrit la saisie, une fois les frappes retombees. Sauver a chaque caractere
 * serait un acces disque par touche pour un etat qui n'aura de sens qu'une fois
 * le nombre entier.
 */
function memoriserSaisie() {
  clearTimeout(sauvegardeEnAttente);
  sauvegardeEnAttente = setTimeout(() => {
    try {
      const aGarder = Object.fromEntries(RACINES_PERSISTEES.map((c) => [c, etat[c]]));
      localStorage.setItem(CLE_SAISIE, JSON.stringify(aGarder));
    } catch {
      // Stockage indisponible ou plein : la session continue normalement, seule
      // la memoire d'une ouverture a l'autre est perdue. Ce n'est pas une raison
      // d'interrompre une saisie en cours.
    }
  }, 400);
}

/**
 * Relit la saisie memorisee et la pose sur l'etat de depart. Les racines sont
 * REMPLACEES et non fusionnees : une liste de prets memorisee doit rester celle
 * qui a ete saisie, pas se melanger a celle de la demonstration.
 */
function restaurerSaisie() {
  let brut;
  try {
    brut = localStorage.getItem(CLE_SAISIE);
  } catch {
    return false;
  }
  if (!brut) return false;
  try {
    const lu = JSON.parse(brut);
    // Une saisie sans identite n'en est pas une : plutot que de restaurer un
    // objet a moitie forme, on repart proprement de la demonstration.
    if (!lu || typeof lu !== 'object' || !lu.identite) return false;
    for (const cle of RACINES_PERSISTEES) {
      if (lu[cle] !== undefined) etat[cle] = lu[cle];
    }
    // Un profil actif qui ne designe plus rien laisserait l'ecran sans
    // parametres : on retombe sur le premier profil connu.
    if (!etat.profils?.some((p) => p.id === etat.profil_actif)) {
      etat.profil_actif = etat.profils?.[0]?.id ?? 'referentiel';
    }
    return true;
  } catch {
    // Contenu illisible (ecriture interrompue, cle ecrasee par un autre outil).
    return false;
  }
}

/** Efface la memoire et recharge : le plus sur moyen de revenir a l'origine. */
function reinitialiserSaisie() {
  if (!confirm('Effacer la saisie mémorisée et repartir de l’opération de démonstration ?')) return;
  try {
    localStorage.removeItem(CLE_SAISIE);
  } catch {
    /* voir memoriserSaisie */
  }
  location.reload();
}

// ---------------------------------------------------------------- evenements

document.addEventListener('input', (ev) => {
  const el = /** @type {HTMLInputElement} */ (ev.target);

  // La recherche de parametre ne touche pas a l'etat : elle ne fait que filtrer
  // l'affichage. Elle passe donc AVANT la garde sur `data-champ`, qu'elle n'a
  // pas - c'est un filtre, pas une saisie.
  if (el.id === 'recherche-parametre') {
    rechercheParametre = el.value;
    rendreParametres();
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
    alert(
      `${posees} valeur${posees > 1 ? 's' : ''} collée${posees > 1 ? 's' : ''}. ` +
        `${hors} valeur${hors > 1 ? 's' : ''} débordai${hors > 1 ? 'ent' : 't'} de la grille, ` +
        `${hors > 1 ? 'elles ont' : 'elle a'} été ignorée${hors > 1 ? 's' : ''}.`,
    );
  }
});

document.addEventListener('change', (ev) => {
  // L'interrupteur de masquage change la STRUCTURE de la table, pas l'etat.
  const id = /** @type {HTMLElement} */ (ev.target).id;
  if (id === 'select-profil') {
    etat.profil_actif = /** @type {HTMLSelectElement} */ (ev.target).value;
    rafraichirTout();
    return;
  }
  if (id === 'afficher-tva') tvaVisible = /** @type {HTMLInputElement} */ (ev.target).checked;
  if (id === 'masquer-vides' || id === 'afficher-tva') rafraichirTout();
});

document.addEventListener('click', (ev) => {
  const el = /** @type {HTMLElement} */ (ev.target);

  // Un menu de tranches ouvert se ferme des qu'on clique AILLEURS. `details`
  // ne le fait pas de lui-meme : il reste ouvert jusqu'a ce qu'on reclique son
  // resume, si bien qu'on se retrouve avec deux ou trois panneaux flottants
  // au-dessus du tableau. On ferme donc tous ceux qui ne contiennent pas le
  // clic - celui qu'on vient d'ouvrir se contient lui-meme, il survit.
  for (const d of document.querySelectorAll('details.tranches-choix[open]')) {
    if (!d.contains(el)) /** @type {HTMLDetailsElement} */ (d).open = false;
  }

  if (el.closest('#btn-reinitialiser')) {
    reinitialiserSaisie();
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
    $('#contenu-parametres').scrollIntoView({ block: 'nearest' });
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
    const saisi = prompt(`${libelle} : taux à appliquer à toutes les années (%), vide pour revenir au référentiel`);
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
      const nom = prompt('Nom du profil', p.nom);
      if (!nom) return;
      p.nom = nom;
    } else if (action === 'reinitialiser') {
      if (!confirm(`Rendre au profil « ${p.nom} » toutes les valeurs du référentiel ?`)) return;
      p.parametrage = { baremes: {}, trajectoires: { par_annee: {} } };
      p.parametrage_sauve = structuredClone(p.parametrage);
    } else if (action === 'supprimer') {
      if (!confirm(`Supprimer le profil « ${p.nom} » ?`)) return;
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
    if (!confirm(`Supprimer le modèle « ${nom} » ?`)) return;
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
      !confirm(
        `« ${p.libelle} » porte une répartition saisie à la main. La regrouper la remplacera ` +
          'par un montant unique, et une nouvelle ventilation repartirait au prorata de surface ' +
          'utile. Continuer ?',
      )
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
      !confirm(
        `${aPerdre.length} ligne${aPerdre.length > 1 ? 's portent' : ' porte'} une répartition ` +
          `saisie à la main (${aPerdre.slice(0, 3).map((p) => p.libelle).join(', ')}` +
          `${aPerdre.length > 3 ? '…' : ''}). ${aPerdre.length > 1 ? 'Les' : 'La'} regrouper ` +
          `${aPerdre.length > 1 ? 'les' : 'la'} remplacera par un montant unique. Continuer ?`,
      )
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
      window.alert('Indiquer un nombre de lots supérieur à zéro.');
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
    if (!window.confirm(`Supprimer les ${cibles.length} lots sélectionnés ?`)) return;
    // Du DERNIER index vers le premier : supprimer par le debut decalerait les
    // suivants et l'on effacerait des lots voisins de ceux qu'on visait.
    for (const i of cibles) etat.lots.splice(i, 1);
    lotsSelectionnes.clear();
    dernierLotCoche = null;
    rafraichirTout();
    return;
  }

  if (el.id === 'btn-vider-lots') {
    if (etat.lots.length && !window.confirm(`Supprimer les ${etat.lots.length} lots du programme ?`)) return;
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
      if (!confirm(`Supprimer ${quoi} « ${nom} » ?`)) return;
    }
    etat[aSupprimer].splice(i, 1);
    rafraichirTout();
    return;
  }

  if (el.id === 'btn-json') {
    $('#contenu-json').textContent = dernierResultat
      ? JSON.stringify(dernierResultat, null, 2)
      : 'Aucun résultat : la saisie est incomplète ou le calcul a échoué.';
    /** @type {HTMLDialogElement} */ (document.getElementById('dialogue-json')).showModal();
  }
  if (el.id === 'btn-fermer-json') {
    /** @type {HTMLDialogElement} */ (document.getElementById('dialogue-json')).close();
  }
});

// ---------------------------------------------------------------- demarrage

appliquerTheme(themeInitial());
// La saisie memorisee se pose AVANT le premier rendu : la reposer apres
// ferait clignoter l'operation de demonstration a chaque ouverture.
const saisieRestauree = restaurerSaisie();
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
// `afficherEcran` retombe seul sur le programme si l'ecran memorise n'existe
// plus - une tranche dont le dernier lot a ete supprime, par exemple.
if (ecranMemorise) afficherEcran(ecranMemorise);
// Dire ce qui est a l'ecran. Une saisie qui reapparait sans un mot laisse
// croire a une operation de demonstration bizarrement remplie.
if (saisieRestauree) {
  const p = document.getElementById('etat-calcul');
  if (p) p.title = 'Saisie restaurée depuis la dernière session';
}
