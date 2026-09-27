import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pages, repository, basePath } from './config.mjs';
import { renderMarkdown, escape } from './render.mjs';
import { shell, home, docsLayout, lab, playground, useCaseCards } from './templates.mjs';

const here = fileURLToPath(new URL('.', import.meta.url)), root = resolve(here, '..');
const out = join(here, '_site'), base = basePath(process.env.SITE_BASE ?? '/');
const origin = process.env.SITE_ORIGIN ? new URL(process.env.SITE_ORIGIN).origin : '';
const sha = process.env.SITE_COMMIT ?? process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[a-f\d]{40}$/.test(sha)) throw new Error('SITE_COMMIT must be a complete commit SHA');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!readdirSync(join(root, 'dist')).includes('shared.js')) throw new Error('Build the library with build:wasm and build:browser first');
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
cpSync(join(here, 'assets'), join(out, 'assets'), { recursive: true });
mkdirSync(join(out, 'library'));
for (const file of readdirSync(join(root, 'dist'))) if (file.endsWith('.js')) cpSync(join(root, 'dist', file), join(out, 'library', file));
const routes = new Map(pages.map(page => [page.source, `docs/${page.slug}/`]));
routes.set('README.md', ''); routes.set('docs/README.md', 'docs/getting-started/');
routes.set('playground/', 'playground/'); routes.set('lab/', 'lab/');
// A controlled page is not sufficient: dedicated worker entry URLs and their
// dependencies must also be inside the opt-in service worker's demo scope.
const demoScripts = new Map([
  ['lab/', ['main.mjs', 'capability.mjs', 'lab.mjs', 'bench-core.mjs', 'bench-runner.mjs', 'bench-reader.mjs']],
  ['playground/', ['main.mjs', 'capability.mjs', 'playground.mjs', 'snapshot-worker.mjs']],
]);
for (const [route, scripts] of demoScripts) {
  mkdirSync(join(out, route, 'assets'), { recursive: true });
  for (const file of scripts) cpSync(join(here, 'assets', file), join(out, route, 'assets', file));
  cpSync(join(out, 'library'), join(out, route, 'library'), { recursive: true });
}
const search = [], siteRoutes = [];
function writePage(route, title, description, body, script) {
  const destination = join(out, route); mkdirSync(destination, { recursive: true });
  let html = shell({ title, description, body, script, base, route, version, sha, origin });
  if (demoScripts.has(route)) {
    // Keep both main.mjs references identical so it registers each UI handler once.
    html = html.replaceAll(`src="${base}assets/`, `src="${base}${route}assets/`);
  }
  writeFileSync(join(destination, 'index.html'), html);
  siteRoutes.push(route);
}
writePage('', 'Share your data. Not copies.', 'Shared immutable collections for JavaScript and TypeScript. Direct reads across workers, stable snapshots, and optional task pools.', home(base), 'home.mjs');
writePage('lab/', 'Benchmark lab', 'Compare shared snapshots and structured-cloned maps in your browser. Checked outputs, raw samples, and no assumed winner.', lab(base), 'lab.mjs');
writePage('playground/', 'Snapshot playground', 'Make an edit and watch a real worker keep an earlier immutable snapshot.', playground(base), 'playground.mjs');
writePage('use-cases/', 'Built for shared work', 'Application patterns for data-heavy maps, editors, and analysis tools.', `<main id="main" class="wrap use-case-page"><div class="page-intro"><span class="eyebrow">APPLICATION PATTERNS</span><h1>Same data.<br>More possibilities.</h1><p>Keep large inputs available to the UI and workers. Start with the access pattern—not a new framework.</p></div>${useCaseCards(base)}<p class="case-footnote">These are implementation patterns, not customer testimonials or measured production case studies.</p></main>`);
for (const page of pages) {
  const source = readFileSync(join(root, page.source), 'utf8');
  const { html, toc } = renderMarkdown(source, page.source, routes, base);
  writePage(`docs/${page.slug}/`, page.title, page.description, docsLayout(page, html, toc, pages, base, sha));
  mkdirSync(join(out, 'markdown'), { recursive: true }); writeFileSync(join(out, 'markdown', `${page.slug}.md`), source);
  search.push({ title: page.title, description: page.description, route: `docs/${page.slug}/`, text: source.replace(/<!--.*?-->/gs, '').replace(/[`#*]/g, '').slice(0, 28000) });
}
writeFileSync(join(out, 'search.json'), JSON.stringify(search));
writeFileSync(join(out, 'build.json'), JSON.stringify({ sourceCommit: sha, version, base, pages: siteRoutes, librarySHA256: createHash('sha256').update(readFileSync(join(root, 'dist/shared.js'))).digest('hex') }, null, 2));
writeFileSync(join(out, '404.html'), shell({ title: 'Page not found', description: 'Find your way back to the zerocopy docs.', base, version, sha, body: `<main id="main" class="wrap not-found"><span class="eyebrow">404 / WRONG TURN</span><h1>This page isn't here.</h1><p>The data didn't disappear. This address just has no page.</p><a class="button primary" href="${base}docs/getting-started/">Open the documentation →</a></main>` }));
for (const route of ['lab', 'playground']) cpSync(join(here, 'assets/isolation-sw.js'), join(out, route, 'isolation-sw.js'));
writeFileSync(join(out, '.nojekyll'), '');
writeFileSync(join(out, '_headers'), '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  Cross-Origin-Resource-Policy: same-origin\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n');
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n${origin ? `Sitemap: ${origin}${base}sitemap.xml\n` : ''}`);
if (origin) writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${siteRoutes.map(route => `<url><loc>${escape(origin + base + route)}</loc></url>`).join('')}</urlset>`);
writeFileSync(join(out, 'llms.txt'), `# zerocopy\n\nShared immutable collections. Reads are local; tasks are optional.\n\nSource: ${repository}/commit/${sha}\n\n${pages.map(page => `- [${page.title}](${origin}${base}markdown/${page.slug}.md): ${page.description}`).join('\n')}\n`);
console.log(`Built ${siteRoutes.length} static pages at ${base}. Source ${sha.slice(0, 7)}. No client-side Markdown or UI framework.`);
