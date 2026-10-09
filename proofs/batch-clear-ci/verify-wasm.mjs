// Deterministic byte/WAT prerequisite. No operation clocks or candidate API runs.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function proveOneOperand(baseline, candidate) {
  const a = baseline.split('\n'), b = candidate.split('\n'); assert.equal(a.length, b.length);
  const changed = a.flatMap((line, i) => line === b[i] ? [] : [i]); assert.equal(changed.length, 1);
  const i = changed[0]; assert.equal(a[i].trim(), '(i32.const 256)'); assert.equal(b[i].trim(), '(i32.const 64)');
  assert.equal(a.slice(0, i).filter(line => /^ \(func /.test(line)).at(-1).match(/^ \(func \$(\d+)/)[1], '19');
  assert(a.slice(i - 20, i).some(line => line.includes('(memory.fill')));
  const interfaces = text => text.split('\n').filter(line => /^ \((import|export) /.test(line));
  assert.deepEqual(interfaces(baseline), interfaces(candidate));
  return {changedFunction: 19, changedLines: 1, baselineLengthOperand: 256, candidateLengthOperand: 64,
    identicalInterfaces: true, baselineWatSha256: sha(baseline), candidateWatSha256: sha(candidate)};
}
export function instrument(text, length) {
  const needle = `    (i32.const ${length})\n   )\n   (loop $label1`;
  assert.equal(text.split(needle).length - 1, 1);
  text = text.replace(needle, `    (block (result i32)
     (global.set $batchCalls (i32.add (global.get $batchCalls) (i32.const 1)))
     (global.set $batchBytes (i32.add (global.get $batchBytes) (i32.const ${length})))
     (i32.const ${length})
    )
   )
   (loop $label1`);
  const firstGlobal = text.match(/^ \(global \$[^ ]+/m)[0];
  return text.replace(firstGlobal, ` (global $batchCalls (mut i32) (i32.const 0))
 (global $batchBytes (mut i32) (i32.const 0))
 (export "__batchFillCalls" (global $batchCalls))
 (export "__batchFillBytes" (global $batchBytes))
` + firstGlobal);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, candidate, directory] = process.argv.slice(2).map(value => path.resolve(value));
  const origin = JSON.parse(readFileSync(new URL('./origin.json', import.meta.url), 'utf8'));
  const binaryen = (await import(pathToFileURL(path.join(base, 'node_modules/binaryen/index.js')).href)).default;
  mkdirSync(directory, {recursive: false});
  const texts = {}, binaries = {};
  for (const [arm, source] of [['baseline', base], ['candidate', candidate]]) {
    binaries[arm] = readFileSync(path.join(source, 'persistent-core.wasm'));
    assert.equal(sha(binaries[arm]), origin.expectedWasm[arm]['persistent-core.wasm']);
    const module = binaryen.readBinary(binaries[arm]); texts[arm] = module.emitText(); module.dispose();
    writeFileSync(path.join(directory, arm + '.wat'), texts[arm], {flag: 'wx'});
    const diagnosticText = instrument(texts[arm], arm === 'baseline' ? 256 : 64);
    const diagnostic = binaryen.parseText(diagnosticText);
    diagnostic.setFeatures(binaryen.Features.All); assert(diagnostic.validate());
    writeFileSync(path.join(directory, arm + '-instrumented.wasm'), diagnostic.emitBinary(), {flag: 'wx'}); diagnostic.dispose();
  }
  const proof = proveOneOperand(texts.baseline, texts.candidate);
  assert.equal(binaries.baseline.length, 26118); assert.equal(binaries.candidate.length, 26118);
  proof.binaryChangedOffsets = Array.from(binaries.baseline.keys()).filter(i => binaries.baseline[i] !== binaries.candidate[i]);
  assert.deepEqual(proof.binaryChangedOffsets, [10961, 10962]);
  proof.officialInputs = Object.fromEntries(Object.entries(binaries).map(([arm, bytes]) => [arm, sha(bytes)]));
  proof.diagnosticOnly = true; proof.timingInputsRemainOfficial = true;
  writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify(proof));
}
