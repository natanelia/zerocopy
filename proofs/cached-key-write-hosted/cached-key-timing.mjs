import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(readFileSync(new URL('./CONFIG.json', import.meta.url), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const [flag, requestPath, outputPath] = process.argv.slice(2);
assert.equal(flag, '--request');
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
assert.ok(['smoke', 'calibrate', 'measure', 'fresh'].includes(request.mode));
assert.ok(config.engines.includes(request.engine) && config.arms.includes(request.arm));
const endpoint = config.endpoints.find(e => e.id === request.endpoint);
if (request.mode !== 'smoke') assert.ok(endpoint);
if (request.mode === 'measure') {
  assert.notEqual(endpoint.mode, 'fresh');
  assert.equal(request.measurementOperationCap, endpoint.measurementCap);
} else assert.equal(request.measurementOperationCap, undefined);

class Budget extends Error {}
const result = { schema: 1, kind: 'cached-key-write-timing-observation', status: 'running',
  mode: request.mode, engine: request.engine, arm: request.arm, endpoint: request.endpoint ?? null,
  measurementOperationCap: request.measurementOperationCap ?? null,
  allocationCappedCount: request.allocationCappedCount ?? null,
  targetMeasurementCalls: request.targetMeasurementCalls ?? null,
  cumulativeCallsScope: 'phase-loop operations only', calibrationContributesToGainInference: false,
  admissions: 0, sumConfiguredLinearMemoryMaxima: 0, ledger: [], fixtures: [], phases: [], cumulativeCalls: 0 };
const checkpoint = () => writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
checkpoint();
const admitted = new Map(), keepFixtures = [];
let S, owner;
const encoder = new TextEncoder();
const keys = Array.from({ length: 32 }, (_, i) => `k${String(i).padStart(3, '0')}`);
const byKey = (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
const align4 = n => Math.ceil(n / 4) * 4;
const publicValue = value => value && typeof value.entries === 'function' ? [...value.entries()].sort(byKey) : value;
const prefix = (a, end = a.used) => sha(new Uint8Array(a.memory.buffer, 65536, end - 65536));

function admit(snapshot, role, maximumBytes) {
  const a = owner(snapshot);
  assert.ok(!admitted.has(a.id));
  assert.equal(a.used, 65536); assert.equal(a.memory.buffer.byteLength, 131072);
  const row = { id: a.id, role, maximumBytes, initialUsed: a.used, initialCapacity: a.memory.buffer.byteLength,
    used: a.used, capacity: a.memory.buffer.byteLength, completed: false };
  admitted.set(a.id, { a, row }); result.ledger.push(row);
  result.admissions = admitted.size;
  result.sumConfiguredLinearMemoryMaxima += maximumBytes;
  checkpoint();
  return a;
}

function nativeState() {
  let backing = 0;
  const rows = [];
  for (const { a, row } of admitted.values()) {
    row.used = a.used; row.capacity = a.memory.buffer.byteLength;
    assert.ok(row.used >= 65536 && row.used <= row.capacity && row.capacity <= row.maximumBytes);
    assert.equal(row.capacity % 65536, 0);
    backing += row.capacity;
    rows.push({ id: row.id, role: row.role, used: row.used, capacity: row.capacity, maximumBytes: row.maximumBytes });
  }
  if (backing > config.nativeBackingCapBytes) throw new Budget('total-native-backing-cap');
  return { backingBytes: backing, arenas: rows };
}

function checkMap(map, expected) {
  assert.equal(map.size, expected.length); assert.ok(Object.isFrozen(map));
  const wanted = expected.map(([key, value]) => [key, value]).sort(byKey);
  const actual = [...map.entries()].map(([key, value]) => [key, publicValue(value)]).sort(byKey);
  assert.deepEqual(actual, wanted);
  for (const [key, value] of wanted) {
    const observed = map.get(key);
    assert.deepEqual(publicValue(observed), value);
    if (observed && typeof observed === 'object') assert.ok(Object.isFrozen(observed));
  }
}

function fixture(e) {
  const children = [], childModels = [[['v', 0]], [['v', 1]]];
  let dependency;
  if (e.mode === 'nested') {
    S.configureMemory({ maximumBytes: config.dependencyMaximumBytes }); S.resetMap();
    const empty = new S.SharedMap('number');
    dependency = admit(empty, e.id + '/child', config.dependencyMaximumBytes);
    children.push(empty.set('v', 0)); children.push(children[0].set('v', 1));
    assert.equal(dependency.used, 65536 + 56); assert.equal(dependency.memory.buffer.byteLength, 131072);
  }
  S.configureMemory({ maximumBytes: e.mode === 'fresh' ? config.freshMaximumBytes : config.parentMaximumBytes });
  S.resetMap();
  const type = e.mode === 'nested' ? S.map('number') : e.mode === 'primitive' ? 'number' : 'object';
  const empty = new S.SharedMap(type);
  const a = admit(empty, e.id + '/parent', e.mode === 'fresh' ? config.freshMaximumBytes : config.parentMaximumBytes);
  let seed, seedModel;
  if (e.mode === 'miss') {
    seedModel = Array.from({ length: 2048 }, (_, i) => [`s${String(i).padStart(4, '0')}`, { seed: 1 }]);
    seed = new S.SharedMap('object').setMany(seedModel);
    assert.equal(owner(seed), a); assert.equal(a.keys.size, 2048); assert.equal(a.keyBytes, 10240);
  }
  const models = [0, 1].map(revision => keys.map((key, i) => [key,
    e.mode === 'nested' ? childModels[revision] : e.mode === 'primitive' ? i + revision * 0.5 : { id: i, revision }]));
  let rows = models.map((model, revision) => model.map(([key, value]) => [key,
    e.mode === 'nested' ? children[revision] : value]));
  const descriptorTexts = children.map(value => JSON.stringify({ __t: 'SharedMap', __i: 'number', __a: dependency.id, __d: value.toWorkerData() }));
  const descriptorBytes = descriptorTexts.map(text => encoder.encode(text).length);
  assert.ok(descriptorBytes.every(length => length <= 256));
  let freshModel;
  if (e.mode === 'fresh') {
    freshModel = Array.from({ length: 5000 }, (_, i) => [`key-${i}`, {
      id: i, label: `Lane ${i} — 道路 🙂`, active: (i & 1) === 0,
      position: [i * 0.25, -i * 0.5], meta: { revision: i % 7, source: 'survey' },
    }]);
    assert.ok(freshModel.every(([key, value]) => encoder.encode(key).length <= 8 && encoder.encode(JSON.stringify(value)).length <= 512));
    rows = [freshModel];
    // JSON normalizes -0 in the first position; preserve the original input
    // and independently compare the documented JSON-decoded value model.
    freshModel = JSON.parse(JSON.stringify(freshModel));
  } else if (e.mode === 'object' || e.mode === 'miss') {
    assert.ok(rows.flat().every(([, value]) => encoder.encode(JSON.stringify(value)).length <= 22));
  }
  let current = e.mode === 'fresh' ? empty : empty.setMany(rows[0]);
  const initial = current, retained = [{ map: initial, revision: 0 }];
  const setupBytes = a.used - 65536;
  assert.ok(setupBytes <= e.setupBytes);
  const tokenIDs = new Map(keys.map(key => [key, a.keys.get(key)]));
  if (e.mode === 'object' || e.mode === 'nested') assert.ok([...tokenIDs.values()].every(token => token && token.ptr !== undefined));
  if (e.mode === 'miss') assert.ok([...tokenIDs.values()].every(token => token === undefined));
  const fixedModels = e.mode === 'fresh' ? { empty: [], final: freshModel } : { revisions: models, seed: seedModel ?? null };
  const row = { endpoint: e.id, unit: e.mode === 'fresh' ? 5000 : 32.5, completed: false,
    semanticSHA256: sha(JSON.stringify({ endpoint: e.id, type, fixedModels })),
    parentID: a.id, dependencyIDs: dependency ? [dependency.id] : [], setupBytes,
    descriptorTexts, descriptorBytes, descriptorIDsAreRandomPublicIDs: e.mode === 'nested',
    rawDescriptorBytesComparableAcrossProcesses: false, initialDescriptor: initial.toWorkerData(),
    keyCount: e.mode === 'fresh' ? 5000 : 32, inputModelSHA256: sha(JSON.stringify(fixedModels)) };
  assert.equal(row.semanticSHA256, e.semanticSHA256); assert.equal(row.inputModelSHA256, e.inputModelSHA256);
  result.fixtures.push(row);
  const f = { e, a, row, initial, retained, children, dependency, revision: 0, completedCalls: 0,
    run(calls) {
      let checksum = 0;
      if (e.mode === 'fresh') {
        current = current.setMany(rows[0]); checksum = current.size;
      } else {
        let next = current;
        for (let i = 0; i < calls; i++) {
          const revision = (this.completedCalls + i + 1) & 1;
          next = next.setMany(rows[revision]); checksum = (checksum + next.size + revision) >>> 0;
        }
        current = next;
      }
      return checksum;
    },
    finish(calls) {
      this.completedCalls += calls; this.revision = this.completedCalls & 1;
      retained.push({ map: current, revision: this.revision });
    },
    validate() {
      const before = nativeState();
      for (const snapshot of retained) checkMap(snapshot.map, e.mode === 'fresh'
        ? snapshot.map === initial ? [] : freshModel : models[snapshot.revision]);
      if (seed) checkMap(seed, seedModel);
      for (let i = 0; i < children.length; i++) checkMap(children[i], childModels[i]);
      if (e.mode === 'object' || e.mode === 'nested') for (const key of keys) assert.equal(a.keys.get(key), tokenIDs.get(key));
      if (e.mode === 'miss') {
        assert.equal(a.keys.size, 2048); assert.equal(a.keyBytes, 10240);
        for (const key of keys) assert.equal(a.keys.has(key), false);
      }
      const handles = { initial, current, ...(seed ? { seed } : {}), ...Object.fromEntries(children.map((value, i) => ['child' + i, value])) };
      const data = S.getWorkerData(handles, { copy: false });
      assert.deepEqual(data.arenas.map(x => x.id).sort(), [a.id, ...(dependency ? [dependency.id] : [])].sort());
      for (const [name, value] of Object.entries(handles)) {
        assert.equal(data.structures[name].arena, owner(value).id);
        assert.deepEqual(data.structures[name].data, value.toWorkerData());
      }
      assert.deepEqual(nativeState(), before, 'validation must not allocate native bytes');
      row.lastDescriptor = current.toWorkerData(); row.lastRevision = this.revision;
      row.retainedSnapshots = retained.length; row.completedCalls = this.completedCalls;
      row.keyCacheCount = a.keys.size; row.keyCacheBytes = a.keyBytes;
      row.targetCacheHitCount = keys.filter(key => a.keys.has(key)).length;
      return sha(JSON.stringify(e.mode === 'fresh' ? this.completedCalls ? freshModel : [] : models[this.revision]));
    } };
  f.validate(); row.completed = true;
  for (const id of [a.id, ...(dependency ? [dependency.id] : [])]) admitted.get(id).row.completed = true;
  row.setupNative = nativeState(); keepFixtures.push(f); checkpoint();
  return f;
}

function phase(f, calls, kind, timed = true) {
  assert.ok(Number.isSafeInteger(calls) && calls > 0);
  if (f.e.mode === 'fresh') { assert.equal(calls, 1); assert.equal(f.completedCalls, 0); }
  const cumulativeLimit = request.mode === 'calibrate' ? f.e.plannerTotalCalls
    : request.mode === 'measure' ? f.e.measurementCap * 1.5 : request.mode === 'fresh' ? 1 : config.smokeCalls;
  if (f.completedCalls + calls > cumulativeLimit) throw new Budget('cumulative-operation-cap');
  const addedBound = f.e.mode === 'fresh' ? f.e.freshPayloadBytes : calls * f.e.batchBytes;
  const before = nativeState(), maximum = admitted.get(f.a.id).row.maximumBytes;
  const projectedParentCapacity = Math.max(131072, Math.ceil((f.a.used + addedBound) / 65536) * 65536);
  if (projectedParentCapacity > maximum || before.backingBytes - f.a.memory.buffer.byteLength + projectedParentCapacity > config.nativeBackingCapBytes)
    throw new Budget('prospective-native-headroom');
  const boundaries = [...admitted.values()].map(({ a }) => ({ a, used: a.used, hash: prefix(a) }));
  const record = { endpoint: f.e.id, kind, calls, completed: false, validated: false, beforeNative: before,
    maximumAddedPayloadBytes: addedBound, completedCallsBefore: f.completedCalls };
  result.phases.push(record); checkpoint();
  const start = timed ? process.hrtime.bigint() : 0n;
  const checksum = f.run(calls);
  const elapsedNs = timed ? Number(process.hrtime.bigint() - start) : null;
  f.finish(calls);
  Object.assign(record, { completed: true, completedCalls: calls, checksum, elapsedNs });
  result.cumulativeCalls += calls; checkpoint();
  const expectedChecksum = f.e.mode === 'fresh' ? 5000 : 32 * calls + Math.floor((calls + 1 - (record.completedCallsBefore & 1)) / 2);
  assert.equal(checksum, expectedChecksum % 2 ** 32);
  const parentBefore = before.arenas.find(a => a.id === f.a.id).used;
  record.addedPayloadBytes = f.a.used - parentBefore;
  const minimumAdded = f.e.mode === 'fresh' ? 5000 * 16 : calls * (f.e.mode === 'primitive' ? 1152 : f.e.mode === 'nested'
    ? 32 * Math.min(...f.row.descriptorBytes.map(n => align4(20 + n))) : 1408);
  assert.ok(record.addedPayloadBytes >= minimumAdded && record.addedPayloadBytes <= addedBound);
  record.publishedPrefixChecks = boundaries.map(saved => {
    const afterSHA256 = prefix(saved.a, saved.used);
    assert.equal(afterSHA256, saved.hash, 'published native prefix changed');
    return { id: saved.a.id, used: saved.used, beforeSHA256: saved.hash, afterSHA256 };
  });
  record.logicalSHA256 = f.validate(); record.afterNative = nativeState(); record.validated = true;
  assert.equal(record.logicalSHA256, f.e.logicalSHA256ByRevision[f.e.mode === 'fresh' ? 1 : f.revision]);
  if (timed && (!Number.isFinite(elapsedNs) || elapsedNs <= 0)) throw new Budget('nonpositive-or-nonfinite-phase-duration');
  checkpoint(); return record;
}

try {
  S = await import(pathToFileURL(request.subject).href);
  owner = value => Object.getPrototypeOf(S.SharedMap).owner(value);
  if (request.mode === 'smoke') {
    assert.equal(request.endpoint, null);
    for (const e of config.endpoints) phase(fixture(e), e.mode === 'fresh' ? 1 : config.smokeCalls, 'smoke', false);
    assert.equal(result.admissions, config.smokeAdmissions); result.status = 'passed';
  } else {
    const f = fixture(endpoint); assert.equal(result.admissions, endpoint.admissions);
    if (request.mode === 'fresh') {
      assert.equal(endpoint.mode, 'fresh');
      result.measurement = phase(f, 1, 'fresh-import');
      result.freshDurationMeetsThroughputFloor = result.measurement.elapsedNs >= config.measurementMinimumNs;
      result.status = 'passed';
    } else if (request.mode === 'calibrate') {
      const warm = [], pilots = [];
      for (let i = 0; i < config.plannerWarmBatches; i++) warm.push(phase(f, endpoint.plannerWarmCalls, 'calibration-warmup'));
      result.calibrationWarmup = { batches: warm.length, elapsedNs: warm.reduce((n, row) => n + row.elapsedNs, 0), callsPerBatch: endpoint.plannerWarmCalls };
      for (let i = 0; i < config.pilotBatches; i++) pilots.push(phase(f, endpoint.plannerPilotCalls, 'pilot'));
      result.pilots = pilots;
      assert.equal(result.cumulativeCalls, endpoint.plannerTotalCalls);
      result.status = pilots.every(row => row.elapsedNs >= config.pilotMinimumNs) ? 'passed' : 'short';
      if (result.status === 'short') result.error = 'count-planning-pilot-duration-floor';
    } else {
      const calls = request.measurementCalls;
      assert.ok(Number.isSafeInteger(calls) && calls > 0 && calls <= endpoint.measurementCap && calls % config.countQuantum === 0);
      const warm = [];
      for (let i = 0; i < config.measurementWarmupBatches; i++) warm.push(phase(f, calls / config.measurementWarmupDivisor, 'measurement-warmup'));
      result.warmup = { calls: warm.reduce((n, row) => n + row.calls, 0), elapsedNs: warm.reduce((n, row) => n + row.elapsedNs, 0), batches: warm };
      result.measurement = phase(f, calls, 'measurement');
      result.status = result.warmup.elapsedNs >= config.measurementWarmupMinimumNs && result.measurement.elapsedNs >= config.measurementMinimumNs ? 'passed' : 'short';
      if (result.status === 'short') result.error = result.warmup.elapsedNs < config.measurementWarmupMinimumNs ? 'measurement-warmup-duration-floor' : 'measurement-duration-floor';
    }
  }
  result.finalNative = nativeState();
} catch (error) {
  result.status = error instanceof Budget ? 'budget-invalid' : 'failed'; result.error = String(error.stack ?? error);
}
checkpoint();
console.log(JSON.stringify({ status: result.status, outputSHA256: sha(readFileSync(outputPath)) }));
if (result.status === 'failed') process.exitCode = 1;
