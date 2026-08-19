// @ts-check
/**
 * Depot de simulations : la bibliotheque, et le contrat qui la rend deplaçable.
 *
 * L'outil ne portait qu'UNE simulation, ecrite dans une cle unique du stockage
 * local. Ce module en fait une bibliotheque : plusieurs simulations, une seule
 * ouverte a la fois, chacune avec sa fiche - nom, version, commune, programme,
 * date de derniere modification.
 *
 * CE QUI COMPTE ICI, c'est le CONTRAT et non l'implementation. Le depot expose
 * six operations et rien d'autre :
 *
 *   listerSimulations()        -> Fiche[]      les fiches, sans charger les donnees
 *   lireSimulation(id)         -> Simulation   le contenu d'une simulation
 *   ecrireSimulation(id, sim)  -> Fiche        cree ou remplace
 *   supprimerSimulation(id)    -> void
 *   simulationCourante() / ouvrirSimulation(id) -> la simulation ouverte
 *
 * La cible est un serveur d'entreprise : les simulations et le moteur y seront
 * stockes, et cet ecran ouvrira un fichier distant. Le jour venu, seul le corps
 * de ces six fonctions change - `fetch` a la place de `localStorage` - et
 * l'ecran n'en sait rien. C'est la raison d'etre de ce module : l'interface ne
 * connait JAMAIS la cle de stockage, elle ne connait que le depot.
 *
 * Deux consequences de ce contrat, tenues des maintenant :
 *   - `listerSimulations()` ne charge pas les donnees. Une bibliotheque de deux cents
 *     simulations ne doit pas peser deux cents fois le poids d'une simulation
 *     pour afficher une liste. C'est vrai en local, ce sera vital en reseau.
 *   - les REFERENTIELS ne sont jamais dans une simulation. Le zonage des
 *     communes pese pres d'un megaoctet, cent vingt fois une simulation
 *     ordinaire : il est charge une fois par l'application, jamais copie.
 *
 * Ce module vit dans `ui/` et non dans `src/` : le moteur est pur, sans I/O ni
 * etat global (CLAUDE.md §4), et un depot est exactement le contraire.
 */

/** Prefixe de toutes les cles. Le suffixe de version permet une migration future. */
const PREFIXE = 'moteur-sim.depot.v1';
const CLE_INDEX = `${PREFIXE}.index`;
const CLE_COURANT = `${PREFIXE}.courant`;
const CLE_SIM = (id) => `${PREFIXE}.sim.${id}`;

/** Cle de l'ancienne simulation unique, reprise a la premiere ouverture. */
const CLE_HERITEE = 'moteur-sim.saisie.v1';

/**
 * @typedef {Object} Fiche
 * @property {string} id
 * @property {string} nom
 * @property {string} groupe            le projet auquel la simulation appartient
 * @property {string} commune
 * @property {string} zone_ABC
 * @property {string} type_operation
 * @property {number} nb_lots
 * @property {number} nb_logements
 * @property {string[]} produits        codes presents au programme
 * @property {string} cree_le           ISO
 * @property {string} modifie_le        ISO
 * @property {number} octets            poids de la simulation, mesure a l'ecriture
 */

/** Lecture tolerante : un stockage indisponible ou illisible ne doit rien casser. */
function depotLireJSON(cle, defaut) {
  try {
    const brut = localStorage.getItem(cle);
    if (!brut) return defaut;
    const v = JSON.parse(brut);
    return v ?? defaut;
  } catch {
    return defaut;
  }
}

function depotEcrireJSON(cle, valeur) {
  try {
    localStorage.setItem(cle, JSON.stringify(valeur));
    return true;
  } catch {
    // Quota depasse ou stockage refuse : l'appelant en est informe pour
    // pouvoir le DIRE a l'utilisateur. Perdre une sauvegarde en silence est
    // la pire des issues.
    return false;
  }
}

/**
 * Identifiant d'une simulation.
 *
 * Sur l'horodatage : le MOTEUR n'a pas le droit de lire l'heure (CLAUDE.md §4,
 * meme entrees -> memes sorties). Le depot, lui, en a besoin - un identifiant
 * doit etre unique et une fiche doit porter sa date. Aucune de ces valeurs
 * n'entre jamais dans un calcul : elles ne servent qu'a ranger et a afficher.
 */
function depotNouvelId(index) {
  const base = `sim-${Date.now().toString(36)}`;
  let id = base;
  let n = 2;
  while (index.some((f) => f.id === id)) id = `${base}-${n++}`;
  return id;
}

/**
 * Numero suivant : le plus grand des numeros existants, plus un.
 *
 * Aucun compteur n'est conserve, et c'est voulu. Supprimer la DERNIERE
 * simulation doit rendre son numero disponible - avec 1, 2, 3, effacer la 3
 * ramene la prochaine a 3, et non a 4 qui laisserait un trou permanent en fin
 * de liste. Supprimer une simulation du MILIEU, en revanche, laisse son numero
 * vacant : avec 1, 2, 4, la prochaine est la 5. Combler le 3 obligerait soit a
 * renumeroter les suivantes - donc a changer la reference d'un dossier qu'on a
 * peut-etre deja cite ailleurs - soit a rendre l'ordre des numeros incoherent
 * avec l'ordre de creation.
 */
function depotProchainNumero(index) {
  return index.reduce((m, f) => Math.max(m, Number(f.numero) || 0), 0) + 1;
}

/** Fiche deduite d'une simulation : ce que la liste affiche sans ouvrir le fichier. */
export function ficheSimulation(sim, base = {}) {
  const lots = Array.isArray(sim?.lots) ? sim.lots : [];
  const produits = [...new Set(lots.map((l) => l?.code_produit).filter(Boolean))];
  const maintenant = new Date().toISOString();
  return {
    id: base.id ?? '',
    numero: base.numero ?? 0,
    nom: sim?.identite?.nom || 'Simulation sans nom',
    groupe: sim?.identite?.groupe || '',
    commune: sim?.identite?.commune || '',
    zone_ABC: sim?.identite?.zone_ABC || '',
    type_operation: sim?.identite?.type_operation || '',
    nb_lots: lots.length,
    nb_logements: lots.reduce((s, l) => s + (Number(l?.nb_logements) || 0), 0),
    produits,
    cree_le: base.cree_le ?? maintenant,
    modifie_le: maintenant,
    octets: new Blob([JSON.stringify(sim ?? {})]).size,
  };
}

/**
 * Les fiches, du numero le plus recent au plus ancien.
 *
 * Le tri par defaut est le NUMERO et non la date de modification : avec
 * quelques milliers de dossiers, une liste qui se reordonne a chaque frappe
 * est inutilisable - on cherche une ligne, on la perd, elle est remontee en
 * tete. L'ecran laisse trier par n'importe quelle colonne.
 */
export function listerSimulations() {
  const index = depotLireJSON(CLE_INDEX, []);
  return [...index].sort((a, b) => (Number(b.numero) || 0) - (Number(a.numero) || 0));
}

/** Le contenu d'une simulation, ou null si elle n'existe pas. */
export function lireSimulation(id) {
  return depotLireJSON(CLE_SIM(id), null);
}

/**
 * Cree ou remplace une simulation, et met sa fiche a jour.
 * @returns {Fiche|null} la fiche ecrite, ou null si le stockage a refuse
 */
export function ecrireSimulation(id, sim) {
  const index = depotLireJSON(CLE_INDEX, []);
  const ancienne = index.find((f) => f.id === id);
  const fiche = ficheSimulation(sim, {
    id,
    cree_le: ancienne?.cree_le,
    // Une simulation garde son numero a vie. Il n'est attribue qu'a la
    // premiere ecriture, jamais recalcule.
    numero: ancienne?.numero ?? depotProchainNumero(index),
  });
  if (!depotEcrireJSON(CLE_SIM(id), sim)) return null;
  const suivant = ancienne
    ? index.map((f) => (f.id === id ? fiche : f))
    : [...index, fiche];
  if (!depotEcrireJSON(CLE_INDEX, suivant)) return null;
  return fiche;
}

/** Ajoute une simulation sous un identifiant neuf. */
export function ajouterSimulation(sim, nom) {
  const index = depotLireJSON(CLE_INDEX, []);
  const id = depotNouvelId(index);
  const copie = structuredClone(sim);
  if (nom) {
    copie.identite = { ...(copie.identite ?? {}), nom };
  }
  return ecrireSimulation(id, copie) ? id : null;
}

export function supprimerSimulation(id) {
  try {
    localStorage.removeItem(CLE_SIM(id));
  } catch {
    /* le retrait de l'index suffit a la faire disparaitre */
  }
  depotEcrireJSON(CLE_INDEX, depotLireJSON(CLE_INDEX, []).filter((f) => f.id !== id));
  if (simulationCourante() === id) ouvrirSimulation(null);
}

/** Renomme sans relire la simulation entiere quand c'est evitable. */
export function renommerSimulation(id, nom) {
  const sim = lireSimulation(id);
  if (!sim) return false;
  sim.identite = { ...(sim.identite ?? {}), nom };
  return Boolean(ecrireSimulation(id, sim));
}

export function simulationCourante() {
  try {
    return localStorage.getItem(CLE_COURANT);
  } catch {
    return null;
  }
}

export function ouvrirSimulation(id) {
  try {
    if (id === null) localStorage.removeItem(CLE_COURANT);
    else localStorage.setItem(CLE_COURANT, id);
  } catch {
    /* voir depotEcrireJSON */
  }
  return id;
}

/**
 * Reprend l'ancienne simulation unique dans la bibliotheque, une seule fois.
 *
 * Sans cela, la mise a jour de l'outil ferait disparaitre le travail en cours
 * de chaque utilisateur : sa saisie serait toujours dans le stockage, mais
 * plus aucun ecran n'irait la chercher. La cle heritee est CONSERVEE et non
 * effacee, pour qu'un retour a la version precedente reste possible.
 *
 * @returns {string|null} l'identifiant de la simulation reprise
 */
export function reprendreHeritage() {
  if (depotLireJSON(CLE_INDEX, []).length) return null;
  const ancienne = depotLireJSON(CLE_HERITEE, null);
  if (!ancienne || !ancienne.identite) return null;
  const id = ajouterSimulation(ancienne);
  if (id) ouvrirSimulation(id);
  return id;
}

/** Poids total de la bibliotheque, pour l'afficher a l'utilisateur. */
export function poidsBibliotheque() {
  return listerSimulations().reduce((s, f) => s + (Number(f.octets) || 0), 0);
}
