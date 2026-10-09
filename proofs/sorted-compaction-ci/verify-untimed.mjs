import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fixture} from './fixtures.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));

export function compareUntimed(directory, manifestFile, protocol) {
  const ledgerFile = path.join(directory, 'ledger.json'), ledger = read(ledgerFile);
  assert.equal(ledger.mode, 'untimed'); assert.equal(ledger.status, 'complete');
  assert.equal(ledger.verificationAfter?.ok, true); assert.equal(ledger.manifestSha256, sha(readFileSync(manifestFile)));
  assert.equal(ledger.slots.length, 4); assert.equal(ledger.calibration.length, 0);
  const inputs = [], references = new Map(), seen = new Set(), allocationResults = []; let chunks = 0;
  for (const slot of ledger.slots) {
    assert.equal(slot.status, 'complete'); assert.equal(slot.returncode, 0); assert.equal(slot.cleanup.ownedGroupGone, true);
    assert(protocol.runtimes.includes(slot.runtime)); assert(['baseline', 'candidate'].includes(slot.arm));
    assert(!seen.has(`${slot.runtime}/${slot.arm}`)); seen.add(`${slot.runtime}/${slot.arm}`);
    const file = path.join(directory, `${slot.id}.stdout.jsonl`), bytes = readFileSync(file);
    assert.equal(sha(bytes), slot.stdoutSha256); inputs.push({path: path.resolve(file), sha256: sha(bytes)});
    const records = bytes.toString().trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records[0].mode, 'untimed'); assert.equal(records[0].runtime, slot.runtime); assert.equal(records[0].arm, slot.arm);
    assert.equal(records.at(-1).operationClocks, false); assert.equal(records.at(-1).chunks, 20);
    assert.equal(records.filter(record => record.kind === 'case').length, 10);
    const observations = new Map(records.filter(record => record.kind === 'body-observation').map(record => [record.observationId, record]));
    assert.equal(observations.size, 20);
    for (const spec of protocol.cases) {
      const matches = records.filter(record => record.kind === 'case' && record.case === spec.id); assert.equal(matches.length, 1);
      const entry = matches[0], input = fixture(spec);
      assert.equal(entry.inputDigest, input.inputDigest); assert.equal(entry.expectedDigest, input.expectedDigest); assert.equal(entry.rows.length, 2);
      for (const [i, row] of entry.rows.entries()) {
        const operations = i ? spec.ladder.at(-1) : spec.ladder[0];
        assert.equal(row.phase, i ? 'untimed-maximum' : 'untimed-minimum'); assert.equal(row.operations, operations);
        assert.equal(row.publicCalls, operations); assert.equal(row.durationMs, null); assert.equal(row.nsPerOperation, null);
        const observation = observations.get(row.observationId); assert(observation);
        assert.equal(observation.validated, false); assert.equal(observation.durationMs, null); assert.equal(observation.nsPerOperation, null);
        assert.equal(observation.case, spec.id); assert.equal(observation.phase, row.phase); assert.equal(observation.operations, operations);
        const s = row.semantics; assert(s); assert.equal(s.resultCount, operations);
        assert.equal(s.checksum, spec.operation === 'get' ? operations / 1024 * (1023 * 1024 / 2) : operations * spec.size);
        assert.match(s.semanticDigest, /^[0-9a-f]{64}$/); assert.equal(s.expectedDigest, input.expectedDigest);
        assert(s.liveBackingBytes <= protocol.memory.maximumLiveBackingBytes); assert(s.liveBackingBytes <= s.plannedBackingBound);
        assert(s.baseSourceBackingBytes <= protocol.memory.maximumSourceBackingBytes);
        assert(s.uniqueLiveOwners >= 2); assert(s.sourcePayloads.length); assert(s.sourcePayloads.every(value => /^[0-9a-f]{64}$/.test(value)));
        if (spec.shape === 'fallback') assert.deepEqual(s.adversarialTraversal.lastTwoKeys, ['0255', '0254']); else assert.equal(s.adversarialTraversal, null);
        // Pointer text, branch layout, used bytes and cache admission may differ.
        // Compare public logical outcomes across arms; retain allocation receipts separately.
        const semantic = {inputDigest: entry.inputDigest, expectedDigest: entry.expectedDigest, operations,
          checksum: s.checksum, semanticDigest: s.semanticDigest, resultCount: s.resultCount, cacheState: s.cacheState};
        const key = `${spec.id}/${i}`;
        if (references.has(key)) assert.deepEqual(semantic, references.get(key), `Cross-arm/runtime public semantic mismatch: ${key}`);
        else references.set(key, semantic);
        for (const allocation of s.allocations) {
          assert(Number.isSafeInteger(allocation.usedBytes) && allocation.usedBytes >= 65536);
          assert(allocation.backingBytes >= allocation.usedBytes && allocation.backingBytes <= spec.maximumResultOwnerBackingBytes);
          if (spec.shape === 'decimal') assert.equal(allocation.branchBytes, slot.arm === 'baseline' ? 171000 : 25504);
          if (['tiny','binary','prefix'].includes(spec.shape)) assert.equal(allocation.abandonedBranches, 0);
        }
        allocationResults.push({runtime: slot.runtime, arm: slot.arm, case: spec.id, endpoint: row.phase, allocations: s.allocations,
          liveBackingBytes: s.liveBackingBytes, baseSourceBackingBytes: s.baseSourceBackingBytes, uniqueLiveOwners: s.uniqueLiveOwners});
        chunks++;
      }
    }
  }
  assert.equal(chunks, 80);
  for (const shape of ['compact-tiny-2', 'compact-binary-256', 'compact-prefix-256', 'compact-late-fallback-256', 'compact-hamt-1024']) {
    const rows = allocationResults.filter(row => row.case === shape);
    for (const endpoint of ['untimed-minimum', 'untimed-maximum']) {
      const values = rows.filter(row => row.endpoint === endpoint).map(row => row.allocations);
      for (const value of values.slice(1)) assert.deepEqual(value, values[0], `No-saving/fallback allocation control: ${shape}`);
    }
  }
  return {passed: true, chunks, caseEndpoints: references.size, manifestSha256: ledger.manifestSha256,
    ledgerSha256: sha(readFileSync(ledgerFile)), inputs, allocationResults, operationClocks: false};
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const protocol = read(new URL('./protocol.json', import.meta.url));
  const result = compareUntimed(path.resolve(process.argv[2]), path.resolve(process.argv[3]), protocol);
  writeFileSync(path.join(process.argv[2], 'semantic-comparison.json'), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({passed: true, chunks: result.chunks, operationClocks: false}));
}
