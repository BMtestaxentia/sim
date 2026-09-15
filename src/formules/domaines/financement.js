// @ts-check
/**
 * DOMAINE « FINANCEMENT » - R-FIN : fonds propres, solde a financer, prets CDC
 * theoriques, besoin de chaque tranche et montants automatiques de ses prets.
 *
 * Chaque tranche porte par defaut un pret foncier et un pret construction dont
 * le MONTANT S'AJUSTE a son besoin : ce que son prix de revient ne couvre pas
 * encore apres ses subventions, ses fonds propres et ses prets a montant saisi.
 * Une tranche SURFINANCEE finance les autres : son excedent se repartit, au
 * prorata des surfaces, sur les tranches qui ont encore un besoin, en trois
 * tours comme la calculette CDC. Le foncier se sert le premier, dans la limite
 * du droit a pret foncier, et la construction prend le reste.
 *
 * Sources : `calculs!D327:D336`, calculette CDC « production LS » (onglet
 * Construction, colonnes AI a AO, AT37 et M49).
 */

/** @type {import('../classeur.js').Domaine} */
export const FINANCEMENT = {
  domaine: 'financement',
  titre: 'Plan de financement',
  dimensions: {
    pret_saisi: {
      libelle: 'Prêt saisi',
      valeurs: 'INDICES(prets_saisis)',
      etiquette: 'libelle_pret_saisi',
    },
    tirage: { libelle: 'Tirage de préfinancement', valeurs: 'INDICES(tirages_saisis)' },
    tour: { libelle: 'Tour de redressement', valeurs: 'SUITE(1; tours_redressement)' },
    nature_auto: { libelle: 'Prêt automatique', valeurs: 'natures_auto' },
  },
  grandeurs: {
    // --- R-FIN-7 : apport en fonds propres ---------------------------------------
    mode_exploitation_saisi: {
      libelle: 'Régime d’exploitation saisi',
      unite: 'texte',
      saisie: 'exploitation.mode',
      ecran: 'Exploitation',
    },
    mode_redevance_saisi: {
      libelle: 'Mode de redevance saisi',
      unite: 'texte',
      saisie: 'exploitation.mode_redevance',
      ecran: 'Exploitation',
    },
    apport_en_transparence: {
      libelle: 'Opération en redevance transparente',
      unite: 'booleen',
      regle: 'R-FIN-7',
      formule: "ET(mode_exploitation_saisi = 'redevance'; DEFAUT(mode_redevance_saisi; 'forfaitaire') = 'transparence')",
    },
    taux_apport_defaut: {
      libelle: 'Part d’apport par défaut',
      unite: 'taux',
      regle: 'R-FIN-7',
      parametre: 'fonds_propres.apport.taux_defaut',
      ecran: 'Paramètres > Fonds propres',
    },
    taux_apport_transparence: {
      libelle: 'Part d’apport en redevance transparente',
      unite: 'taux',
      regle: 'R-FIN-7',
      parametre: 'fonds_propres.apport.taux_redevance_transparence',
      ecran: 'Paramètres > Fonds propres',
    },
    taux_apport_reference: {
      libelle: 'Part d’apport du référentiel',
      unite: 'taux',
      regle: 'R-FIN-7',
      formule: 'DEFAUT(SI(apport_en_transparence; taux_apport_transparence; taux_apport_defaut); 0)',
      note: 'En redevance transparente, l’apport prend la forme d’une avance de trésorerie et se limite à 2 %.',
    },
    taux_apport_saisi: {
      libelle: 'Part d’apport saisie',
      unite: 'taux',
      sur: ['code'],
      saisie: 'taux_apport_par_produit[code]',
      ecran: 'Tranche > Fonds propres',
    },
    apport_saisi_brut: {
      libelle: 'Apport saisi',
      unite: 'eur',
      sur: ['code'],
      saisie: 'fonds_propres_par_produit[code]',
      ecran: 'Tranche > Fonds propres',
    },
    apport_saisi: {
      libelle: 'Apport saisi retenu',
      unite: 'eur',
      sur: ['code'],
      formule: 'SI(SAISI(apport_saisi_brut); NOMBRE(apport_saisi_brut); VIDE)',
      note: 'Une case vide rend la main au calcul ; zéro reste une valeur légitime, une tranche sans apport.',
    },
    taux_apport_tranche: {
      libelle: 'Part d’apport de la tranche',
      unite: 'taux',
      regle: 'R-FIN-7',
      sur: ['tranche'],
      formule:
        'SI(SAISI(taux_apport_saisi[code: tranche]); NOMBRE(taux_apport_saisi[code: tranche]); taux_apport_reference)',
    },
    apport_auto_tranche: {
      libelle: 'Apport calculé de la tranche',
      unite: 'eur',
      regle: 'R-FIN-7',
      sur: ['tranche'],
      formule: 'ARRONDI.EURO(total_ttc_tranche * taux_apport_tranche)',
      note: 'Sa part du prix de revient TTC de la tranche.',
    },
    apport_tranche: {
      libelle: 'Apport de la tranche',
      unite: 'eur',
      regle: 'R-FIN-7',
      sur: ['tranche'],
      formule: 'DEFAUT(apport_saisi[code: tranche]; apport_auto_tranche)',
    },
    fp_saisis_par_tranche: {
      libelle: 'Fonds propres saisis par tranche',
      unite: 'liste',
      saisie: 'fonds_propres_par_produit',
      ecran: 'Tranche > Fonds propres',
    },
    fp_en_tranches: {
      libelle: 'Fonds propres tenus par tranche',
      unite: 'booleen',
      formule: 'SI(fp_saisis_par_tranche; VRAI; FAUX)',
    },
    fonds_propres_global_saisis: {
      libelle: 'Fonds propres saisis pour l’opération',
      unite: 'eur',
      saisie: 'fonds_propres_eur',
      ecran: 'Plan de financement',
    },
    cles_fonds_propres: {
      libelle: 'Tranches portant des fonds propres',
      unite: 'liste',
      formule: 'UNIQUES(CONCATENER(tranches_presentes; CLES(fp_saisis_par_tranche)))',
      note: 'Les tranches du programme, et celles qui portent encore une saisie : un apport saisi compte là où il est.',
    },
    fonds_propres_total: {
      libelle: 'Fonds propres de l’opération',
      unite: 'eur',
      regle: 'R-FIN-7',
      formule:
        'SI(fp_en_tranches; SOMME(SI(CONTIENT(tranches_presentes; k); apport_tranche[tranche: k]; ' +
        'DEFAUT(apport_saisi[code: k]; 0)) POUR k DANS cles_fonds_propres); DEFAUT(fonds_propres_global_saisis; 0))',
    },
    fonds_propres_tranche: {
      libelle: 'Fonds propres de la tranche',
      unite: 'eur',
      regle: 'R-FIN-7',
      sur: ['tranche'],
      formule: 'SI(fp_en_tranches; apport_tranche; quote_part_su * DEFAUT(fonds_propres_global_saisis; 0))',
    },
    fonds_propres_tranche_arrondi: {
      libelle: 'Fonds propres de la tranche, arrondis',
      unite: 'eur',
      sur: ['tranche'],
      formule: 'ARRONDI.EURO(fonds_propres_tranche)',
    },
    fp_remuneres_saisi: {
      libelle: 'Fonds propres rémunérés',
      unite: 'booleen',
      sur: ['code'],
      saisie: 'remuneration_fonds_propres[code].remuneres',
      ecran: 'Tranche > Fonds propres',
    },
    fp_taux_saisi: {
      libelle: 'Taux de rémunération saisi',
      unite: 'taux',
      sur: ['code'],
      saisie: 'remuneration_fonds_propres[code].taux',
      ecran: 'Tranche > Fonds propres',
    },
    fp_reconstitues_saisi: {
      libelle: 'Fonds propres reconstitués',
      unite: 'booleen',
      sur: ['code'],
      saisie: 'remuneration_fonds_propres[code].reconstitues',
      ecran: 'Tranche > Fonds propres',
    },
    fp_duree_saisie: {
      libelle: 'Durée de reconstitution saisie',
      unite: 'an',
      sur: ['code'],
      saisie: 'remuneration_fonds_propres[code].duree_reconstitution_ans',
      ecran: 'Tranche > Fonds propres',
    },
    taux_remuneration_fp: {
      libelle: 'Taux de rémunération des fonds propres',
      unite: 'taux',
      regle: 'R-FIN-7',
      sur: ['tranche'],
      formule: 'SI(fp_remuneres_saisi[code: tranche] = VRAI; NOMBRE(fp_taux_saisi[code: tranche]); 0)',
    },
    duree_reconstitution_fp: {
      libelle: 'Durée de reconstitution des fonds propres',
      unite: 'an',
      regle: 'R-FIN-7',
      sur: ['tranche'],
      formule: 'SI(fp_reconstitues_saisi[code: tranche] = VRAI; NOMBRE(fp_duree_saisie[code: tranche]); 0)',
    },
    annuite_fp_tranche: {
      libelle: 'Charge annuelle des fonds propres',
      unite: 'eur',
      regle: 'R-FIN-7',
      sur: ['tranche'],
      formule:
        'SI(NON(fonds_propres_tranche > 0); 0; ' +
        'SI(NON(duree_reconstitution_fp > 0); SI(taux_remuneration_fp > 0; ARRONDI.EURO(fonds_propres_tranche * taux_remuneration_fp); 0); ' +
        'SI(NON(taux_remuneration_fp > 0); ARRONDI.EURO(fonds_propres_tranche / duree_reconstitution_fp); ' +
        'ARRONDI.EURO(fonds_propres_tranche * taux_remuneration_fp / (1 - (1 + taux_remuneration_fp) ^ -duree_reconstitution_fp)))))',
      note: 'Rémunérés sans être reconstitués : les intérêts seuls. Reconstitués sans être rémunérés : le capital seul. Les deux : une annuité, comme un prêt que l’opération se fait à elle-même.',
    },
    annuite_fp_totale: {
      libelle: 'Charge annuelle des fonds propres de l’opération',
      unite: 'eur',
      regle: 'R-FIN-7',
      formule: 'ARRONDI.EURO(SOMME(annuite_fp_tranche POUR tranche))',
    },
    duree_charge_fp: {
      libelle: 'Années portant la charge de fonds propres',
      unite: 'an',
      regle: 'R-FIN-7',
      sur: ['tranche'],
      formule: 'SI(duree_reconstitution_fp > 0; MIN(duree_reconstitution_fp; duree_simulation); duree_simulation)',
      note: 'Reconstitués, la charge s’arrête au terme : le capital est rendu. Sinon elle court tant que l’opération existe.',
    },

    // --- Prets saisis ---------------------------------------------------------------
    prets_saisis: { libelle: 'Prêts saisis', unite: 'liste', saisie: 'prets', ecran: 'Plan de financement' },
    champ_pret_saisi: {
      libelle: 'Caractéristique saisie du prêt',
      unite: 'texte',
      sur: ['pret_saisi', 'champ'],
      saisie: 'prets[pret_saisi][champ]',
      ecran: 'Plan de financement',
    },
    libelle_pret_saisi: {
      libelle: 'Libellé du prêt saisi',
      unite: 'texte',
      sur: ['pret_saisi'],
      formule: "champ_pret_saisi[champ: 'libelle']",
    },
    nature_pret_saisi: {
      libelle: 'Nature du prêt saisi',
      unite: 'texte',
      sur: ['pret_saisi'],
      formule: "champ_pret_saisi[champ: 'nature']",
    },
    montant_pret_saisi: {
      libelle: 'Montant du prêt saisi',
      unite: 'eur',
      sur: ['pret_saisi'],
      formule: "champ_pret_saisi[champ: 'montant_eur']",
    },
    pret_saisi_auto: {
      libelle: 'Prêt saisi à montant automatique',
      unite: 'booleen',
      regle: 'R-FIN-3',
      sur: ['pret_saisi'],
      formule: "OU(champ_pret_saisi[champ: 'montant_auto'] = VRAI; NON(RENSEIGNE(montant_pret_saisi)))",
    },
    tranche_pret_saisi: {
      libelle: 'Tranche du prêt saisi',
      unite: 'texte',
      sur: ['pret_saisi'],
      formule: "DEFAUT(champ_pret_saisi[champ: 'produit']; tranche_unique)",
      note: 'Un prêt sans tranche revient à la tranche unique du programme.',
    },
    autres_prets: {
      libelle: 'Autres prêts',
      unite: 'eur',
      regle: 'R-FIN-3',
      formule: "SOMME(montant_pret_saisi POUR pret_saisi QUAND nature_pret_saisi = 'autre')",
    },
    nb_prets_cdc_saisis: {
      libelle: 'Prêts saisis hors « autres »',
      unite: 'nombre',
      formule: "NB(pret_saisi POUR pret_saisi QUAND nature_pret_saisi <> 'autre')",
    },
    pret_principal_saisi: {
      libelle: 'Un prêt foncier ou construction est saisi',
      unite: 'booleen',
      regle: 'R-FIN-3',
      formule: "UN(OU(nature_pret_saisi = 'foncier'; nature_pret_saisi = 'construction') POUR pret_saisi)",
      note: 'Sinon, chaque tranche reçoit ses prêts par défaut.',
    },
    prets_fixes_tranche: {
      libelle: 'Prêts à montant saisi de la tranche',
      unite: 'eur',
      regle: 'R-FIN-3',
      sur: ['tranche'],
      formule:
        'SOMME(NOMBRE(montant_pret_saisi) POUR pret_saisi QUAND ET(NON(pret_saisi_auto); tranche_pret_saisi = tranche))',
      note: 'Un montant saisi fige le prêt : il vient en déduction du besoin, comme une ressource déjà acquise.',
    },

    // --- R-FIN-3 : solde a financer ------------------------------------------------
    solde_a_financer: {
      libelle: 'Solde à financer',
      unite: 'eur',
      regle: 'R-FIN-3',
      formule: 'ARRONDI.EURO(total_ttc_module - (subventions_total + fonds_propres_total + autres_prets))',
    },

    // --- R-FIN-6 : prefinancement --------------------------------------------------
    prefinancement_saisi: {
      libelle: 'Préfinancement saisi',
      unite: 'liste',
      saisie: 'prefinancement',
      ecran: 'Trésorerie',
    },
    prefi_actif: {
      libelle: 'Préfinancement demandé',
      unite: 'booleen',
      formule: 'SI(prefinancement_saisi; VRAI; FAUX)',
    },
    tirages_saisis: {
      libelle: 'Tirages du préfinancement',
      unite: 'liste',
      saisie: 'prefinancement.tirages',
      ecran: 'Trésorerie',
    },
    montant_tirage: {
      libelle: 'Montant du tirage',
      unite: 'eur',
      sur: ['tirage'],
      saisie: 'prefinancement.tirages[tirage].montant_eur',
      ecran: 'Trésorerie',
    },
    date_tirage: {
      libelle: 'Date du tirage',
      unite: 'date',
      sur: ['tirage'],
      saisie: 'prefinancement.tirages[tirage].date',
      ecran: 'Trésorerie',
    },
    taux_prefinancement: {
      libelle: 'Taux du préfinancement',
      unite: 'taux',
      saisie: 'prefinancement.taux',
      ecran: 'Trésorerie',
    },
    date_fin_prefinancement_saisie: {
      libelle: 'Fin de capitalisation saisie',
      unite: 'date',
      saisie: 'prefinancement.date_fin',
      ecran: 'Trésorerie',
    },
    capitaliser_prefinancement_saisi: {
      libelle: 'Capitaliser les intérêts',
      unite: 'booleen',
      saisie: 'prefinancement.capitaliser',
      ecran: 'Trésorerie',
    },
    jours_par_an_prefinancement: {
      libelle: 'Base de jours de la capitalisation',
      unite: 'nombre',
      constante: 365,
      note: 'Convention exact/365 de LEON (SimPLUS!FA15).',
    },
    jour_tirage: {
      libelle: 'Rang du jour du tirage',
      unite: 'jours',
      sur: ['tirage'],
      formule: 'JOURS(date_tirage)',
    },
    jour_fin_prefinancement: {
      libelle: 'Rang du jour de fin de capitalisation',
      unite: 'jours',
      regle: 'R-FIN-6',
      formule:
        'SI(DEFINI(date_fin_prefinancement_saisie); JOURS(date_fin_prefinancement_saisie); MAX(jour_tirage POUR tirage))',
      note: 'À défaut de date saisie, le jour du dernier tirage.',
    },
    tirage_tardif: {
      libelle: 'Tirage postérieur à la fin de capitalisation',
      unite: 'date',
      formule: 'PREMIER(date_tirage POUR tirage QUAND jour_tirage > jour_fin_prefinancement)',
    },
    prefinancement_nominal: {
      libelle: 'Montant tiré',
      unite: 'eur',
      regle: 'R-FIN-6',
      formule:
        "SI(RENSEIGNE(tirage_tardif); ERREUR('Tirage posterieur a la date de fin de capitalisation : '; tirage_tardif); " +
        'SOMME(montant_tirage POUR tirage))',
    },
    prefinancement_capitalise: {
      libelle: 'Montant capitalisé',
      unite: 'eur',
      regle: 'R-FIN-6',
      formule:
        'SOMME(montant_tirage * (1 + taux_prefinancement) ^ ((jour_fin_prefinancement - jour_tirage) / jours_par_an_prefinancement) POUR tirage)',
      note: 'Capitalisation actuarielle de chaque tirage jusqu’à la fin de capitalisation.',
    },
    prefinancement_interets: {
      libelle: 'Intérêts de préfinancement',
      unite: 'eur',
      regle: 'R-FIN-6',
      formule: 'prefinancement_capitalise - prefinancement_nominal',
    },
    prefinancement_capital_constitue: {
      libelle: 'Capital constitué',
      unite: 'eur',
      regle: 'R-FIN-6',
      formule:
        'SI(SI.ABSENT(capitaliser_prefinancement_saisi; VRAI); prefinancement_nominal + prefinancement_interets; prefinancement_nominal)',
    },
    interets_prefinancement: {
      libelle: 'Intérêts de préfinancement retenus',
      unite: 'eur',
      formule: 'SI(prefi_actif; prefinancement_interets; 0)',
    },

    // --- R-FIN-2/4 : droit a pret foncier et prets CDC theoriques ---------------------
    charge_fonciere_lasm: {
      libelle: 'Charge foncière TTC finale',
      unite: 'eur',
      regle: 'R-FIN-2',
      formule: "DEFAUT(ttc_lasm_chapitre[chapitre: 'charge_fonciere']; 0)",
    },
    reduction_subventions_foncier: {
      libelle: 'Part des subventions dans le prix de revient',
      unite: 'taux',
      regle: 'R-FIN-2',
      formule: 'SI(total_ttc_module > 0; subventions_total / total_ttc_module; 0)',
    },
    quote_part_foncier: {
      libelle: 'Quote-part retenue du droit foncier',
      unite: 'taux',
      constante: 1,
      note: 'Le droit se calcule sur l’opération entière, puis se répartit entre tranches au prorata des surfaces.',
    },
    droit_foncier_total: {
      libelle: 'Droit à prêt foncier',
      unite: 'eur',
      regle: 'R-FIN-2',
      formule:
        'ARRONDI.EURO(charge_fonciere_lasm * (1 - reduction_subventions_foncier) * quote_part_foncier)',
      note: 'Assiette de la calculette CDC (Construction!AT37) : toutes les subventions du plan, arbitrage du 06/08/2026 (Q-30).',
    },
    au_moins_une_tranche_cdc: {
      libelle: 'Une tranche relève des fonds d’épargne',
      unite: 'booleen',
      regle: 'R-FIN-5',
      formule: 'OU(LONGUEUR(tranches_presentes) = 0; UN(finance_par_cdc POUR tranche))',
    },
    cdc_theoriques_actifs: {
      libelle: 'Prêts CDC théoriques calculés',
      unite: 'booleen',
      regle: 'R-FIN-4',
      formule: 'ET(nb_prets_cdc_saisis = 0; au_moins_une_tranche_cdc)',
    },
    option_arrondi_milliers: {
      libelle: 'Arrondir les prêts au millier supérieur',
      unite: 'booleen',
      saisie: 'options.arrondir_prets_milliers_sup',
      ecran: 'Paramètres',
    },
    arrondir_prets_milliers: {
      libelle: 'Arrondi des prêts au millier',
      unite: 'booleen',
      formule: 'DEFAUT(option_arrondi_milliers; FAUX)',
    },
    cdc_foncier_exact: {
      libelle: 'Prêt CDC foncier théorique, non arrondi',
      unite: 'eur',
      regle: 'R-FIN-4',
      formule: 'MAX(0; MIN(solde_a_financer; droit_foncier_total))',
    },
    cdc_foncier: {
      libelle: 'Prêt CDC foncier théorique',
      unite: 'eur',
      regle: 'R-FIN-4',
      formule: 'SI(arrondir_prets_milliers; ARRONDI.MILLIER.SUP(cdc_foncier_exact); cdc_foncier_exact)',
    },
    cdc_batiment_exact: {
      libelle: 'Prêt CDC bâtiment théorique, non arrondi',
      unite: 'eur',
      regle: 'R-FIN-4',
      formule: 'MAX(0; solde_a_financer - interets_prefinancement - cdc_foncier)',
    },
    cdc_batiment: {
      libelle: 'Prêt CDC bâtiment théorique',
      unite: 'eur',
      regle: 'R-FIN-4',
      formule: 'SI(arrondir_prets_milliers; ARRONDI.MILLIER.SUP(cdc_batiment_exact); cdc_batiment_exact)',
    },
    cdc_pret_foncier: {
      libelle: 'Prêt CDC foncier théorique, arrondi',
      unite: 'eur',
      formule: 'ARRONDI.EURO(cdc_foncier)',
    },
    cdc_pret_batiment: {
      libelle: 'Prêt CDC bâtiment théorique, arrondi',
      unite: 'eur',
      formule: 'ARRONDI.EURO(cdc_batiment)',
    },
    cdc_total: {
      libelle: 'Prêts CDC théoriques',
      unite: 'eur',
      regle: 'R-FIN-4',
      formule: 'ARRONDI.EURO(cdc_foncier + cdc_batiment)',
    },

    // --- R-SUB-3 : subventions revenant a chaque tranche ------------------------------
    ssf_part_tranche: {
      libelle: 'Part de la surcharge foncière revenant à la tranche',
      unite: 'eur',
      regle: 'R-SUB-2',
      sur: ['tranche'],
      formule:
        'REPARTIR(quote_part_su * subvention_surcharge_fonciere POUR tranche; ARRONDI.EURO(subvention_surcharge_fonciere))',
      note: 'Calculée sur l’opération entière, elle se répartit au prorata des surfaces, en euros entiers dont la somme vaut son montant.',
    },
    subventions_ventilees_tranche: {
      libelle: 'Subventions de la tranche',
      unite: 'eur',
      regle: 'R-SUB-3',
      sur: ['tranche'],
      formule:
        'SOMME(SI(tranche_subvention = tranche; montant_subvention; 0) POUR subvention QUAND subvention_rattachee) + ' +
        'SI(subvention_surcharge_fonciere; ssf_part_tranche; 0)',
    },
    subventions_ventilees_tranche_arrondies: {
      libelle: 'Subventions de la tranche, arrondies',
      unite: 'eur',
      sur: ['tranche'],
      formule: 'ARRONDI.EURO(subventions_ventilees_tranche)',
    },

    // --- R-FIN-3 : besoin de chaque tranche, et son redressement en serie --------------
    besoin_brut: {
      libelle: 'Besoin de financement de la tranche',
      unite: 'eur',
      regle: 'R-FIN-3',
      sur: ['tranche'],
      formule: 'total_ttc_module_tranche - subventions_ventilees_tranche - fonds_propres_tranche - prets_fixes_tranche',
      note: 'Le signe est conservé : un besoin négatif signale une tranche surfinancée, dont l’excédent va financer les autres.',
    },
    tours_redressement: {
      libelle: 'Tours de redressement',
      unite: 'nombre',
      constante: 3,
      note: 'La calculette CDC itère trois fois.',
    },
    besoin_tour_precedent: {
      libelle: 'Besoin avant le tour',
      unite: 'eur',
      regle: 'R-FIN-3',
      sur: ['tranche', 'tour'],
      formule: 'SI(tour = 1; besoin_brut; besoin_apres_tour[tour: tour - 1])',
    },
    negatifs_tour: {
      libelle: 'Une tranche est surfinancée au début du tour',
      unite: 'booleen',
      sur: ['tour'],
      formule: 'UN(besoin_tour_precedent < 0 POUR tranche)',
    },
    excedent_tour: {
      libelle: 'Excédent à redistribuer',
      unite: 'eur',
      regle: 'R-FIN-3',
      sur: ['tour'],
      formule: 'SOMME(besoin_tour_precedent POUR tranche QUAND besoin_tour_precedent < 0)',
    },
    cle_tour: {
      libelle: 'Surface des tranches à servir',
      unite: 'taux',
      sur: ['tour'],
      formule: 'SOMME(quote_part_su POUR tranche QUAND besoin_tour_precedent > 0)',
    },
    besoin_apres_tour: {
      libelle: 'Besoin après le tour',
      unite: 'eur',
      regle: 'R-FIN-3',
      sur: ['tranche', 'tour'],
      formule:
        'SI(NON(negatifs_tour); besoin_tour_precedent; SI(besoin_tour_precedent < 0; 0; ' +
        'SI(ET(besoin_tour_precedent > 0; cle_tour > 0); besoin_tour_precedent + excedent_tour * (quote_part_su / cle_tour); ' +
        'besoin_tour_precedent)))',
      note: 'Les tranches surfinancées tombent à zéro, et leur excédent réduit le besoin des autres au prorata de leur surface.',
    },
    tour_complet: {
      libelle: 'Tour mené à son terme',
      unite: 'booleen',
      sur: ['tour'],
      formule:
        'ET(SI(tour = 1; VRAI; tour_complet[tour: tour - 1]); negatifs_tour; UN(besoin_tour_precedent > 0 POUR tranche); cle_tour > 0)',
    },
    redressement_tours: {
      libelle: 'Tours de redressement menés',
      unite: 'nombre',
      formule: 'NB(tour POUR tour QUAND tour_complet)',
    },
    besoin_redresse: {
      libelle: 'Besoin redressé de la tranche',
      unite: 'eur',
      regle: 'R-FIN-3',
      sur: ['tranche'],
      formule: 'besoin_apres_tour[tour: tours_redressement]',
    },
    excedent_redresse: {
      libelle: 'Excédent redistribué entre tranches',
      unite: 'eur',
      regle: 'R-FIN-3',
      formule: 'ARRONDI.EURO(SOMME(-excedent_tour POUR tour))',
    },

    // --- R-FIN-2/3 : montants automatiques des prets ---------------------------------
    plafond_foncier_tranche: {
      libelle: 'Droit à prêt foncier de la tranche',
      unite: 'eur',
      regle: 'R-FIN-2',
      sur: ['tranche'],
      formule: 'droit_foncier_total * quote_part_su',
    },
    foncier_auto_present: {
      libelle: 'La tranche porte un prêt foncier automatique',
      unite: 'booleen',
      sur: ['tranche'],
      formule:
        "OU(UN(ET(pret_saisi_auto; nature_pret_saisi = 'foncier'; tranche_pret_saisi = tranche) POUR pret_saisi); " +
        "ET(NON(pret_principal_saisi); CONTIENT(natures_defaut; 'foncier')))",
    },
    foncier_auto_exact: {
      libelle: 'Prêt foncier automatique, non arrondi',
      unite: 'eur',
      regle: 'R-FIN-2',
      sur: ['tranche'],
      formule:
        'SI(foncier_auto_present; MIN(DEFAUT(besoin_redresse; 0); DEFAUT(plafond_foncier_tranche; 0)); 0)',
      note: 'Le foncier se sert le premier, dans la limite du droit à prêt foncier de la tranche.',
    },
    construction_auto_exact: {
      libelle: 'Prêt construction automatique, non arrondi',
      unite: 'eur',
      regle: 'R-FIN-3',
      sur: ['tranche'],
      formule: 'MAX(0; DEFAUT(besoin_redresse; 0) - foncier_auto_exact)',
    },
    natures_auto: {
      libelle: 'Prêts à montant automatique',
      unite: 'liste',
      constante: ['foncier', 'construction'],
    },
    montant_auto_exact: {
      libelle: 'Montant automatique, non arrondi',
      unite: 'eur',
      sur: ['tranche', 'nature_auto'],
      formule: "SI(nature_auto = 'foncier'; foncier_auto_exact; construction_auto_exact)",
    },
    montant_auto: {
      libelle: 'Montant automatique du prêt',
      unite: 'eur',
      regle: 'R-FIN-3',
      sur: ['tranche', 'nature_auto'],
      formule:
        'REPARTIR(montant_auto_exact POUR nature_auto; ARRONDI.EURO(foncier_auto_exact + construction_auto_exact))',
      note: 'Foncier et construction s’arrondissent ensemble : arrondis séparément, ils laissaient fuir un euro.',
    },
  },
};
