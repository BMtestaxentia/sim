/**
 * Serveur statique minimal, pour ouvrir l'interface dans un navigateur.
 *
 * Aucune dependance : le projet s'interdit toute bibliotheque de production
 * (CLAUDE.md §3) et n'a pas de raison d'en prendre une pour servir des
 * fichiers. `node outils/serveur_local.mjs` suffit.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const RACINE = process.cwd();
const PORT = Number(process.env.PORT) || 8731;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const chemin = url === '/' ? '/ui/index.html' : url.endsWith('/') ? url + 'index.html' : url;
  // `normalize` empeche de remonter au-dessus de la racine par `..`.
  // `normalize` empeche de remonter au-dessus de la racine par `..`.
  const sur = normalize(chemin).replace(/^([.][.][/\\])+/, '');
  // Deux racines, dans l'ordre : le depot, puis `ui/`. La page est servie a la
  // racine du serveur mais vit dans `ui/`, si bien que son `style.css` relatif
  // arrive en `/style.css`. Chercher aussi dans `ui/` evite d'avoir a reecrire
  // les chemins de la page pour la seule commodite du serveur - et le moteur
  // (`/src`) comme les referentiels restent servis depuis le depot.
  for (const base of [RACINE, join(RACINE, 'ui')]) {
    try {
      const fichier = join(base, sur);
      const corps = await readFile(fichier);
      res.writeHead(200, { 'content-type': TYPES[extname(fichier)] ?? 'application/octet-stream' });
      res.end(corps);
      return;
    } catch {
      /* on essaie la racine suivante */
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Introuvable : ' + chemin);
}).listen(PORT, () => console.log('Interface servie sur http://localhost:' + PORT));
