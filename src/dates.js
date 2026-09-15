// @ts-check
/**
 * Arithmetique des dates, sans horloge systeme.
 *
 * Les dates du moteur sont des entrees explicites au format ISO `AAAA-MM-JJ`.
 * Ce module ne fait que les convertir et les decaler ; il ne lit jamais la
 * date du jour. Il vit a part parce que trois modules s'en servent - le
 * calendrier, les prets et la tresorerie - et que la bibliotheque de fonctions
 * des formules en a besoin sans dependre d'aucun d'eux.
 */

/** Millisecondes par jour (constante calendaire). Source unique du projet. */
export const MS_PAR_JOUR = 86400000;

/**
 * Numero de jour UTC d'une date exprimee en ISO 'AAAA-MM-JJ' (ou d'un objet Date).
 * @param {string|Date} date
 * @returns {number}
 */
export function jourUTC(date) {
  if (date instanceof Date) {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / MS_PAR_JOUR;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  if (!m) throw new Error(`Date attendue au format AAAA-MM-JJ : ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / MS_PAR_JOUR;
}

/**
 * Formate un numero de jour UTC en date ISO 'AAAA-MM-JJ'.
 * @param {number} jour
 * @returns {string}
 */
export function versISO(jour) {
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
