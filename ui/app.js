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

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

// __REFERENTIELS_DEBUT__ (bloc remplace par des litteraux dans la version autonome)
const referentiels = {
  baremes: await (await fetch('../referentiels/baremes_2025.json')).json(),
  trajectoires: await (await fetch('../referentiels/trajectoires_axentia_2026.json')).json(),
};
// __REFERENTIELS_FIN__

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
    duree_simulation_ans: 40,
  },
  lots: [
    { code_produit: 'PLS', nb_logements: 6, shab_m2: 400, surfaces_annexes_m2: 40, marge_locale_eur_m2: 0 },
  ],
  postes_bilan: [
    { chapitre: 'charge_fonciere', libelle: 'Acquisition VEFA', montant_ht_eur: 642780, taux_tva: 0.055 },
    { chapitre: 'charge_fonciere', libelle: 'Frais de notaire', montant_ht_eur: 12000, taux_tva: 0.055 },
    { chapitre: 'honoraires', libelle: 'Honoraires techniques', montant_ht_eur: 18000, taux_tva: 0.2 },
  ],
  modulation_ttc_eur: 0,
  subventions: [{ libelle: 'Ville', montant_eur: 20000, gratuite: true }],
  fonds_propres_eur: 50000,
  mode_prets: 'saisis',
  prets: [
    {
      code: 'PLS_CONSTRUCTION', libelle: 'PLS construction', nature: 'construction',
      montant_eur: 494023, taux: 0.0351, progressivite: 0, duree_ans: 40,
      annee_premiere_echeance: 2028, revisabilite: 'SIMPLE', differe_ans: 0, differe_type: 2,
    },
    {
      code: 'PLS_FONCIER', libelle: 'PLS foncier', nature: 'foncier',
      montant_eur: 176035, taux: 0.0351, progressivite: 0, duree_ans: 50,
      annee_premiere_echeance: 2028, revisabilite: 'SIMPLE', differe_ans: 0, differe_type: 2,
    },
  ],
  exploitation: {
    frais_gestion_pct_loyers: 0.07,
    taux_vacance_impayes: 0.02,
    gros_entretien_eur_m2: 5,
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

/** Palette : les chapitres en navy, les prets en teintes franchement distinctes. */
const COULEURS = {
  charge_fonciere: '#12274a',
  batiment: '#2e5aa8',
  honoraires: '#5f86c9',
  frais_divers: '#9db4dc',
  modulation: '#c3d1e8',
  subventions: '#1e7a5a',
  fonds_propres: '#8a6100',
  pret_construction: '#6b3fa0',
  pret_foncier: '#a05fb4',
  pret_autre: '#c79ad6',
};

const CHAPITRES = {
  charge_fonciere: 'Charge foncière',
  batiment: 'Bâtiment',
  honoraires: 'Honoraires',
  frais_divers: 'Frais divers',
};

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
  for (const cle of cles.slice(0, -1)) ref = ref[cle];
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

// ---------------------------------------------------------------- rendu de structure

function rendreSelectProduit() {
  $('#select-produit').innerHTML = produitsOrdonnes()
    .map((p) => `<option value="${p.code}" ${p.v1 ? '' : 'disabled'}>${p.libelle}${p.v1 ? '' : ' (hors V1)'}</option>`)
    .join('');
}

function rendreChampsStatiques() {
  for (const el of document.querySelectorAll('[data-champ]')) {
    const champ = /** @type {HTMLInputElement} */ (el);
    if (champ.closest('tbody') || champ.closest('.liste')) continue;
    const v = lireChemin(etat, champ.dataset.champ ?? '');
    if (champ.type === 'checkbox') champ.checked = Boolean(v);
    else if (champ.dataset.type === 'pourcentage') champ.value = nul(v) ? '' : String(v * 100);
    else champ.value = nul(v) ? '' : String(v);
  }
}

/**
 * Structure des tables de saisie. Appelee seulement quand le NOMBRE ou l'IDENTITE
 * des lignes change : la reconstruire a chaque frappe detruit le focus et coupe la
 * saisie d'un decimal au moment du separateur.
 */
function rendreStructure() {
  // --- Programme : une ligne par tranche ---
  $('#table-programme').querySelector('tbody').innerHTML = etat.lots
    .map((lot, i) => {
      const options = produitsOrdonnes()
        .map((p) => `<option value="${p.code}" ${p.code === lot.code_produit ? 'selected' : ''} ${p.v1 ? '' : 'disabled'}>${p.libelle}</option>`)
        .join('');
      return `<tr data-tranche="${i}">
        <td><select data-champ="lots.${i}.code_produit" data-structure="1">${options}</select></td>
        <td><input type="number" step="1" min="0" data-champ="lots.${i}.nb_logements" data-type="nombre" value="${valNum(lot.nb_logements)}" /></td>
        <td><input type="number" step="0.01" min="0" data-champ="lots.${i}.shab_m2" data-type="nombre" value="${valNum(lot.shab_m2)}" /></td>
        <td><input type="number" step="0.01" min="0" data-champ="lots.${i}.surfaces_annexes_m2" data-type="nombre" value="${valNum(lot.surfaces_annexes_m2)}" /></td>
        <td class="calc" data-calc="su"></td>
        <td class="calc" data-calc="cs"></td>
        <td class="calc" data-calc="plafond"></td>
        <td><input type="number" step="0.01" data-champ="lots.${i}.marge_locale_eur_m2" data-type="nombre" value="${valNum(lot.marge_locale_eur_m2)}" /></td>
        <td><input type="number" step="0.01" min="0" data-champ="lots.${i}.loyer_sortie_force" data-type="nombre" value="${valNum(lot.loyer_sortie_force)}" /></td>
        <td class="calc" data-calc="loyer"></td>
        <td class="calc" data-calc="loyer_annuel"></td>
        <td><button type="button" class="bouton--supprimer" data-supprimer="lots" data-index="${i}" title="Supprimer">×</button></td>
      </tr>`;
    })
    .join('');

  // --- Postes de prix de revient ---
  $('#table-postes').querySelector('tbody').innerHTML = etat.postes_bilan
    .map(
      (p, i) => `<tr data-poste="${i}">
        <td><select data-champ="postes_bilan.${i}.chapitre" data-structure="1">
          ${Object.entries(CHAPITRES).map(([c, l]) => `<option value="${c}" ${c === p.chapitre ? 'selected' : ''}>${l}</option>`).join('')}
        </select></td>
        <td><input type="text" data-champ="postes_bilan.${i}.libelle" value="${att(p.libelle)}" /></td>
        <td><input type="number" step="1" data-champ="postes_bilan.${i}.montant_ht_eur" data-type="nombre" value="${valNum(p.montant_ht_eur)}" /></td>
        <td><select data-champ="postes_bilan.${i}.taux_tva" data-type="nombre">
          ${TAUX_TVA.map((v) => `<option value="${v}" ${v === p.taux_tva ? 'selected' : ''}>${(v * 100).toFixed(1)} %</option>`).join('')}
        </select></td>
        <td class="calc" data-calc="tva"></td>
        <td class="calc" data-calc="ttc"></td>
        <td><button type="button" class="bouton--supprimer" data-supprimer="postes_bilan" data-index="${i}" title="Supprimer">×</button></td>
      </tr>`,
    )
    .join('');

  // --- Subventions ---
  $('#table-subventions').querySelector('tbody').innerHTML = etat.subventions.length
    ? etat.subventions
        .map(
          (s, i) => `<tr>
        <td><input type="text" data-champ="subventions.${i}.libelle" value="${att(s.libelle)}" /></td>
        <td><input type="number" step="1" data-champ="subventions.${i}.montant_eur" data-type="nombre" value="${valNum(s.montant_eur)}" /></td>
        <td class="num"><input type="checkbox" data-champ="subventions.${i}.gratuite" data-type="booleen" ${s.gratuite ? 'checked' : ''} /></td>
        <td><button type="button" class="bouton--supprimer" data-supprimer="subventions" data-index="${i}" title="Supprimer">×</button></td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="4" class="vide">Aucune subvention</td></tr>';

  // --- Prets ---
  $('#liste-prets').innerHTML = etat.prets
    .map(
      (p, i) => `
      <div class="ligne ligne--pret">
        <label class="champ"><span>Libellé</span>
          <input type="text" data-champ="prets.${i}.libelle" value="${att(p.libelle)}" /></label>
        <label class="champ"><span>Montant (€)</span>
          <input type="number" step="1" min="0" data-champ="prets.${i}.montant_eur" data-type="nombre" value="${valNum(p.montant_eur)}" /></label>
        <label class="champ"><span>Nature</span>
          <select data-champ="prets.${i}.nature">
            ${['construction', 'foncier', 'autre'].map((n) => `<option value="${n}" ${n === p.nature ? 'selected' : ''}>${n}</option>`).join('')}
          </select></label>
        <button type="button" class="bouton--supprimer" data-supprimer="prets" data-index="${i}" title="Supprimer">×</button>
        <div class="ligne__pied">
          <label class="champ"><span>Taux saisi (%)</span>
            <input type="number" step="0.01" data-champ="prets.${i}.taux" data-type="pourcentage" value="${valNum(nul(p.taux) ? null : p.taux * 100)}" /></label>
          <label class="champ"><span>Durée (ans)</span>
            <input type="number" step="1" min="1" data-champ="prets.${i}.duree_ans" data-type="nombre" value="${valNum(p.duree_ans)}" /></label>
          <label class="champ"><span>1re échéance (année)</span>
            <input type="number" step="1" data-champ="prets.${i}.annee_premiere_echeance" data-type="nombre" value="${valNum(p.annee_premiere_echeance)}" /></label>
        </div>
        <div class="ligne__pied">
          <label class="champ"><span>Révisabilité</span>
            <select data-champ="prets.${i}.revisabilite">
              ${OPTIONS_REVISABILITE.map((v) => `<option value="${v}" ${v === p.revisabilite ? 'selected' : ''}>${v}</option>`).join('')}
            </select></label>
          <label class="champ"><span>Progressivité (%)</span>
            <input type="number" step="0.1" data-champ="prets.${i}.progressivite" data-type="pourcentage" value="${valNum(nul(p.progressivite) ? null : p.progressivite * 100)}" /></label>
          <label class="champ"><span>Différé (ans)</span>
            <input type="number" step="1" min="0" data-champ="prets.${i}.differe_ans" data-type="nombre" value="${valNum(p.differe_ans)}" /></label>
        </div>
        <div class="ligne__pied">
          <label class="champ"><span>Type de différé</span>
            <select data-champ="prets.${i}.differe_type" data-type="nombre">
              ${OPTIONS_DIFFERE.map((o) => `<option value="${o.v}" ${o.v === p.differe_type ? 'selected' : ''}>${o.l}</option>`).join('')}
            </select></label>
        </div>
      </div>`,
    )
    .join('');
}

// ---------------------------------------------------------------- rendu des valeurs

/** Remplit les cellules calculees et les pieds de table. Ne touche pas aux champs de saisie. */
function rendreValeurs(r) {
  const ind = r.indicateurs;

  // --- Programme ---
  const parProduit = {};
  for (const l of r.loyers) parProduit[l.code_produit] = l;
  for (const tr of document.querySelectorAll('#table-programme tbody tr')) {
    const i = Number(/** @type {HTMLElement} */ (tr).dataset.tranche);
    const c = parProduit[etat.lots[i]?.code_produit];
    const set = (cle, v) => {
      const td = tr.querySelector(`[data-calc="${cle}"]`);
      if (td) td.textContent = v;
    };
    set('su', c ? nb(c.su_m2) : '—');
    set('cs', c ? nb(c.cs) : '—');
    set('plafond', c ? nb(c.loyer_max_base_eur_m2) : '—');
    set('loyer', c ? nb(c.loyer_pratique_eur_m2) : '—');
    set('loyer_annuel', c ? eur(c.loyer_annuel_eur) : '—');
  }
  $('#table-programme').querySelector('tfoot').innerHTML = `<tr>
      <td class="libelle">Total opération</td>
      <td class="num">${nb(ind.nb_logements)}</td>
      <td class="num">${nb(ind.shab_m2)}</td>
      <td class="num">${nb(ind.surfaces_annexes_m2)}</td>
      <td class="num">${nb(ind.su_m2)}</td>
      <td colspan="5"></td>
      <td class="num">${eur(ind.loyers_annuels_eur)}</td>
      <td></td>
    </tr>`;

  // --- Postes : le detail vient du moteur, rien n'est recalcule ici ---
  const b = r.bilan;
  for (const tr of document.querySelectorAll('#table-postes tbody tr')) {
    const i = Number(/** @type {HTMLElement} */ (tr).dataset.poste);
    const d = b.postes[i];
    const set = (cle, v) => {
      const td = tr.querySelector(`[data-calc="${cle}"]`);
      if (td) td.textContent = v;
    };
    set('tva', d ? eur(d.tva_eur) : '—');
    set('ttc', d ? eur(d.ttc_eur) : '—');
  }
  $('#table-postes').querySelector('tfoot').innerHTML = `<tr>
      <td class="libelle" colspan="2">Total</td>
      <td class="num">${eur(b.total_ht_eur)}</td><td></td>
      <td class="num">${eur(b.total_tva_eur)}</td>
      <td class="num">${eur(b.total_ttc_eur)}</td><td></td>
    </tr>
    <tr>
      <td class="libelle" colspan="2">Base finançable (TTC / LASM)</td>
      <td colspan="3"></td>
      <td class="num">${eur(b.total_ttc_module_eur)}</td><td></td>
    </tr>`;
  $('#aide-lasm').textContent =
    `⚙ La base finançable applique le taux de livraison à soi-même du produit principal ` +
    `(${pct(b.taux_lasm, 1)}), et non les taux de TVA de saisie. C'est elle que le plan de ` +
    `financement doit couvrir.`;

  // --- Subventions ---
  $('#table-subventions').querySelector('tfoot').innerHTML = `<tr>
      <td class="libelle">Total</td>
      <td class="num">${eur(r.subventions.total_avec_ssf_eur)}</td>
      <td class="num" colspan="2" style="font-weight:400;color:var(--encre-doux)">dont gratuites ${eur(r.subventions.gratuites_eur)}</td>
    </tr>`;

  // --- Prets ---
  for (const bt of document.querySelectorAll('[data-mode-prets]')) {
    bt.setAttribute('aria-pressed', String(bt.getAttribute('data-mode-prets') === etat.mode_prets));
  }
  const theorique = etat.mode_prets === 'theoriques';
  $('#prets-saisis').hidden = theorique;
  $('#prets-theoriques').hidden = !theorique;
  if (theorique) {
    const lignes = r.amortissements
      .map(
        (a) =>
          `<div><strong>${att(a.libelle)}</strong> — ${eur(a.montant_eur)}, ${a.tableau.length} ans, ` +
          `taux appliqué ${pct(a.tableau[0].taux)}, 1<sup>re</sup> échéance ${a.annee_premiere_echeance}</div>`,
      )
      .join('');
    $('#prets-theoriques').innerHTML =
      (lignes ||
        `<div class="vide">Aucun prêt CDC mobilisé : le solde à financer vaut ` +
          `${eur(r.financement.solde_a_financer_eur)}.</div>`) +
      `<p class="aide" style="margin-top:10px">Montants, durées et taux déduits du solde à financer ` +
      `et des règles du produit (R-AMT-1, R-FIN-4). Basculer sur « Saisis » pour les reprendre à la main.</p>`;
  }

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
  const alerteTranches = r.alertes.find((a) => /tranches/i.test(a));
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
      ok: !alerteTranches,
      libelle: alerteTranches ?? 'Opération mono-produit : taux de livraison à soi-même unique',
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
  const reprises = [alerteHorizon, alerteTranches, alerteLignes].filter(Boolean);
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

/** Vue courante du compte : jalons (defaut) ou annee par annee. */
let vueExploitation = 'jalons';

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
    `Compte partiel : ${e.postes_absents.length} familles de postes ne sont pas encore modélisées.</span>`;

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
    tableau('Coefficient de structure', cs.source, ['Cas', 'Base', 'Facteur logements'], [
      ['Métropole habitat', nb(cs.metropole_habitat.base), nb(cs.metropole_habitat.facteur_nl)],
      ['Foyers', nb(cs.metropole_habitat.base), nb(cs.foyers.facteur_nl)],
      ['DOM', nb(cs.dom.base), nb(cs.dom.facteur_nl)],
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
  if (!etat.lots.length) m.push('au moins une tranche de programme');
  etat.lots.forEach((l, i) => {
    if (nul(l.nb_logements)) m.push(`nombre de logements de la ligne ${i + 1}`);
    if (nul(l.shab_m2)) m.push(`SHAB de la ligne ${i + 1}`);
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
function rafraichirTout() {
  rendreStructure();
  recalculer();
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
  } else if (el.dataset.type === 'booleen') {
    valeur = el.checked;
  } else {
    valeur = el.value === '' ? null : el.value;
  }

  ecrireChemin(etat, chemin, valeur);

  if (chemin === 'identite.produit' && etat.lots.length === 1) {
    etat.lots[0].code_produit = valeur;
    rafraichirTout();
    return;
  }

  // Un changement de produit ou de chapitre reordonne la restitution : on
  // reconstruit. Sinon on ne met a jour que les valeurs, ce qui preserve le focus.
  if (el.dataset.structure) rafraichirTout();
  else recalculer();
});

document.addEventListener('click', (ev) => {
  const el = /** @type {HTMLElement} */ (ev.target);

  const onglet = el.closest('[data-ecran]');
  if (onglet) {
    const cible = /** @type {HTMLElement} */ (onglet).dataset.ecran;
    for (const o of document.querySelectorAll('[data-ecran]')) {
      o.setAttribute('aria-selected', String(/** @type {HTMLElement} */ (o).dataset.ecran === cible));
    }
    for (const e of document.querySelectorAll('.ecran')) {
      /** @type {HTMLElement} */ (e).hidden = e.id !== `ecran-${cible}`;
    }
    if (cible === 'parametres') rendreParametres();
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

  const aAjouter = el.dataset?.ajouter;
  if (aAjouter) {
    if (aAjouter === 'lots') {
      // Une ligne = une tranche de financement. Proposer un produit deja present
      // creerait deux lignes agregees en une seule, aux valeurs identiques.
      const utilises = new Set(etat.lots.map((l) => l.code_produit));
      const libre = produitsOrdonnes().find((p) => p.v1 && !utilises.has(p.code));
      if (!libre) {
        window.alert('Tous les produits du périmètre V1 sont déjà présents dans le programme.');
        return;
      }
      etat.lots.push({
        code_produit: libre.code, nb_logements: 0, shab_m2: 0,
        surfaces_annexes_m2: 0, marge_locale_eur_m2: 0,
      });
    } else {
      const modeles = {
        postes_bilan: { chapitre: 'batiment', libelle: 'Nouveau poste', montant_ht_eur: 0, taux_tva: 0.1 },
        subventions: { libelle: 'Nouvelle subvention', montant_eur: 0, gratuite: false },
        prets: {
          code: `PRET_${etat.prets.length + 1}`, libelle: 'Nouveau prêt', nature: 'autre',
          montant_eur: 0, taux: 0.02, progressivite: 0, duree_ans: 40,
          annee_premiere_echeance: dernierResultat?.calendrier?.annee_mise_en_location ?? 2028,
          revisabilite: 'TAUX FIXE', differe_ans: 0, differe_type: 2,
        },
      };
      etat[aAjouter].push(structuredClone(modeles[aAjouter]));
    }
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

rendreSelectProduit();
rendreChampsStatiques();
rafraichirTout();
