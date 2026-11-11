// Independent audit of saved evidence; never reruns or adjusts measurements.
// Usage: node audit-evidence.mjs complete-study.json[.gz] [...]
// CHECK_CONFIRMED_SOURCE=1 also binds formal records to the current sources.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import ts from 'typescript';

const STUDY = 'list-float64-numeric-20261108';
const BASELINE = '0ac8a005268335a6116f025e75f670b5cee6843e';
const CASE_NAMES = [
  'float64-32', 'float64-4096', 'float64-65536', 'float64-1048576',
  'float64-subview-65536', 'float64-shared-65536', 'float64-only-4096', 'float64-only-65536',
  'array-build-control-32', 'scalar-append-control-2048',
  'numeric-range-control-65569', 'numeric-box-control-65538',
];
const PILOT_NAMES = ['float64-32', 'float64-65536', 'float64-only-4096', 'float64-only-65536',
  'float64-shared-65536', 'array-build-control-32', 'scalar-append-control-2048',
  'numeric-range-control-65569', 'numeric-box-control-65538'];
const AA_NAMES = ['float64-65536', 'float64-only-65536', 'array-build-control-32',
  'scalar-append-control-2048', 'numeric-range-control-65569', 'numeric-box-control-65538'];
const TYPED_ONLY_NAMES = ['float64-only-4096', 'float64-only-65536'];
const PAIRS = { pilot: 2, formal: 6, aa: 4 };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => {
  const bytes = readFileSync(file);
  return JSON.parse((file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
};
function middle(values) {
  assert.ok(values.length > 0);
  const ordered = [...values].sort((a, b) => a - b);
  return (ordered[Math.floor((ordered.length - 1) / 2)] + ordered[Math.floor(ordered.length / 2)]) / 2;
}
function near(actual, expected, label) {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected), `${label}: finite values`);
  assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)),
    `${label}: ${actual} != ${expected}`);
}
function changed(left, right) {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(name => left[name] !== right[name]).sort();
}
function repository(file) {
  let directory = dirname(resolve(file));
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    assert.notEqual(parent, directory, 'Repository package.json must exist');
    directory = parent;
  }
  return directory;
}
function recordedFile(root, record) {
  assert.equal(typeof record.name, 'string'); assert.match(record.sha256, /^[a-f0-9]{64}$/);
  const marker = record.name.lastIndexOf('/proofs/');
  const file = marker >= 0 ? join(root, record.name.slice(marker + 1)) : record.name;
  assert.ok(existsSync(file), `Recorded source is missing: ${record.name}`);
  assert.equal(sha(readFileSync(file)), record.sha256, `Recorded source changed: ${record.name}`);
  return file;
}
function manifest(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), label);
  assert.ok(Object.keys(value).length > 0, `${label}: nonempty`);
  for (const [name, digest] of Object.entries(value)) {
    assert.ok(name && !name.startsWith('/') && !name.split('/').includes('..'), `${label}: relative file`);
    assert.match(digest, /^[a-f0-9]{64}$/, `${label}/${name}`);
  }
}
const baselineTrees = new Map(), baselineFiles = new Map();
function baselineFile(root, name) {
  if (!baselineTrees.has(root)) {
    baselineTrees.set(root, new Set(execFileSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', BASELINE],
      { encoding: 'utf8' }).trim().split('\n')));
  }
  if (!baselineTrees.get(root).has(name)) return null;
  const key = `${root}\0${name}`;
  if (!baselineFiles.has(key)) {
    baselineFiles.set(key, execFileSync('git', ['-C', root, 'show', `${BASELINE}:${name}`]));
  }
  return baselineFiles.get(key);
}
function sourceProof(root, data) {
  const before = data.source.before, after = data.source.after;
  assert.equal(before.commit, BASELINE);
  for (const [variant, record] of Object.entries(data.source)) {
    assert.match(record.commit, /^[a-f0-9]{40}$/);
    for (const key of ['sources', 'wasm', 'bundles']) manifest(record[key], `${variant}/${key}`);
  }
  assert.deepEqual(Object.keys(data.source).sort(), ['after', 'before']);
  assert.deepEqual(changed(before.sources, after.sources),
    data.mode === 'aa' ? [] : [...data.study.changedSources].sort());
  // This factory study changes JavaScript only. All compiled kernels must agree.
  assert.deepEqual(data.study.changedWasm, []);
  assert.deepEqual(before.wasm, after.wasm);
  if (data.mode === 'aa') assert.deepEqual(before, after);
  for (const [name, digest] of Object.entries(before.sources)) {
    const committed = baselineFile(root, name);
    assert.notEqual(committed, null, `Unexpected baseline source: ${name}`);
    assert.equal(sha(committed), digest, `Baseline commit mismatch: ${name}`);
  }
  assert.deepEqual(Object.keys(data.snapshots).sort(), [...data.study.changedSources].sort());
  for (const name of data.study.changedSources) {
    const committed = baselineFile(root, name);
    if (committed === null) {
      assert.equal(Object.hasOwn(before.sources, name), false, `New helper must be absent from the baseline: ${name}`);
      assert.equal(data.snapshots[name].before, null, `New helper baseline snapshot: ${name}`);
    } else {
      assert.equal(sha(committed), before.sources[name], `Changed source baseline mismatch: ${name}`);
    }
    assert.deepEqual(Object.keys(data.snapshots[name]).sort(), ['after', 'before']);
    for (const variant of ['before', 'after']) {
      const snapshot = data.snapshots[name][variant], sources = data.source[variant].sources;
      if (!Object.hasOwn(sources, name)) {
        // In A/A, both snapshots of a newly added candidate helper are null.
        assert.equal(snapshot, null, `Absent source snapshot: ${name}/${variant}`);
      } else {
        assert.equal(typeof snapshot, 'string', `Present source snapshot: ${name}/${variant}`);
        assert.equal(sha(snapshot), sources[name], `Snapshot mismatch: ${name}/${variant}`);
      }
    }
    if (process.env.CHECK_CONFIRMED_SOURCE === '1' && data.mode === 'formal') {
      const current = join(root, name);
      if (Object.hasOwn(after.sources, name)) {
        assert.equal(sha(readFileSync(current)), after.sources[name], `Current measured source changed: ${name}`);
      } else assert.equal(existsSync(current), false, `Removed measured source exists: ${name}`);
    }
  }
}

// Reparse archived source text independently of check-shared-graph.mjs.
// This also makes the audit independent of future compiler/chunk-name changes.
function parseSharedGraph(read) {
  const pending = ['shared.js'], texts = {}, files = {}, edges = {};
  while (pending.length) {
    const name = pending.shift();
    if (Object.hasOwn(files, name)) continue;
    assert.ok(!posix.isAbsolute(name) && !name.split('/').includes('..'), 'Graph stays within dist');
    const source = read(name);
    assert.equal(typeof source, 'string', `Missing archived module: ${name}`);
    texts[name] = source;
    files[name] = { sha256: sha(source), bytes: Buffer.byteLength(source) };
    const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(tree.parseDiagnostics.length, 0, `Parse ${name}`);
    const dependencies = new Set();
    function inspect(node) {
      let reference;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        reference = node.moduleSpecifier;
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        assert.ok(node.arguments.length, `Unresolved import/require in ${name}`);
        reference = node.arguments[0];
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        reference = node.moduleReference.expression;
      }
      if (reference) {
        assert.ok(ts.isStringLiteralLike(reference), `Unresolved module path in ${name}`);
        assert.ok(reference.text.startsWith('.'), `External dependency in ${name}: ${reference.text}`);
        dependencies.add(reference.text);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(tree);
    edges[name] = [...dependencies].sort();
    for (const specifier of edges[name]) pending.push(posix.normalize(posix.join(posix.dirname(name), specifier)));
  }
  const ordered = object => Object.fromEntries(Object.entries(object).sort(([left], [right]) => left.localeCompare(right)));
  return { texts: ordered(texts), files: ordered(files), edges: ordered(edges) };
}
function captureSharedSources(directory) {
  const before = resolve(directory), folder = dirname(fileURLToPath(import.meta.url));
  assert.equal(execFileSync('git', ['-C', before, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), BASELINE);
  const parsed = parseSharedGraph(name => readFileSync(join(before, 'dist', name), 'utf8'));
  assert.equal(Object.keys(parsed.files).length, 5);
  const raw = Buffer.from(JSON.stringify({ schema: 'zerocopy-shared-module-texts/v1', baseline: BASELINE,
    entry: 'shared.js', modules: parsed.texts }) + '\n');
  const compressed = gzipSync(raw, { level: 9 }), file = 'shared-module-sources.json.gz';
  const manifest = { schema: 'zerocopy-compressed-proof/v1', file, moduleCount: Object.keys(parsed.files).length,
    rawBytes: raw.length, compressedBytes: compressed.length, rawSha256: sha(raw), compressedSha256: sha(compressed) };
  writeFileSync(join(folder, file), compressed, { flag: 'wx' });
  writeFileSync(join(folder, 'shared-module-sources-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(manifest, null, 2));
}
const parsedGraphs = new Map();
function verifySharedGraph(root, data) {
  const folder = join(root, 'proofs', STUDY);
  const manifest = json(join(folder, 'shared-module-sources-manifest.json'));
  assert.equal(manifest.schema, 'zerocopy-compressed-proof/v1');
  assert.equal(manifest.file, 'shared-module-sources.json.gz'); assert.equal(manifest.moduleCount, 5);
  const compressed = readFileSync(join(folder, manifest.file));
  assert.equal(compressed.length, manifest.compressedBytes); assert.equal(sha(compressed), manifest.compressedSha256);
  const raw = gunzipSync(compressed);
  assert.equal(raw.length, manifest.rawBytes); assert.equal(sha(raw), manifest.rawSha256);
  let parsed = parsedGraphs.get(manifest.rawSha256);
  if (!parsed) {
    const snapshot = JSON.parse(raw.toString('utf8'));
    assert.equal(snapshot.schema, 'zerocopy-shared-module-texts/v1');
    assert.equal(snapshot.baseline, BASELINE); assert.equal(snapshot.entry, 'shared.js');
    parsed = parseSharedGraph(name => snapshot.modules[name]);
    assert.deepEqual(Object.keys(snapshot.modules).sort(), Object.keys(parsed.files).sort(), 'No missing or extra archived modules');
    assert.equal(Object.keys(parsed.files).length, manifest.moduleCount);
    assert.equal(Object.hasOwn(parsed.files, 'numeric.js'), false, 'Root graph must not load the optional numeric entry');
    parsedGraphs.set(manifest.rawSha256, parsed);
  }
  const proofFile = join(folder, 'shared-graph-result.json'), proofBytes = readFileSync(proofFile);
  const proof = JSON.parse(proofBytes.toString('utf8'));
  assert.equal(proof.status, 'PASSED'); assert.equal(proof.entry, 'dist/shared.js');
  assert.deepEqual(proof.changes, []); assert.deepEqual(proof.changedRootSources, ['numeric.ts']);
  assert.equal(proof.wasm.identical, true);
  for (const variant of ['before', 'after']) {
    assert.deepEqual(proof[variant].external, []); assert.deepEqual(proof[variant].unresolved, []);
    assert.deepEqual(proof[variant].files, parsed.files, `Independent graph contents: ${variant}`);
    assert.deepEqual(proof[variant].edges, parsed.edges, `Independent graph edges: ${variant}`);
    assert.deepEqual(proof.wasm[variant], data.source[variant].wasm, `Graph WASM identity: ${variant}`);
    for (const [name, identity] of Object.entries(parsed.files)) {
      assert.equal(data.source[variant].bundles[name], identity.sha256, `Measured graph module: ${variant}/${name}`);
    }
  }
  return { proofFile: basename(proofFile), proofSha256: sha(proofBytes),
    sourceSnapshotFile: manifest.file, sourceSnapshotRawSha256: manifest.rawSha256,
    modules: Object.keys(parsed.files).length,
    bytes: Object.values(parsed.files).reduce((total, entry) => total + entry.bytes, 0),
    identicalPathsAndContents: true, externalDependencies: 0, unresolvedDependencies: 0 };
}

function workerProof(root, data) {
  if (data.mode === 'aa') return null;
  const folder = join(root, 'proofs', STUDY);
  const workerFile = 'node-worker-result.json';
  const worker = json(join(folder, workerFile));
  assert.equal(worker.source, data.source.after.sources['numeric.ts']);
  assert.equal(worker.wasm, data.source.after.wasm['persistent-core.wasm']);
  assert.deepEqual(worker.bundles, data.source.after.bundles);
  assert.equal(worker.driver, sha(readFileSync(join(folder, 'node-worker.mjs'))));
  assert.equal(worker.fixtures, sha(readFileSync(join(folder, 'worker-fixtures.mjs'))));
  assert.equal(worker.runtime.bun, undefined); assert.equal(worker.timingMeasurements, false);
  assert.deepEqual(worker.checks.map(check => check.transport), ['shared', 'copy']);
  for (const check of worker.checks) {
    assert.equal(check.first.type, 'scanned'); assert.equal(check.first.ok, true); assert.equal(check.first.count, 65569);
    assert.equal(check.second.type, 'complete'); assert.equal(check.second.ok, true);
    assert.deepEqual(check.second.checked, ['retained-source', 'raw-NaN-payloads', 'signed-zero',
      'read-only-guards', 'new-root-after-growth', 'ordinary-edits-after-import', 'published-bytes']);
  }
  assert.ok(Number.isSafeInteger(worker.writer.importedCount) && worker.writer.importedCount > 65569);
  assert.deepEqual(worker.writer.checks, ['float64-input-copy', 'subview', 'shared-input',
    'raw-NaN-payloads', 'signed-zero', 'empty-input', 'set-push-pop-after-import',
    'memory-growth', 'old-view-validity', 'published-byte-immutability']);
  return { file: workerFile,
    nodeWorkers: 'Shared and copied workers match measured source, unchanged WASM, every bundle, and proof identities' };
}
function date(value, label) {
  assert.equal(typeof value, 'string', label);
  const result = Date.parse(value); assert.ok(Number.isFinite(result), label); return result;
}
async function audit(file) {
  const data = json(file), root = repository(file);
  assert.equal(data.schema, 'zerocopy-paired-public-operation/v1'); assert.equal(data.status, 'complete');
  assert.equal(data.study.id, STUDY); assert.equal(data.study.baseline, BASELINE);
  assert.ok(Object.hasOwn(PAIRS, data.mode), 'Declared study mode');
  assert.equal(Object.hasOwn(data, 'failure'), false); assert.equal(Object.hasOwn(data, 'error'), false);
  assert.equal(new Set(data.study.changedSources).size, data.study.changedSources.length);
  assert.deepEqual(data.study.changedSources, ['numeric.ts', 'tsconfig.numeric.json']);
  assert.equal(data.study.phase, undefined, 'This is a separate fixed optional-entry study');
  sourceProof(root, data);
  const sharedGraph = verifySharedGraph(root, data);
  recordedFile(root, data.driver);
  const workloadFile = recordedFile(root, data.workload);
  assert.equal(basename(workloadFile), 'workloads.mjs');
  const { study } = await import(pathToFileURL(workloadFile));
  assert.deepEqual(data.study, study, 'Recorded study must match its frozen workload');
  assert.deepEqual(data.study.cases.map(spec => spec.name), CASE_NAMES);
  assert.deepEqual(data.study.pilotCases, PILOT_NAMES); assert.deepEqual(data.study.aaCases, AA_NAMES);
  assert.equal(data.study.cases.find(spec => spec.name === 'scalar-append-control-2048').repetitions, 256);
  for (const spec of data.study.cases) {
    assert.equal(Boolean(spec.typedSetup), TYPED_ONLY_NAMES.includes(spec.name), 'Only declared typed-only cases change setup input');
    if (spec.kind === 'numeric-range' || spec.kind === 'numeric-box') assert.equal(spec.repetitions, 512);
  }
  for (const support of data.study.supportFiles ?? []) {
    assert.equal(support.name, basename(support.name), 'Support filename must be local to the workload');
    assert.equal(sha(readFileSync(join(dirname(workloadFile), support.name))), support.sha256,
      `Pinned workload support changed: ${support.name}`);
  }
  const pairs = data.method.pairs, cases = data.method.cases;
  const selection = data.mode === 'pilot' ? PILOT_NAMES : data.mode === 'aa' ? AA_NAMES : CASE_NAMES;
  assert.deepEqual(cases, study.cases.filter(spec => selection.includes(spec.name)), 'Complete predeclared case selection');
  assert.equal(pairs, PAIRS[data.mode]); assert.equal(data.method.samples, 9);
  assert.equal(data.method.minimumWarmupBatches, 8); assert.equal(data.method.minimumWarmupMs, 500);
  assert.equal(data.method.lock, '/tmp/zerocopy-perf-20261108.lock');
  assert.deepEqual(Object.keys(data.method.runtimes), ['node', 'bun']);
  assert.match(data.host.affinity, /^\d+$/);
  const started = date(data.startedAt, 'Study start'), completed = date(data.completedAt, 'Study end');
  assert.ok(completed >= started);

  const expectedOrder = [];
  for (let pair = 0; pair < pairs; pair++) {
    for (const runtime of pair % 2 ? ['bun', 'node'] : ['node', 'bun']) {
      for (const spec of pair % 2 ? [...cases].reverse() : cases) {
        for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
          expectedOrder.push({ pair, runtime, caseName: spec.name, variant });
        }
      }
    }
  }
  assert.equal(data.runs.length, expectedOrder.length);
  let verifiedOutputs = 0, measuredBatches = 0, shortMeasuredBatches = 0, warmupBatches = 0, previousEnd = started;
  const lookup = new Map(), runtimeIdentity = new Map(), fixtures = new Map();
  for (let index = 0; index < data.runs.length; index++) {
    const run = data.runs[index], expected = expectedOrder[index];
    for (const [field, value] of Object.entries(expected)) assert.equal(run[field], value, `Run order ${index}/${field}`);
    const spec = cases.find(item => item.name === run.caseName);
    assert.deepEqual(run.spec, spec); assert.ok(Number.isSafeInteger(spec.repetitions) && spec.repetitions > 0);
    assert.equal(run.affinity, data.host.affinity); assert.match(run.expectedDigest, /^[a-f0-9]{64}$/);
    assert.equal(Boolean(run.versions.bun), run.runtime === 'bun');
    assert.equal(typeof run.versions.node, 'string'); assert.equal(typeof run.executable, 'string');
    const identity = { versions: run.versions, executable: run.executable };
    if (runtimeIdentity.has(run.runtime)) assert.deepEqual(identity, runtimeIdentity.get(run.runtime));
    else runtimeIdentity.set(run.runtime, identity);
    const fixture = { fixture: run.fixture, expectedDigest: run.expectedDigest };
    const fixtureKey = `${run.runtime}/${spec.name}`;
    if (fixtures.has(fixtureKey)) assert.deepEqual(fixture, fixtures.get(fixtureKey));
    else fixtures.set(fixtureKey, fixture);
    assert.equal(run.fixture.kind, spec.kind); assert.equal(run.fixture.count, spec.count);
    assert.equal(run.fixture.offset, spec.offset ?? 0); assert.equal(run.fixture.shared, Boolean(spec.shared));
    assert.ok(Number.isSafeInteger(run.fixture.initialUsed) && run.fixture.initialUsed > 65536);
    const readControl = spec.kind === 'numeric-range' || spec.kind === 'numeric-box';
    assert.equal(run.fixture.optionalNumericEntryImported, spec.kind === 'typed' || readControl);
    assert.equal(run.fixture.reset, readControl
      ? 'One ordinary-array source reused across batches; initial untimed operation primes the existing numeric kernel'
      : spec.typedSetup
      ? 'Private writer reset and Float64Array source construction through existing pushMany before every batch, outside timing'
      : 'Private writer reset and ordinary-array source construction before every batch, outside timing');
    if (spec.kind === 'typed') {
      assert.equal(run.fixture.timedOperation,
        'Before: new SharedList(number).pushMany(the same Float64Array); after: fromFloat64(the same Float64Array) from zerocopy/numeric; no Array.from conversion in either timed path');
    }
    const runStart = date(run.startedAt, `Run ${index} start`), runEnd = date(run.completedAt, `Run ${index} end`);
    assert.ok(runStart >= previousEnd && runEnd >= runStart && runEnd <= completed, `Run ${index} chronology`);
    previousEnd = runEnd;
    assert.equal(run.sampleBatchMs.length, 9); assert.ok(run.warmupBatchMs.length >= 8);
    const times = [...run.warmupBatchMs, ...run.sampleBatchMs];
    assert.ok(times.every(value => Number.isFinite(value) && value > 0));
    assert.ok(run.warmupBatchMs.reduce((sum, value) => sum + value, 0) >= 500);
    const medianMs = middle(run.sampleBatchMs) / spec.repetitions;
    near(run.medianMs, medianMs, `Median ${index}`);
    assert.equal(run.verifiedOutputs, (run.warmupBatchMs.length + 9) * spec.repetitions);
    near(run.batchTiming.minimumObservedMs, Math.min(...times), `Minimum ${index}`);
    near(run.batchTiming.minimumMeasuredMs, Math.min(...run.sampleBatchMs), `Measured minimum ${index}`);
    assert.equal(run.batchTiming.measuredBelow2ms, run.sampleBatchMs.filter(time => time < 2).length);
    assert.equal(run.batchTiming.warmupBelow2ms, run.warmupBatchMs.filter(time => time < 2).length);
    verifiedOutputs += run.verifiedOutputs; measuredBatches += 9; warmupBatches += run.warmupBatchMs.length;
    shortMeasuredBatches += run.batchTiming.measuredBelow2ms;
    const key = `${run.runtime}/${run.caseName}/${run.pair}/${run.variant}`;
    assert.ok(!lookup.has(key)); lookup.set(key, { run, medianMs });
  }

  const summary = [];
  assert.equal(new Set(data.summary.map(row => `${row.runtime}/${row.name}`)).size, data.summary.length);
  for (const runtime of ['node', 'bun']) for (const spec of cases) {
    const points = [];
    for (let pair = 0; pair < pairs; pair++) {
      const before = lookup.get(`${runtime}/${spec.name}/${pair}/before`);
      const after = lookup.get(`${runtime}/${spec.name}/${pair}/after`);
      assert.equal(before.run.expectedDigest, after.run.expectedDigest); assert.deepEqual(before.run.fixture, after.run.fixture);
      assert.deepEqual(before.run.versions, after.run.versions); assert.equal(before.run.affinity, after.run.affinity);
      points.push({ pair, before: before.medianMs, after: after.medianMs, ratio: after.medianMs / before.medianMs });
    }
    const logs = points.map(point => Math.log(point.ratio));
    const average = logs.reduce((sum, value) => sum + value, 0) / pairs;
    let interval95 = null;
    if (pairs > 2) {
      const critical = pairs === 6 ? 2.5705818356363155 : 3.182446305284263;
      const variance = logs.reduce((sum, value) => sum + (value - average) ** 2, 0) / (pairs - 1);
      const uncertainty = critical * Math.sqrt(variance / pairs);
      interval95 = [Math.exp(average - uncertainty), Math.exp(average + uncertainty)];
    }
    const calculated = { runtime, name: spec.name, role: spec.role,
      beforeMs: middle(points.map(point => point.before)), afterMs: middle(points.map(point => point.after)),
      pairedRatio: Math.exp(average), interval95, fasterPairs: points.filter(point => point.ratio < 1).length, points };
    const saved = data.summary.find(row => row.runtime === runtime && row.name === spec.name);
    assert.ok(saved); assert.equal(saved.role, calculated.role); assert.equal(saved.fasterPairs, calculated.fasterPairs);
    for (const field of ['beforeMs', 'afterMs', 'pairedRatio']) near(saved[field], calculated[field], `${runtime}/${spec.name}/${field}`);
    if (interval95) {
      assert.equal(saved.interval95.length, 2);
      interval95.forEach((value, index) => near(saved.interval95[index], value, `${runtime}/${spec.name}/CI${index}`));
    } else assert.equal(saved.interval95, null);
    assert.equal(saved.points.length, points.length);
    for (let index = 0; index < points.length; index++) {
      assert.equal(saved.points[index].pair, index);
      for (const key of ['before', 'after', 'ratio']) near(saved.points[index][key], points[index][key], `${runtime}/${spec.name}/point${index}/${key}`);
    }
    summary.push(calculated);
  }
  assert.equal(data.summary.length, summary.length);
  return { file: basename(file), study: STUDY, mode: data.mode, status: 'independently verified',
    comparison: data.mode === 'aa' ? 'Repeated baseline against itself; not pooled with A/B results' :
      'Complete existing constructor + pushMany with the same Float64Array versus complete optional numeric fromFloat64 call',
    controlScope: 'Root-only controls load the identical shared graph; optional numeric controls exercise the changed optional entry',
    processes: data.runs.length, measuredBatches, shortMeasuredBatches, warmupBatches,
    verifiedOutputCount: verifiedOutputs, sharedGraph, workerProof: workerProof(root, data), summary };

}

if (process.argv[2] === '--capture-shared-sources') {
  assert.equal(process.argv.length, 4, 'Supply the frozen baseline directory');
  captureSharedSources(process.argv[3]);
} else {
  assert.ok(process.argv.length > 2, 'Supply one or more complete recorded study JSON or JSON.gz files');
  for (const file of process.argv.slice(2)) console.log(JSON.stringify(await audit(resolve(file)), null, 2));
}
