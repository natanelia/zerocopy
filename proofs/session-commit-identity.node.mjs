import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Clock-free source-operation census, never a physical-allocation or speed test.
// Run separately against each freshly built exact-source checkout:
// node proofs/session-commit-identity.node.mjs <checkout> <baseline|candidate>
const root = resolve(process.argv[2] ?? '.'), arm = process.argv[3];
assert.ok(arm === 'baseline' || arm === 'candidate', 'Supply baseline or candidate');
const z = await import(pathToFileURL(join(root, 'dist/shared.js')).href);
const { createSharedState } = await import(pathToFileURL(join(root, 'dist/worker.js')).href);
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function census(action) {
  const originalKeys = Object.keys, originalEvery = Array.prototype.every;
  const counts = { keyArrays: 0, keySlots: 0, everyCalls: 0, everyCallbacks: 0 };
  Object.keys = value => {
    const keys = originalKeys(value);
    counts.keyArrays++; counts.keySlots += keys.length;
    return keys;
  };
  Array.prototype.every = function (callback, thisArg) {
    counts.everyCalls++;
    return originalEvery.call(this, (value, index, values) => {
      counts.everyCallbacks++;
      return callback.call(thisArg, value, index, values);
    });
  };
  try { return { value: action(), ...counts }; }
  finally { Object.keys = originalKeys; Array.prototype.every = originalEvery; }
}

function expected(keys, slots, calls, callbacks) {
  return { keyArrays: keys, keySlots: slots, everyCalls: calls, everyCallbacks: callbacks };
}
function check(row, counts, value) {
  assert.deepEqual(row, { value, ...counts });
}

const rows = [];
for (const roots of [0, 1, 256]) {
  let serializations = 0;
  class ObservedMap extends z.SharedMap {
    toWorkerData() { serializations++; return super.toWorkerData(); }
  }
  const handle = new ObservedMap('number'), initial = Object.create(null);
  for (let i = 0; i < roots; i++) initial[`root-${i}`] = handle;
  const state = createSharedState(initial, { copy: false });
  try {
    assert.equal(serializations, roots);
    const flush = census(() => state.flush());
    check(flush, arm === 'baseline' ? expected(2, roots * 2, 1, roots) : expected(0, 0, 0, 0), 0);
    rows.push({ case: 'unchanged-flush', roots, ...flush });

    const beforePublish = serializations;
    const publish = census(() => state.publish({ ...state.current }));
    check(publish, arm === 'baseline' ? expected(4, roots * 4, 2, roots * 2) : expected(2, roots * 2, 1, roots), 0);
    assert.equal(serializations - beforePublish, roots, 'No serializer may be skipped');
    rows.push({ case: 'unchanged-publish', roots, serializations: serializations - beforePublish, ...publish });

    const changed = roots ? { ...initial, 'root-0': handle.set('n', 1) } : { added: handle.set('n', 1) };
    state.update(() => changed);
    state.update(() => initial);
    const reverted = census(() => state.flush());
    check(reverted, expected(2, roots * 2, 1, roots), 0);
    rows.push({ case: 'distinct-equal-capture', roots, ...reverted });

    const changedPublish = census(() => state.publish(changed));
    check(changedPublish, roots ? expected(4, roots * 4, 2, 2) : expected(4, 2, 0, 0), 1);
    rows.push({ case: 'changed-publish', roots, ...changedPublish });
    assert.equal(state.version, 1);
  } finally { state.dispose(); }
}

console.log(JSON.stringify({
  status: 'passed', arm, runtime: process.version, bun: process.versions.bun ?? null,
  note: 'Executed API calls and returned key slots; no operation clocks, heap/RSS, or speed claim.',
  inputs: {
    workerSource: sha256(join(root, 'worker.ts')),
    protocolSource: sha256(join(root, 'worker-protocol.ts')),
    sharedModule: sha256(join(root, 'dist/shared.js')),
    workerModule: sha256(join(root, 'dist/worker.js')),
  }, rows,
}, null, 2));
