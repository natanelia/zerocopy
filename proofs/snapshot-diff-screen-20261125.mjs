import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox } from 'playwright';

const [checkout, output, rounds = '11'] = process.argv.slice(2);
assert(checkout && output && Number.isInteger(+rounds) && +rounds > 0);
const root = resolve(checkout);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const identity = JSON.parse(readFileSync(join(root, 'website/_site/build.json'), 'utf8'));
assert.equal(identity.sourceCommit, commit);
assert.equal(identity.sourceDirty, false);
const report = { complete: false, commit, identity, driverSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'), cases: [], samples: [], engines: {} };
const save = () => writeFileSync(resolve(output), JSON.stringify(report, null, 2));
const { createPreview } = await import(pathToFileURL(join(root, 'website/serve.mjs')).href);
const server = createPreview();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + server.address().port + '/investigation-benchmark/';

// Evidence-only algorithm. Changed means a different published leaf address
// or presence/absence, not necessarily different decoded values. Only compare
// addresses in a verified single attached Arena. No production API or change.
function reader() {
  self.onmessage = async ({ data }) => {
    try {
      const { initWorker } = await import(data.apiURL);
      const { issuesFor } = await import(data.fixtureURL);
      const start = performance.now();
      const { before, after } = await initWorker(data.payload);
      const attachMs = performance.now() - start;
      const a = before.arena;
      if (a !== after.arena || !a.readOnly || !(a.memory.buffer instanceof SharedArrayBuffer)) throw Error('Requires a single verified shared reader arena');
      if (typeof a.wasm.mapChild !== 'function') throw Error('Missing mapChild export');
      const view = a.dv;
      const changed = new Set();
      let visited = 0, enumerated = 0, skipped = 0;
      function scan(left, right) {
        // Strong baseline: scan addresses, not decoded JSON. Also handles
        // non-branch shape mismatches, collision buckets and journal roots.
        const old = new Set();
        for (const p of a.leaves(left)) { old.add(p); enumerated++; }
        for (const p of a.leaves(right)) {
          enumerated++;
          if (!old.delete(p)) changed.add(a.leafKey(p, view));
        }
        for (const p of old) changed.add(a.leafKey(p, view));
      }
      function bitmap(p, tag) {
        return tag === 0xffffffff ? 0 : (tag & 0x80000000) ? view.getUint32(p + 8, true) >>> 16 : (tag & 3) === 1 ? view.getUint32(p + 4, true) : 0;
      }
      function diff(left, right) {
        visited++;
        if (left === right) { skipped++; return; }
        const lm = left ? bitmap(left, view.getUint32(left, true)) : 0;
        const rm = right ? bitmap(right, view.getUint32(right, true)) : 0;
        if (!lm || !rm) { scan(left, right); return; }
        const union = lm | rm;
        for (let digit = 0; digit < 16; digit++) {
          const bit = 1 << digit;
          if (union & bit) diff(lm & bit ? a.wasm.mapChild(left, digit) >>> 0 : 0, rm & bit ? a.wasm.mapChild(right, digit) >>> 0 : 0);
        }
      }
      const detectStart = performance.now();
      if (data.mode === 'scan') scan(before.root, after.root);
      else if (data.mode === 'tree') diff(before.root, after.root);
      else throw Error('Unknown mode');
      const detectMs = performance.now() - detectStart;
      // Same downstream computation for both algorithms: update validation
      // summary from the old summary and affected records only.
      const computeStart = performance.now();
      let invalid = data.initialInvalid;
      for (const key of changed) {
        const prev = before.get(key), next = after.get(key);
        if (prev && issuesFor(prev).length) invalid--;
        if (next && issuesFor(next).length) invalid++;
      }
      const recomputeMs = performance.now() - computeStart;
      const totalMs = performance.now() - detectStart;
      const keys = [...changed].sort();
      self.postMessage({ attachMs, detectMs, recomputeMs, totalMs, keys, invalid, visited, enumerated, skipped, beforeSize: before.size, afterSize: after.size });
    } catch (error) { self.postMessage({ error: String(error.stack || error) }); }
  };
}

const cases = [
  { count: 1000, edits: 1, kind: 'sparse' },
  { count: 10000, edits: 100, kind: 'sparse' },
  { count: 100000, edits: 100, kind: 'sparse' },
  { count: 100000, edits: 1000, kind: 'churn' },
  { count: 10000, edits: 5000, kind: 'dense' },
  { count: 10000, edits: 0, kind: 'identity' },
];
async function prepare(page, c) {
  await page.goto(url);
  assert(await page.evaluate(() => crossOriginIsolated));
  return page.evaluate(async ({ c, workerSource }) => {
    const fixtureURL = new URL('./assets/catalog-core.mjs', location.href).href;
    const apiURL = new URL('./library/shared.js', location.href).href;
    const f = await import(fixtureURL);
    const api = await import(apiURL);
    const entries = f.entriesFor(c.count), initial = new Map(entries), next = new Map(entries);
    const expected = new Set(), writes = [], deletes = [];
    const before = new api.SharedMap('object').setMany(entries);
    for (let i = 0; i < c.edits; i++) {
      // 7919 is coprime to all fixture counts. Churn combines removals
      // and inserts with disjoint replacements in the same retained map.
      const index = i * 7919 % c.count, key = f.productId(index);
      expected.add(key);
      if (c.kind === 'churn' && i % 2 === 0) {
        deletes.push(key); next.delete(key);
        const added = 'tile/新增/' + i, value = f.product(index, 1);
        expected.add(added); writes.push([added, value]); next.set(added, value);
      } else {
        const value = f.product(index, 1);
        writes.push([key, value]); next.set(key, value);
      }
    }
    const after = deletes.length || writes.length ? before.deleteMany(deletes).setMany(writes) : before;
    if (before.arena !== after.arena) throw Error('Owner arena mismatch');
    const payload = api.getWorkerData({ before, after }, { copy: false });
    if (payload.arenas.length !== 1 || payload.arenas.some(a => a.copy || !(a.memory.buffer instanceof SharedArrayBuffer))) throw Error('Not a single shared arena');
    const invalid = m => [...m.values()].reduce((n, value) => n + Number(f.issuesFor(value).length > 0), 0);
    const initialInvalid = invalid(initial), expectedInvalid = invalid(next);
    // Verify the complete logical contents before timing readers. Native Map
    // serves as the independent mutation and validation oracle.
    for (const [map, oracle] of [[before, initial], [after, next]]) {
      if (map.size !== oracle.size) throw Error('Size mismatch');
      let count = 0;
      for (const [key, value] of map.entries()) {
        if (!oracle.has(key) || JSON.stringify(value) !== JSON.stringify(oracle.get(key))) throw Error('Content mismatch: ' + key);
        count++;
      }
      if (count !== oracle.size) throw Error('Traversal mismatch');
    }
    const workerURL = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    globalThis.__diff = { workerURL, payload, apiURL, fixtureURL, initialInvalid };
    return { expectedKeys: [...expected].sort(), expectedInvalid, beforeSize: before.size, afterSize: after.size, initialInvalid, arenaBytes: after.arena.used };
  }, { c, workerSource: '(' + reader.toString() + ')();' });
}
async function sample(page, mode, oracle) {
  const data = await page.evaluate(async mode => {
    const p = globalThis.__diff;
    const workers = Array.from({ length: 2 }, () => new Worker(p.workerURL, { type: 'module' }));
    try {
      const start = performance.now();
      const readers = await Promise.all(workers.map(w => new Promise((resolve, reject) => {
        w.onmessage = e => e.data.error ? reject(Error(e.data.error)) : resolve(e.data);
        w.onerror = e => reject(Error(e.message));
        w.postMessage({ mode, payload: p.payload, apiURL: p.apiURL, fixtureURL: p.fixtureURL, initialInvalid: p.initialInvalid });
      })));
      return { readers, roundTripMs: performance.now() - start };
    } finally { workers.forEach(w => w.terminate()); }
  }, mode);
  for (const r of data.readers) {
    assert.deepEqual(r.keys, oracle.expectedKeys);
    assert.equal(r.invalid, oracle.expectedInvalid);
    assert.equal(r.beforeSize, oracle.beforeSize);
    assert.equal(r.afterSize, oracle.afterSize);
    for (const key of ['attachMs', 'detectMs', 'recomputeMs', 'totalMs']) assert(Number.isFinite(r[key]) && r[key] >= 0);
    // Raw keys are checked in full; preserve hashes and counts in the artifact
    // rather than duplicating up to 5000 strings for every measurement.
    r.keyHash = createHash('sha256').update(JSON.stringify(r.keys)).digest('hex');
    r.keyCount = r.keys.length;
    delete r.keys;
  }
  return data;
}
try {
  for (const [engine, launcher] of Object.entries({ chromium, firefox })) {
    const browser = await launcher.launch();
    report.engines[engine] = browser.version();
    try {
      for (const c of cases) {
        const page = await browser.newPage();
        try {
          const oracle = await prepare(page, c);
          const id = engine + '/' + c.count + '/' + c.kind;
          report.cases.push({ id, ...c, ...oracle });
          save();
          // Untimed warmups; each timed call uses two newly created readers.
          // First screen the baseline before executing the prototype.
          await sample(page, 'scan', oracle);
          await sample(page, 'tree', oracle);
          for (let i = 0; i < +rounds; i++) {
            const groups = i % 2 ? ['ab', 'aa'] : ['aa', 'ab'];
            for (const group of groups) {
              const modes = group === 'aa' ? ['scan', 'scan'] : ['scan', 'tree'];
              if (i % 2) modes.reverse();
              for (let order = 0; order < modes.length; order++) {
                const mode = modes[order], result = await sample(page, mode, oracle);
                report.samples.push({ id, group, pair: i, order, mode, ...result });
                save();
              }
            }
          }
          console.log(id + ': ' + (+rounds) + ' A/A and A/B pairs verified');
        } finally { await page.close(); }
      }
    } finally { await browser.close(); }
  }
  report.complete = true;
} finally { save(); await new Promise(r => server.close(r)); }
