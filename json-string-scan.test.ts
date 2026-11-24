import { describe, expect, test } from 'vitest';
import { Buffer } from 'node:buffer';
import { Arena, arenaOf } from './arena';
import { JsonView } from './json-view';
import { SharedList, SharedMap, getWorkerData, initWorker } from './shared';

const encoder = new TextEncoder();

function record(arena: Arena, text: string, offset = 0) {
  const bytes = encoder.encode(text), allocation = arena.alloc(bytes.length + offset);
  const pointer = allocation + offset;
  arena.buf.set(bytes, pointer);
  return { pointer, end: pointer + bytes.length, view: new JsonView(arena, pointer, bytes.length) };
}

describe('bounded JSON string scanning', () => {
  test('finds quotes and escapes at every word offset without changing decoded values', () => {
    const arena = new Arena();
    const suffixes = ['', '#', '\\', '\\]', '"#', '\n\t\r\b\f\0', 'é道路🙂', '\ud800', '\udfff'];
    for (let alignment = 0; alignment < 8; alignment++) {
      for (let prefix = 0; prefix <= 24; prefix++) {
        for (const suffix of suffixes) {
          const value = 'a'.repeat(prefix) + suffix, text = JSON.stringify(value);
          const { pointer, end, view } = record(arena, text, alignment);
          const expectedEnd = text.includes('\\') ? -end : end;
          expect(arena.wasm.jsonStringEnd(pointer, end)).toBe(expectedEnd);
          expect(arena.wasm.jsonValueEnd(pointer, end)).toBe(end);
          expect(view.value()).toBe(value);
        }
      }
    }
  });

  test('reads exact tails at the physical end of memory without overreading', () => {
    const arena = new Arena({ memory: new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true }) });
    const end = arena.memory.buffer.byteLength;
    for (let length = 0; length <= 40; length++) {
      for (const suffix of ['', '"', '\\', '\n', '道路🙂']) {
        const value = 'x'.repeat(length) + suffix, text = JSON.stringify(value), bytes = encoder.encode(text);
        const pointer = end - bytes.length;
        arena.buf.set(bytes, pointer);
        const before = arena.buf.slice(pointer);
        expect(arena.wasm.jsonStringEnd(pointer, end)).toBe(text.includes('\\') ? -end : end);
        expect(arena.wasm.jsonValueEnd(pointer, end)).toBe(end);
        expect(new JsonView(arena, pointer, bytes.length).value()).toBe(value);
        expect(arena.buf.subarray(pointer)).toEqual(before);
      }
    }
    for (let length = 0; length <= 40; length++) {
      for (const suffix of ['', '\\', '\\"']) {
        const bytes = encoder.encode('"' + 'x'.repeat(length) + suffix), pointer = end - bytes.length;
        arena.buf.set(bytes, pointer);
        expect(arena.wasm.jsonStringEnd(pointer, end)).toBe(0);
        expect(arena.wasm.jsonValueEnd(pointer, end)).toBe(0);
      }
    }
  });

  test('does not use a quote outside the enclosing record bound', () => {
    const arena = new Arena();
    for (let length = 0; length <= 40; length++) {
      for (const suffix of ['', '\\', '\\"']) {
        const text = '"' + 'x'.repeat(length) + suffix;
        const bytes = encoder.encode(text + '"#\\]"'), pointer = arena.alloc(bytes.length);
        arena.buf.set(bytes, pointer);
        const end = pointer + encoder.encode(text).length;
        expect(arena.wasm.jsonStringEnd(pointer, end)).toBe(0);
        expect(arena.wasm.jsonValueEnd(pointer, end)).toBe(0);
      }
    }
  });

  test('skips long quoted decoys and preserves nested boundaries', () => {
    const arena = new Arena();
    const text = 'prefix '.repeat(10000) + '"target":999,]}\\]#道路🙂\ud800';
    const expected = { before: text, nested: [{ before: text, target: 17 }], target: 42, after: true };
    const { view } = record(arena, JSON.stringify(expected));
    const before = arena.buf.slice(), used = arena.used;
    expect(view.get('target')).toBe(42);
    expect(view.get('before')).toBe(text);
    expect(view.get('after')).toBe(true);
    expect(view.has('missing')).toBe(false);
    const nested = (view.get('nested') as JsonView).at(0) as JsonView;
    expect(nested.get('target')).toBe(17);
    expect(nested.get('after')).toBeUndefined();
    expect(nested.toObject()).toEqual(expected.nested[0]);
    expect(arena.used).toBe(used);
    expect(Buffer.from(arena.buf).equals(before)).toBe(true);
  });

  test('skips mixed containers at every word alignment and respects the closing bound', () => {
    const arena = new Arena();
    const coordinates = Array.from({ length: 40 }, (_, i) => [103.854219 + i / 1234, -1.29136 - i / 456]);
    const payload = [{ text: '道路🙂 [{ "a": 99 }] \\ \n'.repeat(25), coordinates }, [null, true, false]];
    const expected = { payload, ok: true, trailingField: 42 };
    for (let alignment = 0; alignment < 8; alignment++) {
      const { pointer, end, view } = record(arena, JSON.stringify(expected), alignment);
      expect(arena.wasm.jsonValueEnd(pointer, end)).toBe(end);
      expect(arena.wasm.jsonValueEnd(pointer, end - 1)).toBe(0);
      expect(view.get('ok')).toBe(true);
      expect(view.get('trailingField')).toBe(42);
      const nested = view.get('payload') as JsonView;
      expect((nested.at(1) as JsonView).toObject()).toEqual(payload[1]);
      expect(nested.at(2)).toBeUndefined();
      expect(nested.toObject()).toEqual(payload);
    }
  });

  test.each([false, true])('retained map/list views remain read-only after owner growth (copy=%s)', async copy => {
    const arena = new Arena(), text = 'ordinary text 道路🙂 '.repeat(4096), escaped = text + '"\\\n';
    const source = new SharedMap('object', 0, 0, arena).set('record', { text, escaped, target: 37 });
    const list = new SharedList('object', 0, 0, 0, arena).push({ text: escaped, target: 41 });
    const { source: reader, list: listReader } = await initWorker(getWorkerData({ source, list }, { copy }));
    const mapView = reader.getView('record')!, listView = listReader.getView(0)!;
    const capacity = arena.memory.buffer.byteLength;
    const changed = source.set('padding', { text: 'x'.repeat(capacity + 65536) })
      .set('record', { text: 'new', escaped: 'new', target: -1 });
    expect(arena.memory.buffer.byteLength).toBeGreaterThan(capacity);
    const writerBefore = arena.buf.slice(), readArena = arenaOf(reader), readerBefore = readArena.buf.slice();
    const used = readArena.used;
    expect(mapView.get('target')).toBe(37);
    expect(mapView.get('text')).toBe(text);
    expect(mapView.get('escaped')).toBe(escaped);
    expect(listView.get('target')).toBe(41);
    expect(listView.get('text')).toBe(escaped);
    expect(changed.getView('record')!.get('target')).toBe(-1);
    expect(readArena.used).toBe(used);
    expect(Buffer.from(readArena.buf).equals(readerBefore)).toBe(true);
    expect(Buffer.from(arena.buf).equals(writerBefore)).toBe(true);
    expect(Object.isFrozen(reader.get('record'))).toBe(true);
  });
});
