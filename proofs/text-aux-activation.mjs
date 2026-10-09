/** Run once per fresh portable arm/feature mode. Counts work; never times it. */
import assert from 'node:assert/strict';

const NativeModule = WebAssembly.Module, NativeInstance = WebAssembly.Instance;
const nativeValidate = WebAssembly.validate, nativeAtob = globalThis.atob;
const disabled = process.env.TEXT_AUX_FORCE_UNSUPPORTED === '1';
const source = process.env.TEXT_AUX_SOURCE === '1';
let probes = 0, auxiliaryModules = 0, auxiliaryInstances = 0, decodes = 0;
const importedMemories = [];
function isText(module) {
  const exports = NativeModule.exports(module);
  return exports.length === 3 && exports.some(value => value.name === 'textContainsBlock16');
}
WebAssembly.Module = new Proxy(NativeModule, { construct(target, args) {
  const module = Reflect.construct(target, args);
  if (isText(module)) auxiliaryModules++;
  return module;
} });
WebAssembly.Instance = new Proxy(NativeInstance, { construct(target, args) {
  const instance = Reflect.construct(target, args);
  if (isText(args[0])) { auxiliaryInstances++; importedMemories.push(args[1].env.memory); }
  return instance;
} });
WebAssembly.validate = bytes => { probes++; return disabled ? false : nativeValidate(bytes); };
globalThis.atob = text => { decodes++; return nativeAtob(text); };
const stages = [];
const counts = () => ({ probes, auxiliaryModules, auxiliaryInstances, decodes });
function record(stage) { stages.push({ stage, ...counts() }); }

try {
  const { SharedList, resetSharedList, getWorkerData, initWorker } = await import(process.env.QUERY_PROOF_ENTRY);
  const initial = counts();
  assert.deepEqual(initial, { probes: 0, auxiliaryModules: 0, auxiliaryInstances: 0, decodes: source ? 0 : 1 });
  record('ordinary import');
  new SharedList('number').pushMany([1, 2, 3]);
  resetSharedList();
  const emptyList = new SharedList('string');
  const list = emptyList.pushMany(Array.from({ length: 65 }, (_, i) => [
    'x'.repeat(32) + 'Request ' + i, 'a'.repeat(48), 'x'.repeat(32) + 'KELVIN', '日本語', '',
  ][i % 5]));
  const values = list.toArray();
  const data = getWorkerData({ list }, { copy: false }), memory = data.arenas[0].memory;
  const descriptorsBefore = JSON.stringify(data);
  const memoryBefore = new Uint8Array(memory.buffer).slice();
  const extentBefore = memory.buffer.byteLength;
  const query = list.compileTextSearch('request', { caseSensitive: false });
  const unused = list.compileTextSearch('unused');
  for (const i of [-1, 65, 1.5, NaN, Infinity, '0', undefined, null, 2 ** 32]) assert.equal(query(i), false);
  assert.equal(emptyList.compileTextSearch('x')(0), false);
  assert.equal(list.compileTextSearch('')(0), true);
  assert.equal(list.compileTextSearch('a'.repeat(17))(1), true);
  assert.equal(list.compileTextSearch('a'.repeat(33))(1), true);
  assert.equal(list.compileTextSearch('日本', { caseSensitive: false })(3), true);
  assert.equal(list.compileTextSearch('\ud83d')(0), false);
  assert.deepEqual(counts(), initial, 'No auxiliary work for unused/ineligible queries or invalid indices');
  assert.deepEqual(new Uint8Array(memory.buffer), memoryBefore);
  assert.equal(memory.buffer.byteLength, extentBefore);
  record('construction, query compilation, invalid/empty/ineligible use');

  assert.equal(query(0), true);
  const afterFirst = { probes: 1, auxiliaryModules: disabled ? 0 : 1, auxiliaryInstances: disabled ? 0 : 1, decodes: source ? 0 : disabled ? 1 : 2 };
  assert.deepEqual(counts(), afterFirst);
  assert.deepEqual(new Uint8Array(memory.buffer), memoryBefore);
  assert.equal(memory.buffer.byteLength, extentBefore);
  record('first valid short-query use');
  // A second query and separate attached arena share the same imported memory.
  const second = list.compileTextSearch('k', { caseSensitive: false });
  for (let i = values.length - 1; i >= 0; i--) {
    assert.equal(query(i), values[i].toLowerCase().includes('request'));
    assert.equal(second(i), values[i].toLowerCase().includes('k'));
  }
  const { list: shared } = await initWorker(data);
  assert.equal(shared.compileTextSearch('request', { caseSensitive: false })(0), true);
  assert.deepEqual(counts(), afterFirst);
  assert.equal(JSON.stringify(getWorkerData({ list }, { copy: false })), descriptorsBefore);
  assert.deepEqual(new Uint8Array(memory.buffer), memoryBefore);
  record('second query and shared attachment');

  // An actual writer allocation grows the same memory object. Previously
  // compiled snapshots and newly created snapshots continue to read it.
  const changed = list.push('z'.repeat(extentBefore + 1) + 'request');
  assert.ok(memory.buffer.byteLength > extentBefore);
  assert.equal(query(0), true);
  assert.equal(shared.compileTextSearch('request', { caseSensitive: false })(0), true);
  assert.equal(changed.compileTextSearch('request')(65), true);
  assert.deepEqual(counts(), afterFirst);
  record('writer growth and retained snapshots');

  // Copy attachment creates a second memory, not another auxiliary module.
  const { list: copy } = await initWorker(getWorkerData({ list }, { copy: true }));
  const copyMemory = getWorkerData({ list: copy }, { copy: false }).arenas[0].memory;
  assert.notEqual(copyMemory, memory);
  const copyBefore = new Uint8Array(copyMemory.buffer).slice();
  assert.equal(copy.compileTextSearch('request', { caseSensitive: false })(0), true);
  assert.deepEqual(new Uint8Array(copyMemory.buffer), copyBefore);
  assert.equal(auxiliaryInstances, disabled ? 0 : 2);
  assert.equal(auxiliaryModules, disabled ? 0 : 1);
  assert.equal(probes, 1);
  if (!disabled) assert.deepEqual(importedMemories, [memory, copyMemory]);
  record('first query on second memory via copy attachment');

  resetSharedList();
  const other = new SharedList('string').push('another request');
  assert.equal(query(0), true);
  assert.equal(unused(0), false);
  assert.equal(other.compileTextSearch('request')(0), true);
  assert.equal(auxiliaryInstances, disabled ? 0 : 3);
  assert.equal(auxiliaryModules, disabled ? 0 : 1);
  assert.equal(probes, 1);
  record('reset and independent memory');
  console.log(JSON.stringify({ entry: process.env.QUERY_PROOF_ENTRY, featureDisabled: disabled, source, stages }));
} finally {
  WebAssembly.Module = NativeModule; WebAssembly.Instance = NativeInstance;
  WebAssembly.validate = nativeValidate; globalThis.atob = nativeAtob;
}
