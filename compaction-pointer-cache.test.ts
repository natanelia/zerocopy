import assert from 'node:assert/strict';
import { describe, test, expect } from 'vitest';
import * as S from './shared';
import { Arena, arenaOf, HEAP_START } from './arena';

function raw(list: S.SharedList<any>, i = 0) {
  const a = arenaOf(list), d = list.toWorkerData();
  return a.dv.getFloat64(d.tail + i * 8, true);
}
function leaf(map: S.SharedMap<any> | S.SharedOrderedMap<any>, key: string) {
  const a = arenaOf(map);
  return [...a.leaves(map.root)].find(p => a.leafKey(p) === key)!;
}
function stackValues(stack: S.SharedStack<any>) {
  const values = [];
  while (stack.size) { values.push(stack.peek()); stack = stack.pop(); }
  return values;
}

describe('compaction pointer cache domains', () => {
  for (const copy of [false, true]) test(`logical arena IDs share across attachment sessions, copy=${copy}`, async () => {
    const a = new Arena();
    const list = new S.SharedList('string', 0, 0, 0, a).pushMany(['same', 'other']);
    const more = list.push('third');
    const map = new S.SharedMap('string', 0, 0, a).setMany([['a', 'A'], ['b', 'B']]);
    const changed = map.set('c', 'C');
    const stack = new S.SharedStack('string', 0, 0, undefined, a).push('one').push('two');
    const pushed = stack.push('three');
    const data = S.getWorkerData({ list, more, map, changed, stack, pushed }, { copy });
    const first = await S.initWorker(data), second = await S.initWorker(data);
    assert.notStrictEqual(arenaOf(first.list), arenaOf(second.list));
    expect(arenaOf(first.list).id).toBe(arenaOf(second.list).id);
    const result = S.compactMany({ list: first.list, more: second.more, map: first.map, changed: second.changed, stack: first.stack, pushed: second.pushed });
    expect(result.list.toArray()).toEqual(['same', 'other']);
    expect(result.more.toArray()).toEqual(['same', 'other', 'third']);
    expect(raw(result.list)).toBe(raw(result.more));
    expect(leaf(result.map, 'a')).toBe(leaf(result.changed, 'a'));
    expect(result.pushed.pop().head).toBe(result.stack.head);
    const sameSession = S.compactMany({ list: first.list, more: first.more, map: first.map, changed: first.changed, stack: first.stack, pushed: first.pushed });
    expect(arenaOf(result.list).used).toBe(arenaOf(sameSession.list).used);
    expect(() => first.list.push('blocked')).toThrow(/read-only/);
    expect(result.list.push('writable').toArray()).toEqual(['same', 'other', 'writable']);
  });

  for (const copy of [false, true]) test(`first cache group survives fallback groups across attachments, copy=${copy}`, async () => {
    const a = new Arena(), b = new Arena();
    const list = new S.SharedList('string', 0, 0, 0, a).push('first');
    const more = list.push('later');
    const object = new S.SharedList('object', 0, 0, 0, a).push({ value: 'object' });
    const other = new S.SharedList('string', 0, 0, 0, b).push('other');
    const otherMore = other.push('last');
    expect(raw(list)).toBe(raw(other));
    const data = S.getWorkerData({ list, more, object, other, otherMore }, { copy });
    const first = await S.initWorker(data), second = await S.initWorker(data);
    const result = S.compactMany({
      list: first.list, object: first.object, other: first.other,
      more: second.more, otherMore: second.otherMore,
    });
    expect(result.list.toArray()).toEqual(['first']);
    expect(result.object.toArray()).toEqual([{ value: 'object' }]);
    expect(result.more.toArray()).toEqual(['first', 'later']);
    expect(result.otherMore.toArray()).toEqual(['other', 'last']);
    expect(raw(result.list)).toBe(raw(result.more));
    expect(raw(result.other)).toBe(raw(result.otherMore));
    expect(raw(result.list)).not.toBe(raw(result.other));
    const sameSession = S.compactMany({ list: first.list, object: first.object, other: first.other, more: first.more, otherMore: first.otherMore });
    expect(arenaOf(result.list).used).toBe(arenaOf(sameSession.list).used);
  });

  test('identical numeric pointers in distinct arenas remain distinct', () => {
    const first = new S.SharedList('string', 0, 0, 0, new Arena()).push('first');
    const second = new S.SharedList('string', 0, 0, 0, new Arena()).push('other');
    expect(raw(first)).toBe(raw(second));
    const result = S.compactMany({ first, second });
    expect(result.first.toArray()).toEqual(['first']);
    expect(result.second.toArray()).toEqual(['other']);
    expect(raw(result.first)).not.toBe(raw(result.second));
  });

  test('raw value types do not coalesce a valid shared byte representation', () => {
    const a = new Arena(), text = new S.SharedList('string', 0, 0, 0, a).push('null');
    const object = S.SharedList.fromWorkerData({ ...text.toWorkerData(), type: 'object' }, a);
    const result = S.compactMany({ text, object });
    expect(result.text.toArray()).toEqual(['null']);
    expect(result.object.toArray()).toEqual([null]);
    expect(raw(result.text)).not.toBe(raw(result.object));
  });

  test('raw blobs, stack nodes and heap nodes keep separate cache namespaces', () => {
    const a = new Arena(), value = a.encode('string', 'value'), node = a.alloc(32);
    // Zero priority also provides a null stack link and a zero-length raw blob.
    a.dv.setFloat64(node, 0, true); a.dv.setFloat64(node + 8, value, true);
    const tail = a.alloc(8); a.dv.setFloat64(tail, node, true);
    const blob = new S.SharedList('string', 0, 0, 1, a, tail);
    const stack = S.SharedStack.fromWorkerData({ head: node, size: 1, type: 'string' }, a);
    const heap = S.SharedPriorityQueue.fromWorkerData({ root: node, size: 1, type: 'string', isMaxHeap: false }, a);
    const result = S.compactMany({ blob, stack, heap });
    expect(result.blob.get(0)).toBe(''); expect(result.stack.peek()).toBe('value'); expect(result.heap.peek()).toBe('value');
    expect(new Set([raw(result.blob), result.stack.head, result.heap.root]).size).toBe(3);
  });

  test('ordinary and ordered leaves preserve their separate value prefixes', () => {
    const a = new Arena(), ordered = new S.SharedOrderedMap('string', 0, 0, 0, 0, a).set('x', 'text');
    // Both descriptors validly view this leaf. The ordinary string includes the
    // ordered leaf's four-byte ordinal prefix; compaction must not share outputs.
    const plain = new S.SharedMap('string', ordered.root, ordered.size, a);
    const result = S.compactMany({ ordered, plain });
    expect(result.ordered.get('x')).toBe('text');
    expect(result.plain.get('x')).toBe(plain.get('x'));
    expect(leaf(result.ordered, 'x')).not.toBe(leaf(result.plain, 'x'));
  });

  test('retained ordered leaves can be rewritten to different live ordinals', () => {
    const a = new Arena();
    const first = new S.SharedOrderedMap('string', 0, 0, 0, 0, a).set('a', 'A').set('b', 'B').set('c', 'C');
    const second = first.delete('a'), third = second.set('a', 'new');
    const result = S.compactMany({ first, second, third, again: first });
    expect(result.again).toBe(result.first);
    for (const key of ['first', 'second', 'third'] as const) expect([...result[key].entries()]).toEqual([...({ first, second, third })[key].entries()]);
    const b1 = leaf(result.first, 'b'), b2 = leaf(result.second, 'b');
    expect(b1).not.toBe(b2); expect(b2).toBe(leaf(result.third, 'b'));
    expect([...result.second.set('d', 'D').keys()]).toEqual(['b', 'c', 'd']);
  });

  test('nested snapshots reuse caches after recursive compaction and target growth', () => {
    const child = new S.SharedList('string', 0, 0, 0, new Arena()).pushMany(['🙂'.repeat(40000), 'tail']);
    const a = new Arena(), list = new S.SharedList('SharedList<string>', 0, 0, 0, a).pushMany([child, child]);
    const map = new S.SharedMap('SharedList<string>', 0, 0, a).set('child', child);
    const stack = new S.SharedStack('SharedList<string>', 0, 0, undefined, a).push(child).push(child);
    const result = S.compactMany({ list, map, stack, child });
    for (const nested of [result.list.get(0)!, result.list.get(1)!, result.map.get('child')!, result.stack.peek()!]) {
      expect(nested.toWorkerData()).toEqual(result.child.toWorkerData());
      assert.strictEqual(arenaOf(nested), arenaOf(result.child));
      expect(nested.toArray()).toEqual(child.toArray());
    }
    expect(S.getWorkerData(result).arenas).toHaveLength(1);
  });

  test('shared stack and heap subtrees retain values and published source bytes', () => {
    const a = new Arena();
    let stack = new S.SharedStack('object', 0, 0, undefined, a), heap = new S.SharedPriorityQueue('object', undefined, a);
    for (let i = 0; i < 65; i++) { stack = stack.push({ i }); heap = heap.enqueue({ i }, i % 11); }
    const pushed = stack.push({ i: 99 }), enqueued = heap.enqueue({ i: 99 }, -1);
    const bytes = a.buf.slice(HEAP_START, a.used), used = a.used;
    const result = S.compactMany({ stack, pushed, heap, enqueued });
    expect(result.pushed.pop().head).toBe(result.stack.head);
    expect(stackValues(result.stack)).toEqual(stackValues(stack));
    expect([...result.heap.entries()]).toEqual([...heap.entries()]);
    expect([...result.enqueued.entries()]).toEqual([...enqueued.entries()]);
    expect(a.used).toBe(used); assert.equal(Buffer.compare(a.buf.subarray(HEAP_START, used), bytes), 0);
    expect(Object.isFrozen(result.stack.peek())).toBe(true);
  });
});
