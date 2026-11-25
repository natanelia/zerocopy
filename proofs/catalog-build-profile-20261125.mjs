import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus, release, arch } from 'node:os';
import { chromium, firefox } from 'playwright';

// Diagnostic replay of the exact owner construction on an isolated browser
// page. Actual two-worker timings are collected separately by website.mjs.
// CPU sampling and unprofiled timing are deliberately separate.
const [checkout, output, repetitions = '7'] = process.argv.slice(2);
assert(checkout && output && Number.isInteger(+repetitions) && +repetitions > 0);
const root = resolve(checkout), out = resolve(output);
mkdirSync(out, { recursive: true });
const identity = JSON.parse(readFileSync(join(root, 'website/_site/build.json'), 'utf8'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(identity.sourceCommit, commit);
assert.equal(identity.sourceDirty, false);
const report = {
  complete: false, commit, identity, node: process.version, cpu: cpus()[0]?.model,
  arch: arch(), os: release(), driverSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
  samples: [], profiles: [], engines: {},
};
const save = () => writeFileSync(join(out, 'stages.json'), JSON.stringify(report, null, 2));
const { createPreview } = await import(pathToFileURL(join(root, 'website/serve.mjs')).href);
const server = createPreview();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + server.address().port + '/investigation-benchmark/';

async function prepare(page, count) {
  await page.goto(url);
  assert(await page.evaluate(() => crossOriginIsolated));
  await page.evaluate(async count => {
    const fixture = await import('./assets/catalog-core.mjs');
    const { deepFreeze } = await import('./assets/feature-core.mjs');
    const { createStorage } = await import('./assets/feature-storage.mjs');
    const api = await import('./library/shared.js');
    const storage = await createStorage('shared');
    const { readCase, runReadQuery, verifyReadContract } = await import('./assets/catalog-read-workloads.mjs');
    const { readReference, verifyReadAnswer } = await import('./assets/catalog-read-reference.mjs');
    const entries = fixture.entriesFor(count);
    globalThis.__catalogProfile = { storage, api, deepFreeze, entries, count, fixture, readCase, runReadQuery, verifyReadContract, readReference, verifyReadAnswer };
  }, count);
}
async function build(page, split) {
  return page.evaluate(split => {
    const p = globalThis.__catalogProfile;
    let start = performance.now(), map, freezeMs, constructorMs, setManyMs;
    if (split) {
      for (const [, value] of p.entries) p.deepFreeze(value);
      freezeMs = performance.now() - start;
      const ctorStart = performance.now();
      const empty = new p.api.SharedMap('object');
      constructorMs = performance.now() - ctorStart;
      const setStart = performance.now();
      map = empty.setMany(p.entries);
      setManyMs = performance.now() - setStart;
    } else {
      map = p.storage.build(p.entries);
    }
    const buildMs = performance.now() - start;
    p.map = map;
    return { buildMs, freezeMs, constructorMs, setManyMs, size: map.size, usedBytes: map.arena.used };
  }, split);
}
async function verify(page) {
  return page.evaluate(() => {
    const p = globalThis.__catalogProfile, ids = p.fixture.queryIds(p.count), definition = p.readCase('full-shared-get');
    const start = performance.now();
    const data = p.storage.payload(p.map);
    const payloadMs = performance.now() - start;
    if (!data.arenas.length || data.arenas.some(a => a.copy || !(a.memory.buffer instanceof SharedArrayBuffer))) throw new Error('Not shared');
    const answer = p.runReadQuery(p.map, ids, definition);
    return { payloadMs, verification: p.verifyReadAnswer(answer, p.readReference(p.count, 0, ids, definition)), contract: p.verifyReadContract(answer, definition) };
  });
}
// Aggregate sampled time without dropping native/WASM/GC/idle or counting a
// recursive frame twice per sample. Raw CDP profile is the source of truth.
function summarize(profile) {
  const nodes = new Map(profile.nodes.map(n => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const child of n.children ?? []) parent.set(child, n.id);
  const self = new Map(), inclusive = new Map();
  const label = n => {
    const f = n.callFrame;
    return (f.functionName || '(anonymous)') + ' @ ' + (f.url || '(native)') + ':' + (f.lineNumber + 1);
  };
  assert.equal(profile.samples.length, profile.timeDeltas.length);
  let totalUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    let id = profile.samples[i];
    const delta = profile.timeDeltas[i];
    assert(Number.isFinite(delta) && delta >= 0 && nodes.has(id));
    totalUs += delta;
    const leaf = label(nodes.get(id));
    self.set(leaf, (self.get(leaf) ?? 0) + delta);
    const visited = new Set();
    while (nodes.has(id)) {
      const key = label(nodes.get(id));
      if (!visited.has(key)) inclusive.set(key, (inclusive.get(key) ?? 0) + delta);
      visited.add(key);
      id = parent.get(id);
    }
  }
  const top = m => [...m].sort((a,b) => b[1] - a[1]).slice(0, 40).map(([frame, us]) => ({ frame, us, fraction: us / totalUs }));
  return { totalUs, samples: profile.samples.length, self: top(self), inclusive: top(inclusive) };
}
try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox })) {
    const browser = await launcher.launch();
    try {
      report.engines[engine] = browser.version();
      for (const count of [1000, 10000, 100000]) {
        for (let pair = -2; pair < +repetitions; pair++) {
          for (const split of (pair % 2 ? [true, false] : [false, true])) {
            const page = await browser.newPage();
            try {
              await prepare(page, count);
              const stages = await build(page, split);
              assert.equal(stages.size, count);
              report.samples.push({ engine, count, pair, warmup: pair < 0, mode: split ? 'split' : 'exact', ...stages, ...await verify(page) });
              save();
            } finally { await page.close(); }
          }
        }
        if (engine !== 'chromium' || count < 10000) continue;
        for (let rep = 0; rep < 3; rep++) {
          const page = await browser.newPage();
          try {
            await prepare(page, count);
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Profiler.enable');
            await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
            await cdp.send('Profiler.start');
            const stages = await build(page, false);
            const { profile } = await cdp.send('Profiler.stop');
            await cdp.detach();
            assert.equal(stages.size, count);
            const file = 'chromium-' + count + '-' + rep + '.cpuprofile';
            writeFileSync(join(out, file), JSON.stringify(profile));
            report.profiles.push({ engine, count, rep, file, ...stages, ...await verify(page), ...summarize(profile) });
            save();
          } finally { await page.close(); }
        }
      }
    } finally { await browser.close(); }
  }
  report.complete = true;
  save();
} finally {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
}
