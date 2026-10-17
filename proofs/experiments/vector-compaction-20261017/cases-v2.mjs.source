import assert from 'node:assert/strict';

export const cases = [
  ...[0, 32, 33, 1024, 32769, 262145].map(size => ({ name: `list-number-${size}`, kind: 'list', type: 'number', size })),
  { name: 'list-boolean-32769', kind: 'list', type: 'boolean', size: 32769 },
  { name: 'list-string-4097', kind: 'list', type: 'string', size: 4097 },
  { name: 'list-object-4097', kind: 'list', type: 'object', size: 4097 },
  { name: 'queue-number-offset17-32769', kind: 'queue', type: 'number', size: 32769, consumed: 17 },
  { name: 'queue-number-offset31-33', kind: 'queue', type: 'number', size: 33, consumed: 31 },
  { name: 'queue-string-offset17-1025', kind: 'queue', type: 'string', size: 1025, consumed: 17 },
  { name: 'linked-number-4097-control', kind: 'linked', type: 'number', size: 4097 },
  { name: 'map-number-4097-control', kind: 'map', type: 'number', size: 4097 },
];

export function createCase(api, spec) {
  api.resetSharedList(); api.resetQueue(); api.resetLinkedList(); api.resetMap();
  const values = Array.from({ length: spec.size + (spec.consumed ?? 0) }, (_, i) => {
    if (spec.type === 'number') return (i * 7919) % 10007 - 5000.25;
    if (spec.type === 'boolean') return (i % 3) === 0;
    if (spec.type === 'string') return `road/${i}/界🙂`;
    return { id: i, position: [i + 0.25, -i], label: `road/${i}/界🙂` };
  });
  let source;
  if (spec.kind === 'list') source = new api.SharedList(spec.type).pushMany(values);
  else if (spec.kind === 'queue') {
    source = new api.SharedQueue(spec.type);
    for (const value of values) source = source.enqueue(value);
    for (let i = 0; i < spec.consumed; i++) source = source.dequeue();
  } else if (spec.kind === 'linked') {
    source = new api.SharedLinkedList(spec.type);
    for (const value of values) source = source.append(value);
  } else source = new api.SharedMap(spec.type).setMany(values.map((value, i) => [`key/${i}`, value]));
  const retained = values.slice(spec.consumed ?? 0);
  // Object collections use native JSON semantics, including -0 becoming 0.
  const expected = spec.type === 'object' ? JSON.parse(JSON.stringify(retained)) : retained;
  let last, sink = 0;
  function run(iterations) {
    for (let i = 0; i < iterations; i++) { last = api.compact(source); sink = (sink + last.size) | 0; }
    return sink;
  }
  function check() {
    assert.equal(last.size, spec.size);
    if (spec.kind === 'map') assert.deepEqual(new Map(last.entries()), new Map(expected.map((value, i) => [`key/${i}`, value])));
    else if (spec.kind === 'queue') {
      const actual = [];
      for (let q = last; q.size; q = q.dequeue()) actual.push(q.peek());
      assert.deepEqual(actual, expected);
    } else assert.deepEqual(last.toArray(), expected);
    const output = api.getWorkerData({ value: last }, { copy: false });
    return { size: last.size, usedBytes: output.arenas.reduce((sum, a) => sum + a.used, 0), backingBytes: output.arenas.reduce((sum, a) => sum + a.memory.buffer.byteLength, 0), sink };
  }
  return { run, check };
}
