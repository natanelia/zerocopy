import { describe, expect, test } from 'vitest';
import { Arena, arenaOf } from './arena';
import { JsonView } from './json-view';
import { SharedMap, getWorkerData, initWorker } from './shared';

function fromText(text: string) {
  const arena = new Arena(), bytes = new TextEncoder().encode(text), pointer = arena.alloc(bytes.length);
  arena.buf.set(bytes, pointer);
  return { arena, view: new JsonView(arena, pointer, bytes.length) };
}
const materialize = (value: unknown) => value instanceof JsonView ? value.toObject() : value;

describe('JSON array cursor correctness', () => {
  test('interleaves forward, backward, repeated, missing and invalid indexes', () => {
    const values = [0, null, false, 'quote"\\\n道路🙂', [4, { nested: true }], { index: 5 }, 1.25, true];
    const { view, arena } = fromText(JSON.stringify(values));
    const before = arena.buf.slice(), used = arena.used;
    for (const index of [0, 1, 1, 4, 5, 7, 8, 0xffffffff, 6, 2, -1, NaN, Infinity, 2.5, 0, 7, 3]) {
      const expected = Number.isInteger(index) && index >= 0 ? values[index] : undefined;
      expect(materialize(view.at(index))).toEqual(expected);
    }
    expect(arena.used).toBe(used);
    expect(arena.buf).toEqual(before);
    expect(view.toObject()).toEqual(values);
  });

  test('does not continue into siblings after a nested array ends', () => {
    const { view } = fromText(' { "items": [ 0, [1, 2], {"text": "] , [ \\\""} ], "after": [99, 100] } ');
    const items = view.get('items') as JsonView;
    expect(items.at(0)).toBe(0);
    expect(materialize(items.at(1))).toEqual([1, 2]);
    expect(materialize(items.at(2))).toEqual({ text: '] , [ "' });
    for (const index of [3, 4, 100, 0xffffffff]) expect(items.at(index)).toBeUndefined();
    expect(items.at(0)).toBe(0);
    expect(materialize(items.at(2))).toEqual({ text: '] , [ "' });
    expect((view.get('after') as JsonView).at(1)).toBe(100);
    expect(items.byteLength).toBe(new TextEncoder().encode('[ 0, [1, 2], {"text": "] , [ \\\""} ]').length);
  });

  test('keeps independent cursors for separate views and nested arrays', () => {
    const { view } = fromText('[[0,1,2],[3,4,5],[6,7,8]]');
    const first = view.at(0) as JsonView, last = view.at(2) as JsonView;
    expect(first.at(0)).toBe(0);
    expect(last.at(0)).toBe(6);
    expect(first.at(2)).toBe(2);
    expect(last.at(1)).toBe(7);
    const anotherFirst = view.at(0) as JsonView;
    expect(anotherFirst).not.toBe(first);
    expect(anotherFirst.at(1)).toBe(1);
    expect(first.at(1)).toBe(1);
    expect(last.at(2)).toBe(8);
  });

  test('random reads retain exact offsets as a large nested index is thinned', async () => {
    const values = Array.from({ length: 33013 }, (_, i) =>
      i % 19 === 0 ? { text: `道路 "] ${i}`, list: [i] } : i % 7 === 0 ? null : i);
    const original = new SharedMap('object').set('doc', { values, after: ['outside'] });
    for (const copy of [false, true]) {
      const { original: reader } = await initWorker(getWorkerData({ original }, { copy }));
      const array = reader.getView('doc')!.get('values') as JsonView;
      // First rewind builds a short index, then irregular jumps grow it through
      // three stride changes. Out-of-range probes must stop before the sibling.
      const indexes = [129, 64, 31, 32, 33, 8191, 8192, 8193, 16385, 16384, 16383,
        32769, 32768, 32767, 0xffffffff, values.length, values.length - 1];
      for (let i = 0; i < 512; i++) indexes.push(i * 7919 % values.length);
      for (const i of indexes) expect(materialize(array.at(i))).toEqual(values[i]);
      expect(array.toObject()).toEqual(values);
    }
  });

  test('supports empty, scalar and one-element views without inventing elements', () => {
    for (const text of ['[]', ' [ ] ', '{}', 'null', 'true', '1', '"[]"']) {
      const { view } = fromText(text);
      for (const index of [0, 1, 0, 0xffffffff]) expect(view.at(index)).toBeUndefined();
    }
    const { view } = fromText('[ -0 ]');
    expect(Object.is(view.at(0), -0)).toBe(true);
    expect(view.at(1)).toBeUndefined();
    expect(Object.is(view.at(-0), -0)).toBe(true);
  });

  test('retains exact scalar conversion when resuming past escaped strings and containers', () => {
    const text = '["\\uD800\\n🙂", {"nested":["]", {"x": [1, 2]}]}, -0, 1e309, 9007199254740993, 5e-324]';
    const expected = JSON.parse(text), { view } = fromText(text);
    for (let index = 0; index < expected.length; index++) expect(materialize(view.at(index))).toEqual(expected[index]);
    expect(Object.is(view.at(2), -0)).toBe(true);
    expect(view.at(3)).toBe(Infinity);
    expect(view.at(6)).toBeUndefined();
    expect(view.toObject()).toEqual(expected);
  });

  test('skips a deep preceding element without recursion or an array-end pre-scan', () => {
    const nested = '['.repeat(20000) + '0' + ']'.repeat(20000);
    const { view } = fromText(`[${nested},17,18]`);
    expect(view.at(0)).toBeInstanceOf(JsonView);
    expect(view.at(1)).toBe(17);
    expect(view.at(2)).toBe(18);
    expect(view.at(3)).toBeUndefined();
  });

  test('allows a decoder to reenter the same view and grow memory during a selected read', () => {
    const { view, arena } = fromText('[0,"selected 道路","after",3]');
    expect(view.at(0)).toBe(0);
    const decode = TextDecoder.prototype.decode;
    let reentered = false;
    TextDecoder.prototype.decode = function (input, options) {
      if (!reentered) {
        reentered = true;
        arena.alloc(arena.memory.buffer.byteLength + 65536);
        expect(view.at(3)).toBe(3);
      }
      return decode.call(this, input, options);
    };
    try {
      expect(view.at(1)).toBe('selected 道路');
      expect(reentered).toBe(true);
      expect(view.at(2)).toBe('after');
      expect(view.at(3)).toBe(3);
      expect(view.at(4)).toBeUndefined();
      expect(view.at(0)).toBe(0);
    } finally { TextDecoder.prototype.decode = decode; }
  });

  test('retains a read-only cursor after growth, edits and further attachments', async () => {
    const values = Array.from({ length: 1100 }, (_, index) => index);
    const writer = new SharedMap('object').set('record', { items: values, after: [9999] });
    const { writer: reader } = await initWorker(getWorkerData({ writer }, { copy: false }));
    const items = reader.getView('record')!.get('items') as JsonView;
    for (let index = 0; index < 40; index++) expect(items.at(index)).toBe(index);
    const arena = arenaOf(writer), capacity = arena.memory.buffer.byteLength;
    const grown = writer.set('large', { padding: 'x'.repeat(capacity + 65536) });
    const changed = grown.set('record', { items: [-1, -2], after: [-3] });
    expect(arena.memory.buffer.byteLength).toBeGreaterThan(capacity);
    const before = arena.buf.slice();
    const { changed: latest } = await initWorker(getWorkerData({ changed }, { copy: false }));
    for (let index = 40; index < values.length; index++) expect(items.at(index)).toBe(index);
    expect(items.at(values.length)).toBeUndefined();
    expect(items.at(3)).toBe(3);
    expect(items.at(1099)).toBe(1099);
    expect((latest.getView('record')!.get('items') as JsonView).at(1)).toBe(-2);
    expect(items.toObject()).toEqual(values);
    expect(Object.isFrozen(reader.get('record')!.items)).toBe(true);
    expect(arena.buf).toEqual(before);
  });
});
