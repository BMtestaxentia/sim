// @ts-check
/**
 * Calendrier de l'operation : chaine de dates derivees de la saisie.
 *
 * Source d'ergonomie : onglet ACCUEIL de la maquette LEON REWORK, ou seule la
 * date de debut des travaux est saisie ; livraison et mise en location en
 * decoulent (`C24 = C22 decalee de C23 mois`, `C25 = C24 + 1 jour`).
 *
 * Ce module existe pour que cette derivation reste une REGLE DE CALCUL du
 * moteur et n'aille pas se loger dans l'interface, ou elle serait invisible aux
 * tests et divergerait a la premiere occasion. L'UI l'appelle pour afficher, le
 * moteur l'appelle pour calculer : une seule implementation.
 *
 * Aucune horloge systeme : toutes les dates sont des entrees explicites.
 */
import { jourUTC, MS_PAR_JOUR } from './amortissement.js';

/**
 * Formate un numero de jour UTC en date ISO 'AAAA-MM-JJ'.
 * @param {number} jour
 * @returns {string}
 */
function versISO(jour) {
  return new Date(jour * MS_PAR_JOUR).toISOString().slice(0, 10);
}

/**
 * Decale une date d'un nombre entier de mois, en calendaire (et non en tranches
 * de 30 jours). Le jour du mois est conserve, sauf si le mois d'arrivee est plus
 * court : on retombe alors sur son dernier jour (31 janvier + 1 mois = 28 ou 29 fevrier).
 * @param {string|Date} date
 * @param {number} mois
 * @returns {string} date ISO
 */
export function decalerMois(date, mois) {
  const j = jourUTC(date);
  const d = new Date(j * MS_PAR_JOUR);
  const an = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const jour = d.getUTCDate();

  const cible = new Date(Date.UTC(an, m + mois, 1));
  const dernierJourDuMois = new Date(
    Date.UTC(cible.getUTCFullYear(), cible.getUTCMonth() + 1, 0),
  ).getUTCDate();

  return versISO(
    Date.UTC(cible.getUTCFullYear(), cible.getUTCMonth(), Math.min(jour, dernierJourDuMois)) /
      MS_PAR_JOUR,
  );
}

/**
 * @typedef {Object} EntreesCalendrier
 * @property {string|Date} [date_debut_travaux]
 * @property {number} [duree_chantier_mois]
 * @property {string|Date} [date_livraison]      surcharge (contractuelle en VEFA)
 * @property {string|Date} [date_mise_en_location] surcharge
 * @property {number} [annee_mise_en_location]   surcharge directe (forme minimale)
 *
 * @typedef {Object} Calendrier
 * @property {string|null} date_debut_travaux
 * @property {number|null} duree_chantier_mois
 * @property {string|null} date_livraison
 * @property {string|null} date_mise_en_location
 * @property {number} annee_mise_en_location
 * @property {Record<string, 'saisie'|'calcule'>} origine  d'ou vient chaque date
 */

/**
 * Derive le calendrier de l'operation.
 *
 * Regles (maquette ACCUEIL) :
 *   livraison        = debut des travaux decale de la duree de chantier, en mois
 *   mise en location = livraison + 1 jour
 * Chaque date derivee peut etre surchargee par la saisie ; `origine` indique
 * pour chacune si elle a ete saisie ou calculee, ce qui permet a l'interface de
 * distinguer visuellement les deux sans reimplementer la regle.
 *
 * @param {EntreesCalendrier} entrees
 * @returns {Calendrier}
 */
export function calendrierOperation(entrees = {}) {
  const {
    date_debut_travaux,
    duree_chantier_mois,
    date_livraison,
    date_mise_en_location,
    annee_mise_en_location,
  } = entrees;

  /** @type {Record<string, 'saisie'|'calcule'>} */
  const origine = {};

  let livraison = null;
  if (date_livraison) {
    livraison = versISO(jourUTC(date_livraison));
    origine.date_livraison = 'saisie';
  } else if (date_debut_travaux && Number.isFinite(duree_chantier_mois)) {
    livraison = decalerMois(date_debut_travaux, Number(duree_chantier_mois));
    origine.date_livraison = 'calcule';
  }

  let miseEnLocation = null;
  if (date_mise_en_location) {
    miseEnLocation = versISO(jourUTC(date_mise_en_location));
    origine.date_mise_en_location = 'saisie';
  } else if (livraison) {
    miseEnLocation = versISO(jourUTC(livraison) + 1);
    origine.date_mise_en_location = 'calcule';
  }

  let annee;
  if (miseEnLocation) {
    annee = Number(miseEnLocation.slice(0, 4));
    origine.annee_mise_en_location = 'calcule';
  } else if (Number.isInteger(annee_mise_en_location)) {
    annee = Number(annee_mise_en_location);
    origine.annee_mise_en_location = 'saisie';
  } else {
    throw new Error(
      "Calendrier incomplet : renseigner soit annee_mise_en_location, soit une date de mise en " +
        'location, soit un debut de travaux avec une duree de chantier.',
    );
  }

  if (date_debut_travaux) origine.date_debut_travaux = 'saisie';

  return {
    date_debut_travaux: date_debut_travaux ? versISO(jourUTC(date_debut_travaux)) : null,
    duree_chantier_mois: Number.isFinite(duree_chantier_mois) ? Number(duree_chantier_mois) : null,
    date_livraison: livraison,
    date_mise_en_location: miseEnLocation,
    annee_mise_en_location: annee,
    origine,
  };
}
