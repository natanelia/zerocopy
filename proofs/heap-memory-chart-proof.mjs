import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const protocol = JSON.parse(readFileSync(join(here, 'heap-memory-chart-protocol.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = path => hash(readFileSync(path));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const git = (source, ...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
const sorted = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

export function verifySource(source, requireCommit = true) {
  const commit = git(source, 'rev-parse', 'HEAD'), tree = git(source, 'rev-parse', 'HEAD^{tree}');
  if (requireCommit) assert.equal(commit, protocol.candidateCommit, 'Measured source commit changed');
  assert.equal(tree, protocol.candidateTree, 'Measured source tree changed');
  const files = {};
  for (const entry of execFileSync('git', ['ls-tree', '-rz', 'HEAD'], { cwd: source, encoding: 'utf8' }).split('\0').filter(Boolean)) {
    const [, mode, blob, name] = /^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(entry) || [];
    assert.ok(name && ['100644', '100755'].includes(mode), `Unsupported source entry: ${entry}`);
    assert.ok(lstatSync(join(source, name)).isFile(), `Not a regular source file: ${name}`);
    assert.equal(git(source, 'hash-object', '--', name), blob, `Source bytes changed: ${name}`);
    files[name] = { blob, sha256: digest(join(source, name)) };
  }
  for (const [name, expected] of Object.entries(protocol.proofHashes)) assert.equal(digest(join(source, 'proofs', name)), expected, `Method changed: ${name}`);
  for (const [name, expected] of Object.entries(protocol.adapterHashes)) assert.equal(digest(join(source, 'website', name)), expected, `Dataset or adapter changed: ${name}`);
  const pkg = read(join(source, 'package.json'));
  assert.equal(pkg.devDependencies.immutable, protocol.immutable);
  assert.equal(pkg.devDependencies.assemblyscript, protocol.assemblyscript);
  return { commit, tree, files };
}

function verifyEnvironment() {
  for (const key of ['runtime', 'v8', 'platform', 'arch']) {
    const actual = { runtime: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch };
    assert.equal(actual[key], protocol[key], `Runtime mismatch: ${key}`);
  }
  assert.equal(execFileSync('bun', ['--revision'], { encoding: 'utf8' }).trim(), protocol.bunRevision);
  for (const key of ['NODE_OPTIONS', 'BUN_OPTIONS', 'MEMORY_VENDOR']) assert.ok(!process.env[key], `Unexpected ${key}`);
}

function currentModules(source) {
  const hashes = { ...protocol.adapterHashes };
  for (const name of readdirSync(join(source, 'dist')).filter(name => name.endsWith('.js')).sort()) hashes[`library/${name}`] = digest(join(source, 'dist', name));
  assert.ok(hashes['library/shared.js']);
  hashes['vendor/immutable.mjs'] = digest(join(source, 'node_modules/immutable/dist/immutable.es.js'));
  assert.equal(hashes['vendor/immutable.mjs'], protocol.vendorHash, 'Immutable.js bytes changed');
  return sorted(hashes);
}

export function auditRaw(source, rawDirectory, expected = protocol) {
  const summary = read(join(rawDirectory, 'summary.json'));
  for (const key of ['runtime', 'v8', 'platform', 'arch', 'immutable', 'trials', 'entries', 'runCount', 'method']) assert.deepEqual(summary[key], expected[key], `Summary mismatch: ${key}`);
  assert.equal(summary.schema, 'zerocopy-investigation-memory/v1');
  assert.equal(summary.runtimeSourceCommit, expected.candidateCommit);
  assert.deepEqual(summary.readerCounts, expected.readerCounts);
  assert.deepEqual(summary.fixtures, expected.fixtures);
  assert.deepEqual(sorted(summary.proofHashes), sorted(expected.proofHashes));
  for (const [name, value] of Object.entries(expected.adapterHashes)) assert.equal(summary.hashes[name], value);
  assert.equal(summary.hashes['vendor/immutable.mjs'], expected.vendorHash);
  const calibration = summary.calibration;
  assert.equal(calibration.wasmCapacity, 8388608);
  assert.ok(calibration.ordinary.arrayBuffers - calibration.before.arrayBuffers >= 8388608 - 65536);
  assert.ok(Math.abs(calibration.wasm.arrayBuffers - calibration.ordinary.arrayBuffers) < 65536);
  const { kinds, fixtures, stages } = expected;
  const files = fixtures.flatMap(fixture => kinds.flatMap(kind => (kind === 'centralized' ? [0] : [0, 2, 4]).flatMap(readers => [1, 2, 3].map(trial => `${fixture}-${kind}-${readers}-trial-${trial}.json`))));
  assert.deepEqual(readdirSync(rawDirectory).sort(), [...files, 'summary.json'].sort(), 'Missing, extra or failed raw runs');
  const all = new Map();
  for (const filename of files) {
    const raw = read(join(rawDirectory, filename));
    assert.equal(filename, `${raw.fixture}-${raw.kind}-${raw.readers}-trial-${raw.trial}.json`);
    assert.equal(raw.entries, 100000);
    assert.deepEqual(raw.records.map(record => record.type === 'stage' ? record.name : record.type), ['baseline', 'loaded', 'answer', 'answer', 'queried', 'answer', 'answer', 'append-retained', 'answer', 'released', 'answer', 'streamed', 'stopped']);
    const roles = ['owner', ...Array.from({ length: raw.readers }, (_, i) => `reader-${i}`), 'controller'];
    const baseline = raw.records[0];
    assert.deepEqual(baseline.threads.map(thread => thread.role), roles);
    for (const thread of baseline.threads) {
      assert.equal(thread.arenas.length, 0);
      if (thread.role !== 'controller') { assert.equal(thread.count, 0); assert.equal(thread.frozenCount, 0); }
    }
    const measurements = raw.records.filter(record => record.type === 'stage');
    assert.deepEqual(measurements.map(stage => stage.name), stages);
    for (const stage of measurements) {
      assert.deepEqual(stage.threads.map(thread => thread.role), roles);
      const count = ['loaded', 'queried'].includes(stage.name) ? 100000 : stage.name === 'streamed' ? 142000 : 102000;
      const arenas = new Map();
      for (const thread of stage.threads) {
        if (thread.role !== 'controller') {
          assert.equal(thread.count, count);
          assert.equal(thread.frozenCount, stage.name === 'append-retained' ? 100000 : 0);
        }
        for (const arena of thread.arenas) {
          const prior = arenas.get(arena.id);
          if (prior) { assert.equal(prior.capacityBytes, arena.capacityBytes); prior.usedBytes = Math.max(prior.usedBytes, arena.usedBytes); }
          else arenas.set(arena.id, { ...arena });
          assert.ok(arena.usedBytes >= 65536 && arena.usedBytes <= arena.capacityBytes);
        }
      }
      const sum = (threads, field) => threads.reduce((n, thread) => n + thread.usage[field], 0);
      const heapUsed = sum(stage.threads, 'heapUsed'), arrayBuffers = sum(stage.threads, 'arrayBuffers');
      const heapDelta = heapUsed - sum(baseline.threads, 'heapUsed');
      const arrayBufferDelta = arrayBuffers - sum(baseline.threads, 'arrayBuffers');
      const wasmCapacityBytes = [...arenas.values()].reduce((n, arena) => n + arena.capacityBytes, 0);
      const arenaUsedBytes = [...arenas.values()].reduce((n, arena) => n + arena.usedBytes, 0);
      assert.equal(arenas.size, raw.kind === 'shared' ? 1 : 0);
      const calculated = { heapUsed, arrayBuffers, external: sum(stage.threads, 'external'), heapDelta, arrayBufferDelta, wasmCapacityBytes, arenaUsedBytes, arenaCount: arenas.size, retainedBytes: heapDelta + arrayBufferDelta + wasmCapacityBytes };
      for (const [field, value] of Object.entries(calculated)) assert.equal(stage.memory[field], value, `${filename}:${stage.name}:${field}`);
      assert.equal(stage.memory.resolved, true);
      assert.deepEqual(stage.memory.arenas, [...arenas.values()]);
      assert.ok(Number.isSafeInteger(stage.rssBytes) && stage.rssBytes > 0);
      assert.ok(stage.processHighWaterRSSBytes >= stage.rssBytes);
      const key = `${raw.kind}:${raw.fixture}:${raw.readers}:${stage.name}`;
      if (!all.has(key)) all.set(key, []);
      all.get(key).push({ trial: raw.trial, ...stage.memory, rssBytes: stage.rssBytes, processHighWaterRSSBytes: stage.processHighWaterRSSBytes });
    }
    if (raw.kind === 'shared') for (const field of ['wasmCapacityBytes', 'arenaUsedBytes']) assert.equal(measurements[2].memory[field], measurements[3].memory[field]);
    const stopped = raw.records.at(-1);
    assert.deepEqual(stopped.threads.map(thread => thread.role), ['controller']);
    assert.deepEqual(stopped.threads[0].arenas, []);
    assert.ok(stopped.rssBytes > 0 && stopped.processHighWaterRSSBytes >= stopped.rssBytes);
  }
  assert.equal(all.size, 150); assert.equal(summary.summary.length, 150);
  const seen = new Set();
  for (const group of summary.summary) {
    const key = `${group.kind}:${group.fixture}:${group.readers}:${group.stage}`;
    assert.ok(!seen.has(key)); seen.add(key); assert.equal(group.entries, 100000);
    const samples = all.get(key).sort((a, b) => a.trial - b.trial);
    assert.deepEqual(group.samples, samples);
    const fields = ['retainedBytes', 'heapDelta', 'arrayBufferDelta', 'wasmCapacityBytes', 'arenaUsedBytes', 'rssBytes', 'processHighWaterRSSBytes'];
    const medians = Object.fromEntries(fields.map(field => [field, samples.map(sample => sample[field]).sort((a, b) => a - b)[1]]));
    assert.deepEqual(group.medians, medians);
  }
  return { summary, summarySHA256: digest(join(rawDirectory, 'summary.json')), rawRuns: files.length, stateSamples: all.size * 3 };
}

async function run(command, source, evidence) {
  if (command === 'check-plan') {
    const result = verifySource(source, false);
    console.log(JSON.stringify({ verifiedTree: result.tree, sourceFiles: Object.keys(result.files).length, proofFiles: Object.keys(protocol.proofHashes).length, adapters: Object.keys(protocol.adapterHashes).length }));
    return;
  }
  assert.ok(['before', 'built', 'measure', 'audit'].includes(command), 'Unknown command');
  verifyEnvironment();
  const sourceState = verifySource(source);
  mkdirSync(evidence, { recursive: true });
  if (command === 'before') {
    const proofRoot = dirname(here);
    write(join(evidence, 'source.json'), { ...sourceState, proofCommit: git(proofRoot, 'rev-parse', 'HEAD'), proofTree: git(proofRoot, 'rev-parse', 'HEAD^{tree}'), protocolSHA256: digest(join(here, 'heap-memory-chart-protocol.json')), driverSHA256: digest(fileURLToPath(import.meta.url)), runtime: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, runnerImage: process.env.ImageOS ?? null, runnerImageVersion: process.env.ImageVersion ?? null, runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null });
    cpSync(join(here, 'heap-memory-chart-protocol.json'), join(evidence, 'protocol.json'));
    cpSync(fileURLToPath(import.meta.url), join(evidence, 'driver.mjs'));
    cpSync(join(proofRoot, '.github/workflows/heap-memory-chart.yml'), join(evidence, 'workflow.yml'));
    writeFileSync(join(evidence, 'source.tar'), execFileSync('git', ['archive', 'HEAD'], { cwd: source, maxBuffer: 32 * 1024 * 1024 }));
    return;
  }
  const before = read(join(evidence, 'source.json'));
  assert.deepEqual(sourceState.files, before.files);
  assert.equal(before.protocolSHA256, digest(join(here, 'heap-memory-chart-protocol.json')));
  assert.equal(before.driverSHA256, digest(fileURLToPath(import.meta.url)));
  const modules = currentModules(source);
  if (command === 'built') {
    for (const name of ['immutable', 'assemblyscript']) assert.equal(read(join(source, 'node_modules', name, 'package.json')).version, protocol[name]);
    assert.ok(existsSync(join(source, 'bun.lock')), 'Retain the exact resolved dependency lockfile');
    cpSync(join(source, 'bun.lock'), join(evidence, 'bun.lock'));
    cpSync(join(source, 'dist'), join(evidence, 'dist'), { recursive: true });
    for (const name of readdirSync(source).filter(name => name.endsWith('.wasm'))) cpSync(join(source, name), join(evidence, name));
    write(join(evidence, 'built.json'), { sourceCommit: sourceState.commit, sourceTree: sourceState.tree, modules, bunRevision: protocol.bunRevision, lockSHA256: digest(join(source, 'bun.lock')), wasmSHA256: digest(join(source, 'persistent-core.wasm')) });
    return;
  }
  const built = read(join(evidence, 'built.json'));
  assert.deepEqual(modules, built.modules, 'Built module bytes changed');
  assert.equal(digest(join(source, 'persistent-core.wasm')), built.wasmSHA256);
  assert.equal(digest(join(source, 'bun.lock')), built.lockSHA256);
  if (command === 'measure') {
    const expected = { MEMORY_SOURCE: protocol.candidateCommit, MEMORY_ENTRIES: '100000', MEMORY_TRIALS: '3', MEMORY_READERS: '0,2,4', MEMORY_FIXTURES: 'repeated,unique,unicode', MEMORY_KINDS: 'shared,immutable,native,centralized' };
    for (const [name, value] of Object.entries(expected)) assert.equal(process.env[name], value);
    assert.equal(resolve(source, process.env.MEMORY_OUT), join(evidence, 'raw'));
    assert.ok(!existsSync(join(evidence, 'raw')), 'Refuse to reuse prior samples');
    execFileSync(process.execPath, ['proofs/investigation-memory.mjs'], { cwd: source, stdio: 'inherit', env: process.env, timeout: 10 * 60 * 1000 });
    return;
  }
  const result = auditRaw(source, join(evidence, 'raw'));
  assert.deepEqual(sorted(result.summary.hashes), built.modules, 'Measured modules differ from built modules');
  // The unmodified driver checks every query against the independent reference.
  // This separate pass recomputes every signed memory total and grouped median.
  const { summary } = result;
  const chart = read(join(source, 'website/memory-chart-data.json'));
  const record = read(join(source, 'website/recorded-memory.json'));
  for (const key of ['schema', 'runtime', 'v8', 'platform', 'arch', 'cpu', 'measuredAt', 'trials', 'entries', 'runtimeSourceCommit']) chart[key] = record[key] = summary[key];
  chart.summarySHA256 = record.summarySHA256 = result.summarySHA256;
  const get = (kind, fixture, readers) => summary.summary.find(group => group.kind === kind && group.fixture === fixture && group.readers === readers && group.stage === 'queried');
  for (const group of chart.groups) group.samples = get(group.kind, group.fixture, group.readers).samples.map(({ trial, retainedBytes, rssBytes }) => ({ trial, retainedBytes, rssBytes }));
  for (const row of record.rows) for (const kind of protocol.kinds) row[kind] = get(kind, row.fixture, kind === 'centralized' ? 0 : 2).medians.retainedBytes;
  const review = join(evidence, 'review'); mkdirSync(review);
  write(join(review, 'memory-chart-data.json'), chart);
  write(join(review, 'recorded-memory.json'), record);
  write(join(evidence, 'audit.json'), { passed: true, sourceCommit: sourceState.commit, sourceTree: sourceState.tree, summarySHA256: result.summarySHA256, rawRuns: result.rawRuns, stateSamples: result.stateSamples, chartGroups: chart.groups.length, methodUnchanged: true, result: 'Current memory chart evidence; no heap insertion attribution or performance clearance.', limits: protocol.limits });
  console.log(`Verified ${result.rawRuns} raw runs and ${result.stateSamples} state samples; existing chart data is ready for review.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, source, evidence] = process.argv.slice(2);
  assert.ok(command && source && (command === 'check-plan' || evidence), 'Usage: node proofs/heap-memory-chart-proof.mjs command source [evidence]');
  await run(command, resolve(source), evidence ? resolve(evidence) : undefined);
}
