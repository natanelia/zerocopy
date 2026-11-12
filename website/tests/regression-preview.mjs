/**
 * Test-only pages for the retained benchmark engines and original UI regressions.
 * Nothing here is written to _site or published. Product navigation tests use the
 * ordinary preview server and therefore see redirects, not these fixtures.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createPreview } from '../serve.mjs';
import { basePath, pages, repository } from '../config.mjs';
import { shell, docsLayout, lab } from '../templates.mjs';
import { featureExplorer, featureBenchmark } from '../feature-template.mjs';
import { comparison } from '../comparison-template.mjs';
import { explorer } from '../explorer-template.mjs';
import { investigationBenchmark } from '../explorer-benchmark-template.mjs';
import { renderMarkdown } from '../render.mjs';
import { injectMemoryCharts } from '../memory-charts.mjs';
import { injectFeatureMemoryCharts } from '../feature-memory-charts.mjs';

const meta = JSON.parse(readFileSync(new URL('../_site/build.json', import.meta.url)));
const demos = new Map([
  ['compare/', { title: 'Product catalog regression fixture', render: base => featureExplorer(base, true), script: 'feature.mjs' }],
  ['investigation-benchmark/', { title: 'Catalog benchmark regression fixture', render: featureBenchmark, script: 'feature-benchmark.mjs' }],
  ['lab/', { title: 'Map transport regression fixture', render: lab, script: 'lab.mjs' }],
  ['historical/log-explorer/', { title: 'Historical log explorer regression fixture', render: explorer, script: 'explorer.mjs' }],
  ['historical/log-compare/', { title: 'Historical log comparison regression fixture', render: comparison, script: 'comparison.mjs' }],
  ['historical/log-benchmark/', { title: 'Historical log benchmark regression fixture', render: investigationBenchmark, script: 'explorer-benchmark.mjs' }],
]);
const reports = [
  { source: 'docs/feature-map-memory.md', slug: 'memory-comparison', title: 'SharedMap memory comparison', group: 'Recorded evidence', description: 'Original recorded memory evidence.' },
  { source: 'docs/memory-comparison.md', slug: 'historical-sharedlist-memory', title: 'Historical SharedList memory', group: 'Recorded evidence', description: 'Historical recorded memory evidence.' },
];

function historical(body, base) {
  for (const [current, old] of [['compare/', 'historical/log-compare/'], ['explorer/', 'historical/log-explorer/'], ['investigation-benchmark/', 'historical/log-benchmark/'], ['docs/memory-comparison/', 'docs/historical-sharedlist-memory/']]) body = body.replaceAll(`href="${base}${current}"`, `href="${base}${old}"`);
  return '<aside class="historical-notice">Historical SharedList log workload. Test-only regression fixture.</aside>' + body;
}

export function regressionHTML(route, base = meta.base) {
  basePath(base);
  let body, script, title;
  const demo = demos.get(route), report = reports.find(page => `docs/${page.slug}/` === route);
  if (demo) {
    ({ script, title } = demo); body = demo.render(base);
    if (route.startsWith('historical/')) body = historical(body, base);
  } else if (report) {
    title = report.title;
    const source = readFileSync(new URL('../../' + report.source, import.meta.url), 'utf8');
    const routes = new Map([...pages, ...reports].map(page => [page.source, `docs/${page.slug}/`]));
    routes.set('README.md', ''); routes.set('docs/README.md', 'docs/getting-started/');
    const rendered = renderMarkdown(source, report.source, routes, base);
    const charts = report.slug === 'memory-comparison' ? injectFeatureMemoryCharts(rendered.html, base) : injectMemoryCharts(rendered.html, base);
    body = docsLayout(report, charts, rendered.toc, [...pages.filter(page => !reports.some(item => item.slug === page.slug)), ...reports], base, meta.sourceCommit);
  } else if (route === 'explorer/') {
    const target = base + 'compare/';
    return `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${target}"><script>location.replace(${JSON.stringify(target)} + location.search + location.hash)</script></head><body><a href="${target}">Continue to regression fixture</a></body></html>`;
  } else return undefined;
  let html = shell({ title, description: 'Test-only benchmark regression fixture. Never published.', body, script, base, route, version: meta.version, sha: meta.sourceCommit, noindex: true });
  for (const style of ['memory-charts.css', 'feature.css', ...(route === 'historical/log-compare/' ? ['comparison.css'] : [])]) html = html.replace('</head>', `<link rel="stylesheet" href="${base}assets/${style}"></head>`);
  if (meta.preview) html = html.replace('<header class="site-header">', `<aside class="preview-banner">PR #${meta.preview.number} preview · ${meta.preview.headCommit.slice(0, 7)} · Not a release · <a href="${repository}/pull/${meta.preview.number}">Return to PR</a></aside><header class="site-header">`);
  if (demo) html = html.replaceAll(`src="${base}assets/`, `src="${base}${route}assets/`);
  return html;
}

export function createRegressionPreview({ base = '/', isolated = true } = {}) {
  basePath(base);
  const production = createPreview({ base, isolated });
  const serve = production.listeners('request')[0];
  return createServer((request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch { serve(request, response); return; }
    if (!url.pathname.startsWith(base)) { serve(request, response); return; }
    const route = url.pathname.slice(base.length), html = regressionHTML(route, base);
    if (html !== undefined) {
      if (isolated) { response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(html); return;
    }
    for (const prefix of demos.keys()) if (route.startsWith(prefix)) {
      const asset = route.slice(prefix.length);
      if (/^(?:assets|library|vendor)\//.test(asset)) request.url = base + asset + url.search;
      else if (asset === 'isolation-sw.js') request.url = base + 'assets/isolation-sw.js' + url.search;
      break;
    }
    serve(request, response);
  });
}
