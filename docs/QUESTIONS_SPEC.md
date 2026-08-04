# Questions de spécification (à trancher par l'instance chat qui détient la matrice LEON)

Procédure (CLAUDE.md §6) : en cas d'ambiguïté métier, NE PAS deviner. Consigner ici, Bastien remonte à l'instance chat qui tranche avec les cellules sources sous les yeux, puis on met à jour le dictionnaire et on implémente.

| # | Règle | Question | Statut | Réponse / cellule source |
|---|---|---|---|---|
| _ex_ | R-LOYER-4 | Borne exacte du ratio LCR intermédiaire (10-20 %) : ratio/100 ou autre ? | ouverte | — |
| Q-1 | R-AMT-4 | Dernière échéance ajustée (SimPLUS!FK117, à transcrire caractère par caractère). Implémentation actuelle : annuité_finale = CRD_précédent + intérêts de l'année (le CRD est soldé exactement, amortissement = CRD_précédent). À confirmer contre la formule source, notamment le traitement des intérêts de l'année de solde. | ouverte | — |
| Q-2 | R-AMT-4 | Révisabilité SIMPLE : le taux d'intérêt tx_N suit-il la trajectoire LA (révision du taux seul, progressivité figée à p) ou reste-t-il au taux d'origine (équivalent TAUX FIXE) ? Implémentation actuelle : taux révisé, annuité progressée à p seul. | ouverte | — |
| Q-3 | R-FIN-6 | Capitalisation des tirages de préfinancement (SimPLUS!FA15:FD27, à transcrire) : taux mensuel proportionnel (taux/12) ou actuariel ((1+t)^(1/12)−1) ? Convention d'échéancier (nombre de mois de portage par tirage) ? Implémentation actuelle : proportionnel taux/12, capitalisation composée mensuelle jusqu'à la mise en location. | ouverte | — |
| Q-4 | R-AMT-3 | « année(DAT) + 1, +0 si démembrement » : lecture retenue = 1re échéance à année(DAT)+1 en pleine propriété, année(DAT)+0 (année même) en démembrement. À confirmer (SimPLUS!AR17, ParaPLUS type_foncier). | ouverte | — |
| Q-5 | R-AMT-4 | Première annuité quand la trajectoire LA a déjà bougé l'année de 1re échéance : l'annuité 1 reste-t-elle la forme fermée au taux d'origine (SimPLUS!AM15) pendant que les intérêts de l'année 1 utilisent le taux révisé tx_1 ? Implémentation actuelle : oui (annuité 1 non révisée, intérêts au taux révisé de l'année). | ouverte | — |
