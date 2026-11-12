import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pages, evidencePages, benchmarkRedirects, projectName, repository, basePath } from './config.mjs';
import { renderMarkdown, escape } from './render.mjs';
import { writeFeatureMemoryAssets } from './feature-memory-charts.mjs';
import { writeMemoryChartAssets } from './memory-charts.mjs';
import { shell, home, docsLayout, playground, useCaseCards } from './templates.mjs';
import { benchmarks } from './benchmarks-template.mjs';
import { benchmarkPerformancePanel } from './benchmark-performance.mjs';

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
writeFeatureMemoryAssets(join(out, 'assets'));
mkdirSync(join(out, 'library'));
for (const file of readdirSync(join(root, 'dist'))) if (file.endsWith('.js')) cpSync(join(root, 'dist', file), join(out, 'library', file));
// Keep the upstream dependency pinned, local, licensed, and inside demo scopes.
const immutablePackage = JSON.parse(readFileSync(join(root, 'node_modules/immutable/package.json'), 'utf8'));
const pinnedImmutable = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies.immutable;
if (immutablePackage.version !== pinnedImmutable) throw new Error('Install the pinned Immutable.js version before building');
mkdirSync(join(out, 'vendor'));
cpSync(join(root, 'node_modules/immutable/dist/immutable.es.js'), join(out, 'vendor/immutable.mjs'));
cpSync(join(root, 'node_modules/immutable/LICENSE'), join(out, 'vendor/immutable-LICENSE.txt'));
const immerPackage = JSON.parse(readFileSync(join(root, 'node_modules/immer/package.json'), 'utf8'));
if (immerPackage.version !== JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies.immer) throw new Error('Install the pinned Immer version before building');
cpSync(join(root, 'node_modules/immer/dist/immer.production.mjs'), join(out, 'vendor/immer.mjs'));
cpSync(join(root, 'node_modules/immer/LICENSE'), join(out, 'vendor/immer-LICENSE.txt'));
writeFileSync(join(out, 'vendor/version.mjs'), `export const immutableVersion = ${JSON.stringify(immutablePackage.version)};\nexport const immerVersion = ${JSON.stringify(immerPackage.version)};\n`);
const routes = new Map([...pages.map(page => [page.source, `docs/${page.slug}/`]), ...evidencePages.map(page => [page.source, page.target])]);
routes.set('README.md', ''); routes.set('docs/README.md', 'docs/getting-started/');
routes.set('playground/', 'playground/'); routes.set('lab/', 'benchmarks/#performance');
// A controlled page is not sufficient: dedicated worker entry URLs and their
// dependencies must also be inside the service worker's demo scope.
const demoScripts = new Map([
  ['playground/', ['main.mjs', 'capability.mjs', 'isolation.mjs', 'playground.mjs', 'snapshot-worker.mjs']],
]);
const featureScripts = ['main.mjs', 'capability.mjs', 'isolation.mjs', 'feature-core.mjs', 'catalog-core.mjs', 'catalog-reference.mjs', 'catalog-peer.mjs', 'catalog-timings.mjs', 'catalog-benchmark-core.mjs', 'feature-storage.mjs', 'feature-peer.mjs', 'feature-reader.mjs', 'feature-owner.mjs'];
demoScripts.set('benchmarks/', [...featureScripts, 'feature-benchmark.mjs', 'benchmark-bars.mjs']);
for (const [route, scripts] of demoScripts) {
  mkdirSync(join(out, route, 'assets'), { recursive: true });
  for (const file of [...scripts, 'search.mjs']) cpSync(join(here, 'assets', file), join(out, route, 'assets', file));
  cpSync(join(out, 'library'), join(out, route, 'library'), { recursive: true });
  if (scripts.includes('immutable-storage.mjs') || scripts.includes('bench-maps.mjs') || scripts.includes('feature-storage.mjs')) cpSync(join(out, 'vendor'), join(out, route, 'vendor'), { recursive: true });
}
const search = [], siteRoutes = [];
function writePage(route, title, description, body, script) {
  const destination = join(out, route); mkdirSync(destination, { recursive: true });
  let html = shell({ title, description, body, script, base, route, version, sha, origin, noindex: !!preview });
  if (route === 'benchmarks/') html = html.replace('</head>', `<link rel="stylesheet" href="${base}assets/benchmarks.css"></head>`);
  if (route === 'playground/') html = html.replace('</head>', `<link rel="stylesheet" href="${base}assets/studio.css"></head>`);
  if (preview) {
    html = html.replace('</head>', `<link rel="stylesheet" href="${base}assets/comparison.css"></head>`);
    html = html.replace('<header class="site-header">', `<aside class="preview-banner">PR #${preview.number} preview · ${preview.headCommit.slice(0, 7)} · Not a release · <a href="${repository}/pull/${preview.number}">Return to PR</a></aside><header class="site-header">`);
  }
  if (demoScripts.has(route)) {
    // Keep both main.mjs references identical so it registers each UI handler once.
    html = html.replaceAll(`src="${base}assets/`, `src="${base}${route}assets/`);
  }
  writeFileSync(join(destination, 'index.html'), html);
  siteRoutes.push(route);
}
writePage('', `${projectName}: Immutable collections for JavaScript and TypeScript`, `${projectName} shares immutable maps, lists, and sets across workers with SharedArrayBuffer and WebAssembly. Read locally without cloning the dataset.`, home(base), 'home.mjs');
writePage('benchmarks/', 'Memory and performance benchmarks', 'Compare recorded memory use, see measured performance results, and run the checked product-catalog benchmark on your device in one click.', benchmarks(base, benchmarkPerformancePanel(base)), 'feature-benchmark.mjs');
function writeRedirect(route, target, title, preserveHash = false) {
  const destination = join(out, route); mkdirSync(destination, { recursive: true });
  const [path, anchor] = target.split('#'), href = base + target;
  let html = shell({ title, description: title, body: `<main id="main" class="wrap"><h1>${title}</h1><p><a href="${href}">Continue directly →</a></p></main>`, base, route: path, version, sha, origin, noindex: true });
  // Queries belong before the destination fragment. Retired UI anchors do not
  // exist on the consolidated page, so each old route gets its relevant section.
  const hash = preserveHash ? 'location.hash' : JSON.stringify(anchor ? '#' + anchor : '');
  html = html.replace('</head>', `<meta http-equiv="refresh" content="0;url=${href}"><script>location.replace(${JSON.stringify(base + path)} + location.search + ${hash})</script></head>`);
  writeFileSync(join(destination, 'index.html'), html);
}
for (const { route, target } of benchmarkRedirects) writeRedirect(route, target, 'Benchmarks have moved');
writeRedirect('docs/maps/', 'docs/catalog/', 'Product catalog guide', true);
writePage('playground/', 'Snapshot studio', 'Edit products, publish revisions, and pin earlier snapshots in real reader workers. Explore immutable shared data in your browser.', playground(base), 'playground.mjs');
writePage('use-cases/', 'Built for shared work', 'Use shared collections for observability, editors, large tables, product catalogs, graphs, and simulations.', `<main id="main" class="wrap use-case-page"><div class="page-intro"><span class="eyebrow">APPLICATION PATTERNS</span><h1>Same data.<br>More possibilities.</h1><p>Product records, document nodes, table rows and graph edges can share the same versioned collection pattern.</p></div>${useCaseCards(base)}<p><a class="text-link" href="${base}docs/use-cases/">Compare the use cases and alternatives →</a></p><p class="case-footnote">These are implementation patterns, not customer testimonials or measured production case studies.</p></main>`);
for (const page of pages) {
  const source = readFileSync(join(root, page.source), 'utf8');
  const rendered = renderMarkdown(source, page.source, routes, base);
  const html = rendered.html;
  const { toc } = rendered;
  writePage(`docs/${page.slug}/`, page.title, page.description, docsLayout(page, html, toc, pages, base, sha));
  mkdirSync(join(out, 'markdown'), { recursive: true }); writeFileSync(join(out, 'markdown', `${page.slug}.md`), source);
  for (const section of rendered.sections) search.push({ title: page.title, description: page.description,
    heading: section.title, context: section.context, route: `docs/${page.slug}/${section.id ? '#' + section.id : ''}`, text: section.text });
}
for (const page of evidencePages) {
  mkdirSync(join(out, 'markdown'), { recursive: true });
  cpSync(join(root, page.source), join(out, 'markdown', `${page.slug}.md`));
}
for (const [heading, anchor, text] of [
  ['Memory', 'memory', 'Compare recorded whole-process memory use for ZeroCopy, native Map, Immutable.js and Immer, with two and four reader workers.'],
  ['Performance', 'performance', 'Run the product catalog benchmark in your browser. Compare shared snapshots, incremental copies and full copies.'],
  ['Method and source data', 'sources', 'Download recorded memory and performance measurements, original reports, samples, methodology and environment.'],
]) search.push({ title: 'Benchmarks', description: 'Memory and performance in one place.', heading, context: '', route: `benchmarks/#${anchor}`, text });
writeFileSync(join(out, 'search.json'), JSON.stringify(search));
writeFileSync(join(out, 'build.json'), JSON.stringify({ sourceCommit: sha, version, dependencies: { immutable: immutablePackage.version, immer: immerPackage.version }, base, ...(preview ? { preview } : {}), pages: siteRoutes, librarySHA256: createHash('sha256').update(readFileSync(join(root, 'dist/shared.js'))).digest('hex') }, null, 2));
writeFileSync(join(out, '404.html'), shell({ title: 'Page not found', route: '404.html', description: 'Find your way back to the zerocopy docs.', base, version, sha, noindex: true, body: `<main id="main" class="wrap not-found"><span class="eyebrow">404 / WRONG TURN</span><h1>This page isn't here.</h1><p>The data didn't disappear. This address just has no page.</p><a class="button primary" href="${base}docs/getting-started/">Open the documentation →</a></main>` }));
for (const route of demoScripts.keys()) cpSync(join(here, 'assets/isolation-sw.js'), join(out, route, 'isolation-sw.js'));
writeFileSync(join(out, '.nojekyll'), '');
writeFileSync(join(out, '_headers'), '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  Cross-Origin-Resource-Policy: same-origin\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n');
// Let crawlers fetch preview HTML so they can observe its noindex directive.
// A project-site robots.txt is not host-root crawl control on GitHub Pages.
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n${origin && !preview ? `Sitemap: ${origin}${base}sitemap.xml\n` : ''}`);
if (origin && !preview) writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${siteRoutes.map(route => `<url><loc>${escape(origin + base + route)}</loc></url>`).join('')}</urlset>`);
writeFileSync(join(out, 'llms.txt'), `# zerocopy\n\nShared immutable collections. Reads are local; tasks are optional.\n\nSource: ${repository}/commit/${sha}\nBenchmarks: ${origin}${base}benchmarks/\n\n${pages.map(page => `- [${page.title}](${origin}${base}markdown/${page.slug}.md): ${page.description}`).join('\n')}\n\n## Recorded evidence\n\n${evidencePages.map(page => `- [${page.title}](${origin}${base}markdown/${page.slug}.md)`).join('\n')}\n`);
console.log(`Built ${siteRoutes.length} static pages at ${base}. Source ${sha.slice(0, 7)}. No client-side Markdown or UI framework.`);
