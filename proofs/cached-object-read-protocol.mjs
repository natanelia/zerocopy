import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const PINS = Object.freeze({
  baseline: '3773c6e519c7c0958da13727ed1082f449f3ee25',
  candidate: 'e249dd4148211dfec0e439ea5988af041c446e94',
  correctness: '8b224ead5f275358dbd4081a5795e6c0fd7e76c1',
  correctnessRun: 37863609752,
});
export const SETTINGS = Object.freeze({
  schema: 1, node: '22.23.3', bun: '1.4.2', arch: 'x64',
  quartets: 4, samples: 21, pilotTargetMs: 40, warmTargetMs: 500,
  sampleFloorMs: 10, warmFloorMs: 150, margin: 1.02,
  substantialUpper: 0.90, t975df3: 3.182446305284263,
  maxSweeps: 16777216,
});
export const CASES = Object.freeze([
  { id: 'map-object-512', kind: 'map', codec: 'object', size: 512, target: true },
  { id: 'ordered-object-512', kind: 'ordered', codec: 'object', size: 512, target: true },
  { id: 'sorted-object-512', kind: 'sorted', codec: 'object', size: 512, target: true },
  { id: 'map-nested-512', kind: 'map', codec: 'nested', size: 512, target: true },
  { id: 'map-object-1', kind: 'map', codec: 'object', size: 1, target: false },
  { id: 'map-unadmitted-address-object-512', kind: 'map', codec: 'object', size: 1024, addressSaturated: true, target: false },
  { id: 'map-number-512', kind: 'map', codec: 'number', size: 512, target: false },
  { id: 'map-string-512', kind: 'map', codec: 'string', size: 512, target: false },
  { id: 'sorted-number-512', kind: 'sorted', codec: 'number', size: 512, target: false },
  { id: 'map-alternating-roots-object-512', kind: 'map', codec: 'object', size: 512, alternate: true, target: false },
  { id: 'map-unknown-missing-object-512', kind: 'map', codec: 'object', size: 512, missing: true, target: false },
  { id: 'map-object-cache-saturated-tail-512', kind: 'map', codec: 'object', size: 2560, saturated: true, target: false },
].map(Object.freeze));

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonHash = data => hash(JSON.stringify(data));
export const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
export function median(xs) {
  assert.equal(xs.length, SETTINGS.samples, 'all 21 samples required');
  assert.ok(xs.every(x => Number.isFinite(x) && x > 0));
  return [...xs].sort((a, b) => a - b)[10];
}
export function workload(id) {
  const found = CASES.find(c => c.id === id);
  assert.ok(found, 'unknown workload: ' + id);
  return found;
}
export function positiveCount(n) {
  assert.ok(Number.isSafeInteger(n) && n > 0 && n <= SETTINGS.maxSweeps, 'invalid fixed work');
  return n;
}
// Fixed seed and algorithms are frozen with the harness before seeing timings.
export const SCHEDULE_SEED = 0x6b3a912d;
function random(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
function shuffled(items, next) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
// Analysis labels never enter a subject's input. Each quartet stays contiguous.
export function campaign() {
  const next = random(SCHEDULE_SEED), result = [];
  const cells = ['node', 'bun'].flatMap(runtime => CASES.map(spec => ({ runtime, workload: spec.id })));
  const orientations = new Map();
  for (const cell of cells) for (const group of ['ab', 'baseline-aa', 'candidate-aa']) {
    orientations.set(cell.runtime + '/' + cell.workload + '/' + group, shuffled(['ABBA', 'ABBA', 'BAAB', 'BAAB'], next));
  }
  for (let q = 0; q < SETTINGS.quartets; q++) {
    for (const cell of shuffled(cells, next)) {
      for (const group of shuffled(['ab', 'baseline-aa', 'candidate-aa'], next)) {
        const labels = orientations.get(cell.runtime + '/' + cell.workload + '/' + group)[q];
        for (let position = 0; position < 4; position++) {
          const label = labels[position];
          const role = group === 'ab' ? (label === 'A' ? 'baseline' : 'candidate')
            : (group === 'baseline-aa' ? 'baseline' : 'candidate');
          result.push({ ...cell, group, quartet: q, position, label, role });
        }
      }
    }
  }
  assert.equal(result.length, CASES.length * 2 * 48, '48 subjects for every runtime/workload cell');
  return result;
}
export function schedule(runtime, id) {
  return campaign().filter(c => c.runtime === runtime && c.workload === id);
}
export function chooseWork(pilots) {
  assert.equal(pilots.length, 2, 'one pilot per source role');
  let sweeps = 1, warmSweeps = 1;
  for (const p of pilots) {
    assert.equal(p.phase, 'pilot');
    const last = p.pilot.at(-1);
    assert.ok(last.ms >= SETTINGS.pilotTargetMs);
    positiveCount(last.sweeps);
    sweeps = Math.max(sweeps, last.sweeps);
    warmSweeps = Math.max(warmSweeps, Math.ceil(last.sweeps * SETTINGS.warmTargetMs / last.ms));
  }
  positiveCount(sweeps); positiveCount(warmSweeps);
  return Object.freeze({ sweeps, warmSweeps });
}
export function verifySubject(record, expected) {
  assert.equal(record.schema, SETTINGS.schema);
  assert.equal(record.workload, expected.workload);
  assert.equal(record.runtime.name, expected.runtime);
  assert.equal(record.runtime.version, SETTINGS[expected.runtime]);
  assert.equal(record.runtime.arch, SETTINGS.arch);
  assert.equal(record.packageDigest, expected.packageDigest);
  assert.equal(record.phase, expected.phase);
  assert.equal(record.fixtureDigest, jsonHash(record.fixture));
  assert.equal(record.postFixtureDigest, record.fixtureDigest, 'published fixture mutated');
  assert.ok(Number.isSafeInteger(record.opsPerSweep) && record.opsPerSweep > 0);
  assert.ok(Number.isSafeInteger(record.expectedPerSweep) && record.expectedPerSweep > 0);
  const check = sample => {
    positiveCount(sample.sweeps);
    assert.equal(sample.sink, record.expectedPerSweep * sample.sweeps, 'sink/all same work');
    assert.ok(Number.isSafeInteger(sample.sink));
    assert.ok(Number.isFinite(sample.ms) && sample.ms > 0);
  };
  if (record.phase === 'measure') {
    assert.equal(record.sweeps, expected.sweeps);
    assert.equal(record.warm.sweeps, expected.warmSweeps);
    assert.equal(record.samples.length, SETTINGS.samples);
    check(record.warm);
    assert.ok(record.warm.ms >= SETTINGS.warmFloorMs, 'warm-up below 150 ms: invalid, do not rerun');
    for (const sample of record.samples) {
      check(sample); assert.equal(sample.sweeps, expected.sweeps);
      assert.ok(sample.ms >= SETTINGS.sampleFloorMs, 'sample below 10 ms: invalid, do not exclude');
    }
  } else if (record.phase === 'pilot') {
    assert.ok(record.pilot.length > 0);
    record.pilot.forEach(check);
  } else {
    assert.equal(record.phase, 'check');
    assert.equal(record.checkSink, record.expectedPerSweep);
  }
  return record;
}
export function sameWork(a, b) {
  assert.deepEqual(a.fixture, b.fixture, 'descriptor, arena bytes, IDs, keys and public outputs must match');
  assert.equal(a.fixtureDigest, b.fixtureDigest);
  assert.equal(a.opsPerSweep, b.opsPerSweep);
  assert.equal(a.expectedPerSweep, b.expectedPerSweep);
}
export function interval(logRatios) {
  assert.equal(logRatios.length, SETTINGS.quartets, 'four independent quartets required');
  assert.ok(logRatios.every(Number.isFinite));
  const center = mean(logRatios);
  const variance = logRatios.reduce((sum, x) => sum + (x - center) ** 2, 0) / 3;
  const half = SETTINGS.t975df3 * Math.sqrt(variance / 4);
  return { ratio: Math.exp(center), lower: Math.exp(center - half), upper: Math.exp(center + half),
    logRatios, df: 3, confidence: 0.95, method: 'Student t of four quartet log ratios' };
}
export function summarizeCell(records) {
  assert.equal(records.length, 48);
  const expected = schedule(records[0].runtime, records[0].workload);
  for (let i = 0; i < expected.length; i++) {
    for (const key of Object.keys(expected[i])) assert.equal(records[i][key], expected[i][key], 'complete immutable schedule');
    sameWork(records[0].result, records[i].result);
  }
  const groups = {};
  for (const group of ['ab', 'baseline-aa', 'candidate-aa']) {
    const logs = [];
    for (let q = 0; q < 4; q++) {
      const quartet = records.filter(r => r.group === group && r.quartet === q);
      assert.equal(quartet.length, 4);
      const values = label => quartet.filter(r => r.label === label)
        .map(r => Math.log(median(r.result.samples.map(s => s.ms))));
      logs.push(mean(values('B')) - mean(values('A')));
    }
    groups[group] = interval(logs);
  }
  const aa = [groups['baseline-aa'], groups['candidate-aa']];
  return { ...groups,
    aaEquivalent: aa.every(x => x.lower >= 1 / SETTINGS.margin && x.upper <= SETTINGS.margin),
    aaAdverse: aa.some(x => (x.ratio < 1 / SETTINGS.margin || x.ratio > SETTINGS.margin) && (x.lower > 1 || x.upper < 1)),
    abClear: groups.ab.upper <= SETTINGS.margin,
    abAdverse: groups.ab.lower > SETTINGS.margin,
    substantial: groups.ab.upper <= SETTINGS.substantialUpper,
  };
}
export function decide(cells) {
  assert.equal(cells.length, CASES.length * 2);
  assert.deepEqual(cells.map(c => c.runtime + '/' + c.workload).sort(),
    ['node', 'bun'].flatMap(runtime => CASES.map(c => runtime + '/' + c.id)).sort());
  const strongClear = cells.every(c => c.summary.abClear && !c.summary.aaAdverse);
  const aaEquivalenceClear = strongClear && cells.every(c => c.summary.aaEquivalent);
  const anyAdverse = cells.some(c => c.summary.abAdverse || c.summary.aaAdverse);
  const targets = cells.filter(c => workload(c.workload).target);
  const scopedGains = anyAdverse ? [] : targets.filter(c => c.summary.substantial)
    .map(c => c.runtime + '/' + c.workload);
  const allPrimaryTargetsSubstantial = !anyAdverse && targets.every(c => c.summary.substantial);
  return { strongClear, aaEquivalenceClear, anyAdverse, scopedGains, allPrimaryTargetsSubstantial,
    verdict: anyAdverse ? 'adverse-or-drift' : strongClear ? 'strong-clear' : scopedGains.length ? 'scoped-gains-controls-uncertain' : 'inconclusive',
    multiplicity: 'pointwise 95% intervals; predeclared primary family is all eight target cells; selected scoped subsets are exploratory',
    noReruns: true, noExclusions: true, noAaNormalization: true };
}
