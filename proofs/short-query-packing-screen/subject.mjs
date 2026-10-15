/** The sole timing subject. Executed only after exact packet release. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CASES, EXPECTED, makeCorpus, entriesFor, referenceMatch } from './corpus.mjs';

assert.equal(process.argv.length, 4);
assert.equal(process.argv[2], '--job');
const job = JSON.parse(readFileSync(process.argv[3], 'utf8'));
assert.ok(['calibration', 'comparison'].includes(job.mode));
assert.ok(['node', 'bun'].includes(job.engine));
assert.ok(['baseline', 'candidate'].includes(job.arm));
assert.deepEqual([...job.caseOrder].sort(), [...CASES].sort());
assert.ok(job.entry.startsWith('file:///'));
const entries = makeCorpus();
const corpusSha256 = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
assert.equal(corpusSha256, job.corpusSha256);
const { SharedList, resetSharedList } = await import(job.entry);
resetSharedList();
for (const entry of entries) {
  entry.list = new SharedList('string').pushMany(entry.values);
  assert.deepEqual(entry.list.toArray(), entry.values);
  const predicate = entry.list.compileTextSearch(entry.term, entry.options);
  for (let i = 0; i < entry.values.length; i++) {
    assert.equal(predicate(i), referenceMatch(entry, entry.values[i]));
  }
  entry.reused = entry.list.compileTextSearch(entry.term, entry.options);
}

function operation(id) {
  const group = entriesFor(id, entries);
  if (id === 'S1') return repetitions => {
    let checksum = 0;
    for (let r = 0; r < repetitions; r++) for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < group.length; j++) {
        const e = group[j], predicate = e.list.compileTextSearch(e.term, e.options), i = (pass + j) & 1;
        if (predicate(i)) checksum += (j + 1) * (i + 1);
      }
    }
    return checksum;
  };
  const count = id === 'C1' || id === 'C2' ? 4096 : 16, reuse = id === 'C2';
  return repetitions => {
    let checksum = 0;
    for (let r = 0; r < repetitions; r++) for (let j = 0; j < group.length; j++) {
      const e = group[j], predicate = reuse ? e.reused : e.list.compileTextSearch(e.term, e.options);
      for (let i = 0; i < count; i++) if (predicate(i)) checksum += (j + 1) * (i + 1);
    }
    return checksum;
  };
}
const emit = row => console.log(JSON.stringify(row));
const now = () => performance.now();
const median = a => [...a].sort((x, y) => x - y)[1]; // Three calibration observations only.
const result = { engine: job.engine, arm: job.arm, round: job.round,
  corpusSha256, workloads: {}, calibration: {} };

for (const id of job.caseOrder) {
  const run = operation(id), expected = EXPECTED[id];
  const start = now(); let warmCalls = 0, warmChecksum = 0;
  do { warmChecksum += run(1); warmCalls++; } while (now() - start < 500);
  assert.equal(warmChecksum, expected.checksum * warmCalls);
  emit({ event: 'prewarm', case: id, milliseconds: now() - start, calls: warmCalls, checksum: warmChecksum });
  const batch = (K, phase, index) => {
    const before = now(), checksum = run(K), milliseconds = now() - before;
    assert.equal(checksum, expected.checksum * K);
    assert.ok(Number.isFinite(milliseconds) && milliseconds > 0);
    emit({ event: 'batch', case: id, K, phase, index, milliseconds, checksum });
    return { milliseconds, checksum };
  };
  if (job.mode === 'calibration') {
    assert.equal(job.arm, 'baseline');
    const trials = []; let selected = null;
    for (let level = 0; level <= 20; level++) {
      const K = 2 ** level;
      const warmupMs = Array.from({ length: 8 }, (_, i) => batch(K, 'warmup', i).milliseconds);
      const measured = Array.from({ length: 3 }, (_, i) => batch(K, 'calibration', i));
      const trial = { K, warmupMs, measuredMs: measured.map(x => x.milliseconds),
        checksums: measured.map(x => x.checksum), expectedChecksum: expected.checksum * K };
      trials.push(trial);
      if (median(trial.measuredMs) >= 50) { selected = K; break; }
    }
    assert.notEqual(selected, null, 'calibration exhausted fixed doubling ladder');
    result.calibration[id] = { K: selected, trials };
  } else {
    const K = job.counts[id];
    assert.ok(Number.isSafeInteger(K) && K >= 1 && K <= 2 ** 20 && (K & (K - 1)) === 0);
    const warmupMs = Array.from({ length: 8 }, (_, i) => batch(K, 'warmup', i).milliseconds);
    const measured = Array.from({ length: 4 }, (_, i) => batch(K, 'measured', i));
    result.workloads[id] = { K, operationsPerRepetition: expected.operations, warmupMs,
      measuredMs: measured.map(x => x.milliseconds), checksums: measured.map(x => x.checksum),
      expectedChecksum: expected.checksum * K };
  }
}
emit({ event: 'result', result });
