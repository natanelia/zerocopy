import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const directory = path.resolve(process.argv[2]), inputs = [], rows = [];
let reference = null;
for (const runtime of ['node', 'bun']) for (const arm of ['baseline', 'candidate']) {
  const file = path.join(directory, `mechanism-${runtime}-${arm}.json`), bytes = readFileSync(file), result = JSON.parse(bytes);
  assert.equal(result.runtime, runtime); assert.equal(result.arm, arm); assert.equal(result.operationClocks, false);
  assert.equal(result.officialDiagnosticEqual, true); assert.equal(result.diagnostic.length, 7);
  const comparison = result.diagnostic.map(({counter, ...row}) => ({...row, calls: counter.calls}));
  if (reference) assert.deepEqual(comparison, reference); else reference = comparison;
  for (const row of result.diagnostic) { assert.equal(row.counter.bytes, row.counter.calls * (arm === 'baseline' ? 256 : 64)); rows.push({runtime, arm, case: row.case, ...row.counter}); }
  inputs.push({path: file, sha256: createHash('sha256').update(bytes).digest('hex')});
}
writeFileSync(path.join(directory, 'mechanism-comparison.json'), JSON.stringify({passed: true, operationClocks: false, rows, inputs,
  interpretation: 'Requested memory.fill initialization byte positions; not latency, physical stores or retained memory.'}, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({passed: true, cases: rows.length, operationClocks: false}));
