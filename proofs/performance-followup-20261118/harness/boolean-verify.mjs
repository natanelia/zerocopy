#!/usr/bin/env node
// Read-only verification of completed Boolean List studies; never imports a workload or
// executes a collection. Recorded raw-value claims are checked against the
// fixed workload dimensions, not recreated from an already-primed reader.
// Usage: node boolean-verify.mjs report.json[.gz] [--driver benchmark.mjs]
//   [--workloads boolean-workloads.mjs] [--baseline checkout] [--candidate checkout]
//   [--manifest-only]
// By default every source/bundle file is hashed against the recorded checkout
// path. --manifest-only checks manifest structure/digests, not file contents;
// driver and workload file hashes are always checked.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const directory = dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (actual, expected, label) => assert.deepStrictEqual(actual, expected, label);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const median = values => {
  const ordered = values.slice().sort((a, b) => a - b), middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

// Independently fixed catalog; do not import the benchmark's cases or helpers.
const catalog = [];
function add(type, size, style, mode) {
  catalog.push({ name: `list.${type}.get.${style}.${size}.${mode}`, type, size, style, mode });
}
for (const size of [31, 32, 33, 8192]) for (const style of ['sequential', 'shuffled', 'tail']) {
  for (const mode of ['fresh', 'warm']) add('boolean', size, style, mode);
}
for (const type of ['number', 'string', 'object']) for (const style of ['sequential', 'shuffled']) {
  for (const mode of ['fresh', 'warm']) add(type, type !== 'number' && mode === 'warm' ? 1024 : 8192, style, mode);
}
const tailIndexes = { 31: 4, 32: 4, 33: 3, 8192: 6 };
// scripts/build-wasm.mjs copies the canonical core to exactly these legacy
// names. The portable browser build embeds canonical artifacts directly.
const compatibilityAliases = new Set([
  'shared-map.wasm', 'shared-list.wasm', 'linked-list.wasm', 'singly-linked-list.wasm',
  'doubly-linked-list.wasm', 'ordered-map.wasm', 'sorted-tree.wasm', 'priority-queue.wasm',
]);

function optionalAliases(variant) {
  const core = variant.source.find(entry => entry.file === 'persistent-core.wasm');
  assert(core, 'Missing canonical persistent core');
  const aliases = variant.source.filter(entry => compatibilityAliases.has(entry.file));
  for (const alias of aliases) same(alias.sha256, core.sha256, `Compatibility alias differs from canonical core: ${alias.file}`);
  return aliases;
}

function files(root, relative = '') {
  const result = [];
  for (const item of readdirSync(join(root, relative), { withFileTypes: true })) {
    const name = join(relative, item.name);
    if (item.isDirectory()) result.push(...files(root, name));
    else if (item.isFile()) result.push(name);
  }
  return result.sort();
}
function verifyManifest(variant, root, contents) {
  assert(/^[a-f0-9]{40}$/.test(variant.commit), 'Invalid recorded commit');
  assert(sha(variant.trackedDiffSha256), 'Invalid tracked diff digest');
  assert(typeof variant.status === 'string', 'Missing recorded checkout status');
  for (const [field, digest] of [['source', 'sourceManifestSha256'], ['bundles', 'bundleManifestSha256']]) {
    const entries = variant[field];
    assert(Array.isArray(entries) && entries.length > 0, `Missing ${field} manifest`);
    const names = entries.map(entry => entry.file);
    same(names, [...new Set(names)].sort(), `Duplicate or unsorted ${field} paths`);
    same(hash(JSON.stringify(entries)), variant[digest], `${field} manifest digest`);
    for (const entry of entries) {
      assert(typeof entry.file === 'string' && entry.file.length > 0 && !isAbsolute(entry.file)
        && !entry.file.split('/').some(part => !part || part === '.' || part === '..')
        && !entry.file.includes('\\'), 'Unsafe manifest path');
      assert(sha(entry.sha256), `Invalid digest: ${entry.file}`);
      same(Object.keys(entry).sort(), (field === 'source' ? ['file', 'sha256'] : ['bytes', 'file', 'sha256']), 'Manifest entry fields');
      if (field === 'bundles') {
        assert(entry.file.startsWith('dist/') && entry.file.endsWith('.js'), 'Unexpected bundle path');
        assert(positiveInteger(entry.bytes), 'Invalid bundle byte count');
      }
      if (contents) {
        const bytes = readFileSync(join(root, entry.file));
        same(hash(bytes), entry.sha256, `File hash: ${join(root, entry.file)}`);
        if (field === 'bundles') same(bytes.length, entry.bytes, `Bundle length: ${entry.file}`);
      }
    }
  }
  assert(variant.bundles.some(entry => entry.file === 'dist/shared.js'), 'Missing portable entry');
  for (const name of ['arena.ts', 'shared.ts', 'shared-list.ts', 'persistent-core.wasm', 'package.json', 'rust/wasm-abi.json']) {
    assert(variant.source.some(entry => entry.file === name), `Missing source: ${name}`);
  }
  if (contents) {
    const expectedSource = [
      ...readdirSync(root).filter(name => (name.endsWith('.ts') && !name.endsWith('.test.ts')) || name.endsWith('.wasm')),
      ...files(join(root, 'rust', 'src')).map(name => `rust/src/${name}`),
      'package.json', 'rust/Cargo.toml', 'rust/Cargo.lock', 'rust-toolchain.toml', 'rust/wasm-abi.json',
      'scripts/build-wasm.mjs', 'scripts/rust-wasm.mjs', 'scripts/build-browser.ts',
    ].sort();
    same(variant.source.map(entry => entry.file), expectedSource, 'Complete source inventory');
    same(variant.bundles.map(entry => entry.file), files(join(root, 'dist')).filter(file => file.endsWith('.js')).map(file => `dist/${file}`), 'Complete bundle inventory');
    same(variant.dependencyVersions, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies, 'Dependency versions');
  }
}

function verify(report, options) {
  same(report.schema, 'zerocopy-followup-performance/v1', 'Report schema');
  same(report.complete, true, 'Incomplete reports are not performance evidence');
  assert(!Object.hasOwn(report, 'error'), 'Completed report contains an error');
  assert(Number.isFinite(Date.parse(report.startedAt)) && Date.parse(report.finishedAt) >= Date.parse(report.startedAt), 'Invalid report dates');
  assert(positiveInteger(report.pairs) && report.pairs <= 30, 'Invalid pair count');
  assert(Array.isArray(report.runtimes) && report.runtimes.length > 0 && new Set(report.runtimes).size === report.runtimes.length
    && report.runtimes.every(runtime => ['node', 'bun'].includes(runtime)), 'Invalid runtime coverage');
  same(report.catalog, catalog, 'Fixed workload catalog');
  const config = report.config;
  assert(Number.isSafeInteger(config.warmups) && config.warmups >= 0 && config.warmups <= 64, 'Invalid warmup count');
  assert(Number.isFinite(config.batchScale) && config.batchScale > 0 && config.batchScale <= 64, 'Invalid batch scale');
  assert(Array.isArray(config.only) && new Set(config.only).size === config.only.length
    && config.only.every(name => catalog.some(item => item.name === name)), 'Invalid selected cases');
  const selected = catalog.filter(item => !config.only.length || config.only.includes(item.name));
  assert(selected.length > 0, 'No selected cases');
  same(config.caseNames, selected.map(item => item.name), 'Selected case order');
  same(hash(readFileSync(options.driver)), report.harness.driverSha256, 'Controller hash');
  same(hash(readFileSync(options.workloads)), report.harness.workloadsSha256, 'Workload hash');
  same(Object.keys(report.variants).sort(), ['baseline', 'candidate'], 'Variant coverage');
  for (const name of ['baseline', 'candidate']) verifyManifest(report.variants[name], options[name] ?? report.variants[name].path, !options.manifestOnly);
  const a = report.variants.baseline, b = report.variants.candidate;
  const optionalCompatibilityAliases = { baseline: optionalAliases(a), candidate: optionalAliases(b) };
  const nonAliases = variant => variant.source.filter(entry => !compatibilityAliases.has(entry.file));
  same(a.dependencyVersions, b.dependencyVersions, 'Dependencies changed between variants');
  same(nonAliases(a).map(entry => entry.file), nonAliases(b).map(entry => entry.file), 'Nonalias source coverage differs between variants');
  // This study changes only SharedList's TypeScript Boolean read path. Other runtime source
  // and every canonical WASM artifact must remain identical, including A/A.
  same(nonAliases(a).filter(entry => entry.file !== 'shared-list.ts'), nonAliases(b).filter(entry => entry.file !== 'shared-list.ts'), 'Unexpected source/WASM change');

  same(report.samples.length, report.runtimes.length * report.pairs * 2, 'Sample count');
  const observed = new Map(), versions = new Map(), sourceSizes = new Map();
  let cursor = 0, totalRows = 0, totalRawValues = 0, totalStates = 0;
  for (const runtime of report.runtimes) for (let pair = 0; pair < report.pairs; pair++) {
    for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const sample = report.samples[cursor++];
      same([sample.runtime, sample.pair, sample.variant], [runtime, pair, variant], 'Paired sample order');
      same(sample.gcAvailable, true, 'Explicit garbage collection unavailable');
      assert(typeof sample.versions?.node === 'string', 'Missing runtime version');
      assert(runtime === 'bun' ? typeof sample.versions.bun === 'string' : sample.versions.bun === undefined, 'Runtime identity mismatch');
      if (versions.has(runtime)) same(sample.versions, versions.get(runtime), 'Runtime changed during study');
      else versions.set(runtime, sample.versions);
      const rotation = pair % selected.length, order = [...selected.slice(rotation), ...selected.slice(0, rotation)];
      same(sample.rows.map(row => row.name), order.map(item => item.name), 'Rotated workload order/coverage');
      for (let position = 0; position < order.length; position++) {
        const item = order[position], row = sample.rows[position];
        const iterations = Math.max(1, Math.ceil(262144 * config.batchScale / item.size));
        const calls = iterations * item.size, measuredArenas = item.mode === 'fresh' ? iterations : 1;
        const arenas = measuredArenas + config.warmups;
        assert(Number.isFinite(row.elapsedMs) && row.elapsedMs > 0, `Invalid elapsed time: ${item.name}`);
        const expected = {
          operations: calls, millisecondsPer10000: row.elapsedMs / calls * 10000,
          operation: `ordinary ${item.type} List.get`, type: item.type, size: item.size, iterations,
          actualTimedValuesVerified: calls, rawValuesRetained: 'ordinary Arrays', exactTypesAndValuesVerified: true,
          frozenObjectsVerified: item.type === 'object', ordinaryGet: true,
          distinctIndexesRead: item.style === 'tail' ? tailIndexes[item.size] : item.size,
          freshReaderPerIteration: item.mode === 'fresh', attachmentTimed: false, primedReader: item.mode === 'warm',
          readerMode: item.mode, order: item.style, tinyBatch: row.elapsedMs < 20, minimumBatchMs: 20,
          distinctReaderArenasChecked: arenas, distinctMeasuredReaderArenasChecked: measuredArenas,
          distinctWarmupReaderArenasChecked: config.warmups, uniqueMemoriesByteChecked: 1,
          distinctReaderWasmInstancesChecked: arenas, readerArenaAllocationBytes: 0, sharedBytesUnchanged: true,
        };
        for (const [key, value] of Object.entries(expected)) same(row[key], value, `${item.name}: ${key}`);
        assert(Number.isSafeInteger(row.sharedUsedBytes) && row.sharedUsedBytes >= 65536
          && Number.isSafeInteger(row.sharedCapacityBytes) && row.sharedCapacityBytes >= row.sharedUsedBytes
          && row.sharedCapacityBytes <= 256 * 1024 * 1024 && row.sharedCapacityBytes % 65536 === 0, 'Invalid shared memory dimensions');
        const sizes = [row.sharedUsedBytes, row.sharedCapacityBytes];
        if (sourceSizes.has(item.name)) same(sizes, sourceSizes.get(item.name), 'Source memory dimensions changed');
        else sourceSizes.set(item.name, sizes);
        observed.set(`${runtime}:${pair}:${variant}:${item.name}`, row);
        totalRows++; totalRawValues += calls; totalStates += arenas;
      }
    }
  }
  const computed = [];
  for (const runtime of report.runtimes) for (const item of selected) {
    const base = [], candidate = [], ratios = [];
    for (let pair = 0; pair < report.pairs; pair++) {
      base.push(observed.get(`${runtime}:${pair}:baseline:${item.name}`));
      candidate.push(observed.get(`${runtime}:${pair}:candidate:${item.name}`));
      ratios.push(candidate[pair].elapsedMs / base[pair].elapsedMs);
    }
    const times = [...base, ...candidate].map(row => row.elapsedMs);
    computed.push({ runtime, name: item.name,
      baselineMedianMsPer10000: median(base.map(row => row.millisecondsPer10000)),
      candidateMedianMsPer10000: median(candidate.map(row => row.millisecondsPer10000)),
      pairedRatios: ratios, medianPairedRatio: median(ratios), candidateFasterPairs: ratios.filter(ratio => ratio < 1).length,
      minimumBatchMs: Math.min(...times), shortBatchWarning: times.some(value => value < 20),
    });
  }
  same(report.summary, computed, 'Recomputed complete summary');
  return { samples: cursor, rows: totalRows, cases: selected.length, summaries: computed.length,
    timedValueVerificationClaimsChecked: totalRawValues, readerArenaVerificationClaimsChecked: totalStates,
    sourceAndBundleContentsChecked: !options.manifestOnly, harnessContentsChecked: true,
    optionalCompatibilityAliases,
    compatibilityAliasNote: 'Only the eight documented compatibility aliases may be optional; every present alias hashes exactly to persistent-core.wasm. Measured portable dist embeds canonical files, and every recorded bundle is still verified.',
    scope: 'Validates frozen-file hashes, recorded integrity counts and summary arithmetic; does not rerun timed reads.' };
}

try {
  const args = process.argv.slice(2), reportPath = args.shift();
  assert(reportPath && !reportPath.startsWith('--'), 'Pass a completed JSON or gzip report');
  const options = { driver: join(directory, 'benchmark.mjs'), workloads: join(directory, 'boolean-workloads.mjs'), manifestOnly: false };
  while (args.length) {
    const option = args.shift();
    if (option === '--manifest-only') { options.manifestOnly = true; continue; }
    assert(['--driver', '--workloads', '--baseline', '--candidate'].includes(option) && args.length && !args[0].startsWith('--'), `Invalid option: ${option}`);
    options[option.slice(2)] = resolve(args.shift());
  }
  const input = readFileSync(reportPath), bytes = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input) : input;
  const result = verify(JSON.parse(bytes.toString('utf8')), options);
  process.stdout.write(`${JSON.stringify({ valid: true, report: resolve(reportPath), reportSha256: hash(bytes), ...result }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Boolean List evidence verification failed: ${error.message}\n`);
  process.exitCode = 1;
}
