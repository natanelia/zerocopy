import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const cases = [
  { name: 'float64-32', role: 'small-input', kind: 'typed', count: 32, repetitions: 8192 },
  { name: 'float64-4096', role: 'target', kind: 'typed', count: 4096, repetitions: 1024 },
  { name: 'float64-65536', role: 'target', kind: 'typed', count: 65536, repetitions: 64 },
  { name: 'float64-1048576', role: 'large-input', kind: 'typed', count: 1048576, repetitions: 4 },
  { name: 'float64-subview-65536', role: 'subview', kind: 'typed', count: 65536, offset: 7, repetitions: 64 },
  { name: 'float64-shared-65536', role: 'shared-input', kind: 'typed', count: 65536, shared: true, repetitions: 64 },
  { name: 'float64-only-4096', role: 'typed-only-history', kind: 'typed', count: 4096, typedSetup: true, repetitions: 1024 },
  { name: 'float64-only-65536', role: 'typed-only-history', kind: 'typed', count: 65536, typedSetup: true, repetitions: 64 },
  { name: 'array-build-control-32', role: 'control', kind: 'array', count: 32, repetitions: 8192 },
  { name: 'scalar-append-control-2048', role: 'control', kind: 'push', count: 2048, append: 256, repetitions: 256 },
  { name: 'numeric-range-control-65569', role: 'optional-numeric-control', kind: 'numeric-range', count: 65569, repetitions: 512 },
  { name: 'numeric-box-control-65538', role: 'optional-numeric-control', kind: 'numeric-box', count: 65538, repetitions: 512 },
];

export const study = {
  id: 'list-float64-numeric-20261108',
  baseline: '0ac8a005268335a6116f025e75f670b5cee6843e',
  changedSources: ['numeric.ts', 'tsconfig.numeric.json'],
  changedWasm: [],
  pilotCases: ['float64-32', 'float64-65536', 'float64-only-4096', 'float64-only-65536', 'float64-shared-65536', 'array-build-control-32', 'scalar-append-control-2048', 'numeric-range-control-65569', 'numeric-box-control-65538'],
  aaCases: ['float64-65536', 'float64-only-65536', 'array-build-control-32', 'scalar-append-control-2048', 'numeric-range-control-65569', 'numeric-box-control-65538'],
  cases,
};

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const valueAt = i => ((Math.imul(i, 8191) >>> 0) % 65537) - 32768 + 0.25;
const tailLength = count => count ? ((count - 1) & 31) + 1 : 0;
function depthFor(count) {
  let depth = 0, capacity = 32;
  while (count > capacity) { depth++; capacity *= 32; }
  return depth;
}
function equalNumbers(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) if (!Object.is(actual[i], expected[i])) {
    assert.fail(`Value mismatch at ${i}: ${actual[i]} != ${expected[i]}`);
  }
}

export async function createWorkload(directory, spec) {
  assert.equal(new Uint8Array(new Uint16Array([1]).buffer)[0], 1,
    'This recorded byte-oracle benchmark is scoped to a little-endian host');
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const offset = spec.offset ?? 0;
  const backing = spec.shared ? new SharedArrayBuffer((spec.count + offset + 3) * 8)
    : new ArrayBuffer((spec.count + offset + 3) * 8);
  const input = new Float64Array(backing, offset * 8, spec.count);
  for (let i = 0; i < input.length; i++) input[i] = valueAt(i);
  const range = [-8192, 8192], bounds = { minX: -100, minY: -50, maxX: 100, maxY: 50 };
  if (spec.kind === 'numeric-range') {
    [NaN, Infinity, -Infinity, -0, 0, ...range].forEach((value, i) => { input[i] = value; });
    input[input.length - 1] = range[1];
  }
  if (spec.kind === 'numeric-box') {
    for (let i = 0; i < input.length / 2; i++) {
      input[i * 2] = (Math.imul(i, 17) % 1009) - 504 + 0.25;
      input[i * 2 + 1] = (Math.imul(i, 97) % 1013) - 506 + 0.5;
    }
    input.set([NaN, 0, Infinity, 0, -Infinity, 0, -0, 0, -100, -50, 100, 50]);
    input[input.length - 2] = 100; input[input.length - 1] = 50;
  }
  const array = Array.from(input), inputBytes = Buffer.from(new Uint8Array(backing, input.byteOffset, input.byteLength));
  const backingBytes = Buffer.from(new Uint8Array(backing));
  // Root-only controls deliberately do not load the optional numeric entry.
  const readControl = spec.kind === 'numeric-range' || spec.kind === 'numeric-box';
  const N = spec.kind === 'typed' || readControl
    ? await import(pathToFileURL(join(directory, 'dist/numeric.js'))) : null;
  const construct = typeof N?.fromFloat64 === 'function'
    ? values => N.fromFloat64(values)
    : values => new S.SharedList('number').pushMany(values);
  const importCase = spec.kind === 'typed' || spec.kind === 'array';
  const sourceValues = importCase ? [3.5, -0, 17.25, -99] : array;
  const suffix = Array.from({ length: spec.append ?? 0 }, (_, i) => -i - 0.5);
  let expectedCount = 0;
  if (spec.kind === 'numeric-range') {
    for (const value of array) if (value >= range[0] && value <= range[1]) expectedCount++;
  } else if (spec.kind === 'numeric-box') {
    for (let i = 0; i < array.length; i += 2) {
      if (array[i] >= bounds.minX && array[i] <= bounds.maxX
        && array[i + 1] >= bounds.minY && array[i + 1] <= bounds.maxY) expectedCount++;
    }
  }
  const expected = spec.kind === 'push' ? [...array, ...suffix] : array;
  let source, memory, used, sourceBytes, materialized;
  function prepareBatch() {
    // The first untimed operation primes the existing numeric kernel once.
    // Reusing its immutable source keeps kernel instantiation outside timing.
    if (readControl && source) return;
    S.resetSharedList();
    source = new S.SharedList('number').pushMany(spec.typedSetup ? new Float64Array(sourceValues) : sourceValues);
    const packet = S.getWorkerData({ source }, { copy: false });
    memory = packet.arenas[0].memory; used = packet.arenas[0].used;
    sourceBytes = Buffer.from(new Uint8Array(memory.buffer, 65536, used - 65536));
    materialized = false;
  }
  prepareBatch();
  const initialUsed = used;

  function verifyImport(result) {
    assert.ok(result instanceof S.SharedList); assert.ok(Object.isFrozen(result));
    assert.equal(result.type, 'number'); assert.equal(result.size, spec.count);
    const packet = S.getWorkerData({ result }, { copy: false });
    assert.equal(packet.arenas.length, 1);
    assert.strictEqual(packet.arenas[0].memory, memory, 'Each result must use the expected writer arena');
    const treeSize = spec.count - tailLength(spec.count), depth = depthFor(treeSize);
    assert.equal(result.depth, depth);
    const inputAddress = result.tail - treeSize * 8;
    assert.ok(inputAddress >= used && inputAddress % 8 === 0);
    assert.ok(Buffer.from(memory.buffer, inputAddress, spec.count * 8).equals(inputBytes), 'Every encoded input byte must match');
    const view = new DataView(memory.buffer);
    function verifyBranch(pointer, level, first) {
      if (!level) { assert.equal(pointer, inputAddress + first * 8); return; }
      assert.ok(pointer >= inputAddress + spec.count * 8 && pointer + 128 <= view.byteLength && pointer % 8 === 0);
      const span = 32 ** level;
      for (let slot = 0; slot < 32; slot++) {
        const index = first + slot * span, child = view.getUint32(pointer + slot * 4, true);
        if (index >= treeSize) assert.equal(child, 0);
        else verifyBranch(child, level - 1, index);
      }
    }
    if (treeSize) verifyBranch(result.root, depth, 0);
    else assert.equal(result.root, 0);
    // Full byte comparison and every link above prove all values of every
    // retained result. Also exercise complete public materialization once per
    // batch, without allocating millions of oracle arrays on the fastest path.
    if (!materialized) { equalNumbers(result.toArray(), array); materialized = true; }
  }

  return {
    prepareBatch,
    operation() {
      if (spec.kind === 'typed') return construct(input);
      if (spec.kind === 'array') return new S.SharedList('number').pushMany(array);
      if (spec.kind === 'numeric-range') return N.countInRange(source, range[0], range[1]);
      if (spec.kind === 'numeric-box') return N.countPointsInBox(source, bounds);
      if (spec.kind === 'push') {
        let result = source;
        for (const value of suffix) result = result.push(value);
        return result;
      }
      throw new Error(`Unknown case kind: ${spec.kind}`);
    },
    verify(result) {
      if (importCase) return verifyImport(result);
      if (readControl) return assert.equal(result, expectedCount);
      assert.ok(result instanceof S.SharedList); assert.notStrictEqual(result, source);
      assert.ok(Object.isFrozen(result)); assert.equal(result.type, 'number');
      assert.equal(result.size, expected.length); equalNumbers(result.toArray(), expected);
    },
    checkInvariant() {
      assert.equal(source.size, sourceValues.length);
      if (readControl) assert.equal(S.getWorkerData({ source }, { copy: false }).arenas[0].used, used,
        'Existing numeric readers must not allocate in the source arena');
      assert.ok(Buffer.from(memory.buffer, 65536, used - 65536).equals(sourceBytes), 'Published source bytes unchanged');
      equalNumbers(source.toArray(), sourceValues);
      assert.ok(Buffer.from(backing).equals(backingBytes), 'Entire input buffer including subview margins unchanged');
    },
    expectedDigest: hash(JSON.stringify({ spec, sourceValues, input: hash(inputBytes), suffix, expected, range, bounds, expectedCount })),
    fixture: {
      kind: spec.kind, count: spec.count, initialUsed, offset, shared: Boolean(spec.shared),
      optionalNumericEntryImported: Boolean(N),
      reset: readControl
        ? 'One ordinary-array source reused across batches; initial untimed operation primes the existing numeric kernel'
        : spec.typedSetup
        ? 'Private writer reset and Float64Array source construction through existing pushMany before every batch, outside timing'
        : 'Private writer reset and ordinary-array source construction before every batch, outside timing',
      timedOperation: spec.kind === 'typed' ? 'Before: new SharedList(number).pushMany(the same Float64Array); after: fromFloat64(the same Float64Array) from zerocopy/numeric; no Array.from conversion in either timed path'
        : spec.kind === 'array' ? 'One existing constructor plus pushMany call with the same ordinary number array'
        : spec.kind === 'numeric-range' ? 'One existing public countInRange call over every source value, with inclusive bounds'
        : spec.kind === 'numeric-box' ? 'One existing public countPointsInBox call over every coordinate pair, with inclusive bounds'
        : spec.kind === 'push' ? `${spec.append} existing public push calls, retaining the final result`
        : 'Unknown operation',
      oracle: importCase ? 'Every output: frozen handle/shape, exact full leaf bytes and every tree pointer; first output per batch fully materialized publicly; complete prior snapshot and input bytes checked after every batch'
        : readControl ? 'Every returned integer checked against an independent complete JavaScript predicate scan; full source values, all published bytes, input bytes and used offset checked after every batch'
        : 'Every output value and shape checked; complete prior snapshot and input bytes checked after every batch',
      inputTiming: 'Typed input, ordinary-array controls, oracle, and backing-buffer allocation prepared outside timing',
    },
  };
}
