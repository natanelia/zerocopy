import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Arena, HEAP_START } from './arena';
import { SharedList, getWorkerData, initWorker } from './shared';
import { compileStringSearch } from './text-search';

const terms = [
  'request-processing-completed-okay',
  'Ab'.repeat(32) + 'AC',
  'a'.repeat(64) + 'b',
  'a'.repeat(32) + 'b' + 'a'.repeat(32),
  'K'.repeat(33),
  '🙂'.repeat(9),
  'İ'.repeat(17),
  'a'.repeat(32) + '\ud83d',
  '\udc00' + 'x'.repeat(32),
];

function expected(value: string, term: string, sensitive: boolean): boolean {
  return sensitive ? value.includes(term) : value.toLowerCase().includes(term.toLowerCase());
}

describe('long searches compiled for each case mode', () => {
  it('keeps mixed compiled modes exact at every start and tail alignment', () => {
    const a = new Arena();
    const values = ['', 'short', 'K'.repeat(40), 'a'.repeat(32) + '😀', '𐀀' + 'x'.repeat(32)];
    for (const term of terms) for (let offset = 0; offset < 16; offset++) {
      values.push('!'.repeat(offset) + term, '!'.repeat(offset) + term + '?', term.toUpperCase(),
        term.slice(0, -1), ('a'.repeat(40) + 'b').repeat(8) + term, 'a'.repeat(300) + 'c');
    }
    const list = new SharedList('string', 0, 0, 0, a).pushMany(values), stored = list.toArray();
    const used = a.used, before = a.buf.slice(HEAP_START, used);
    const compiled = terms.flatMap(term => [true, false].map(sensitive => ({
      term, sensitive, match: list.compileTextSearch(term, { caseSensitive: sensitive }),
    })));
    for (let i = 0; i < stored.length; i++) for (const { term, sensitive, match } of compiled) {
      assert.equal(match(i), expected(stored[i], term, sensitive), JSON.stringify({ i, term, sensitive }));
    }
    assert.equal(a.used, used);
    assert.equal(Buffer.compare(a.buf.subarray(HEAP_START, used), before), 0);
  });

  it('ignores poisoned neighboring bytes in both long-search modes', () => {
    const memory = new SharedArrayBuffer(65536), bytes = new Uint8Array(memory), view = new DataView(memory);
    const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    let decoded = 0;
    const a = {
      buf: bytes, dv: view,
      decode: (_type: string, raw: number) => {
        decoded++;
        return decoder.decode(bytes.subarray(raw + 4, raw + 4 + view.getUint32(raw, true)));
      },
    } as unknown as Arena;
    for (const term of ['a'.repeat(64) + 'b', 'Ab'.repeat(17), 'k'.repeat(33), '🙂'.repeat(9)]) {
      for (const sensitive of [true, false]) for (const gap of [0, 128]) for (let offset = 0; offset < 8; offset++) {
        for (const value of ['x'.repeat(offset + 80), 'x'.repeat(offset) + term, 'a'.repeat(128) + 'c']) {
          const encoded = encoder.encode(value), raw = bytes.length - encoded.length - 4 - gap;
          bytes.fill(0xa5); view.setUint32(raw, encoded.length, true); bytes.set(encoded, raw + 4);
          if (gap) bytes.set(encoder.encode('K' + term), raw + 4 + encoded.length);
          const before = bytes.slice(), match = compileStringSearch(a, term, { caseSensitive: sensitive });
          decoded = 0;
          assert.equal(match(raw), expected(value, term, sensitive), JSON.stringify({ term, sensitive, gap, offset, value }));
          if (/^[\x00-\x7f]*$/.test(term)) assert.equal(decoded, 0, 'ASCII rows never inspect or decode a Unicode neighbor');
          assert.equal(Buffer.compare(bytes, before), 0);
        }
      }
    }
  });

  it('retains old results on writer and copied/shared readers after growth and forks', async () => {
    const a = new Arena(), term = 'K'.repeat(33);
    const values = Array.from({ length: 257 }, (_, i) => i % 4 === 0 ? term : i % 4 === 1
      ? 'K'.repeat(33) : i % 4 === 2 ? 'k'.repeat(33) : 'unchanged');
    const list = new SharedList('string', 0, 0, 0, a).pushMany(values);
    const readers = await Promise.all([false, true].map(copy => initWorker(getWorkerData({ list }, { copy }))));
    const compiled = [list, ...readers.map(reader => reader.list)].flatMap(snapshot => [true, false].map(sensitive => ({
      sensitive, match: snapshot.compileTextSearch(term, { caseSensitive: sensitive }),
    })));
    const oldBuffer = a.memory.buffer, oldEnd = a.used, before = a.buf.slice(HEAP_START, oldEnd);
    const fork = list.set(0, 'gone');
    list.push('growth'.repeat(oldBuffer.byteLength));
    assert.notEqual(a.memory.buffer, oldBuffer);
    assert.equal(fork.get(0), 'gone'); assert.equal(list.get(0), term);
    const used = a.used;
    for (const { sensitive, match } of compiled) {
      for (let i = 0; i < values.length; i++) assert.equal(match(i), expected(values[i], term, sensitive));
      for (const index of [-1, 0.5, values.length, NaN, Infinity, 2 ** 32]) assert.equal(match(index), false);
    }
    assert.equal(a.used, used);
    assert.equal(Buffer.compare(a.buf.subarray(HEAP_START, oldEnd), before), 0);
    for (const reader of readers) assert.throws(() => reader.list.push('forbidden'), /read-only/);
  });
});
