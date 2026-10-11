import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(readFileSync(new URL('./CONFIG.json', import.meta.url), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const arena = map => map.arena;
const byKey = (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
// These three topology/fixture helpers are verbatim accepted correctness helpers.
function inspect(map) {
  const a = arena(map), dv = a.dv, events = [], wasm = a.wasm;
  function visit(p, journalDepth = 0) {
    if (!p) return [];
    const tag = dv.getUint32(p, true);
    if (tag === 0) { events.push(['leaf', p]); return [p]; }
    if (tag === 0xffffffff) {
      events.push(['journal', p, journalDepth + 1]);
      const edits = Array.from({ length: dv.getUint32(p + 12, true) }, (_, i) => dv.getUint32(p + 16 + 4 * i, true));
      const keys = new Set(edits.map(leaf => a.leafKey(leaf)));
      return edits.concat(visit(dv.getUint32(p + 4, true), journalDepth + 1).filter(leaf => !keys.has(a.leafKey(leaf))));
    }
    if (tag === 2) {
      events.push(['collision', p]);
      return Array.from({ length: dv.getUint32(p + 8, true) }, (_, i) => dv.getUint32(p + 16 + 4 * i, true)).flatMap(leaf => visit(leaf, journalDepth));
    }
    const overlay = !!(tag & 0x80000000);
    assert.ok(overlay || (tag & 3) === 1, 'valid HAMT branch');
    events.push([overlay ? 'overlay' : 'canonical', p]);
    const bitmap = overlay ? dv.getUint32(p + 8, true) >>> 16 : dv.getUint32(p + 4, true);
    const result = [];
    for (let digit = 0; digit < 16; digit++) if (bitmap & (1 << digit)) {
      const child = wasm.mapChild(p, digit) >>> 0;
      assert.ok(child); result.push(...visit(child, journalDepth));
    }
    return result;
  }
  const pointers = visit(map.root), overlayIndexes = events.flatMap((event, i) => event[0] === 'overlay' ? [i] : []);
  return { pointers, overlayNodes: events.filter(e => e[0] === 'overlay').map(e => e[1]),
    overlayBitmaps: events.filter(e => e[0] === 'overlay').map(e => dv.getUint32(e[1] + 8, true) >>> 16),
    canonicalCount: events.filter(e => e[0] === 'canonical').length,
    collisionCount: events.filter(e => e[0] === 'collision').length,
    journalDepth: Math.max(0, ...events.filter(e => e[0] === 'journal').map(e => e[2])),
    leavesBeforeFirstOverlay: overlayIndexes.length ? events.slice(0, overlayIndexes[0]).filter(e => e[0] === 'leaf').length : pointers.length };
}
function fnv(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}
function selectedKeys() {
  const wanted = [0, ...Array.from({ length: 8 }, (_, i) => (i << 4) | 8),
    ...Array.from({ length: 8 }, (_, i) => ((i + 8) << 4) | 12), ...Array.from({ length: 5 }, (_, i) => (i << 4) | 15)];
  const found = new Map();
  for (let i = 0; i < 65536 && found.size < wanted.length; i++) {
    const key = `lane${i}`, prefix = fnv(key) & 255;
    if (wanted.includes(prefix) && !found.has(prefix)) found.set(prefix, key);
  }
  assert.equal(found.size, wanted.length, 'bounded key fixture found every requested prefix');
  return wanted.map(prefix => { const key = found.get(prefix); assert.equal(fnv(key) & 255, prefix); return key; });
}

class Budget extends Error {}
class TimerResolution extends Error {}
const [flag, requestPath, outputPath] = process.argv.slice(2);
assert.equal(flag, '--request'); assert.ok(requestPath && outputPath);
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
assert.ok(['smoke', 'calibrate', 'measure'].includes(request.mode));
assert.ok(config.engines.includes(request.engine) && config.arms.includes(request.arm));
const result = { schema: 1, kind: 'lazy-traversal-timing-observation', status: 'running', mode: request.mode,
  engine: request.engine, arm: request.arm, endpoint: request.endpoint ?? null,
  admissions: 0, sumConfiguredLinearMemoryMaxima: 0, ledger: [], phases: [], cumulativeCalls: 0 };
const checkpoint = () => writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
checkpoint();
function makeFixture(S, e) {
  const limit = request.mode === 'smoke' ? config.smokeAdmissions : config.subjectAdmissions;
  if (result.admissions >= limit) throw new Budget('arena-admission-cap');
  const admission = { admission: ++result.admissions, endpoint: e.id, maximumBytes: config.arenaMaximumBytes, completed: false };
  result.ledger.push(admission); result.sumConfiguredLinearMemoryMaxima += config.arenaMaximumBytes; checkpoint();
  let map, expected;
  if (e.mode === 'sorted') {
    S.resetSortedMap(); map = new S.SharedSortedMap('number');
    expected = Array.from({ length: 8 }, (_, i) => [`key${i}`, i]);
    for (const [key, value] of expected) map = map.set(key, value);
    assert.equal(map.comparator, undefined);
    assert.equal(arena(map).wasm.radixSize(map.root), 8);
  } else if (e.mode === 'empty-set') {
    S.resetMap(); map = new S.SharedSet(); expected = [];
  } else {
    S.resetMap(); map = new S.SharedMap('number');
    if (e.mode === 'overlay') {
      const keys = selectedKeys(), initial = keys.slice(0, 17).map((key, i) => [key, i]);
      map = map.setMany(initial).set(keys[1], -1).delete(keys[8]).set(keys[9], -9);
      const additions = keys.slice(17).map((key, i) => [key, 100 + i]);
      map = map.setMany(additions); const model = new Map(initial);
      model.set(keys[1], -1); model.delete(keys[8]); model.set(keys[9], -9);
      additions.forEach(([key, value]) => model.set(key, value)); expected = [...model];
    } else {
      expected = Array.from({ length: e.count }, (_, i) => [`key${i}`, i]); map = map.setMany(expected);
    }
  }
  const hamtMap = e.mode === 'empty-set' ? map._map : map;
  const readEntries = () => e.mode === 'empty-set' ? [...map.values()] : [...map.entries()];
  const a = arena(map), transport = S.getWorkerData({ map }, { copy: false });
  assert.equal(transport.arenas.length, 1); assert.equal(transport.arenas[0].id, a.id);
  const before = { used: a.used, capacity: a.memory.buffer.byteLength, bytes: Buffer.from(a.buf.slice(65536, a.used)) };
  assert.ok(before.capacity <= config.arenaMaximumBytes);
  const shape = e.mode === 'sorted' ? { kind: 'natural-radix', size: map.size } : inspect(hamtMap);
  if (e.mode === 'canonical') {
    assert.equal(shape.overlayNodes.length, 0); assert.equal(shape.pointers.length, e.count); assert.ok(shape.canonicalCount > 0);
  } else if (e.mode === 'overlay') {
    assert.equal(a.dv.getUint32(map.root, true) & 0x80000000, 0);
    assert.equal(shape.leavesBeforeFirstOverlay, 1); assert.ok(new Set(shape.overlayNodes).size >= 2);
    assert.equal(shape.overlayBitmaps[0] & shape.overlayBitmaps[1], 0);
  } else if (e.mode === 'empty' || e.mode === 'empty-set') {
    assert.equal(hamtMap.root, 0); assert.equal(hamtMap.size, 0); assert.equal(shape.pointers.length, 0);
  }
  assert.equal(map.size, e.count); assert.equal(expected.length, e.count);
  assert.deepEqual(readEntries().sort(byKey), [...expected].sort(byKey));
  const sum = expected.reduce((total, row) => total + row[1], 0);
  assert.ok(Number.isSafeInteger(sum));
  Object.assign(admission, { completed: true, root: hamtMap.root, size: map.size, used: before.used,
    capacity: before.capacity, prefixSHA256: sha(before.bytes), expectedSum: sum, shape,
    fixtureSHA256: sha(JSON.stringify({ endpoint: e.id, expected: [...expected].sort(byKey), shape })) });
  checkpoint(); return { map, a, expected, sum, before, admission, readEntries };
}
function phase(f, calls, kind, timed = true) {
  assert.ok(Number.isSafeInteger(calls) && calls > 0 && calls <= config.operationCap);
  if (request.mode === 'calibrate' && result.cumulativeCalls + calls > config.calibrationCumulativeCap) throw new Budget('calibration-cumulative-operation-cap');
  const record = { kind, calls, completed: false }; result.phases.push(record); checkpoint();
  let checksum = 0, consumed = 0, traversals = 0;
  const start = timed ? process.hrtime.bigint() : 0n;
  for (let i = 0; i < calls; i++) {
    for (const value of f.map.values()) { checksum = (checksum + value) >>> 0; consumed++; }
    traversals++;
  }
  const elapsedNs = timed ? Number(process.hrtime.bigint() - start) : null;
  Object.assign(record, { elapsedNs, checksum, consumed, traversals, completed: true });
  result.cumulativeCalls += calls; checkpoint();
  assert.equal(traversals, calls); assert.equal(consumed, calls * f.expected.length);
  assert.equal(checksum, Number((BigInt(f.sum) * BigInt(calls)) & 0xffffffffn));
  assert.equal(f.a.used, f.before.used); assert.equal(f.a.memory.buffer.byteLength, f.before.capacity);
  assert.deepEqual(Buffer.from(f.a.buf.subarray(65536, f.before.used)), f.before.bytes);
  assert.deepEqual(f.readEntries().sort(byKey), [...f.expected].sort(byKey));
  record.validated = true; checkpoint();
  if (request.mode === 'calibrate' && timed && !(Number.isFinite(elapsedNs) && elapsedNs > 0)) {
    throw new TimerResolution('calibration-timer-resolution');
  }
  return record;
}
try {
  const S = await import(pathToFileURL(request.subject).href);
  S.configureMemory({ maximumBytes: config.arenaMaximumBytes });
  if (request.mode === 'smoke') {
    assert.equal(request.endpoint, null);
    for (const e of config.endpoints) phase(makeFixture(S, e), config.smokeCalls, 'smoke', false);
    result.status = 'passed';
  } else {
    const e = config.endpoints.find(e => e.id === request.endpoint); assert.ok(e);
    const f = makeFixture(S, e);
    if (request.mode === 'calibrate') {
      let calls = config.probeStart, probe;
      for (;;) {
        probe = phase(f, calls, 'geometric');
        if (probe.elapsedNs >= config.probeTargetNs || calls === config.operationCap) break;
        calls = Math.min(config.operationCap, calls * config.probeMultiplier);
      }
      if (probe.elapsedNs < config.probeTargetNs) { result.status = 'short'; result.error = 'geometric-probe-duration-floor'; }
      else {
        const warm = []; let elapsed = 0;
        while (warm.length < config.warmCalibrationMinimumBatches || elapsed < config.warmCalibrationMinimumNs) {
          if (warm.length === config.warmCalibrationMaximumBatches) break;
          const row = phase(f, calls, 'calibration-warmup'); warm.push(row); elapsed += row.elapsedNs;
        }
        result.calibrationWarmup = { batches: warm.length, elapsedNs: elapsed, callsPerBatch: calls };
        if (warm.length < config.warmCalibrationMinimumBatches || elapsed < config.warmCalibrationMinimumNs) {
          result.status = 'short'; result.error = 'calibration-warmup-floor';
        } else {
          const fastest = Math.min(...warm.slice(-4).map(row => row.elapsedNs / row.calls));
          if (!(fastest > 0)) { result.status = 'short'; result.error = 'timer-resolution'; }
          else {
            const pilotCalls = Math.ceil(config.pilotTargetNs / fastest / config.countQuantum) * config.countQuantum;
            result.pilotCalls = pilotCalls; checkpoint();
            if (pilotCalls > config.operationCap) throw new Budget('pilot-operation-cap');
            const pilots = [];
            for (let i = 0; i < config.pilotBatches; i++) pilots.push(phase(f, pilotCalls, 'pilot'));
            result.pilots = pilots;
            result.status = pilots.every(row => row.elapsedNs >= config.pilotMinimumNs) ? 'passed' : 'short';
            if (result.status === 'short') result.error = 'pilot-duration-floor';
          }
        }
      }
    } else {
      const calls = request.measurementCalls;
      assert.ok(Number.isSafeInteger(calls) && calls > 0 && calls <= config.operationCap && calls % config.countQuantum === 0);
      const warm = [];
      for (let i = 0; i < config.measurementWarmupBatches; i++) warm.push(phase(f, calls / config.measurementWarmupDivisor, 'measurement-warmup'));
      result.warmup = { calls: warm.reduce((n, row) => n + row.calls, 0), elapsedNs: warm.reduce((n, row) => n + row.elapsedNs, 0), batches: warm };
      result.measurement = phase(f, calls, 'measurement');
      result.status = result.warmup.elapsedNs >= config.measurementWarmupMinimumNs && result.measurement.elapsedNs >= config.measurementMinimumNs ? 'passed' : 'short';
      if (result.status === 'short') result.error = result.warmup.elapsedNs < config.measurementWarmupMinimumNs ? 'measurement-warmup-duration-floor' : 'measurement-duration-floor';
    }
  }
} catch (error) {
  result.status = error instanceof TimerResolution ? 'short' : error instanceof Budget ? 'budget-invalid' : 'failed'; result.error = String(error.stack ?? error);
}
checkpoint();
console.log(JSON.stringify({ status: result.status, outputSHA256: sha(readFileSync(outputPath)) }));
if (result.status === 'failed') process.exitCode = 1;
