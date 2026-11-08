import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const [beforeArg, afterArg] = process.argv.slice(2);
assert.ok(beforeArg && afterArg, 'Usage: node abi.mjs BASELINE_ROOT CANDIDATE_ROOT');
const beforeRoot = resolve(beforeArg), afterRoot = resolve(afterArg);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const beforeBytes = readFileSync(join(beforeRoot, 'persistent-core.wasm'));
const afterBytes = readFileSync(join(afterRoot, 'persistent-core.wasm'));
const before = new WebAssembly.Module(beforeBytes), after = new WebAssembly.Module(afterBytes);
const exportsBefore = WebAssembly.Module.exports(before), exportsAfter = WebAssembly.Module.exports(after);
assert.deepEqual(WebAssembly.Module.imports(after), WebAssembly.Module.imports(before));
for (const entry of exportsBefore) assert.deepEqual(exportsAfter.find(item => item.name === entry.name), entry);
const added = exportsAfter.filter(entry => !exportsBefore.some(item => item.name === entry.name));
assert.deepEqual(added.sort((a, b) => a.name.localeCompare(b.name)), [
  { name: 'tailSetMany', kind: 'function' }, { name: 'vecSetMany', kind: 'function' },
]);
const aliases = ['shared-map', 'shared-list', 'linked-list', 'singly-linked-list',
  'doubly-linked-list', 'ordered-map', 'sorted-tree', 'priority-queue'];
for (const root of [beforeRoot, afterRoot]) {
  const core = readFileSync(join(root, 'persistent-core.wasm'));
  for (const alias of aliases) assert.deepEqual(readFileSync(join(root, `${alias}.wasm`)), core, `${alias} must retain the core alias`);
}
console.log(JSON.stringify({ passed: true, scope: 'WASM import/export names and kinds, plus identical legacy aliases; raw-format compatibility is checked by the old-reader worker proof',
  beforeSha256: hash(beforeBytes), afterSha256: hash(afterBytes),
  preservedExports: exportsBefore.length, imports: WebAssembly.Module.imports(after), added, aliases }, null, 2));
