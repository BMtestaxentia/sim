// @ts-check
/**
 * DOMAINE « PRIX DE REVIENT » - R-TVA : postes, TVA, livraison a soi-meme et
 * ventilation par tranche.
 *
 * Chaque poste se saisit une fois, globalement ou tranche par tranche. Saisi
 * globalement, il se repartit au prorata de la surface utile (R-TVA-3) ; chaque
 * tranche applique ENSUITE son propre taux de livraison a soi-meme (R-TVA-2) :
 * un PLAI et un logement libre ne portent pas la meme TVA finale sur le meme
 * poste.
 *
 * Aucun arrondi pendant la ventilation : les montants restent exacts jusqu'aux
 * totaux, ou la repartition sans perte garantit que les tranches somment
 * exactement le total de l'operation, et les chapitres le prix de revient.
 *
 * Sources : BilPLS!D:J (saisie par poste), maquette LEON REWORK PDR!B3
 * (« saisie HT globale, ventilation au prorata SU »), referentiel tva.
 */
import { produit } from '../../produits.js';

/** Libelles des chapitres, pour l'ecran. */
const LIBELLES_CHAPITRES = /** @type {Record<string, string>} */ ({
  charge_fonciere: 'Charge foncière',
  batiment: 'Bâtiment',
  honoraires: 'Honoraires',
  frais_divers: 'Frais divers',
  frais_financiers: 'Frais financiers',
});

/** @type {import('../classeur.js').Domaine} */
export const PRIX_REVIENT = {
  domaine: 'prix_revient',
  titre: 'Prix de revient',
  dimensions: {
    poste: { libelle: 'Poste', valeurs: 'INDICES(postes_saisis)', etiquette: 'libelle_poste' },
    chapitre: {
      libelle: 'Chapitre',
      valeurs: 'UNIQUES(LISTE(chapitre_poste POUR poste))',
      etiquette: 'libelle_chapitre',
    },
  },
  grandeurs: {
    // --- Saisie des postes ----------------------------------------------------
    postes_saisis: {
      libelle: 'Postes du prix de revient',
      unite: 'liste',
      saisie: 'postes_bilan',
      ecran: 'Prix de revient',
    },
    id_poste: {
      libelle: 'Identifiant du poste',
      unite: 'texte',
      sur: ['poste'],
      saisie: 'postes_bilan[poste].id',
      ecran: 'Prix de revient',
    },
    chapitre_poste: {
      libelle: 'Chapitre du poste',
      unite: 'texte',
      sur: ['poste'],
      saisie: 'postes_bilan[poste].chapitre',
      ecran: 'Prix de revient',
    },
    libelle_poste: {
      libelle: 'Libellé du poste',
      unite: 'texte',
      sur: ['poste'],
      saisie: 'postes_bilan[poste].libelle',
      ecran: 'Prix de revient',
    },
    libelle_chapitre: {
      libelle: 'Libellé du chapitre',
      unite: 'texte',
      sur: ['chapitre'],
      lire: (_ctx, ch) => LIBELLES_CHAPITRES[ch] ?? ch,
    },
    montant_ht_saisi_poste: {
      libelle: 'Montant HT saisi',
      unite: 'eur',
      sur: ['poste'],
      saisie: 'postes_bilan[poste].montant_ht_eur',
      ecran: 'Prix de revient',
    },
    montants_ht_tranches_poste: {
      libelle: 'Montants HT saisis tranche par tranche',
      unite: 'liste',
      sur: ['poste'],
      saisie: 'postes_bilan[poste].montants_ht_par_produit',
      ecran: 'Prix de revient',
    },
    montant_ht_tranche_saisi: {
      libelle: 'Montant HT saisi pour la tranche',
      unite: 'eur',
      sur: ['poste', 'tranche'],
      saisie: 'postes_bilan[poste].montants_ht_par_produit[tranche]',
      ecran: 'Prix de revient',
    },
    taux_tva_poste: {
      libelle: 'Taux de TVA saisi',
      unite: 'taux',
      sur: ['poste'],
      saisie: 'postes_bilan[poste].taux_tva',
      ecran: 'Prix de revient',
    },
    taux_tva_tranche_saisi: {
      libelle: 'Taux de TVA saisi pour la tranche',
      unite: 'taux',
      sur: ['poste', 'tranche'],
      saisie: 'postes_bilan[poste].taux_tva_par_produit[tranche]',
      ecran: 'Prix de revient',
    },
    hors_lasm_poste: {
      libelle: 'Poste hors livraison à soi-même',
      unite: 'booleen',
      sur: ['poste'],
      saisie: 'postes_bilan[poste].hors_lasm',
      ecran: 'Prix de revient',
    },
    modulation_saisie: {
      libelle: 'Modulation TTC saisie',
      unite: 'eur',
      saisie: 'modulation_ttc_eur',
      ecran: 'Prix de revient',
    },
    modulation_ttc: {
      libelle: 'Modulation TTC',
      unite: 'eur',
      regle: 'R-TVA-4',
      formule: 'DEFAUT(modulation_saisie; 0)',
      note: 'TTC non finançable ajouté au prix de revient.',
    },
    qpv_saisi: {
      libelle: 'Quartier prioritaire saisi',
      unite: 'booleen',
      saisie: 'identite.qpv',
      ecran: 'Opération',
    },
    qpv: {
      libelle: 'Opération en quartier prioritaire',
      unite: 'booleen',
      regle: 'R-TVA-2',
      formule: 'qpv_saisi = VRAI',
    },

    // --- R-TVA-2 : taux de livraison a soi-meme ------------------------------
    taux_lasm_qpv: {
      libelle: 'Taux du PLUS en quartier prioritaire',
      unite: 'taux',
      regle: 'R-TVA-2',
      parametre: 'tva.plus_en_qpv.taux',
      ecran: 'Paramètres > TVA',
    },
    taux_lasm_produit: {
      libelle: 'Taux de livraison à soi-même propre au produit',
      unite: 'taux',
      regle: 'R-TVA-2',
      sur: ['tranche'],
      parametre: 'tva.lasm_par_produit[tranche]',
      ecran: 'Paramètres > TVA',
    },
    taux_lasm_designe: {
      libelle: 'Taux désigné par le produit',
      unite: 'taux',
      regle: 'R-TVA-2',
      sur: ['tranche'],
      lire: (ctx, tranche) => ctx.baremes?.tva?.[produit(tranche).cle_lasm],
      ecran: 'Paramètres > TVA',
    },
    taux_lasm: {
      libelle: 'Taux de livraison à soi-même',
      unite: 'taux',
      regle: 'R-TVA-2',
      sur: ['tranche'],
      formule:
        "SI(ET(tranche = 'PLUS'; qpv; DEFINI(taux_lasm_qpv)); taux_lasm_qpv; " +
        'SI(DEFINI(taux_lasm_produit); taux_lasm_produit; ' +
        "SI(DEFINI(taux_lasm_designe); taux_lasm_designe; ERREUR('Taux LASM introuvable pour '; tranche))))",
      note: 'Le PLUS en quartier prioritaire relève du taux social (CGI 278 sexies) : une condition de localisation, pas un autre produit.',
    },

    // --- R-TVA-1/3 : montants des postes -------------------------------------
    ventile_a_la_main_poste: {
      libelle: 'Poste saisi tranche par tranche',
      unite: 'booleen',
      regle: 'R-TVA-3',
      sur: ['poste'],
      formule: 'SI(montants_ht_tranches_poste; VRAI; FAUX)',
    },
    ht_poste: {
      libelle: 'Montant HT du poste',
      unite: 'eur',
      regle: 'R-TVA-3',
      sur: ['poste'],
      formule:
        'SI(ventile_a_la_main_poste; SOMME(DEFAUT(m; 0) POUR m DANS VALEURS(montants_ht_tranches_poste)); ' +
        'DEFAUT(montant_ht_saisi_poste; 0))',
      note: 'Saisi tranche par tranche, le poste vaut la somme de ses tranches : la saisie par tranche fait foi.',
    },
    tva_saisie_poste: {
      libelle: 'TVA du poste au taux saisi',
      unite: 'eur',
      regle: 'R-TVA-1',
      sur: ['poste'],
      formule: 'ht_poste * DEFAUT(taux_tva_poste; 0)',
    },
    ttc_saisie_poste: {
      libelle: 'TTC du poste au taux saisi',
      unite: 'eur',
      regle: 'R-TVA-1',
      sur: ['poste'],
      formule: 'ht_poste + tva_saisie_poste',
    },
    ht_poste_arrondi: {
      libelle: 'Montant HT du poste, arrondi',
      unite: 'eur',
      sur: ['poste'],
      formule: 'ARRONDI.EURO(ht_poste)',
    },
    tva_saisie_poste_arrondie: {
      libelle: 'TVA du poste au taux saisi, arrondie',
      unite: 'eur',
      sur: ['poste'],
      formule: 'ARRONDI.EURO(tva_saisie_poste)',
    },
    ttc_saisie_poste_arrondi: {
      libelle: 'TTC du poste au taux saisi, arrondi',
      unite: 'eur',
      sur: ['poste'],
      formule: 'ARRONDI.EURO(ttc_saisie_poste)',
    },

    // --- Lecture d'un seul tenant, au taux de la tranche de reference ---------
    tranche_reference: {
      libelle: 'Tranche de référence',
      unite: 'texte',
      formule:
        "DEFAUT(tranche_unique; ELEMENT(tranches_presentes; 0); ERREUR('Programme sans tranche : saisir au moins un lot.'))",
      note: 'La tranche unique, ou à défaut la première : la lecture d’un seul tenant n’a qu’un taux.',
    },
    taux_lasm_reference: {
      libelle: 'Taux de livraison à soi-même de référence',
      unite: 'taux',
      regle: 'R-TVA-2',
      formule: 'taux_lasm[tranche: tranche_reference]',
    },
    ttc_lasm_reference_poste: {
      libelle: 'TTC du poste au taux de référence',
      unite: 'eur',
      regle: 'R-TVA-2',
      sur: ['poste'],
      formule: 'SI(hors_lasm_poste; ttc_saisie_poste; ht_poste * (1 + taux_lasm_reference))',
    },
    ttc_lasm_reference_poste_arrondi: {
      libelle: 'TTC du poste au taux de référence, arrondi',
      unite: 'eur',
      sur: ['poste'],
      formule: 'ARRONDI.EURO(ttc_lasm_reference_poste)',
    },
    ht_chapitre_global: {
      libelle: 'Montant HT du chapitre, d’un seul tenant',
      unite: 'eur',
      sur: ['chapitre'],
      formule: 'ARRONDI.EURO(SOMME(ht_poste POUR poste QUAND chapitre_poste = chapitre))',
    },
    tva_chapitre_global: {
      libelle: 'TVA du chapitre, d’un seul tenant',
      unite: 'eur',
      sur: ['chapitre'],
      formule: 'ARRONDI.EURO(SOMME(tva_saisie_poste POUR poste QUAND chapitre_poste = chapitre))',
    },
    ttc_chapitre_global: {
      libelle: 'TTC du chapitre, d’un seul tenant',
      unite: 'eur',
      sur: ['chapitre'],
      formule: 'ARRONDI.EURO(SOMME(ttc_saisie_poste POUR poste QUAND chapitre_poste = chapitre))',
    },
    ttc_lasm_chapitre_global: {
      libelle: 'TTC final du chapitre, d’un seul tenant',
      unite: 'eur',
      sur: ['chapitre'],
      formule: 'ARRONDI.EURO(SOMME(ttc_lasm_reference_poste POUR poste QUAND chapitre_poste = chapitre))',
    },
    total_ht_global: {
      libelle: 'Total HT, d’un seul tenant',
      unite: 'eur',
      formule: 'ARRONDI.EURO(SOMME(ht_poste POUR poste))',
    },
    total_tva_global: {
      libelle: 'Total TVA, d’un seul tenant',
      unite: 'eur',
      formule: 'ARRONDI.EURO(SOMME(tva_saisie_poste POUR poste))',
    },
    total_ttc_global: {
      libelle: 'Total TTC, d’un seul tenant',
      unite: 'eur',
      formule: 'ARRONDI.EURO(SOMME(ttc_saisie_poste POUR poste))',
    },
    total_ttc_lasm_global: {
      libelle: 'Total TTC final, d’un seul tenant',
      unite: 'eur',
      formule: 'ARRONDI.EURO(SOMME(ttc_lasm_reference_poste POUR poste))',
    },
    total_ttc_module_global: {
      libelle: 'Prix de revient modulé, d’un seul tenant',
      unite: 'eur',
      regle: 'R-TVA-4',
      formule: 'ARRONDI.EURO(SOMME(ttc_lasm_reference_poste POUR poste) + modulation_ttc)',
    },

    // --- R-TVA-2/3 : ventilation par tranche -----------------------------------
    ht_poste_tranche: {
      libelle: 'Montant HT du poste pour la tranche',
      unite: 'eur',
      regle: 'R-TVA-3',
      sur: ['poste', 'tranche'],
      formule:
        'SI(ventile_a_la_main_poste; DEFAUT(montant_ht_tranche_saisi; 0); ht_poste * quote_part_su)',
    },
    taux_tva_poste_tranche: {
      libelle: 'Taux de TVA du poste pour la tranche',
      unite: 'taux',
      regle: 'R-TVA-2',
      sur: ['poste', 'tranche'],
      formule:
        'SI(RENSEIGNE(taux_tva_tranche_saisi); taux_tva_tranche_saisi; ' +
        'SI(hors_lasm_poste; DEFAUT(taux_tva_poste; 0); ' +
        'SI(RENSEIGNE(taux_lasm); taux_lasm; DEFAUT(taux_tva_poste; 0))))',
      note: 'Sans saisie propre à la tranche, le taux de son produit ; un poste hors livraison à soi-même garde son taux saisi.',
    },
    tva_poste_tranche: {
      libelle: 'TVA du poste pour la tranche',
      unite: 'eur',
      regle: 'R-TVA-2',
      sur: ['poste', 'tranche'],
      formule: 'ht_poste_tranche * taux_tva_poste_tranche',
    },
    ttc_poste_tranche: {
      libelle: 'TTC du poste pour la tranche',
      unite: 'eur',
      sur: ['poste', 'tranche'],
      formule: 'ht_poste_tranche + tva_poste_tranche',
    },
    ttc_lasm_poste_tranche: {
      libelle: 'TTC final du poste pour la tranche',
      unite: 'eur',
      regle: 'R-TVA-2',
      sur: ['poste', 'tranche'],
      formule:
        'SI(hors_lasm_poste; ht_poste_tranche + tva_poste_tranche; ht_poste_tranche * (1 + taux_lasm))',
    },
    part_poste_tranche: {
      libelle: 'Part du poste revenant à la tranche',
      unite: 'taux',
      sur: ['poste', 'tranche'],
      formule: 'SI(ht_poste > 0; ht_poste_tranche / ht_poste; quote_part_su)',
    },
    tva_poste_ventile: {
      libelle: 'TVA du poste, tranches cumulées',
      unite: 'eur',
      sur: ['poste'],
      formule: 'ARRONDI.EURO(SOMME(tva_poste_tranche POUR tranche DANS tranches_ordre_saisie))',
    },
    ttc_poste_ventile: {
      libelle: 'TTC du poste, tranches cumulées',
      unite: 'eur',
      sur: ['poste'],
      formule: 'ARRONDI.EURO(SOMME(ttc_poste_tranche POUR tranche DANS tranches_ordre_saisie))',
    },
    ttc_lasm_poste_ventile: {
      libelle: 'TTC final du poste, tranches cumulées',
      unite: 'eur',
      sur: ['poste'],
      formule: 'ARRONDI.EURO(SOMME(ttc_lasm_poste_tranche POUR tranche DANS tranches_ordre_saisie))',
    },

    // --- Totaux par tranche : cumuls exacts, puis repartition sans perte ---------
    cumul_ht_tranche: {
      libelle: 'Montant HT exact de la tranche',
      unite: 'eur',
      sur: ['tranche'],
      formule: 'SOMME(ht_poste_tranche POUR poste)',
    },
    cumul_tva_tranche: {
      libelle: 'TVA exacte de la tranche',
      unite: 'eur',
      sur: ['tranche'],
      formule: 'SOMME(tva_poste_tranche POUR poste)',
    },
    cumul_ttc_tranche: {
      libelle: 'TTC exact de la tranche',
      unite: 'eur',
      sur: ['tranche'],
      formule: 'SOMME(ttc_poste_tranche POUR poste)',
    },
    cumul_ttc_lasm_tranche: {
      libelle: 'TTC final exact de la tranche',
      unite: 'eur',
      sur: ['tranche'],
      formule: 'SOMME(ttc_lasm_poste_tranche POUR poste)',
    },
    modulation_tranche: {
      libelle: 'Modulation revenant à la tranche',
      unite: 'eur',
      regle: 'R-TVA-4',
      sur: ['tranche'],
      formule: 'modulation_ttc * quote_part_su',
    },
    total_ht_tranche: {
      libelle: 'Montant HT de la tranche',
      unite: 'eur',
      sur: ['tranche'],
      formule: 'REPARTIR(cumul_ht_tranche POUR tranche DANS tranches_ordre_saisie)',
    },
    total_tva_tranche: {
      libelle: 'TVA de la tranche',
      unite: 'eur',
      sur: ['tranche'],
      formule: 'REPARTIR(cumul_tva_tranche POUR tranche DANS tranches_ordre_saisie)',
    },
    total_ttc_tranche: {
      libelle: 'TTC de la tranche',
      unite: 'eur',
      sur: ['tranche'],
      formule: 'REPARTIR(cumul_ttc_tranche POUR tranche DANS tranches_ordre_saisie)',
    },
    total_ttc_lasm_tranche: {
      libelle: 'TTC final de la tranche',
      unite: 'eur',
      regle: 'R-TVA-2',
      sur: ['tranche'],
      formule: 'REPARTIR(cumul_ttc_lasm_tranche POUR tranche DANS tranches_ordre_saisie)',
    },
    total_ttc_module_tranche: {
      libelle: 'Prix de revient de la tranche',
      unite: 'eur',
      regle: 'R-TVA-4',
      sur: ['tranche'],
      formule:
        'REPARTIR(cumul_ttc_lasm_tranche + modulation_tranche POUR tranche DANS tranches_ordre_saisie)',
    },
    total_ht: {
      libelle: 'Total HT',
      unite: 'eur',
      formule: 'SOMME(total_ht_tranche POUR tranche DANS tranches_ordre_saisie)',
    },
    total_tva: {
      libelle: 'Total TVA',
      unite: 'eur',
      formule: 'SOMME(total_tva_tranche POUR tranche DANS tranches_ordre_saisie)',
    },
    total_ttc: {
      libelle: 'Total TTC',
      unite: 'eur',
      formule: 'SOMME(total_ttc_tranche POUR tranche DANS tranches_ordre_saisie)',
    },
    total_ttc_lasm: {
      libelle: 'Total TTC final',
      unite: 'eur',
      regle: 'R-TVA-2',
      formule: 'SOMME(total_ttc_lasm_tranche POUR tranche DANS tranches_ordre_saisie)',
    },
    total_ttc_module: {
      libelle: 'Prix de revient',
      unite: 'eur',
      regle: 'R-TVA-4',
      formule: 'SOMME(total_ttc_module_tranche POUR tranche DANS tranches_ordre_saisie)',
      note: 'Base du plan de financement (R-FIN-1).',
    },

    // --- Chapitres : exacts, repartis entre eux, puis entre tranches -------------
    ht_chapitre_exact: {
      libelle: 'Montant HT exact du chapitre',
      unite: 'eur',
      sur: ['chapitre'],
      formule:
        'SOMME(ht_poste_tranche POUR poste QUAND chapitre_poste = chapitre POUR tranche DANS tranches_ordre_saisie)',
    },
    tva_chapitre_exact: {
      libelle: 'TVA exacte du chapitre',
      unite: 'eur',
      sur: ['chapitre'],
      formule:
        'SOMME(tva_poste_tranche POUR poste QUAND chapitre_poste = chapitre POUR tranche DANS tranches_ordre_saisie)',
    },
    ttc_chapitre_exact: {
      libelle: 'TTC exact du chapitre',
      unite: 'eur',
      sur: ['chapitre'],
      formule:
        'SOMME(ttc_poste_tranche POUR poste QUAND chapitre_poste = chapitre POUR tranche DANS tranches_ordre_saisie)',
    },
    ttc_lasm_chapitre_exact: {
      libelle: 'TTC final exact du chapitre',
      unite: 'eur',
      sur: ['chapitre'],
      formule:
        'SOMME(ttc_lasm_poste_tranche POUR poste QUAND chapitre_poste = chapitre POUR tranche DANS tranches_ordre_saisie)',
    },
    ht_chapitre: {
      libelle: 'Montant HT du chapitre',
      unite: 'eur',
      sur: ['chapitre'],
      formule: 'REPARTIR(ht_chapitre_exact POUR chapitre)',
    },
    tva_chapitre: {
      libelle: 'TVA du chapitre',
      unite: 'eur',
      sur: ['chapitre'],
      formule: 'REPARTIR(tva_chapitre_exact POUR chapitre)',
    },
    ttc_chapitre: {
      libelle: 'TTC du chapitre',
      unite: 'eur',
      sur: ['chapitre'],
      formule: 'REPARTIR(ttc_chapitre_exact POUR chapitre)',
    },
    ttc_lasm_chapitre: {
      libelle: 'TTC final du chapitre',
      unite: 'eur',
      sur: ['chapitre'],
      formule: 'REPARTIR(ttc_lasm_chapitre_exact POUR chapitre)',
    },
    ht_chapitre_tranche_exact: {
      libelle: 'Montant HT exact du chapitre pour la tranche',
      unite: 'eur',
      sur: ['chapitre', 'tranche'],
      formule: 'SOMME(ht_poste_tranche POUR poste QUAND chapitre_poste = chapitre)',
    },
    tva_chapitre_tranche_exact: {
      libelle: 'TVA exacte du chapitre pour la tranche',
      unite: 'eur',
      sur: ['chapitre', 'tranche'],
      formule: 'SOMME(tva_poste_tranche POUR poste QUAND chapitre_poste = chapitre)',
    },
    ttc_chapitre_tranche_exact: {
      libelle: 'TTC exact du chapitre pour la tranche',
      unite: 'eur',
      sur: ['chapitre', 'tranche'],
      formule: 'SOMME(ttc_poste_tranche POUR poste QUAND chapitre_poste = chapitre)',
    },
    ttc_lasm_chapitre_tranche_exact: {
      libelle: 'TTC final exact du chapitre pour la tranche',
      unite: 'eur',
      sur: ['chapitre', 'tranche'],
      formule: 'SOMME(ttc_lasm_poste_tranche POUR poste QUAND chapitre_poste = chapitre)',
    },
    ht_chapitre_tranche: {
      libelle: 'Montant HT du chapitre pour la tranche',
      unite: 'eur',
      sur: ['chapitre', 'tranche'],
      formule: 'REPARTIR(ht_chapitre_tranche_exact POUR tranche DANS tranches_ordre_saisie; ht_chapitre)',
      note: 'Réparti sur le sous-total AFFICHÉ du chapitre : la ligne s’additionne à l’écran.',
    },
    tva_chapitre_tranche: {
      libelle: 'TVA du chapitre pour la tranche',
      unite: 'eur',
      sur: ['chapitre', 'tranche'],
      formule: 'REPARTIR(tva_chapitre_tranche_exact POUR tranche DANS tranches_ordre_saisie; tva_chapitre)',
    },
    ttc_chapitre_tranche: {
      libelle: 'TTC du chapitre pour la tranche',
      unite: 'eur',
      sur: ['chapitre', 'tranche'],
      formule: 'REPARTIR(ttc_chapitre_tranche_exact POUR tranche DANS tranches_ordre_saisie; ttc_chapitre)',
    },
    ttc_lasm_chapitre_tranche: {
      libelle: 'TTC final du chapitre pour la tranche',
      unite: 'eur',
      sur: ['chapitre', 'tranche'],
      formule:
        'REPARTIR(ttc_lasm_chapitre_tranche_exact POUR tranche DANS tranches_ordre_saisie; ttc_lasm_chapitre)',
    },
  },
};
