import { escape, codeBlock } from './render.mjs';
import { cityDemo } from './city-demo.mjs';
import { projectName, repository, npmPackage } from './config.mjs';

const arrow = '<svg class="link-arrow" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 13 13 3M4 3h9v9"/></svg>';
export function shell({ title, description, body, base, route = '', script, version, sha, origin, noindex = false }) {
  const href = path => base + path;
  const wordmark = `<a class="wordmark" href="${href('')}" aria-label="zerocopy home"><span class="brand-symbol" aria-hidden="true"></span>zerocopy</a>`;
  const navigation = [
    ['Docs', 'docs/getting-started/', route.startsWith('docs/')],
    ['Use cases', 'use-cases/', route === 'use-cases/'],
    ['Benchmarks', 'investigation-benchmark/', route === 'investigation-benchmark/'],
  ].map(([label, path, active]) => {
    const current = active ? ` aria-current="${route === path ? 'page' : 'location'}"` : '';
    return `<a href="${href(path)}"${current}>${label}</a>`;
  }).join('');
  const canonical = origin ? `<link rel="canonical" href="${escape(origin + href(route))}"><meta property="og:url" content="${escape(origin + href(route))}">` : '';
  const pageTitle = route ? `${title} · zerocopy` : title;
  // Describe the source project once, on the indexable canonical homepage.
  const project = origin && !route && !noindex ? {
    '@context': 'https://schema.org',
    '@type': 'SoftwareSourceCode',
    '@id': repository,
    name: projectName,
    alternateName: 'zerocopy',
    description,
    url: origin + base,
    codeRepository: repository,
    programmingLanguage: ['TypeScript', 'JavaScript'],
    license: `${repository}/blob/main/LICENSE`,
    sameAs: [npmPackage],
  } : undefined;
  // JSON-LD is raw script text: HTML entities are not decoded here.
  const structuredData = project ? `<script type="application/ld+json">${JSON.stringify(project).replaceAll('<', '\\u003c')}</script>` : '';
  const metadata = `<meta property="og:site_name" content="zerocopy"><meta name="twitter:card" content="summary">${noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f8f5ed"><title>${escape(pageTitle)}</title><meta name="description" content="${escape(description)}"><meta property="og:title" content="${escape(pageTitle)}"><meta property="og:description" content="${escape(description)}"><meta property="og:type" content="website">${canonical}${metadata}${structuredData}<link rel="icon" href="${href('assets/icon.svg')}" type="image/svg+xml"><link rel="preload" as="font" type="font/woff2" crossorigin href="${href('assets/bricolage-grotesque-latin.woff2')}"><link rel="stylesheet" href="${href('assets/site.css')}">${['historical/log-explorer/', 'historical/log-benchmark/'].includes(route) ? `<link rel="stylesheet" href="${href('assets/explorer.css')}">` : ''}<script type="module" src="${href('assets/main.mjs')}"></script>${script ? `<script type="module" src="${href('assets/' + script)}"></script>` : ''}${route ? '' : `<link rel="stylesheet" href="${href('assets/home.css')}">`}</head><body data-base="${base}" data-source="${sha}"><a class="skip" href="#main">Skip to content</a>
  <header class="site-header">${wordmark}<nav class="desktop-nav" aria-label="Main">${navigation}</nav><div class="header-actions"><button class="search-open" aria-label="Search documentation"><svg width="17" height="17" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m12 12 5 5" stroke="currentColor" stroke-width="1.5"/></svg></button><a class="github-link" href="${repository}">GitHub</a><button class="menu-toggle" aria-expanded="false" aria-controls="mobile-nav">Menu</button></div></header>
  <nav id="mobile-nav" class="mobile-nav" aria-label="Mobile" hidden>${navigation}<a href="${href('compare/')}">Live comparison</a><a href="${href('playground/')}">Small snapshot example</a><a href="${repository}">GitHub</a></nav>
  ${body}
  <footer class="site-footer"><div>${wordmark}<p><a href="${repository}">${projectName}</a></p></div><div class="footer-links"><a href="${href('docs/getting-started/')}">Get started</a><a href="${href('docs/memory/')}">Know the trade-offs</a><a href="${repository}/issues">Feedback ${arrow}</a><a href="${npmPackage}">npm package ${arrow}</a><a href="${repository}/blob/main/LICENSE">MIT license</a></div><p class="build-info">Source build v${escape(version)} · <a href="${repository}/commit/${sha}">${sha.slice(0, 7)}</a><br>No analytics. Benchmarks stay in your browser.</p></footer>
  <dialog class="search-dialog" aria-labelledby="search-title"><div class="search-top"><label id="search-title" for="search-input">Search the docs</label><button class="search-close" aria-label="Close search">Esc</button></div><input id="search-input" type="search" placeholder="Try “worker”, “typed object”, or “compaction”…" autocomplete="off" aria-describedby="search-status search-help" aria-controls="search-results"><p id="search-status" role="status">Type a topic to find a guide.</p><button id="search-retry" class="text-button" type="button" hidden>Retry search</button><nav aria-label="Search results"><ol id="search-results"></ol></nav><p id="search-help">↓ ↑ to move · Enter to open · Esc to close</p><a class="search-browse" href="${href('docs/getting-started/')}">Browse documentation →</a></dialog><div class="toast" role="status" aria-live="polite"></div>
  </body></html>`;
}

export function home(base) {
  const main = `import { Worker } from 'node:worker_threads';
import { SharedMap } from 'zerocopy';
import { createState } from 'zerocopy/state';

const stock = new SharedMap('number').set('pens', 12);
const state = createState({ stock });
const worker = new Worker(new URL('./worker.mjs', import.meta.url));
worker.once('exit', () => state.dispose());

await state.connect(worker);
state.update('stock', map => map.set('pens', 8));`;
  const reader = `import { parentPort } from 'node:worker_threads';
import { connectSharedSession } from 'zerocopy/worker';

const state = await connectSharedSession({
  endpoint: parentPort,
});
const before = state.current.stock;

state.subscribe(({ stock }) => {
  console.log(before.get('pens'), stock.get('pens'));
  state.dispose();
});`;
  return `<main id="main">
    <section class="product-hero wrap" id="how-it-works" aria-labelledby="product-title">
      <div class="product-intro">
        <h1 id="product-title"><span class="sr-only">Immutable collections for Node.js workers, Web Workers in the browser, and Bun workers.</span><span aria-hidden="true">Immutable<br>collections for<br><span class="runtime-slot"><span class="runtime-phrase"><span class="runtime-word">Node.js</span> workers.</span></span></span></h1>
        <p>A JavaScript and TypeScript library for sharing maps, lists, and sets across workers. With shared memory, workers read snapshots without copying the whole collection.</p>
        <div class="product-actions">
          <a class="quickstart" href="${base}docs/getting-started/">Quickstart <span aria-hidden="true">→</span></a>
          <div class="install-command"><code>npm i zerocopy</code><button type="button" class="copy-install" aria-label="Copy npm install command" hidden><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 7V4h11v13h-3"/><rect x="4" y="8" width="11" height="13" rx="1.5"/></svg></button></div>
          <button class="runtime-control" type="button" aria-label="Pause rotating runtime name" title="Pause rotating runtime name" hidden><svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16"><path class="pause-icon" d="M5 3v10m6-10v10" fill="none" stroke="currentColor" stroke-width="2"/><path class="play-icon" d="m5 3 8 5-8 5z" fill="currentColor" hidden/></svg></button>
        </div>
      </div>
      <figure class="worker-example" aria-label="Runnable Node.js worker example">
        <div class="example-mat">
          <div class="code-demo">
            <div class="code-tabs" role="tablist" aria-label="Node.js example files" hidden>
              <button role="tab" aria-selected="true" id="tab-reader" aria-controls="panel-reader" data-code-tab="reader">worker.mjs</button>
              <button role="tab" aria-selected="false" id="tab-owner" aria-controls="panel-owner" tabindex="-1" data-code-tab="owner">main.mjs</button>
            </div>
            <div id="panel-reader">${codeBlock(reader, 'worker.mjs', 'js')}</div>
            <div id="panel-owner">${codeBlock(main, 'main.mjs', 'js')}</div>
          </div>
        </div>
        <figcaption><span>Save both files, then run <code>node main.mjs</code>.</span><span class="example-result"><samp>12 8</samp> Original and updated counts</span></figcaption>
      </figure>
    </section>
    <section class="wrap storage-example" id="worker-architecture">
      <div><h2>One writer.<br>Many readers.</h2>
        <p>A writer publishes immutable snapshots. Readers can keep an earlier version while updates arrive. Use the storage model to see what each worker holds when sharing or cloning.</p>
        <p>Node.js supports shared storage. Browsers require cross-origin isolation. Bun copies snapshots by default.</p>
        <a class="model-link" href="${base}docs/mental-model/">How sharing works ${arrow}</a>
      </div>
      <div class="sharing-card" aria-label="Shared and cloned storage"><div class="diagram-toolbar"><span class="diagram-title">Storage model</span><div class="segmented" role="group" aria-label="Storage model"><button data-storage="shared" aria-pressed="true">Shared</button><button data-storage="cloned" aria-pressed="false">Cloned</button></div></div><div class="diagram"><div class="owner-node"><span class="node-icon">W</span><span>Writer<small>Main thread or worker</small></span></div><div class="wire wire-top"></div><div class="arena"><div class="arena-header"><span>Dataset</span><span id="arena-label">Shared backing storage</span></div><div class="memory-grid" aria-hidden="true">${Array.from({ length: 32 }, () => `<i></i>`).join('')}</div><div class="arena-footer"><span class="mono">Map · List · Set</span></div></div><div class="wire wire-bottom"></div><div class="reader-nodes" id="reader-nodes"></div></div><div class="diagram-controls"><label for="worker-count">Readers <output id="worker-count-value">3</output></label><input id="worker-count" type="range" min="1" max="4" value="3"><span id="storage-count" role="status">1 backing store</span></div></div>
    </section>
    <section class="wrap product-links" aria-label="Try the library">
      <article><h2><a href="${base}compare/">Try the product catalog</a></h2><p>Look up records with real workers, publish an update, and read the earlier revision.</p><span class="destination-arrow" aria-hidden="true">${arrow}</span></article>
      <article><h2><a href="${base}investigation-benchmark/">Run benchmarks</a></h2><p>Measure reads and updates on your device and inspect the recorded memory results.</p><span class="destination-arrow" aria-hidden="true">${arrow}</span></article>
    </section>
    ${cityDemo(base)}
  </main>`;
}

export function useCaseCards(base) {
  const cards = [
    ['catalog', 'Product catalogs', 'Look up a product by ID', 'Look up products and validate prices and stock in workers. Replace objects while retaining an earlier revision.', '<path d="M10 70h180M10 40h180M30 80V55m20 25V40m20 40V48m20 32V25m20 55V10m20 70V20m20 60V45m20 35V58"/>'],
    ['editors', 'Creative tools', 'Validate while editing', 'Run validation, layout, or export against an earlier document snapshot while the UI accepts new edits.', '<rect x="20" y="10" width="100" height="80" rx="5"/><path d="M40 30h55M40 44h30M40 58h60M40 72h40"/><rect x="110" y="38" width="70" height="54" rx="4"/>'],
    ['data-tables', 'Data exploration', 'Read a table several ways', 'Filter, group, and chart the same rows in independent workers. Keep the UI focused on visible results.', '<rect x="15" y="10" width="170" height="80" rx="4"/><path d="M15 30h170M15 50h170M15 70h170M55 10v80M115 10v80"/>'],
    ['analytics', 'Retail analytics', 'Build facets and filters', 'Build facets, filters, and availability views over the same changing catalog.', '<rect x="15" y="15" width="46" height="70" rx="5"/><rect x="77" y="15" width="46" height="70" rx="5"/><rect x="139" y="15" width="46" height="70" rx="5"/><path d="M25 64h26M87 64h26M149 64h26"/>'],
    ['graphs', 'Developer tools', 'Traverse a stable graph', 'Share nodes and edges with dependency analysis, layout, and diagnostics workers while the graph changes.', '<path d="M40 50 100 20 165 50 100 85zM40 50h125M100 20v65"/><circle cx="40" cy="50" r="10"/><circle cx="100" cy="20" r="10"/><circle cx="165" cy="50" r="10"/><circle cx="100" cy="85" r="10"/>'],
    ['simulations', 'Simulations', 'Inspect a changing world', 'Let analysis and visualization read published world snapshots. Keep one writer per arena.', '<path d="M10 85h180M20 85V60h25v25M65 85V40h25v45M110 85V20h25v65M155 85V50h25v35"/>'],
  ];
  return `<div class="use-case-grid">${cards.map(([slug, label, title, text, art]) => `<a class="use-case-card" href="${base}docs/${slug}/"><div class="case-art ${slug}"><svg viewBox="0 0 200 100" aria-hidden="true">${art}</svg></div><div class="case-copy"><span class="eyebrow">${label}</span><h3>${title}${arrow}</h3><p>${text}</p></div></a>`).join('')}</div>`;
}

export function docsLayout(page, html, toc, pages, base, sha) {
  const groups = [...new Set(pages.map(p => p.group))];
  const guideGroups = groups.map(group => `<div class="sidebar-group"><h2>${escape(group)}</h2><ul>${pages.filter(p => p.group === group).map(p => `<li><a href="${base}docs/${p.slug}/"${p.slug === page.slug ? ' aria-current="page"' : ''}>${escape(p.title)}</a></li>`).join('')}</ul></div>`).join('');
  const contents = `<nav aria-label="On this page"><ol>${toc.map(item => `<li class="toc-level-${item.depth}"><a href="#${escape(item.id)}">${escape(item.text)}</a></li>`).join('')}</ol></nav>`;
  const related = pages.filter(p => p.group === page.group);
  const index = related.findIndex(p => p.slug === page.slug);
  const adjacent = [[related[index - 1], 'prev', 'Previous'], [related[index + 1], 'next', 'Next']]
    .filter(([guide]) => guide).map(([guide, rel, label]) => `<a class="doc-${rel}" rel="${rel}" href="${base}docs/${guide.slug}/"><span>${label} in ${escape(page.group)}</span><strong>${escape(guide.title)}</strong></a>`).join('');
  return `<div class="docs-layout"><aside class="docs-sidebar"><p class="eyebrow">DOCUMENTATION</p><nav aria-label="Documentation">${guideGroups}</nav><a class="sidebar-lab" href="${base}investigation-benchmark/">↗ Catalog benchmark</a></aside>
  <main class="doc-main" id="main"><details class="mobile-docs-menu"><summary>Browse documentation</summary><nav aria-label="All documentation">${guideGroups}</nav></details><div class="doc-breadcrumb">${escape(page.group)} <span>/</span> ${escape(page.title)}</div><h1>${escape(page.title)}</h1><p class="doc-description">${escape(page.description)}</p><div class="doc-meta"><span>Source documentation</span><a href="${repository}/blob/${sha}/${page.source}">View source ↗</a><button class="copy-page" data-markdown="${base}markdown/${page.slug}.md">Copy Markdown</button></div>
  ${toc.length ? `<details class="mobile-page-menu"><summary>On this page</summary>${contents}</details>` : ''}<article class="prose">${html}</article>${adjacent ? `<nav class="doc-pagination" aria-label="More in ${escape(page.group)}">${adjacent}</nav>` : ''}<div class="doc-bottom"><span>Found something unclear?</span><a href="${repository}/issues/new">Improve this guide ↗</a></div></main>
  <aside class="doc-toc">${toc.length ? `<p class="eyebrow">ON THIS PAGE</p>${contents}` : ''}<a class="toc-help" href="${base}playground/">Try a real snapshot →</a></aside></div>`;
}

export function isolationNotice() {
  return `<div class="capability-notice" id="capability" role="status"><span class="status-dot"></span><span id="capability-text">Preparing this demo…</span><button id="enable-isolation" hidden type="button">Retry setup</button></div><p class="capability-help" id="capability-help" hidden>Setup normally runs automatically. This host may need one page refresh to enable shared memory. If your browser blocks service workers or isolation, open this page in a full browser or use a host with COOP/COEP headers. Documentation stays available; there is no copy-mode fallback.</p>`;
}

export function lab(base) {
  return `<main id="main" class="lab-page wrap"><div class="page-intro"><div class="eyebrow">SCALAR-NUMBER MAP TRANSPORT CONTROL</div><h1>Evidence.<br><span>Not promises.</span></h1><p>Compare zerocopy shared snapshots with Immutable.js Map and Immer Map using full copies across workers. In your browser, with every result checked.</p></div>${isolationNotice()}<p class="lab-small"><strong>Full copy on every publication.</strong> Immutable.js Map and Immer Map copy the entire dataset to every reader in every trial. SharedMap publishes shared descriptors. This scalar-number control measures repeated publication and reads; use the catalog benchmark for incremental-copy and full-copy edits.</p><p><a class="text-link" href="${base}investigation-benchmark/">Compare incremental and full-copy product updates →</a></p><div class="lab-workspace"><form id="benchmark-form" class="lab-controls"><div class="panel-heading"><span class="small-index">01</span><h2>Set your workload</h2></div><label for="entries">Dataset size</label><select id="entries"><option value="1000">1,000 entries</option><option value="10000" selected>10,000 entries</option><option value="50000">50,000 entries</option></select><label for="readers">Dedicated workers</label><select id="readers"><option value="1">1 worker</option><option value="2" selected>2 workers</option><option value="4">4 workers</option></select><div class="workload-spec"><span>Shape</span><strong>String keys → numbers</strong><span>Samples</span><strong>7 per path + 2 warm-ups</strong><span>Operation</span><strong>Publish, attach, read all</strong></div><button class="button primary" id="run-benchmark" disabled>Run benchmark <span aria-hidden="true">→</span></button><button class="button secondary" id="cancel-benchmark" type="button" hidden>Stop run</button><p class="muted">This uses CPU and memory. Run it in a foreground tab. All data is generated locally.</p></form><section class="lab-results" aria-labelledby="results-heading"><div class="panel-heading"><span class="small-index">02</span><h2 id="results-heading">Read the results</h2><span class="live-label">LIVE / LOCAL</span></div><div id="benchmark-status" role="status" aria-live="polite">Ready for a real result.</div><progress id="benchmark-progress" max="27" value="0" aria-label="Benchmark progress" hidden></progress><div class="result-chart" id="benchmark-chart"><div class="result-row"><div><span>zerocopy · shared snapshot</span><strong>— <small>ms</small></strong></div><div class="result-track"></div></div><div class="result-row"><div><span>Immutable.js Map · full copy</span><strong>— <small>ms</small></strong></div><div class="result-track"></div></div><div class="result-row"><div><span>Immer Map · full copy</span><strong>— <small>ms</small></strong></div><div class="result-track"></div></div><p class="empty-result">No stored scores. Press Run to measure.</p></div><div id="benchmark-summary" class="result-summary" hidden></div><div id="benchmark-detail"></div><div class="result-actions"><button id="export-results" class="button secondary" disabled>Download raw JSON ↓</button><a href="#method">Read the method →</a></div></section></div>
  <section class="section method-section" id="method"><div><div class="eyebrow">THE SMALL PRINT IS THE POINT</div><h2>What this actually measures.</h2><p class="section-lead">End-to-end fan-out and reads. Not a pure transfer benchmark. Not a memory benchmark.</p></div><div class="method-grid"><div><h3>Included</h3><p>Snapshot encoding, sending to all readers, reconstruction or shared attachment, a lookup for every key, and the response. zerocopy reattaches read-only shared views. Immutable.js encodes all entries, structured-clones them, and rebuilds a Map in each reader. Immer structured-clones its Map and freezes each replica.</p></div><div><h3>Excluded</h3><p>Worker startup and library loading happen before warm-up. Dataset construction happens once, with its own reported timing. It is not included in the comparison bars.</p></div><div><h3>Same job. Checked answers.</h3><p>All three paths use the same deterministic string keys and numeric values. Each reader reports a checksum. A mismatch fails the run. Measurement order rotates, and the median and interquartile range use all seven samples.</p></div><div><h3>No universal winner</h3><p>Any path can win. Immer uses produce with Map support and default auto-freezing. All snapshots are built once; every trial publishes a full snapshot. Warm-up does not remove attachment, cloning, reconstruction, or freezing costs. This test does not measure persistent edit history, every value type, or your application's workload.</p></div></div><div class="method-links"><a href="${base}docs/benchmarks/">All recorded collection benchmarks →</a><a href="${repository}/blob/main/website/assets/bench-runner.mjs">Inspect the benchmark source ↗</a></div></section></main>`;
}

export function playground(base) {
  return `<main id="main" class="wrap playground-page"><div class="page-intro"><div class="eyebrow">A REAL SHARED-MEMORY PLAYGROUND</div><h1>New edits.<br><span>Unchanged history.</span></h1><p>Start a real dedicated worker. Headphones start with 12 units in stock. Mark them as sold out, then compare the live catalog with the worker's retained snapshot.</p></div>${isolationNotice()}<div class="playground-controls"><button class="button primary" id="start-playground" disabled>Connect a worker →</button><label for="stock">Headphones in stock <input id="stock" type="number" min="0" max="200" step="1" value="0" disabled><span>units</span></label><button class="button secondary" id="apply-edit" disabled>Apply edit ↗</button><button class="text-button" id="stop-playground" disabled>Disconnect</button></div><div class="snapshot-live-grid"><div class="snapshot-live owner"><span class="eyebrow">MAIN THREAD / OWNER</span><h2>Current state</h2><div class="stock-value" id="owner-value">—<span>units</span></div><p class="stock-status" id="owner-availability" aria-live="polite">Not loaded</p><code>state.current.stock.get('headphones')</code><p>Updates synchronously.</p></div><div class="snapshot-live reader"><span class="eyebrow">WORKER / RECEIVED</span><h2>Latest snapshot</h2><div class="stock-value" id="reader-value">—<span>units</span></div><p class="stock-status" id="reader-availability" aria-live="polite">Not loaded</p><code>shared.current.stock.get('headphones')</code><p>Receives new roots asynchronously.</p></div><div class="snapshot-live retained"><span class="eyebrow">WORKER / RETAINED</span><h2>First snapshot</h2><div class="stock-value" id="retained-value">—<span>units</span></div><p class="stock-status" id="retained-availability" aria-live="polite">Not loaded</p><code>initial.stock.get('headphones')</code><p>Stays unchanged after later edits.</p></div></div><div class="playground-bottom"><div class="event-log"><div class="code-label"><span>LIVE EVENT LOG</span><span>Actual worker messages</span></div><ol id="snapshot-log" role="log" aria-live="polite"><li>Ready. No worker is running yet.</li></ol></div><div class="playground-explainer"><h2>What to notice</h2><p>The owner changes first. The worker sees the new value after a snapshot arrives. Its first snapshot still shows <strong>12 units in stock</strong>, even when the current value is zero.</p><p>Each collection read happens locally, outside any task. The worker sends small reports only so this page can display the results.</p><a class="text-link" href="${base}docs/getting-started/">Build this into your app →</a></div></div><p class="lab-small">This uses the real source build shipped with this site. Disconnect releases the session and terminates this worker. Browser page navigation also ends the demo. This is a local catalog view, not stock reservation; checkout still needs server validation.</p></main>`;
}
