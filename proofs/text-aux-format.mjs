/** Cross-build descriptor and stored-byte equality; no timing or new wire fields. */
import assert from 'node:assert/strict';
const entries = process.argv.slice(2);
assert.equal(entries.length, 3, 'Pass baseline, scalar-control, and SIMD portable shared.js URLs');
const apis = await Promise.all(entries.map(entry => import(entry)));
const input = Array.from({ length: 65 }, (_, i) => [
  'x'.repeat(15) + 'Request ' + i, 'x'.repeat(16) + 'Timeout', 'x'.repeat(17) + 'KELVIN',
  '\0日本語😀', '\ufeffRequest', '', 'a'.repeat(49), '\ud800',
][i % 8]);
const lists = apis.map(api => { api.resetSharedList(); return new api.SharedList('string').pushMany(input); });
const normalize = data => ({
  __shared: data.__shared, version: data.version,
  arenas: data.arenas.map(({ used, memory, copy }) => ({ used, memory: !!memory, copy: copy ? Array.from(copy) : undefined })),
  structures: Object.fromEntries(Object.entries(data.structures).map(([key, value]) => [key, {
    type: value.type, arena: data.arenas.findIndex(arena => arena.id === value.arena), data: value.data,
  }])),
});
const originalData = apis.map((api, i) => api.getWorkerData({ list: lists[i] }, { copy: false }));
const stored = originalData.map(data => new Uint8Array(data.arenas[0].memory.buffer).slice());
for (let i = 1; i < entries.length; i++) {
  assert.deepEqual(normalize(originalData[i]), normalize(originalData[0]));
  assert.deepEqual(stored[i], stored[0]);
}
let attachments = 0, predicates = 0;
for (let producer = 0; producer < entries.length; producer++) for (let reader = 0; reader < entries.length; reader++) {
  for (const copy of [false, true]) {
    const data = apis[producer].getWorkerData({ list: lists[producer] }, { copy });
    const { list } = await apis[reader].initWorker(data);
    const values = list.toArray();
    assert.deepEqual(values, lists[producer].toArray());
    assert.deepEqual(list.toWorkerData(), lists[producer].toWorkerData());
    for (const term of ['', 'request', 'k', 'missing', '😀', '\ud83d', 'a'.repeat(16), 'a'.repeat(17), 'a'.repeat(33)]) {
      for (const caseSensitive of [false, true]) {
        const query = list.compileTextSearch(term, { caseSensitive });
        for (let i = values.length - 1; i >= 0; i--) assert.equal(query(i),
          (caseSensitive ? values[i] : values[i].toLowerCase()).includes(caseSensitive ? term : term.toLowerCase()));
        predicates++;
      }
    }
    attachments++;
  }
}
for (let i = 0; i < entries.length; i++) assert.deepEqual(new Uint8Array(originalData[i].arenas[0].memory.buffer), stored[i]);
console.log(JSON.stringify({ entries, identicalStoredBytes: stored[0].length, attachments, predicates, format: originalData[0].version }));
