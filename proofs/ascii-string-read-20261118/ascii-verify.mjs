#!/usr/bin/env node
// Independent, read-only audit of completed ASCII string studies. No workload
// is imported or executed. Integrity counts are recorded claims; actual timed
// strings are checked by the workload, not reconstructed by this verifier.
// Usage: node ascii-verify.mjs report.json[.gz] [--driver benchmark.mjs]
//   [--workloads ascii-workloads.mjs] [--baseline checkout] [--candidate checkout]
//   [--manifest-only]
// Default: hash every source/bundle file at the recorded checkout paths.
// --manifest-only skips those contents, but still verifies both harness files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const script = fileURLToPath(import.meta.url), directory = dirname(script);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (actual, expected, label) => assert.deepStrictEqual(actual, expected, label);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value > 0;
const median = values => {
  const ordered = [...values].sort((a, b) => a - b), middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

// Fixed independently of both the report catalog and workload implementation.
const catalog = [
  ['list.string.get', 'ascii16', 'cold'], ['list.string.get', 'ascii32', 'cold'],
  ['list.string.get', 'ascii16', 'over-cap', true], ['list.string.get', 'ascii16', 'warm'],
  ['list.string.get', 'boundaries', 'cold'], ['list.string.get', 'unicode', 'cold'],
  ['list.string.get', 'ascii64', 'cold'], ['map.keys', 'ascii16', 'cold'],
  ['map.keys', 'ascii32', 'cold'], ['map.keys', 'ascii16', 'over-cap'],
  ['map.keys', 'ascii16', 'warm'], ['map.keys', 'boundaries', 'cold'], ['map.keys', 'unicode', 'cold'],
].map(([group, style, mode, shuffled]) => ({ name: `${group}.${style}.${mode}`, group, style, mode,
  count: mode === 'warm' ? 1024 : 8192, ...(shuffled ? { shuffled: true } : {}) }));
const byteLengths = {
  ascii16: [16], ascii32: [32], ascii64: [64],
  boundaries: [3, 4, 5, 7, 8, 15, 16, 31, 32, 33, 64], unicode: [8, 9, 10, 11, 12, 30],
};

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
  assert(typeof variant.path === 'string' && variant.path.length > 0, 'Missing checkout path');
  assert(typeof variant.commit === 'string' && /^[a-f0-9]{40}$/.test(variant.commit), 'Invalid recorded commit');
  assert(sha(variant.trackedDiffSha256), 'Invalid tracked diff digest');
  assert(typeof variant.status === 'string', 'Missing recorded checkout status');
  assert(variant.dependencyVersions && typeof variant.dependencyVersions === 'object' && !Array.isArray(variant.dependencyVersions)
    && Object.keys(variant.dependencyVersions).length > 0
    && Object.values(variant.dependencyVersions).every(version => typeof version === 'string' && version.length > 0), 'Invalid dependency versions');
  for (const [field, digest] of [['source', 'sourceManifestSha256'], ['bundles', 'bundleManifestSha256']]) {
    const entries = variant[field];
    assert(Array.isArray(entries) && entries.length > 0, `Missing ${field} manifest`);
    const names = entries.map(entry => entry.file);
    same(names, [...new Set(names)].sort(), `Duplicate or unsorted ${field} paths`);
    assert(sha(variant[digest]), `Invalid ${field} manifest digest`);
    same(hash(JSON.stringify(entries)), variant[digest], `${field} manifest digest`);
    for (const entry of entries) {
      assert(typeof entry.file === 'string' && entry.file.length > 0 && !isAbsolute(entry.file)
        && !entry.file.split('/').some(part => !part || part === '.' || part === '..')
        && !entry.file.includes('\\'), 'Unsafe manifest path');
      assert(sha(entry.sha256), `Invalid file digest: ${entry.file}`);
      same(Object.keys(entry).sort(), field === 'source' ? ['file', 'sha256'] : ['bytes', 'file', 'sha256'], 'Manifest entry fields');
      if (field === 'bundles') {
        assert(entry.file.startsWith('dist/') && entry.file.endsWith('.js'), 'Unexpected bundle path');
        assert(integer(entry.bytes), 'Invalid bundle byte count');
      }
      if (contents) {
        const bytes = readFileSync(join(root, entry.file));
        same(hash(bytes), entry.sha256, `File hash: ${join(root, entry.file)}`);
        if (field === 'bundles') same(bytes.length, entry.bytes, `Bundle length: ${entry.file}`);
      }
    }
  }
  assert(variant.bundles.some(entry => entry.file === 'dist/shared.js'), 'Missing portable entry');
  for (const name of ['arena.ts', 'shared.ts', 'shared-list.ts', 'shared-map.ts', 'utf8.ts', 'persistent-core.wasm', 'package.json', 'rust/wasm-abi.json']) {
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

export function verifyReport(report, options = {}) {
  const settings = { driver: join(directory, 'benchmark.mjs'), workloads: join(directory, 'ascii-workloads.mjs'), manifestOnly: false, ...options };
  same(report.schema, 'zerocopy-followup-performance/v1', 'Report schema');
  same(report.complete, true, 'Incomplete reports are not performance evidence');
  assert(!Object.hasOwn(report, 'error'), 'Completed report contains an error');
  assert(Number.isFinite(Date.parse(report.startedAt)) && Date.parse(report.finishedAt) >= Date.parse(report.startedAt), 'Invalid report dates');
  assert(integer(report.pairs) && report.pairs <= 30, 'Invalid pair count');
  assert(Array.isArray(report.runtimes) && report.runtimes.length > 0 && new Set(report.runtimes).size === report.runtimes.length
    && report.runtimes.every(runtime => ['node', 'bun'].includes(runtime)), 'Invalid runtime coverage');
  const environment = report.environment;
  same(environment?.allowedCpus, '2', 'Predeclared controller CPU affinity');
  for (const field of ['platform', 'release', 'architecture']) assert(typeof environment?.[field] === 'string' && environment[field].length > 0, `Missing environment ${field}`);
  assert(Array.isArray(environment.cpus) && environment.cpus.length > 0
    && environment.cpus.every(cpu => typeof cpu.model === 'string' && Number.isFinite(cpu.speed) && cpu.speed >= 0), 'Invalid CPU metadata');
  assert(integer(environment.totalMemoryBytes) && Number.isSafeInteger(environment.freeMemoryBytesAtStart)
    && environment.freeMemoryBytesAtStart >= 0 && environment.freeMemoryBytesAtStart <= environment.totalMemoryBytes, 'Invalid environment memory metadata');
  for (const field of ['loadAtStart', 'loadAtEnd']) assert(Array.isArray(environment[field]) && environment[field].length === 3
    && environment[field].every(value => Number.isFinite(value) && value >= 0), `Invalid environment ${field}`);
  same(report.catalog, catalog, 'Fixed workload catalog');
  const config = report.config;
  assert(Number.isSafeInteger(config.warmups) && config.warmups >= 0 && config.warmups <= 64, 'Invalid warmup count');
  assert(Number.isFinite(config.batchScale) && config.batchScale > 0 && config.batchScale <= 64, 'Invalid batch scale');
  assert(Array.isArray(config.only) && new Set(config.only).size === config.only.length
    && config.only.every(name => catalog.some(item => item.name === name)), 'Invalid selected cases');
  const selected = catalog.filter(item => !config.only.length || config.only.includes(item.name));
  same(config.caseNames, selected.map(item => item.name), 'Selected case order');
  assert(sha(report.harness.driverSha256) && sha(report.harness.workloadsSha256), 'Invalid harness digest');
  same(hash(readFileSync(settings.driver)), report.harness.driverSha256, 'Controller hash');
  same(hash(readFileSync(settings.workloads)), report.harness.workloadsSha256, 'Workload hash');
  same(Object.keys(report.variants).sort(), ['baseline', 'candidate'], 'Variant coverage');
  for (const name of ['baseline', 'candidate']) verifyManifest(report.variants[name], settings[name] ?? report.variants[name].path, !settings.manifestOnly);
  const a = report.variants.baseline, b = report.variants.candidate;
  same(a.dependencyVersions, b.dependencyVersions, 'Dependencies changed between variants');
  same(a.source.map(entry => entry.file), b.source.map(entry => entry.file), 'Source coverage differs between variants');
  // This study changes only Arena.string; UTF-8 helpers and WASM stay identical.
  same(a.source.filter(entry => entry.file !== 'arena.ts'), b.source.filter(entry => entry.file !== 'arena.ts'), 'Unexpected source/WASM change');

  same(report.samples.length, report.runtimes.length * report.pairs * 2, 'Sample count');
  const observed = new Map(), versions = new Map(), sourceSizes = new Map();
  let cursor = 0, totalRows = 0, totalValues = 0, totalStates = 0;
  for (const runtime of report.runtimes) for (let pair = 0; pair < report.pairs; pair++) {
    for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const sample = report.samples[cursor++];
      same([sample.runtime, sample.pair, sample.variant], [runtime, pair, variant], 'Paired sample order');
      same(sample.allowedCpus, '2', 'Predeclared worker CPU affinity');
      same(sample.gcAvailable, true, 'Explicit garbage collection unavailable');
      assert(typeof sample.versions?.node === 'string', 'Missing runtime version');
      assert(runtime === 'bun' ? typeof sample.versions.bun === 'string' : sample.versions.bun === undefined, 'Runtime identity mismatch');
      if (versions.has(runtime)) same(sample.versions, versions.get(runtime), 'Runtime changed during study');
      else versions.set(runtime, sample.versions);
      const rotation = pair % selected.length, order = [...selected.slice(rotation), ...selected.slice(0, rotation)];
      same(sample.rows.map(row => row.name), order.map(item => item.name), 'Rotated workload order/coverage');
      for (let position = 0; position < order.length; position++) {
        const item = order[position], row = sample.rows[position], list = item.group === 'list.string.get';
        const iterations = Math.max(1, Math.ceil(262144 * config.batchScale / item.count));
        const operations = iterations * item.count, measured = item.mode === 'cold' ? iterations : 1;
        const arenas = measured + config.warmups;
        assert(Number.isFinite(row.elapsedMs) && row.elapsedMs > 0, `Invalid elapsed time: ${item.name}`);
        const expected = {
          operations, millisecondsPer10000: row.elapsedMs / operations * 10000,
          operation: list ? 'ordinary string List.get' : 'ordinary Map key yielded', count: item.count, iterations,
          actualTimedValuesVerified: operations, rawValuesRetained: 'ordinary Arrays', exactStringTypesAndValuesVerified: true,
          ordinaryGet: list, ordinaryMapKeys: !list, freshReaderPerIteration: item.mode === 'cold', attachmentTimed: false,
          primedReader: item.mode !== 'cold', cacheMode: item.mode, stringCacheEntryLimit: 2048,
          fixtureDistinctStrings: item.count, fixtureByteLengths: byteLengths[item.style],
          order: list && item.shuffled ? 'fixed shuffled permutation' : list ? 'sequential' : 'Map key iteration',
          distinctReaderArenasChecked: arenas, distinctMeasuredReaderArenasChecked: measured,
          distinctWarmupReaderArenasChecked: config.warmups, uniqueMemoriesByteChecked: 1,
          distinctReaderWasmInstancesChecked: arenas, readerArenaAllocationBytes: 0, sharedBytesUnchanged: true,
        };
        for (const [field, value] of Object.entries(expected)) same(row[field], value, `${item.name}: ${field}`);
        assert(Number.isSafeInteger(row.sharedUsedBytes) && row.sharedUsedBytes >= 65536
          && Number.isSafeInteger(row.sharedCapacityBytes) && row.sharedCapacityBytes >= row.sharedUsedBytes
          && row.sharedCapacityBytes <= 256 * 1024 * 1024 && row.sharedCapacityBytes % 65536 === 0, 'Invalid shared memory dimensions');
        const sizes = [row.sharedUsedBytes, row.sharedCapacityBytes];
        if (sourceSizes.has(item.name)) same(sizes, sourceSizes.get(item.name), 'Source memory dimensions changed');
        else sourceSizes.set(item.name, sizes);
        observed.set(`${runtime}:${pair}:${variant}:${item.name}`, row);
        totalRows++; totalValues += operations; totalStates += arenas;
      }
    }
  }
  const recomputedSummary = [];
  for (const runtime of report.runtimes) for (const item of selected) {
    const baseline = [], candidate = [], ratios = [];
    for (let pair = 0; pair < report.pairs; pair++) {
      baseline.push(observed.get(`${runtime}:${pair}:baseline:${item.name}`));
      candidate.push(observed.get(`${runtime}:${pair}:candidate:${item.name}`));
      const ratio = candidate[pair].elapsedMs / baseline[pair].elapsedMs;
      assert(Number.isFinite(ratio) && ratio > 0, 'Invalid paired ratio'); ratios.push(ratio);
    }
    const times = [...baseline, ...candidate].map(row => row.elapsedMs);
    recomputedSummary.push({ runtime, name: item.name,
      baselineMedianMsPer10000: median(baseline.map(row => row.elapsedMs / row.operations * 10000)),
      candidateMedianMsPer10000: median(candidate.map(row => row.elapsedMs / row.operations * 10000)),
      pairedRatios: ratios, medianPairedRatio: median(ratios), candidateFasterPairs: ratios.filter(ratio => ratio < 1).length,
      minimumBatchMs: Math.min(...times), shortBatchWarning: times.some(value => value < 20),
    });
  }
  same(report.summary, recomputedSummary, 'Recomputed complete summary');
  return { samples: cursor, rows: totalRows, cases: selected.length, summaries: recomputedSummary.length,
    timedValueVerificationClaimsChecked: totalValues, readerArenaVerificationClaimsChecked: totalStates,
    sourceAndBundleContentsChecked: !settings.manifestOnly, harnessContentsChecked: true,
    scope: 'Checks frozen-file hashes, recorded integrity counts and summary arithmetic; does not rerun timed reads.',
    recomputedSummary };
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    const args = process.argv.slice(2), reportPath = args.shift();
    assert(reportPath && !reportPath.startsWith('--'), 'Pass a completed JSON or gzip report');
    const options = {};
    while (args.length) {
      const option = args.shift();
      if (option === '--manifest-only') { options.manifestOnly = true; continue; }
      assert(['--driver', '--workloads', '--baseline', '--candidate'].includes(option) && args.length && !args[0].startsWith('--'), `Invalid option: ${option}`);
      options[option.slice(2)] = resolve(args.shift());
    }
    const input = readFileSync(reportPath), bytes = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input) : input;
    const { recomputedSummary, ...result } = verifyReport(JSON.parse(bytes.toString('utf8')), options);
    process.stdout.write(`${JSON.stringify({ valid: true, report: resolve(reportPath), reportSha256: hash(bytes), ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`ASCII evidence verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
