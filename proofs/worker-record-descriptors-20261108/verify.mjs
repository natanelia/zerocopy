// Verify the saved study without executing either library or taking new timings.
// Usage: node proofs/worker-record-descriptors-20261108/verify.mjs [--check-source]
// The optional source check needs Git history and checks the current implementation;
// the default checks historical evidence even after production source has changed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const folder = dirname(fileURLToPath(import.meta.url));
const repo = resolve(folder, '../..');
const baselineCommit = '0ac8a005268335a6116f025e75f670b5cee6843e';
const implementationCommit = '93fcd53609e8b290028fcbe2a00ac754908dce85';
const sourceDigest = {
  baseline: '21868d3b9b0d2479837b733f342a2980adbe2dadee0ea7692a27611be73085d2',
  candidate: 'c5941cc9ba08dfc84cb1771e51c7fddb8fed9204f7df407611e9210d102d7222',
};
const workloadDigest = 'aecaf4add27b726bc9c59e6ce2d2da7cb315b80621f158eaeb460c61a0b181bb';
const runnerDigests = {
  pilot: 'b3ffa6c2ecd41556da8181d7a10458e95ce551750e42b31f1d637bdf2947da6c',
  final: '0d786ccc6d3b70d81bc10c42eb679c99fcc6fde6dac2b5fac8b9a1a815c12623',
};
const cases = [
  { name: 'create-distinct-1024', operation: 'create', fields: 1024, alias: false },
  { name: 'publish-distinct-1024', operation: 'publish', fields: 1024, alias: false },
  { name: 'create-alias-1024', operation: 'create', fields: 1024, alias: true },
  { name: 'publish-alias-noop-1024', operation: 'noop', fields: 1024, alias: true },
  { name: 'create-distinct-32', operation: 'create', fields: 32, alias: false },
  { name: 'publish-distinct-1', operation: 'publish', fields: 1, alias: false },
  { name: 'create-record-1', operation: 'create', fields: 1, alias: false },
  { name: 'create-single-snapshot', operation: 'create', fields: 1, alias: false, single: true },
];
const studies = [
  { stem: 'pilot-v1', pilot: true, pairs: 2, warmMs: 200, cases,
    processes: 8, batches: 576,
    digest: '6b4f8874c7ad516cce5e187f5d7cb59817088fa9b21557bbaf8ddeb3bd4fdd91' },
  { stem: 'formal-v2', pairs: 6, warmMs: 500, cases,
    processes: 192, batches: 1728,
    digest: 'fd2ff6a09a0121a6ecfc76f3c896c582e9788c11ac7a69927a724d3607c6a2dd' },
  { stem: 'aa-v2', aa: true, pairs: 4, warmMs: 500, cases: [cases[0], cases[7]],
    processes: 32, batches: 288,
    digest: '84b575ac842ed93739d3dcc1b271b572ec46df89bb7b198d2d6a8c27ec220755' },
];
const flags = new Set(process.argv.slice(2));
assert.ok([...flags].every(flag => flag === '--check-source'), 'Only --check-source is supported');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = name => sha256(readFileSync(resolve(folder, name)));
const median = values => {
  const ordered = [...values].sort((a, b) => a - b), half = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[half] : (ordered[half - 1] + ordered[half]) / 2;
};
const sum = values => values.reduce((total, value) => total + value, 0);
const range = values => [Math.min(...values), Math.max(...values)];
const positive = (value, label) => assert.ok(Number.isFinite(value) && value > 0, `${label}: positive finite number`);
const close = (actual, expected, label) => {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected), `${label}: finite numbers`);
  assert.ok(Math.abs(actual - expected) <= 1e-15 + Math.abs(expected) * 1e-12,
    `${label}: ${actual} differs from recomputed ${expected}`);
};
const timestamp = value => {
  const ms = Date.parse(value);
  assert.ok(Number.isFinite(ms) && new Date(ms).toISOString() === value, `Invalid timestamp: ${value}`);
  return ms;
};

function readArchive(stem) {
  const names = [`${stem}.json`, `${stem}.json.gz`].filter(name => existsSync(resolve(folder, name)));
  assert.ok(names.length, `Missing ${stem}.json or ${stem}.json.gz`);
  const decoded = names.map(name => {
    const bytes = readFileSync(resolve(folder, name));
    return name.endsWith('.gz') ? gunzipSync(bytes) : bytes;
  });
  for (const bytes of decoded) assert.deepEqual(bytes, decoded[0], `Conflicting copies of ${stem}`);
  return { files: names, digest: sha256(decoded[0]), data: JSON.parse(decoded[0].toString('utf8')) };
}

function checkHashMap(value, size, label) {
  assert.equal(Object.keys(value).length, size, `${label}: file count`);
  assert.deepEqual(Object.keys(value), Object.keys(value).sort(), `${label}: sorted paths`);
  for (const digest of Object.values(value)) assert.match(digest, /^[0-9a-f]{64}$/, label);
}

assert.equal(hashFile('pilot-runner-v1.mjs'), runnerDigests.pilot, 'Preserved pilot runner');
assert.equal(hashFile('benchmark.mjs'), runnerDigests.final, 'Final measured runner');
assert.equal(hashFile('pilot-workloads-v1.mjs'), workloadDigest, 'Preserved pilot workload');
assert.equal(hashFile('workloads.mjs'), workloadDigest, 'Final measured workload');

const loaded = studies.map(study => {
  const archive = readArchive(study.stem);
  assert.equal(archive.digest, study.digest, `${study.stem}: original decompressed bytes`);
  assert.deepEqual(readArchive(`${study.stem}-summary`).data, archive.data.summary,
    `${study.stem}: summary sidecar`);
  return { ...study, ...archive };
});
const formal = loaded[1].data.metadata;
const runtimeInfo = new Map();
let hardware, previousStudyEnd = -Infinity;
const reports = [];

for (const study of loaded) {
  const { metadata: m, records, summary, end } = study.data;
  const names = study.cases.map(spec => spec.name);
  const runtimes = [...new Set(records.map(record => record.runtime))];
  assert.equal(runtimes.length, 2, `${study.stem}: Node and Bun`);
  assert.deepEqual(runtimes, [...new Set(loaded[0].data.records.map(record => record.runtime))]);
  assert.equal(m.pairs, study.pairs);
  assert.equal(m.warmMs, study.warmMs);
  assert.equal(m.samples, 9);
  assert.equal(m.affinity, '2');
  assert.equal(m.baselineCommit, baselineCommit);
  // The pilot measured the same implementation before it was committed.
  assert.equal(m.candidateCommit, study.pilot || study.aa ? baselineCommit : implementationCommit);
  assert.equal(m.schema, study.pilot ? undefined : 'zerocopy-worker-record-descriptors/v2');
  assert.deepEqual(m.cases, study.pilot ? undefined : names);
  assert.equal(m.baseline === m.candidate, Boolean(study.aa));
  assert.deepEqual(m.harnessHashes, { runner: runnerDigests[study.pilot ? 'pilot' : 'final'], workloads: workloadDigest });
  for (const role of ['baseline', 'candidate']) {
    checkHashMap(m[`${role}Sources`], 75, `${study.stem} ${role} sources`);
    checkHashMap(m[`${role}Build`], 12, `${study.stem} ${role} bundles`);
    const expectedRole = study.aa ? 'baseline' : role;
    assert.deepEqual(m[`${role}Sources`], formal[`${expectedRole}Sources`], `${study.stem}: source identity`);
    assert.deepEqual(m[`${role}Build`], formal[`${expectedRole}Build`], `${study.stem}: build identity`);
    assert.equal(sha256(m[`${role}Source`]), sourceDigest[expectedRole], `${study.stem}: embedded source`);
    assert.equal(m[`${role}Sources`]['worker-protocol.ts'], sourceDigest[expectedRole]);
  }
  assert.deepEqual(Object.keys(m.baselineSources), Object.keys(m.candidateSources));
  assert.deepEqual(Object.keys(m.baselineSources).filter(name => m.baselineSources[name] !== m.candidateSources[name]),
    study.aa ? [] : ['worker-protocol.ts'], `${study.stem}: only intended source changed, including unchanged WASM`);

  const startMs = timestamp(m.start), endMs = timestamp(end);
  assert.ok(startMs >= previousStudyEnd && endMs >= startMs, `${study.stem}: study chronology`);
  previousStudyEnd = endMs;
  const expectedOrder = [];
  if (study.pilot) {
    for (const runtime of runtimes) for (let pair = 0; pair < study.pairs; pair++) {
      const caseNames = [...names.slice(pair % names.length), ...names.slice(0, pair % names.length)];
      for (const role of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
        expectedOrder.push({ runtime, pair, role, caseNames });
    }
  } else {
    for (let pair = 0; pair < study.pairs; pair++) {
      for (const runtime of pair % 2 ? [...runtimes].reverse() : runtimes)
        for (const name of pair % 2 ? [...names].reverse() : names) {
          const candidateFirst = (pair + runtimes.indexOf(runtime) + names.indexOf(name)) % 2;
          for (const role of candidateFirst ? ['candidate', 'baseline'] : ['baseline', 'candidate'])
            expectedOrder.push({ runtime, pair, role, case: name, caseNames: [name] });
        }
    }
  }
  assert.equal(records.length, study.processes, `${study.stem}: process count`);
  assert.equal(expectedOrder.length, study.processes);
  let previousChildEnd = startMs, batches = 0;
  const observations = new Map();
  for (const [index, record] of records.entries()) {
    const expected = expectedOrder[index], child = record.result;
    const { runtime, pair, role, case: caseName } = record;
    assert.deepEqual({ runtime, pair, role, case: caseName }, {
      runtime: expected.runtime, pair: expected.pair, role: expected.role, case: expected.case,
    }, `${study.stem}: full process order at ${index}`);
    assert.deepEqual(child.results.map(result => result.name), expected.caseNames, `${study.stem}: case order at ${index}`);
    assert.deepEqual(child.hashes, m[`${role}Build`], `${study.stem}: child imported the expected build`);
    assert.equal(child.affinity, m.affinity);
    const identity = { runtime: child.runtime, bun: child.bun, versions: child.versions, execPath: child.execPath };
    if (!runtimeInfo.has(runtime)) runtimeInfo.set(runtime, identity);
    assert.deepEqual(identity, runtimeInfo.get(runtime), 'Runtime identity is consistent across all studies and arms');
    assert.equal(child.runtime, `v${child.versions.node}`);
    assert.equal(child.bun, runtimes.indexOf(runtime) === 0 ? null : '1.4.2');
    assert.equal(child.versions.node, child.bun ? '26.3.0' : '24.22.1');
    if (child.bun) assert.equal(child.versions.bun, child.bun);
    const machine = { cpu: child.cpu, platform: child.platform, arch: child.arch };
    hardware ??= machine;
    assert.deepEqual(machine, hardware, 'Same recorded hardware metadata for every child');
    assert.equal(child.platform, 'linux');
    const childStart = timestamp(child.startedAt), childEnd = timestamp(child.endedAt);
    assert.ok(childStart >= previousChildEnd && childEnd >= childStart && childEnd <= endMs,
      `${study.stem}: sequential child timestamps at ${index}`);
    previousChildEnd = childEnd;
    let accountedMs = 0;
    for (const result of child.results) {
      const spec = study.cases.find(value => value.name === result.name);
      const actualSpec = Object.fromEntries(['name', 'operation', 'fields', 'alias', 'single']
        .filter(key => Object.hasOwn(result, key)).map(key => [key, result[key]]));
      assert.deepEqual(actualSpec, spec, `${study.stem}: exact fixture parameters`);
      assert.ok(Number.isSafeInteger(result.iterations) && result.iterations > 0
        && Number.isInteger(Math.log2(result.iterations)), 'Calibration selected a power-of-two iteration count');
      assert.ok(Number.isFinite(result.calibrationMs) && result.calibrationMs >= 20, 'Final calibration batch reached 20 ms');
      assert.ok(Number.isFinite(result.warmMs) && result.warmMs >= study.warmMs, 'Recorded timed warm-up reached its target');
      assert.ok(Number.isSafeInteger(result.warmBatches) && result.warmBatches > 0, 'Positive recorded warm-up batch count');
      assert.equal(result.unit, 'milliseconds per complete public operation');
      const checksum = spec.operation === 'create' ? result.iterations
        : spec.operation === 'noop' ? 0 : result.iterations * (result.iterations + 1) / 2;
      assert.ok(Number.isSafeInteger(checksum));
      for (const field of ['milliseconds', 'batchMilliseconds', 'checksums']) assert.equal(result[field].length, 9);
      for (let sample = 0; sample < 9; sample++) {
        positive(result.batchMilliseconds[sample], 'Measured batch');
        positive(result.milliseconds[sample], 'Per-operation duration');
        close(result.milliseconds[sample], result.batchMilliseconds[sample] / result.iterations, 'Per-operation conversion');
        assert.equal(result.checksums[sample], checksum, 'Complete-operation checksum');
      }
      const processMedian = median(result.milliseconds);
      close(result.medianMs, processMedian, 'Recorded process median');
      const key = JSON.stringify([runtime, pair, role, spec.name]);
      assert.equal(observations.has(key), false, 'Unique process/arm/case observation');
      observations.set(key, { ...result, processMedian });
      accountedMs += result.calibrationMs + result.warmMs + sum(result.batchMilliseconds);
      batches += 9;
    }
    // Only the final calibration and aggregate timed warm-up are recorded. Setup,
    // validation, earlier calibration batches, and imports add further wall time.
    assert.ok(accountedMs <= childEnd - childStart + 2, 'Recorded timed work fits child wall time');
  }
  assert.equal(batches, study.batches, `${study.stem}: batch count`);

  const rows = [];
  for (const runtime of runtimes) for (const name of names) {
    const paired = Array.from({ length: study.pairs }, (_, pair) => {
      const get = role => observations.get(JSON.stringify([runtime, pair, role, name])).processMedian;
      const baselineMs = get('baseline'), candidateMs = get('candidate');
      return { baselineMs, candidateMs, ratio: candidateMs / baselineMs };
    });
    const logs = paired.map(pair => Math.log(pair.ratio)), mean = sum(logs) / logs.length;
    const variance = sum(logs.map(log => (log - mean) ** 2)) / (logs.length - 1);
    const error = Math.sqrt(variance / logs.length);
    const critical = study.pairs === 6 ? 2.570581835636305 : study.pairs === 4 ? 3.182446305284263 : null;
    const computed = { runtime, name, baselineMs: median(paired.map(pair => pair.baselineMs)),
      candidateMs: median(paired.map(pair => pair.candidateMs)), pairedGeomeanRatio: Math.exp(mean),
      interval95: critical === null ? null : [Math.exp(mean - critical * error), Math.exp(mean + critical * error)], pairs: paired };
    const saved = summary[rows.length];
    assert.equal(saved.runtime, runtime); assert.equal(saved.name, name);
    for (const field of ['baselineMs', 'candidateMs', 'pairedGeomeanRatio']) close(saved[field], computed[field], `${study.stem}: ${field}`);
    assert.equal(saved.pairs.length, study.pairs);
    for (let pair = 0; pair < study.pairs; pair++) for (const field of ['baselineMs', 'candidateMs', 'ratio'])
      close(saved.pairs[pair][field], paired[pair][field], `${study.stem}: paired ${field}`);
    if (critical === null) assert.equal(saved.interval95, null, 'Pilot had no confidence interval');
    else {
      assert.equal(saved.interval95.length, 2);
      saved.interval95.forEach((value, i) => close(value, computed.interval95[i], `${study.stem}: Student t interval`));
    }
    const arms = Object.fromEntries(['baseline', 'candidate'].map(role => {
      const results = Array.from({ length: study.pairs }, (_, pair) => observations.get(JSON.stringify([runtime, pair, role, name])));
      const durations = results.flatMap(result => result.batchMilliseconds);
      return [role, { iterations: range(results.map(result => result.iterations)),
        calibrationMs: range(results.map(result => result.calibrationMs)),
        warmMs: range(results.map(result => result.warmMs)), warmBatches: range(results.map(result => result.warmBatches)),
        batchMs: range(durations), measuredBatchesBelow20Ms: durations.filter(value => value < 20).length }];
    }));
    rows.push({ ...computed, runtime: runtimeInfo.get(runtime).bun ? 'Bun 1.4.2' : 'Node 24.22.1', arms });
  }
  assert.equal(summary.length, rows.length, `${study.stem}: complete summary`);
  reports.push({ name: study.stem, files: study.files, sha256: study.digest,
    processes: records.length, batches, pairs: study.pairs, start: m.start, end, rows });
}

let checkedSourceFiles = 0;
let measuredCommitStatus = 'not requested';
if (flags.has('--check-source')) {
  const git = args => execFileSync('git', args, { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
  const tracked = git(['ls-tree', '-r', '--name-only', baselineCommit]).toString('utf8').trim().split('\n');
  const sourceFiles = tracked.filter(name => (!name.includes('/') && (name === 'package.json'
    || (name.endsWith('.ts') && !name.endsWith('.test.ts'))))
    || ['scripts/build-browser.ts', 'scripts/build-wasm.mjs'].includes(name)).sort();
  // WASM files are generated, not tracked. Their saved hashes were already
  // checked for equality between arms and across all three studies above.
  assert.deepEqual(sourceFiles, Object.keys(formal.baselineSources).filter(name => !name.endsWith('.wasm')),
    'Complete tracked baseline source manifest');
  for (const name of sourceFiles) {
    assert.equal(sha256(git(['show', `${baselineCommit}:${name}`])), formal.baselineSources[name], `Tracked baseline source: ${name}`);
    checkedSourceFiles++;
  }
  // Publishing the reviewed tree need not preserve the local measurement commit.
  // Its recorded identity and embedded source hash are always checked; its Git
  // object is an additional check when present, not a prerequisite for readers.
  const measuredCommit = spawnSync('git', ['cat-file', '-e', `${implementationCommit}^{commit}`], { cwd: repo, stdio: 'ignore' });
  if (measuredCommit.error) throw measuredCommit.error;
  if (measuredCommit.status === 0) {
    assert.equal(sha256(git(['show', `${implementationCommit}:worker-protocol.ts`])), sourceDigest.candidate, 'Measured implementation commit');
    measuredCommitStatus = 'checked against Git';
  } else {
    assert.ok([1, 128].includes(measuredCommit.status), 'Unexpected Git failure checking the local measurement commit');
    measuredCommitStatus = 'Git object unavailable; embedded source hash verified';
  }
  assert.equal(sha256(readFileSync(resolve(repo, 'worker-protocol.ts'))), sourceDigest.candidate, 'Current measured implementation');
}

const format = value => Number(value.toPrecision(8)).toString();
const formatRange = values => values.map(format).join('..');
console.log('PASS: saved worker-record descriptor evidence; no benchmarks executed.');
console.log(`Source check: ${flags.has('--check-source') ? `${checkedSourceFiles} baseline files against Git and current worker-protocol.ts` : 'historical hashes only (use --check-source for Git/current source)'}.`);
console.log(`Local measurement commit ${implementationCommit}: ${measuredCommitStatus}.`);
console.log(`Hardware: ${hardware.cpu}; ${hardware.platform}/${hardware.arch}; all measured children pinned to CPU 2.`);
console.log('Ratios use paired process medians. Intervals use Student t on paired log ratios; no pilot interval, pooling, or A/A correction.');
console.log('Saved checksums and samples are verified here; full output/snapshot assertions ran in the preserved, hashed workload.');
console.log('Warm-up values are recorded aggregates. Measured batches may be shorter than the pre-warm-up 20 ms calibration target.');
for (const study of reports) {
  console.log(`\n${study.name}: ${study.processes} processes, ${study.batches} measured batches, ${study.pairs} pairs per runtime/case`);
  console.log(`Files: ${study.files.join(', ')}; original SHA-256 ${study.sha256}`);
  console.log(`Time: ${study.start} to ${study.end}`);
  for (const row of study.rows) {
    console.log(`${row.runtime} ${row.name}: median ms/op ${format(row.baselineMs)} -> ${format(row.candidateMs)}; paired ratio ${format(row.pairedGeomeanRatio)}; 95% interval ${row.interval95 ? formatRange(row.interval95) : 'not reported (pilot)'}`);
    console.log(`  Pair ratios: ${row.pairs.map(pair => format(pair.ratio)).join(', ')}`);
    for (const [role, arm] of Object.entries(row.arms)) console.log(`  ${role}: iterations ${formatRange(arm.iterations)}; calibration ms ${formatRange(arm.calibrationMs)}; warm ms ${formatRange(arm.warmMs)} / batches ${formatRange(arm.warmBatches)}; measured batch ms ${formatRange(arm.batchMs)} (${arm.measuredBatchesBelow20Ms}/${study.pairs * 9} below 20 ms)`);
  }
}
console.log(`\nPASS: ${sum(reports.map(study => study.processes))} processes and ${sum(reports.map(study => study.batches))} measured batches verified across all three preserved studies.`);
