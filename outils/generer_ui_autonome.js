// @ts-check
/**
 * Genere `ui/simulation-autonome.html` : un fichier UNIQUE, ouvrable par simple
 * double-clic, sans node, sans serveur et sans connexion.
 *
 *   node outils/generer_ui_autonome.js
 *
 * Pourquoi ce fichier existe : les modules ESM et `fetch` sont bloques par la
 * politique d'origine des navigateurs sur `file://`. La version servee (npm run
 * ui) importe `src/moteur.js` tel quel ; la version autonome en inline une copie
 * pour les postes ou node n'est pas lançable.
 *
 * Ce n'est PAS une etape de build du moteur (CLAUDE.md §3 : aucun build) : le
 * moteur reste du JS ESM lisible et testable tel quel. C'est un artefact de
 * DISTRIBUTION, regenere a la demande, et marque comme genere.
 *
 * Le fichier produit EST versionne, contrairement a l'usage pour un artefact
 * genere : le poste cible ne peut pas lancer node, donc ne peut pas le
 * regenerer. Il doit donc etre livre tel quel par le depot. Le regenerer apres
 * toute modification de `src/` ou de `ui/` fait partie de la routine de commit.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const lire = (...p) => readFileSync(join(RACINE, ...p), 'utf8');

/** Ordre de dependance des modules du moteur (aucun cycle : chacun ne cite que les precedents). */
const MODULES = [
  'arrondis.js',
  'produits.js',
  'amortissement.js',
  'calendrier.js', // depend de amortissement.js (jourUTC)
  'trajectoires.js',
  'loyers.js',
  'bilan.js',
  'subventions.js',
  'financement.js',
  'fiscalite.js',
  'exploitation.js',
  'moteur.js',
];

/** Retire les `import` et les mots-cles `export` pour permettre la concatenation. */
function aplatir(source) {
  return source
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^export\s+/gm, '');
}

/**
 * Detecte les collisions de noms au niveau racine : concatener plusieurs modules
 * dans une meme portee casserait silencieusement sur un doublon (ex. deux
 * `const MOIS_PAR_AN`). On prefere echouer bruyamment.
 */
function verifierCollisions(morceaux) {
  const vus = new Map();
  const collisions = [];
  for (const { nom, code } of morceaux) {
    for (const m of code.matchAll(/^(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const symbole = m[1];
      if (vus.has(symbole)) collisions.push(`${symbole} (${vus.get(symbole)} et ${nom})`);
      else vus.set(symbole, nom);
    }
  }
  if (collisions.length) {
    throw new Error(
      'Collisions de noms entre modules, la concatenation serait incorrecte :\n  - ' +
        collisions.join('\n  - '),
    );
  }
}

/**
 * Verifie qu'aucun module du moteur n'importe un fichier absent de MODULES.
 * Sans ce controle, un module oublie produit un fichier qui se genere sans bruit
 * et n'echoue qu'a l'ouverture dans le navigateur, sur un « X is not defined ».
 */
function verifierExhaustivite() {
  const manquants = new Set();
  for (const nom of MODULES) {
    for (const m of lire('src', nom).matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)) {
      if (!MODULES.includes(m[1])) manquants.add(`${m[1]} (importe par ${nom})`);
    }
  }
  if (manquants.size) {
    throw new Error(
      'Modules du moteur absents de la liste MODULES :\n  - ' +
        [...manquants].join('\n  - ') +
        '\nAjoutez-les dans l ordre de dependance.',
    );
  }
}

// --- Moteur ---
verifierExhaustivite();
const morceaux = MODULES.map((nom) => ({ nom, code: aplatir(lire('src', nom)) }));
const moteur = morceaux
  .map(({ nom, code }) => `\n/* ===== src/${nom} ===== */\n${code.trim()}\n`)
  .join('');

// --- Referentiels inlines a la place du bloc fetch ---
const referentiels = {
  baremes: JSON.parse(lire('referentiels', 'baremes_2025.json')),
  trajectoires: JSON.parse(lire('referentiels', 'trajectoires_axentia_2026.json')),
  nomenclature_pdr: JSON.parse(lire('referentiels', 'nomenclature_pdr.json')),
  zonage_communes: JSON.parse(lire('referentiels', 'zonage_communes.json')),
  departements: JSON.parse(lire('referentiels', 'departements.json')),
};

// Garde-fou : tout referentiel charge par l'UI doit etre inline ici, sinon la
// version autonome part avec un referentiel manquant et echoue a l'ouverture.
for (const m of lire('ui', 'app.js').matchAll(/referentiels\/([\w.]+)\.json/g)) {
  const cle = m[1].replace(/_\d{4}$/, '').replace(/_axentia_\d{4}$/, '');
  const present = Object.keys(referentiels).some((k) => k.startsWith(cle.split('_')[0]));
  if (!present) throw new Error(`Referentiel charge par l'UI mais absent du generateur : ${m[1]}.json`);
}
// L'UI est concatenee dans la MEME portee que le moteur : ses noms racine
// entrent donc en collision avec les siens. On verifie l'ensemble d'un bloc,
// et pas seulement les modules entre eux.
const app = aplatir(lire('ui', 'app.js')).replace(
  /\/\/ __REFERENTIELS_DEBUT__[\s\S]*?\/\/ __REFERENTIELS_FIN__/,
  `const referentiels = ${JSON.stringify(referentiels)};`,
);
if (app.includes('__REFERENTIELS_DEBUT__')) {
  throw new Error("Le bloc de referentiels n'a pas ete remplace : marqueurs absents de ui/app.js");
}
if (/\bawait\b/.test(app.split('\n').filter((l) => !l.trim().startsWith('*')).join('\n'))) {
  throw new Error('`await` de premier niveau restant : le script classique ne peut pas le porter');
}

verifierCollisions([...morceaux, { nom: 'ui/app.js', code: app }]);

// --- Assemblage ---
const html = lire('ui', 'index.html')
  .replace('<link rel="stylesheet" href="style.css" />', `<style>\n${lire('ui', 'style.css')}\n</style>`)
  .replace(
    '<script type="module" src="app.js"></script>',
    `<script>\n"use strict";\n(function () {\n${moteur}\n\n/* ===== ui/app.js ===== */\n${app}\n})();\n</script>`,
  )
  .replace(
    '<head>',
    '<head>\n    <!-- FICHIER GENERE — ne pas editer. Source : ui/ + src/. ' +
      'Regenerer avec : node outils/generer_ui_autonome.js -->',
  );

const sortie = join(RACINE, 'ui', 'simulation-autonome.html');
writeFileSync(sortie, html);
console.log(`Fichier autonome ecrit : ${sortie}`);
console.log(`Taille : ${(html.length / 1024).toFixed(0)} Ko — ouvrable par double-clic.`);
