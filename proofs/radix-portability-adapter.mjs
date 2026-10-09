// Exact source transformations are confined to environment and untimed helpers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CONFIG } from './trie-view-protocol.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
export function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Expected one exact adapter site: ${before}`);
  return source.replace(before, after);
}
export function transform(source, edits) {
  let output = source;
  for (const [before, after] of edits) output = replaceOnce(output, before, after);
  let reversed = output;
  for (const [before, after] of [...edits].reverse()) reversed = replaceOnce(reversed, after, before);
  assert.equal(reversed, source, 'Browser adapter is not reversible');
  return { source: output, originalSha256: hash(source), sourceSha256: hash(output), edits };
}
export function deriveBrowser() {
  const workload = transform(read('trie-view-workloads.mjs'), [
    ["import assert from 'node:assert/strict';", "import { assert } from './shims.mjs';"],
    ["import { createHash } from 'node:crypto';", "import { createHash } from './shims.mjs';"],
  ]);
  const originalSubject = read('trie-view-subject.mjs');
  const timedCore = originalSubject.slice(originalSubject.indexOf('function positiveDuration'), originalSubject.indexOf('export async function subject'));
  const originalBody = originalSubject.slice(originalSubject.indexOf('export async function subject'), originalSubject.indexOf('\nif (process.argv[1]'));
  const body = transform(originalBody, [
    ["    assert.equal(process.execArgv.length, 0, 'Subject requires default JIT flags');", "    assert.equal(globalThis.crossOriginIsolated, true, 'Browser subject requires cross-origin isolation');"],
    ["    assert.ok(!process.env.NODE_OPTIONS && !process.env.BUN_OPTIONS, 'Subject requires default runtime options');", "    assert.equal(request.authorization, 'frozen-ci-subject', 'Browser timing authorization missing');"],
  ]);
  const prefix = `import { assert } from './shims.mjs';\nimport { fixture, verifyFixture, snapshot, normalizeSink } from './workloads.mjs';\nconst CONFIG = Object.freeze(${JSON.stringify(CONFIG)});\nlet imported = false;\nfunction runtimeReceipt() { return { name: 'browser', userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, crossOriginIsolated }; }\nfunction validateEntry(entryUrl) { assert.equal(entryUrl, location.origin + '/subject/dist/shared.js'); return { entryUrl }; }\nfunction sourceReceipt() { return { derivation: 'exact-pinned-browser-adapter-v1' }; }\nfunction requireTimingAuthorization(phase) { assert.ok(['verify','pilot','measure'].includes(phase)); }\n`;
  const subject = { source: prefix + timedCore + body.source, originalSha256: hash(originalSubject),
    originalBodySha256: body.originalSha256, derivedBodySha256: body.sourceSha256,
    timedCoreSha256: hash(timedCore), edits: body.edits };
  subject.sourceSha256 = hash(subject.source);
  const worker = transform(read('trie-view-worker.mjs'), [
    ["import assert from 'node:assert/strict';", "import { assert } from '/study/shims.mjs';"],
    ["import { parentPort } from 'node:worker_threads';", "import { parentPort } from '/study/shims.mjs';"],
  ]);
  const parentOriginal = read('trie-view-workers.mjs');
  const importsEnd = parentOriginal.indexOf('const api = await import(moduleURL);');
  const parentBody = transform(parentOriginal.slice(importsEnd), [
    ['for (const copy of [false, true]) {', 'for (const copy of [selectedCopy]) {'],
    ["console.log(JSON.stringify({ transport:", "reports.push(JSON.stringify({ transport:"],
    ["new URL('./trie-view-worker.mjs', import.meta.url)", "new URL('/proofs/trie-view-worker.mjs', location.origin)"],
  ]);
  const parentSource = "import { assert, Worker } from './shims.mjs';\nexport async function workerChecks(moduleURL, selectedCopy) {\nconst reports = [];\n" + parentBody.source + '\nreturn reports.map(value => JSON.parse(value));\n}\n';
  return { workload, subject, worker, parent: { source: parentSource, sourceSha256: hash(parentSource),
    originalSha256: hash(parentOriginal), originalBodySha256: parentBody.originalSha256,
    derivedBodySha256: parentBody.sourceSha256, edits: parentBody.edits },
    shims: { source: read('radix-portability-browser-shims.mjs'), sourceSha256: hash(read('radix-portability-browser-shims.mjs')) } };
}
