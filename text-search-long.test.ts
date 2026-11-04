import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { SharedList, getWorkerData, initWorker, resetSharedList } from './shared';
import { compileStringSearch } from './text-search';
import type { Arena } from './arena';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

function verify(list: SharedList<'string'>, terms: readonly string[]): void {
  const values = list.toArray();
  for (const term of terms) for (const caseSensitive of [true, false]) {
    const query = caseSensitive ? term : term.toLowerCase();
    const match = list.compileTextSearch(term, { caseSensitive });
    for (let i = 0; i < values.length; i++) {
      const value = caseSensitive ? values[i] : values[i].toLowerCase();
      expect(match(i), JSON.stringify({ term, caseSensitive, i })).toBe(value.includes(query));
    }
  }
}

describe('long text search candidate skipping', () => {
  it('preserves starts, overlaps, final-byte hits and every byte alignment', () => {
    const terms = [
      'request-processing-completed-for-map-validation',
      'a'.repeat(64) + 'b',
      'ab'.repeat(32) + 'ac',
      '\0' + 'z'.repeat(34),
      '🚦'.repeat(9),
      'K'.repeat(17),
      'k'.repeat(33),
      'İ'.repeat(18),
      '\ud83d' + 'x'.repeat(40),
    ];
    const values = ['', 'short', ...terms];
    for (const term of terms) for (let offset = 0; offset < 17; offset++) {
      values.push('!'.repeat(offset) + term, '!'.repeat(offset) + term + '?', term.slice(0, -1),
        term.repeat(3), term.toUpperCase(), 'a'.repeat(400) + term,
        'ab'.repeat(300) + term, 'a'.repeat(400) + 'c');
    }
    verify(new SharedList('string').pushMany(values), terms);
  });

  it('keeps prefix fallback linear for adversarial repeated prefixes', () => {
    const term = 'a'.repeat(4096) + 'b';
    const values = ['a'.repeat(262144), 'a'.repeat(262144) + 'b', 'a'.repeat(262144) + 'c'];
    verify(new SharedList('string').pushMany(values), [term]);
  });

  it('never searches outside a string ending at the final memory byte', () => {
    const buffer = new SharedArrayBuffer(65536), bytes = new Uint8Array(buffer), view = new DataView(buffer);
    const arena = {
      buf: bytes,
      dv: view,
      decode: (_type: string, raw: number) => decoder.decode(bytes.subarray(raw + 4, raw + 4 + view.getUint32(raw, true))),
    } as unknown as Arena;
    const terms = ['a'.repeat(32) + 'b', '\0' + 'z'.repeat(34), '🚦'.repeat(9)];
    for (const term of terms) for (let offset = 0; offset < 17; offset++) for (const gap of [0, 64]) {
      for (const value of ['', 'short', '!'.repeat(offset), '!'.repeat(offset) + term, 'a'.repeat(offset + 80) + 'c']) {
        const encoded = encoder.encode(value), raw = bytes.length - encoded.length - 4 - gap;
        bytes.fill(0xa5);
        view.setUint32(raw, encoded.length, true); bytes.set(encoded, raw + 4);
        if (gap) bytes.set(encoder.encode(term), raw + 4 + encoded.length);
        const before = bytes.slice();
        const match = compileStringSearch(arena, term);
        const indexOf = Uint8Array.prototype.indexOf;
        Uint8Array.prototype.indexOf = function (search, from) {
          expect(this.buffer).toBe(buffer);
          expect(this.byteOffset).toBeGreaterThanOrEqual(raw + 4);
          expect(this.byteOffset + this.byteLength).toBeLessThanOrEqual(raw + 4 + encoded.length);
          return indexOf.call(this, search, from);
        };
        try { expect(match(raw)).toBe(value.includes(term)); }
        finally { Uint8Array.prototype.indexOf = indexOf; }
        expect(Buffer.compare(Buffer.from(bytes), Buffer.from(before))).toBe(0);
      }
    }
  });

  it('does not decode ASCII misses or retain answers from another snapshot', async () => {
    resetSharedList();
    const term = 'request-processing-completed-for-map-validation';
    const values = Array.from({ length: 1057 }, (_, i) => `${i} ` + 'log payload '.repeat(20) + (i % 3 ? 'done' : term));
    const before = new SharedList('string').pushMany(values);
    const ownedMatch = before.compileTextSearch(term);
    const changed = before.set(0, 'gone').set(1, term);
    const readers = await Promise.all([false, true].map(copy => initWorker(getWorkerData({ before, changed }, { copy }))));
    const matches = readers.map(reader => [reader.before.compileTextSearch(term), reader.changed.compileTextSearch(term)]);
    const source = getWorkerData({ before }, { copy: false }).arenas[0], memory = source.memory!;
    const oldBuffer = memory.buffer;
    const snapshotBytes = new Uint8Array(oldBuffer, 0, source.used).slice();
    before.pushMany(Array.from({ length: 60000 }, (_, i) => `other ${i} `.repeat(8)));
    expect(memory.buffer.byteLength).toBeGreaterThan(oldBuffer.byteLength);
    resetSharedList();
    new SharedList('string').push('replacement arena');
    const decode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = () => { throw new Error('ASCII search must not decode rows'); };
    try {
      for (let i = 0; i < values.length; i++) {
        const expected = values[i].includes(term);
        expect(ownedMatch(i)).toBe(expected);
        for (const [oldMatch, newMatch] of matches) {
          expect(oldMatch(i)).toBe(expected);
          expect(newMatch(i)).toBe(i === 0 ? false : i === 1 ? true : expected);
        }
      }
      for (const match of [ownedMatch, ...matches.flat()]) {
        for (const index of [-1, 1057, 0.5, NaN, Infinity, 2 ** 32]) expect(match(index)).toBe(false);
      }
    } finally { TextDecoder.prototype.decode = decode; }
    // Growth may change allocator metadata, never any published string or list.
    expect(new Uint8Array(oldBuffer).subarray(65536, snapshotBytes.length)).toEqual(snapshotBytes.subarray(65536));
    expect(() => readers[0].before.push('other')).toThrow(/read-only/);
  });

  it('keeps compiled searches valid in real workers while the owner grows', async () => {
    resetSharedList();
    const term = 'request-processing-completed-for-map-validation';
    const values = Array.from({ length: 1025 }, (_, i) => `event ${i} ` + (i % 3 ? 'unchanged' : term));
    const text = new SharedList('string').pushMany(values);
    const worker = new Worker(new URL('./proofs/long-text-search-worker.mjs', import.meta.url), {
      // Bun's real workers use the supported copy transport; the separate
      // Node proof also exercises actual shared memory.
      workerData: { payload: getWorkerData({ text }, { copy: !!process.versions.bun }), term },
    });
    const receive = () => new Promise<any>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    try {
      expect(await receive()).toEqual({ ready: true });
      text.pushMany(Array.from({ length: 60000 }, (_, i) => `growing ${i} `.repeat(8)));
      const result = receive(); worker.postMessage('scan');
      expect(await result).toEqual({ count: values.filter(value => value.includes(term)).length });
    } finally { await worker.terminate(); }
  }, 10000);
});
