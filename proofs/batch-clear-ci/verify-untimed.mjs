import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fixture} from './fixtures.mjs';
const sha = data => createHash('sha256').update(data).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
export function compareUntimed(directory, manifestFile, protocol) {
  const ledgerFile = path.join(directory, 'ledger.json'), ledger = read(ledgerFile);
  assert.equal(ledger.mode, 'untimed'); assert.equal(ledger.status, 'complete');
  assert.equal(ledger.verificationAfter?.ok, true);
  assert.equal(ledger.manifestSha256, sha(readFileSync(manifestFile)));
  assert.equal(ledger.slots.length, 4); assert.equal(ledger.calibration.length, 0);
  const inputs = [], references = new Map(), seen = new Set(); let chunks = 0;
  for (const slot of ledger.slots) {
    assert.equal(slot.status, 'complete'); assert.equal(slot.returncode, 0); assert.equal(slot.cleanup.ownedGroupGone, true);
    assert(protocol.runtimes.includes(slot.runtime)); assert(['baseline', 'candidate'].includes(slot.arm));
    assert(!seen.has(`${slot.runtime}/${slot.arm}`)); seen.add(`${slot.runtime}/${slot.arm}`);
    const file = path.join(directory, `${slot.id}.stdout.jsonl`), bytes = readFileSync(file);
    assert.equal(sha(bytes), slot.stdoutSha256); inputs.push({path: path.resolve(file), sha256: sha(bytes)});
    const records = bytes.toString().trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records[0].mode, 'untimed'); assert.equal(records[0].runtime, slot.runtime); assert.equal(records[0].arm, slot.arm);
    assert.equal(records.at(-1).operationClocks, false); assert.equal(records.at(-1).chunks, 14);
    assert.equal(records.filter(record => record.kind === 'case').length, 7);
    for (const spec of protocol.cases) {
      const matches = records.filter(record => record.kind === 'case' && record.case === spec.id); assert.equal(matches.length, 1);
      const entry = matches[0], input = fixture(spec);
      assert.equal(entry.inputDigest, input.inputDigest); assert.equal(entry.expectedDigest, input.expectedDigest);
      assert.equal(entry.rows.length, 2);
      for (const [i, row] of entry.rows.entries()) {
        assert.equal(row.phase, i ? 'untimed-maximum' : 'untimed-minimum');
        assert.equal(row.operations, i ? spec.ladder.at(-1) : spec.ladder[0]);
        assert.equal(row.publicCalls, row.operations); assert.equal(row.checksum, row.operations * spec.resultSize);
        for (const name of ['durationMs', 'nsPerOperation', 'nsPerInputEntry']) assert.equal(row[name], null);
        for (const value of [row.retainedPayload, row.outputEntries, row.sourceEntries, row.semantics?.sourceOldPrefix, row.semantics?.outputPayload]) assert.match(value, /^[0-9a-f]{64}$/);
        for (const value of [row.retainedUsed, row.beforeCapacity, row.semantics.sourceUsed, row.semantics.sourceCapacity, row.semantics.outputUsed, row.semantics.outputCapacity]) assert(Number.isSafeInteger(value) && value >= 65536);
        assert.equal(row.semantics.sourceDescriptor.size, input.seed.length);
        assert.equal(row.semantics.outputDescriptor.size, spec.resultSize);
        assert.equal(row.semantics.sourceOldPrefix, row.retainedPayload);
        assert.equal(row.semantics.outputSharesSourceArena, spec.operation === 'setMany');
        assert(row.semantics.sourceCapacity <= protocol.memory.maximumArenaBytes);
        assert(row.semantics.outputCapacity <= protocol.memory.maximumArenaBytes);
        assert(row.semantics.sourceUsed <= row.semantics.sourceCapacity);
        assert(row.semantics.outputUsed <= row.semantics.outputCapacity);
        const semantic = {inputDigest: entry.inputDigest, expectedDigest: entry.expectedDigest, operations: row.operations,
          checksum: row.checksum, retainedUsed: row.retainedUsed, beforeCapacity: row.beforeCapacity, retainedPayload: row.retainedPayload,
          semantics: row.semantics, outputEntries: row.outputEntries, sourceEntries: row.sourceEntries};
        const key = `${spec.id}/${i}`;
        if (references.has(key)) assert.deepEqual(semantic, references.get(key), `Cross-arm/runtime semantic mismatch: ${key}`);
        else references.set(key, semantic);
        chunks++;
      }
    }
  }
  assert.equal(chunks, 56);
  return {passed: true, chunks, caseEndpoints: references.size, manifestSha256: ledger.manifestSha256,
    ledgerSha256: sha(readFileSync(ledgerFile)), inputs, operationClocks: false};
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const protocol = read(new URL('./protocol.json', import.meta.url));
  const result = compareUntimed(path.resolve(process.argv[2]), path.resolve(process.argv[3]), protocol);
  writeFileSync(path.join(process.argv[2], 'semantic-comparison.json'), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify(result));
}
