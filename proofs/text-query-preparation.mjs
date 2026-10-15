/** Public semantic controls for scalar preparation; run unchanged on both arms. */
import assert from 'node:assert/strict';
const entry = process.env.QUERY_PROOF_ENTRY ?? new URL('../dist/shared.js', import.meta.url).href;
const { SharedList, getWorkerData, initWorker, resetSharedList } = await import(entry);

function verify(list, terms) {
  const values = list.toArray();
  for (const term of terms) for (const caseSensitive of [true, false]) {
    const query = caseSensitive ? term : term.toLowerCase();
    const match = list.compileTextSearch(term, { caseSensitive });
    for (let i = values.length - 1; i >= 0; i--) {
      const value = caseSensitive ? values[i] : values[i].toLowerCase();
      assert.equal(match(i), value.includes(query), JSON.stringify({ term, caseSensitive, i }));
    }
  }
}

// Short preparation: byte boundaries, zero padding and high-byte words.
{
  resetSharedList();
  const ascii = [1, 4, 5, 8, 9, 12, 13, 16].map(length => 'aB\0[z]Q@_`^'.repeat(2).slice(0, length));
  const unicode = [
    ['aé', 3], ['abé', 4], ['abcé', 5], ['abcdefgé', 9],
    ['abcdefghijké', 13], ['abcdefghijklmn' + 'é', 16],
    ['😀', 4], ['a😀', 5], ['abc😀', 7], ['abc😀a', 8],
    ['abc😀ab', 9], ['😀😀😀', 12], ['a😀😀😀', 13], ['😀😀😀😀', 16],
  ];
  const encoder = new TextEncoder();
  for (const [term, length] of unicode) assert.equal(encoder.encode(term).length, length);
  const terms = [...ascii, ...unicode.map(([term]) => term)];
  const values = ['', ...terms.flatMap(term => [term, 'x' + term, term + 'q', 'x' + term + 'q', term.slice(0, -1)])];
  verify(new SharedList('string').pushMany(values), terms);
}
console.log('PASS short-byte-and-word-boundaries');

// ASCII masks and Unicode fallback use the public decoded includes contract.
{
  resetSharedList();
  const values = [
    '', 'Request', 'REQUEST', 'KELVIN', 'İSTANBUL', 'I\u0307', 'ΟΣ', 'ΟΣΑ', 'ß', 'ẞ', 'ſ',
    'CAFÉ', 'e\u0301', 'é', '😀', '\ud800', '\udfff', '日本語 request', 'request 日本語',
    're中quest', '\uFEFFRequest', 'nul\0byte', '@[\\]^`{|}~', 'a'.repeat(40),
  ];
  const terms = [
    '', 'request', 'K', 'k', 'İ', 'i', '\u0307', 'σ', 'ς', 'ss', 's', 'é', 'e\u0301',
    '😀', '\ud83d', '\ude00', '\ud800', '\udfff', '\uFFFD', '\uFEFF', '\0', '@', '[', '`', '{',
    'a'.repeat(17), 'a'.repeat(32), 'a'.repeat(33),
  ];
  verify(new SharedList('string').pushMany(values), terms);
}
console.log('PASS decoded-includes-contract');

// Required Unicode fallback must preserve decoder effects and exact errors.
{
  resetSharedList();
  const ascii = new SharedList('string').push('Request ' + 'x'.repeat(40));
  const kelvin = new SharedList('string').push('K' + 'x'.repeat(40));
  const surrogate = new SharedList('string').push('prefix 😀 ' + 'x'.repeat(40));
  const asciiMatch = ascii.compileTextSearch('request', { caseSensitive: false });
  const kelvinMatch = kelvin.compileTextSearch('k', { caseSensitive: false });
  const surrogateMatch = surrogate.compileTextSearch('\ud83d');
  const decode = TextDecoder.prototype.decode, failure = new Error('expected decoder failure');
  TextDecoder.prototype.decode = () => { throw failure; };
  try {
    assert.equal(asciiMatch(0), true);
    assert.throws(() => kelvinMatch(0), error => error === failure);
    assert.throws(() => surrogateMatch(0), error => error === failure);
  } finally { TextDecoder.prototype.decode = decode; }
  assert.equal(kelvinMatch(0), true);
  assert.equal(surrogateMatch(0), true);
}
console.log('PASS decoder-fallback-and-errors');

// Option getters: validation order, one read, errors and reentrant growth.
{
  resetSharedList();
  const list = new SharedList('string').pushMany(['Request', '']);
  let reads = 0;
  const options = { get caseSensitive() { reads++; return false; } };
  assert.throws(() => new SharedList('number').compileTextSearch('x', options), TypeError);
  assert.throws(() => list.compileTextSearch(42, options), TypeError);
  assert.equal(reads, 0);
  assert.throws(() => list.compileTextSearch('', null), TypeError);
  const empty = list.compileTextSearch('', options);
  assert.equal(reads, 1); assert.equal(empty(1), true); assert.equal(reads, 1);
  const failure = new Error('expected getter failure');
  assert.throws(() => list.compileTextSearch('', { get caseSensitive() { throw failure; } }), error => error === failure);
  assert.throws(() => list.compileTextSearch('', { get caseSensitive() { reads++; return 'false'; } }), TypeError);
  assert.equal(reads, 2);
  assert.equal(list.compileTextSearch('request', { caseSensitive: null })(0), false);

  const memory = getWorkerData({ list }, { copy: false }).arenas[0].memory;
  const oldBytes = memory.buffer.byteLength;
  let nested, changed, reentries = 0;
  const inherited = Object.create({ get caseSensitive() {
    reentries++;
    nested = list.compileTextSearch('Request');
    changed = list.set(0, 'different').push('x'.repeat(oldBytes + 65536));
    resetSharedList(); new SharedList('string').push('unrelated');
    return false;
  } });
  const match = list.compileTextSearch('request', inherited);
  assert.equal(reentries, 1); assert.ok(memory.buffer.byteLength > oldBytes);
  Object.defineProperty(inherited, 'caseSensitive', { value: true });
  assert.equal(match(0), true); assert.equal(match(1), false); assert.equal(match(2), false);
  assert.equal(nested(0), true); assert.equal(changed.compileTextSearch('different')(0), true);
  assert.equal(reentries, 1);
}
console.log('PASS option-getter-order-and-reentry');

// Factories, subclasses and copied/shared snapshots remain valid after growth.
{
  resetSharedList();
  const input = Array.from({ length: 65 }, (_, i) => ['Request', 'KELVIN', 'abcé', '😀', 'absent'][i % 5] + i);
  const original = new SharedList('string').pushMany(input);
  const descriptor = original.toWorkerData();
  class SearchList extends SharedList {}
  const subclass = new SearchList('string', descriptor.root, descriptor.depth, descriptor.size, undefined, descriptor.tail);
  const factory = SharedList.fromWorkerData(descriptor);
  const shared = (await initWorker(getWorkerData({ original }, { copy: false }))).original;
  const copied = (await initWorker(getWorkerData({ original }, { copy: true }))).original;
  const handles = [original, subclass, factory, shared, copied];
  const queries = [['request', false], ['k', false], ['abcé', true], ['😀', true], ['abcé', false]];
  const prepared = handles.map(list => queries.map(([term, caseSensitive]) => list.compileTextSearch(term, { caseSensitive })));
  const memory = getWorkerData({ original }, { copy: false }).arenas[0].memory;
  const oldBytes = memory.buffer.byteLength;
  const changed = original.set(0, 'different').push('x'.repeat(oldBytes + 65536));
  assert.ok(memory.buffer.byteLength > oldBytes);
  resetSharedList(); new SharedList('string').push('unrelated');
  const indices = [64, 0, 15, 16, 31, 32, 63, 1, 48, 47, 64, 0];
  for (const matches of prepared) for (let q = 0; q < queries.length; q++) {
    const [term, caseSensitive] = queries[q], query = caseSensitive ? term : term.toLowerCase();
    for (const index of indices) assert.equal(matches[q](index), (caseSensitive ? input[index] : input[index].toLowerCase()).includes(query));
    for (const index of [-1, 65, 1.5, NaN, Infinity, '0']) assert.equal(matches[q](index), false);
  }
  assert.equal(changed.compileTextSearch('different')(0), true);
  for (const list of [shared, copied]) assert.throws(() => list.push('x'), /read-only/);
}
console.log('PASS retained-snapshots-and-supported-construction');
console.log(JSON.stringify({ kind: 'text-query-preparation-correctness', groups: 5, status: 'pass' }));
