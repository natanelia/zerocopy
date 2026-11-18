#!/usr/bin/env node
/**
 * Read-only consistency audit of archived benchmark JSON or JSON.gz reports.
 * Usage: node verify.mjs [--json] report.json [report.json.gz ...]
 *
 * This checks internal evidence consistency, not the authenticity of an archive
 * or statistical significance. It does not reread checkout paths, run workloads,
 * alter results, or trust summary statistics instead of recomputing them.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const sameNumber = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >>> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = (runtime, name) => JSON.stringify([runtime, name]);
const sampleKey = sample => JSON.stringify([sample.runtime, sample.pair, sample.variant]);
const sameNames = (actual, expected) => actual.length === expected.length && [...actual].sort().every((name, index) => name === [...expected].sort()[index]);
// Independent, fixed catalog for this study. Unknown workload revisions require
// an explicit verifier update instead of silently accepting a smaller matrix.
const WORKLOADS_SHA256 = 'bfa82185019b81a1a115650464b81aecb341ba22126567745978d3039f3e844f';
const catalog = new Map([
  ...[0, 4, 8, 16, 64, 256, 4096].flatMap(bytes => ['string', 'after'].map(operation =>
    [`json-string.${operation}.ascii.${bytes}`, { bytes, operation }])),
  ...['unicode', 'escaped'].flatMap(style => [256, 4096].flatMap(bytes => ['string', 'after'].map(operation =>
    [`json-string.${operation}.${style}.${bytes}`, { bytes, operation }]))),
  ['json-string.first-number.key2', { bytes: 0, operation: 'first' }],
  ['json-string.first-number.key8', { bytes: 0, operation: 'first' }],
  ['json-string.missing.small', { bytes: 0, operation: 'missing' }],
]);


export function verifyReport(report) {
  const issues = [], recomputedSummary = [];
  const check = (condition, label) => { if (!condition) issues.push(label); return condition; };
  if (!check(object(report), 'Report must be an object')) return { verified: false, issues, recomputedSummary };
  check(report.schema === 'zerocopy-paired-public-api/v1', 'Unsupported report schema');
  check(report.complete === true, 'Report is incomplete');
  const validPairs = check(positiveInteger(report.pairs) && report.pairs <= 30, 'pairs must be an integer from 1 through 30');
  const validRuntimes = check(Array.isArray(report.runtimes) && report.runtimes.length > 0
    && report.runtimes.every(name => ['node', 'bun', 'chromium'].includes(name))
    && new Set(report.runtimes).size === report.runtimes.length, 'runtimes must be a unique nonempty supported-runtime array');
  check(object(report.config), 'Missing workload configuration');
  check(object(report.harness) && isHash(report.harness.driverSha256) && isHash(report.harness.workloadsSha256), 'Invalid harness SHA-256 fields');
  check(report.harness?.workloadsSha256 === WORKLOADS_SHA256, 'Unknown workload catalog hash');
  check(Number.isFinite(report.config?.batchScale) && report.config.batchScale > 0 && report.config.batchScale <= 16, 'Invalid batch scale');
  check(Number.isFinite(Date.parse(report.startedAt)), 'Missing/invalid startedAt');
  check(Number.isFinite(Date.parse(report.finishedAt)), 'Missing/invalid finishedAt');

  for (const variant of ['baseline', 'candidate']) {
    const source = report.variants?.[variant];
    if (!check(object(source), `Missing ${variant} provenance`)) continue;
    check(source.commit === null || typeof source.commit === 'string' && /^[0-9a-f]{40}$/.test(source.commit), `${variant}: invalid commit identity`);
    check(isHash(source.trackedDiffSha256), `${variant}: invalid tracked-diff SHA-256`);
    for (const [field, digestField] of [['source', 'sourceManifestSha256'], ['bundles', 'bundleManifestSha256']]) {
      const entries = source[field];
      if (!check(Array.isArray(entries) && entries.length > 0, `${variant}: missing ${field} manifest`)) continue;
      const names = new Set();
      for (const [index, entry] of entries.entries()) {
        const label = `${variant}.${field}[${index}]`;
        if (!check(object(entry), `${label}: invalid entry`)) continue;
        check(typeof entry.file === 'string' && entry.file.length > 0 && !names.has(entry.file), `${label}: missing/duplicate filename`);
        names.add(entry.file);
        check(isHash(entry.sha256), `${label}: invalid SHA-256`);
        if (field === 'bundles') check(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0, `${label}: invalid byte length`);
      }
      check(isHash(source[digestField]) && source[digestField] === sha256(JSON.stringify(entries)), `${variant}: ${field} manifest digest mismatch`);
      if (field === 'bundles') check(names.has('dist/shared.js'), `${variant}: missing public shared.js bundle`);
    }
  }

  if (!check(Array.isArray(report.samples), 'samples must be an array') || !validPairs || !validRuntimes) {
    return { verified: false, issues, recomputedSummary };
  }
  check(report.samples.length === report.runtimes.length * report.pairs * 2, 'Sample count does not match runtimes × pairs × 2');
  const samples = new Map(), rowsBySample = new Map(), referenceVersions = new Map();
  let caseNames;
  for (const [index, sample] of report.samples.entries()) {
    const label = `samples[${index}]`;
    if (!check(object(sample), `${label}: invalid sample`)) continue;
    check(report.runtimes.includes(sample.runtime), `${label}: undeclared runtime`);
    check(Number.isSafeInteger(sample.pair) && sample.pair >= 0 && sample.pair < report.pairs, `${label}: pair index out of range`);
    check(['baseline', 'candidate'].includes(sample.variant), `${label}: invalid variant`);
    const identity = sampleKey(sample);
    check(!samples.has(identity), `${label}: duplicate runtime/pair/variant`); samples.set(identity, sample);
    check(typeof sample.gcAvailable === 'boolean', `${label}: missing GC-availability metadata`);
    check(object(sample.versions), `${label}: missing runtime version metadata`);
    const version = JSON.stringify({ versions: sample.versions, gcAvailable: sample.gcAvailable });
    if (referenceVersions.has(sample.runtime)) check(referenceVersions.get(sample.runtime) === version, `${label}: runtime/GC metadata differs within runtime`);
    else referenceVersions.set(sample.runtime, version);
    if (!check(Array.isArray(sample.rows) && sample.rows.length > 0, `${label}: missing workload rows`)) continue;
    const rows = new Map(); rowsBySample.set(identity, rows);
    for (const [rowIndex, row] of sample.rows.entries()) {
      const rowLabel = `${label}.rows[${rowIndex}]`;
      if (!check(object(row), `${rowLabel}: invalid row`)) continue;
      if (!check(typeof row.name === 'string' && catalog.has(row.name), `${rowLabel}: invalid case name`)) continue;
      check(!rows.has(row.name), `${rowLabel}: duplicate case ${row.name}`); rows.set(row.name, row);
      check(finite(row.elapsedMs) && row.elapsedMs > 0, `${rowLabel}: elapsedMs must be finite and positive`);
      check(positiveInteger(row.operations), `${rowLabel}: operations must be a positive integer`);
      check(row.count === 1 && row.iterations === 64, `${rowLabel}: invalid count/iterations`);
      const item = catalog.get(row.name);
      const targetCalls = item.bytes <= 16 ? 1048576 : item.bytes <= 256 ? 262144 : item.operation === 'string' ? 16384 : 65536;
      const callsPerView = Math.max(1, Math.ceil(targetCalls * report.config?.batchScale / 64));
      check(row.serializedStringPayloadBytes === item.bytes, `${rowLabel}: payload size differs from catalog`);
      check(row.callsPerView === callsPerView && row.operations === 64 * callsPerView, `${rowLabel}: operations differ from workload dimensions`);
      check(sameNumber(row.millisecondsPer10000, row.elapsedMs / row.operations * 10000), `${rowLabel}: millisecondsPer10000 formula mismatch`);
      if (row.name?.startsWith('map.') || row.name?.startsWith('json-array.') || row.name?.startsWith('json-string.')) {
        check(row.sharedBytesUnchanged === true, `${rowLabel}: read did not attest unchanged shared bytes`);
        check(row.sharedArenaAllocationBytes === 0, `${rowLabel}: read shared allocation is not zero`);
        check(finite(row.checksum), `${rowLabel}: missing/nonfinite read checksum`);
      } else if (row.name?.startsWith('list.')) {
        check(row.sharedReaderVerified === true, `${rowLabel}: missing list reader verification`);
      }
    }
    const names = [...rows.keys()];
    if (caseNames) check(sameNames(names, caseNames), `${label}: case coverage differs between samples`);
    else caseNames = names;
  }
  caseNames ??= [];
  if (Array.isArray(report.config?.only) && report.config.only.length) check(sameNames(caseNames, report.config.only), 'Case names differ from config.only');
  if (report.config?.group) check(report.config.group === 'json-string' && caseNames.every(name => name.startsWith(`${report.config.group}.`)), 'Case names differ from config.group');
  if (!report.config?.only?.length) check(sameNames(caseNames, [...catalog.keys()]), 'Case names differ from the full frozen workload catalog');

  const summaryEntries = new Map();
  if (check(Array.isArray(report.summary), 'Missing summary array')) {
    check(report.summary.length === report.runtimes.length * caseNames.length, 'Summary case/runtime count mismatch');
    for (const [index, entry] of report.summary.entries()) {
      if (!check(object(entry), `summary[${index}]: invalid entry`)) continue;
      const identity = key(entry.runtime, entry.name);
      check(report.runtimes.includes(entry.runtime) && caseNames.includes(entry.name), `summary[${index}]: undeclared runtime/case`);
      check(!summaryEntries.has(identity), `summary[${index}]: duplicate runtime/case`); summaryEntries.set(identity, entry);
    }
  }
  const stableFields = ['operations', 'count', 'iterations', 'checksum', 'selectedIndexes', 'freshReaderPerIteration',
    'primedReader', 'ordinaryGet', 'freshViewPerIteration', 'operation', 'order', 'retainedPrefixCount',
    'callsPerView', 'field', 'style', 'serializedStringPayloadBytes', 'decodedStringCodeUnits'];
  for (const runtime of report.runtimes) {
    for (let pair = 0; pair < report.pairs; pair++) for (const variant of ['baseline', 'candidate']) {
      check(samples.has(JSON.stringify([runtime, pair, variant])), `Missing sample ${runtime}/${pair}/${variant}`);
    }
    for (const name of caseNames) {
      const baseline = [], candidate = []; let reference;
      for (let pair = 0; pair < report.pairs; pair++) for (const variant of ['baseline', 'candidate']) {
        const row = rowsBySample.get(JSON.stringify([runtime, pair, variant]))?.get(name);
        if (!check(row !== undefined, `Missing row ${runtime}/${pair}/${variant}/${name}`)) continue;
        if (reference) for (const field of stableFields) check(Object.is(row[field], reference[field]), `${runtime}/${pair}/${variant}/${name}: ${field} differs between paired/repeated workloads`);
        else reference = row;
        (variant === 'baseline' ? baseline : candidate).push(row);
      }
      if (baseline.length !== report.pairs || candidate.length !== report.pairs
        || [...baseline, ...candidate].some(row => !finite(row.elapsedMs) || row.elapsedMs <= 0 || !positiveInteger(row.operations))) continue;
      const ratios = candidate.map((row, pair) => row.elapsedMs / baseline[pair].elapsedMs);
      const recomputed = {
        runtime, name,
        baselineMedianMsPer10000: median(baseline.map(row => row.elapsedMs / row.operations * 10000)),
        candidateMedianMsPer10000: median(candidate.map(row => row.elapsedMs / row.operations * 10000)),
        pairedRatios: ratios, medianPairedRatio: median(ratios), candidateFasterPairs: ratios.filter(ratio => ratio < 1).length,
        minimumBatchMs: Math.min(...baseline.map(row => row.elapsedMs), ...candidate.map(row => row.elapsedMs)),
        shortBatchWarning: [...baseline, ...candidate].some(row => row.elapsedMs < 20),
      };
      recomputedSummary.push(recomputed);
      const claimed = summaryEntries.get(key(runtime, name));
      if (!check(claimed !== undefined, `Missing summary ${runtime}/${name}`)) continue;
      for (const field of ['baselineMedianMsPer10000', 'candidateMedianMsPer10000', 'medianPairedRatio', 'minimumBatchMs']) {
        check(sameNumber(claimed[field], recomputed[field]), `${runtime}/${name}: summary ${field} mismatch`);
      }
      for (const field of ['candidateFasterPairs', 'shortBatchWarning']) check(claimed[field] === recomputed[field], `${runtime}/${name}: summary ${field} mismatch`);
      check(Array.isArray(claimed.pairedRatios) && claimed.pairedRatios.length === ratios.length
        && ratios.every((ratio, pair) => sameNumber(claimed.pairedRatios[pair], ratio)), `${runtime}/${name}: summary pairedRatios mismatch`);
    }
  }
  return { verified: issues.length === 0, issues, schema: report.schema, pairs: report.pairs, runtimes: report.runtimes,
    sampleCount: report.samples.length, caseCount: caseNames.length, config: report.config,
    sourceCommits: Object.fromEntries(['baseline', 'candidate'].map(variant => [variant, report.variants?.[variant]?.commit])),
    bundleManifestSha256: Object.fromEntries(['baseline', 'candidate'].map(variant => [variant, report.variants?.[variant]?.bundleManifestSha256])),
    identicalBuilds: report.variants?.baseline?.bundleManifestSha256 === report.variants?.candidate?.bundleManifestSha256,
    recomputedSummary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), json = args.includes('--json'), paths = args.filter(arg => arg !== '--json');
  if (!paths.length) { process.stderr.write('Usage: node verify.mjs [--json] report.json [report.json.gz ...]\n'); process.exitCode = 2; }
  const audits = paths.map(path => {
    try {
      const input = readFileSync(path), compressed = path.endsWith('.gz') || input[0] === 0x1f && input[1] === 0x8b;
      const bytes = compressed ? gunzipSync(input, { maxOutputLength: 128 * 1024 * 1024 }) : input;
      return { path, archiveSha256: sha256(input), decodedJsonSha256: sha256(bytes), ...verifyReport(JSON.parse(bytes.toString('utf8'))) };
    } catch (error) { return { path, verified: false, issues: [error.message], recomputedSummary: [] }; }
  });
  if (audits.some(audit => !audit.verified)) process.exitCode = 1;
  if (json) process.stdout.write(`${JSON.stringify(audits, null, 2)}\n`);
  else for (const audit of audits) {
    process.stdout.write(`${audit.verified ? 'VERIFIED' : 'FAILED'} ${audit.path}\n`);
    for (const issue of audit.issues) process.stdout.write(`  ERROR: ${issue}\n`);
    if (audit.verified) process.stdout.write(`  ${audit.sampleCount} samples; ${audit.caseCount} cases; ${audit.pairs} pairs per runtime; identical builds: ${audit.identicalBuilds}\n`);
    for (const row of audit.recomputedSummary) process.stdout.write(`  ${row.runtime} ${row.name}: baseline ${row.baselineMedianMsPer10000.toFixed(6)}, candidate ${row.candidateMedianMsPer10000.toFixed(6)} ms/10k; median paired ratio ${row.medianPairedRatio.toFixed(6)}; faster ${row.candidateFasterPairs}/${audit.pairs}; minimum batch ${row.minimumBatchMs.toFixed(3)} ms${row.shortBatchWarning ? ' [SHORT]' : ''}\n`);
    process.stdout.write('  Consistency audit only; no statistical significance or cross-platform guarantee is inferred.\n');
  }
}
