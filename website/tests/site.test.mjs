import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { basePath, pages } from '../config.mjs';
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
test('the first screen sells direct reads, not mandatory tasks or invented results', () => {
  const home = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(home.includes('Share your data.')); assert.ok(home.includes('Tasks optional.'));
  assert.ok(home.includes('Conceptual storage model. Not a memory measurement.'));
  const lab = readFileSync(join(out, 'lab/index.html'), 'utf8');
  assert.ok(lab.includes('No stored scores.')); assert.ok(lab.includes('Not a memory benchmark.'));
  assert.match(lab, /Immutable\.js Map/); assert.match(lab, /Immer Map/);
  assert.doesNotMatch(lab, /Structured-cloned Map|Native Map can win/);
  for (const file of ['immutable.mjs', 'immer.mjs', 'immutable-LICENSE.txt', 'immer-LICENSE.txt']) assert.ok(existsSync(join(out, 'lab/vendor', file)), file);
  assert.equal(meta.dependencies.immer, JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).devDependencies.immer);
  assert.ok(!home.includes('<script src="https://'));
});

test('demo workers and all runtime modules stay inside the automatic isolation scope', () => {
  for (const [route, entry, worker] of [['lab', 'lab.mjs', 'bench-runner.mjs'], ['playground', 'playground.mjs', 'snapshot-worker.mjs'], ['explorer', 'feature.mjs', 'feature-owner.mjs'], ['compare', 'feature.mjs', 'feature-owner.mjs'], ['investigation-benchmark', 'feature-benchmark.mjs', 'feature-owner.mjs'], ['historical/log-explorer', 'explorer.mjs', 'explorer-owner.mjs'], ['historical/log-benchmark', 'explorer-benchmark.mjs', 'explorer-bench-runner.mjs']]) {
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


test('feature attribute example and separate catalog tutorial have clear scopes', () => {
  const home = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(home, /feature registry/i); assert.doesNotMatch(home, /headphones/);
  assert.doesNotMatch(home, /100,000 generated events|immutable columns|LOG EXPLORER/);
  const guide = readFileSync(join(out, 'docs/maps/index.html'), 'utf8');
  assert.match(guide, /does not render a map or perform spatial search/);
  const playground = readFileSync(join(out, 'playground/index.html'), 'utf8');
  assert.match(playground, /Headphones in stock/);
});

test('primary pages use feature maps while the old log workload is clearly historical', () => {
  const home = readFileSync(join(out, 'index.html'), 'utf8');
  for (const slug of ['maps', 'editors', 'data-tables', 'analytics', 'graphs', 'simulations']) assert.ok(home.includes(`docs/${slug}/`));
  for (const route of ['explorer', 'compare']) {
    const html = readFileSync(join(out, route, 'index.html'), 'utf8');
    assert.match(html, /Replace 100 features/); assert.match(html, /Initial · retained/);
    assert.doesNotMatch(html, /Freeze investigation|live events|Five immutable columns/);
  }
  for (const route of ['historical/log-explorer', 'historical/log-compare', 'historical/log-benchmark']) {
    const html = readFileSync(join(out, route, 'index.html'), 'utf8');
    assert.match(html, /Historical SharedList log workload/);
    assert.ok(existsSync(join(out, route, 'isolation-sw.js')));
    assert.ok(existsSync(join(out, route, 'library/shared.js')));
  }
});

test('feature benchmark discloses sparse replicas, retained history and separate query phases', () => {
  const html = readFileSync(join(out, 'investigation-benchmark/index.html'), 'utf8');
  for (const text of ['only changed pairs', 'fresh owner and reader workers', 'first query', 'repeat query', 'revision 0', 'independent reference']) assert.ok(html.includes(text), text);
});
