import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const UPDATES = 1024;
export const MAX_CHECKED_ELEMENTS = 1048576;
export const MAX_SHARED_BYTES = 16 * 1024 * 1024;
export const CASES = Object.freeze([
  { name: 'tail-number-noop', type: 'number', size: 1, index: 0, mode: 'noop', role: 'target' },
  { name: 'tree-number-noop', type: 'number', size: 65537, index: 32768, mode: 'noop', role: 'target' },
  { name: 'tree-boolean-noop', type: 'boolean', size: 1057, index: 511, mode: 'noop', role: 'target' },
  { name: 'tree-string-noop', type: 'string', size: 1057, index: 511, mode: 'noop', role: 'target' },
  { name: 'tail-number-changed', type: 'number', size: 1, index: 0, mode: 'changed', role: 'changed-write control' },
  { name: 'tree-number-changed', type: 'number', size: 65537, index: 32768, mode: 'changed', role: 'changed-write control' },
  { name: 'tree-boolean-changed', type: 'boolean', size: 1057, index: 511, mode: 'changed', role: 'changed-write control' },
  { name: 'tree-string-changed', type: 'string', size: 1057, index: 511, mode: 'changed', role: 'changed-write control' },
  { name: 'tree-json-reencode', type: 'object', size: 1057, index: 511, mode: 'reencode', role: 'generic fallback' },
  { name: 'get-control', type: 'number', size: 65537, mode: 'get', role: 'unchanged read control' },
].map(Object.freeze));
const sha = value => createHash('sha256').update(value).digest('hex');
const HEAP_START = 65536;

export function makeWorkload(api, spec) {
  const Arena = new api.SharedList('number').arena.constructor;
  const strings = Array.from({ length: 8 }, (_, i) => `interned-${i}-界🙂`);
  const input = Array.from({ length: spec.size }, (_, i) => spec.type === 'number' ? i + .25
    : spec.type === 'boolean' ? !!(i & 1) : spec.type === 'string' ? strings[i & 7] : { i, tag: '界🙂' });
  const requests = Array.from({ length: UPDATES }, (_, i) => spec.mode !== 'changed' ? input[spec.index]
    : spec.type === 'number' ? -(i + 1.25) : spec.type === 'boolean' ? (i & 1 ? input[spec.index] : !input[spec.index]) : strings[i & 7]);
  const queries = Array.from({ length: UPDATES }, (_, i) => (i * 67) % spec.size);
  const expected = spec.mode === 'get' ? queries.map(index => input[index]) : [...input];
  if (spec.mode !== 'get') for (const value of requests) expected[spec.index] = value;
  const tailStart = (spec.size - 1) & ~31, prefix = tailStart;
  let depth = 0; for (let capacity = 32; prefix > capacity; capacity *= 32) depth++;
  const nodeBytes = spec.mode === 'get' ? 0 : spec.index >= tailStart ? (spec.size - tailStart) * 8 : 256 + depth * 128;
  const blobBytes = spec.type === 'object' ? Math.ceil((4 + new TextEncoder().encode(JSON.stringify(requests[0])).length) / 8) * 8 : 0;
  const worstSharedBytesPerOperation = (nodeBytes + blobBytes) * (spec.mode === 'get' ? 0 : UPDATES);
  const maxRepeat = Math.max(1, Math.min(65536, Math.floor(MAX_CHECKED_ELEMENTS / expected.length),
    worstSharedBytesPerOperation ? Math.floor(MAX_SHARED_BYTES / worstSharedBytesPerOperation) : 65536));
  const expectedDigest = sha(JSON.stringify(expected));
  function check(actual, wanted) {
    assert.ok(Array.isArray(actual));
    assert.equal(actual.length, wanted.length);
    for (let i = 0; i < wanted.length; i++) {
      if (spec.type === 'object') {
        const value = actual[i];
        if (!value || value.i !== wanted[i].i || value.tag !== wanted[i].tag || Object.keys(value).length !== 2
          || !Object.hasOwn(value, 'i') || !Object.hasOwn(value, 'tag') || !Object.isFrozen(value)) throw new Error(`Object mismatch at ${i}`);
      } else if (!Object.is(actual[i], wanted[i])) throw new Error(`Value mismatch at ${i}`);
    }
  }
  function prepare(candidate) {
    const arena = new Arena(), source = new api.SharedList(spec.type, 0, 0, 0, arena).pushMany(input);
    assert.equal(source.size, spec.size); assert.equal(source.depth, depth);
    check(source.toArray(), input);
    const used = arena.used, sourceHash = sha(new Uint8Array(arena.memory.buffer, HEAP_START, used - HEAP_START));
    const bufferBytes = arena.memory.buffer.byteLength;
    const allocatedPerOperation = candidate && spec.mode === 'noop' ? 0 : worstSharedBytesPerOperation;
    function materialize() {
      if (spec.mode === 'get') {
        const result = new Array(UPDATES);
        for (let i = 0; i < UPDATES; i++) result[i] = source.get(queries[i]);
        return result;
      }
      let result = source;
      for (let i = 0; i < UPDATES; i++) result = result.set(spec.index, requests[i]);
      return result;
    }
    function verify(result) {
      if (spec.mode === 'get') { check(result, expected); return; }
      assert.notEqual(result, source); assert.ok(Object.isFrozen(result));
      assert.equal(result.arena, arena); assert.equal(result.type, spec.type); assert.equal(result.size, source.size); assert.equal(result.depth, source.depth);
      const sameStorage = result.root === source.root && result.tail === source.tail;
      assert.equal(sameStorage, candidate && spec.mode === 'noop');
      check(result.toArray(), expected);
    }
    function finish(repeat) {
      check(source.toArray(), input);
      assert.equal(sha(new Uint8Array(arena.memory.buffer, HEAP_START, used - HEAP_START)), sourceHash, 'A published source byte changed');
      const allocatedBytes = arena.used - used, expectedAllocatedBytes = repeat * allocatedPerOperation;
      assert.equal(allocatedBytes, expectedAllocatedBytes, 'Unexpected shared allocation');
      return { sourceUsed: used, sourceSha256: sourceHash, sourceBufferBytes: bufferBytes, sourceVerifiedElements: 2 * spec.size,
        allocatedBytes, expectedAllocatedBytes, finalBufferBytes: arena.memory.buffer.byteLength,
        sourceBytesUnchanged: true };
    }
    return { materialize, verify, finish };
  }
  return { prepare, expectedDigest, outputElements: expected.length, maxRepeat,
    updatesPerOperation: UPDATES, nodeBytes, blobBytes, worstSharedBytesPerOperation };
}
