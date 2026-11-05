import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { CASES, UPDATES, MAX_CHECKED_ELEMENTS, MAX_SHARED_BYTES } from './workloads.mjs';

// Saved-evidence verification only. No collection build is imported or timed.
// Production identities refer to archived measured sources, never every live
// root source: independent changes must remain free to combine with this proof.
const root = dirname(fileURLToPath(import.meta.url)), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ledger = JSON.parse(readFileSync(join(root, 'artifact-manifest.json'), 'utf8'));
assert.equal(ledger.schema, 'zerocopy-list-set-lookup-artifacts/v1');
assert.equal(ledger.decision, 'rejected; proof-only archive; no improvement PR');
assert.deepEqual(ledger.studies.map(study => study.path), ['results/pilot-01.json.gz', 'results/formal-01.json.gz']);
const near = (a, b, message) => assert.ok(Number.isFinite(a) && Number.isFinite(b)
  && Math.abs(a - b) <= Math.max(1e-11, Math.abs(b) * 1e-10), `${message}: ${a} != ${b}`);
const median = values => {
  const a = [...values].sort((x, y) => x - y), i = a.length >>> 1;
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
};
for (const [name, expected] of Object.entries(ledger.files)) {
  const bytes = readFileSync(join(root, name));
  assert.equal(bytes.length, expected.bytes, name); assert.equal(sha(bytes), expected.sha256, name);
}
const frozenConfig = { pilot: { pairs: 2, samples: 7, warmupMs: 150 }, formal: { pairs: 6, samples: 11, warmupMs: 500 },
  targetBatchMs: 20, minWarmupBatches: 8, maxWarmupBatches: 2048, maxCalibrationSteps: 12, childTimeoutMs: 300000,
  maxCheckedElements: MAX_CHECKED_ELEMENTS, maxSharedBytes: MAX_SHARED_BYTES, updatesPerOperation: UPDATES };
const coreAliases = ['doubly-linked-list.wasm', 'linked-list.wasm', 'ordered-map.wasm', 'persistent-core.wasm',
  'priority-queue.wasm', 'shared-list.wasm', 'shared-map.wasm', 'singly-linked-list.wasm', 'sorted-tree.wasm'];
const totals = { studies: 0, freshSubjects: 0, pairs: 0, measuredBatches: 0, checkedCalls: 0, checkedElements: 0, checkedSourceElements: 0 };
let pilot;
for (const artifact of ledger.studies) {
  const stored = readFileSync(join(root, artifact.path));
  assert.equal(stored.length, artifact.storedBytes); assert.equal(sha(stored), artifact.storedSha256);
  const bytes = artifact.path.endsWith('.gz') ? gunzipSync(stored) : stored;
  assert.equal(bytes.length, artifact.rawBytes); assert.equal(sha(bytes), artifact.rawSha256);
  const data = JSON.parse(bytes.toString('utf8'));
  assert.equal(data.schema, 'zerocopy-list-set-lookup/v1'); assert.equal(data.status, 'complete');
  assert.ok(['pilot', 'formal'].includes(data.phase)); assert.deepEqual(data.config, frozenConfig); assert.deepEqual(data.cases, CASES);
  assert.equal(data.phase, totals.studies === 0 ? 'pilot' : 'formal');
  assert.equal(data.source.baseline.commit, '77599337867dbf785a5f0311d34637d0b36678fc');
  assert.equal(data.hardware.affinity, '2');
  for (const [name, hash] of Object.entries(data.source.driver)) assert.equal(sha(readFileSync(join(root, name))), hash, name);
  assert.deepEqual(Object.keys(data.source.baseline.production), Object.keys(data.source.candidate.production));
  assert.deepEqual(Object.keys(data.source.baseline.production).filter(name => data.source.baseline.production[name] !== data.source.candidate.production[name]), ['persistent-core.as.ts']);
  assert.deepEqual(data.source.baseline.support, data.source.candidate.support);
  assert.deepEqual(Object.keys(data.source.baseline.wasm), Object.keys(data.source.candidate.wasm));
  assert.deepEqual(Object.keys(data.source.baseline.wasm).filter(name => data.source.baseline.wasm[name] !== data.source.candidate.wasm[name]), coreAliases);
  for (const side of ['baseline', 'candidate']) for (const name of coreAliases) assert.equal(data.source[side].wasm[name], data.source[side].wasm['persistent-core.wasm']);
  for (const [liveName, archiveName] of Object.entries(ledger.measuredSources)) {
    const hash = data.source.candidate.production[liveName] ?? data.source.candidate.tests[liveName];
    assert.equal(sha(readFileSync(join(root, archiveName))), hash, archiveName);
  }
  if (data.phase === 'pilot') pilot = { data, artifact };
  else {
    assert.ok(pilot, 'Verify the complete pilot before confirmation');
    assert.deepEqual(data.plans, pilot.data.plans); assert.deepEqual(data.source.driver, pilot.data.source.driver);
    for (const side of ['baseline', 'candidate']) for (const group of ['production', 'tests', 'support', 'wasm', 'bundles']) assert.deepEqual(data.source[side][group], pilot.data.source[side][group]);
    assert.equal(data.pilotFile.sha256, pilot.artifact.rawSha256);
  }
  const settings = data.config[data.phase], newSequences = [], allRows = [];
  assert.equal(data.plans.length, CASES.length * 2);
  function checkSubject(subject, spec, plan, candidate, phase, count) {
    assert.equal(subject.status, 'complete'); assert.equal(subject.name, spec.name); assert.equal(subject.phase, phase);
    assert.equal(subject.runtime, plan.runtime); assert.equal(subject.candidate, candidate);
    if (plan.runtime === 'node') assert.equal(subject.versions.node, '24.22.1');
    else assert.equal(subject.versions.bun, '1.4.2');
    assert.equal(subject.outputElements, spec.mode === 'get' ? UPDATES : spec.size); assert.equal(subject.updatesPerOperation, UPDATES);
    assert.equal(subject.expectedDigest, plan.expectedDigest); assert.equal(subject.sourceSha256, plan.sourceSha256);
    const prefix = (spec.size - 1) & ~31; let depth = 0;
    for (let capacity = 32; prefix > capacity; capacity *= 32) depth++;
    const nodeBytes = spec.mode === 'get' ? 0 : spec.index >= prefix ? (spec.size - prefix) * 8 : 256 + depth * 128;
    const blobBytes = spec.type === 'object' ? Math.ceil((4 + Buffer.byteLength(JSON.stringify({ i: spec.index, tag: '界🙂' }))) / 8) * 8 : 0;
    const worst = (nodeBytes + blobBytes) * (spec.mode === 'get' ? 0 : UPDATES);
    const maxRepeat = Math.max(1, Math.min(65536, Math.floor(MAX_CHECKED_ELEMENTS / subject.outputElements), worst ? Math.floor(MAX_SHARED_BYTES / worst) : 65536));
    assert.equal(subject.nodeBytes, nodeBytes); assert.equal(subject.blobBytes, blobBytes); assert.equal(subject.worstSharedBytesPerOperation, worst);
    assert.equal(subject.maxRepeat, maxRepeat); assert.equal(subject.capped, subject.repeat === maxRepeat);
    let calls = 0, elements = 0, sourceElements = 0;
    function batch(row, repeat) {
      assert.ok(Number.isInteger(row.repeat) && row.repeat >= 1 && row.repeat <= maxRepeat);
      if (repeat !== undefined) assert.equal(row.repeat, repeat);
      assert.ok(Number.isFinite(row.ms) && row.ms >= 0); assert.equal(row.verifiedCalls, row.repeat);
      assert.equal(row.verifiedElements, row.repeat * subject.outputElements); assert.equal(row.publicCalls, row.repeat * UPDATES);
      assert.equal(row.sourceVerifiedElements, spec.size * 2); assert.equal(row.sourceSha256, plan.sourceSha256);
      assert.ok(row.sourceUsed >= 65536 && row.sourceBufferBytes >= row.sourceUsed);
      assert.equal(row.sourceBytesUnchanged, true);
      const allocation = candidate && spec.mode === 'noop' && spec.index < prefix ? 0 : row.repeat * worst;
      assert.equal(row.allocatedBytes, allocation); assert.equal(row.expectedAllocatedBytes, allocation);
      assert.ok(row.finalBufferBytes >= row.sourceUsed + allocation);
      calls += row.verifiedCalls; elements += row.verifiedElements; sourceElements += row.sourceVerifiedElements;
    }
    batch(subject.initial, 1);
    assert.ok(subject.warmup.length >= 8 && subject.warmup.length <= 2048);
    for (const row of subject.warmup) batch(row, phase === 'measure' ? plan.repeat : undefined);
    near(subject.warmupMs, subject.warmup.reduce((sum, row) => sum + row.ms, 0), 'Warm-up elapsed');
    assert.ok(subject.warmupMs >= (phase === 'calibrate' ? 150 : settings.warmupMs));
    assert.equal(subject.warmupCalls, subject.warmup.reduce((sum, row) => sum + row.repeat, 0));
    if (phase === 'calibrate') {
      assert.equal(subject.samples.length, 0); assert.ok(subject.calibration.length >= 1 && subject.calibration.length <= 12);
      for (const step of subject.calibration) { assert.equal(step.trials.length, 3); for (const row of step.trials) batch(row, step.repeat); }
      assert.equal(subject.repeat, subject.calibration.at(-1).repeat);
      near(subject.minMsPerCall, Math.min(...subject.calibration.at(-1).trials.map(row => row.ms / row.repeat)), 'Calibration minimum');
    } else {
      assert.equal(subject.calibration.length, 0); assert.equal(subject.samples.length, settings.samples); assert.equal(subject.repeat, plan.repeat);
      for (const row of subject.samples) batch(row, plan.repeat);
      near(subject.medianMs, median(subject.samples.map(row => row.ms / row.repeat)), 'Process median');
      near(subject.minBatchMs, Math.min(...subject.samples.map(row => row.ms)), 'Minimum batch');
      assert.equal(subject.belowTargetBatches, subject.samples.filter(row => row.ms < 20).length);
    }
    assert.equal(subject.checkedCalls, calls); assert.equal(subject.checkedElements, elements); assert.equal(subject.checkedSourceElements, sourceElements);
    assert.equal(subject.allPublishedBytesVerified, true); assert.equal(subject.allAllocationDeltasVerified, true);
    if (count) {
      newSequences.push(subject.sequence); totals.freshSubjects++; totals.checkedCalls += calls; totals.checkedElements += elements;
      totals.checkedSourceElements += sourceElements; totals.measuredBatches += subject.samples.length;
    }
  }
  for (const runtime of ['node', 'bun']) for (const [index, spec] of CASES.entries()) {
    const plan = data.plans.find(row => row.runtime === runtime && row.name === spec.name); assert.ok(plan);
    assert.deepEqual(plan.order, index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']);
    for (const build of plan.order) checkSubject(plan.calibration[build], spec, plan, build === 'candidate', 'calibrate', data.phase === 'pilot');
    assert.equal(plan.repeat, Math.max(plan.calibration.baseline.repeat, plan.calibration.candidate.repeat));
  }
  const expectedOrder = ['node', 'bun'].flatMap(runtime => Array.from({ length: settings.pairs }, (_, pair) => {
    const start = pair % CASES.length;
    return [...CASES.slice(start), ...CASES.slice(0, start)].map(spec => ({ runtime, pair, name: spec.name }));
  }).flat());
  assert.equal(data.pairs.length, expectedOrder.length); assert.equal(data.summary.length, CASES.length * 2);
  for (const [index, pair] of data.pairs.entries()) {
    const { runtime, name, pair: number } = expectedOrder[index];
    assert.equal(pair.runtime, runtime); assert.equal(pair.name, name); assert.equal(pair.pair, number);
    assert.deepEqual(pair.order, number % 2 ? ['after', 'before'] : ['before', 'after']);
    const spec = CASES.find(row => row.name === name), plan = data.plans.find(row => row.runtime === runtime && row.name === name);
    for (const side of pair.order) checkSubject(pair[side], spec, plan, side === 'after', 'measure', true);
    totals.pairs++;
  }
  for (const runtime of ['node', 'bun']) for (const spec of CASES) {
    const pairs = data.pairs.filter(row => row.runtime === runtime && row.name === spec.name), logs = pairs.map(row => Math.log(row.after.medianMs / row.before.medianMs));
    assert.equal(pairs.length, settings.pairs);
    const row = data.summary.find(row => row.runtime === runtime && row.name === spec.name), mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
    assert.ok(row); assert.equal(row.pairs, settings.pairs);
    near(row.beforeMedianMs, median(pairs.map(row => row.before.medianMs)), 'Before marginal median');
    near(row.afterMedianMs, median(pairs.map(row => row.after.medianMs)), 'After marginal median');
    near(row.ratio, Math.exp(mean), 'Paired geometric ratio'); assert.equal(row.pairRatios.length, pairs.length);
    for (const [index, value] of logs.entries()) near(row.pairRatios[index], Math.exp(value), 'Pair ratio');
    near(row.minRatio, Math.exp(Math.min(...logs)), 'Minimum pair ratio'); near(row.maxRatio, Math.exp(Math.max(...logs)), 'Maximum pair ratio');
    if (data.phase === 'formal') {
      const half = 2.570581835636314 * Math.sqrt(logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 5 / 6);
      near(row.lower95, Math.exp(mean - half), 'Lower interval'); near(row.upper95, Math.exp(mean + half), 'Upper interval'); assert.equal(row.degreesOfFreedom, 5);
    } else assert.equal(row.lower95, undefined);
    allRows.push({ runtime, name: spec.name, ratio: row.ratio });
  }
  assert.deepEqual([...newSequences].sort((a, b) => a - b), Array.from({ length: newSequences.length }, (_, i) => i));
  totals.studies++;
  console.log(JSON.stringify({ path: artifact.path, rawSha256: artifact.rawSha256, phase: data.phase, status: 'verified',
    freshSubjects: newSequences.length, summaryRows: allRows.length, pairs: data.pairs.length }));
}
assert.equal(totals.studies, 2); assert.equal(totals.pairs, 160); assert.equal(totals.measuredBatches, 3200);
console.log(JSON.stringify({ status: 'passed', immutableFiles: Object.keys(ledger.files).length, ...totals }));
