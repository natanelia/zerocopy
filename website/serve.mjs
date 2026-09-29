import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { basePath } from './config.mjs';
const root = fileURLToPath(new URL('_site/', import.meta.url));
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.md': 'text/plain', '.txt': 'text/plain', '.xml': 'application/xml' };
/** Serve the production output, including optional subpath and no-header tests. */
export function createPreview({ base = '/', isolated = true } = {}) {
  basePath(base);
  return createServer((request, response) => {
    let path;
    try { path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); } catch { response.writeHead(400).end(); return; }
    if (!path.startsWith(base)) { response.writeHead(404).end(); return; }
    let file = resolve(root, path.slice(base.length));
    if (file !== root.replace(/\/$/, '') && !file.startsWith(root.replace(/\/$/, '') + sep)) { response.writeHead(403).end(); return; }
    if (isolated) { response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); }
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (statSync(file).isDirectory()) {
        if (!path.endsWith('/')) { response.writeHead(301, { Location: path + '/' }).end(); return; }
        file = resolve(file, 'index.html');
      }
      const data = readFileSync(file); response.setHeader('Content-Type', `${types[extname(file)] ?? 'application/octet-stream'}; charset=utf-8`); response.end(data);
    } catch { response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(readFileSync(resolve(root, '404.html'))); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createPreview({ base: process.env.SITE_BASE ?? '/', isolated: process.env.SITE_ISOLATED !== 'false' });
  server.listen(Number(process.env.PORT ?? 4173), '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${server.address().port}${process.env.SITE_BASE ?? '/'}`));
}
