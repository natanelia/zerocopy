/** Runtime-neutral checks used by Vitest, Node, Bun and browser proofs. */
export function equalValues(actual, expected, label = 'values') {
  if (actual.length !== expected.length) throw new Error(`${label}: length mismatch`);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i], b = expected[i];
    const equal = b !== null && typeof b === 'object'
      ? JSON.stringify(a) === JSON.stringify(b) : Object.is(a, b);
    if (!equal || !Object.hasOwn(actual, i)) throw new Error(`${label}: mismatch at ${i}`);
  }
}
function scan(item, reverse = false) {
  const values = [], indices = [];
  item[reverse ? 'forEachReverse' : 'forEach']((value, index) => {
    values.push(value); indices.push(index);
  });
  equalValues(indices, Array.from({ length: item.size }, (_, i) => reverse ? item.size - 1 - i : i), 'indices');
  return values;
}
export async function runScanChecks(api) {
  const passed = [];
  const check = (name, fn) => { fn(); passed.push(name); };
  const special = [-0, 0, NaN, Infinity, -Infinity, Number.MIN_VALUE, 1.25];
  for (const n of [0, 1, 31, 32, 33, 1024, 1025, 32769]) {
    check(`numeric list boundaries: ${n}`, () => {
      const expected = Array.from({ length: n }, (_, i) => special[i % special.length]);
      const item = api.compact(new api.SharedList('number')).pushMany(expected);
      equalValues(item.toArray(), expected); equalValues([...item.values()], expected);
      equalValues(scan(item), expected);
    });
  }
  // Prepare and refresh before tracing. Constructor counts are not GC timings.
  for (const type of ['number', 'boolean']) {
    check(`${type}: explicit byte order and zero new scan views`, () => {
      const expected = Array.from({ length: 1057 }, (_, i) => type === 'number' ? special[i % special.length] : i % 3 === 0);
      const item = api.compact(new api.SharedList(type)).pushMany(expected);
      item.toArray();
      const Native = globalThis.Float64Array, View = globalThis.DataView;
      const original = View.prototype.getFloat64;
      let typedViews = 0, dataViews = 0, reads = 0;
      globalThis.Float64Array = new Proxy(Native, { construct(target, args) {
        typedViews++; return Reflect.construct(target, args, target);
      } });
      globalThis.DataView = new Proxy(View, { construct(target, args) {
        dataViews++; return Reflect.construct(target, args, target);
      } });
      View.prototype.getFloat64 = function (offset, littleEndian) {
        if (littleEndian !== true) throw new Error('Scan must read explicit little-endian bytes');
        reads++; return original.call(this, offset, littleEndian);
      };
      try {
        equalValues(item.toArray(), expected); equalValues([...item.values()], expected);
        equalValues(scan(item), expected);
      } finally {
        View.prototype.getFloat64 = original;
        globalThis.Float64Array = Native; globalThis.DataView = View;
      }
      if (typedViews || dataViews || reads !== 3 * expected.length) {
        throw new Error(`Unexpected scan views/reads: ${typedViews}/${dataViews}/${reads}`);
      }
    });
  }
  check('iterator suspension, interleaving, callbacks and actual shared growth', () => {
    const expected = Array.from({ length: 1057 }, (_, i) => i + 0.5);
    const item = api.compact(new api.SharedList('number')).pushMany(expected);
    const fork = item.set(32, -32), a = item.values(), b = fork.values();
    const first = a.next().value, other = b.next().value;
    const memory = api.getWorkerData({ item }, { copy: false }).arenas[0].memory;
    const bytesBefore = memory.buffer.byteLength;
    item.pushMany(Array(100000).fill(1));
    if (memory.buffer.byteLength <= bytesBefore) throw new Error('Test did not grow shared memory');
    equalValues([first, ...a], expected);
    const forkExpected = expected.slice(); forkExpected[32] = -32;
    equalValues([other, ...b], forkExpected);
    const visited = [];
    item.forEach((value, index) => {
      if (index === 20) { memory.grow(1); equalValues(fork.toArray(), forkExpected); }
      visited.push(value);
    });
    equalValues(visited, expected); equalValues(api.compact(item).toArray(), expected);
  });
  for (const type of ['number', 'boolean']) for (const copy of [false, true]) {
    const expected = Array.from({ length: 1057 }, (_, i) => type === 'boolean' ? i % 3 === 0 : special[i % special.length]);
    const source = api.compact(new api.SharedList(type)).pushMany(expected);
    const { item } = await api.initWorker(api.getWorkerData({ item: source }, { copy }));
    check(`${type}: ${copy ? 'copy' : 'shared'} attachment`, () => {
      equalValues(item.toArray(), expected); equalValues([...item.values()], expected);
      equalValues(scan(item), expected);
      let rejected = false;
      try { item.push(expected[0]); } catch (error) { rejected = /read-only/.test(error.message); }
      if (!rejected) throw new Error('Reader accepted a write');
    });
  }
  for (const name of ['SharedLinkedList', 'SharedDoublyLinkedList']) for (const type of ['number', 'boolean', 'string', 'object']) {
    check(`${name}<${type}>: forward/reverse scans and growth`, () => {
      const expected = Array.from({ length: 65 }, (_, i) => type === 'number' ? special[i % special.length]
        : type === 'boolean' ? i % 3 === 0 : type === 'string' ? `界🙂${i}` : { id: i, nested: { value: i } });
      let item = api.compact(new api[name](type));
      for (const value of expected) item = item.append(value);
      const fork = item.prepend(expected[0]);
      equalValues(item.toArray(), expected); equalValues(scan(item), expected);
      equalValues(fork.toArray(), [expected[0], ...expected]);
      if (name === 'SharedDoublyLinkedList') {
        const memory = api.getWorkerData({ item }, { copy: false }).arenas[0].memory;
        const values = [];
        item.forEachReverse((value, index) => { if (index === 64) memory.grow(1); values.push(value); });
        equalValues(values, expected.slice().reverse());
        equalValues(scan(item, true), expected.slice().reverse());
        equalValues(item.toArrayReverse(), expected.slice().reverse());
      }
      if (type === 'object' && !Object.isFrozen(item.get(0).nested)) throw new Error('Decoded JSON is mutable');
    });
  }
  check('nested descriptors still decode across list leaves', () => {
    const children = Array.from({ length: 65 }, (_, i) => new api.SharedMap('number').set('id', i));
    const item = api.compact(new api.SharedList(api.map('number'))).pushMany(children);
    const expected = children.map((_, i) => i);
    equalValues([...item.values()].map(value => value.get('id')), expected);
    equalValues(item.toArray().map(value => value.get('id')), expected);
  });
  return { count: passed.length, passed };
}
