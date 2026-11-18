import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'list-boolean-encoding-20261108',
  baseline: 'a4265a0608ec25eec5719496225212db6b251989',
  changedSources: ['arena.ts'],
  changedWasm: [],
  pilotCases: ['boolean-255-control', 'boolean-256', 'boolean-1024', 'boolean-32768', 'boolean-262144', 'number-control-1024'],
  aaCases: ['boolean-1024', 'boolean-32768', 'number-control-1024', 'scalar-boolean-push-control'],
  cases: [
    { name: 'boolean-255-control', role: 'control', kind: 'bulk', type: 'boolean', prefix: 0, count: 255, repetitions: 2048 },
    { name: 'boolean-256', role: 'threshold', kind: 'bulk', type: 'boolean', prefix: 0, count: 256, repetitions: 2048 },
    { name: 'boolean-1024', role: 'target', kind: 'bulk', type: 'boolean', prefix: 0, count: 1024, repetitions: 512 },
    { name: 'boolean-32768', role: 'target', kind: 'bulk', type: 'boolean', prefix: 0, count: 32768, repetitions: 32 },
    { name: 'boolean-262144', role: 'target', kind: 'bulk', type: 'boolean', prefix: 0, count: 262144, repetitions: 4 },
    { name: 'boolean-prefix-31', role: 'target', kind: 'bulk', type: 'boolean', prefix: 31, count: 1024, repetitions: 512 },
    { name: 'boolean-prefix-32', role: 'target', kind: 'bulk', type: 'boolean', prefix: 32, count: 1024, repetitions: 512 },
    { name: 'boolean-prefix-65', role: 'target', kind: 'bulk', type: 'boolean', prefix: 65, count: 1024, repetitions: 512 },
    { name: 'number-control-1024', role: 'control', kind: 'bulk', type: 'number', prefix: 65, count: 1024, repetitions: 512 },
    { name: 'string-control-256', role: 'control', kind: 'bulk', type: 'string', prefix: 31, count: 256, repetitions: 256 },
    { name: 'object-control-128', role: 'control', kind: 'bulk', type: 'object', prefix: 31, count: 128, repetitions: 64 },
    { name: 'scalar-boolean-push-control', role: 'control', kind: 'scalar', type: 'boolean', prefix: 17, count: 1, repetitions: 32768 },
  ],
};

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => typeof value === 'number'
  ? Number.isNaN(value) ? ['NaN'] : Object.is(value, -0) ? ['-0']
    : value === Infinity ? ['+Infinity'] : value === -Infinity ? ['-Infinity'] : value
  : value;
const specials = [NaN, -0, Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE];
function value(type, index, prefix = false) {
  if (type === 'boolean') return prefix ? index % 5 === 0 : index % 3 === 0 || index % 7 === 2;
  if (type === 'number') return index % 127 === 0 ? specials[(index / 127 | 0) % specials.length] : index + 0.25;
  if (type === 'string') return `${prefix ? 'prefix' : 'value'}/é/界/🙂/${index}`;
  return { id: prefix ? -index - 1 : index, flags: [index % 2 === 0, index % 3 === 0], point: [index, index + 0.25] };
}

export function makeFixture(spec) {
  const prefix = Array.from({ length: spec.prefix }, (_, i) => value(spec.type, i, true));
  const input = Array.from({ length: spec.count }, (_, i) => value(spec.type, i));
  const expected = [...prefix, ...input];
  return { prefix, input, expected };
}

export async function createWorkload(directory, spec) {
  const S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
  const { prefix, input, expected } = makeFixture(spec);
  let source, arena, sourceBytes, descriptor;
  function prepareBatch() {
    S.resetSharedList();
    source = new S.SharedList(spec.type).pushMany(prefix);
    const packet = S.getWorkerData({ source }, { copy: false });
    arena = packet.arenas[0]; descriptor = packet.structures.source.data;
    sourceBytes = hash(new Uint8Array(arena.memory.buffer, 65536, arena.used - 65536));
  }
  prepareBatch();
  return {
    prepareBatch,
    operation() { return spec.kind === 'scalar' ? source.push(input[0]) : source.pushMany(input); },
    verify(result) {
      assert.ok(result instanceof S.SharedList);
      assert.ok(Object.isFrozen(result)); assert.notStrictEqual(result, source);
      assert.equal(result.type, spec.type); assert.equal(result.size, expected.length);
      assert.deepEqual(result.toArray(), expected);
      if (spec.type === 'object') {
        const object = result.get(spec.prefix);
        assert.ok(Object.isFrozen(object)); assert.ok(Object.isFrozen(object.flags)); assert.ok(Object.isFrozen(object.point));
      }
    },
    checkInvariant() {
      assert.deepEqual(source.toArray(), prefix);
      const packet = S.getWorkerData({ source }, { copy: false });
      assert.deepEqual(packet.structures.source.data, descriptor);
      assert.strictEqual(packet.arenas[0].memory, arena.memory);
      assert.ok(packet.arenas[0].used >= arena.used);
      assert.equal(hash(new Uint8Array(arena.memory.buffer, 65536, arena.used - 65536)), sourceBytes);
    },
    expectedDigest: hash(JSON.stringify({ spec, expected: expected.map(canonical) })),
    fixture: {
      type: spec.type, sourceCount: spec.prefix, appendCount: spec.count, resultCount: expected.length,
      sourceHash: sourceBytes,
      sourceConstruction: 'fresh private List arena and original prefix before every batch, outside timing',
      timedOperation: spec.kind === 'scalar' ? 'source.push(input[0]), retaining the returned snapshot'
        : 'source.pushMany(input), including validation, temporary storage, final value storage, tree linking and snapshot construction',
      oracle: 'every result value via unchanged public toArray, size, type, frozen handles, complete original prefix and all original published bytes',
      inputShape: 'ordinary dense Array; reused input values and independently retained forks from one immutable source per batch',
    },
  };
}
