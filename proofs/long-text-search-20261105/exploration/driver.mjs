import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { SharedList, resetSharedList } = await import(pathToFileURL(process.argv[2]).href);
const runtime = process.versions.bun ? `bun-${process.versions.bun}` : `node-${process.version}`;
const phrase = 'request-processing-completed-for-map-validation';
const cases = [
  { name: 'long-ascii-miss', term: 'Z'.repeat(40) + 'target', sensitive: true, text: i => `log entry ${i} ` + 'map tile validation successful. '.repeat(30) },
  { name: 'long-ascii-hit-end', term: phrase, sensitive: true, text: i => `log entry ${i} ` + 'map tile validation successful. '.repeat(30) + (i % 4 ? 'okay' : phrase) },
  { name: 'long-ascii-hit-first', term: phrase, sensitive: true, text: i => phrase + ` ${i} ` + 'map tile validation successful. '.repeat(30) },
  { name: 'long-insensitive-miss', term: 'XYZ'.repeat(14), sensitive: false, text: i => `log entry ${i} ` + 'Map Tile Validation Successful. '.repeat(30) },
  { name: 'long-insensitive-hit', term: phrase, sensitive: false, text: i => `log entry ${i} ` + 'Map Tile Validation Successful. '.repeat(30) + (i % 4 ? 'okay' : phrase.toUpperCase()) },
  { name: 'long-prefix-overlap', term: 'a'.repeat(64) + 'b', sensitive: true, text: i => 'a'.repeat(1024) + (i % 4 ? 'c' : 'b') + i },
  { name: 'long-unicode-fallback', term: 'k'.repeat(40), sensitive: false, text: i => `log entry ${i} ` + 'Map Tile Validation Successful. '.repeat(15) + (i % 4 ? 'K' : 'K'.repeat(40)) },
  { name: 'short-query-control', term: 'validation', sensitive: false, text: i => `log entry ${i} ` + 'Map Tile Validation Successful. '.repeat(15) },
];
const records = [];
for (const c of cases) {
  resetSharedList();
  const input = Array.from({ length: 2048 }, (_, i) => c.text(i));
  const query = c.sensitive ? c.term : c.term.toLowerCase();
  const expected = input.reduce((sum, value, i) => sum + ((c.sensitive ? value : value.toLowerCase()).includes(query) ? i + 1 : 0), 0);
  const list = new SharedList('string').pushMany(input);
  const scan = () => {
    let sum = 0;
    for (let repeat = 0; repeat < 4; repeat++) {
      const match = list.compileTextSearch(c.term, { caseSensitive: c.sensitive });
      for (let i = 0; i < list.size; i++) if (match(i)) sum += i + 1;
    }
    return sum;
  };
  for (let i = 0; i < 5; i++) assert.equal(scan(), expected * 4);
  const samples = [];
  for (let i = 0; i < 9; i++) {
    const start = performance.now(), sum = scan(), ms = performance.now() - start;
    assert.equal(sum, expected * 4);
    samples.push(ms / 4);
  }
  records.push({ name: c.name, expected, samples, median: [...samples].sort((a,b) => a-b)[4] });
}
console.log(JSON.stringify({ runtime, entry: process.argv[2], records }));
