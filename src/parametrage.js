// @ts-check
/**
 * Surcharge des referentiels PAR SIMULATION (R-PARAM).
 *
 * Un bareme reglementaire change plusieurs fois par an - grille tarifaire CDC,
 * loyers plafonds au 1er janvier, trajectoire macro revue en gestion. Attendre
 * une livraison du moteur pour chiffrer au tarif du jour n'est pas tenable, et
 * modifier le fichier du depot rendrait toutes les simulations anterieures
 * irreproductibles d'un coup.
 *
 * La surcharge voyage donc AVEC LA SIMULATION : `entrees.parametrage` calque la
 * structure du referentiel et vient par-dessus. Le fichier du depot reste la
 * reference, l'ecart est explicite, et le meme dossier rejoue ailleurs redonne
 * les memes nombres. C'est ce qui distingue ce mecanisme d'un reglage global
 * mutable, qui casserait la purete du moteur (CLAUDE.md §4).
 *
 * Aucune regle de calcul ici : uniquement la composition des donnees.
 */

/**
 * Une valeur de surcharge VIDE ne surcharge rien. C'est la regle centrale : a
 * l'ecran, effacer une cellule doit rendre la valeur du referentiel, pas
 * imposer zero ni casser le calcul.
 * @param {any} v
 * @returns {boolean}
 */
function vide(v) {
  return v === undefined || v === null || v === '' || (typeof v === 'number' && Number.isNaN(v));
}

/**
 * Fusionne une surcharge partielle sur un referentiel, en profondeur.
 *
 * - objet : fusionne cle par cle, les cles absentes de la surcharge restent ;
 * - tableau POSITIONNEL : fusionne PAR INDEX, ce qui permet de ne redonner
 *   qu'une zone d'un bareme sans recopier les quatre autres ;
 * - tableau A IDENTIFIANTS (chaque element porte un `id`) : c'est une LISTE, pas
 *   une grille. La surcharge y fait autorite sur la composition - elle peut donc
 *   en retirer un element, ce qu'une fusion par index ne permet pas : l'element
 *   de base reapparaitrait au-dela de la longueur de la surcharge. Les elements
 *   communs se fusionnent par `id`, pour qu'une surcharge partielle reste
 *   possible sur un element sans recopier tous ses champs ;
 * - valeur simple : remplacee, sauf si elle est vide.
 *
 * Ne modifie jamais ses arguments : le referentiel charge une fois pour toutes
 * doit rester intact d'une simulation a l'autre.
 *
 * @template T
 * @param {T} base       valeur du referentiel
 * @param {any} surcharge  valeur saisie, partielle
 * @returns {T}
 */
/**
 * Un tableau est une LISTE, et non une grille positionnelle, quand tous ses
 * elements sont des objets porteurs d'un `id`. Le vide en est exclu : un
 * tableau sans element ne dit rien de sa nature, et le traiter en liste
 * laisserait une surcharge vide effacer toute la base.
 */
function listeAIdentifiants(t) {
  return (
    t.length > 0 &&
    t.every((e) => e && typeof e === 'object' && !Array.isArray(e) && typeof e.id === 'string')
  );
}

export function fusionner(base, surcharge) {
  if (vide(surcharge)) return base;

  if (Array.isArray(base)) {
    if (!Array.isArray(surcharge)) return /** @type {any} */ (surcharge);
    if (listeAIdentifiants(base) && listeAIdentifiants(surcharge)) {
      const parId = new Map(base.map((e) => [e.id, e]));
      return /** @type {any} */ (surcharge.map((e) => fusionner(parId.get(e.id), e)));
    }
    const long = Math.max(base.length, surcharge.length);
    const out = [];
    for (let i = 0; i < long; i++) out.push(fusionner(base[i], surcharge[i]));
    return /** @type {any} */ (out);
  }

  if (base && typeof base === 'object' && !Array.isArray(surcharge) && typeof surcharge === 'object') {
    /** @type {Record<string, any>} */
    const out = { ...base };
    for (const [cle, v] of Object.entries(surcharge)) {
      out[cle] = cle in out ? fusionner(out[cle], v) : v;
    }
    return /** @type {any} */ (out);
  }

  return surcharge;
}

/**
 * Surcharges des trajectoires macro.
 *
 * Elles ne suivent pas la forme du fichier - une liste d'annees - mais une
 * table creuse `{ annee: { poste: taux } }` : on ne modifie jamais cinquante
 * lignes, on en corrige deux ou trois, et une surcharge creuse dit lesquelles.
 *
 * @param {Object} trajectoires  trajectoires deja normalisees (`par_poste`)
 * @param {Object} [surcharge]   `{ taux_reference_livret_a, par_annee: {2028: {loyers_irl: 0.021}} }`
 * @returns {Object} trajectoires surchargees, l'original reste intact
 */
export function surchargerTrajectoires(trajectoires, surcharge) {
  if (!surcharge || (vide(surcharge.taux_reference_livret_a) && !surcharge.par_annee)) {
    return trajectoires;
  }

  /** @type {Record<string, any>} */
  const parPoste = {};
  for (const [poste, valeurs] of Object.entries(trajectoires.par_poste ?? {})) {
    parPoste[poste] = typeof valeurs === 'object' && valeurs !== null ? { ...valeurs } : valeurs;
  }
  const livretA = { ...(trajectoires.livret_a_par_annee ?? {}) };

  for (const [annee, postes] of Object.entries(surcharge.par_annee ?? {})) {
    for (const [poste, v] of Object.entries(/** @type {Record<string, any>} */ (postes) ?? {})) {
      if (vide(v)) continue;
      // Le Livret A est lu par l'amortissement dans sa propre table et par
      // l'exploitation dans `par_poste` : les deux doivent bouger ensemble,
      // sans quoi un taux revise a l'ecran ne changerait que la moitie du
      // resultat.
      if (poste === 'livret_a') livretA[annee] = Number(v);
      if (typeof parPoste[poste] === 'object' && parPoste[poste] !== null) {
        parPoste[poste][annee] = Number(v);
      }
    }
  }

  return {
    ...trajectoires,
    par_poste: parPoste,
    livret_a_par_annee: livretA,
    taux_reference_livret_a: vide(surcharge.taux_reference_livret_a)
      ? trajectoires.taux_reference_livret_a
      : Number(surcharge.taux_reference_livret_a),
  };
}

/**
 * Liste des surcharges effectivement appliquees, chemin par chemin. Sert a la
 * restitution : une simulation chiffree hors bareme doit le DIRE, sinon deux
 * exports identiques a l'oeil peuvent porter des tarifs differents.
 *
 * @param {any} base
 * @param {any} surcharge
 * @param {string} [prefixe]
 * @returns {Array<{chemin: string, referentiel: any, applique: any}>}
 */
export function ecartsParametrage(base, surcharge, prefixe = '') {
  /** @type {Array<{chemin: string, referentiel: any, applique: any}>} */
  const out = [];
  if (vide(surcharge) || typeof surcharge !== 'object') return out;

  for (const [cle, v] of Object.entries(surcharge)) {
    if (vide(v)) continue;
    const chemin = prefixe ? `${prefixe}.${cle}` : cle;
    const b = base?.[cle];
    if (v && typeof v === 'object') out.push(...ecartsParametrage(b, v, chemin));
    else if (b !== v) out.push({ chemin, referentiel: b, applique: v });
  }
  return out;
}
