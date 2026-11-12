// Run the existing website's owner/readers unchanged against two built libraries.
// Usage: node browser.mjs BASELINE_REPO CANDIDATE_REPO OUTPUT.json [pairs=7]
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { chromium } from 'playwright';

const [baseArg, candidateArg, outputArg, pairsArg = '7'] = process.argv.slice(2);
if (!baseArg || !candidateArg || !outputArg) throw new Error('Expected BASELINE_REPO CANDIDATE_REPO OUTPUT.json [pairs]');
const output = resolve(outputArg);
if (existsSync(output)) throw new Error(`Refusing to overwrite existing evidence: ${output}`);
const roots = { before: resolve(baseArg), after: resolve(candidateArg) }, pairs = Number(pairsArg);
if (!Number.isSafeInteger(pairs) || pairs < 1) throw new Error('pairs must be positive');
const counts = (process.env.COUNTS ?? '1000,10000,100000').split(',').map(Number);
assert.ok(counts.length && new Set(counts).size === counts.length && counts.every(n => [1000, 10000, 100000].includes(n)), 'Unsupported or duplicate COUNTS');
const warmups = 2, raw = [];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function identity(root) {
  const sources = ['arena.ts', 'freeze-json.ts', 'utf8.ts', 'shared-map.ts', 'shared-list.ts', 'shared.ts', 'shared-runtime.as.ts'];
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sources: Object.fromEntries(sources.map(file => [file, sha256(readFileSync(join(root, file)))])),
    build: Object.fromEntries(readdirSync(join(root, 'dist')).filter(file => file.endsWith('.js')).sort().map(file => [file, sha256(readFileSync(join(root, 'dist', file)))])) };
}
const identities = Object.fromEntries(Object.entries(roots).map(([arm, root]) => [arm, identity(root)]));
const fixtureIdentity = () => ({ harness: sha256(readFileSync(new URL(import.meta.url))),
  assets: Object.fromEntries(readdirSync(join(roots.after, 'website/assets')).filter(file => file.endsWith('.mjs')).sort()
    .map(file => [file, sha256(readFileSync(join(roots.after, 'website/assets', file)))])),
  vendors: Object.fromEntries(['immutable/dist/immutable.es.js', 'immer/dist/immer.production.mjs'].map(file =>
    [file, sha256(readFileSync(join(roots.before, 'node_modules', file)))])) });
const fixtures = fixtureIdentity();
const data = { schema: 'zerocopy-reader-startup-browser/v1', startedAt: new Date().toISOString(),
  method: 'Existing website owner/readers, unchanged timing boundaries and correctness checks; fresh owner plus two fresh readers every sample; alternate A/B order and rotate competitor groups, retain warmups and all measured pairs. readyMs is the per-sample sum of construction, publication and first-query timings, excluding worker/module startup, dataset generation, harness messages and verification gaps.',
  roots, identities, fixtures, config: { counts, pairs, warmups, readers: 2, requestedIds: 1000, competitors: process.env.COMPETITORS === '1' }, raw };
mkdirSync(dirname(output), { recursive: true });
const save = () => { writeFileSync(output + '.tmp', JSON.stringify(data, null, 2) + '\n'); renameSync(output + '.tmp', output); };
save();
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Reader startup measurements</title>'); return; }
  const [, arm, area, ...parts] = pathname.split('/'), root = roots[arm], file = parts.join('/');
  if (!root || !file || parts.some(part => part === '..')) { response.writeHead(404).end(); return; }
  let path;
  if (area === 'assets') path = join(roots.after, 'website/assets', file);
  else if (area === 'library') path = join(root, 'dist', file);
  else if (area === 'vendor' && file === 'immutable.mjs') path = join(root, 'node_modules/immutable/dist/immutable.es.js');
  else if (area === 'vendor' && file === 'immer.mjs') path = join(root, 'node_modules/immer/dist/immer.production.mjs');
  try { if (!path) throw new Error('Unknown path'); response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(path)); }
  catch { response.writeHead(404).end(); }
});
let browser;
const phases = ['constructionMs', 'publicationMs', 'firstQueryMs', 'repeatQueryMs', 'updateMs', 'editPublicationMs', 'updatedQueryMs', 'readyMs'];
const median = values => { const sorted = [...values].sort((a, b) => a - b); const middle = sorted.length >> 1; return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const environment = await page.evaluate(() => ({ userAgent: navigator.userAgent, crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency }));
  if (!environment.crossOriginIsolated) throw new Error('Shared-memory isolation is required');
  data.environment = { ...environment, browser: browser.version(), cpu: cpus()[0]?.model }; save();
  async function sample(arm, kind, count, pair, warmup) {
    const result = await page.evaluate(async ({ arm, kind, count }) => {
      const { Peer } = await import(`/${arm}/assets/catalog-peer.mjs`);
      const owner = new Peer(new URL(`/${arm}/assets/feature-owner.mjs`, location.href));
      try {
        await owner.request('prepare', { kind, readers: 2, updateMode: 'incremental' });
        const setup = await owner.request('load', { count });
        const first = await owner.request('query'), repeat = await owner.request('query');
        const edit = await owner.request('edit'), updated = await owner.request('query');
        const retained = await owner.request('query', { frozen: true });
        await owner.request('stop');
        return { constructionMs: setup.constructionMs, publicationMs: setup.publicationMs,
          firstQueryMs: first.ms, repeatQueryMs: repeat.ms, updateMs: edit.updateMs,
          editPublicationMs: edit.publicationMs, updatedQueryMs: updated.ms,
          readyMs: setup.constructionMs + setup.publicationMs + first.ms,
          verification: [first, repeat, updated, retained].map(value => ({ revision: value.revision,
            verifiedReplies: value.verifiedReplies, lookup: value.answer.lookup.fingerprint,
            validation: value.answer.validation.fingerprint, found: value.answer.lookup.found,
            missing: value.answer.lookup.missing })) };
      } finally { owner.close(); }
    }, { arm, kind, count });
    assert.ok(phases.every(phase => Number.isFinite(result[phase]) && result[phase] >= 0));
    raw.push({ arm, kind, count, pair, warmup, ...result }); save();
    process.stderr.write(`${warmup ? 'warmup' : 'pair'} ${pair} ${count} ${arm}/${kind}: build=${result.constructionMs.toFixed(2)} first=${result.firstQueryMs.toFixed(2)} ready=${result.readyMs.toFixed(2)} ms\n`);
  }
  for (const count of counts) for (let pair = 0; pair < warmups + pairs; pair++) {
    const arms = pair % 2 ? ['after', 'before'] : ['before', 'after'];
    const groups = [arms.map(arm => ({ arm, kind: 'shared' })), ...(data.config.competitors && count === 10000
      ? ['native', 'immutable', 'immer'].map(kind => [{ arm: 'before', kind }]) : [])];
    for (let offset = 0; offset < groups.length; offset++) for (const { arm, kind } of groups[(offset + pair) % groups.length])
      await sample(arm, kind, count, pair, pair < warmups);
  }
  for (const arm of Object.keys(roots)) assert.deepEqual(identity(roots[arm]), identities[arm], `${arm} source or build changed`);
  assert.deepEqual(fixtureIdentity(), fixtures, 'Harness or fixtures changed');
  const summary = counts.map(count => ({ count, phases: Object.fromEntries(phases.map(phase => {
    const rows = raw.filter(row => !row.warmup && row.count === count && row.kind === 'shared');
    const before = rows.filter(row => row.arm === 'before'), after = rows.filter(row => row.arm === 'after');
    const ratios = before.map(row => after.find(value => value.pair === row.pair)[phase] / row[phase]);
    return [phase, { beforeMs: median(before.map(row => row[phase])), afterMs: median(after.map(row => row[phase])),
      pairedMedianRatio: median(ratios), fasterPairs: ratios.filter(ratio => ratio < 1).length, pairs: ratios.length, ratios }];
  })) }));
  data.completedAt = new Date().toISOString(); data.summary = summary; save();
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  data.failedAt = new Date().toISOString(); data.failure = error.stack ?? String(error); save(); throw error;
} finally {
  await browser?.close(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
}
