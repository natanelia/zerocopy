import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { totals, compareMemory, median, summarize, validateCase, validateAnswers, STAGES } from './feature-map-memory-model.mjs';

const arena = { id: 'one', capacityBytes: 131072, usedBytes: 66000, readOnly: false };
const thread = (role, heapUsed = 100, arrayBuffers = 20, arenas = []) => ({ role, usage: { heapUsed, arrayBuffers, external: 1e9, rss: 5e9 }, arenas });

test('the same shared backing capacity is counted once across versions and isolates', () => {
  const value = totals([thread('owner', 100, 20, [arena, { ...arena, usedBytes: 67000 }]), thread('reader-0', 110, 30, [{ ...arena, readOnly: true }]), thread('controller')]);
  assert.equal(value.arenaCount, 1);
  assert.equal(value.wasmCapacityBytes, 131072);
  assert.equal(value.arenaUsedBytes, 67000);
  assert.equal(value.heapUsed, 310);
});
test('different arenas add their full spare capacity and reserved prefixes', () => {
  const value = totals([thread('owner', 100, 20, [arena, { ...arena, id: 'two', capacityBytes: 262144 }])]);
  assert.equal(value.wasmCapacityBytes, 393216);
  assert.equal(value.arenaUsedBytes, 132000);
});
test('signed component deltas are preserved and external/RSS are excluded from the total', () => {
  const value = compareMemory([thread('owner', 200, 100)], [thread('owner', 100, 80, [arena])]);
  assert.equal(value.heapDelta, -100);
  assert.equal(value.arrayBufferDelta, -20);
  assert.equal(value.retainedBytes, 131072 - 120);
  assert.equal(value.resolved, true);
});
test('an unresolved total is flagged rather than clamped or discarded', () => {
  const value = compareMemory([thread('owner', 200)], [thread('owner', 100)]);
  assert.equal(value.resolved, false);
  assert.equal(value.retainedBytes, -100);
});
test('duplicate or changed thread identities and conflicting capacities fail', () => {
  assert.throws(() => totals([thread('owner'), thread('owner')]));
  assert.throws(() => totals([thread('owner', 100, 20, [arena]), thread('reader', 100, 20, [{ ...arena, capacityBytes: 262144 }])]));
  assert.throws(() => compareMemory([thread('owner')], [thread('reader')]));
  assert.throws(() => compareMemory([thread('owner', 100, 20, [arena])], [thread('owner', 100, 20, [arena])]));
});
test('invalid capacities, missing measurements, and cases outside the matrix fail', () => {
  assert.throws(() => totals([thread('owner', NaN)]));
  assert.throws(() => totals([thread('owner', 100, 20, [{ ...arena, usedBytes: 999999 }])]));
  assert.throws(() => totals([thread('owner', 100, 20, [{ ...arena, capacityBytes: 131073 }])]));
  for (const config of [{ kind: 'shared', readers: 1, entries: 1000 }, { kind: 'centralized', readers: 0, entries: 1000 }, { kind: 'native', readers: 2, entries: 999 }, { kind: 'native', readers: 2, entries: 7919 }]) assert.throws(() => validateCase(config));
  for (const entries of [1000, 10000, 100000]) validateCase({ kind: 'native', readers: 2, entries });
});
test('worker replies must cover every assigned task, identity, and revision', () => {
  const config = { kind: 'native', readers: 2, entries: 1000 }, expected = { lookup: { found: 9 }, validation: { found: 9 } };
  const answer = { revision: 1, answers: [
    { role: 'reader-0', task: 'lookup', revision: 1, answer: { lookup: expected.lookup } },
    { role: 'reader-1', task: 'validate', revision: 1, answer: { validation: expected.validation } },
  ] };
  validateAnswers(answer, config, 1, expected);
  const changed = change => { const value = structuredClone(answer); change(value); return value; };
  assert.throws(() => validateAnswers(changed(value => value.answers.pop()), config, 1, expected));
  assert.throws(() => validateAnswers(changed(value => value.answers[1].role = 'reader-0'), config, 1, expected));
  assert.throws(() => validateAnswers(changed(value => value.answers[1].revision = 0), config, 1, expected));
  assert.throws(() => validateAnswers(changed(value => value.answers[1].answer = {}), config, 1, expected));
  assert.throws(() => validateAnswers(changed(value => value.answers[0].answer.validation = expected.validation), config, 1, expected));
  assert.throws(() => validateAnswers({ revision: 1, answers: [{ role: 'owner', task: 'both', revision: 1, answer: { lookup: expected.lookup } }] }, { ...config, readers: 0 }, 1, expected));
});
test('median and observed ranges retain all signed samples without mutating inputs', () => {
  const values = [5, 1, 9, 3];
  assert.equal(median(values), 4); assert.deepEqual(values, [5, 1, 9, 3]); assert.throws(() => median([]));
  const samples = [-20, 10, 40].map((heapDelta, index) => ({ kind: 'shared', readers: 2, entries: 1000, trial: index + 1, records: [{ type: 'stage', name: 'queried',
    memory: { retainedBytes: 100 + heapDelta, heapDelta, arrayBufferDelta: 0, wasmCapacityBytes: 100, arenaUsedBytes: 80 }, rssBytes: 1000, processHighWaterRSSBytes: 2000 }] }));
  const [group] = summarize(samples);
  assert.equal(group.samples.length, 3);
  assert.equal(group.medians.retainedBytes, 110);
  assert.deepEqual(group.ranges.heapDelta, { min: -20, max: 40 });
});

// Opt in explicitly: this launches actual workloads and must share the benchmark lane.
test('all four representations use real readers, retained roots, sparse edits, and clean shutdown', { skip: process.env.FEATURE_MEMORY_SMOKE !== '1', timeout: 180000 }, () => {
  const directory = process.env.FEATURE_MEMORY_SMOKE_OUT || mkdtempSync(join(tmpdir(), 'zerocopy-feature-map-memory-smoke-'));
  const output = join(directory, 'results');
  let succeeded = false;
  try {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./feature-map-memory.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 170000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, FEATURE_MEMORY_ENTRIES: '1000', FEATURE_MEMORY_TRIALS: '1', FEATURE_MEMORY_READERS: '2', FEATURE_MEMORY_KINDS: 'shared,native,immutable,immer', FEATURE_MEMORY_OUT: output },
    });
    assert.equal(run.status, 0, `${run.error ?? ''}\n${run.stderr}\n${run.stdout}`);
    const result = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
    assert.equal(result.runCount, 4); assert.equal(result.summary.length, 4 * STAGES.length);
    assert.equal(result.status, 'verified'); assert.equal(result.recordingType, 'diagnostic'); assert.equal(result.chartEligible, false);
    const terminal = JSON.parse(readFileSync(join(output, 'terminal.json'), 'utf8'));
    assert.equal(terminal.status, 'verified'); assert.equal(terminal.verifiedRuns, 4);
    for (const group of result.summary) {
      assert.equal(group.samples.length, 1); assert.ok(group.samples[0].resolved);
      assert.equal(group.samples[0].arenaCount, group.kind === 'shared' ? 1 : 0);
    }
    for (const kind of ['shared', 'native', 'immutable', 'immer']) {
      const sample = JSON.parse(readFileSync(join(output, `${kind}-2-trial-1.json`), 'utf8'));
      assert.deepEqual(sample.records.at(-1).threads.map(thread => thread.role), ['controller']);
      assert.equal(readFileSync(join(output, `${kind}-2-trial-1.stderr.log`), 'utf8'), '');
      const phases = sample.records.filter(record => record.type === 'answer').slice(0, 2).map(record => record.phase);
      assert.deepEqual(phases, ['cold', 'warm']);
    }
    succeeded = true;
  } finally {
    // All smoke evidence remains distinct from any chart-eligible full matrix.
    console.error(`${succeeded ? 'Verified' : 'Failed'} diagnostic smoke evidence preserved at ${directory}`);
  }
});
