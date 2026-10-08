import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { Arena, arenaOf, HEAP_START } from './arena';
import { SharedList, SharedQueue, SharedLinkedList, SharedDoublyLinkedList, SharedMap, compact, compactMany, getWorkerData, initWorker } from './shared';

const counts = [0, 1, 31, 32, 33, 1024, 1025, 4097];
const kinds = ['list', 'queue', 'linked', 'doubly'] as const;
type Kind = typeof kinds[number];
function create(kind: Kind, type: 'number' | 'boolean', values: any[], arena = new Arena()): any {
  if (kind === 'list') return new SharedList(type, 0, 0, 0, arena).pushMany(values);
  let result: any = kind === 'queue' ? new SharedQueue(type, 0, 0, 0, undefined, arena)
    : kind === 'linked' ? new SharedLinkedList(type, 0, 0, 0, arena) : new SharedDoublyLinkedList(type, 0, 0, 0, arena);
  for (const value of values) result = kind === 'queue' ? result.enqueue(value) : result.append(value);
  return result;
}
function valuesOf(value: any, kind: Kind): any[] {
  if (kind !== 'queue') return value.toArray();
  const values: any[] = [];
  while (value.size) { values.push(value.peek()); value = value.dequeue(); }
  return values;
}
function sourceBytes(value: object) { const a = arenaOf(value); return a.buf.slice(HEAP_START, a.used); }
function unchanged(value: object, before: Uint8Array): void {
  const a = arenaOf(value);
  assert.strictEqual(a.used - HEAP_START, before.length);
  assert.strictEqual(Buffer.compare(a.buf.subarray(HEAP_START, a.used), before), 0);
}

describe('primitive compaction byte spans', () => {
  for (const kind of kinds) for (const type of ['number', 'boolean'] as const) test(`${kind} ${type} preserves block boundaries and source bytes`, () => {
    for (const count of counts) {
      const expected = Array.from({ length: count }, (_, i) => type === 'number' ? i % 7 === 0 ? -0 : i / 8 : i % 3 === 0);
      const source = create(kind, type, expected), bytes = sourceBytes(source), result = compact(source);
      assert.deepStrictEqual(valuesOf(result, kind), expected);
      unchanged(source, bytes);
      assert.deepStrictEqual(valuesOf(source, kind), expected);
      assert.notStrictEqual(arenaOf(result), arenaOf(source));
      const value = type === 'number' ? -123 : true;
      const next = kind === 'list' ? result.push(value) : kind === 'queue' ? result.enqueue(value) : result.append(value);
      assert.deepStrictEqual(valuesOf(next, kind), [...expected, value]);
      assert.deepStrictEqual(valuesOf(result, kind), expected);
    }
  });

  test('queues compact unaligned consumed prefixes, including offsets inside their tail', () => {
    for (const type of ['number', 'boolean'] as const) {
      const all = Array.from({ length: 1091 }, (_, i) => type === 'number' ? i : i % 2 === 0);
      const original = create('queue', type, all);
      for (const offset of [0, 1, 15, 31, 32, 33, 1023, 1024, 1025, 1088, 1089, 1090, 1091]) {
        let source = original;
        for (let i = 0; i < offset; i++) source = source.dequeue();
        const result: any = compact(source);
        assert.deepStrictEqual(valuesOf(result, 'queue'), all.slice(offset));
        assert.strictEqual(result.tail, 0);
      }
      assert.deepStrictEqual(valuesOf(original, 'queue'), all);
    }
  });

  for (const kind of ['linked', 'doubly'] as const) test(`${kind} copies shortened, split, and tail-free spans`, () => {
    let source = create(kind, 'number', Array.from({ length: 1073 }, (_, i) => i));
    const old = source, expected = old.toArray();
    for (let i = 0; i < 80; i++) { source = source.removeFirst(); expected.shift(); }
    for (let i = 0; i < 50; i++) {
      const index = (i * 13) % (expected.length - 1);
      source = source.insertAfter(index, -i); expected.splice(index + 1, 0, -i);
      source = kind === 'linked' ? source.removeAfter(index + 1) : source.remove(index + 2); expected.splice(index + 2, 1);
    }
    const tailFree = create(kind, 'number', Array.from({ length: 64 }, (_, i) => i)).insertAfter(62, 777);
    assert.strictEqual(tailFree.tailSize, 0);
    const bytes = sourceBytes(source), result = compact(source);
    assert.deepStrictEqual(result.toArray(), expected);
    assert.deepStrictEqual(compact(tailFree).toArray(), tailFree.toArray());
    assert.deepStrictEqual(old.toArray(), Array.from({ length: 1073 }, (_, i) => i));
    unchanged(source, bytes);
  });

  test('copies raw float bits without canonicalizing NaN payloads or negative zero', () => {
    const bits = [0x8000000000000000n, 0x7ff0000000000000n, 0xfff0000000000000n,
      0x7ff8000000000001n, 0x7ff0000000000042n, 0xfff8000000001234n, 0x0000000000000001n];
    for (const kind of kinds) {
      const a = new Arena(), input = a.alloc(65 * 8);
      for (let i = 0; i < 65; i++) a.dv.setBigUint64(input + i * 8, bits[i % bits.length], true);
      const root = a.wasm.vecLink(0, 0, 1, 0, input, 64) >>> 0;
      const head = a.wasm.blockBuild(input, 2) >>> 0;
      const source = kind === 'list' ? new SharedList('number', root, 1, 65, a, input + 512)
        : kind === 'queue' ? new SharedQueue('number', root, 1, 64, undefined, a, input + 512, 1)
        : kind === 'linked' ? new SharedLinkedList('number', head, input + 512, 65, a, 1)
        : new SharedDoublyLinkedList('number', head, input + 512, 65, a, 1);
      const result: any = compact(source), target = arenaOf(result), expectedOffset = kind === 'queue' ? 1 : 0;
      assert.deepStrictEqual(valuesOf(result, kind), valuesOf(source, kind));
      // Compaction allocates one contiguous live-value range before its nodes.
      for (let i = 0; i < result.size; i++) assert.strictEqual(target.dv.getBigUint64(HEAP_START + i * 8, true), bits[(i + expectedOffset) % bits.length]);
    }
  });

  test.each([false, true])('read-only transport, nested sharing and target growth remain safe, copy=%s', async copy => {
    const source = create('list', 'number', Array.from({ length: 32769 }, (_, i) => i));
    const prefix = create('list', 'boolean', Array.from({ length: 4096 }, (_, i) => i % 2 === 0));
    const outer = new SharedMap('SharedList<number>').set('a', source).set('b', source);
    const attached = await initWorker(getWorkerData({ source, outer }, { copy }));
    const bytes = sourceBytes(attached.source);
    const result = compactMany({ prefix, source: attached.source, outer: attached.outer, same: attached.source });
    assert.deepStrictEqual(result.prefix.toArray(), prefix.toArray());
    assert.strictEqual(result.source, result.same);
    assert.deepStrictEqual(result.source.toArray(), source.toArray());
    assert.deepStrictEqual(result.outer.get('a')!.toArray(), source.toArray());
    assert.deepStrictEqual(result.outer.get('a')!.toWorkerData(), result.source.toWorkerData());
    assert.strictEqual(arenaOf(result.outer), arenaOf(result.source));
    unchanged(attached.source, bytes);
    assert.throws(() => attached.source.push(1), /read-only/);
    assert.strictEqual(result.source.push(99).get(32769), 99);
  });

  test('rejects inconsistent sequence counts and truncated spans', () => {
    const a = new Arena(), input = a.alloc(32 * 8), head = a.wasm.blockBuild(input, 1) >>> 0;
    for (const C of [SharedLinkedList, SharedDoublyLinkedList]) {
      assert.throws(() => compact(new C('number', head, 0, 31, a, 0)), /Invalid sequence descriptor/);
      assert.throws(() => compact(new C('boolean', head, 0, 33, a, 0)), /Invalid sequence descriptor/);
      assert.throws(() => compact(new C('number', 0, a.buf.byteLength - 8, 2, a, 2)), RangeError);
      // Legacy descriptors permit these tailSize values; keep their old
      // per-element interpretation rather than changing their acceptance.
      assert.strictEqual(compact(new C('number', 0, 0, 0, a, -1)).size, 0);
      assert.deepStrictEqual(compact(new C('number', 0, input, 1, a, 0.5)).toArray(), [0]);
    }
    assert.throws(() => compact(new SharedList('number', 0, 0, 2, a, a.buf.byteLength - 8)), RangeError);
  });
});
