// The original adapter stays intact. Only browser pilot calibration has a new
// reversible exception; measured execution and the entire fixture are unchanged.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deriveBrowser as deriveOriginal, transform } from './radix-portability-adapter.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
export const CALIBRATION_EDITS = Object.freeze([
  Object.freeze(['  repeat = 1;\n  for (let step = 0;', '  repeat = prewarm.batches.at(-1).repeat;\n  for (let step = 0;']),
]);
export function section(source, start, end) {
  assert.equal(source.split(start).length, 2, `Nonunique section start: ${start}`);
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(last > first, `Missing section end: ${end}`);
  return source.slice(first, last);
}
export function deriveBrowser() {
  const original = deriveOriginal(), source = read('trie-view-subject.mjs');
  const core = section(source, 'function positiveDuration', 'export async function subject');
  const adaptedCore = transform(core, CALIBRATION_EDITS);
  const edits = [[core, adaptedCore.source], ["derivation: 'exact-pinned-browser-adapter-v1'", "derivation: 'exact-pinned-browser-recovery-v1'"]];
  const adapted = transform(original.subject.source, edits);
  const preserved = {
    timedBatch: ['function timedBatch(', 'function fail('],
    fixedMeasure: ['export function runFixedMeasure(', 'export async function subject'],
    positiveDuration: ['function positiveDuration(', '\n\n// Timed bodies'],
  };
  const preservedSha256 = {};
  for (const [name, [start, end]] of Object.entries(preserved)) {
    const expected = section(source, start, end);
    assert.equal(section(adapted.source, start, end), expected, `${name} changed`);
    preservedSha256[name] = hash(expected);
  }
  // Guard the complete fixture as well as its execute closure separately.
  const fixture = read('trie-view-workloads.mjs');
  const execute = section(fixture, '  const execute = repeat =>', '\n  const result =');
  assert.equal(section(original.workload.source, '  const execute = repeat =>', '\n  const result ='), execute);
  preservedSha256.fixtureExecute = hash(execute);
  const { timedCoreSha256, ...receipt } = original.subject;
  return { ...original, subject: { ...receipt, source: adapted.source, sourceSha256: adapted.sourceSha256,
    protocol: 'radix-browser-recovery-v1', originalAdapterSha256: adapted.originalSha256,
    originalTimedCoreSha256: timedCoreSha256, derivedTimedCoreSha256: adaptedCore.sourceSha256,
    calibrationEdits: CALIBRATION_EDITS, receiptEdits: edits.slice(1), preservedSha256 } };
}
