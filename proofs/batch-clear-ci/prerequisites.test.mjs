// Synthetic prerequisite rejection tests only. No candidate loads or clocks.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {proveOneOperand, instrument} from './verify-wasm.mjs';
import {compareUntimed} from './verify-untimed.mjs';
import {fixture} from './fixtures.mjs';
const protocol = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url), 'utf8'));
const sha = data => createHash('sha256').update(data).digest('hex');
let checks = 0;
function check(fn) { fn(); checks++; }
const base = '(module\n (import "env" "memory" (memory 2 65536 shared))\n (global $g (mut i32) (i32.const 0))\n (func $19\n   (memory.fill\n    (i32.const 8192)\n    (i32.const 0)\n    (i32.const 256)\n   )\n   (loop $label1\n   )\n )\n)';
const candidate = base.replace('(i32.const 256)', '(i32.const 64)');
check(() => assert.equal(proveOneOperand(base, candidate).changedFunction, 19));
check(() => assert.throws(() => proveOneOperand(base, base)));
check(() => assert.throws(() => proveOneOperand(base, candidate.replace('8192', '8193'))));
check(() => assert.throws(() => proveOneOperand(base, candidate.replace('(i32.const 64)', '(i32.const 32)'))));
check(() => assert.throws(() => proveOneOperand(base.replace('$19', '$18'), candidate.replace('$19', '$18'))));
check(() => assert.throws(() => proveOneOperand(base.replace('memory.fill', 'memory.copy'), candidate.replace('memory.fill', 'memory.copy'))));
const instrumented = instrument(base, 256);
check(() => assert(instrumented.indexOf('(import') < instrumented.indexOf('(global $batchCalls')));
check(() => assert.equal(instrumented.split('(export "__batchFillCalls"').length - 1, 1));
check(() => assert.throws(() => instrument(base, 64)));
const directory = mkdtempSync(path.join(tmpdir(), 'batch-clear-prerequisites-'));
const manifestFile = path.join(directory, 'manifest.json'); writeFileSync(manifestFile, '{}\n');
function createFixture(mutate = () => {}) {
  const slots = [];
  for (const runtime of ['node', 'bun']) for (const arm of ['baseline', 'candidate']) {
    const id = `${runtime}-${arm}`;
    const records = [{kind: 'start', mode: 'untimed', runtime, arm}, ...protocol.cases.map(spec => {
      const input = fixture(spec);
      return {kind: 'case', case: spec.id, inputDigest: input.inputDigest, expectedDigest: input.expectedDigest, rows: [spec.ladder[0], spec.ladder.at(-1)].map((operations, i) => ({
        phase: i ? 'untimed-maximum' : 'untimed-minimum', operations, publicCalls: operations, checksum: operations * spec.resultSize,
        durationMs: null, nsPerOperation: null, nsPerInputEntry: null, retainedUsed: 65536, beforeCapacity: 131072, retainedPayload: '0'.repeat(64),
        outputEntries: '1'.repeat(64), sourceEntries: '2'.repeat(64), semantics: {sourceDescriptor: {size: input.seed.length}, outputDescriptor: {size: spec.resultSize}, sourceOldPrefix: '0'.repeat(64), outputPayload: '3'.repeat(64), sourceUsed: 65536, sourceCapacity: 131072, outputUsed: 65536, outputCapacity: 131072, outputSharesSourceArena: spec.operation === 'setMany'},
      }))};
    }), {kind: 'complete', chunks: 14, operationClocks: false}];
    mutate(records, {runtime, arm});
    const bytes = records.map(record => JSON.stringify(record)).join('\n') + '\n';
    writeFileSync(path.join(directory, id + '.stdout.jsonl'), bytes);
    slots.push({id, runtime, arm, status: 'complete', returncode: 0, cleanup: {ownedGroupGone: true}, stdoutSha256: sha(bytes)});
  }
  const ledger = {mode: 'untimed', status: 'complete', verificationAfter: {ok: true}, manifestSha256: sha(readFileSync(manifestFile)), calibration: [], slots};
  writeFileSync(path.join(directory, 'ledger.json'), JSON.stringify(ledger));
  return ledger;
}
try {
  createFixture(); check(() => assert.equal(compareUntimed(directory, manifestFile, protocol).chunks, 56));
  for (const mutation of [
    rows => { rows[1].rows[0].durationMs = 1; },
    rows => { rows[1].rows[0].operations = 1; },
    rows => { rows[1].rows[0].checksum++; },
    rows => { delete rows[1].rows[0].semantics; },
    rows => { rows.at(-1).operationClocks = true; },
    (rows, slot) => { if (slot.arm === 'candidate') rows[1].rows[0].semantics.outputPayload = '4'.repeat(64); },
    rows => { rows[1].inputDigest = 'changed'; },
  ]) { createFixture(mutation); check(() => assert.throws(() => compareUntimed(directory, manifestFile, protocol))); }
  const ledger = createFixture(); ledger.status = 'incomplete'; writeFileSync(path.join(directory, 'ledger.json'), JSON.stringify(ledger));
  check(() => assert.throws(() => compareUntimed(directory, manifestFile, protocol)));
  createFixture(); writeFileSync(path.join(directory, 'node-baseline.stdout.jsonl'), 'changed');
  check(() => assert.throws(() => compareUntimed(directory, manifestFile, protocol)));
  console.log(JSON.stringify({syntheticPrerequisiteChecks: checks, passed: true, candidateLoaded: false, operationClocks: false}));
} finally { rmSync(directory, {recursive: true, force: true}); }
