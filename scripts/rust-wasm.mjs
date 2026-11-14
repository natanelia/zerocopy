import binaryen from 'binaryen';
import assert from 'node:assert/strict';

// Rust statics would reside in the imported shared memory. These volatile
// placeholders become genuine, instance-local Wasm globals. Raw Cargo output
// is an intermediate file and must never be distributed.
const slots = [
  [2048, 'heap_end', 'i32', 65536], [2052, 'capacity', 'i32', 0],
  [2056, 'inserted_count', 'i32', 0], [2060, 'batch_change', 'i32', 0],
  [2064, 'writer_index_root', 'i32', 0], [2068, 'writer_first_valid', 'i32', 0],
  [2072, 'write_map_root', 'i32', 0], [2076, 'write_map_size', 'i32', 0],
  [2112, 'bbox_min_x', 'f64', Infinity], [2120, 'bbox_min_y', 'f64', Infinity],
  [2128, 'bbox_max_x', 'f64', -Infinity], [2136, 'bbox_max_y', 'f64', -Infinity],
];
const slotByAddress = new Map(slots.map(([address, name, type, initial]) => [address, { name, type, initial }]));
const stateGlobals = new Set(slots.map(([, name]) => name));
const names = new Map(Object.entries(binaryen.ExpressionIds).map(([name, id]) => [id, name]));
// Unfamiliar instructions require review instead of bypassing the audit.
const children = {
  Block: ['children'], If: ['condition', 'ifTrue', 'ifFalse'], Loop: ['body'],
  Break: ['condition', 'value'], Switch: ['condition', 'value'], Call: ['operands'],
  LocalSet: ['value'], GlobalSet: ['value'], Load: ['ptr'], Store: ['ptr', 'value'],
  Unary: ['value'], Binary: ['left', 'right'], Select: ['ifTrue', 'ifFalse', 'condition'],
  Drop: ['value'], Return: ['value'], MemoryGrow: ['delta'],
  MemoryCopy: ['dest', 'source', 'size'], MemoryFill: ['dest', 'value', 'size'],
  SIMDExtract: ['vec'], SIMDReplace: ['vec', 'value'], SIMDShuffle: ['left', 'right'],
  SIMDTernary: ['a', 'b', 'c'], SIMDShift: ['vec', 'shift'], SIMDLoad: ['ptr'],
  Const: [], LocalGet: [], GlobalGet: [], MemorySize: [], Nop: [], Unreachable: [],
};

function expressionInfo(ref) {
  const id = binaryen.getExpressionId(ref);
  // Binaryen's JS convenience accessor has no descriptor for these leaves.
  return id === binaryen.UnreachableId || id === binaryen.NopId
    ? { id, type: binaryen.getExpressionType(ref) } : binaryen.getExpressionInfo(ref);
}

export function walk(ref, visit, replace = false) {
  if (!ref) return ref;
  const info = expressionInfo(ref), name = names.get(info.id);
  assert.ok(Object.hasOwn(children, name), `Unaudited Wasm instruction: ${name ?? info.id}`);
  for (const field of children[name]) {
    const value = info[field];
    if (Array.isArray(value)) {
      value.forEach((child, index) => {
        const next = walk(child, visit, replace);
        if (replace && next !== child) binaryen[name][field === 'children' ? 'setChildAt' : 'setOperandAt'](ref, index, next);
      });
    } else if (value) {
      const next = walk(value, visit, replace);
      if (replace && next !== value) binaryen[name][`set${field[0].toUpperCase()}${field.slice(1)}`](ref, next);
    }
  }
  return visit(ref, replace ? expressionInfo(ref) : info, name) ?? ref;
}

function constantAddress(info) {
  const ptr = binaryen.getExpressionInfo(info.ptr);
  return ptr.id === binaryen.ConstId && ptr.type === binaryen.i32
    ? (ptr.value >>> 0) + info.offset : undefined;
}

export function abiOf(module) {
  const result = {};
  for (let i = 0; i < module.getNumExports(); i++) {
    const item = binaryen.getExportInfo(module.getExportByIndex(i));
    if (item.kind === binaryen.ExternalFunction) {
      const fn = binaryen.getFunctionInfo(module.getFunction(item.value));
      const typeName = type => type === binaryen.i32 ? 'i32' : type === binaryen.f64 ? 'f64' : type === binaryen.i64 ? 'i64' : `type:${type}`;
      result[item.name] = { params: binaryen.expandType(fn.params).map(typeName), results: binaryen.expandType(fn.results).map(typeName) };
    } else {
      assert.equal(item.kind, binaryen.ExternalMemory, `Unexpected export ${item.name}`);
      result[item.name] = { kind: 'memory' };
    }
  }
  return result;
}

export const readerExports = [
  'getHeapEnd', 'mapSize', 'mapFind', 'mapChild', 'keyBuf', 'batchBuf',
  'mapHashCandidate', 'mapHashCandidateFrom', 'mapHashPrefix',
  'textContains16', 'textContainsBlock16', 'vecLeaf', 'vecGet', 'blockGet',
  'mapNumber', 'radixSize', 'radixFind', 'journalFind', 'compareLeaves',
  'jsonValueEnd', 'jsonStringEnd', 'jsonFieldAscii8', 'jsonFieldCandidate', 'jsonArrayAt', 'jsonInteger',
  'countInRange', 'countPointsInBox', 'bboxMinX', 'bboxMinY', 'bboxMaxX', 'bboxMaxY', 'xyLeaf', 'bboxXY',
];

export function auditModule(module, expectedAbi, strictGlobals = false) {
  assert.equal(module.getStart(), 0, 'Instantiation must not run a start function');
  assert.equal(binaryen._BinaryenGetNumDataSegments(module.ptr), 0, 'Data segments would overwrite a shared arena on attachment');
  assert.equal(module.getNumTables(), 0, 'The kernels must not need indirect calls or a runtime table');
  assert.deepEqual(module.getMemoryInfo(), { module: 'env', base: 'memory', initial: 2, shared: true, is64: false, max: 65536 });
  if (expectedAbi) assert.deepEqual(abiOf(module), expectedAbi, 'Kernel ABI changed');
  const functions = new Map();
  let instructions = 0;
  for (let i = 0; i < module.getNumFunctions(); i++) {
    const fn = binaryen.getFunctionInfo(module.getFunctionByIndex(i));
    assert.ok(!fn.module && fn.body, `Host function import is forbidden: ${fn.name}`);
    const facts = { calls: new Set(), writes: false, grows: false };
    walk(fn.body, (_ref, info, name) => {
      instructions++;
      if (name === 'Call') facts.calls.add(info.target);
      if (['Store', 'MemoryCopy', 'MemoryFill'].includes(name)) facts.writes = true;
      if (name === 'MemoryGrow') facts.grows = true;
      if (name === 'GlobalGet' || name === 'GlobalSet') {
        assert.notEqual(info.name, '__stack_pointer', `Linear-memory stack use in ${fn.name}`);
        if (strictGlobals) assert.ok(stateGlobals.has(info.name), `Unaudited instance global ${info.name} in ${fn.name}`);
      }
      if (name === 'Const' && info.type === binaryen.i32) {
        assert.ok(info.value < 2048 || info.value >= 2144, `Unpromoted state address in ${fn.name}`);
      }
      if (name === 'Load' || name === 'Store' || name === 'SIMDLoad') {
        assert.ok(info.offset < 2048 || info.offset >= 2144, `Unpromoted state offset in ${fn.name}`);
      }
    });
    functions.set(fn.name, facts);
  }
  const safe = new Set();
  function readOnly(name, visiting = new Set()) {
    if (safe.has(name) || visiting.has(name)) return;
    const facts = functions.get(name);
    assert.ok(facts, `Unknown callee ${name}`);
    assert.ok(!facts.writes && !facts.grows, `Reader reaches shared-memory writes/growth in ${name}`);
    visiting.add(name);
    for (const callee of facts.calls) readOnly(callee, visiting);
    visiting.delete(name);
    safe.add(name);
  }
  for (const name of readerExports) {
    const ref = module.getExport(name);
    if (ref) readOnly(binaryen.getExportInfo(ref).value);
  }
  return { functions: functions.size, instructions, readOnlyFunctions: safe.size, dataSegments: 0, linearStackUses: 0 };
}

export function finishRustModule(bytes, expectedAbi) {
  const module = binaryen.readBinary(bytes);
  const used = new Set();
  let promoted = 0;
  try {
    assert.equal(binaryen._BinaryenGetNumDataSegments(module.ptr), 0, 'Rust unexpectedly emitted shared data');
    for (let i = 0; i < module.getNumFunctions(); i++) {
      const fn = module.getFunctionByIndex(i);
      const body = walk(binaryen.getFunctionInfo(fn).body, (_ref, info, name) => {
        if (name !== 'Load' && name !== 'Store') return;
        const slot = slotByAddress.get(constantAddress(info));
        if (!slot) return;
        const type = binaryen[slot.type];
        assert.equal(info.bytes, slot.type === 'f64' ? 8 : 4, `Unexpected state width: ${slot.name}`);
        assert.equal(name === 'Load' ? info.type : binaryen.getExpressionType(info.value), type);
        if (!used.has(slot.name)) {
          module.addGlobal(slot.name, type, true, module[slot.type].const(slot.initial));
          used.add(slot.name);
        }
        promoted++;
        return name === 'Load' ? module.global.get(slot.name, type) : module.global.set(slot.name, info.value);
      }, true);
      binaryen.Function.setBody(fn, body);
    }
    for (const name of ['__stack_pointer', '__heap_base', '__data_end']) {
      if (module.getExport(name)) module.removeExport(name);
    }
    assert.ok(module.validate(), 'Invalid Wasm after state promotion');
    // Audit before optimization too: hidden stack traffic must never be
    // accepted just because a particular optimizer happens to remove it.
    auditModule(module, undefined, true);
    binaryen.setOptimizeLevel(3);
    binaryen.setShrinkLevel(0);
    module.optimize();
    module.runPasses(['strip-debug', 'strip-producers', 'vacuum']);
    assert.ok(module.validate(), 'Invalid optimized Wasm');
    const audit = auditModule(module, expectedAbi, true);
    const binary = module.emitBinary();
    assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(binary)), [{ module: 'env', name: 'memory', kind: 'memory' }]);
    return { binary, text: module.emitText(), audit: { ...audit, promoted, instanceGlobals: [...used].sort(), bytes: binary.length } };
  } finally {
    module.dispose();
  }
}
