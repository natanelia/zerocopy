import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pages, repository, basePath } from './config.mjs';
import { renderMarkdown, escape } from './render.mjs';
import { comparison } from './comparison-template.mjs';
import { injectMemoryCharts, writeMemoryChartAssets } from './memory-charts.mjs';
import { explorer } from './explorer-template.mjs';
import { investigationBenchmark } from './explorer-benchmark-template.mjs';
import { shell, home, docsLayout, lab, playground, useCaseCards } from './templates.mjs';

const here = fileURLToPath(new URL('.', import.meta.url)), root = resolve(here, '..');
const out = join(here, '_site'), base = basePath(process.env.SITE_BASE ?? '/');
const origin = process.env.SITE_ORIGIN ? new URL(process.env.SITE_ORIGIN).origin : '';
const sha = process.env.SITE_COMMIT ?? process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[a-f\d]{40}$/.test(sha)) throw new Error('SITE_COMMIT must be a complete commit SHA');
const previewNumber = Number(process.env.SITE_PREVIEW_PR || 0);
const preview = previewNumber ? { number: previewNumber, headCommit: process.env.SITE_HEAD_COMMIT } : undefined;
if (preview && (!Number.isSafeInteger(preview.number) || preview.number < 1 || !/^[a-f0-9]{40}$/.test(preview.headCommit))) throw new Error('Invalid preview metadata');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!readdirSync(join(root, 'dist')).includes('shared.js')) throw new Error('Build the library with build:wasm and build:browser first');
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
cpSync(join(here, 'assets'), join(out, 'assets'), { recursive: true });
writeMemoryChartAssets(join(out, 'assets'));
mkdirSync(join(out, 'library'));
for (const file of readdirSync(join(root, 'dist'))) if (file.endsWith('.js')) cpSync(join(root, 'dist', file), join(out, 'library', file));
// Keep the upstream dependency pinned, local, licensed, and inside demo scopes.
const immutablePackage = JSON.parse(readFileSync(join(root, 'node_modules/immutable/package.json'), 'utf8'));
const pinnedImmutable = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies.immutable;
if (immutablePackage.version !== pinnedImmutable) throw new Error('Install the pinned Immutable.js version before building');
mkdirSync(join(out, 'vendor'));
cpSync(join(root, 'node_modules/immutable/dist/immutable.es.js'), join(out, 'vendor/immutable.mjs'));
cpSync(join(root, 'node_modules/immutable/LICENSE'), join(out, 'vendor/immutable-LICENSE.txt'));
writeFileSync(join(out, 'vendor/version.mjs'), `export const immutableVersion = ${JSON.stringify(immutablePackage.version)};\n`);
const routes = new Map(pages.map(page => [page.source, `docs/${page.slug}/`]));
routes.set('README.md', ''); routes.set('docs/README.md', 'docs/getting-started/');
routes.set('playground/', 'playground/'); routes.set('lab/', 'lab/');
// A controlled page is not sufficient: dedicated worker entry URLs and their
// dependencies must also be inside the service worker's demo scope.
const demoScripts = new Map([
  ['compare/', ['main.mjs', 'capability.mjs', 'isolation.mjs', 'comparison.mjs', 'comparison-core.mjs', 'comparison-runner.mjs', 'comparison-reader.mjs', 'immutable-storage.mjs', 'explorer-core.mjs', 'explorer-peer.mjs', 'explorer-storage.mjs', 'explorer-reference.mjs']],
  ['lab/', ['main.mjs', 'capability.mjs', 'isolation.mjs', 'lab.mjs', 'bench-core.mjs', 'bench-runner.mjs', 'bench-reader.mjs']],
  ['explorer/', ['main.mjs', 'capability.mjs', 'isolation.mjs', 'explorer.mjs', 'explorer-core.mjs', 'explorer-peer.mjs', 'explorer-owner.mjs', 'explorer-storage.mjs', 'explorer-reader.mjs', 'immutable-storage.mjs']],
  ['investigation-benchmark/', ['main.mjs', 'capability.mjs', 'isolation.mjs', 'explorer-benchmark.mjs', 'explorer-bench-runner.mjs', 'immutable-storage.mjs', 'explorer-core.mjs', 'explorer-peer.mjs', 'explorer-storage.mjs', 'explorer-reader.mjs', 'explorer-reference.mjs', 'bench-core.mjs']],
  ['playground/', ['main.mjs', 'capability.mjs', 'isolation.mjs', 'playground.mjs', 'snapshot-worker.mjs']],
]);
for (const [route, scripts] of demoScripts) {
  mkdirSync(join(out, route, 'assets'), { recursive: true });
  for (const file of scripts) cpSync(join(here, 'assets', file), join(out, route, 'assets', file));
  cpSync(join(out, 'library'), join(out, route, 'library'), { recursive: true });
  if (scripts.includes('immutable-storage.mjs')) cpSync(join(out, 'vendor'), join(out, route, 'vendor'), { recursive: true });
}
const search = [], siteRoutes = [];
function writePage(route, title, description, body, script) {
  const destination = join(out, route); mkdirSync(destination, { recursive: true });
  let html = shell({ title, description, body, script, base, route, version, sha, origin, noindex: !!preview });
  if (['compare/', 'investigation-benchmark/', 'docs/memory-comparison/'].includes(route)) {
    html = html.replace('</head>', `<link rel="stylesheet" href="${base}assets/memory-charts.css"></head>`);
  }
  if (preview) {
    html = html.replace('</head>', `<link rel="stylesheet" href="${base}assets/comparison.css"></head>`);
    html = html.replace('<header class="site-header">', `<aside class="preview-banner">PR #${preview.number} preview · ${preview.headCommit.slice(0, 7)} · Not a release · <a href="${repository}/pull/${preview.number}">Return to PR</a></aside><header class="site-header">`);
  }
  if (route === 'compare/' && !preview) html = html.replace('</head>', `<link rel="stylesheet" href="${base}assets/comparison.css"></head>`);
  if (demoScripts.has(route)) {
    // Keep both main.mjs references identical so it registers each UI handler once.
    html = html.replaceAll(`src="${base}assets/`, `src="${base}${route}assets/`);
  }
  writeFileSync(join(destination, 'index.html'), html);
  siteRoutes.push(route);
}
writePage('', 'zerocopy: Zero-copy immutable collections for JavaScript and TypeScript', 'Share immutable maps, lists, and sets across Web Workers with SharedArrayBuffer and WebAssembly. Local reads, stable snapshots, and no dataset cloning.', home(base).replace(`href="${base}explorer/">See it work`, `href="${base}compare/">Compare it live`), 'home.mjs');
writePage('compare/', 'zerocopy vs Immutable.js vs native', 'Run shared snapshots, Immutable.js Lists, and native replicas side by side. Same events, checked outputs, real timings, no artificial delays.', comparison(base), 'comparison.mjs');
writePage('explorer/', 'Log explorer · one example of shared work', 'Search and summarize 100,000 generated events with real workers. Freeze an investigation while ingestion continues.', explorer(base).replace('<div class="explorer-setup">', `<p><a class="text-link" href="${base}compare/">Compare zerocopy, Immutable.js, and native arrays →</a></p><div class="explorer-setup">`), 'explorer.mjs');
writePage('investigation-benchmark/', 'Compare four investigation architectures', 'Measure shared snapshots, Immutable.js Lists, incremental native replicas, and one native data-owning worker with checked results.', investigationBenchmark(base), 'explorer-benchmark.mjs');
writePage('lab/', 'Benchmark lab', 'Compare shared snapshots and structured-cloned maps in your browser. Checked outputs, raw samples, and no assumed winner.', lab(base), 'lab.mjs');
writePage('playground/', 'Snapshot playground', 'Mark headphones as sold out and watch a real worker keep the earlier in-stock snapshot.', playground(base), 'playground.mjs');
writePage('use-cases/', 'Built for shared work', 'Use shared collections for observability, editors, large tables, product catalogs, graphs, and simulations.', `<main id="main" class="wrap use-case-page"><div class="page-intro"><span class="eyebrow">APPLICATION PATTERNS</span><h1>Same data.<br>More possibilities.</h1><p>Logs are one example, not the product. Use zerocopy wherever several threads need local reads of large, versioned collections.</p></div>${useCaseCards(base)}<p><a class="text-link" href="${base}docs/use-cases/">Compare the use cases and alternatives →</a></p><p class="case-footnote">These are implementation patterns, not customer testimonials or measured production case studies.</p></main>`);
for (const page of pages) {
  const source = readFileSync(join(root, page.source), 'utf8');
  const rendered = renderMarkdown(source, page.source, routes, base);
  const html = page.slug === 'memory-comparison' ? injectMemoryCharts(rendered.html, base) : rendered.html;
  const { toc } = rendered;
  writePage(`docs/${page.slug}/`, page.title, page.description, docsLayout(page, html, toc, pages, base, sha));
  mkdirSync(join(out, 'markdown'), { recursive: true }); writeFileSync(join(out, 'markdown', `${page.slug}.md`), source);
  search.push({ title: page.title, description: page.description, route: `docs/${page.slug}/`, text: source.replace(/<!--.*?-->/gs, '').replace(/[`#*]/g, '').slice(0, 28000) });
}
writeFileSync(join(out, 'search.json'), JSON.stringify(search));
writeFileSync(join(out, 'build.json'), JSON.stringify({ sourceCommit: sha, version, dependencies: { immutable: immutablePackage.version }, base, ...(preview ? { preview } : {}), pages: siteRoutes, librarySHA256: createHash('sha256').update(readFileSync(join(root, 'dist/shared.js'))).digest('hex') }, null, 2));
writeFileSync(join(out, '404.html'), shell({ title: 'Page not found', description: 'Find your way back to the zerocopy docs.', base, version, sha, noindex: true, body: `<main id="main" class="wrap not-found"><span class="eyebrow">404 / WRONG TURN</span><h1>This page isn't here.</h1><p>The data didn't disappear. This address just has no page.</p><a class="button primary" href="${base}docs/getting-started/">Open the documentation →</a></main>` }));
for (const route of ['lab', 'playground', 'explorer', 'investigation-benchmark', 'compare']) cpSync(join(here, 'assets/isolation-sw.js'), join(out, route, 'isolation-sw.js'));
writeFileSync(join(out, '.nojekyll'), '');
writeFileSync(join(out, '_headers'), '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  Cross-Origin-Resource-Policy: same-origin\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n');
// Let crawlers fetch preview HTML so they can observe its noindex directive.
// A project-site robots.txt is not host-root crawl control on GitHub Pages.
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n${origin && !preview ? `Sitemap: ${origin}${base}sitemap.xml\n` : ''}`);
if (origin && !preview) writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${siteRoutes.map(route => `<url><loc>${escape(origin + base + route)}</loc></url>`).join('')}</urlset>`);
writeFileSync(join(out, 'llms.txt'), `# zerocopy\n\nShared immutable collections. Reads are local; tasks are optional.\n\nSource: ${repository}/commit/${sha}\n\n${pages.map(page => `- [${page.title}](${origin}${base}markdown/${page.slug}.md): ${page.description}`).join('\n')}\n`);
console.log(`Built ${siteRoutes.length} static pages at ${base}. Source ${sha.slice(0, 7)}. No client-side Markdown or UI framework.`);
