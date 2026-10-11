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
  for (const [route, entry, worker] of [['lab', 'lab.mjs', 'bench-runner.mjs'], ['playground', 'playground.mjs', 'snapshot-worker.mjs'], ['explorer', 'explorer.mjs', 'explorer-owner.mjs'], ['investigation-benchmark', 'explorer-benchmark.mjs', 'explorer-bench-runner.mjs']]) {
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


test('public examples avoid HD map defaults while the catalog remains a separate tutorial', () => {
  for (const file of files(out).filter(file => /\.(html|md)$/.test(file))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /speed[ -]?limit|km\/h|lane-1|limits\.worker/i, file);
  }
  const home = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(home, /log explorer/i);
  assert.doesNotMatch(home, /headphones/);
  const playground = readFileSync(join(out, 'playground/index.html'), 'utf8');
  assert.match(playground, /Headphones in stock/);
  assert.match(playground, /id="stock"[^>]*step="1"[^>]*value="0"/);
});


test('the product has broad use cases and the log explorer is only one example', () => {
  const home = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(home, /One dataset/);
  for (const slug of ['log-explorer', 'editors', 'data-tables', 'analytics', 'graphs', 'simulations']) {
    assert.ok(home.includes(`docs/${slug}/`), slug);
  }
  const cases = readFileSync(join(out, 'docs/use-cases/index.html'), 'utf8');
  assert.match(cases, /not a log engine/);
  assert.match(cases, /simpler alternative/);
  assert.match(cases, /Persistence/);
  const explorer = readFileSync(join(out, 'explorer/index.html'), 'utf8');
  assert.match(explorer, /ONE EXAMPLE. MANY APPLICATIONS./);
  assert.match(explorer, /100,000/);
  assert.match(explorer, /Freeze investigation/);
  assert.match(explorer, /No upload/);
});

test('investigation benchmark compares incremental replicas rather than a full-copy straw man', () => {
  const html = readFileSync(join(out, 'investigation-benchmark/index.html'), 'utf8');
  assert.match(html, /only the delta/);
  assert.match(html, /One data owner/);
  assert.match(html, /No stored scores/);
  assert.match(html, /independent native-array reference/);
});
