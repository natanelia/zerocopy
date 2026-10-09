/** Source-instrumented WASM work census. No timers and no public exports changed. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const build = 'build/scalar-text-filter/';
const counts = ['swarChunks', 'firstCandidates', 'verifierCalls', 'verifierWordLoads', 'verifierByteLoads', 'filterSetups', 'filterChunks', 'filteredCandidates', 'scalarStarts'];
function instrument(source) {
  let text = source;
  const replace = (from, to) => { assert.equal(text.split(from).length, 2, from); text = text.replace(from, to); };
  replace('  const first = pointer + 8 <= end ?', '  verifierCalls++;\n  if (pointer + 8 <= end) verifierWordLoads++; else verifierByteLoads += size;\n  const first = pointer + 8 <= end ?');
  replace('  const last = pointer + 16 <= end ?', '  if (pointer + 16 <= end) verifierWordLoads++; else verifierByteLoads += size - 8;\n  const last = pointer + 16 <= end ?');
  replace('    for (; pointer + 8 <= limit; pointer += 8) {', '    for (; pointer + 8 <= limit; pointer += 8) {\n      swarChunks++;');
  replace('      let positions = (different - ONES) & ~different & HIGH;', '      let positions = (different - ONES) & ~different & HIGH;\n      firstCandidates += <u32>popcnt<u64>(positions);');
  replace('    for (; pointer < limit; pointer++) {', '    for (; pointer < limit; pointer++) {\n      scalarStarts++;');
  if (text.includes('    let last: u64')) {
    replace('      const shift = ((size - 1) & 7) * 8;', '      filterSetups++;\n      const shift = ((size - 1) & 7) * 8;');
    replace('        const tail = (load<u64>', '        filterChunks++;\n        const prior = <u32>popcnt<u64>(positions);\n        const tail = (load<u64>');
    replace('        positions &= (tail - ONES) & ~tail & HIGH;', '        positions &= (tail - ONES) & ~tail & HIGH;\n        filteredCandidates += prior - <u32>popcnt<u64>(positions);');
  }
  text += '\n' + counts.map(name => `let ${name}: u32 = 0;`).join('\n');
  text += '\nexport function resetCounters(): void { ' + counts.map(name => `${name} = 0;`).join(' ') + ' }';
  text += '\nexport function getCounter(index: u32): u32 { switch(index) {' + counts.map((name, i) => `case ${i}: return ${name};`).join(' ') + '} return 0; }\n';
  return text;
}
const readerFiles = [build + 'baseline-reader.as.ts', 'shared-text-reader.as.ts'];
const sources = readerFiles.map(file => readFileSync(file, 'utf8'));
for (let i = 0; i < sources.length; i++) {
  const source = build + `instrumented-${i}.as.ts`, target = build + `instrumented-${i}.wasm`;
  writeFileSync(source, instrument(sources[i]));
  execFileSync(process.execPath, ['node_modules/assemblyscript/bin/asc.js', source, '-o', target,
    '--importMemory', '--sharedMemory', '--initialMemory', '2', '--maximumMemory', '65536', '--enable', 'threads', '--runtime', 'stub', '--optimizeLevel', '3', '--shrinkLevel', '0'], { stdio: 'inherit' });
}
const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true }), bytes = new Uint8Array(memory.buffer), view = new DataView(memory.buffer);
const paths = [build + 'baseline-core.wasm', 'persistent-core.wasm', build + 'instrumented-0.wasm', build + 'instrumented-1.wasm'];
const kernels = paths.map(path => new WebAssembly.Instance(new WebAssembly.Module(readFileSync(path)), { env: { memory } }).exports);
const cases = [
  { id: 'tiny-early-hit', text: 'ok!', query: 'ok' },
  { id: 'short-no-chunk', text: 'x'.repeat(12), query: 'needle' },
  { id: 'one-byte-miss', text: 'x'.repeat(1024), query: 'n' },
  { id: 'zero-candidates', text: 'x'.repeat(1024), query: 'needle' },
  { id: 'one-candidate-per-chunk', text: 'nxxxxxxx'.repeat(128), query: 'needle' },
  { id: 'two-candidates-per-chunk', text: 'nxnxxxxx'.repeat(128), query: 'needle' },
  { id: 'dense-second-miss', text: 'a'.repeat(1024), query: 'ab' },
  { id: 'dense-last-miss-8', text: 'a'.repeat(1024), query: 'aaaaaaab' },
  { id: 'dense-last-miss-16', text: 'a'.repeat(1024), query: 'aaaaaaaaaaaaaaab' },
  { id: 'dense-both-endpoints-pass', text: 'a'.repeat(1024), query: 'abaa' },
  { id: 'dense-early-hit', text: 'a'.repeat(1024), query: 'aaaa' },
  { id: 'dense-late-hit', text: 'a'.repeat(1023) + 'b', query: 'aaaaaaab' },
  { id: 'dense-casefold-last-miss', text: 'A'.repeat(1024), query: 'aaaaaaab', insensitive: true },
  { id: 'dense-unicode-tail', text: 'a'.repeat(1021) + '中', query: 'aaaaaaab', insensitive: true },
  ...[7, 8, 9].map(starts => ({ id: `boundary-${starts}-starts`, text: 'a'.repeat(starts + 7), query: 'aaaaaaab' })),
];
const encoder = new TextEncoder(), results = [];
for (const item of cases) {
  const input = encoder.encode(item.text), query = encoder.encode(item.query), words = new Uint32Array(4), masks = new Uint32Array(4);
  for (let i = 0; i < query.length; i++) { words[i >>> 2] |= query[i] << ((i & 3) * 8); if (item.insensitive && query[i] >= 97 && query[i] <= 122) masks[i >>> 2] |= 32 << ((i & 3) * 8); }
  view.setUint32(65536, input.length, true); bytes.set(input, 65540);
  const args = [65536, query.length, ...words, ...masks, !!item.insensitive];
  const expected = kernels[0].textContains16(...args), before = bytes.slice();
  const observations = kernels.map((kernel, i) => {
    if (i >= 2) kernel.resetCounters();
    const result = kernel.textContains16(...args); assert.equal(result, expected, item.id);
    return i >= 2 ? Object.fromEntries(counts.map((name, j) => [name, kernel.getCounter(j)])) : undefined;
  });
  assert.deepEqual(bytes, before, item.id);
  results.push({ id: item.id, queryBytes: query.length, inputBytes: input.length, expected,
    baseline: observations[2], candidate: observations[3] });
}
const report = { noTimings: true, sourceSha256: sources.map(source => createHash('sha256').update(source).digest('hex')), results };
writeFileSync(build + 'census.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
