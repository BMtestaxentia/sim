// @ts-check
/**
 * Interface de montage d'operation : saisie, plan de financement, parametres.
 *
 * Importe `src/moteur.js` TEL QUEL : le moteur est de l'ESM pur, il tourne dans
 * le navigateur sans build ni transpilation (exigence CLAUDE.md §3).
 *
 * Cette couche ne contient AUCUNE regle de calcul. Elle collecte des entrees,
 * appelle `calculer()` et met en forme le resultat. Toute valeur affichee vient
 * du moteur, y compris les dates derivees et les prets CDC theoriques.
 *
 * Ergonomie reprise de la maquette LEON REWORK (12 onglets) : ecrans separes,
 * unites dans les libelles, blocs ordonnes du general au particulier, notes de
 * renvoi prefixees d'un engrenage. Correction du seul defaut de la maquette :
 * elle ne distingue pas visuellement le saisi du calcule, ici tout champ
 * calcule porte la classe `--calcule` et n'est pas focusable.
 *
 * Un seul fichier a dessein : le generateur de la version autonome concatene
 * tout dans une portee unique et refuse les collisions de noms racine.
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

/** Operation de depart : 6 logements PLS, calquee sur la structure BERGERAC. */
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
      annee_premiere_echeance: 2028, revisabilite: 'SIMPLE', differe_ans: 0,
      livret_a_origine: 0.024, livret_a_par_annee: { 2028: 0.02 },
    },
    {
      code: 'PLS_FONCIER', libelle: 'PLS foncier', nature: 'foncier',
      montant_eur: 176035, taux: 0.0351, progressivite: 0, duree_ans: 50,
      annee_premiere_echeance: 2028, revisabilite: 'SIMPLE', differe_ans: 0,
      livret_a_origine: 0.024, livret_a_par_annee: { 2028: 0.02 },
    },
  ],
  exploitation: {
    frais_gestion_pct_loyers: 0.07,
    taux_vacance_impayes: 0.02,
    gros_entretien_eur_m2: 5,
    // Aucune trajectoire en dur : le moteur applique le profil du referentiel.
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

const CHAPITRES = {
  charge_fonciere: 'Charge foncière',
  batiment: 'Bâtiment',
  honoraires: 'Honoraires',
  frais_divers: 'Frais divers',
};

const OPTIONS_REVISABILITE =['DOUBLE', 'D. LIMITEE', 'SIMPLE', 'TAUX FIXE'];
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

/** Valeur d'un champ numerique : vide reste vide, jamais converti en zero. */
function valNum(v) {
  return nul(v) ? '' : v;
}

// ---------------------------------------------------------------- rendu saisie

function rendreSelectProduit() {
  $('#select-produit').innerHTML = produitsOrdonnes()
    .map(
      (p) =>
        `<option value="${p.code}" ${p.v1 ? '' : 'disabled'}>${p.libelle}${p.v1 ? '' : ' (hors V1)'}</option>`,
    )
    .join('');
}

function rendreChampsStatiques() {
  for (const el of document.querySelectorAll('[data-champ]')) {
    const champ = /** @type {HTMLInputElement} */ (el);
    if (champ.closest('tbody') || champ.closest('.liste')) continue;
    const v = lireChemin(etat, champ.dataset.champ ?? '');
    if (champ.type === 'checkbox') champ.checked = Boolean(v);
    else champ.value = nul(v) ? '' : String(v);
  }
}

/** Table du programme : une ligne par tranche de financement. */
function rendreProgramme(r) {
  const corps = $('#table-programme').querySelector('tbody');
  const pied = $('#table-programme').querySelector('tfoot');

  // Les colonnes calculees viennent du resultat, apparie par code produit.
  const parProduit = {};
  for (const l of r?.loyers ?? []) parProduit[l.code_produit] = l;

  corps.innerHTML = etat.lots
    .map((lot, i) => {
      const c = parProduit[lot.code_produit];
      const options = produitsOrdonnes()
        .map((p) => `<option value="${p.code}" ${p.code === lot.code_produit ? 'selected' : ''} ${p.v1 ? '' : 'disabled'}>${p.libelle}</option>`)
        .join('');
      return `<tr>
        <td><select data-champ="lots.${i}.code_produit">${options}</select></td>
        <td><input type="number" step="1" min="0" data-champ="lots.${i}.nb_logements" data-type="nombre" data-requis="1" value="${valNum(lot.nb_logements)}" /></td>
        <td><input type="number" step="0.01" min="0" data-champ="lots.${i}.shab_m2" data-type="nombre" data-requis="1" value="${valNum(lot.shab_m2)}" /></td>
        <td><input type="number" step="0.01" min="0" data-champ="lots.${i}.surfaces_annexes_m2" data-type="nombre" value="${valNum(lot.surfaces_annexes_m2)}" /></td>
        <td class="calc">${c ? nb(c.su_m2) : '—'}</td>
        <td class="calc">${c ? nb(c.cs) : '—'}</td>
        <td class="calc">${c ? nb(c.loyer_max_base_eur_m2) : '—'}</td>
        <td><input type="number" step="0.01" data-champ="lots.${i}.marge_locale_eur_m2" data-type="nombre" value="${valNum(lot.marge_locale_eur_m2)}" /></td>
        <td><input type="number" step="0.01" min="0" data-champ="lots.${i}.loyer_sortie_force" data-type="nombre" placeholder="${c ? nb(c.loyer_max_base_eur_m2) : ''}" value="${valNum(lot.loyer_sortie_force)}" /></td>
        <td class="calc">${c ? nb(c.loyer_pratique_eur_m2) : '—'}</td>
        <td class="calc">${c ? eur(c.loyer_annuel_eur) : '—'}</td>
        <td><button type="button" class="bouton--supprimer" data-supprimer="lots" data-index="${i}" title="Supprimer">×</button></td>
      </tr>`;
    })
    .join('');

  const t = (cle) => etat.lots.reduce((s, l) => s + (Number(l[cle]) || 0), 0);
  const suTotal = (r?.loyers ?? []).reduce((s, l) => s + l.su_m2, 0);
  const loyerTotal = (r?.loyers ?? []).reduce((s, l) => s + l.loyer_annuel_eur, 0);
  pied.innerHTML = `<tr>
      <td class="libelle">Total</td>
      <td class="num">${nb(t('nb_logements'))}</td>
      <td class="num">${nb(t('shab_m2'))}</td>
      <td class="num">${nb(t('surfaces_annexes_m2'))}</td>
      <td class="num">${nb(suTotal)}</td>
      <td colspan="5"></td>
      <td class="num">${eur(loyerTotal)}</td>
      <td></td>
    </tr>`;
}

function rendrePostes(r) {
  const corps = $('#table-postes').querySelector('tbody');
  const pied = $('#table-postes').querySelector('tfoot');

  corps.innerHTML = etat.postes_bilan
    .map((p, i) => {
      const tva = (Number(p.montant_ht_eur) || 0) * (Number(p.taux_tva) || 0);
      return `<tr>
        <td><select data-champ="postes_bilan.${i}.chapitre">
          ${Object.entries(CHAPITRES).map(([c, l]) => `<option value="${c}" ${c === p.chapitre ? 'selected' : ''}>${l}</option>`).join('')}
        </select></td>
        <td><input type="text" data-champ="postes_bilan.${i}.libelle" value="${att(p.libelle)}" /></td>
        <td><input type="number" step="1" data-champ="postes_bilan.${i}.montant_ht_eur" data-type="nombre" value="${valNum(p.montant_ht_eur)}" /></td>
        <td><select data-champ="postes_bilan.${i}.taux_tva" data-type="nombre">
          ${TAUX_TVA.map((v) => `<option value="${v}" ${v === p.taux_tva ? 'selected' : ''}>${(v * 100).toFixed(1)} %</option>`).join('')}
        </select></td>
        <td class="calc">${eur(tva)}</td>
        <td class="calc">${eur((Number(p.montant_ht_eur) || 0) + tva)}</td>
        <td><button type="button" class="bouton--supprimer" data-supprimer="postes_bilan" data-index="${i}" title="Supprimer">×</button></td>
      </tr>`;
    })
    .join('');

  const b = r?.bilan;
  pied.innerHTML = `<tr>
      <td class="libelle" colspan="2">Total</td>
      <td class="num">${eur(b?.total_ht_eur)}</td>
      <td></td>
      <td class="num">${eur(b?.total_tva_eur)}</td>
      <td class="num">${eur(b?.total_ttc_eur)}</td>
      <td></td>
    </tr>
    <tr>
      <td class="libelle" colspan="2">Base finançable (TTC / LASM)</td>
      <td colspan="3"></td>
      <td class="num">${eur(b?.total_ttc_module_eur)}</td>
      <td></td>
    </tr>`;

  $('#aide-lasm').textContent = b
    ? `⚙ La base finançable applique le taux de livraison à soi-même du produit principal ` +
      `(${pct(b.taux_lasm, 1)}), et non les taux de TVA de saisie. C'est elle qui doit être ` +
      `couverte par le plan de financement.`
    : '';
}

function rendreSubventions(r) {
  const corps = $('#table-subventions').querySelector('tbody');
  const pied = $('#table-subventions').querySelector('tfoot');

  corps.innerHTML = etat.subventions.length
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

  const s = r?.subventions;
  pied.innerHTML = `<tr>
      <td class="libelle">Total</td>
      <td class="num">${eur(s?.total_avec_ssf_eur)}</td>
      <td class="num" colspan="2" style="font-weight:400;color:var(--encre-doux)">dont gratuites ${eur(s?.gratuites_eur)}</td>
    </tr>`;
}

function rendrePrets(r) {
  for (const b of document.querySelectorAll('[data-mode-prets]')) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-mode-prets') === etat.mode_prets));
  }
  const theorique = etat.mode_prets === 'theoriques';
  $('#prets-saisis').hidden = theorique;
  $('#prets-theoriques').hidden = !theorique;

  if (theorique) {
    const lignes = (r?.amortissements ?? [])
      .map(
        (a) =>
          `<div><strong>${att(a.libelle)}</strong> — ${eur(a.montant_eur)}, ${a.tableau.length} ans, ` +
          `taux appliqué ${pct(a.tableau[0].taux)}, 1<sup>re</sup> échéance ${a.annee_premiere_echeance}</div>`,
      )
      .join('');
    $('#prets-theoriques').innerHTML =
      (lignes || '<div class="vide">Aucun prêt CDC mobilisé : le solde à financer est nul ou négatif.</div>') +
      `<p class="aide" style="margin-top:10px">Montants, durées et taux déduits du solde à financer et ` +
      `des règles du produit (R-AMT-1, R-FIN-4). Basculer sur « Saisis » pour les reprendre à la main.</p>`;
    return;
  }

  $('#liste-prets').innerHTML = etat.prets
    .map(
      (p, i) => `
      <div class="ligne ligne--pret">
        <label class="champ"><span>Libellé</span>
          <input type="text" data-champ="prets.${i}.libelle" value="${att(p.libelle)}" /></label>
        <label class="champ"><span>Montant (€)</span>
          <input type="number" step="1" data-champ="prets.${i}.montant_eur" data-type="nombre" value="${valNum(p.montant_eur)}" /></label>
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
      </div>`,
    )
    .join('');
}

function rendreCalendrier(r) {
  const c = r?.calendrier;
  $('#date-mel').value = c?.date_mise_en_location ?? '';
  // Une date de livraison deduite se presente comme calculee, une date saisie non.
  const champLivraison = /** @type {HTMLInputElement} */ (
    document.querySelector('[data-champ="dates.date_livraison"]')
  );
  const deduite = c?.origine?.date_livraison === 'calcule';
  champLivraison.classList.toggle('champ--calcule', deduite);
  if (deduite) champLivraison.value = c?.date_livraison ?? '';
}

// ---------------------------------------------------------------- rendu resultats

function rendreBarre(element, segments, echelle) {
  element.innerHTML = segments
    .filter((s) => s.montant > 0)
    .map((s) => {
      const etiquette = s.montant / echelle > 0.07 ? `<span>${eur(s.montant)}</span>` : '';
      return `<div class="segment" style="flex-grow:${s.montant};background:${s.couleur}" title="${att(s.libelle)} : ${eur(s.montant)}">${etiquette}</div>`;
    })
    .join('');
  const total = segments.reduce((t, s) => t + Math.max(0, s.montant), 0);
  if (total < echelle) {
    element.insertAdjacentHTML('beforeend', `<div style="flex-grow:${echelle - total}"></div>`);
  }
}

function rendreFinancement(r) {
  // --- Emplois et ressources ---
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
  if (r.subventions.total_avec_ssf_eur > 0) {
    ressources.push({ libelle: 'Subventions', montant: r.subventions.total_avec_ssf_eur, couleur: COULEURS.subventions });
  }
  if (etat.fonds_propres_eur > 0) {
    ressources.push({ libelle: 'Fonds propres', montant: etat.fonds_propres_eur, couleur: COULEURS.fonds_propres });
  }
  for (const a of r.amortissements) {
    if (!(a.montant_eur > 0)) continue;
    ressources.push({
      libelle: a.libelle || a.code,
      montant: a.montant_eur,
      couleur: COULEURS[`pret_${a.nature}`] ?? COULEURS.pret_autre,
    });
  }

  const totalEmplois = emplois.reduce((t, s) => t + s.montant, 0);
  const totalRessources = ressources.reduce((t, s) => t + s.montant, 0);
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

  // --- Tableau des emplois ---
  const tEmplois = $('#table-emplois');
  tEmplois.querySelector('tbody').innerHTML = emplois
    .map(
      (e) => `<tr><td>${att(e.libelle)}</td><td class="num">${eur(e.ht)}</td>
        <td class="num">${eur(e.montant)}</td>
        <td class="num">${totalEmplois ? pct(e.montant / totalEmplois, 1) : '—'}</td></tr>`,
    )
    .join('');
  const ind = r.indicateurs;
  tEmplois.querySelector('tfoot').innerHTML = `<tr>
      <td class="libelle">Total</td><td class="num">${eur(r.bilan.total_ht_eur)}</td>
      <td class="num">${eur(totalEmplois)}</td><td class="num">100 %</td></tr>
    <tr><td colspan="4" style="font-weight:400;color:var(--encre-doux);border-top:none">
      ${eur(ind.prix_revient_par_logement_eur)} / logement · ${eur(ind.prix_revient_par_m2_shab_eur)} / m² SHAB
    </td></tr>`;

  // --- Tableau des ressources ---
  const tRes = $('#table-ressources');
  tRes.querySelector('tbody').innerHTML = ressources
    .map(
      (s) => `<tr><td>${att(s.libelle)}</td><td class="num">${eur(s.montant)}</td>
        <td class="num">${totalRessources ? pct(s.montant / totalRessources, 1) : '—'}</td></tr>`,
    )
    .join('');
  tRes.querySelector('tfoot').innerHTML = `<tr>
      <td class="libelle">Total</td><td class="num">${eur(totalRessources)}</td><td class="num">100 %</td></tr>
    <tr><td class="libelle">Solde à financer</td>
      <td class="num">${eur(r.financement.solde_a_financer_eur)}</td><td></td></tr>`;

  // --- Prets ---
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
          <td>${att(a.libelle)}</td>
          <td class="num">${eur(a.montant_eur)}</td>
          <td class="num">${nul(a.taux_saisi) ? '—' : pct(a.taux_saisi)}</td>
          <td class="num">${pct(t[0].taux)}</td>
          <td class="num">${t.length} ans</td>
          <td class="num">${t[0].annee}</td>
          <td class="num">${eur(t[0].annuite_eur)}</td>
          <td class="num">${eur(t.at(-1).annuite_eur)}</td>
          <td class="num">${eur(total)}</td>
        </tr>`;
      })
      .join('');
    const totalMontant = r.amortissements.reduce((s, a) => s + a.montant_eur, 0);
    const totalAnnuites = r.amortissements.reduce(
      (s, a) => s + a.tableau.reduce((x, l) => x + l.annuite_eur, 0),
      0,
    );
    pied.innerHTML = `<tr><td class="libelle">Total</td><td class="num">${eur(totalMontant)}</td>
      <td colspan="6"></td><td class="num">${eur(totalAnnuites)}</td></tr>`;
  }

  const ecarts = r.amortissements.filter(
    (a) => !nul(a.taux_saisi) && Math.abs(a.tableau[0].taux - a.taux_saisi) > 1e-9,
  );
  $('#aide-taux').textContent = ecarts.length
    ? `⚙ Le taux appliqué diffère du taux saisi : la révision Livret A joue dès la première ` +
      `échéance. Profil ${r.profil_trajectoires ?? 'non renseigné'}.`
    : '';

  // --- Indicateurs ---
  $('#indicateurs').innerHTML = [
    { l: 'Prix de revient', v: eur(ind.prix_revient_ttc_eur), d: `${eur(ind.prix_revient_par_logement_eur)} / logement` },
    { l: 'Coût au m² SHAB', v: eur(ind.prix_revient_par_m2_shab_eur), d: `${nb(ind.shab_m2)} m² SHAB` },
    { l: 'Surface utile', v: `${nb(ind.su_m2)} m²`, d: `${ind.nb_logements} logements` },
    { l: 'Loyers annuels', v: eur(ind.loyers_annuels_eur), d: `RMO ${pct(ind.rmo)}` },
    { l: 'Fonds propres', v: pct(ind.taux_fonds_propres), d: eur(etat.fonds_propres_eur) },
    { l: 'Prêts CDC', v: pct(r.financement.equilibre.ratio_prets_cdc), d: eur(r.financement.total_prets_cdc_eur) },
    { l: 'Reconstitution FP', v: ind.annee_reconstitution_fonds_propres ?? 'non atteinte', d: `TFPB dès ${ind.annee_debut_tfpb}` },
  ]
    .map(
      (i) => `<div class="indicateur"><div class="indicateur__libelle">${i.l}</div>
        <div class="indicateur__valeur">${i.v}</div><div class="indicateur__detail">${i.d}</div></div>`,
    )
    .join('');

  rendreControles(r);
}

/**
 * Controles TOUJOURS visibles, y compris quand ils passent : masquer un controle
 * satisfait rend l'absence d'alerte indistinguable de l'absence de controle.
 */
function rendreControles(r) {
  const eq = r.financement.equilibre;
  const mini = referentiels.baremes.constantes_reglementaires.controle_ratio_prets_cdc_min.valeur;

  const controles = [
    {
      ok: eq.equilibre,
      libelle: eq.equilibre
        ? 'Emplois et ressources s’équilibrent'
        : `Emplois et ressources : écart de ${eur(eq.ecart_eur)}`,
      grave: true,
    },
    {
      ok: eq.ratio_prets_cdc === null || eq.ratio_prets_cdc >= mini,
      libelle: `Ratio prêts CDC ${pct(eq.ratio_prets_cdc)} pour un minimum réglementaire de ${pct(mini, 0)}`,
    },
    {
      ok: !r.loyers.some((l) => l.force && l.loyer_pratique_eur_m2 > l.loyer_max_base_eur_m2),
      libelle: 'Loyers de sortie dans le plafond réglementaire',
    },
    {
      ok: !r.alertes.some((a) => /horizon de simulation/i.test(a)),
      libelle: "Toutes les annuités tombent dans l’horizon de simulation",
    },
    {
      ok: r.surfaces.tranches.length <= 1,
      libelle:
        r.surfaces.tranches.length <= 1
          ? 'Opération mono-produit : taux de livraison à soi-même unique'
          : `Opération à ${r.surfaces.tranches.length} tranches, un seul taux de LASM appliqué`,
    },
  ];

  const passes = controles.filter((c) => c.ok).length;
  const echecs = controles.length - passes;

  $('#controles').innerHTML = controles
    .map((c) => {
      const classe = c.ok ? 'ok' : c.grave ? 'erreur' : 'alerte';
      const etat = c.ok ? 'OK' : c.grave ? 'Erreur' : 'Alerte';
      return `<li class="controle controle--${classe}">
        <span class="controle__etat">${etat}</span>
        <span class="controle__texte">${c.libelle}</span></li>`;
    })
    .join('');

  const bandeau = $('#bandeau-controle');
  const bloquant = controles.some((c) => !c.ok && c.grave);
  bandeau.className = `bandeau ${bloquant ? 'bandeau--erreur' : echecs ? 'bandeau--alerte' : 'bandeau--ok'}`;
  bandeau.innerHTML =
    `<span class="bandeau__principal">${
      eq.equilibre ? 'Plan de financement équilibré' : `Écart de ${eur(eq.ecart_eur)}`
    }</span>` +
    `<span class="bandeau__detail">${passes} contrôle${passes > 1 ? 's' : ''} sur ${controles.length} ` +
    `${passes > 1 ? 'passés' : 'passé'}${echecs ? `, ${echecs} à examiner` : ''}.</span>`;
}

// ---------------------------------------------------------------- ecran parametres

function rendreParametres() {
  const b = referentiels.baremes;
  const t = referentiels.trajectoires;

  $('#bandeau-parametres').innerHTML =
    `<span class="bandeau__principal">Lecture seule</span>` +
    `<span class="bandeau__detail">Barèmes ${b.date_valeur} · profil ${t.profil}. ` +
    `Ces valeurs sont versionnées dans le dépôt : les modifier ici rendrait les simulations ` +
    `non reproductibles.</span>`;

  const tableau = (titre, source, entetes, lignes) => `
    <section class="bloc para-groupe">
      <h3>${titre}</h3>
      ${source ? `<p class="para-source">${att(source)}</p>` : ''}
      <div class="table-defilante"><table class="tableau">
        <thead><tr>${entetes.map((e, i) => `<th ${i ? 'class="num"' : ''}>${e}</th>`).join('')}</tr></thead>
        <tbody>${lignes
          .map((l) => `<tr>${l.map((c, i) => `<td ${i ? 'class="num"' : ''}>${c}</td>`).join('')}</tr>`)
          .join('')}</tbody>
      </table></div>
    </section>`;

  const lm123 = b.loyers_max_zone_123;
  const lmABC = b.loyers_max_zone_ABC;
  const cs = b.constantes_reglementaires.coefficient_structure;

  const blocs = [
    tableau(
      'Loyers plafonds par zone 1/2/3 (€/m² SU/mois)',
      lm123.source,
      ['Produit', ...lm123.zones],
      ['PLUS', 'PLAI', 'LIBRE'].map((p) => [p, ...lm123[p].map((v) => nb(v))]),
    ),
    tableau(
      'Loyers plafonds par zone A/B/C (€/m² SU/mois)',
      lmABC.source,
      ['Produit', ...lmABC.zones],
      ['PLS', 'PLI'].map((p) => [p, ...lmABC[p].map((v) => nb(v))]),
    ),
    tableau(
      'Prêts CDC par défaut',
      'R-AMT-1 ; spreads confirmés par la maquette LEON REWORK (ADMIN!C43:C46)',
      ['Produit', 'Nature', 'Taux', 'Durée', 'Révisabilité'],
      produitsOrdonnes().flatMap((p) =>
        p.prets_defaut.map((d) => [p.libelle, d.nature, d.taux_ref, d.duree_ref, d.revisabilite]),
      ),
    ),
    tableau(
      'Taux de livraison à soi-même',
      b.tva.source,
      ['Clé', 'Taux'],
      Object.entries(b.tva.lasm_par_produit)
        .filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => [k, pct(v, 1)]),
    ),
    tableau(
      'Coefficient de structure',
      cs.source,
      ['Cas', 'Base', 'Facteur logements'],
      [
        ['Métropole habitat', nb(cs.metropole_habitat.base), nb(cs.metropole_habitat.facteur_nl)],
        ['Foyers', nb(cs.metropole_habitat.base), nb(cs.foyers.facteur_nl)],
        ['DOM', nb(cs.dom.base), nb(cs.dom.facteur_nl)],
      ],
    ),
    tableau(
      'Trajectoires macro',
      `${t.source} — ${t.trajectoires.length} années, de ${t.trajectoires[0].annee} à ${t.trajectoires.at(-1).annee}`,
      ['Année', 'Loyers / IRL', 'Gros entretien', 'Gestion', 'TFPB', 'Livret A'],
      t.trajectoires
        .slice(0, 15)
        .map((l) => [
          l.annee, pct(l.loyers_irl), pct(l.gros_entretien), pct(l.gestion), pct(l.tfpb), pct(l.livret_a),
        ]),
    ),
  ];

  $('#contenu-parametres').innerHTML = blocs.join('');
}

// ---------------------------------------------------------------- boucle de calcul

let dernierResultat = null;

/** Champs numeriques obligatoires : on refuse de calculer avec un zero implicite. */
function champsManquants() {
  const manquants = [];
  if (nul(etat.dates.duree_simulation_ans)) manquants.push('durée de simulation');
  etat.lots.forEach((l, i) => {
    if (nul(l.nb_logements)) manquants.push(`nombre de logements de la tranche ${i + 1}`);
    if (nul(l.shab_m2)) manquants.push(`SHAB de la tranche ${i + 1}`);
  });
  return manquants;
}

function recalculer() {
  const pastille = $('#etat-calcul');
  pastille.textContent = 'calcul…';
  pastille.className = 'pastille pastille--calcul';

  const manquants = champsManquants();
  if (manquants.length) {
    $('#erreur').hidden = false;
    $('#erreur').textContent = `Saisie incomplète : ${manquants.join(', ')}.`;
    pastille.textContent = 'incomplet';
    return;
  }

  try {
    // Le moteur est pur : on peut l'appeler a chaque frappe sans effet de bord.
    // En mode « CDC theoriques », on ne lui transmet aucun pret : c'est l'absence
    // de pret saisi qui declenche le calcul theorique (R-FIN-4).
    const entrees = structuredClone(etat);
    if (etat.mode_prets === 'theoriques') entrees.prets = [];
    const r = calculer(entrees, referentiels);
    dernierResultat = r;
    $('#erreur').hidden = true;
    $('#version-moteur').textContent = `v${r.version_moteur}`;

    rendreCalendrier(r);
    rendreProgramme(r);
    rendrePostes(r);
    rendreSubventions(r);
    rendrePrets(r);
    rendreFinancement(r);

    pastille.textContent = 'à jour';
    pastille.className = 'pastille pastille--ok';
  } catch (e) {
    $('#erreur').hidden = false;
    $('#erreur').textContent = `Calcul impossible : ${/** @type {Error} */ (e).message}`;
    pastille.textContent = 'erreur';
  }
}

// ---------------------------------------------------------------- evenements

document.addEventListener('input', (ev) => {
  const el = /** @type {HTMLInputElement} */ (ev.target);
  const chemin = el.dataset?.champ;
  if (!chemin) return;

  let valeur;
  if (el.dataset.type === 'nombre' || el.dataset.type === 'pourcentage') {
    // Un champ vide reste vide : il ne devient jamais zero silencieusement.
    if (el.value === '') valeur = null;
    else {
      const n = Number(el.value);
      if (Number.isNaN(n)) return; // saisie transitoire
      valeur = el.dataset.type === 'pourcentage' ? n / 100 : n;
    }
  } else if (el.dataset.type === 'booleen') {
    valeur = el.checked;
  } else {
    valeur = el.value === '' ? null : el.value;
  }

  ecrireChemin(etat, chemin, valeur);

  // Changer le produit principal aligne la premiere tranche si elle est seule.
  if (chemin === 'identite.produit' && etat.lots.length === 1) {
    etat.lots[0].code_produit = valeur;
  }

  // Une saisie dans un tableau en modifie les colonnes calculees : on garde le
  // focus en ne rendant que les resultats, pas la structure de la table.
  const dansTable = Boolean(el.closest('tbody'));
  const focus = /** @type {HTMLElement} */ (document.activeElement);
  const cheminFocus = focus?.dataset?.champ;
  const position = /** @type {HTMLInputElement} */ (focus)?.selectionStart ?? null;

  recalculer();

  if (dansTable && cheminFocus) {
    const cible = /** @type {HTMLInputElement} */ (
      document.querySelector(`[data-champ="${cheminFocus}"]`)
    );
    if (cible && cible !== document.activeElement) {
      cible.focus();
      if (position !== null && cible.setSelectionRange) {
        try { cible.setSelectionRange(position, position); } catch { /* type non compatible */ }
      }
    }
  }
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

  const mode = el.dataset?.modePrets;
  if (mode) {
    // Le mode ne DETRUIT PAS la saisie : les prets saisis restent dans l'etat et
    // sont simplement ignores le temps du mode theorique. Basculer et revenir
    // doit etre sans perte.
    etat.mode_prets = mode;
    recalculer();
    return;
  }

  const aAjouter = el.dataset?.ajouter;
  if (aAjouter) {
    const modeles = {
      lots: { code_produit: etat.identite.produit, nb_logements: 0, shab_m2: 0, surfaces_annexes_m2: 0, marge_locale_eur_m2: 0 },
      postes_bilan: { chapitre: 'batiment', libelle: 'Nouveau poste', montant_ht_eur: 0, taux_tva: 0.1 },
      subventions: { libelle: 'Nouvelle subvention', montant_eur: 0, gratuite: false },
      prets: {
        code: `PRET_${etat.prets.length + 1}`, libelle: 'Nouveau prêt', nature: 'autre',
        montant_eur: 0, taux: 0.02, progressivite: 0, duree_ans: 40,
        annee_premiere_echeance: dernierResultat?.calendrier?.annee_mise_en_location ?? 2028,
        revisabilite: 'TAUX FIXE', differe_ans: 0,
      },
    };
    etat[aAjouter].push(structuredClone(modeles[aAjouter]));
    recalculer();
    return;
  }

  const aSupprimer = el.dataset?.supprimer;
  if (aSupprimer) {
    etat[aSupprimer].splice(Number(el.dataset.index), 1);
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

rendreSelectProduit();
rendreChampsStatiques();
recalculer();
