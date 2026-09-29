/** Batched search must preserve the scalar contract without shared scratch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const module = new WebAssembly.Module(readFileSync(process.env.TEXT_KERNEL_ENTRY ?? new URL('../persistent-core.wasm', import.meta.url)));
const { SharedList, getWorkerData, initWorker, resetSharedList } = await import(process.env.QUERY_PROOF_ENTRY ?? new URL('../dist/shared.js', import.meta.url).href);

test('half-leaf masks preserve matches, Unicode fallbacks, and every short tail', () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  const { textContains16: scalar, textContainsBlock16: batch } = new WebAssembly.Instance(module, { env: { memory } }).exports;
  assert.equal(typeof batch, 'function');
  const bytes = new Uint8Array(memory.buffer), view = new DataView(memory.buffer), encoder = new TextEncoder();
  for (let size = 1; size <= 16; size++) for (const insensitive of [false, true]) {
    const term = 'a'.repeat(size - 1) + 'b', words = new Uint32Array(4), masks = new Uint32Array(4);
    for (let i = 0; i < size; i++) {
      words[i >>> 2] |= term.charCodeAt(i) << ((i & 3) * 8);
      if (insensitive) masks[i >>> 2] |= 32 << ((i & 3) * 8);
    }
    const inputs = ['', term, term.toUpperCase(), '日本語', 'a'.repeat(35), 'x' + term, term + 'x', 'K', 'İ', 'z', 'a'.repeat(20) + 'b', term, 're中quest', '\0', term, 'absent'];
    let end = 65536;
    const pointers = inputs.map(input => {
      const data = encoder.encode(input), p = end;
      view.setUint32(p, data.length, true); bytes.set(data, p + 4); end += 4 + data.length;
      return p;
    });
    for (let count = 1; count <= 16; count++) {
      // The address array ends at memory's last byte. A full-leaf overread traps.
      const address = bytes.length - count * 8;
      for (let i = 0; i < count; i++) view.setFloat64(address + i * 8, pointers[i], true);
      const before = bytes.slice(); let expected = 0;
      for (let i = 0; i < count; i++) {
        const result = scalar(pointers[i], size, ...words, ...masks, insensitive);
        if (result > 0) expected |= 1 << i;
        else if (result < 0) expected |= 1 << (i + 16);
      }
      assert.equal(batch(address, count, size, ...words, ...masks, insensitive) >>> 0, expected >>> 0);
      assert.deepEqual(bytes, before, 'A reader must never write shared scratch');
    }
  }
  for (const count of [0, 17, 0xffffffff]) assert.equal(batch(bytes.length, count, 1, 0,0,0,0, 0,0,0,0, false), 0);
  for (const size of [0, 17, 0xffffffff]) assert.equal(batch(bytes.length, 16, size, 0,0,0,0, 0,0,0,0, false), 0);
});

test('half-leaf predicates remain exact for sparse, reverse, and interleaved queries', async () => {
  for (const size of [1, 15, 16, 17, 31, 32, 33, 1023, 1024, 1025]) {
    resetSharedList();
    const input = Array.from({ length: size }, (_, i) => ['Request ' + i, '日本語', 'KELVIN', 'İ', 'Timeout', '😀'][i % 6]);
    const original = new SharedList('string').pushMany(input);
    for (const copy of [false, true]) {
      const { list } = await initWorker(getWorkerData({ list: original }, { copy }));
      const queries = ['request', 'absent', 'k', 'i', '😀', 'a'.repeat(16)];
      const tests = queries.map(term => list.compileTextSearch(term, { caseSensitive: false }));
      for (let pass = 0; pass < 3; pass++) for (let i = 0; i < size; i++) {
        const index = pass === 0 ? i : pass === 1 ? size - i - 1 : (i * 17) % size;
        for (let q = 0; q < tests.length; q++) assert.equal(tests[q](index), list.get(index).toLowerCase().includes(queries[q]));
      }
    }
  }
});


test('seeded full-range Unicode needles match JavaScript on retained shared and copied views', async () => {
  let seed = 0xf00d, checks = 0;
  const next = () => { seed = Math.imul(seed, 1664525) + 1013904223; return seed >>> 0; };
  const alphabet = ['A', 'Z', 'i', 'k', '[', '{', '^', '~', '\0', 'K', 'İ', 'Σ', 'ς', 'ß', 'é', '中', '😀', '\ud800', '\udfff'];
  for (let trial = 0; trial < 12; trial++) {
    resetSharedList();
    const input = Array.from({ length: 65 + trial }, () =>
      Array.from({ length: next() % 150 }, () => next() % 3
        ? alphabet[next() % alphabet.length] : String.fromCodePoint(next() % 0x110000)).join(''));
    const original = new SharedList('string').pushMany(input);
    const { text } = await initWorker(getWorkerData({ text: original }, { copy: trial % 2 === 0 }));
    // get() defines the public contract: encoding replaces unpaired surrogates.
    const values = text.toArray();
    const terms = ['request', 'k', 'i', 's', 'σ', 'ς', '😀', '\ud83d', '\ude00'];
    for (let j = 0; j < 100; j++) {
      const value = values[next() % values.length], start = next() % (value.length + 1);
      terms.push(value.slice(start, start + next() % 100));
    }
    for (const term of terms) for (const caseSensitive of [true, false]) {
      const query = caseSensitive ? term : term.toLowerCase();
      const contains = text.compileTextSearch(term, { caseSensitive });
      for (let i = values.length - 1; i >= 0; i--) {
        assert.equal(contains(i), (caseSensitive ? values[i] : values[i].toLowerCase()).includes(query),
          JSON.stringify({ trial, term, index: i, caseSensitive }));
        checks++;
      }
    }
  }
  assert.equal(checks, 184428);
});
