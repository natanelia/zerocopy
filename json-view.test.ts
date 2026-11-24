import { describe, expect, test, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { Arena, arenaOf } from './arena';
import { JsonView } from './json-view';
import { SharedMap } from './shared-map';
import { SharedList } from './shared-list';
import { getWorkerData, initWorker } from './shared';

const encoder = new TextEncoder();
function fromText(text: string): { arena: Arena; view: JsonView } {
  const arena = new Arena(), bytes = encoder.encode(text), ptr = arena.alloc(bytes.length);
  arena.buf.set(bytes, ptr);
  return { arena, view: new JsonView(arena, ptr, bytes.length) };
}
function fromValue(value: unknown) { return fromText(JSON.stringify(value)); }

describe('JSON shared-byte views', () => {
  test('returns scalars and nested views, preserving missing versus null', () => {
    const { view } = fromValue({ n: 17, flag: false, nil: null, text: 'hello', nest: { a: 2 }, arr: [1, null, { deep: true }] });
    expect(view.type).toBe('object');
    expect(view.value()).toBe(view);
    expect(view.get('n')).toBe(17);
    expect(view.get('flag')).toBe(false);
    expect(view.get('nil')).toBeNull();
    expect(view.get('text')).toBe('hello');
    expect(view.get('missing')).toBeUndefined();
    expect(view.has('nil')).toBe(true);
    expect(view.has('missing')).toBe(false);
    expect(view.has('toString')).toBe(false);
    expect(view.at(0)).toBeUndefined();
    const nest = view.get('nest') as JsonView, arr = view.get('arr') as JsonView;
    expect(nest).toBeInstanceOf(JsonView);
    expect(nest.get('a')).toBe(2);
    expect(arr.type).toBe('array');
    expect(arr.at(0)).toBe(1);
    expect(arr.at(1)).toBeNull();
    expect((arr.at(2) as JsonView).get('deep')).toBe(true);
    for (const index of [-1, 1.5, 3, NaN, Infinity, 0x100000000]) expect(arr.at(index)).toBeUndefined();
    expect(arr.get('0')).toBeUndefined();
    expect(Object.keys(view)).toEqual([]);
    expect(Object.isFrozen(view)).toBe(false);
  });

  test('ordinary strings, field predicates and safe integers need no JSON.parse or Object.freeze and never write shared bytes', () => {
    const { arena, view } = fromValue({ category: 'books', revision: 42, flag: true, nil: null, text: '道路🙂\uD800\n', nest: [1, 2] });
    const before = arena.buf.slice(0, arena.used);
    const parse = vi.spyOn(JSON, 'parse'), freeze = vi.spyOn(Object, 'freeze');
    let values: unknown[], parses: number, freezes: number;
    try {
      values = [view.get('revision'), view.has('text'), view.equals('category', 'books'), view.equals('text', '道路🙂\uD800\n'),
        view.equals('flag', true), view.equals('nil', null), view.equals('revision', 42), view.equals('revision', '42'),
        (view.get('nest') as JsonView).at(1), view.get('category')];
      parses = parse.mock.calls.length; freezes = freeze.mock.calls.length;
    } finally { parse.mockRestore(); freeze.mockRestore(); }
    expect(values!).toEqual([42, true, true, true, true, true, true, false, 2, 'books']);
    expect(parses!).toBe(0); expect(freezes!).toBe(0);
    expect(Buffer.from(arena.buf.buffer, 0, arena.used).equals(Buffer.from(before.buffer))).toBe(true);
  });

  test('matches semantic field names and strings without conflating UTF-8 and UTF-16', () => {
    const object = JSON.parse('{"__proto__":{"n":1},"constructor":2,"toString":3}');
    const names = ['', 'a', '12345678', '123456789', 'quote"', 'slash\\', '\n', '\u0000', 'é', '道路', '🙂', '\uD800', '\uDFFF', '\uFEFF', '\u{10FFFF}', 'a🙂é\\\n'];
    for (const [index, key] of names.entries()) Object.defineProperty(object, key, { value: `v${index} ${key}`, enumerable: true });
    const { view } = fromValue(object);
    for (const key of names) {
      expect(view.has(key)).toBe(true);
      expect(view.get(key)).toBe(object[key]);
      expect(view.equals(key, object[key])).toBe(true);
      expect(view.equals(key, object[key] + 'x')).toBe(false);
    }
    expect((view.get('__proto__') as JsonView).get('n')).toBe(1);
    expect(view.get('constructor')).toBe(2);
    expect(view.get('toString')).toBe(3);
    expect(view.get('不存在')).toBeUndefined();
    expect(view.get('\uD800x')).toBeUndefined();
  });

  test('a matching key hash is not accepted as equality', () => {
    // Distinct long keys have the same UTF-16 FNV-1a hash (3178506677).
    const first = 'collision-field/prb', second = 'collision-field/5cb0';
    const { view } = fromValue({ [first]: { decoy: [1, 2, 3] }, [second]: 'correct' });
    expect(view.get(second)).toBe('correct');
    expect((view.get(first) as JsonView).get('decoy')).toBeInstanceOf(JsonView);
    const absent = fromValue({ [first]: [9, { nested: second }] }).view;
    expect(absent.get(second)).toBeUndefined();
    expect(absent.has(second)).toBe(false);
  });

  test('handles escaped keys, nested decoys, whitespace and selected string escapes', () => {
    const text = ' { "decoy" : { "field": 9 }, "array": [ "}\\\"", { "field": 8 } ], "fi\\u0065ld" : -0, "\\u00e9": "\\uD800\\n🙂" } ';
    const { view } = fromText(text);
    expect(Object.is(view.get('field'), -0)).toBe(true);
    expect(view.get('é')).toBe('\uD800\n🙂');
    expect(view.equals('é', '\uD800\n🙂')).toBe(true);
    expect(view.toJSON()).toEqual(JSON.parse(text));
    expect(view.byteLength).toBe(encoder.encode(text.trim()).length);
  });

  test('preserves exact JS number rounding and negative zero', () => {
    const tokens = ['0', '-0', '9007199254740991', '-9007199254740991', '9007199254740992', '9007199254740993',
      '18446744073709551615', '1.234567890123456789', '-0.0', '1e+308', '1e309', '-1e309', '5e-324', '1e-400', '-1e-400'];
    for (const token of tokens) {
      const reference = JSON.parse(token);
      const view = fromText(`{"number":${token},"after":true}`).view;
      expect(Object.is(view.get('number'), reference)).toBe(true);
      expect(view.equals('number', reference)).toBe(true);
      expect(view.get('after')).toBe(true);
      expect(Object.is(fromText(token).view.value(), reference)).toBe(true);
    }
  });

  test('supports scalar root values without freezing or losing null', () => {
    for (const value of [null, true, false, '', '\uFEFFtext', 'é🙂\uD800', 123, -1.25]) {
      const view = fromValue(value).view;
      expect(view.value()).toEqual(value);
      expect(view.get('anything')).toBeUndefined();
      expect(view.has('anything')).toBe(false);
      expect(view.at(0)).toBeUndefined();
      expect(view.toJSON()).toEqual(value);
    }
  });

  test('materializes only explicitly, returning fresh mutable values independent of the record', () => {
    const { view } = fromValue({ nest: { n: 1 }, list: [1, 2] });
    const first = view.toObject(), second = view.toJSON();
    expect(first).not.toBe(second);
    expect(first.nest).not.toBe(second.nest);
    expect(Object.isFrozen(first)).toBe(false);
    first.nest.n = 9; first.list.push(3);
    expect((view.get('nest') as JsonView).get('n')).toBe(1);
    expect(second).toEqual({ nest: { n: 1 }, list: [1, 2] });
    expect(JSON.stringify(view)).toBe('{"nest":{"n":1},"list":[1,2]}');
    const frozen = view.toObject({ freeze: true });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.nest)).toBe(true);
    expect(Object.isFrozen(frozen.list)).toBe(true);
  });

  test('keeps nested view bounds and selected materialization inside that value', () => {
    const { view } = fromValue({ first: { only: 1 }, second: { other: 2 }, array: [[3], 4] });
    const first = view.get('first') as JsonView;
    expect(first.get('other')).toBeUndefined();
    expect(first.get('second')).toBeUndefined();
    expect(first.toJSON()).toEqual({ only: 1 });
    const array = (view.get('array') as JsonView).at(0) as JsonView;
    expect(array.at(1)).toBeUndefined();
    expect(array.toJSON()).toEqual([3]);
  });

  test('reads retained shared records after memory growth without changing any shared bytes', () => {
    const writer = new Arena(), raw = writer.encode('object', { category: 'books', nested: { n: 7 }, text: '保持🙂' });
    const length = writer.dv.getUint32(raw, true), used = writer.used;
    const reader = new Arena({ memory: writer.memory, used, readOnly: true });
    const view = new JsonView(reader, raw + 4, length), nested = view.get('nested') as JsonView;
    const oldBuffer = reader.buf;
    writer.alloc(writer.memory.buffer.byteLength + 65536);
    expect(reader.buf).not.toBe(oldBuffer);
    const before = new Uint8Array(writer.memory.buffer).slice();
    expect(view.equals('category', 'books')).toBe(true);
    expect(view.get('text')).toBe('保持🙂');
    expect(nested.get('n')).toBe(7);
    expect(view.toJSON()).toEqual({ category: 'books', nested: { n: 7 }, text: '保持🙂' });
    expect(Buffer.from(writer.memory.buffer).equals(Buffer.from(before.buffer))).toBe(true);
  });

  test('skips very deep unrelated values without a recursive parser or linear-memory stack', () => {
    const deep = '['.repeat(20000) + '0' + ']'.repeat(20000);
    const { view } = fromText(`{"deep":${deep},"target":7}`);
    expect(view.get('target')).toBe(7);
    const array = view.get('deep') as JsonView;
    expect(array.type).toBe('array');
    expect(array.byteLength).toBe(40001);
  });

  test('rejects invalid bounds and field argument types', () => {
    const { arena, view } = fromValue({ ok: true });
    for (const [pointer, length] of [[0, 1], [65536, 0], [65536, -1], [65536, Infinity], [65536.5, 1], [arena.buf.length, 1]]) {
      expect(() => new JsonView(arena, pointer, length)).toThrow(RangeError);
    }
    expect(() => view.get(1 as any)).toThrow(TypeError);
    expect(() => view.has(null as any)).toThrow(TypeError);
  });

  test('integrates with map/list records and preserves retained snapshots', () => {
    const before = new SharedMap('object').set('p', { price: 10, nested: [1] });
    const view = before.getView('p')!;
    const after = before.set('p', { price: 20, nested: [2] });
    expect(view.get('price')).toBe(10);
    expect(after.getView('p')!.get('price')).toBe(20);
    expect(before.getView('missing')).toBeUndefined();
    expect(Object.isFrozen(before.get('p'))).toBe(true);
    const list = new SharedList('object').pushMany([{ name: 'one' }, [2, 3]]);
    expect(list.getView(0)!.get('name')).toBe('one');
    expect(list.getView(1)!.at(1)).toBe(3);
    expect(list.getView(2)).toBeUndefined();
  });

  test('reads list views across leaf/tree boundaries and retains them through writer growth', async () => {
    const records = Array.from({ length: 1100 }, (_, index) => ({ index, text: `record ${index}`, nested: [index] }));
    const list = new SharedList('object').pushMany(records);
    const { list: reader } = await initWorker(getWorkerData({ list }, { copy: false }));
    const indices = [0, 31, 32, 63, 64, 1023, 1024, 1099];
    const retained = indices.map(index => reader.getView(index)!);
    for (const index of indices) {
      expect(reader.get(index)).toEqual(records[index]);
      expect(reader.getView(index)!.get('index')).toBe(index);
    }
    const arena = arenaOf(list), oldBuffer = arena.buf;
    const grown = list.push({ index: 1100, text: 'x'.repeat(oldBuffer.length), nested: [1100] });
    expect(arena.buf).not.toBe(oldBuffer);
    expect(grown.getView(1100)!.get('index')).toBe(1100);
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i];
      expect(retained[i].get('index')).toBe(index);
      expect((reader.getView(index)!.get('nested') as JsonView).at(0)).toBe(index);
    }
    const changed = grown.set(1024, { index: -1, text: 'changed', nested: [] });
    expect(changed.getView(1024)!.get('index')).toBe(-1);
    expect(list.getView(1024)!.get('index')).toBe(1024);
    expect(reader.getView(1100)).toBeUndefined();
  });
});

test('field offsets distinguish ranges, arenas, and long or missing keys', () => {
  const padding = 'x'.repeat(40);
  const { arena, view } = fromText(`{"first":"${padding}","later":2}`);
  const text = `{"first":"${padding}","later":4}`;
  const data = encoder.encode(text);
  const raw = arena.alloc(data.length);
  arena.buf.set(data, raw);
  const complete = new JsonView(arena, raw, data.length);
  const short = new JsonView(arena, raw, text.indexOf(','));
  for (let i = 0; i < 3; i++) {
    expect(complete.get('later')).toBe(4);
    expect(short.has('later')).toBe(false);
    expect(view.get('later')).toBe(2);
  }

  const names = ['x', 'long field name', '名', '__proto__', 'a'.repeat(65)];
  const entries = Array.from({ length: 2500 }, (_, i) => [String(i), {
    [names[i % names.length]!]: i, ['field' + i % 80]: i,
  }] as const);
  const map = new SharedMap('object', 0, 0, new Arena()).setMany(entries);
  for (let pass = 0; pass < 2; pass++) {
    for (let n = 0; n < entries.length; n++) {
      const i = pass === 0 ? n : entries.length - 1 - n;
      const row = map.getView(String(i))!;
      const name = names[i % names.length]!;
      expect(row.get(name)).toBe(i);
      expect(row.has(names[(i + 1) % names.length]!)).toBe(false);
      expect(row.get('field' + i % 80)).toBe(i);
    }
  }
  const other = fromText('{"later":99,"first":0}').view;
  expect(other.get('later')).toBe(99);
  expect(view.get('later')).toBe(2);
});

test('preserves offsets across the signed and unsigned 16-bit boundaries', () => {
  const prefix = '{"pad":"', suffix = '","tail":17}';
  for (const length of [32767, 32768, 65535, 65536]) {
    const { view } = fromText(prefix + 'x'.repeat(length - prefix.length - suffix.length) + suffix);
    for (let pass = 0; pass < 2; pass++) {
      expect(view.byteLength).toBe(length);
      expect(view.get('tail')).toBe(17);
      expect(view.has('missing')).toBe(false);
    }
  }
});

test('preserves reads beyond the per-field and total offset budgets', () => {
  const rows = Array.from({ length: 2052 }, (_, id) => ({ id, a: id, b: id, c: id, d: id }));
  const list = new SharedList('object', 0, 0, 0, new Arena()).pushMany(rows);
  for (let i = 0; i < rows.length; i++) {
    const row = list.getView(i)!;
    for (const key of ['id', 'a', 'b', 'c', 'd']) {
      if (row.get(key) !== i) throw new Error('Wrong field ' + key + ' at row ' + i);
    }
  }
  for (const i of [0, 1638, 2047, 2048, 2051]) expect(list.getView(i)!.get('d')).toBe(i);
});
