// Real Node/browser worker correctness checks; no performance measurements.
export function assert(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, wanted, message) {
  assert(actual.length === wanted.length, `${message}: length`);
  for (let i = 0; i < wanted.length; i++) assert(Object.is(actual[i], wanted[i]), `${message}: value ${i}`);
}
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const patterns = [0x7ff8000000000001n, 0x7ff8000000000002n, 0x7ff0000000000001n,
  0xfff8000000000042n, 0x8000000000000000n, 0x0000000000000001n];
function input(count, shared = false, offset = 0) {
  const buffer = shared ? new SharedArrayBuffer((count + offset + 2) * 8) : new ArrayBuffer((count + offset + 2) * 8);
  const values = new Float64Array(buffer, offset * 8, count), view = new DataView(buffer);
  for (let i = 0; i < count; i++) values[i] = i * 0.25 - 99;
  const indices = [0, 17, 31, 32, 1024, count - 1].filter(index => index >= 0 && index < count);
  const bits = [];
  for (let i = 0; i < indices.length; i++) {
    view.setBigUint64((offset + indices[i]) * 8, patterns[i], littleEndian);
    bits.push([indices[i], patterns[i]]);
  }
  return { values, expected: { values: Array.from(values), bits } };
}
function storedBits(S, list, index) {
  const packet = S.getWorkerData({ list }, { copy: false });
  const view = new DataView(packet.arenas[0].memory.buffer), start = (list.size - 1) & ~31;
  let pointer = list.tail;
  if (index < start) {
    pointer = list.root;
    for (let level = list.depth; level > 0; level--) pointer = view.getUint32(pointer + ((index >>> (level * 5)) & 31) * 4, true);
  }
  return view.getBigUint64(pointer + (index & 31) * 8, true);
}
export function capture(S, structures) {
  return S.getWorkerData(structures, { copy: false }).arenas.map(source => ({ memory: source.memory,
    bytes: new Uint8Array(source.memory.buffer, 65536, source.used - 65536).slice() }));
}
export function unchanged(records) {
  for (const { memory, bytes } of records) {
    const current = new Uint8Array(memory.buffer, 65536, bytes.length);
    assert(current.every((value, i) => value === bytes[i]), 'Published bytes changed');
  }
}
export function fixture(S) {
  S.resetSharedList();
  const inputs = { numeric: input(65569), subview: input(1057, false, 7), shared: input(4097, true, 3), empty: input(0) };
  const structures = {}, expected = {};
  for (const [name, data] of Object.entries(inputs)) {
    structures[name] = S.fromFloat64(data.values); expected[name] = data.expected;
    data.values.fill(12345); // Caller storage must never remain mutable list storage.
  }
  verify(S, structures, expected);
  return { structures, expected };
}
export function verify(S, structures, expected, readOnly = false) {
  for (const [name, list] of Object.entries(structures)) {
    const wanted = expected[name];
    assert(Object.isFrozen(list) && list.type === 'number', `${name}: frozen numeric list`);
    assert(list.size === wanted.values.length, `${name}: size`);
    equal(list.toArray(), wanted.values, `${name}: toArray`);
    equal([...list.values()], wanted.values, `${name}: values`);
    const scanned = [];
    list.forEach((value, index) => { assert(index === scanned.length, `${name}: order`); scanned.push(value); });
    equal(scanned, wanted.values, `${name}: forEach`);
    for (const [index, bits] of wanted.bits) {
      assert(Object.is(list.get(index), wanted.values[index]), `${name}: get ${index}`);
      assert(storedBits(S, list, index) === bits, `${name}: raw bits ${index}`);
    }
    if (readOnly) {
      let rejected = false;
      try { list.push(1); } catch (error) { rejected = /read-only/.test(error.message); }
      assert(rejected, `${name}: attached append must reject`);
      if (list.size) {
        rejected = false;
        try { list.set(0, list.get(0)); } catch (error) { rejected = /read-only/.test(error.message); }
        assert(rejected, `${name}: attached set must reject`);
      }
    }
  }
}
export function editAndGrow(S, structures, expected) {
  const memory = S.getWorkerData(structures, { copy: false }).arenas[0].memory, before = memory.buffer;
  const values = new Float64Array(before.byteLength / 8 + 65569);
  for (let i = 0; i < values.length; i++) values[i] = -i - 0.5;
  const imported = S.fromFloat64(values);
  assert(memory.buffer !== before, 'Typed import must grow the owning arena');
  assert(imported.root >= before.byteLength, 'New root must extend beyond the old worker view');
  values.fill(17);
  const suffix = [7.5, -0, -33.25], numeric = structures.numeric.pushMany(suffix).set(500, -999);
  const subview = structures.subview.pop().set(33, 812.5);
  const shared = structures.shared.push(-101), empty = structures.empty.pushMany([1, -0, 3]);
  const numericValues = [...expected.numeric.values, ...suffix]; numericValues[500] = -999;
  const subviewValues = expected.subview.values.slice(0, -1); subviewValues[33] = 812.5;
  const next = { structures: { numeric, subview, shared, empty, imported }, expected: {
    numeric: { values: numericValues, bits: expected.numeric.bits },
    subview: { values: subviewValues, bits: expected.subview.bits.filter(([index]) => index < subviewValues.length) },
    shared: { values: [...expected.shared.values, -101], bits: expected.shared.bits },
    empty: { values: [1, -0, 3], bits: [[1, 0x8000000000000000n]] },
    imported: { values: Array.from({ length: imported.size }, (_, i) => -i - 0.5), bits: [] },
  } };
  verify(S, next.structures, next.expected);
  return next;
}
export function reentrantWriter(S) {
  const original = fixture(S), published = capture(S, original.structures);
  const saved = original.structures.numeric.get(1024);
  const grown = editAndGrow(S, original.structures, original.expected);
  verify(S, original.structures, original.expected); unchanged(published);
  assert(Object.is(original.structures.numeric.get(1024), saved), 'Cached read after typed import growth');
  return { importedCount: grown.structures.imported.size, checks: ['float64-input-copy', 'subview', 'shared-input',
    'raw-NaN-payloads', 'signed-zero', 'empty-input', 'set-push-pop-after-import',
    'memory-growth', 'old-view-validity', 'published-byte-immutability'] };
}
export function createWorkerHandler(S, send, control) {
  let original, expected, published;
  return async message => {
    if (message.type === 'initial') {
      original = await S.initWorker(message.payload); expected = message.expected;
      published = capture(S, original);
      const saved = original.numeric.get(1024), values = [];
      for (const value of original.numeric.values()) {
        if (values.length === 3) {
          send({ type: 'paused' });
          assert(Atomics.wait(control, 0, 0, 20000) !== 'timed-out', 'Owner growth handshake');
          assert(Object.is(original.numeric.get(1024), saved), 'Cached read after owner growth');
        }
        values.push(value);
      }
      equal(values, expected.numeric.values, 'Paused and resumed numeric scan');
      verify(S, original, expected, true); unchanged(published);
      return { type: 'scanned', ok: true, count: values.length };
    }
    assert(message.type === 'updated' && original, 'Worker protocol');
    const next = await S.initWorker(message.payload);
    verify(S, next, message.expected, true);
    verify(S, original, expected, true); unchanged(published);
    return { type: 'complete', ok: true, checked: ['retained-source', 'raw-NaN-payloads', 'signed-zero',
      'read-only-guards', 'new-root-after-growth', 'ordinary-edits-after-import', 'published-bytes'] };
  };
}
