import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pages, projectName, repository, basePath } from './config.mjs';
import { renderMarkdown, escape } from './render.mjs';
import { comparison } from './comparison-template.mjs';
import { featureExplorer, featureBenchmark } from './feature-template.mjs';
import { writeFeatureMemoryAssets, injectFeatureMemoryCharts } from './feature-memory-charts.mjs';
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
const routes = new Map(pages.map(page => [page.source, `docs/${page.slug}/`]));
routes.set('README.md', ''); routes.set('docs/README.md', 'docs/getting-started/');
routes.set('playground/', 'playground/'); routes.set('lab/', 'lab/');
// A controlled page is not sufficient: dedicated worker entry URLs and their
// dependencies must also be inside the service worker's demo scope.
const demoScripts = new Map([
  ['compare/', ['main.mjs', 'capability.mjs', 'isolation.mjs', 'comparison.mjs', 'comparison-core.mjs', 'comparison-runner.mjs', 'comparison-reader.mjs', 'immutable-storage.mjs', 'immer-storage.mjs', 'explorer-core.mjs', 'explorer-peer.mjs', 'explorer-storage.mjs', 'explorer-reference.mjs']],
  ['lab/', ['main.mjs', 'capability.mjs', 'isolation.mjs', 'lab.mjs', 'bench-core.mjs', 'bench-runner.mjs', 'bench-reader.mjs', 'bench-maps.mjs']],
  ['explorer/', ['main.mjs', 'capability.mjs', 'isolation.mjs', 'explorer.mjs', 'explorer-core.mjs', 'explorer-peer.mjs', 'explorer-owner.mjs', 'explorer-storage.mjs', 'explorer-reader.mjs', 'immutable-storage.mjs']],
  ['investigation-benchmark/', ['main.mjs', 'capability.mjs', 'isolation.mjs', 'explorer-benchmark.mjs', 'explorer-bench-runner.mjs', 'immutable-storage.mjs', 'explorer-core.mjs', 'explorer-peer.mjs', 'explorer-storage.mjs', 'explorer-reader.mjs', 'explorer-reference.mjs', 'bench-core.mjs']],
  ['playground/', ['main.mjs', 'capability.mjs', 'isolation.mjs', 'playground.mjs', 'snapshot-worker.mjs']],
]);
const historicalDemos = new Map([['historical/log-compare/', demoScripts.get('compare/')], ['historical/log-explorer/', demoScripts.get('explorer/')], ['historical/log-benchmark/', demoScripts.get('investigation-benchmark/')]]);
const featureScripts = ['main.mjs', 'capability.mjs', 'isolation.mjs', 'feature-core.mjs', 'catalog-core.mjs', 'catalog-reference.mjs', 'catalog-peer.mjs', 'feature-storage.mjs', 'feature-peer.mjs', 'feature-reader.mjs', 'feature-owner.mjs'];
demoScripts.set('compare/', [...featureScripts, 'feature.mjs']);
demoScripts.delete('explorer/');
demoScripts.set('investigation-benchmark/', [...featureScripts, 'feature-benchmark.mjs']);
for (const [route, scripts] of historicalDemos) demoScripts.set(route, scripts);
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
  if (['compare/', 'investigation-benchmark/', 'docs/memory-comparison/', 'docs/historical-sharedlist-memory/', 'historical/log-compare/', 'historical/log-benchmark/'].includes(route)) {
    html = html.replace('</head>', `<link rel="stylesheet" href="${base}assets/memory-charts.css"></head>`);
  }
  if (['compare/', 'explorer/', 'investigation-benchmark/'].includes(route) || route.startsWith('historical/')) html = html.replace('</head>', `<link rel="stylesheet" href="${base}assets/feature.css"></head>`);
  if (route === 'historical/log-compare/') html = html.replace('</head>', `<link rel="stylesheet" href="${base}assets/comparison.css"></head>`);
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
writePage('compare/', 'Compare the shared product catalog', 'Compare SharedMap, native Map, Immutable.js Map and Immer Map with the same product records, sparse replacements, retained revisions and real workers.', featureExplorer(base, true), 'feature.mjs');
writePage('investigation-benchmark/', 'Product catalog worker benchmark', 'Measure construction, publication, first and repeated keyed reads, and sparse product edits with checked results.', featureBenchmark(base), 'feature-benchmark.mjs');
function historical(body) {
  for (const [current, old] of [['compare/', 'historical/log-compare/'], ['explorer/', 'historical/log-explorer/'], ['investigation-benchmark/', 'historical/log-benchmark/'], ['docs/memory-comparison/', 'docs/historical-sharedlist-memory/']]) body = body.replaceAll(`href="${base}${current}"`, `href="${base}${old}"`);
  return `<aside class="historical-notice">Historical SharedList log workload. These results do not measure the current product catalog. <a href="${base}compare/">Open the live product comparison →</a></aside>` + body;
}
function writeRedirect(route, target, title) {
  const destination = join(out, route); mkdirSync(destination, { recursive: true });
  const href = base + target;
  let html = shell({ title, description: title, body: `<main id="main" class="wrap"><h1>${title}</h1><p><a href="${href}">Continue directly →</a></p></main>`, base, route: target, version, sha, origin, noindex: true });
  html = html.replace('</head>', `<meta http-equiv="refresh" content="0;url=${href}"><script>location.replace(${JSON.stringify(href)} + location.search + location.hash)</script></head>`);
  writeFileSync(join(destination, 'index.html'), html);
}
writeRedirect('explorer/', 'compare/', 'Live product comparison');
writeRedirect('docs/maps/', 'docs/catalog/', 'Product catalog guide');
writePage('historical/log-compare/', 'Historical SharedList comparison', 'Historical log-column workload and its unchanged recorded measurements.', historical(comparison(base)), 'comparison.mjs');
writePage('historical/log-explorer/', 'Historical SharedList log explorer', 'The original log-column use case, retained as a historical reference.', historical(explorer(base)), 'explorer.mjs');
writePage('historical/log-benchmark/', 'Historical SharedList investigation benchmark', 'The original log-column timing workload, retained as a historical reference.', historical(investigationBenchmark(base)), 'explorer-benchmark.mjs');
writePage('lab/', 'Map benchmark: zerocopy vs Immutable.js vs Immer', 'Compare zerocopy, Immutable.js Map, and Immer Map across workers in your browser. Checked outputs, raw samples, and no assumed winner.', lab(base), 'lab.mjs');
writePage('playground/', 'Snapshot playground', 'Mark headphones as sold out and watch a real worker keep the earlier in-stock snapshot.', playground(base), 'playground.mjs');
writePage('use-cases/', 'Built for shared work', 'Use shared collections for observability, editors, large tables, product catalogs, graphs, and simulations.', `<main id="main" class="wrap use-case-page"><div class="page-intro"><span class="eyebrow">APPLICATION PATTERNS</span><h1>Same data.<br>More possibilities.</h1><p>Product records, document nodes, table rows and graph edges can share the same versioned collection pattern.</p></div>${useCaseCards(base)}<p><a class="text-link" href="${base}docs/use-cases/">Compare the use cases and alternatives →</a></p><p class="case-footnote">These are implementation patterns, not customer testimonials or measured production case studies.</p></main>`);
for (const page of pages) {
  const source = readFileSync(join(root, page.source), 'utf8');
  const rendered = renderMarkdown(source, page.source, routes, base);
  const html = page.slug === 'historical-sharedlist-memory' ? injectMemoryCharts(rendered.html, base) : page.slug === 'memory-comparison' ? injectFeatureMemoryCharts(rendered.html, base) : rendered.html;
  const { toc } = rendered;
  writePage(`docs/${page.slug}/`, page.title, page.description, docsLayout(page, html, toc, pages, base, sha));
  mkdirSync(join(out, 'markdown'), { recursive: true }); writeFileSync(join(out, 'markdown', `${page.slug}.md`), source);
  for (const section of rendered.sections) search.push({ title: page.title, description: page.description,
    heading: section.title, context: section.context, route: `docs/${page.slug}/${section.id ? '#' + section.id : ''}`, text: section.text });
}
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
writeFileSync(join(out, 'llms.txt'), `# zerocopy\n\nShared immutable collections. Reads are local; tasks are optional.\n\nSource: ${repository}/commit/${sha}\n\n${pages.map(page => `- [${page.title}](${origin}${base}markdown/${page.slug}.md): ${page.description}`).join('\n')}\n`);
console.log(`Built ${siteRoutes.length} static pages at ${base}. Source ${sha.slice(0, 7)}. No client-side Markdown or UI framework.`);
