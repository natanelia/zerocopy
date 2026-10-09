import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {fixture, setup, runBody, validateMap, semanticState} from './fixtures.mjs';
Object.defineProperty(performance, 'now', {value: () => { throw Error('Operation clocks forbidden in mechanism proof'); }, configurable: false});
const [officialPath, diagnosticPath, arm, outputPath] = process.argv.slice(2);
assert(['baseline', 'candidate'].includes(arm));
const protocol = JSON.parse(readFileSync(new URL('./protocol.json', import.meta.url), 'utf8'));
const runtime = typeof Bun === 'undefined' ? 'node' : 'bun';
assert.equal(runtime === 'node' ? process.version : Bun.version, protocol.runtimeVersions[runtime]);
const result = {};
for (const [mode, entrypoint] of [['official', officialPath], ['diagnostic', diagnosticPath]]) {
  const api = await import(pathToFileURL(entrypoint).href); api.configureMemory({maximumBytes: protocol.memory.maximumArenaBytes});
  const rows = [];
  for (const spec of protocol.cases) {
    if (spec.shape === 'sorted') api.resetSortedMap(); else api.resetMap();
    const input = fixture(spec), root = setup(api, spec, input), retainedUsed = root.arena.used;
    if (mode === 'diagnostic') { root.arena.wasm.__batchFillCalls.value = 0; root.arena.wasm.__batchFillBytes.value = 0; }
    const {output, checksum} = runBody(api, spec, root, input, 1);
    const counter = mode === 'diagnostic' ? {calls: output.arena.wasm.__batchFillCalls.value, bytes: output.arena.wasm.__batchFillBytes.value} : null;
    if (counter) {
      assert.equal(counter.bytes, counter.calls * (arm === 'baseline' ? 256 : 64));
      if (spec.id === 'bulk-number-4' || spec.shape === 'sorted') assert.equal(counter.calls, 0);
      else assert(counter.calls > 0);
    }
    assert.equal(checksum, spec.resultSize);
    rows.push({case: spec.id, inputDigest: input.inputDigest, checksum, semantics: semanticState(root, output, retainedUsed), outputEntries: validateMap(output, input.expected), counter});
  }
  result[mode] = rows;
  api.resetMap(); api.resetSortedMap();
}
assert.deepEqual(result.official.map(({counter, ...row}) => row), result.diagnostic.map(({counter, ...row}) => row));
writeFileSync(outputPath, JSON.stringify({arm, runtime, operationClocks: false, officialDiagnosticEqual: true, ...result}, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({arm, runtime, rows: result.official.length, officialDiagnosticEqual: true, operationClocks: false}));
