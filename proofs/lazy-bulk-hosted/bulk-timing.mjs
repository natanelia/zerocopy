import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(readFileSync(new URL('./CONFIG.json', import.meta.url), 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const plain = data => JSON.parse(JSON.stringify(data));
const utf8 = new TextEncoder();
const rows = map => [...map.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const phaseAt = (endpoint, index) => endpoint.mode === 'scalar' ? Math.floor(index / 64) % 2 : index % 2;
const endpointById = id => {
  const found = config.endpoints.find(x => x.id === id);
  assert(found, `Unknown endpoint ${id}`);
  return found;
};

function fixture(endpoint) {
  const keys = Array.from({ length: endpoint.count }, (_, i) =>
    `k${String(i).padStart(3, '0')}${endpoint.unicode === 'all' || (endpoint.unicode === 'last' && i === endpoint.count - 1) ? '界' : ''}`);
  const phases = [0, 1].map(phase => keys.map((key, i) => [key,
    endpoint.type === 'number' ? i + phase / 8 : endpoint.type === 'object' ? { i, phase, ok: true }
      : `v${String(i).padStart(3, '0')}${endpoint.unicode === 'all' || (endpoint.unicode === 'last' && i === endpoint.count - 1) ? '界' : 'a'}${phase}`]));
  return { endpoint, keys, phases, empty: [] };
}

function checkFixture(f) {
  const e = f.endpoint;
  for (const phase of f.phases) {
    assert.equal(phase.length, e.count);
    const normalized = phase.map(([key]) => new TextDecoder().decode(utf8.encode(key)));
    assert.equal(new Set(normalized).size, e.count);
    const positions = list => list.flatMap((value, i) => /[^\x00-\x7f]/.test(value) ? [i] : []);
    const expected = e.unicode === 'all' ? [...Array(e.count).keys()] : e.unicode === 'last' ? [e.count - 1] : [];
    assert.deepEqual(positions(normalized), expected);
    if (e.type === 'string') assert.deepEqual(positions(phase.map(x => x[1])), expected);
  }
  const oracle = new Map(f.phases[1]);
  let changes = 0;
  for (let i = 0; i < config.smokeCalls; i++) {
    if (e.mode === 'empty') continue;
    const entries = e.mode === 'scalar' ? [f.phases[phaseAt(e, i)][i % 64]] : f.phases[phaseAt(e, i)];
    for (const [key, value] of entries) {
      assert.notDeepEqual(oracle.get(key), value, `${e.id} operation ${i} must change ${key}`);
      oracle.set(key, value); changes++;
    }
  }
  assert.equal(changes, e.mode === 'empty' ? 0 : config.smokeCalls * (e.mode === 'scalar' ? 1 : e.count));
  return { id: e.id, recordsPerCall: e.mode === 'bulk' ? e.count : e.mode === 'scalar' ? 1 : 0,
    initialCardinality: e.count, unicode: e.unicode, smokeCalls: config.smokeCalls, changedEntries: changes,
    fixtureSHA256: hash(JSON.stringify(f)) };
}

function pureSmoke() {
  assert.equal(config.endpoints.length, 8);
  assert.equal(new Set(config.endpoints.map(e => e.id)).size, 8);
  const descriptors = config.endpoints.map(e => checkFixture(fixture(e)));
  const expected = { schema: 1, kind: 'lazy-bulk-timing-fixtures', descriptors };
  assert.deepEqual(expected, plain(expected));
  const wrongCount = plain(expected); wrongCount.descriptors[0].recordsPerCall++;
  const wrongId = plain(expected); wrongId.descriptors[0].id = 'wrong';
  assert.throws(() => assert.deepEqual(expected, wrongCount));
  assert.throws(() => assert.deepEqual(expected, wrongId));
  return { status: 'passed', descriptors, metadataMutationRejections: 2 };
}

class Budget extends Error {}
function makeRunner(S) {
  // This setting applies before every arena creation in the child.
  S.configureMemory({ maximumBytes: config.arenaMaximumBytes });
  const ledger = [];
  const arenaState = map => {
    const data = S.getWorkerData({ map }, { copy: false });
    assert.equal(data.arenas.length, 1);
    const a = data.arenas[0];
    return { used: a.used, capacity: a.memory.buffer.byteLength };
  };
  const validate = (f, initial, map, count) => {
    assert.deepEqual(rows(initial), f.phases[1]);
    const oracle = new Map(f.phases[1]);
    if (f.endpoint.mode === 'bulk' && count) {
      for (const entry of f.phases[(count - 1) % 2]) oracle.set(...entry);
    } else if (f.endpoint.mode === 'scalar') {
      // Counts are full cycles, except the 128-call smoke which is also two cycles.
      assert.equal(count % 64, 0);
      if (count) for (const entry of f.phases[Math.floor((count - 1) / 64) % 2]) oracle.set(...entry);
    }
    assert.deepEqual(rows(map), [...oracle]);
    assert.equal(map.size, f.endpoint.count);
    if (f.endpoint.mode === 'empty') assert.equal(map, initial);
    else assert.notEqual(map.root, initial.root);
    return hash(JSON.stringify(rows(map)));
  };
  function epoch(f, count, kind, timed, probe = false) {
    if (ledger.length >= config.admissionsPerChild) throw new Budget('arena-admission-cap');
    assert(Number.isSafeInteger(count) && count > 0);
    if (!probe) assert.equal(count % config.minimumEpochCalls, 0);
    const item = { admission: ledger.length + 1, kind, endpoint: f.endpoint.id, calls: count,
      configuredMaximumBytes: config.arenaMaximumBytes, completed: false };
    ledger.push(item); // Debit before reset, including failed constructors.
    let initial, map, elapsedNs = 0, checksum = 0, maxDelta = 0, seedBytes = 0;
    try {
      let started = timed ? process.hrtime.bigint() : 0n;
      S.resetMap();
      map = new S.SharedMap(f.endpoint.type);
      if (timed) elapsedNs += Number(process.hrtime.bigint() - started);
      const before = arenaState(map); // Allocation inspection is outside timing.
      assert.equal(before.used, 65536);
      assert.equal(before.capacity, 131072);
      started = timed ? process.hrtime.bigint() : 0n;
      initial = map.setMany(f.phases[1]); map = initial;
      if (probe) seedBytes = arenaState(map).used - before.used;
      for (let i = 0; i < count; i++) {
        const oldUsed = probe ? arenaState(map).used : 0;
        if (f.endpoint.mode === 'scalar') {
          const [key, value] = f.phases[phaseAt(f.endpoint, i)][i % 64];
          if (probe) assert.notDeepEqual(map.get(key), value, 'scalar fixture became a no-op');
          map = map.set(key, value);
        } else {
          map = map.setMany(f.endpoint.mode === 'empty' ? f.empty : f.phases[i % 2]);
        }
        checksum = (checksum + map.root + map.size + i) >>> 0;
        if (probe) maxDelta = Math.max(maxDelta, arenaState(map).used - oldUsed);
      }
      if (timed) elapsedNs += Number(process.hrtime.bigint() - started);
      const after = arenaState(map);
      Object.assign(item, { before, after, allocatedBytes: after.used - before.used, elapsedNs: timed ? elapsedNs : null,
        checksum, root: map.root, initialRoot: initial.root, seedBytes: probe ? seedBytes : null, maximumObservedWriteBytes: probe ? maxDelta : null });
      if (item.allocatedBytes > config.epochBudgetBytes) throw new Budget('epoch-byte-budget');
      assert(after.capacity <= config.arenaMaximumBytes);
      item.contentSHA256 = validate(f, initial, map, count);
      item.completed = true;
      return item;
    } catch (error) {
      item.error = String(error);
      // An unreachable trap does not identify its cause. Treat every unproved
      // WASM trap as an unexpected failure, not recoverable resource evidence.
      throw error;
    }
  }
  function phase(f, calls, limit, kind, maxEpochs) {
    assert(Number.isSafeInteger(limit) && limit >= 256 && limit % 256 === 0);
    assert(Number.isSafeInteger(calls) && calls >= 256 && calls % 256 === 0);
    if (f.endpoint.mode === 'empty' && calls > config.emptyCallCap) throw new Budget('empty-operation-cap');
    const n = Math.ceil(calls / limit);
    if (n > maxEpochs || ledger.length + n > config.admissionsPerChild) throw new Budget('phase-admission-cap');
    const epochs = [];
    for (let left = calls; left > 0;) {
      const count = Math.min(left, limit);
      epochs.push(epoch(f, count, kind, true)); left -= count;
    }
    return { calls, elapsedNs: epochs.reduce((sum, e) => sum + e.elapsedNs, 0),
      epochAdmissions: epochs.map(e => e.admission), checksum: epochs.reduce((a, e) => (a + e.checksum) >>> 0, 0) };
  }
  return { ledger, epoch, phase };
}

async function subject(request) {
  const S = await import(pathToFileURL(request.subject).href);
  const run = makeRunner(S);
  const result = { schema: 1, kind: 'lazy-bulk-timing-child', mode: request.mode, engine: request.engine,
    arm: request.arm, endpoint: request.endpoint ?? null, status: 'running', ledger: run.ledger };
  try {
    if (request.mode === 'smoke') {
      result.fixtures = [];
      for (const e of config.endpoints) {
        const f = fixture(e); const descriptor = checkFixture(f);
        const record = run.epoch(f, config.smokeCalls, 'untimed-sizing-probe', false, true);
        result.fixtures.push({ ...descriptor, seedBytes: record.seedBytes, maximumObservedWriteBytes: record.maximumObservedWriteBytes });
      }
      assert.equal(run.ledger.length, 8);
      result.status = 'passed';
    } else {
      const f = fixture(endpointById(request.endpoint)); checkFixture(f);
      const limit = request.epochWriteLimit;
      if (request.mode === 'calibrate') {
        result.probes = [];
        for (const calls of config.probeCounts) {
          const probe = run.phase(f, calls, limit, 'calibration', config.measurementEpochs);
          result.probes.push(probe);
          if (probe.elapsedNs >= config.probeTargetNs) {
            result.selectedProbe = result.probes.length - 1; result.status = 'passed'; break;
          }
        }
        if (result.status === 'running') result.status = 'short';
      } else {
        assert.equal(request.mode, 'measure');
        result.warmup = run.phase(f, request.warmupCalls, limit, 'warmup', config.warmupEpochs);
        result.measurement = run.phase(f, request.measurementCalls, limit, 'measurement', config.measurementEpochs);
        result.status = result.measurement.elapsedNs >= config.measurementMinimumNs ? 'passed' : 'short';
      }
    }
  } catch (error) {
    result.status = error instanceof Budget ? 'budget-invalid' : 'failed';
    result.error = String(error);
  }
  result.admissions = run.ledger.length;
  result.sumConfiguredLinearMemoryMaxima = run.ledger.reduce((a, e) => a + e.configuredMaximumBytes, 0);
  assert(result.admissions <= config.admissionsPerChild);
  assert(result.sumConfiguredLinearMemoryMaxima <= config.admissionsPerChild * config.arenaMaximumBytes);
  return result;
}

const [mode, requestPath, outputPath] = process.argv.slice(2);
assert(mode === '--pure' || mode === '--request');
let result;
if (mode === '--pure') result = { schema: 1, kind: 'lazy-bulk-timing-pure-smoke', ...pureSmoke() };
else result = await subject(JSON.parse(readFileSync(requestPath, 'utf8')));
const bytes = JSON.stringify(result, null, 2) + '\n';
writeFileSync(outputPath, bytes, { flag: 'wx' });
console.log(JSON.stringify({ schema: 1, kind: result.kind, status: result.status, outputSHA256: hash(bytes) }));
if (result.status === 'failed') process.exitCode = 1;
