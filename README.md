# moteur-sim

Moteur de calcul de simulations financières d'opérations de logement social (successeur de la matrice LEON / Scepia). Réécriture paramétrique, testée contre les annexes LEON officielles (golden tests).

**Périmètre V1** : PLUS/PLAI habitat (neuf / VEFA / acquisition-amélioration). Cible : PLS, LLI, LIBRE, foyers - le produit est une donnée, pas une duplication de code.

## Pourquoi ce repo est privé

Les fixtures de `fixtures/` contiennent des données d'opérations réelles AXENTIA (annexes LEON). Rien de ce repo ne doit être copié vers le repo public `exnihilo` (application SFO).

## Stack

JavaScript ESM pur + JSDoc (`// @ts-check`), **sans build ni transpilation**. Le moteur s'importe tel quel dans Node (tests) et dans le navigateur (future intégration à la maquette SFO). Seule dépendance de dev : Vitest.

```bash
npm install      # installe Vitest
npm test         # lance les golden tests + tests unitaires
npm run check    # vérification de types via JSDoc (tsc --checkJs, si tsc dispo)
```

## Structure

- `src/formules/` - tous les calculs, écrits en formules : le langage, le classeur qui les exécute, et une grandeur par valeur calculée, domaine par domaine (`domaines/`) ; leur écriture Excel (`ecriture.js`) et les modifications du modèle (`surcharges.js`)
- `src/` - l'orchestration (`moteur.js`) et la restitution de chaque domaine de règles R-xxx du dictionnaire
- `ui/` - l'interface ; `ui/tableur.js` est l'onglet Calculs : tout le modèle en feuilles comme dans Excel, la formule de chaque chiffre et ce qui l'alimente, et les modifications du modèle
- `referentiels/` - barèmes et trajectoires versionnés (extraits de la matrice, cellules sources citées)
- `fixtures/` - jeux d'or (entrees.json + attendus.json par opération)
- `tests/` - cas canoniques + comparaison aux annexes
- `docs/` - dictionnaire des règles (spec de référence), brief, écarts LEON, questions de spec
- `CLAUDE.md` - règles du projet pour toute session Claude

## Documentation

- Spécification métier : `docs/DICTIONNAIRE_REGLES_MOTEUR_PLUSPLAI_v0.1.md`
- Séquence de travail : `docs/BRIEF_DEMARRAGE_CLAUDE_CODE.md`
- Règles projet : `CLAUDE.md`
