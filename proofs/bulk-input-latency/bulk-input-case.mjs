/** Fixed public bulk histories; importing this module never imports a library or reads a timer. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const matrix = JSON.parse(readFileSync(new URL('./MATRIX.json', import.meta.url), 'utf8'));
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
export function fixtures(spec) {
  const size = Math.max(spec.count, spec.seedCount), keys = Array.from({ length: size }, (_, i) => `key-${i}`);
  function value(i, phase) {
    const marker = phase < 0 ? 'S' : 'ABC'[phase];
    if (spec.type === 'number') return i + (phase < 0 ? 0.125 : [0.25, 0.5, 0.75][phase]);
    if (spec.type === 'boolean') return ((i + phase + 1) & 1) === 0;
    if (spec.type === 'object') return { id: i, label: `Lane ${i} — 道路 🙂 ${marker}`, active: (i & 1) === 0,
      position: [i * 0.25, -i * 0.5], meta: { revision: (i + phase + 1) % 7, source: 'survey' } };
    const prefix = `value-${i}-${marker}-`; return prefix + 'x'.repeat(48 - prefix.length);
  }
  const seed = keys.map((_, i) => value(i, -1));
  const values = Array.from({ length: spec.updatePhases }, (_, phase) => keys.slice(0, spec.count).map((_, i) => value(i, phase)));
  const seedEntries = keys.slice(0, spec.seedCount).map((key, i) => [key, seed[i]]);
  const entries = values.map(row => row.map((v, i) => [keys[i], v]));
  // Native serialization is the independent value oracle; no library value feeds it.
  const expected = {};
  for (const phase of [-1, ...values.map((_, i) => i)]) expected[phase] = keys.map((_, i) => JSON.stringify(phase >= 0 && i < spec.count ? values[phase][i] : seed[i]));
  if (spec.type === 'object') for (let i = 0; i < size; i++) {
    const lengths = Object.values(expected).map(row => new TextEncoder().encode(row[i]).length);
    assert(lengths.every(n => n === lengths[0] && n <= 192), 'Source-model JSON bound/phase lengths');
  }
  return freeze({ keys, seedEntries, entries, expected });
}

export function createWorkload(api, spec) {
  const f = fixtures(spec); let current, seed, phase = -1, epoch = 0, stableArena;
  const checkStats = map => {
    const data = api.getWorkerData({ map }, { copy: false }); assert.equal(data.arenas.length, 1);
    const a = data.arenas[0], used = a.used, backing = a.memory.buffer.byteLength;
    assert(Number.isSafeInteger(used) && used >= 65536 && used <= backing);
    assert(backing <= matrix.maximumObservedWasmBackingBytes, '128 MiB WASM backing bound');
    return { used, backing, id: a.id };
  };
  function reset() { current = seed = undefined; api.resetMap(); current = new api.SharedMap(spec.type); seed = current; phase = -1; }
  if (spec.regime === 'long-lived-updates') {
    reset(); current = current.setMany(f.seedEntries); seed = current; stableArena = checkStats(current).id;
  }
  function verify(map, wantedPhase, size) {
    assert(Object.isFrozen(map)); assert.equal(map.size, size);
    const digest = createHash('sha256'), expected = f.expected[wantedPhase];
    for (let i = 0; i < size; i++) {
      const actual = JSON.stringify(map.get(f.keys[i])); assert.equal(actual, expected[i], `${spec.id}: phase ${wantedPhase}, key ${i}`);
      digest.update(f.keys[i]).update('\0').update(actual).update('\0');
    }
    return digest.digest('hex');
  }
  return {
    prepare() {
      if (spec.regime === 'fresh-creation') reset();
      const before = checkStats(current); if (stableArena) assert.equal(before.id, stableArena);
      return { start: current, startPhase: phase, before, epochBefore: epoch };
    },
    run() {
      for (let i = 0; i < spec.callsPerSample; i++) { phase = epoch % spec.updatePhases; current = current.setMany(f.entries[phase]); epoch++; }
    },
    async finish(prepared) {
      const after = checkStats(current), size = spec.regime === 'fresh-creation' ? spec.count : spec.seedCount;
      assert.equal(after.id, prepared.before.id); assert.equal(epoch - prepared.epochBefore, spec.callsPerSample);
      assert(after.used >= prepared.before.used);
      const row = { epochBefore: prepared.epochBefore, epochAfter: epoch, phase, startPhase: prepared.startPhase, size,
        calls: spec.callsPerSample, beforeUsed: prepared.before.used, used: after.used, usedIncrement: after.used - prepared.before.used,
        beforeBacking: prepared.before.backing, backing: after.backing, grew: after.backing > prepared.before.backing,
        copySpanBytes: after.used, logical: verify(current, phase, size),
        retainedLogical: verify(prepared.start, prepared.startPhase, spec.regime === 'fresh-creation' ? 0 : spec.seedCount),
        seedLogical: verify(seed, -1, spec.seedCount) };
      // Preserve writer-cache effects, then traverse all roots with fresh read caches.
      // This attachment shares the existing memory; handles stay local to finish().
      const data = api.getWorkerData({ latest: current, start: prepared.start, seed }, { copy: false });
      assert.equal(data.arenas.length, 1); assert.equal(data.arenas[0].id, after.id);
      assert.equal(data.arenas[0].used, after.used); assert.equal(data.arenas[0].memory.buffer.byteLength, after.backing);
      const reader = await api.initWorker(data);
      assert.equal(verify(reader.latest, phase, size), row.logical);
      assert.equal(verify(reader.start, prepared.startPhase, spec.regime === 'fresh-creation' ? 0 : spec.seedCount), row.retainedLogical);
      assert.equal(verify(reader.seed, -1, spec.seedCount), row.seedLogical);
      assert.deepEqual(checkStats(current), after, 'Read-only verification must not allocate in the writer arena');
      return { ...row, freshReaderVerified: true };
    },
  };
}

export function scalarSnapshot(row) {
  assert(Object.values(row).every(v => v === null || ['string', 'number', 'boolean'].includes(typeof v)), 'Records may contain no live references');
  return Object.freeze({ ...row });
}

async function main() {
  const [entryArg, outputArg, cell, label, pairRaw, kind, runtime] = process.argv.slice(2);
  const spec = matrix.cells.find(c => c.id === cell), pair = Number(pairRaw);
  assert(spec && ['node', 'bun'].includes(runtime) && ['ab', 'aa'].includes(kind));
  assert(Number.isSafeInteger(pair) && pair >= 0 && pair < (kind === 'aa' ? 1 : spec.abPairs[runtime]));
  assert((kind === 'aa' ? ['left', 'right'] : ['baseline', 'candidate']).includes(label));
  if (runtime === 'node') { assert.equal(process.versions.bun, undefined); assert.equal(process.versions.node, '22.23.3'); }
  else assert.equal(process.versions.bun, '1.4.2');
  const gc = runtime === 'node' ? globalThis.gc : () => Bun.gc(true); assert.equal(typeof gc, 'function');
  const entry = resolve(entryArg), output = resolve(outputArg), rowsFile = `${output}.rows.jsonl`, startFile = `${output}.started.json`;
  for (const name of [output, rowsFile, startFile]) assert(!existsSync(name), 'Refusing to overwrite original evidence');
  const digest = createHash('sha256');
  for (const name of readdirSync(dirname(entry)).filter(n => n.endsWith('.js')).sort()) digest.update(name).update('\0').update(readFileSync(resolve(dirname(entry), name))).update('\0');
  const metadata = { schema: 'bulk-input-fixed-history/v1', cell, label, pair, kind, runtime, versions: process.versions,
    executable: process.execPath, entry, buildSha256: digest.digest('hex'), platform: process.platform, arch: process.arch,
    cpu: cpus()[0]?.model, warmups: matrix.warmups, measuredSamples: matrix.measuredSamples, date: new Date().toISOString() };
  writeFileSync(startFile, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(rowsFile, '', { flag: 'wx' });
  const rows = []; let failure;
  try {
    const api = await import(pathToFileURL(entry).href), work = createWorkload(api, spec);
    for (let block = 0; block < matrix.warmups + matrix.measuredSamples; block++) {
      let prepared = work.prepare(), ms, error, checked;
      gc();
      const begin = performance.now();
      try { work.run(); } catch (caught) { error = caught; }
      ms = performance.now() - begin;
      try { assert(Number.isFinite(ms) && ms > 0, 'Invalid measured duration'); if (error) throw error; checked = await work.finish(prepared); }
      catch (caught) { error = caught; }
      const row = scalarSnapshot({ block, stage: block < matrix.warmups ? 'warmup' : 'measured', ms,
        ...(checked ?? {}), verified: !error, errorName: error?.name ?? null, errorMessage: error?.message ?? null });
      appendFileSync(rowsFile, JSON.stringify(row) + '\n'); rows.push(row); prepared = null;
      if (error) throw error;
    }
  } catch (error) { failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
  writeFileSync(output, JSON.stringify({ ...metadata, complete: !failure, failure: failure ?? null, rows }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ cell, label, rows: rows.length, complete: !failure }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
