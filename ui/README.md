# Interface de saisie

Deux façons d'ouvrir la même interface. Le calcul est identique : les deux
importent le même moteur, seule la manière de le charger diffère.

## Sans rien installer (recommandé sur poste sans droits)

Ouvrir `ui/simulation-autonome.html` par double-clic. C'est un fichier unique,
sans serveur, sans node, sans connexion réseau.

Ce fichier est **généré** : ne jamais l'éditer à la main. Il est versionné dans
le dépôt uniquement parce que le poste cible ne peut pas lancer node et ne
pourrait donc pas le régénérer.

## Avec node (développement)

```bash
npm run ui
```

puis ouvrir <http://localhost:4173/ui/>. Cette version importe `src/moteur.js`
directement : toute modification du moteur est visible au rechargement, sans
étape de génération.

## Après toute modification de `src/` ou de `ui/`

Régénérer le fichier autonome, sinon il diverge silencieusement du moteur :

```bash
node outils/generer_ui_autonome.js
```

Le générateur échoue bruyamment en cas de collision de noms entre modules ou de
`await` de premier niveau restant, plutôt que de produire un fichier cassé.

## Ce que l'interface ne fait pas

Elle ne contient **aucune règle de calcul**. Toute valeur affichée vient de
`calculer(entrees, referentiels)`. C'est ce qui garantit que l'écran et les
golden tests parlent du même moteur. Le bouton « Voir le JSON » montre le
résultat brut, utile pour vérifier qu'un chiffre affiché correspond bien à ce
que le moteur a produit.
