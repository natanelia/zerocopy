// Prospective only. Importing or freezing this module performs no timing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CASES, CONFIG as ORIGINAL_CONFIG, makeSchedule, measureSingle, summarize } from './block-traversal-performance.mjs';
import { PIN, verifyHelpers } from './block-traversal-empty-controls.mjs';
import { sha256 } from './block-traversal-source.mjs';
import { replaceExactlyOnce } from './block-traversal-chromium-adapter.mjs';

export const IDENTITIES = JSON.parse(readFileSync(new URL('./block-portability-identities.json', import.meta.url)));
export const CONFIG = Object.freeze({ ...ORIGINAL_CONFIG, targetBatchMs: 40, warmupMs: 500,
  measuredBatchFloorMs: 10, measuredWarmupFloorMs: 150 });
export const SELECTION = Object.freeze([
  ['linked/number/0/append/toArray', 'Empty array control; original flagged family, new independent context.'],
  ['doubly/number/1/append/toArrayReverse', 'Singleton reverse array; no block traversal.'],
  ['linked/number/32/append/forEach', 'Largest tail-only forward callback control.'],
  ['linked/number/33/append/forEach', 'First full block plus one tail element.'],
  ['linked/number/4097/append/forEach', 'Large primitive forward callback target.'],
  ['doubly/boolean/4097/append/forEachReverse', 'Large primitive reverse callback target.'],
  ['doubly/number/4097/append/toArray', 'Large forward array materialization.'],
  ['linked/object/1057/edited/forEach', 'Sixteen interior edits, variable block lengths, nested object decode.'],
  ['linked/number/33/append/compact', 'Small generic compaction with fresh arena; ARM only.'],
  ['doubly/object/4097/append/compact', 'Large generic object compaction with fresh arena; ARM only.'],
].map(([name, reason]) => Object.freeze({ workload: CASES.find(row => row.name === name), reason })));
assert(SELECTION.every(row => row.workload));
export const LANES = Object.freeze([
  { name: 'node-arm64', runtime: 'node', arch: 'arm64', runner: 'ubuntu-24.04-arm', cases: 10 },
  { name: 'bun-arm64', runtime: 'bun', arch: 'arm64', runner: 'ubuntu-24.04-arm', cases: 10 },
  ...['chromium', 'firefox', 'webkit'].map(runtime => ({ name: `${runtime}-x64`, runtime, arch: 'x64', runner: 'ubuntu-24.04', cases: 8 })),
].map(Object.freeze));
export const CONTEXT = Object.freeze({
  baseline: PIN.baseline, candidate: PIN.candidate,
  original: 'The original 40-case x64 Node/Bun study, its eleven statistical uncertainties, its three Bun duration flags, and the separate e58 fixed-work supplement stay unchanged. This study does not clear them.',
  chromium: 'The combined Chromium baseline worker failed with WebAssembly.Memory allocation after fixture checks; candidate was not reached. A separate d016 run passed 92 original cases in fresh processes. These are different contexts; no cause is inferred.',
  scope: 'A structural portability screen, not the full matrix or a universal no-regression claim. Every lane is interpreted independently. Browser compaction latency is unmeasured because the original explicit-GC helper has no portable browser API. This exclusion is frozen before timing.',
  jit: 'Default JIT. Node exposes GC only for the original compaction policy. No engine optimization flags, manual GC browser flags, sandbox bypass, timing exclusions, reruns, extensions, or A/A normalization.',
});

export function verifyReusedHelpers() {
  verifyHelpers();
  for (const [file, identity] of Object.entries(IDENTITIES.proof)) {
    assert.equal(sha256(readFileSync(new URL(`../${file}`, import.meta.url))), identity.sha256, `Isolation helper changed: ${file}`);
  }
}
export function randomSource(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}
export function prospectivePlan(laneName) {
  const lane = LANES.find(row => row.name === laneName); assert(lane, 'Unregistered lane');
  const random = randomSource(CONFIG.seed);
  return { schema: 1, lane, context: CONTEXT, config: CONFIG,
    versions: { node: '22.23.3', bun: '1.4.2', playwright: '1.63.0' },
    rows: SELECTION.slice(0, lane.cases).map(({ workload, reason }, index) => ({ workload, reason,
      pilotOrder: index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'], schedule: makeSchedule(random) })),
    counts: { pilots: lane.cases * 2, measuredSubjects: lane.cases * 32, measuredBatches: lane.cases * 32 * 21, quartets: lane.cases * 8 },
    execution: { retryCount: 0, browserPer: 'fresh process per pilot or measured subject',
      neutralPath: 'subject/dist/shared.js', browserPath: '/subject/dist/shared.js',
      launchOptions: { headless: true, timeout: 30000 },
      subjectTimeoutMs: CONFIG.subjectTimeoutMs, closeTimeoutMs: 30000 } };
}

// Derive the entire old subject function. Every replacement is exact and
// reversible; scan, fixture, consumption, validation, GC and timing loops stay
// byte-identical. Only calibration/warmup planning and floor checks change.
export const REPLACEMENTS = Object.freeze([
  ['async function measureSingle(', 'async function measurePortability('],
  ['samples.filter(ms => ms < CONFIG.targetBatchMs).length', 'samples.filter(ms => ms < CONFIG.measuredBatchFloorMs).length'],
  ['warmupTimeShort: !allocating && warmup.elapsedMs < CONFIG.warmupMs', 'warmupTimeShort: !allocating && warmup.elapsedMs < CONFIG.measuredWarmupFloorMs'],
].map(Object.freeze));
export function deriveSubject() {
  verifyReusedHelpers();
  const original = measureSingle.toString();
  let body = original;
  for (const [before, after] of REPLACEMENTS) body = replaceExactlyOnce(body, before, after);
  let reversed = body;
  for (const [before, after] of [...REPLACEMENTS].reverse()) reversed = replaceExactlyOnce(reversed, after, before);
  assert.equal(reversed, original, 'Derived function does not reverse to the original');
  const prefix = `const CONFIG = Object.freeze(${JSON.stringify(CONFIG)});\nconst assert = { equal(a,b,message='Assertion failed') { if (!Object.is(a,b)) throw new Error(message); }, ok(value,message='Assertion failed') { if (!value) throw new Error(message); } };\n`;
  return { source: prefix + `export ${body}\n`, transformations: REPLACEMENTS,
    originalSha256: sha256(original), derivedFunctionSha256: sha256(body), sourceSha256: sha256(prefix + `export ${body}\n`) };
}
export function freezeCommonWork(workload, pilots) {
  assert.equal(pilots.length, 2); assert.equal(new Set(pilots.map(p => p.digest)).size, 1, 'Pilot reference values differ');
  const repeat = Math.max(...pilots.map(p => p.repeat)), fastest = Math.min(...pilots.map(p => p.minMsPerScan));
  assert(Number.isFinite(fastest) && fastest > 0); assert(Number.isSafeInteger(repeat) && repeat > 0);
  const minimumWork = workload.operation === 'compact' ? CONFIG.compactWarmupCalls : Math.ceil(CONFIG.warmupMinElements / Math.max(1, workload.size));
  const warmupScans = workload.operation === 'compact' ? CONFIG.compactWarmupCalls
    : Math.ceil(Math.max(minimumWork, Math.ceil(CONFIG.warmupMs * 1.25 / fastest)) / repeat) * repeat;
  assert(Number.isSafeInteger(warmupScans) && warmupScans > 0);
  return { repeat, warmupScans, fastestPilotMsPerScan: fastest, expectedDigest: pilots[0].digest,
    repeatCapped: pilots.some(p => p.repeatCapped), pilotWarmupCapped: pilots.some(p => p.warmup.capped) };
}
export function summarizePortability(row) {
  const result = summarize(row);
  const aaInvalid = !result['aa-baseline'].inferenceUsable;
  if (aaInvalid) {
    result.ab.inferenceUsable = false;
    result.ab.conclusion = result.ab.controlDrift ? 'control-drift-inconclusive' : 'inconclusive (invalid matched A/A)';
  }
  return result;
}
