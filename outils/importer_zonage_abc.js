// @ts-check
/**
 * Construit `referentiels/zonage_abc_communes.json` depuis le CSV officiel du
 * zonage A/B/C.
 *
 *   node outils/importer_zonage_abc.js <chemin-du-csv>
 *
 * Source : « Liste des communes selon le zonage ABC », Ministere de la
 * Transition ecologique, sur data.gouv.fr, sous Licence Ouverte v2.0.
 * Colonnes : CODGEO ; DEP ; LIBGEO ; zone en vigueur.
 *
 * Pourquoi un script et non une saisie : le zonage est revise par arrete tous
 * les deux ou trois ans. Reimporter doit etre une commande, pas un chantier.
 * Le fichier produit porte sa date de mise en vigueur pour qu'on sache, en le
 * lisant, s'il est perime.
 *
 * Les DOM sont ecartes : ils sont hors perimetre (decision du 06/08/2026) et la
 * liste des departements de l'interface ne les propose pas. Les y laisser
 * ferait grossir un referentiel dont aucune ligne ne serait atteignable.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const source = process.argv[2];
if (!source) {
  console.error('Usage : node outils/importer_zonage_abc.js <chemin-du-csv>');
  process.exit(1);
}

/** Departements retenus : ceux que l'interface propose. */
const departements = new Set(
  JSON.parse(readFileSync(join(RACINE, 'referentiels', 'departements.json'), 'utf8')).departements.map(
    (d) => d.code,
  ),
);

const lignes = readFileSync(source, 'utf8').split(/\r?\n/).filter(Boolean);
const entete = lignes[0].split(';');
if (entete[0] !== 'CODGEO' || entete[1] !== 'DEP' || entete[2] !== 'LIBGEO') {
  throw new Error(`En-tete inattendu, le format de la source a change : ${lignes[0]}`);
}
// La date de mise en vigueur est portee par le libelle de la 4e colonne :
// « Zonage ABC en vigueur depuis le 26 juin 2026 ». On la conserve telle quelle
// plutot que de la deviner.
const enVigueur = entete[3].replace(/^.*en vigueur depuis le /i, '').trim();

/** @type {Record<string, Array<[string, string, string]>>} */
const parDepartement = {};
const zonesVues = new Set();
let ignorees = 0;

for (const ligne of lignes.slice(1)) {
  const [codgeo, dep, libgeo, zone] = ligne.split(';');
  if (!codgeo || !dep || !libgeo || !zone) continue;
  if (!departements.has(dep)) {
    ignorees++;
    continue;
  }
  zonesVues.add(zone);
  (parDepartement[dep] ??= []).push([codgeo, libgeo, zone]);
}

// Les zones admises sont celles du bareme : une valeur inconnue signalerait un
// changement de nomenclature qu'il ne faut surtout pas absorber en silence.
const ADMISES = new Set(['Abis', 'A', 'B1', 'B2', 'C']);
const inconnues = [...zonesVues].filter((z) => !ADMISES.has(z));
if (inconnues.length) {
  throw new Error(`Zones inconnues dans la source : ${inconnues.join(', ')}`);
}

for (const dep of Object.keys(parDepartement)) {
  parDepartement[dep].sort((a, b) => a[1].localeCompare(b[1], 'fr'));
}

const total = Object.values(parDepartement).reduce((s, l) => s + l.length, 0);
const sortie = {
  libelle: 'Zonage A/B/C des communes',
  source:
    '« Liste des communes selon le zonage ABC », Ministere de la Transition ecologique, data.gouv.fr',
  licence: 'Licence Ouverte v2.0',
  en_vigueur_depuis: enVigueur,
  importe_par: 'outils/importer_zonage_abc.js',
  note:
    'Zonage A/B/C uniquement : il commande les loyers plafonds du PLS et du PLI. ' +
    "Le zonage 1/2/3, qui commande ceux du PLUS et du PLAI, releve d'un autre arrete " +
    "et ne fait l'objet d'aucune table nationale ouverte : il reste a saisir. " +
    'DOM ecartes, hors perimetre.',
  champs: ['code_insee', 'nom', 'zone_ABC'],
  nb_communes: total,
  par_departement: parDepartement,
};

const chemin = join(RACINE, 'referentiels', 'zonage_abc_communes.json');
writeFileSync(chemin, `${JSON.stringify(sortie)}\n`);
console.log(`Ecrit : ${chemin}`);
console.log(
  `${total} communes sur ${Object.keys(parDepartement).length} departements, ` +
    `${ignorees} ignorees (hors metropole). En vigueur depuis le ${enVigueur}.`,
);
