import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(readFileSync(new URL('./CONFIG.json', import.meta.url), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
class Budget extends Error {}
const [flag, requestPath, outputPath] = process.argv.slice(2);
assert.equal(flag, '--request'); assert.ok(requestPath && outputPath);
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
assert.ok(['smoke', 'calibrate', 'measure', 'cold'].includes(request.mode));
assert.ok(config.engines.includes(request.engine) && config.arms.includes(request.arm));
assert.equal(config.operationCap, 2 ** 27); assert.equal(config.primitiveMeasurementOperationCap, 2 ** 29);
const requestEndpoint = config.endpoints.find(e => e.id === request.endpoint);
if (request.mode === 'measure') {
  assert.ok(requestEndpoint && requestEndpoint.mode !== 'cold');
  assert.equal(request.measurementOperationCap, requestEndpoint.mode === 'primitive' ? config.primitiveMeasurementOperationCap : config.operationCap);
} else assert.equal(request.measurementOperationCap, undefined);
const result = { schema: 1, kind: 'redux-classifier-timing-observation', status: 'running', mode: request.mode,
  engine: request.engine, arm: request.arm, endpoint: request.endpoint ?? null,
  measurementOperationCap: request.measurementOperationCap ?? null, cumulativeCallsScope: 'phase-loop operations only',
  admissions: 0, sumConfiguredLinearMemoryMaxima: 0, ledger: [], fixtures: [], phases: [], cumulativeCalls: 0 };
const checkpoint = () => writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
checkpoint();
const admitted = new Map();
let S, R, owner;
function makeFixture(e) {
  let run, validate, unit, fingerprint, snapshots = [];
  if (e.mode === 'stringify') {
    let selected = new S.SharedMap('number'), pending = new S.SharedPriorityQueue('number');
    for (const n of [3, 1, 2]) { selected = selected.set(String(n), n); pending = pending.enqueue(n, n); }
    assert.equal(selected.size, 3); assert.equal(pending.size, 3); assert.equal(pending.isMaxHeap, false);
    const rows = Object.freeze(Array.from({ length: 32 }, (_, i) => Object.freeze({ id: i, label: 'item' + i, active: i % 2 === 0 })));
    const state = Object.freeze({ rows, selected, pending });
    // Independent literal format model: HAMT low digits for keys 3,2,1 are 2,5,12;
    // inserting priorities 3,1,2 produces BFS root 1, left 3, right 2.
    const envelope = { $zerocopyRedux: 1, value: ['o', [
      ['rows', ['a', Array.from({ length: 32 }, (_, i) => ['o', [['id', i], ['label', 'item' + i], ['active', i % 2 === 0]]])]],
      ['selected', ['c', 'SharedMap', 'number', null, [['3', 3], ['2', 2], ['1', 1]]]],
      ['pending', ['c', 'SharedPriorityQueue', 'number', false, [[1, 1, 1, 2], [3, 3, -1, -1], [2, 2, -1, -1]]]],
    ]] };
    const expectedText = JSON.stringify(envelope), codec = R.createZerocopyCodec();
    let lastText;
    const consume = text => text.length + text.charCodeAt(0) + text.charCodeAt(text.length >>> 1) + text.charCodeAt(text.length - 1);
    unit = consume(expectedText);
    run = () => { lastText = codec.stringify(state); return consume(lastText); };
    validate = () => {
      assert.ok(Object.isFrozen(state) && Object.isFrozen(rows) && rows.every(Object.isFrozen));
      assert.equal(codec.stringify(state), expectedText);
      if (lastText !== undefined) assert.equal(lastText, expectedText);
    };
    snapshots = [selected, pending];
    fingerprint = { endpoint: e.id, envelope, expectedTextSHA256: sha(expectedText), outputLength: expectedText.length, unit };
  } else if (e.mode.startsWith('selector-')) {
    const map = new S.SharedMap('object').set('x', { nested: { n: 1 } });
    const next = e.mode === 'selector-changing' ? map.set('other', { n: 2 }) : map;
    const states = [{ map, key: 'x' }, { map: next, key: 'x' }];
    const select = R.createSharedMapEntrySelector(state => state.map, state => state.key);
    const first = select(states[0]); let lastValue;
    assert.deepEqual(first, { nested: { n: 1 } });
    if (e.mode === 'selector-changing') assert.notEqual(map.root, next.root);
    run = i => { lastValue = select(states[e.mode === 'selector-changing' ? i & 1 : 0]); return lastValue.nested.n; };
    validate = () => {
      assert.equal(select(states[0]), first); assert.equal(select(states[1]), first);
      if (lastValue !== undefined) assert.equal(lastValue, first);
      assert.deepEqual(first, { nested: { n: 1 } });
    };
    snapshots = e.mode === 'selector-changing' ? [map, next] : [map]; unit = 1;
    fingerprint = { endpoint: e.id, selected: { nested: { n: 1 } }, sizes: snapshots.map(x => x.size), rootsDiffer: map.root !== next.root, unit };
  } else {
    assert.ok(['primitive', 'unfrozen'].includes(e.mode));
    const values = e.mode === 'primitive' ? [null, undefined, false, true, 0, 1, '', 'x'] : Array.from({ length: 8 }, (_, i) => ({ a: i }));
    run = i => Number(R.isZerocopySerializable(values[i & 7]));
    validate = () => {
      assert.ok(values.every(value => R.isZerocopySerializable(value)));
      if (e.mode === 'unfrozen') assert.ok(values.every(value => !Object.isFrozen(value)));
    };
    unit = 1; fingerprint = { endpoint: e.id, values: e.mode === 'primitive' ? ['null', 'undefined', false, true, 0, 1, '', 'x'] : values, unit };
  }
  validate();
  const arenas = [...new Set(snapshots.map(owner))];
  assert.equal(arenas.length, e.admissions);
  for (const a of arenas) if (!admitted.has(a)) {
    assert.ok(admitted.size < config.smokeAdmissions);
    admitted.set(a, admitted.size);
    result.ledger.push({ admission: ++result.admissions, id: a.id, maximumBytes: config.arenaMaximumBytes, completed: true });
    result.sumConfiguredLinearMemoryMaxima += config.arenaMaximumBytes;
  }
  assert.equal(new Set([...admitted.keys()].map(a => a.id)).size, admitted.size, 'unique native arena identities');
  const guards = arenas.map(a => ({ a, id: a.id, used: a.used, capacity: a.memory.buffer.byteLength, prefix: Buffer.from(a.buf.slice(65536, a.used)) }));
  const descriptors = snapshots.map(value => value.toWorkerData());
  const guard = () => {
    for (const g of guards) {
      assert.equal(g.a.id, g.id); assert.equal(g.a.used, g.used); assert.equal(g.a.memory.buffer.byteLength, g.capacity);
      assert.ok(g.capacity <= config.arenaMaximumBytes);
      assert.deepEqual(Buffer.from(g.a.buf.subarray(65536, g.used)), g.prefix);
    }
    assert.deepEqual(snapshots.map(value => value.toWorkerData()), descriptors);
  };
  guard();
  const record = { endpoint: e.id, completed: true, unit, semanticSHA256: sha(JSON.stringify(fingerprint)), fingerprint,
    descriptors, arenas: guards.map(g => ({ admission: admitted.get(g.a) + 1, id: g.id, used: g.used, capacity: g.capacity, prefixSHA256: sha(g.prefix) })) };
  result.fixtures.push(record); checkpoint();
  return { run, validate, guard, unit, record };
}
function phase(f, calls, kind, timed = true) {
  const operationCap = request.mode === 'measure' ? request.measurementOperationCap : config.operationCap;
  assert.ok(Number.isSafeInteger(calls) && calls > 0 && calls <= operationCap);
  if (request.mode === 'calibrate' && result.cumulativeCalls + calls > config.calibrationCumulativeCap) throw new Budget('calibration-cumulative-operation-cap');
  f.validate(); f.guard();
  const record = { kind, calls, completed: false, endpoint: f.record.endpoint }; result.phases.push(record); checkpoint();
  let checksum = 0, completedCalls = 0;
  const start = timed ? process.hrtime.bigint() : 0n;
  for (let i = 0; i < calls; i++) { checksum = (checksum + f.run(i)) >>> 0; completedCalls++; }
  const elapsedNs = timed ? Number(process.hrtime.bigint() - start) : null;
  Object.assign(record, { elapsedNs, checksum, completedCalls, completed: true }); result.cumulativeCalls += calls; checkpoint();
  assert.equal(completedCalls, calls); assert.equal(checksum, Number((BigInt(f.unit) * BigInt(calls)) & 0xffffffffn));
  f.validate(); f.guard(); record.validated = true; checkpoint();
  if (timed && (!Number.isFinite(elapsedNs) || elapsedNs <= 0)) throw new Budget('nonpositive-or-nonfinite-phase-duration');
  return record;
}
try {
  if (request.mode === 'cold') {
    assert.equal(request.endpoint, 'public-entry-import');
    const row = { kind: 'cold-import', calls: 1, completed: false }; result.phases.push(row); checkpoint();
    const url = pathToFileURL(request.subject).href;
    const start = process.hrtime.bigint();
    const imported = await import(url);
    const elapsedNs = Number(process.hrtime.bigint() - start);
    Object.assign(row, { elapsedNs, completed: true, completedCalls: 1 }); checkpoint();
    for (const name of ['createZerocopyCodec', 'createSharedMapEntrySelector', 'isZerocopySerializable']) assert.equal(typeof imported[name], 'function');
    if (!Number.isFinite(elapsedNs) || elapsedNs <= 0) throw new Budget('nonpositive-or-nonfinite-import-duration');
    row.validated = true; result.measurement = row; result.cumulativeCalls = 1; result.status = 'passed';
  } else {
    ({ S, R } = await import(pathToFileURL(request.subject).href));
    owner = value => Object.getPrototypeOf(S.SharedMap).owner(value);
    S.configureMemory({ maximumBytes: config.arenaMaximumBytes });
    if (request.mode === 'smoke') {
      assert.equal(request.endpoint, null);
      for (const e of config.endpoints.filter(e => e.mode !== 'cold')) phase(makeFixture(e), config.smokeCalls, 'smoke', false);
      assert.equal(result.admissions, config.smokeAdmissions); result.status = 'passed';
    } else {
      const e = config.endpoints.find(e => e.id === request.endpoint); assert.ok(e && e.mode !== 'cold');
      const f = makeFixture(e); assert.equal(result.admissions, e.admissions);
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
            if (!(fastest > 0)) throw new Budget('timer-resolution');
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
      } else {
        const calls = request.measurementCalls;
        assert.ok(Number.isSafeInteger(calls) && calls > 0 && calls <= request.measurementOperationCap && calls % config.countQuantum === 0);
        const warm = [];
        for (let i = 0; i < config.measurementWarmupBatches; i++) warm.push(phase(f, calls / config.measurementWarmupDivisor, 'measurement-warmup'));
        result.warmup = { calls: warm.reduce((n, row) => n + row.calls, 0), elapsedNs: warm.reduce((n, row) => n + row.elapsedNs, 0), batches: warm };
        result.measurement = phase(f, calls, 'measurement');
        result.status = result.warmup.elapsedNs >= config.measurementWarmupMinimumNs && result.measurement.elapsedNs >= config.measurementMinimumNs ? 'passed' : 'short';
        if (result.status === 'short') result.error = result.warmup.elapsedNs < config.measurementWarmupMinimumNs ? 'measurement-warmup-duration-floor' : 'measurement-duration-floor';
      }
    }
  }
} catch (error) {
  result.status = error instanceof Budget ? 'budget-invalid' : 'failed'; result.error = String(error.stack ?? error);
}
checkpoint();
console.log(JSON.stringify({ status: result.status, outputSHA256: sha(readFileSync(outputPath)) }));
if (result.status === 'failed') process.exitCode = 1;
