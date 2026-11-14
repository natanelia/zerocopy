import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import binaryen from 'binaryen';
import { auditModule, finishRustModule } from './rust-wasm.mjs';

const memory = '(import "env" "memory" (memory 2 65536 shared)) (export "memory" (memory 0))';
function fixture(body) {
  const module = binaryen.parseText(`(module ${memory} ${body})`);
  module.setFeatures(binaryen.Features.Atomics | binaryen.Features.BulkMemory | binaryen.Features.MutableGlobals);
  const features = ['atomics', 'bulk-memory', 'mutable-globals'];
  module.addCustomSection('target_features', Uint8Array.from([features.length,
    ...features.flatMap(name => [43, name.length, ...new TextEncoder().encode(name)])]));
  return module;
}
function rejects(body, pattern) {
  const module = fixture(body);
  try { assert.throws(() => auditModule(module, undefined, true), pattern); } finally { module.dispose(); }
}

test('all shipped kernels preserve their scalar ABI and pass the shared-memory audit', () => {
  const abi = JSON.parse(readFileSync(new URL('../rust/wasm-abi.json', import.meta.url), 'utf8'));
  for (const [name, expected] of Object.entries(abi)) {
    const module = binaryen.readBinary(readFileSync(new URL(`../${name}.wasm`, import.meta.url)));
    try {
      const report = auditModule(module, expected);
      assert.equal(report.linearStackUses, 0);
      assert.equal(report.dataSegments, 0);
      assert.ok(report.readOnlyFunctions > 0);
    } finally { module.dispose(); }
  }
});

test('attachment and private allocator/bbox state never modify an imported arena', () => {
  const shared = new WebAssembly.Memory({ initial: 2, maximum: 65536, shared: true });
  const bytes = new Uint8Array(shared.buffer);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 93) & 255;
  const before = bytes.slice();
  const core = new WebAssembly.Module(readFileSync(new URL('../persistent-core.wasm', import.meta.url)));
  const a = new WebAssembly.Instance(core, { env: { memory: shared } }).exports;
  const b = new WebAssembly.Instance(core, { env: { memory: shared } }).exports;
  assert.equal(a.getHeapEnd(), 65536);
  assert.equal(b.getHeapEnd(), 65536);
  a.setHeapEnd(70000);
  assert.equal(a.getHeapEnd(), 70000);
  assert.equal(b.getHeapEnd(), 65536);
  assert.deepEqual(bytes, before);
  const geometry = new WebAssembly.Module(readFileSync(new URL('../geometry-kernels.wasm', import.meta.url)));
  const first = new WebAssembly.Instance(geometry, { env: { memory: shared } }).exports;
  const second = new WebAssembly.Instance(geometry, { env: { memory: shared } }).exports;
  assert.equal(first.bboxMinX(), Infinity);
  assert.equal(first.bboxMinY(), Infinity);
  assert.equal(second.bboxMaxX(), -Infinity);
  assert.equal(second.bboxMaxY(), -Infinity);
  assert.deepEqual(bytes, before);
});

test('the build rejects shared data initialization and start functions', () => {
  rejects('(data (i32.const 65536) "bad")', /Data segments/);
  rejects('(func $init) (start $init)', /start function/);
});

test('the audit follows reader calls and rejects hidden writes and memory growth', () => {
  rejects('(func $write (i32.store (i32.const 65536) (i32.const 7))) (func (export "jsonValueEnd") (call $write))', /shared-memory writes/);
  rejects('(func (export "mapFind") (drop (memory.grow (i32.const 1))))', /shared-memory writes\/growth/);
  rejects('(func (export "bboxXY") (memory.fill (i32.const 65536) (i32.const 0) (i32.const 8)))', /shared-memory writes/);
});

test('the build rejects a Rust linear stack even in a writer', () => {
  rejects('(global $__stack_pointer (mut i32) (i32.const 65536)) (func (export "writer") (drop (global.get $__stack_pointer)))', /Linear-memory stack/);
  rejects('(global $renamed_stack (mut i32) (i32.const 65536)) (func (export "writer") (drop (global.get $renamed_stack)))', /Unaudited instance global/);
});

test('the audit rejects host callbacks and residual state addresses', () => {
  rejects('(import "env" "allocate" (func $allocate))', /Host function import/);
  rejects('(func (export "getHeapEnd") (result i32) (i32.load offset=2048 (i32.const 0)))', /Unpromoted state offset/);
  rejects('(func (export "writer") (result i32) (i32.const 2048))', /Unpromoted state address/);
});

test('promotion preserves zero-filled-independent initial state and rejects width changes', () => {
  const module = fixture('(func (export "getHeapEnd") (result i32) (i32.load offset=2048 (i32.const 0)))');
  const wrong = fixture('(func (export "getHeapEnd") (result i32) (i32.load16_u offset=2048 (i32.const 0)))');
  try {
    const result = finishRustModule(module.emitBinary());
    const shared = new WebAssembly.Memory({ initial: 2, maximum: 65536, shared: true });
    new Uint8Array(shared.buffer).fill(255);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), { env: { memory: shared } });
    assert.equal(instance.exports.getHeapEnd(), 65536);
    assert.equal(result.audit.promoted, 1);
    assert.throws(() => finishRustModule(wrong.emitBinary()), /Unexpected state width/);
  } finally { module.dispose(); wrong.dispose(); }
});
