import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { regressionHTML } from './regression-preview.mjs';
import { basePath, pages, evidencePages, benchmarkRedirects } from '../config.mjs';
import { highlight, renderMarkdown } from '../render.mjs';
import { expectedChecksum, orderFor, summarize, validateConfig, verifyChecksums } from '../assets/bench-core.mjs';
const out = fileURLToPath(new URL('../_site/', import.meta.url));
const meta = JSON.parse(readFileSync(join(out, 'build.json')));
function files(directory) { return readdirSync(directory).flatMap(name => { const path = join(directory, name); return statSync(path).isDirectory() ? files(path) : [path]; }); }

test('validates bounded benchmark inputs', () => {
  assert.deepEqual(validateConfig({ entries: 10000, readers: 4 }), { entries: 10000, readers: 4, samples: 7, warmups: 2 });
  for (const config of [null, {}, { entries: 1e9, readers: 4 }, { entries: 1000, readers: 99 }, { entries: '1000', readers: 1 }]) assert.throws(() => validateConfig(config));
});
test('summarizes every sample without mutating inputs', () => {
  const samples = [7, 2, 4, 3, 5, 1, 6];
  assert.deepEqual(summarize(samples), { median: 4, p25: 2.5, p75: 5.5, min: 1, max: 7 });
  assert.equal(samples[0], 7); assert.throws(() => summarize([])); assert.throws(() => summarize([NaN]));
  assert.deepEqual(orderFor(0), ['shared', 'immutable', 'immer']);
  assert.deepEqual(orderFor(1), ['immutable', 'immer', 'shared']);
  assert.deepEqual(orderFor(2), ['immer', 'shared', 'immutable']);
  assert.deepEqual(orderFor(3), orderFor(0));
});
test('checks each reader rather than only a combined checksum', () => {
  assert.equal(expectedChecksum(1000), 499500);
  verifyChecksums([{ checksum: 499500 }, { checksum: 499500 }], 2, 1000);
  assert.throws(() => verifyChecksums([{ checksum: 499499 }, { checksum: 499501 }], 2, 1000));
  assert.throws(() => verifyChecksums([], 1, 1000));
});
test('rejects unsafe deployment prefixes', () => {
  for (const base of ['/', '/zerocopy/', '/nested/site/']) assert.equal(basePath(base), base);
  for (const base of ['//bad/', '/a/../', '/a?b/', 'https://x/', '/a']) assert.throws(() => basePath(base));
});
test('code is escaped before syntax highlighting', () => {
  const html = highlight('const s = "<script>alert(1)</script>";');
  assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(renderMarkdown('## Same\n\n## Same', 'docs/test.md', new Map(), '/').html.includes('id="same-1"'));
});
test('all static pages have metadata, one main heading, and functioning internal links', () => {
  const failures = [];
  for (const file of files(out).filter(file => file.endsWith('.html'))) {
    const html = readFileSync(file, 'utf8');
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1, file);
    assert.match(html, /<meta name="description"/); assert.match(html, /<main[^>]*id="main"/);
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const link = match[1].replaceAll('&amp;', '&');
      if (/^(https?:|mailto:|data:)/.test(link)) continue;
      let path, fragment;
      if (link.startsWith('#')) { path = file; fragment = link.slice(1); }
      else {
        if (!link.startsWith(meta.base)) { failures.push(`${file}: wrong base in ${link}`); continue; }
        const [name, hash] = link.slice(meta.base.length).split('#'); path = resolve(out, name); fragment = hash;
        if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
      }
      if (!existsSync(path)) { failures.push(`${file}: missing ${link}`); continue; }
      if (fragment && path.endsWith('.html')) {
        const destination = readFileSync(path, 'utf8');
        if (!destination.includes(`id="${fragment}"`) && !destination.includes(`name="${fragment}"`)) failures.push(`${file}: missing fragment ${link}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});
test('docs are prerendered and search points to generated pages', () => {
  const index = JSON.parse(readFileSync(join(out, 'search.json'), 'utf8'));
  assert.equal(index.filter(entry => !entry.heading).length, pages.length);
  assert.ok(index.length > pages.length);
  for (const page of index) {
    const [route, fragment] = page.route.split('#');
    const file = join(out, route, 'index.html');
    assert.ok(existsSync(file));
    if (fragment) assert.ok(readFileSync(file, 'utf8').includes(`id="${fragment}"`));
    assert.equal(typeof page.text, 'string');
  }
  assert.ok(readFileSync(join(out, 'docs/collections/index.html'), 'utf8').includes('SharedMap'));
});
test('the product story separates its conceptual model, real playground, and measurements', () => {
  const home = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(home.includes('Share your data.')); assert.ok(home.includes('Tasks optional.'));
  assert.ok(home.includes('Interactive explanation. Not a measured benchmark.'));
  for (const text of ['Main thread or worker', 'One allocating writer per arena', 'synchronous local read', 'deliver new snapshots asynchronously', 'zero allocations', 'cross-origin isolation', 'Explicit compaction']) assert.ok(home.includes(text), text);
  assert.ok(home.includes('id="how-it-works"'));
  assert.ok(home.includes('id="publish-concept"'));
  assert.ok(home.includes('id="arena-revision"'));
  for (const route of ['playground/', 'benchmarks/', 'docs/getting-started/', 'docs/choose-zerocopy/']) assert.ok(home.includes(`href="${meta.base}${route}"`), route);
  assert.ok(home.includes('benchmarks/'));
  assert.doesNotMatch(home, /Choose a benchmark|Compare the full product catalog/);
  assert.doesNotMatch(home, /(?:src|href)="[^\"]*\/library\//);
  const lab = regressionHTML('lab/');
  assert.ok(lab.includes('No stored scores.')); assert.ok(lab.includes('Not a memory benchmark.'));
  assert.match(lab, /Immutable\.js Map/); assert.match(lab, /Immer Map/);
  assert.doesNotMatch(lab, /Structured-cloned Map|Native Map can win/);
  for (const file of ['immutable.mjs', 'immer.mjs', 'immutable-LICENSE.txt', 'immer-LICENSE.txt']) assert.ok(existsSync(join(out, 'vendor', file)), file);
  assert.equal(meta.dependencies.immer, JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).devDependencies.immer);
  assert.ok(!home.includes('<script src="https://'));
});

test('demo workers and all runtime modules stay inside the automatic isolation scope', () => {
  for (const [route, entry, worker] of [['playground', 'playground.mjs', 'snapshot-worker.mjs'], ['benchmarks', 'feature-benchmark.mjs', 'feature-owner.mjs']]) {
    const html = readFileSync(join(out, route, 'index.html'), 'utf8');
    assert.ok(html.includes(`src="${meta.base}${route}/assets/${entry}"`));
    assert.ok(html.includes(`src="${meta.base}${route}/assets/main.mjs"`));
    assert.ok(!html.includes(`src="${meta.base}assets/main.mjs"`));
    assert.ok(existsSync(join(out, route, 'assets', worker)));
    assert.ok(existsSync(join(out, route, 'isolation-sw.js')));
    assert.ok(existsSync(join(out, route, 'assets/isolation.mjs')));
    assert.ok(existsSync(join(out, route, 'assets/search.mjs')));
    assert.ok(!html.includes('Enable shared memory &amp; reload'));
    assert.ok(!html.includes('Enable shared memory & reload'));
    assert.equal(readFileSync(join(out, route, 'library/shared.js'), 'utf8'), readFileSync(join(out, 'library/shared.js'), 'utf8'));
  }
});


test('product catalog and small snapshot tutorial have clear scopes', () => {
  const home = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(home, /Edit a product/); assert.doesNotMatch(home, /headphones/);
  assert.doesNotMatch(home, /100,000 generated events|immutable columns|LOG EXPLORER/);
  const guide = readFileSync(join(out, 'docs/catalog/index.html'), 'utf8');
  assert.match(guide, /prices, stock and availability/);
  const playground = readFileSync(join(out, 'playground/index.html'), 'utf8');
  assert.match(playground, /Headphones in stock/);
});

test('retained comparison fixtures keep their workload boundaries', () => {
  const home = readFileSync(join(out, 'index.html'), 'utf8');
  for (const slug of ['catalog', 'editors', 'data-tables', 'analytics', 'graphs', 'simulations']) assert.ok(home.includes(`docs/${slug}/`));
  for (const route of ['compare']) {
    const html = regressionHTML(route + '/');
    assert.match(html, /Replace 100 products/); assert.match(html, /Initial · retained/);
    assert.doesNotMatch(html, /Freeze investigation|live events|Five immutable columns/);
  }
  for (const route of ['historical/log-explorer', 'historical/log-compare', 'historical/log-benchmark']) {
    const html = regressionHTML(route + '/');
    assert.match(html, /Historical SharedList log workload/);
    assert.ok(!existsSync(join(out, route, 'isolation-sw.js')));
    assert.ok(!existsSync(join(out, route, 'library/shared.js')));
  }
});

test('retained benchmark fixtures preserve copy strategies and the original layout', () => {
  const catalog = regressionHTML('investigation-benchmark/');
  for (const text of ['Incremental-copy replicas publish only changed pairs', 'full-copy replicas publish the entire updated catalog', 'Publish the edited revision', 'Replace and publish 100 products', 'immediately below SharedMap', 'fresh owner and reader workers', 'first query', 'repeat query', 'revision 0', 'independent reference']) assert.ok(catalog.includes(text), text);
  assert.match(catalog, /<h1>One product catalog\.<br>Four implementations\.<\/h1>/);
  assert.doesNotMatch(catalog, /feature-benchmark-preview|data-preview-case|feature-preview-status/);
  assert.ok(catalog.includes('<div id="feature-benchmark-results" aria-live="polite"></div>'));
  const css = readFileSync(join(out, 'assets/feature.css'), 'utf8');
  assert.doesNotMatch(css, /feature-benchmark-preview|feature-preview-status/);
  const historical = regressionHTML('historical/log-benchmark/');
  for (const text of ['incremental copy', 'full copy', '42 measured samples', 'Queries use data already attached']) assert.ok(historical.includes(text), text);
  const live = regressionHTML('compare/');
  assert.equal((live.match(/LOCAL REPLICAS/g) ?? []).length, 3);
  assert.equal((live.match(/Edits clone only 100 changed ID\/object pairs\./g) ?? []).length, 3);
  assert.doesNotMatch(live, /Incremental copy baseline/);
  const logLive = regressionHTML('historical/log-compare/');
  assert.match(logLive, /Incremental copy is the default/);
  assert.match(logLive, /Full copy · all events every update/);
  const lab = regressionHTML('lab/');
  assert.match(lab, /Full copy on every publication/);
});

test('retired routes go directly to one benchmark page without allocating workers', () => {
  for (const { route, target } of [...benchmarkRedirects, { route: 'docs/maps/', target: 'docs/catalog/' }]) {
    const html = readFileSync(join(out, route, 'index.html'), 'utf8');
    assert.ok(html.includes(`http-equiv="refresh" content="0;url=${meta.base}${target}"`), route);
    assert.ok(html.includes(`href="${meta.base}${target}"`), route);
    assert.ok(html.includes('location.replace('), route);
    assert.match(html, /noindex,nofollow/);
    assert.doesNotMatch(html, /feature-load|feature\.mjs|feature-benchmark\.mjs|capability\.mjs/);
    assert.ok(!meta.pages.includes(route), 'Redirects do not compete in the sitemap');
  }
  for (const route of ['', 'benchmarks/', 'playground/', 'docs/catalog/']) {
    const html = readFileSync(join(out, route, 'index.html'), 'utf8');
    for (const retired of benchmarkRedirects) assert.ok(!html.includes(`href="${meta.base}${retired.route}`), `${route} links to retired ${retired.route}`);
    assert.doesNotMatch(html, /road\/|road attributes|road features|\blanes\b|geospatial|cartograph|spatial index/i);
  }
});

test('navigation, search and recorded sources all resolve to one benchmark destination', () => {
  const search = JSON.parse(readFileSync(join(out, 'search.json'), 'utf8'));
  assert.deepEqual(search.filter(entry => entry.title === 'Benchmarks').map(entry => entry.route),
    ['benchmarks/#memory', 'benchmarks/#performance', 'benchmarks/#sources']);
  for (const { route } of benchmarkRedirects) assert.ok(search.every(entry => !entry.route.startsWith(route)), route);
  for (const route of meta.pages) {
    const html = readFileSync(join(out, route, 'index.html'), 'utf8');
    for (const name of ['desktop-nav', 'mobile-nav']) {
      const nav = html.match(new RegExp(`<nav[^>]*class="${name}"[^>]*>([\\s\\S]*?)<\\/nav>`))[1];
      assert.equal((nav.match(/>Benchmarks<\/a>/g) || []).length, 1);
      assert.ok(nav.includes(`href="${meta.base}benchmarks/"`));
      assert.doesNotMatch(nav, /Live catalog comparison|Benchmark explorer/);
    }
    for (const retired of benchmarkRedirects) assert.ok(!html.includes(`href="${meta.base}${retired.route}`), `${route} links to retired ${retired.route}`);
  }
  for (const page of evidencePages) {
    assert.equal(readFileSync(join(out, 'markdown', `${page.slug}.md`), 'utf8'),
      readFileSync(new URL('../../' + page.source, import.meta.url), 'utf8'), page.source);
  }
});
