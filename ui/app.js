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
import { produitsOrdonnes } from '../src/produits.js';
import { arrondirEnConservantLaSomme } from '../src/arrondis.js';

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

// __REFERENTIELS_DEBUT__ (bloc remplace par des litteraux dans la version autonome)
const referentiels = {
  baremes: await (await fetch('../referentiels/baremes_2025.json')).json(),
  trajectoires: await (await fetch('../referentiels/trajectoires_axentia_2026.json')).json(),
  nomenclature_pdr: await (await fetch('../referentiels/nomenclature_pdr.json')).json(),
  zonage_communes: await (await fetch('../referentiels/zonage_communes.json')).json(),
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
  postes_bilan: nomenclatureEnPostes({
    cf_acquisition: { montant_ht_eur: 642780, taux_tva: 0.055 },
    cf_notaire: { montant_ht_eur: 12000, taux_tva: 0.055 },
    hon_architecte: { montant_ht_eur: 18000, taux_tva: 0.2 },
  }),
  // Parametres de loyer PAR TRANCHE : c'est leur niveau naturel, le CS et le
  // plafond ne se calculent qu'a ce niveau.
  loyers_par_produit: {
    PLS: { marge_majoration: 0, marge_locale_eur_m2: 0, loyer_sortie_force: null },
  },
  subventions: [{ libelle: 'Ville', montant_eur: 20000, gratuite: true, affectation: 'PLS' }],
  fonds_propres_par_produit: { PLS: 50000 },
  mode_prets: 'saisis',
  prets: [
    {
      code: 'PLS_CONSTRUCTION', libelle: 'PLS construction', nature: 'construction', produit: 'PLS',
      montant_eur: 494023, taux: 0.0351, progressivite: 0, duree_ans: 40,
      annee_premiere_echeance: 2028, revisabilite: 'SIMPLE', differe_ans: 0, differe_type: 2,
    },
    {
      code: 'PLS_FONCIER', libelle: 'PLS foncier', nature: 'foncier', produit: 'PLS',
      montant_eur: 176035, taux: 0.0351, progressivite: 0, duree_ans: 50,
      annee_premiere_echeance: 2028, revisabilite: 'SIMPLE', differe_ans: 0, differe_type: 2,
    },
  ],
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
    annuite_fonds_propres_eur: null,
    nb_lits: null,
  },
  options: {},
};

// ---------------------------------------------------------------- mise en forme

const fEuro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fNombre = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });

const nul = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
const eur = (v) => (nul(v) ? '—' : fEuro.format(v));
const pct = (v, d = 2) => (nul(v) ? '—' : `${(v * 100).toFixed(d)} %`);
const nb = (v) => (nul(v) ? '—' : fNombre.format(v));

/**
 * Palette des barres emplois/ressources. Elle passe par les tokens de la charte
 * (`--cat-N`, accents d'etat) et non par des hexadecimaux : une couleur ecrite
 * en dur ici resterait celle du theme sombre quand on bascule en clair.
 * Lue au calcul et non a la declaration, pour suivre le theme courant.
 */
const TOKENS_COULEUR = {
  charge_fonciere: '--cat-1',
  batiment: '--cat-3',
  honoraires: '--cat-5',
  frais_divers: '--cat-4',
  modulation: '--cat-6',
  subventions: '--success-accent',
  fonds_propres: '--warning-accent',
  pret_construction: '--info-accent',
  pret_foncier: '--cat-5',
  pret_autre: '--cat-4',
};
const couleur = (cle) =>
  getComputedStyle(document.documentElement).getPropertyValue(TOKENS_COULEUR[cle] ?? '--cat-6').trim() ||
  '#94a3b8';
/** Proxy de compatibilite : `COULEURS.batiment` reste ecrit tel quel dans les vues. */
const COULEURS = new Proxy({}, { get: (_, cle) => couleur(String(cle)) });

/**
 * Identite couleur d'une TRANCHE, stable d'un ecran a l'autre : l'onglet, le
 * bloc, la ligne de pret et la legende d'un meme produit portent la meme teinte.
 * L'ordre canonique des produits fixe l'index, donc la couleur ne bouge pas
 * quand on ajoute une tranche.
 */
const CAT_PAR_PRODUIT = Object.fromEntries(
  produitsOrdonnes().map((p, i) => [p.code, `var(--cat-${(i % 6) + 1})`]),
);
const catProduit = (code) => CAT_PAR_PRODUIT[code] ?? 'var(--cat-6)';

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
  { v: 2, l: "2 — intérêts seuls" },
  { v: 1, l: "1 — rien n'est dû" },
];
const TAUX_TVA = [0.055, 0.1, 0.2, 0];

// ---------------------------------------------------------------- utilitaires

function ecrireChemin(cible, chemin, valeur) {
  const cles = chemin.split('.');
  let ref = cible;
  for (const cle of cles.slice(0, -1)) {
    // Cree les niveaux manquants : `postes_bilan.3.montants_ht_par_produit.PLS`
    // doit pouvoir s'ecrire meme si le dictionnaire de tranches n'existe pas
    // encore. Sans cela la frappe leve au lieu d'ecrire.
    if (ref[cle] === undefined || ref[cle] === null) ref[cle] = {};
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
function zonageDeLaCommune(commune, departement) {
  if (!commune || !departement) return null;
  // Le departement est stocke sous la forme « Nom (code) ». Le code se lit
  // ENTRE PARENTHESES et non par les premiers chiffres rencontres : la Corse
  // s'ecrit 2A et 2B, et « Corse-du-Sud (2A) » donnerait sinon « 2 ».
  const dep = String(departement).match(/\(([0-9AB]{2,3})\)/)?.[1] ?? String(departement).match(/^[0-9AB]{2,3}$/)?.[0];
  if (!dep) return null;
  const nom = String(commune)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return referentiels.zonage_communes.communes[`${dep}-${nom}`] ?? null;
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
  const total = totalPoste(p) ?? 0;
  const parts = arrondirEnConservantLaSomme(
    codes.map((c) => (quotesParts[c] ?? 1 / codes.length) * total),
  );
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
function rendreStructureTranches() {
  const codes = tranchesActives();
  for (const code of codes) {
    etat.loyers_par_produit[code] ??= { marge_majoration: 0, loyer_sortie_force: null };
  }

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
      const prets = etat.prets.map((p, i) => ({ p, i })).filter(({ p }) => (p.produit ?? code) === code);
      const subs = etat.subventions.map((s, i) => ({ s, i })).filter(({ s }) => s.affectation === code);
      return `
      <main class="ecran" id="ecran-tranche-${code}" role="tabpanel" hidden style="--cat:${catProduit(code)}">
        <div class="indicateurs" data-recap-tranche="${code}"></div>

        <div class="colonnes">
          <section class="bloc bloc--tranche">
            <h2 class="bloc__titre">Loyer de la tranche ${att(libelleProduit(code))}</h2>
            <div class="champs champs--serres">
              <label class="champ">
                <span>Majoration (%)</span>
                <input type="number" step="0.1" data-champ="loyers_par_produit.${code}.marge_majoration" data-type="pourcentage" value="${valNum(enPourcent(L.marge_majoration))}" />
              </label>
              <label class="champ">
                <span>Loyer forcé (€/m²/mois)</span>
                <input type="number" step="0.01" min="0" data-champ="loyers_par_produit.${code}.loyer_sortie_force" data-type="nombre" value="${valNum(L.loyer_sortie_force)}" />
              </label>
            </div>
            <div class="table-defilante" style="margin-top:12px">
              <table class="tableau" data-detail-loyer="${code}">
                <tbody></tbody>
              </table>
            </div>
            <p class="aide">
              ⚙ La majoration s'applique au loyer plafond après coefficient de structure
              (R-LOYER-5). La marge locale s'ajoute au barème avant le CS (R-LOYER-1).
              Un loyer forcé court-circuite tout le calcul.
            </p>
          </section>

          <section class="bloc">
            <h2 class="bloc__titre">Fonds propres et subventions</h2>
            <div class="champs champs--serres">
              <label class="champ">
                <span>Fonds propres (€)</span>
                <input type="number" step="1" min="0" data-champ="fonds_propres_par_produit.${code}" data-type="nombre" value="${valNum(etat.fonds_propres_par_produit[code])}" />
              </label>
            </div>
            <div class="table-defilante" style="margin-top:10px">
              <table class="tableau tableau--saisie">
                <thead><tr><th>Subvention</th><th class="num">Montant (€)</th><th class="num">Gratuite</th><th></th></tr></thead>
                <tbody>
                  ${
                    subs.length
                      ? subs
                          .map(
                            ({ s, i }) => `<tr>
                    <td><input type="text" data-champ="subventions.${i}.libelle" value="${att(s.libelle)}" /></td>
                    <td><input type="number" step="1" data-champ="subventions.${i}.montant_eur" data-type="nombre" value="${valNum(s.montant_eur)}" /></td>
                    <td class="num"><input type="checkbox" data-champ="subventions.${i}.gratuite" data-type="booleen" ${s.gratuite ? 'checked' : ''} /></td>
                    <td><button type="button" class="bouton--supprimer" data-supprimer="subventions" data-index="${i}" title="Supprimer">×</button></td>
                  </tr>`,
                          )
                          .join('')
                      : '<tr><td colspan="4" class="vide">Aucune subvention sur cette tranche</td></tr>'
                  }
                </tbody>
              </table>
            </div>
            <button type="button" class="bouton bouton--ajout" data-ajouter-tranche="subventions" data-produit="${code}">+ subvention</button>
            <p class="aide">
              Une subvention gratuite réduit la charge foncière finançable par prêt CDC (R-FIN-2).
            </p>
          </section>
        </div>

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
          </div>
        </section>
      </main>`;
    })
    .join('');
}

/**
 * Prets deplies. Etat purement visuel : il vit ici et non dans `etat`, qui est
 * clone tel quel pour alimenter le moteur et l'export JSON.
 * @type {Set<number>}
 */
const pretsDeplies = new Set();

/** Jeton de metadonnee : etiquette en petites capitales, valeur en clair. */
const jeton = (cle, valeur) =>
  `<span class="jeton"><span class="jeton__cle">${att(cle)}</span><span class="jeton__valeur">${att(valeur)}</span></span>`;

/**
 * Bloc d'un pret, sur le modele des lignes de financement d'ExNihilo : une
 * ligne compacte toujours lisible (libelle, montant, nature, jetons de
 * synthese) et le detail de saisie replie par defaut.
 *
 * Sept champs deplies en permanence pour six prets faisaient quarante-deux
 * cases a l'ecran : on ne voyait plus le plan de financement, seulement des
 * formulaires.
 */
function gabaritPret(p, i) {
  const ouvert = pretsDeplies.has(i);
  const jetons = [
    jeton('taux', nul(p.taux) ? '—' : pct(p.taux, 2)),
    jeton('durée', nul(p.duree_ans) ? '—' : `${p.duree_ans} ans`),
    jeton('1re éch.', valNum(p.annee_premiere_echeance) || '—'),
    jeton('révis.', p.revisabilite ?? '—'),
    ...(p.progressivite ? [jeton('progr.', pct(p.progressivite, 2))] : []),
    ...(p.differe_ans ? [jeton('différé', `${p.differe_ans} ans · type ${p.differe_type ?? 2}`)] : []),
  ].join('');

  return `
    <div class="ligne ligne--pret" style="--cat:${catProduit(p.produit)}">
      <div class="pret__entete">
        <input type="text" class="pret__libelle" data-champ="prets.${i}.libelle" value="${att(p.libelle)}" />
        <input type="number" step="1" min="0" class="pret__montant" data-champ="prets.${i}.montant_eur"
          data-type="nombre" value="${valNum(p.montant_eur)}" />
        <select class="pret__nature" data-champ="prets.${i}.nature">
          ${['construction', 'foncier', 'autre'].map((n) => `<option value="${n}" ${n === p.nature ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
        <button type="button" class="bouton--deplier" data-deplier-pret="${i}"
          aria-expanded="${ouvert}" title="${ouvert ? 'Replier' : 'Déplier'}">${ouvert ? '▴' : '▾'}</button>
        <button type="button" class="bouton--supprimer" data-supprimer="prets" data-index="${i}" title="Supprimer">×</button>
      </div>
      <div class="jetons">${jetons}</div>
      ${
        ouvert
          ? `<div class="pret__detail">
        <div class="champs champs--serres">
          <label class="champ"><span>Taux saisi (%)</span>
            <input type="number" step="0.01" data-champ="prets.${i}.taux" data-type="pourcentage" value="${valNum(enPourcent(p.taux))}" /></label>
          <label class="champ"><span>Durée (ans)</span>
            <input type="number" step="1" min="1" data-champ="prets.${i}.duree_ans" data-type="nombre" value="${valNum(p.duree_ans)}" /></label>
          <label class="champ"><span>1re échéance (année)</span>
            <input type="number" step="1" data-champ="prets.${i}.annee_premiere_echeance" data-type="nombre" value="${valNum(p.annee_premiere_echeance)}" /></label>
          <label class="champ"><span>Révisabilité</span>
            <select data-champ="prets.${i}.revisabilite">
              ${OPTIONS_REVISABILITE.map((v) => `<option value="${v}" ${v === p.revisabilite ? 'selected' : ''}>${v}</option>`).join('')}
            </select></label>
          <label class="champ"><span>Progressivité (%)</span>
            <input type="number" step="0.1" data-champ="prets.${i}.progressivite" data-type="pourcentage" value="${valNum(enPourcent(p.progressivite))}" /></label>
          <label class="champ"><span>Différé (ans)</span>
            <input type="number" step="1" min="0" data-champ="prets.${i}.differe_ans" data-type="nombre" value="${valNum(p.differe_ans)}" /></label>
          <label class="champ"><span>Type de différé</span>
            <select data-champ="prets.${i}.differe_type" data-type="nombre">
              ${OPTIONS_DIFFERE.map((o) => `<option value="${o.v}" ${o.v === p.differe_type ? 'selected' : ''}>${o.l}</option>`).join('')}
            </select></label>
        </div>
      </div>`
          : ''
      }
    </div>`;
}

/**
 * Q-16 — Table des cotisations et charges diverses. Le catalogue vient du
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
        <td class="cellule-valeur"><input type="number" step="${taux ? '0.001' : '1'}" min="0"
          data-champ="exploitation.charges_diverses.${i}.valeur"
          data-type="${taux ? 'pourcentage' : 'nombre'}"
          value="${valNum(taux ? enPourcent(v) : v)}" ${c.actif ? '' : 'disabled'} />
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
 * Les deux selects restent presents dans les deux cas — le zonage doit toujours
 * etre lisible et corrigeable — mais l'ecran DIT d'ou vient la valeur. Un champ
 * prerempli sans provenance laisse croire a une saisie de l'utilisateur.
 */
function rendreZonage() {
  const aide = document.getElementById('aide-zonage');
  if (!aide) return;
  const z = zonageDeLaCommune(etat.identite.commune, etat.identite.departement);

  if (z) {
    // On ne touche QUE les deux selects de zone. Repasser par
    // `rendreChampsStatiques` reecrirait la valeur du champ commune pendant
    // qu'on le saisit, au risque de deplacer le curseur a chaque frappe.
    const poser = (chemin, valeur) => {
      if (etat.identite[chemin] === valeur) return;
      etat.identite[chemin] = valeur;
      const el = /** @type {HTMLSelectElement} */ (document.querySelector(`[data-champ="identite.${chemin}"]`));
      if (el) el.value = String(valeur);
    };
    poser('zone_123', z.zone_123);
    poser('zone_ABC', z.zone_ABC);
    aide.textContent =
      `⚙ Zonage déduit de ${z.nom} (${z.departement}) : zone ${z.zone_123} et zone ${z.zone_ABC}. ` +
      `Source : ${z.source}. Corriger les listes si l'arrêté a changé.`;
    return;
  }

  const connues = Object.keys(referentiels.zonage_communes.communes).length;
  aide.textContent = etat.identite.commune
    ? `⚙ ${etat.identite.commune} n'est pas au référentiel de zonage (${connues} communes attestées) : ` +
      'les deux zones restent à saisir. Le zonage commande le loyer plafond, il n’est pas deviné ' +
      'depuis le département — deux communes voisines peuvent relever de zones différentes.'
    : '⚙ Renseigner commune et département pour que le zonage se déduise, quand la commune est ' +
      'au référentiel. Chaque tranche lit ensuite celui qui la concerne : 1/2/3 pour PLUS et PLAI, ' +
      'A/B/C pour PLS.';
}

/**
 * Q-27 — Bloc foyer. Deux regimes, et ils ne se saisissent pas pareil :
 *  - FORFAITAIRE : un montant negocie et son annee de valeur ;
 *  - TRANSPARENCE : rien a saisir, la redevance EST la somme des charges.
 * Afficher un champ « redevance » en transparence laisserait croire qu'il agit.
 */
function rendreBlocRedevance() {
  const e = etat.exploitation;
  const foyer = e.mode === 'redevance';
  const champs = document.getElementById('champs-redevance');
  const bascule = document.getElementById('bascule-redevance');
  if (!champs) return;

  champs.hidden = !foyer;
  if (bascule) bascule.hidden = !foyer;
  for (const b of document.querySelectorAll('[data-mode-redevance]')) {
    b.setAttribute(
      'aria-pressed',
      String(/** @type {HTMLElement} */ (b).dataset.modeRedevance === (e.mode_redevance ?? 'forfaitaire')),
    );
  }
  for (const el of champs.querySelectorAll('[data-si-redevance]')) {
    /** @type {HTMLElement} */ (el).hidden =
      /** @type {HTMLElement} */ (el).dataset.siRedevance !== (e.mode_redevance ?? 'forfaitaire');
  }

  const aide = document.getElementById('aide-redevance');
  if (aide) {
    aide.textContent =
      (e.mode_redevance ?? 'forfaitaire') === 'transparence'
        ? '⚙ En transparence, le bailleur refacture ses frais : la redevance vaut la somme des ' +
          'charges de l’exercice (annuités d’emprunt et de fonds propres, gros entretien, gestion, ' +
          'taxe foncière, assurances). Elle suit chaque rupture de charges, et les cotisations ' +
          'assises sur la redevance sont refacturées elles aussi. Le résultat est nul, sauf si un ' +
          'taux de vacance vient retrancher une part de la redevance sans réduire les charges.'
        : '⚙ En forfaitaire, la redevance est un montant négocié, indexé depuis son année de valeur. ' +
          'Elle ne suit pas les charges : vérifié sur l’annexe Orléans, où aucune rupture de charges ' +
          'ne laisse de trace sur 60 ans.';
  }
}

function rendreStructure() {
  // --- Programme : une ligne par LOT ---
  const optionsProduit = (selection) =>
    produitsOrdonnes()
      .map((p) => `<option value="${p.code}" ${p.code === selection ? 'selected' : ''} ${p.v1 ? '' : 'disabled'}>${p.libelle}</option>`)
      .join('');

  $('#table-lots').querySelector('tbody').innerHTML = etat.lots.length
    ? etat.lots
        .map(
          (lot, i) => `<tr data-lot="${i}">
        <td class="num num-poste">${i + 1}</td>
        <td><input type="text" data-champ="lots.${i}.batiment" value="${att(lot.batiment)}" /></td>
        <td><input type="text" data-champ="lots.${i}.etage" value="${att(lot.etage)}" /></td>
        <td><select data-champ="lots.${i}.typologie">
          <option value=""></option>
          ${TYPOLOGIES.map((t) => `<option value="${t}" ${t === lot.typologie ? 'selected' : ''}>${t}</option>`).join('')}
        </select></td>
        <td><select data-champ="lots.${i}.code_produit" data-structure="1">${optionsProduit(lot.code_produit)}</select></td>
        <td><input type="number" step="0.01" min="0" data-champ="lots.${i}.shab_m2" data-type="nombre" value="${valNum(lot.shab_m2)}" /></td>
        <td><input type="number" step="0.01" min="0" data-champ="lots.${i}.surfaces_annexes_m2" data-type="nombre" value="${valNum(lot.surfaces_annexes_m2)}" /></td>
        <td class="calc" data-calc="su"></td>
        <td class="calc" data-calc="loyer"></td>
        <td><button type="button" class="bouton--supprimer" data-supprimer="lots" data-index="${i}" title="Supprimer">×</button></td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="10" class="vide">Aucun lot. Utiliser le générateur ci-dessus ou « + lot ».</td></tr>';

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
 * R-TVA-3 — Table du prix de revient : un total qui se ventile, et une colonne
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
  const groupes = codes
    .map(
      (c) =>
        `<th class="col-groupe" colspan="${tva ? 2 : 1}" style="--cat:${catProduit(c)}">` +
        `<span class="col-groupe__puce"></span>${att(libelleProduit(c))}</th>`,
    )
    .join('');
  const sousColonnes = codes
    .map(
      (c) =>
        `<th class="num col-tranche col-tranche--debut" style="--cat:${catProduit(c)}">HT (€)</th>` +
        (tva ? `<th class="num col-tranche" style="--cat:${catProduit(c)}">TVA</th>` : ''),
    )
    .join('');

  const fixes = [
    ['num', 'N°'],
    ['', 'Poste'],
    ['num', 'Total HT (€)'],
    ['', ''],
    ...(tva ? [['num', 'TVA']] : []),
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
    4 + (tva ? 1 : 0) + (parTranche ? codes.length * (tva ? 2 : 1) : 0) + 2;

  // Le bouton « ventiler tout » n'a de sens qu'a partir de deux tranches, et son
  // libelle dit ce qu'il va faire, pas l'etat courant.
  const btnTout = /** @type {HTMLButtonElement} */ (document.getElementById('btn-ventiler-tout'));
  if (btnTout) {
    const remplies = etat.postes_bilan.filter((p) => !nul(totalPoste(p)));
    const toutVentile = remplies.length > 0 && remplies.every(estVentile);
    btnTout.hidden = !parTranche;
    btnTout.textContent = toutVentile ? '↤ Tout regrouper' : '⇥ Ventiler tout';
    btnTout.dataset.action = toutVentile ? 'regrouper' : 'ventiler';
  }

  // --- Corps, groupe par chapitre ---
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
      `<tr class="chapitre-entete"><td colspan="${nbCols}">${ch.numero} — ${att(ch.libelle)}</td></tr>`,
    );

    for (const { p, i } of visibles) {
      const ventile = estVentile(p);
      const vide = nul(totalPoste(p));

      // Total : saisissable tant que la ligne n'est pas ventilee, calcule ensuite.
      // Deux verites pour la meme grandeur, ce serait une de trop.
      const celluleTotal = ventile
        ? `<td class="num calc" data-calc="total" title="Somme des tranches">—</td>`
        : `<td><input type="number" step="1" data-champ="postes_bilan.${i}.montant_ht_eur"
             data-type="nombre" value="${valNum(p.montant_ht_eur)}" /></td>`;

      const selectTVA = (chemin, valeur) =>
        `<select data-champ="${chemin}" data-type="nombre">
          ${TAUX_TVA.map((v) => `<option value="${v}" ${v === valeur ? 'selected' : ''}>${(v * 100).toFixed(1)} %</option>`).join('')}
        </select>`;

      const cellulesTranches = parTranche
        ? codes
            .map((c) => {
              const style = `style="--cat:${catProduit(c)}"`;
              // `--debut` porte le filet colore : il ouvre le bloc de la
              // tranche, il ne separe pas HT de sa TVA.
              const deb = 'col-tranche col-tranche--debut';
              if (!ventile) {
                // Ligne non ventilee : on montre ce que la cle SU donnerait,
                // en lecture seule. C'est un apercu, pas une saisie.
                return (
                  `<td class="num calc ${deb}" ${style} data-apercu="${c}"></td>` +
                  (tva ? `<td class="num calc col-tranche" ${style}></td>` : '')
                );
              }
              return (
                `<td class="${deb}" ${style}><input type="number" step="1"
                   data-champ="postes_bilan.${i}.montants_ht_par_produit.${c}" data-type="nombre"
                   value="${valNum(p.montants_ht_par_produit?.[c])}" /></td>` +
                (tva
                  ? `<td class="col-tranche" ${style}>${selectTVA(
                      `postes_bilan.${i}.taux_tva_par_produit.${c}`,
                      p.taux_tva_par_produit?.[c] ?? p.taux_tva,
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
        ${tva ? `<td>${ventile ? '' : selectTVA(`postes_bilan.${i}.taux_tva`, p.taux_tva)}</td>` : ''}
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
              `<td class="num col-tranche col-tranche--debut" style="--cat:${catProduit(c)}" data-sous-total="${c}" data-cle="ht_eur"></td>` +
              (tva
                ? `<td class="num col-tranche" style="--cat:${catProduit(c)}" data-sous-total="${c}" data-cle="tva_eur"></td>`
                : ''),
          )
          .join('')
      : '';
    lignes.push(
      `<tr class="chapitre-total" data-chapitre-total="${ch.code}">
        <td></td><td class="libelle">Sous-total ${att(ch.libelle.toLowerCase())}</td>
        <td class="num" data-total="ht"></td>
        <td></td>
        ${tva ? '<td></td>' : ''}
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
    set('su', lot ? nb(lot.su_m2) : '—');
    set('loyer', lot && c ? eur(lot.su_m2 * c.loyer_pratique_eur_m2) : '—');
  }
  $('#table-lots').querySelector('tfoot').innerHTML = etat.lots.length
    ? `<tr>
        <td colspan="5" class="libelle">Total — ${nb(ind.nb_logements)} logements</td>
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
    { l: 'Tranches', v: r.surfaces.tranches.length, d: r.surfaces.tranches.map(libelleProduit).join(', ') || '—' },
    { l: 'Surface utile', v: `${nb(ind.su_m2)} m²`, d: `${nb(ind.shab_m2)} m² SHAB` },
    { l: 'Prix de revient', v: eur(ind.prix_revient_ttc_eur), d: `${eur(ind.prix_revient_par_logement_eur)} / logement` },
    { l: 'Loyers annuels', v: eur(ind.loyers_annuels_eur), d: `RMO ${pct(ind.rmo)}` },
    { l: 'Mise en location', v: r.calendrier.annee_mise_en_location, d: `${etat.dates.duree_simulation_ans} ans simulés` },
  ]
    .map((i) => `<div class="indicateur"><div class="indicateur__libelle">${i.l}</div>
      <div class="indicateur__valeur">${i.v}</div><div class="indicateur__detail">${i.d}</div></div>`)
    .join('');

  // --- Ecrans de tranche : bandeau et detail du loyer ---
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
      bandeau.innerHTML = [
        tuile('Programme', `${nb(t.nb_logements)} lgts`, `${nb(t.su_m2)} m² SU · ${pct(t.quote_part_su, 1)} de l’opération`),
        tuile('Loyer de sortie', l ? `${nb(l.loyer_pratique_eur_m2)} €` : '—', 'par m² SU et par mois'),
        tuile('Loyer annuel', l ? eur(l.loyer_annuel_eur) : '—', `coefficient de structure ${l ? nb(l.cs) : '—'}`),
        tuile('Prix de revient', eur(t.prix_revient_ttc_eur), 'TTC / LASM de la tranche'),
        tuile('Ressources', eur(ressources), `${eur(totalPrets)} de prêts · ${eur(t.subventions_eur)} de subventions`),
        tuile(
          reste > 0 ? 'Reste à financer' : 'Financement',
          reste > 0 ? eur(reste) : 'couvert',
          reste > 0 ? 'ressources inférieures au prix de revient' : `${eur(t.fonds_propres_eur)} de fonds propres`,
        ),
      ].join('');
    }
    const detail = document.querySelector(`[data-detail-loyer="${code}"] tbody`);
    if (detail && l) {
      detail.innerHTML = [
        ['Barème de zone + marge locale', `${nb(l.loyer_base_eur_m2)} €/m²/mois`],
        ['Coefficient de structure', nb(l.cs)],
        ['Loyer plafond (barème × CS)', `${nb(l.loyer_max_base_eur_m2)} €/m²/mois`],
        [l.force ? 'Loyer forcé appliqué' : 'Loyer de sortie (plafond × majoration)', `${nb(l.loyer_pratique_eur_m2)} €/m²/mois`],
        ['Loyer annuel de la tranche', eur(l.loyer_annuel_eur)],
      ]
        .map(([k, v]) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`)
        .join('');
    }
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
  const totauxTranches = parTr
    ? codesTr
        .map(
          (c) =>
            `<td class="num col-tranche col-tranche--debut" style="--cat:${catProduit(c)}">${eur(b.par_tranche?.[c]?.total_ht_eur)}</td>` +
            (tvaVisible ? `<td class="num col-tranche" style="--cat:${catProduit(c)}">${eur(b.par_tranche?.[c]?.total_tva_eur)}</td>` : ''),
        )
        .join('')
    : '';

  $('#table-postes').querySelector('tfoot').innerHTML = `<tr>
      <td></td><td class="libelle">Prix de revient total</td>
      <td class="num">${eur(b.total_ht_eur)}</td><td></td>
      ${tvaVisible ? '<td></td>' : ''}
      ${totauxTranches}
      <td class="num">${eur(b.total_tva_eur)}</td>
      <td class="num">${eur(b.total_ttc_eur)}</td>
    </tr>
    <tr>
      <td></td><td class="libelle">Base finançable (TTC / LASM)</td>
      <td colspan="${nbCols - 3}"></td>
      <td class="num">${eur(b.total_ttc_module_eur)}</td>
    </tr>
    <tr>
      <td></td><td colspan="${nbCols - 1}" style="font-weight:400;color:var(--text-tertiary);border-top:none">
        ${renseignes} poste${renseignes > 1 ? 's' : ''} renseigné${renseignes > 1 ? 's' : ''}
        sur ${etat.postes_bilan.length} de la nomenclature${
          ventiles ? ` · ${ventiles} ventilé${ventiles > 1 ? 's' : ''} à la main` : ''
        }
      </td>
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

function rendreFinancement(r) {
  const ind = r.indicateurs;
  const eq = r.financement.equilibre;

  const emplois = Object.entries(r.bilan.chapitres).map(([code, c]) => ({
    libelle: CHAPITRES[code] ?? code,
    montant: c.ttc_lasm_eur,
    ht: c.ht_eur,
    couleur: COULEURS[code] ?? COULEURS.frais_divers,
  }));
  if (r.bilan.modulation_ttc_eur) {
    emplois.push({ libelle: 'Modulation', montant: r.bilan.modulation_ttc_eur, ht: null, couleur: COULEURS.modulation });
  }

  const ressources = [];
  if (ind.subventions_eur) ressources.push({ libelle: 'Subventions', montant: ind.subventions_eur, couleur: COULEURS.subventions });
  if (ind.fonds_propres_eur) ressources.push({ libelle: 'Fonds propres', montant: ind.fonds_propres_eur, couleur: COULEURS.fonds_propres });
  for (const a of r.amortissements) {
    ressources.push({
      libelle: a.libelle || a.code,
      montant: a.montant_eur,
      couleur: COULEURS[`pret_${a.nature}`] ?? COULEURS.pret_autre,
    });
  }

  // Les totaux viennent du moteur ; l'echelle des barres, elle, est un choix de
  // presentation et peut se deduire des segments.
  const totalEmplois = ind.prix_revient_ttc_eur;
  const totalRessources = ind.ressources_eur;
  const echelle = Math.max(totalEmplois, totalRessources, 1);

  rendreBarre($('#barre-emplois'), emplois, echelle);
  rendreBarre($('#barre-ressources'), ressources, echelle);
  $('#total-emplois').textContent = eur(totalEmplois);
  $('#total-ressources').textContent = eur(totalRessources);
  $('#legende').innerHTML = [...emplois, ...ressources]
    .filter((s) => s.montant > 0)
    .map(
      (s) => `<div class="legende__item"><span class="legende__puce" style="background:${s.couleur}"></span>
        <span>${att(s.libelle)}</span><span class="legende__montant">${eur(s.montant)}</span></div>`,
    )
    .join('');

  const part = (m, t) => (t ? pct(m / t, 1) : '—');

  const tE = $('#table-emplois');
  tE.querySelector('tbody').innerHTML = emplois
    .map((e) => `<tr><td>${att(e.libelle)}</td><td class="num">${eur(e.ht)}</td>
      <td class="num">${eur(e.montant)}</td><td class="num">${part(e.montant, totalEmplois)}</td></tr>`)
    .join('');
  tE.querySelector('tfoot').innerHTML = `<tr>
      <td class="libelle">Total</td><td class="num">${eur(r.bilan.total_ht_eur)}</td>
      <td class="num">${eur(totalEmplois)}</td><td class="num">100 %</td></tr>
    <tr><td colspan="4" style="font-weight:400;color:var(--encre-doux);border-top:none">
      ${eur(ind.prix_revient_par_logement_eur)} / logement · ${eur(ind.prix_revient_par_m2_shab_eur)} / m² SHAB</td></tr>`;

  const tR = $('#table-ressources');
  tR.querySelector('tbody').innerHTML = ressources
    .map((s) => `<tr><td>${att(s.libelle)}</td><td class="num">${eur(s.montant)}</td>
      <td class="num">${part(s.montant, totalRessources)}</td></tr>`)
    .join('');
  tR.querySelector('tfoot').innerHTML = `<tr>
      <td class="libelle">Total ressources</td><td class="num">${eur(totalRessources)}</td><td class="num">100 %</td></tr>
    <tr><td class="libelle">Restant à couvrir par prêt CDC</td>
      <td class="num">${eur(r.financement.solde_a_financer_eur)}</td>
      <td class="num" style="font-weight:400;color:var(--encre-doux)">hors prêts CDC</td></tr>`;

  const corps = $('#table-prets').querySelector('tbody');
  const pied = $('#table-prets').querySelector('tfoot');
  if (!r.amortissements.length) {
    corps.innerHTML = '<tr><td colspan="9" class="vide">Aucun prêt mobilisé</td></tr>';
    pied.innerHTML = '';
  } else {
    corps.innerHTML = r.amortissements
      .map((a) => {
        const t = a.tableau;
        const total = t.reduce((s, l) => s + l.annuite_eur, 0);
        return `<tr>
          <td>${att(a.libelle)}</td><td class="num">${eur(a.montant_eur)}</td>
          <td class="num">${nul(a.taux_saisi) ? '—' : pct(a.taux_saisi)}</td>
          <td class="num">${pct(t[0].taux)}</td><td class="num">${t.length} ans</td>
          <td class="num">${t[0].annee}</td><td class="num">${eur(t[0].annuite_eur)}</td>
          <td class="num">${eur(t.at(-1).annuite_eur)}</td><td class="num">${eur(total)}</td>
        </tr>`;
      })
      .join('');
    pied.innerHTML = `<tr><td class="libelle">Total</td>
      <td class="num">${eur(r.financement.total_prets_eur)}</td><td colspan="7"></td></tr>`;
  }

  const ecarts = r.amortissements.filter((a) => !nul(a.taux_saisi) && Math.abs(a.tableau[0].taux - a.taux_saisi) > 1e-9);
  $('#aide-taux').textContent = ecarts.length
    ? `⚙ Le taux appliqué diffère du taux saisi : la révision Livret A joue dès la première ` +
      `échéance. Profil ${r.profil_trajectoires ?? 'non renseigné'}.`
    : '';

  $('#indicateurs').innerHTML = [
    { l: 'Prix de revient', v: eur(ind.prix_revient_ttc_eur), d: `${eur(ind.prix_revient_par_logement_eur)} / logement` },
    { l: 'Coût au m² SHAB', v: eur(ind.prix_revient_par_m2_shab_eur), d: `${nb(ind.shab_m2)} m² SHAB` },
    { l: 'Surface utile', v: `${nb(ind.su_m2)} m²`, d: `${nb(ind.nb_logements)} logements` },
    { l: 'Loyers annuels', v: eur(ind.loyers_annuels_eur), d: `RMO ${pct(ind.rmo)}` },
    { l: 'Fonds propres', v: pct(ind.taux_fonds_propres), d: eur(ind.fonds_propres_eur) },
    { l: 'Prêts CDC', v: pct(eq.ratio_prets_cdc), d: eur(r.financement.total_prets_cdc_eur) },
    {
      l: 'Reconstitution FP',
      v: ind.annee_reconstitution_fonds_propres ?? 'non atteinte',
      d: 'cumul d’autofinancement ≥ fonds propres',
    },
    { l: 'Début TFPB', v: ind.annee_debut_tfpb, d: 'fin d’exonération' },
  ]
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

function rendreCalendrier(r) {
  const c = r.calendrier;
  $('#date-mel').value = c?.date_mise_en_location ?? '';
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
    '#barre-emplois', '#barre-ressources', '#legende', '#indicateurs', '#controles',
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
  $('#total-emplois').textContent = '—';
  $('#total-ressources').textContent = '—';
  for (const id of ['#table-emplois', '#table-ressources', '#table-prets']) {
    $(id).querySelector('tbody').innerHTML = '';
    $(id).querySelector('tfoot').innerHTML = '';
  }
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
  const marge = { haut: 16, bas: 34, gauche: 8, droite: 8 };
  const largeurTrace = L - marge.gauche - marge.droite;
  const hauteurTrace = H - marge.haut - marge.bas;

  const resultats = lignes.map((l) => l.resultat_eur);
  const cumuls = lignes.map((l) => l.cumul_eur);
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
      const y1 = yRes(l.resultat_eur);
      const haut = Math.max(1, Math.abs(y1 - y0));
      const classe = l.resultat_eur < 0 ? 'negatif' : 'positif';
      return `<rect class="graphe__barre--${classe}" x="${(xCentre(i) - largeurBarre / 2).toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${largeurBarre.toFixed(1)}" height="${haut.toFixed(1)}"><title>${l.annee} : résultat ${eur(l.resultat_eur)}, cumul ${eur(l.cumul_eur)}</title></rect>`;
    })
    .join('');

  const trace = lignes.map((l, i) => `${xCentre(i).toFixed(1)},${yCum(l.cumul_eur).toFixed(1)}`).join(' ');

  const reperes = evenements
    .map((e) => {
      const i = lignes.findIndex((l) => l.annee === e.annee);
      if (i < 0) return '';
      const x = xCentre(i).toFixed(1);
      return `<line class="graphe__repere" x1="${x}" y1="${marge.haut}" x2="${x}" y2="${marge.haut + hauteurTrace}" />
        <text class="graphe__texte graphe__texte--repere" x="${x}" y="${marge.haut - 4}" text-anchor="middle">${att(e.annee)}</text>`;
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
    cel.textContent = d ? eur(d.montant_eur) : '—';
  }

  // --- Tuiles ---
  $('#tuiles-exploitation').innerHTML = [
    {
      l: 'Résultat cumulé en fin de simulation',
      v: eur(ind.resultat_cumule_final_eur),
      d: `sur ${e.lignes.length} ans`,
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
  $('#aide-graphe').textContent = e.evenements.length
    ? `⚙ Repères verticaux : ${e.evenements.map((x) => `${x.annee} ${x.libelle.toLowerCase()}`).join(' · ')}.`
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
          evenements: e.evenements.filter((x) => x.annee === l.annee).map((x) => x.libelle),
        }));

  const montant = (v) => `<td class="num ${v < 0 ? 'montant--negatif' : ''}">${eur(v)}</td>`;
  $('#table-exploitation').querySelector('tbody').innerHTML = rangs
    .map((j) => {
      const autresCharges = j.total_charges_eur - j.annuites_eur;
      const marques = (j.evenements ?? []).map((x) => `<span class="evenement">${att(x)}</span>`).join('');
      const classe = j.type === 'moyenne' ? 'ligne--moyenne' : marques ? 'ligne--rupture' : '';
      return `<tr class="${classe}">
        <td>${att(j.libelle)}${marques}</td>
        ${montant(j.total_produits_eur)}${montant(j.annuites_eur)}${montant(autresCharges)}
        ${montant(j.resultat_eur)}${montant(j.cumul_eur)}
        <td class="num">${pct(j.taux_marge, 1)}</td>
      </tr>`;
    })
    .join('');

  const t = e.totaux;
  $('#table-exploitation').querySelector('tfoot').innerHTML = `<tr>
      <td class="libelle">Cumul sur ${e.lignes.length} ans</td>
      ${montant(t.produits_eur)}${montant(t.annuites_eur)}
      ${montant(t.charges_eur - t.annuites_eur)}${montant(t.resultat_eur)}
      <td colspan="2"></td></tr>`;

  $('#aide-exploitation').textContent =
    vueExploitation === 'jalons'
      ? `⚙ Les années de rupture et les premières années sont détaillées, les périodes intermédiaires ` +
        `sont présentées en moyenne annuelle. Basculer sur « Année par année » pour le détail complet.`
      : `⚙ ${e.lignes.length} exercices, de ${e.lignes[0]?.annee} à ${e.lignes.at(-1)?.annee}. ` +
        `La dernière année porte une marge exceptionnelle : les prêts y sont soldés.`;

  $('#postes-absents').innerHTML = e.postes_absents.map((p) => `<li>${att(p)}</li>`).join('');
}

// ---------------------------------------------------------------- ecran parametres

function rendreParametres() {
  const b = referentiels.baremes;
  const t = referentiels.trajectoires;

  $('#bandeau-parametres').innerHTML =
    `<span class="bandeau__principal">Lecture seule</span>` +
    `<span class="bandeau__detail">Barèmes ${b.date_valeur} · profil ${att(t.profil)}. ` +
    `Ces valeurs sont versionnées dans le dépôt : les modifier ici rendrait les simulations non reproductibles.</span>`;

  const tableau = (titre, source, entetes, lignes) => `
    <section class="bloc para-groupe">
      <h3>${titre}</h3>
      ${source ? `<p class="para-source">${att(source)}</p>` : ''}
      <div class="table-defilante"><table class="tableau">
        <thead><tr>${entetes.map((e, i) => `<th ${i ? 'class="num"' : ''}>${e}</th>`).join('')}</tr></thead>
        <tbody>${lignes.map((l) => `<tr>${l.map((c, i) => `<td ${i ? 'class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </section>`;

  const lm123 = b.loyers_max_zone_123;
  const lmABC = b.loyers_max_zone_ABC;
  const cs = b.constantes_reglementaires.coefficient_structure;

  $('#contenu-parametres').innerHTML = [
    tableau('Loyers plafonds par zone 1/2/3 (€/m² SU/mois)', lm123.source, ['Produit', ...lm123.zones],
      ['PLUS', 'PLAI', 'LIBRE'].map((p) => [p, ...lm123[p].map((v) => nb(v))])),
    tableau('Loyers plafonds par zone A/B/C (€/m² SU/mois)', lmABC.source, ['Produit', ...lmABC.zones],
      ['PLS', 'PLI'].map((p) => [p, ...lmABC[p].map((v) => nb(v))])),
    tableau('Prêts CDC par défaut', 'R-AMT-1 ; spreads confirmés par la maquette LEON REWORK (ADMIN!C43:C46)',
      ['Produit', 'Nature', 'Taux', 'Durée', 'Révisabilité'],
      produitsOrdonnes().flatMap((p) => p.prets_defaut.map((d) => [p.libelle, d.nature, d.taux_ref, d.duree_ref, d.revisabilite]))),
    tableau('Taux de livraison à soi-même', b.tva.source, ['Clé', 'Taux'],
      Object.entries(b.tva.lasm_par_produit).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, pct(v, 1)])),
    // La variante DOM n'est plus implementee (hors perimetre) : elle ne figure
    // donc plus ici. N'afficher que des parametres reellement lus par le moteur.
    tableau('Coefficient de structure', cs.source, ['Cas', 'Base', 'Facteur logements'], [
      ['Métropole habitat', nb(cs.metropole_habitat.base), nb(cs.metropole_habitat.facteur_nl)],
      ['Foyers', nb(cs.metropole_habitat.base), nb(cs.foyers.facteur_nl)],
    ]),
    tableau('Trajectoires macro',
      `${t.source} — ${t.trajectoires.length} années, de ${t.trajectoires[0].annee} à ${t.trajectoires.at(-1).annee}. ` +
        `Au-delà, la dernière valeur connue est reconduite.`,
      ['Année', 'Loyers / IRL', 'Gros entretien', 'Gestion', 'TFPB', 'Livret A'],
      t.trajectoires.slice(0, 15).map((l) => [l.annee, pct(l.loyers_irl), pct(l.gros_entretien), pct(l.gestion), pct(l.tfpb), pct(l.livret_a)])),
  ].join('');
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
      if (nul(p.taux)) m.push(`taux du ${nom}`);
      if (nul(p.duree_ans)) m.push(`durée du ${nom}`);
      if (nul(p.montant_eur)) m.push(`montant du ${nom}`);
    });
  }
  return m;
}

function recalculer() {
  const pastille = $('#etat-calcul');
  const erreur = $('#erreur');

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
    if (etat.mode_prets === 'theoriques') entrees.prets = [];
    // Un poste sans montant vaut « non utilise » : il ne doit pas entrer dans le
    // bilan, sinon la nomenclature entiere y figurerait a zero.
    entrees.postes_bilan = entrees.postes_bilan.filter((p) => !nul(p.montant_ht_eur));
    const r = calculer(entrees, referentiels);
    dernierResultat = r;
    erreur.hidden = true;
    $('#version-moteur').textContent = `v${r.version_moteur}`;
    rendreCalendrier(r);
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
}

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
  if (vise === 'parametres') rendreParametres();
}

/**
 * Theme clair ou sombre. Le sombre est celui de l'application ; le clair sert a
 * l'impression et a la videoprojection, ou un fond noir passe mal.
 * Persiste dans localStorage quand il est disponible — la version autonome
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

// ---------------------------------------------------------------- evenements

document.addEventListener('input', (ev) => {
  const el = /** @type {HTMLInputElement} */ (ev.target);
  const chemin = el.dataset?.champ;
  if (!chemin) return;

  let valeur;
  if (el.dataset.type === 'nombre' || el.dataset.type === 'pourcentage') {
    // Un champ `number` en cours de frappe (« 40. » avant la decimale) expose une
    // valeur VIDE et signale `badInput`. Sans cette distinction, la frappe serait
    // interpretee comme un effacement et le chiffre deja saisi serait perdu.
    if (el.validity?.badInput) return;
    // Un champ reellement vide reste vide : il ne devient jamais zero silencieusement.
    if (el.value === '') valeur = null;
    else {
      const n = Number(el.value);
      if (Number.isNaN(n)) return;
      valeur = el.dataset.type === 'pourcentage' ? n / 100 : n;
    }
  } else if (el.dataset.type === 'mode-redevance') {
    valeur = el.checked ? 'redevance' : 'loyers';
  } else if (el.dataset.type === 'booleen') {
    valeur = el.checked;
  } else {
    valeur = el.value === '' ? null : el.value;
  }

  ecrireChemin(etat, chemin, valeur);

  // Un changement de produit ou de chapitre reordonne la restitution : on
  // reconstruit. Sinon on ne met a jour que les valeurs, ce qui preserve le focus.
  if (el.dataset.structure) rafraichirTout();
  else recalculer();
});

document.addEventListener('change', (ev) => {
  // L'interrupteur de masquage change la STRUCTURE de la table, pas l'etat.
  const id = /** @type {HTMLElement} */ (ev.target).id;
  if (id === 'afficher-tva') tvaVisible = /** @type {HTMLInputElement} */ (ev.target).checked;
  if (id === 'masquer-vides' || id === 'afficher-tva') rafraichirTout();
});

document.addEventListener('click', (ev) => {
  const el = /** @type {HTMLElement} */ (ev.target);

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

  const modeRedev = el.closest('[data-mode-redevance]');
  if (modeRedev) {
    etat.exploitation.mode_redevance = /** @type {HTMLElement} */ (modeRedev).dataset.modeRedevance;
    rafraichirTout();
    return;
  }

  const ventiler = el.closest('[data-ventiler]');
  if (ventiler) {
    const i = Number(/** @type {HTMLElement} */ (ventiler).dataset.ventiler);
    const p = etat.postes_bilan[i];
    basculerVentilation(p, !estVentile(p), dernierResultat?.surfaces?.quotes_parts ?? {});
    rafraichirTout();
    return;
  }

  if (el.closest('#btn-ventiler-tout')) {
    const vers = /** @type {HTMLElement} */ (el.closest('#btn-ventiler-tout')).dataset.action === 'ventiler';
    const qp = dernierResultat?.surfaces?.quotes_parts ?? {};
    // Seules les lignes RENSEIGNEES sont touchees : ventiler les quarante-six
    // postes de la nomenclature remplirait la table de zeros.
    for (const p of etat.postes_bilan) {
      if (nul(totalPoste(p))) continue;
      if (estVentile(p) !== vers) basculerVentilation(p, vers, qp);
    }
    rafraichirTout();
    return;
  }

  const deplier = el.closest('[data-deplier-pret]');
  if (deplier) {
    const i = Number(/** @type {HTMLElement} */ (deplier).dataset.depliePret ?? /** @type {HTMLElement} */ (deplier).dataset.deplierPret);
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
      etat.subventions.push({ libelle: 'Nouvelle subvention', montant_eur: 0, gratuite: false, affectation: produit });
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
    etat[aSupprimer].splice(Number(el.dataset.index), 1);
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
rendreChampsStatiques();
rafraichirTout();
