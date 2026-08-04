// @ts-check
/**
 * Interface de saisie d'operation et de visualisation du plan de financement.
 *
 * Importe `src/moteur.js` TEL QUEL : le moteur est de l'ESM pur, il tourne dans
 * le navigateur sans build ni transpilation (exigence CLAUDE.md §3).
 *
 * Cette couche ne contient AUCUNE regle de calcul : elle collecte des entrees,
 * appelle `calculer()` et met en forme le resultat. Toute valeur affichee vient
 * du moteur ; rien n'est recalcule ici.
 */
import { calculer } from '../src/moteur.js';
import { PRODUITS } from '../src/produits.js';

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

// ---------------------------------------------------------------- referentiels

// __REFERENTIELS_DEBUT__ (bloc remplace par des litteraux dans la version autonome)
const referentiels = {
  baremes: await (await fetch('../referentiels/baremes_2025.json')).json(),
  trajectoires: await (await fetch('../referentiels/trajectoires_axentia_2026.json')).json(),
};
// __REFERENTIELS_FIN__

// ---------------------------------------------------------------- etat initial

/** Operation de depart : 6 logements PLS, calquee sur la structure BERGERAC. */
const etat = {
  identite: {
    nom: 'Opération de test',
    produit: 'PLS',
    zone_123: 2,
    zone_ABC: 'B1',
    type_operation: 'Vefa',
  },
  dates: { annee_mise_en_location: 2028, duree_simulation_ans: 40 },
  lots: [
    {
      code_produit: 'PLS',
      nb_logements: 6,
      shab_m2: 400,
      surfaces_annexes_m2: 40,
      marge_locale_eur_m2: 0,
    },
  ],
  postes_bilan: [
    { chapitre: 'charge_fonciere', libelle: 'Acquisition VEFA', montant_ht_eur: 642780, taux_tva: 0.055 },
    { chapitre: 'charge_fonciere', libelle: 'Frais de notaire', montant_ht_eur: 12000, taux_tva: 0.055 },
    { chapitre: 'honoraires', libelle: 'Honoraires techniques', montant_ht_eur: 18000, taux_tva: 0.2 },
  ],
  subventions: [{ libelle: 'Ville', montant_eur: 20000, gratuite: true }],
  fonds_propres_eur: 50000,
  prets: [
    {
      code: 'PLS_CONSTRUCTION', libelle: 'PLS construction', nature: 'construction',
      montant_eur: 494023, taux: 0.0351, progressivite: 0, duree_ans: 40,
      annee_premiere_echeance: 2028, revisabilite: 'SIMPLE',
      livret_a_origine: 0.024, livret_a_par_annee: { 2028: 0.02 },
    },
    {
      code: 'PLS_FONCIER', libelle: 'PLS foncier', nature: 'foncier',
      montant_eur: 176035, taux: 0.0351, progressivite: 0, duree_ans: 50,
      annee_premiere_echeance: 2028, revisabilite: 'SIMPLE',
      livret_a_origine: 0.024, livret_a_par_annee: { 2028: 0.02 },
    },
  ],
  exploitation: {
    frais_gestion_pct_loyers: 0.07,
    taux_vacance_impayes: 0.02,
    gros_entretien_eur_m2: 5,
    trajectoires: { loyers_irl: 0.02, gros_entretien: 0.023, tfpb: 0.05 },
  },
  options: {},
};

// ---------------------------------------------------------------- mise en forme

const fmtEuro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fmtNombre = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });

const eur = (v) => (v === null || v === undefined || Number.isNaN(v) ? '—' : fmtEuro.format(v));
const pct = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(d)} %`);
const nb = (v) => (v === null || v === undefined ? '—' : fmtNombre.format(v));

/** Couleurs des segments de la balance (navy decline + accents sobres). */
const COULEURS = {
  charge_fonciere: '#12274a',
  batiment: '#1b3a6b',
  honoraires: '#2e5aa8',
  frais_divers: '#5f86c9',
  modulation: '#9db4dc',
  subventions: '#1e7a5a',
  fonds_propres: '#8a6100',
  pret_construction: '#12274a',
  pret_foncier: '#2e5aa8',
  pret_autre: '#7c9bd0',
};

const LIBELLES_CHAPITRE = {
  charge_fonciere: 'Charge foncière',
  batiment: 'Bâtiment',
  honoraires: 'Honoraires',
  frais_divers: 'Frais divers',
};

// ---------------------------------------------------------------- utilitaires

/** Ecrit une valeur dans l'etat a partir d'un chemin pointe (`lots.0.shab_m2`). */
function definirParChemin(cible, chemin, valeur) {
  const cles = chemin.split('.');
  let ref = cible;
  for (const cle of cles.slice(0, -1)) ref = ref[cle];
  ref[cles.at(-1)] = valeur;
}

/** Lit une valeur de l'etat a partir d'un chemin pointe. */
function lireParChemin(cible, chemin) {
  return chemin.split('.').reduce((o, cle) => (o == null ? undefined : o[cle]), cible);
}

// ---------------------------------------------------------------- rendu des listes

function rendreListes() {
  // --- Postes de prix de revient ---
  $('#liste-postes').innerHTML = etat.postes_bilan
    .map(
      (p, i) => `
      <div class="ligne ligne--poste">
        <label class="champ"><span>Libellé</span>
          <input type="text" data-champ="postes_bilan.${i}.libelle" value="${p.libelle ?? ''}" /></label>
        <label class="champ"><span>Montant HT</span>
          <input type="number" step="1" data-champ="postes_bilan.${i}.montant_ht_eur" data-type="nombre" value="${p.montant_ht_eur}" /></label>
        <label class="champ"><span>TVA</span>
          <select data-champ="postes_bilan.${i}.taux_tva" data-type="nombre">
            ${[0.055, 0.1, 0.2, 0]
              .map((t) => `<option value="${t}" ${t === p.taux_tva ? 'selected' : ''}>${(t * 100).toFixed(1)} %</option>`)
              .join('')}
          </select></label>
        <button type="button" class="bouton--supprimer" data-supprimer="postes_bilan" data-index="${i}" title="Supprimer">×</button>
        <label class="champ" style="grid-column:1/-1"><span>Chapitre</span>
          <select data-champ="postes_bilan.${i}.chapitre">
            ${Object.entries(LIBELLES_CHAPITRE)
              .map(([c, l]) => `<option value="${c}" ${c === p.chapitre ? 'selected' : ''}>${l}</option>`)
              .join('')}
          </select></label>
      </div>`,
    )
    .join('');

  // --- Subventions ---
  $('#liste-subventions').innerHTML = etat.subventions
    .map(
      (s, i) => `
      <div class="ligne ligne--subvention">
        <label class="champ"><span>Libellé</span>
          <input type="text" data-champ="subventions.${i}.libelle" value="${s.libelle ?? ''}" /></label>
        <label class="champ"><span>Montant</span>
          <input type="number" step="1" data-champ="subventions.${i}.montant_eur" data-type="nombre" value="${s.montant_eur}" /></label>
        <label class="champ"><span>Gratuite</span>
          <input type="checkbox" data-champ="subventions.${i}.gratuite" data-type="booleen" ${s.gratuite ? 'checked' : ''} /></label>
        <button type="button" class="bouton--supprimer" data-supprimer="subventions" data-index="${i}" title="Supprimer">×</button>
      </div>`,
    )
    .join('');

  // --- Prets ---
  $('#liste-prets').innerHTML = etat.prets
    .map(
      (p, i) => `
      <div class="ligne ligne--pret">
        <label class="champ"><span>Libellé</span>
          <input type="text" data-champ="prets.${i}.libelle" value="${p.libelle ?? ''}" /></label>
        <label class="champ"><span>Montant</span>
          <input type="number" step="1" data-champ="prets.${i}.montant_eur" data-type="nombre" value="${p.montant_eur}" /></label>
        <label class="champ"><span>Nature</span>
          <select data-champ="prets.${i}.nature">
            ${['construction', 'foncier', 'autre']
              .map((n) => `<option value="${n}" ${n === p.nature ? 'selected' : ''}>${n}</option>`)
              .join('')}
          </select></label>
        <button type="button" class="bouton--supprimer" data-supprimer="prets" data-index="${i}" title="Supprimer">×</button>
        <div class="ligne__pied">
          <label class="champ"><span>Taux saisi</span>
            <input type="number" step="0.0001" data-champ="prets.${i}.taux" data-type="nombre" value="${p.taux}" /></label>
          <label class="champ"><span>Durée (ans)</span>
            <input type="number" step="1" min="1" data-champ="prets.${i}.duree_ans" data-type="nombre" value="${p.duree_ans}" /></label>
          <label class="champ"><span>1re échéance</span>
            <input type="number" step="1" data-champ="prets.${i}.annee_premiere_echeance" data-type="nombre" value="${p.annee_premiere_echeance}" /></label>
        </div>
        <div class="ligne__pied">
          <label class="champ"><span>Révisabilité</span>
            <select data-champ="prets.${i}.revisabilite">
              ${['DOUBLE', 'D. LIMITEE', 'SIMPLE', 'TAUX FIXE']
                .map((r) => `<option value="${r}" ${r === p.revisabilite ? 'selected' : ''}>${r}</option>`)
                .join('')}
            </select></label>
          <label class="champ"><span>Progressivité</span>
            <input type="number" step="0.001" data-champ="prets.${i}.progressivite" data-type="nombre" value="${p.progressivite ?? 0}" /></label>
          <label class="champ"><span>Différé (ans)</span>
            <input type="number" step="1" min="0" data-champ="prets.${i}.differe_ans" data-type="nombre" value="${p.differe_ans ?? 0}" /></label>
        </div>
      </div>`,
    )
    .join('');
}

/** Remplit les champs statiques depuis l'etat (au premier chargement). */
function rendreChampsStatiques() {
  $('#select-produit').innerHTML = Object.values(PRODUITS)
    .map((p) => `<option value="${p.code}" ${p.v1 ? '' : 'disabled'}>${p.libelle}${p.v1 ? '' : ' (hors V1)'}</option>`)
    .join('');

  for (const el of document.querySelectorAll('[data-champ]')) {
    const champ = /** @type {HTMLInputElement} */ (el);
    if (champ.closest('.liste')) continue; // gere par rendreListes()
    const valeur = lireParChemin(etat, champ.dataset.champ ?? '');
    if (valeur === undefined) continue;
    if (champ.type === 'checkbox') champ.checked = Boolean(valeur);
    else champ.value = String(valeur);
  }
}

// ---------------------------------------------------------------- rendu resultats

/** Construit une barre empilee proportionnelle a partir de segments. */
function rendreBarre(element, segments, echelle) {
  element.innerHTML = segments
    .filter((s) => s.montant > 0)
    .map((s) => {
      const part = s.montant / echelle;
      // On n'affiche l'etiquette que si le segment est assez haut pour la porter.
      const etiquette = part > 0.07 ? `<span>${eur(s.montant)}</span>` : '';
      return `<div class="segment" style="flex-grow:${s.montant};background:${s.couleur}" title="${s.libelle} : ${eur(s.montant)}">${etiquette}</div>`;
    })
    .join('');
  // Reserve le vide au-dessus quand ce cote est le plus court des deux.
  const total = segments.reduce((t, s) => t + Math.max(0, s.montant), 0);
  if (total < echelle) {
    element.insertAdjacentHTML(
      'beforeend',
      `<div style="flex-grow:${echelle - total}"></div>`,
    );
  }
}

function rendreLegende(segments) {
  $('#legende').innerHTML = segments
    .filter((s) => s.montant > 0)
    .map(
      (s) => `<div class="legende__item">
          <span class="legende__puce" style="background:${s.couleur}"></span>
          <span>${s.libelle}</span>
          <span class="legende__montant">${eur(s.montant)}</span>
        </div>`,
    )
    .join('');
}

function rendreResultats(r) {
  // --- Emplois : le prix de revient par chapitre, base TTC/LASM ---
  const emplois = Object.entries(r.bilan.chapitres).map(([code, c]) => ({
    libelle: LIBELLES_CHAPITRE[code] ?? code,
    montant: c.ttc_lasm_eur,
    couleur: COULEURS[code] ?? COULEURS.frais_divers,
  }));
  if (r.bilan.modulation_ttc_eur) {
    emplois.push({ libelle: 'Modulation', montant: r.bilan.modulation_ttc_eur, couleur: COULEURS.modulation });
  }

  // --- Ressources : subventions, fonds propres, prets ---
  const ressources = [];
  if (r.subventions.total_avec_ssf_eur > 0) {
    ressources.push({ libelle: 'Subventions', montant: r.subventions.total_avec_ssf_eur, couleur: COULEURS.subventions });
  }
  if (etat.fonds_propres_eur > 0) {
    ressources.push({ libelle: 'Fonds propres', montant: etat.fonds_propres_eur, couleur: COULEURS.fonds_propres });
  }
  for (const p of etat.prets) {
    if (!(p.montant_eur > 0)) continue;
    ressources.push({
      libelle: p.libelle || p.code,
      montant: p.montant_eur,
      couleur: COULEURS[`pret_${p.nature}`] ?? COULEURS.pret_autre,
    });
  }

  const totalEmplois = emplois.reduce((t, s) => t + s.montant, 0);
  const totalRessources = ressources.reduce((t, s) => t + s.montant, 0);
  const echelle = Math.max(totalEmplois, totalRessources, 1);

  rendreBarre($('#barre-emplois'), emplois, echelle);
  rendreBarre($('#barre-ressources'), ressources, echelle);
  rendreLegende([...emplois, ...ressources]);

  $('#total-emplois').textContent = eur(totalEmplois);
  $('#total-ressources').textContent = eur(totalRessources);

  const eq = r.financement.equilibre;
  const badge = $('#badge-equilibre');
  badge.textContent = eq.equilibre ? 'Équilibré' : `Écart ${eur(eq.ecart_eur)}`;
  badge.className = `badge ${eq.equilibre ? 'badge--equilibre' : 'badge--ecart'}`;

  // --- Tableau des prets ---
  const corps = $('#tableau-prets').querySelector('tbody');
  if (!r.amortissements.length) {
    corps.innerHTML = '<tr><td colspan="6" class="vide">Aucun prêt mobilisé</td></tr>';
  } else {
    corps.innerHTML = r.amortissements
      .map((a) => {
        const t = a.tableau;
        return `<tr>
            <td>${a.libelle}</td>
            <td class="num">${eur(a.montant_eur)}</td>
            <td class="num">${pct(t[0].taux)}</td>
            <td class="num">${t.length} ans</td>
            <td class="num">${eur(t[0].annuite_eur)}</td>
            <td class="num">${eur(t.at(-1).annuite_eur)}</td>
          </tr>`;
      })
      .join('');
  }

  // Le taux applique differe du taux saisi des que la revisabilite joue : on
  // l'explicite, c'est la source de confusion n°1 face a LEON (question Q-8).
  const ecarts = r.amortissements
    .map((a, i) => ({ a, saisi: etat.prets[i]?.taux }))
    .filter(({ a, saisi }) => saisi !== undefined && Math.abs(a.tableau[0].taux - saisi) > 1e-9);
  $('#aide-taux').textContent = ecarts.length
    ? `Taux appliqué ≠ taux saisi : la révision Livret A joue dès la première échéance ` +
      `(LA de référence ${pct(referentiels.baremes ? 0.024 : 0)} contre trajectoire ${pct(0.02)}).`
    : '';

  // --- Indicateurs ---
  const ind = r.indicateurs;
  $('#indicateurs').innerHTML = [
    { l: 'Prix de revient TTC', v: eur(ind.prix_revient_ttc_eur), d: `${eur(ind.prix_revient_par_logement_eur)} / logement` },
    { l: 'Coût au m² SHAB', v: eur(ind.prix_revient_par_m2_shab_eur), d: `${nb(ind.shab_m2)} m² SHAB` },
    { l: 'Surface utile', v: `${nb(ind.su_m2)} m²`, d: `${ind.nb_logements} logements` },
    { l: 'Loyers annuels', v: eur(ind.loyers_annuels_eur), d: `RMO ${pct(ind.rmo)}` },
    { l: 'Fonds propres', v: pct(ind.taux_fonds_propres), d: eur(etat.fonds_propres_eur) },
    {
      l: 'Reconstitution FP',
      v: ind.annee_reconstitution_fonds_propres ?? 'non atteinte',
      d: `TFPB à partir de ${ind.annee_debut_tfpb}`,
    },
  ]
    .map(
      (i) => `<div class="indicateur">
          <div class="indicateur__libelle">${i.l}</div>
          <div class="indicateur__valeur">${i.v}</div>
          <div class="indicateur__detail">${i.d}</div>
        </div>`,
    )
    .join('');

  // --- Alertes ---
  const carteAlertes = $('#carte-alertes');
  if (r.alertes.length) {
    carteAlertes.hidden = false;
    $('#alertes').innerHTML = r.alertes.map((a) => `<li>${a}</li>`).join('');
  } else {
    carteAlertes.hidden = true;
  }

  // --- Aide de saisie : rappel de la surface utile calculee ---
  const lot = r.surfaces.detail[0];
  $('#aide-surfaces').textContent = lot
    ? `Surface utile calculée : ${nb(lot.su_m2)} m² (SHAB + 0,5 × annexes) — coefficient de structure ${nb(r.loyers[0]?.cs)}.`
    : '';

  $('#version-moteur').textContent = `v${r.version_moteur}`;
}

// ---------------------------------------------------------------- boucle de calcul

let dernierResultat = null;

function recalculer() {
  const pastille = $('#etat-calcul');
  pastille.textContent = 'calcul…';
  pastille.className = 'pastille pastille--calcul';

  try {
    // Le moteur est pur : on peut l'appeler a chaque frappe sans effet de bord.
    const r = calculer(structuredClone(etat), referentiels);
    dernierResultat = r;
    $('#erreur').hidden = true;
    rendreResultats(r);
    pastille.textContent = 'à jour';
    pastille.className = 'pastille pastille--ok';
  } catch (e) {
    const erreur = $('#erreur');
    erreur.hidden = false;
    erreur.textContent = `Saisie incomplète ou incohérente : ${/** @type {Error} */ (e).message}`;
    pastille.textContent = 'erreur';
    pastille.className = 'pastille pastille--calcul';
  }
}

// ---------------------------------------------------------------- evenements

document.addEventListener('input', (ev) => {
  const el = /** @type {HTMLInputElement} */ (ev.target);
  const chemin = el.dataset?.champ;
  if (!chemin) return;

  let valeur;
  if (el.dataset.type === 'nombre') {
    valeur = el.value === '' ? 0 : Number(el.value);
    if (Number.isNaN(valeur)) return; // saisie transitoire, on attend
  } else if (el.dataset.type === 'booleen') {
    valeur = el.checked;
  } else {
    valeur = el.value;
  }

  definirParChemin(etat, chemin, valeur);

  // Le produit du lot suit celui de l'operation : un seul endroit ou le dire.
  if (chemin === 'identite.produit') etat.lots[0].code_produit = valeur;

  recalculer();
});

document.addEventListener('click', (ev) => {
  const el = /** @type {HTMLElement} */ (ev.target);

  const aAjouter = el.dataset?.ajouter;
  if (aAjouter) {
    const modeles = {
      postes_bilan: { chapitre: 'batiment', libelle: 'Nouveau poste', montant_ht_eur: 0, taux_tva: 0.1 },
      subventions: { libelle: 'Nouvelle subvention', montant_eur: 0, gratuite: false },
      prets: {
        code: `PRET_${etat.prets.length + 1}`, libelle: 'Nouveau prêt', nature: 'autre',
        montant_eur: 0, taux: 0.02, progressivite: 0, duree_ans: 40,
        annee_premiere_echeance: etat.dates.annee_mise_en_location, revisabilite: 'TAUX FIXE',
        livret_a_origine: 0.024, livret_a_par_annee: { 2028: 0.02 },
      },
    };
    etat[aAjouter].push(structuredClone(modeles[aAjouter]));
    rendreListes();
    recalculer();
    return;
  }

  const aSupprimer = el.dataset?.supprimer;
  if (aSupprimer) {
    etat[aSupprimer].splice(Number(el.dataset.index), 1);
    rendreListes();
    recalculer();
    return;
  }

  if (el.id === 'btn-json') {
    $('#contenu-json').textContent = JSON.stringify(dernierResultat, null, 2);
    /** @type {HTMLDialogElement} */ (document.getElementById('dialogue-json')).showModal();
  }
  if (el.id === 'btn-fermer-json') {
    /** @type {HTMLDialogElement} */ (document.getElementById('dialogue-json')).close();
  }
});

// ---------------------------------------------------------------- demarrage

rendreChampsStatiques();
rendreListes();
recalculer();
