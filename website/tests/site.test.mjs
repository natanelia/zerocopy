import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { basePath } from '../config.mjs';
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
  assert.deepEqual(orderFor(0), ['shared', 'native']); assert.deepEqual(orderFor(1), ['native', 'shared']);
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
  assert.equal(index.length, 15);
  for (const page of index) { assert.ok(existsSync(join(out, page.route, 'index.html'))); assert.ok(page.text.length > 100); }
  assert.ok(readFileSync(join(out, 'docs/collections/index.html'), 'utf8').includes('SharedMap'));
});
test('the first screen sells direct reads, not mandatory tasks or invented results', () => {
  const home = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(home.includes('Share your data.')); assert.ok(home.includes('Tasks optional.'));
  assert.ok(home.includes('Conceptual storage model. Not a memory measurement.'));
  const lab = readFileSync(join(out, 'lab/index.html'), 'utf8');
  assert.ok(lab.includes('No stored scores.')); assert.ok(lab.includes('Not a memory benchmark.'));
  assert.ok(!home.includes('<script src="https://'));
});
