// @ts-check
/**
 * Serveur statique minimal pour l'interface de saisie.
 *
 *   npm run ui       puis ouvrir http://localhost:4173/ui/
 *
 * Sert la racine du repo, ce qui permet a `ui/app.js` d'importer `src/moteur.js`
 * tel quel (ESM natif, aucun build) et de charger `referentiels/*.json` par fetch.
 * Aucune dependance : uniquement les modules internes de Node.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const PORT = Number(process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const serveur = createServer(async (req, res) => {
  try {
    let chemin = decodeURIComponent((req.url ?? '/').split('?')[0]);

    // Redirection (et non reecriture) : la page doit reellement vivre sous /ui/,
    // sinon les chemins relatifs de ses modules ESM se resolvent depuis la racine.
    if (chemin === '/') {
      res.writeHead(302, { Location: '/ui/' }).end();
      return;
    }
    if (chemin.endsWith('/')) chemin += 'index.html';

    // Garde-fou : interdit toute sortie de la racine du repo (traversee de repertoire).
    const cible = normalize(join(RACINE, chemin));
    if (!cible.startsWith(RACINE + sep)) {
      res.writeHead(403).end('Acces refuse');
      return;
    }

    const contenu = await readFile(cible);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(cible)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store', // on veut voir les modifications immediatement
    });
    res.end(contenu);
  } catch (e) {
    const introuvable = /** @type {any} */ (e).code === 'ENOENT';
    res.writeHead(introuvable ? 404 : 500).end(introuvable ? 'Introuvable' : 'Erreur serveur');
  }
});

serveur.listen(PORT, () => {
  console.log(`Interface de saisie : http://localhost:${PORT}/ui/`);
});
