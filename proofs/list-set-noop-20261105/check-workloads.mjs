import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CASES, makeWorkload } from './workloads.mjs';

// Correctness-only smoke check. This imports both builds in one process and
// performs no timing; it is not part of the before/after performance evidence.
const [baseline, candidate] = process.argv.slice(2);
assert.ok(baseline && candidate, 'Usage: node check-workloads.mjs BASELINE CANDIDATE');
for (const [root, isCandidate] of [[baseline, false], [candidate, true]]) {
  const api = await import(pathToFileURL(resolve(root, 'dist/shared.js')).href);
  for (const spec of CASES) {
    const workload = makeWorkload(api, spec), fixture = workload.prepare(isCandidate);
    const result = fixture.materialize(); fixture.verify(result);
    const record = fixture.finish(1);
    console.log(JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', build: isCandidate ? 'candidate' : 'baseline',
      case: spec.name, maxRepeat: workload.maxRepeat, outputElements: workload.outputElements, ...record }));
  }
}
