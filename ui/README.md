# Interface de montage d'opération

Trois écrans, un seul document :

- **Opération** — saisie : identification, calendrier, programme, prix de revient,
  subventions et fonds propres, prêts.
- **Plan de financement** — restitution : équilibre, emplois, ressources, prêts,
  indicateurs, contrôles.
- **Paramètres du modèle** — barèmes, prêts CDC par défaut, coefficient de
  structure, trajectoires. **En lecture seule** : ces valeurs sont versionnées
  dans le dépôt, les rendre modifiables produirait des simulations non
  reproductibles.

L'organisation reprend celle de la maquette Excel LEON REWORK : écrans séparés,
unités dans les libellés, blocs du général au particulier, notes de renvoi
préfixées d'un engrenage. Avec une correction : la maquette ne distingue pas le
saisi du calculé, ici tout champ calculé par le moteur est grisé et non
modifiable.

Deux façons d'ouvrir la même interface. Le calcul est identique : les deux
importent le même moteur, seule la manière de le charger diffère.

## Sans rien installer (recommandé sur poste sans droits)

Ouvrir `ui/simulation-autonome.html` par double-clic. C'est un fichier unique,
sans serveur, sans node, sans connexion réseau — vérifié : la page ne charge
aucune ressource distante. La police Manrope de la charte SFO est utilisée si
elle est installée sur le poste, sinon la pile système prend le relais. Elle
n'est volontairement pas chargée depuis un service externe, ce qui
contredirait le fonctionnement hors ligne.

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

Le générateur échoue bruyamment plutôt que de produire un fichier cassé. Il
refuse : un module du moteur absent de sa liste, un `await` de premier niveau
restant, et **toute collision de nom racine** — y compris entre le moteur et
`app.js`, puisque tout est concaténé dans une seule portée. Si vous ajoutez une
constante à `app.js`, vérifiez qu'aucun module de `src/` ne porte déjà ce nom.

## Ce que l'interface ne fait pas

Elle ne contient **aucune règle de calcul**. Toute valeur affichée vient de
`calculer(entrees, referentiels)`. C'est ce qui garantit que l'écran et les
golden tests parlent du même moteur. Le bouton « Voir le JSON » montre le
résultat brut, utile pour vérifier qu'un chiffre affiché correspond bien à ce
que le moteur a produit.
