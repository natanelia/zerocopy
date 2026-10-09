// Public-operation accounting and oracle checks with small plain test doubles.
// This file does not import a candidate, build anything, or read an operation clock.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture, expectedChecksum, operationCounts, runBody} from './subject.mjs';
const protocol = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url)));
let checks = 0;
const check = fn => { fn(); checks++; };
for (const spec of protocol.cases) {
  const input = fixture(spec), calls = [], operations = 3;
  function queue(values, index = 0, name = 'A') {
    return Object.freeze({size: values.length - index,
      peek() { calls.push(['peek', name, index]); return values[index]; },
      dequeue() { calls.push(['dequeue', name, index]); return queue(values, index + 1, name); },
    });
  }
  const roots = spec.shape === 'alternate-roots' ? [queue(input.entries), queue(input.second, 0, 'B')]
    : spec.shape === 'alternate-blocks' ? [queue(input.entries), queue(input.entries, 32, 'B')]
    : spec.shape === 'tail' ? [queue(input.entries, 31)] : [queue(input.entries)];
  const result = runBody(spec, roots, operations), counts = operationCounts(spec, operations);
  check(() => assert.equal(result.checksum, expectedChecksum(spec, input, operations)));
  check(() => assert.equal(calls.filter(x => x[0] === 'peek').length, counts.publicPeekCalls));
  check(() => assert.equal(calls.filter(x => x[0] === 'dequeue').length, counts.publicDequeueCalls));
  check(() => assert.equal(counts.unit, spec.unit));
  check(() => assert.equal(counts.itemsPerOperation, spec.operation === 'drain' ? spec.size : 1));
  check(() => assert(Number.isSafeInteger(expectedChecksum(spec, input, spec.ladder.at(-1)))));
  if (spec.operation === 'drain') {
    check(() => assert.equal(result.output.size, 0));
    check(() => assert(calls.every((call, i) => call[0] === (i % 2 ? 'dequeue' : 'peek'))));
    check(() => assert.equal(calls.filter(x => x[0] === 'peek' && x[2] === 0).length, operations));
    check(() => assert(!calls.some(x => x[2] >= spec.size)));
  } else {
    check(() => assert.equal(result.output, roots[0]));
    if (spec.shape.startsWith('alternate')) check(() => assert.deepEqual(calls.map(x => x[1]), ['A', 'B', 'A']));
  }
  if (spec.type === 'object') {
    check(() => assert(input.encodedBytes.every(n => n < 256)));
    check(() => assert(input.encodedBytes.slice(0, 2048).reduce((a,b)=>a+b,0) < 2097152));
    check(() => assert.equal(input.entries.length - 2048, 2049));
    check(() => assert(input.entries.every(x => Object.isFrozen(x) && Object.isFrozen(x.tags) && Object.isFrozen(x.meta))));
  }
}
check(() => assert.deepEqual(protocol.cases.map(x => [x.id, x.size, x.ladder]), [
  ['drain-number-65',65,[1,8,64,512,4096]],
  ['drain-number-4097',4097,[1,4,16,64,256]],
  ...[['peek-prefix-warm',4097],['peek-alternate-roots',33],['peek-alternate-blocks',4097],['peek-empty',0],['peek-tail-only',32]].map(([id,size])=>[id,size,[1024,8192,65536,524288,4194304]]),
  ['drain-object-4097-mixed-decode',4097,[1,2,4,8,16]],
]));
console.log(JSON.stringify({subjectContractChecks:checks,passed:true,candidateImported:false,operationClocks:false}));
