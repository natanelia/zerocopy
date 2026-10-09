// Reversible host adaptations. Original kernels remain archived byte-for-byte.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Expected one exact adapter site: ${before}`);
  return source.replace(before, after);
}
export function transform(source, edits) {
  let output = source;
  for (const [before, after] of edits) output = replaceOnce(output, before, after);
  let reversed = output;
  for (const [before, after] of [...edits].reverse()) reversed = replaceOnce(reversed, after, before);
  assert.equal(reversed, source, 'Adapter is not reversible');
  return { source: output, originalSha256: hash(source), sourceSha256: hash(output), edits };
}
export function section(source, start, end) {
  assert.equal(source.split(start).length, 2, `Nonunique section start: ${start}`);
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(last > first); return source.slice(first, last);
}
const observationEdits = [
  ['export async function subject(request) {', 'async function kernelSubject(request) {'],
  ['    while (result.scans < requiredScans', '    request.progress.warmup = result;\n    while (result.scans < requiredScans'],
  ['    let capped = false, minMsPerIteration = null;', '    request.progress.calibration = calibration;\n    let capped = false, minMsPerIteration = null;'],
  ['  const samples = Array.from({ length: CONFIG.samples }, () => timed(request.repeat));',
    '  const samples = []; request.progress.samples = samples;\n  for (let index = 0; index < CONFIG.samples; index++) samples.push(timed(request.repeat));'],
];
const wrapper = `\nexport async function subject(request) {\n  const progress = {};\n  try { return { status: 'completed', ...await kernelSubject({ ...request, progress }), progress }; }\n  catch (error) { return { status: 'failed', phase: request.phase, error: String(error.stack ?? error), progress }; }\n}\n`;
const browserCalibration = [
  ['    let capped = false, minMsPerIteration = null;',
    "    const positivePrewarm = warmup.batches.findLast(batch => Number.isFinite(batch.ms) && batch.ms > 0);\n    assert(positivePrewarm, 'No positive recorded prewarm batch');\n    repeat = positivePrewarm.repeat;\n    request.progress.calibrationStart = { source: 'last-positive-recorded-prewarm', repeat };\n    let capped = false, minMsPerIteration = null;"],
];
function deriveSubject(browser) {
  const source = read('heap-entry-subject.mjs');
  const environmentEdits = browser ? [
    ["import assert from 'node:assert/strict';", "import { assert } from './shims.mjs';"],
    ["from './heap-entry-protocol.mjs'", "from './protocol.mjs'"],
    ["from './heap-entry-workloads.mjs'", "from './workloads.mjs'"],
    ["  assert.equal(process.arch, CONFIG.architecture);", "  assert.equal(globalThis.crossOriginIsolated, true);\n  assert.equal(request.authorization, 'frozen-ci-subject');"],
    ["  const runtime = process.versions.bun ? 'bun' : 'node';", "  const runtime = 'browser';"],
    ["  assert.equal(runtime === 'bun' ? process.versions.bun : process.versions.node, CONFIG.runtimes[runtime]);", "  assert.equal(request.entryUrl, location.origin + '/subject/dist/shared.js');"],
  ] : [["  assert.equal(process.arch, CONFIG.architecture);", "  assert.equal(process.arch, 'arm64');"]];
  // Observation retains partial data without touching measured scan/sink or any
  // time target. Browser-only calibration reuses an actually executed prewarm.
  const edits = [...environmentEdits, ...observationEdits, ...(browser ? browserCalibration : [])];
  const derived = transform(source, edits); derived.source += wrapper; derived.sourceSha256 = hash(derived.source);
  const timed = section(source, '  const timed = repeat => {', '  const warm =');
  assert.equal(section(derived.source, '  const timed = repeat => {', '  const warm ='), timed);
  derived.preservedTimedKernelSha256 = hash(timed);
  return derived;
}
export function deriveNode() { return { subject: deriveSubject(false) }; }
export function deriveBrowser() {
  const workload = transform(read('heap-entry-workloads.mjs'), [
    ["import assert from 'node:assert/strict';", "import { assert } from './shims.mjs';"],
    ["import { createHash } from 'node:crypto';", "import { createHash } from './shims.mjs';"],
  ]);
  const protocol = transform(read('heap-entry-protocol.mjs'), [["import assert from 'node:assert/strict';", "import { assert } from './shims.mjs';"]]);
  const parent = transform(read('heap-portability-semantic.mjs'), [
    ["import assert from 'node:assert/strict';", "import { assert } from './shims.mjs';"],
    ["import { createHash } from 'node:crypto';", "import { createHash, Buffer } from './shims.mjs';"],
    ["import { Worker } from 'node:worker_threads';", "import { Worker } from './shims.mjs';"],
    ["new URL('./heap-entry-worker.mjs', import.meta.url)", "new URL('/proofs/heap-entry-worker.mjs', location.origin)"],
  ]);
  const originalWorker = read('heap-entry-worker.mjs');
  const common = section(read('heap-portability-semantic.mjs'), 'const HEAP_START', 'export async function semanticChecks');
  const body = section(originalWorker, 'if (!isMainThread) {', '\nexport async function checkBuiltEntries');
  const workerSource = "import { assert, createHash, Buffer, parentPort } from '/study/shims.mjs';\nconst isMainThread = false;\n" + common + body;
  const worker = { source: workerSource, sourceSha256: hash(workerSource), originalSha256: hash(originalWorker), preservedWorkerBodySha256: hash(body) };
  const shimsSource = read('heap-portability-browser-shims.mjs') + `\n// Byte comparison only for untimed historical heap semantic checks.\nexport const Buffer = { compare(a, b) {\n  if (a.length !== b.length) return a.length < b.length ? -1 : 1;\n  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;\n  return 0;\n} };\n`;
  const fixtureSource = `import { assert } from './shims.mjs';\nimport { CASES, fixture, fixtureIdentity, consume } from './workloads.mjs';\nexport async function fixtureCheck(entryUrl, name) {\n const api = await import(entryUrl), workload = CASES.find(row => row.name === name); assert(workload);\n const { item, expected } = fixture(api, workload);\n assert.deepEqual(consume(item, workload), expected); assert.deepEqual(consume(item, workload), expected);\n return { status: 'completed', workload, expected, identity: fixtureIdentity(api, item) };\n}\n`;
  return { workload, protocol, subject: deriveSubject(true), parent, worker,
    fixture: { source: fixtureSource, sourceSha256: hash(fixtureSource) },
    shims: { source: shimsSource, sourceSha256: hash(shimsSource), originalSha256: hash(read('heap-portability-browser-shims.mjs')) } };
}
