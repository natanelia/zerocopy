/** Shared, deterministic fixtures for the Node/Bun and browser write proofs. */
export const utf8WriteCases = [
  { name: 'map-json-set', collection: 'SharedMap', type: 'object' },
  { name: 'map-ascii-json-set', collection: 'SharedMap', type: 'object', ascii: true },
  { name: 'map-json-setMany', collection: 'SharedMap', type: 'object', bulk: true },
  { name: 'map-json-update', collection: 'SharedMap', type: 'object', update: true },
  { name: 'map-unicode-set', collection: 'SharedMap', type: 'string', unicode: true },
  { name: 'ordered-json-set', collection: 'SharedOrderedMap', type: 'object' },
  { name: 'sorted-json-set', collection: 'SharedSortedMap', type: 'object' },
  { name: 'list-ascii-push', collection: 'SharedList', type: 'string' },
  { name: 'list-unicode-push', collection: 'SharedList', type: 'string', unicode: true },
  { name: 'list-json-push', collection: 'SharedList', type: 'object' },
  { name: 'list-ascii-json-push', collection: 'SharedList', type: 'object', ascii: true },
  { name: 'list-json-pushMany', collection: 'SharedList', type: 'object', bulk: true },
  { name: 'list-4k-push', collection: 'SharedList', type: 'string', textLength: 4096, limit: 512 },
  { name: 'list-64k-push', collection: 'SharedList', type: 'string', textLength: 65536, limit: 64 },
  { name: 'queue-json-enqueue', collection: 'SharedQueue', type: 'object' },
  { name: 'stack-json-push', collection: 'SharedStack', type: 'object' },
  { name: 'linked-json-append', collection: 'SharedLinkedList', type: 'object' },
  { name: 'doubly-json-append', collection: 'SharedDoublyLinkedList', type: 'object' },
  { name: 'priority-json-enqueue', collection: 'SharedPriorityQueue', type: 'object' },
  // Existing fast paths and string reuse are explicit controls.
  { name: 'control-map-ascii', collection: 'SharedMap', type: 'string' },
  { name: 'control-map-number', collection: 'SharedMap', type: 'number' },
  { name: 'control-list-number', collection: 'SharedList', type: 'number' },
  { name: 'control-list-repeated', collection: 'SharedList', type: 'string', repeated: true },
];

// The update fixture seeds its untimed base with the same generic setMany path.
export function utf8WriteUsesBulkMap(spec, count) {
  return spec.collection === 'SharedMap' && spec.type === 'object' && (spec.bulk || spec.update)
    && count > 0 && count <= 12288;
}

export function checkUtf8WriteStorage(actual, reference) {
  check(JSON.stringify(actual) === JSON.stringify(reference), 'Fresh-arena storage changed between runs');
}

export function compareUtf8WriteStorage(spec, count, before, after) {
  if (utf8WriteUsesBulkMap(spec, count)) {
    check(before.logical && after.logical, 'Missing verified map evidence');
    check(JSON.stringify(after.logical) === JSON.stringify(before.logical), `${spec.name}: logical map differs`);
  } else check(JSON.stringify(after) === JSON.stringify(before), `${spec.name}: baseline storage differs`);
}

const resetNames = {
  SharedMap: 'resetMap', SharedOrderedMap: 'resetOrderedMap', SharedSortedMap: 'resetSortedMap',
  SharedList: 'resetSharedList', SharedQueue: 'resetQueue', SharedStack: 'resetStack',
  SharedLinkedList: 'resetLinkedList', SharedDoublyLinkedList: 'resetDoublyLinkedList',
  SharedPriorityQueue: 'resetPriorityQueue',
};
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { ignoreBOM: true });
function check(condition, message) { if (!condition) throw new Error(message); }
function equalValue(actual, expected) {
  return expected !== null && typeof expected === 'object'
    ? JSON.stringify(actual) === JSON.stringify(expected) : Object.is(actual, expected);
}

export function createUtf8WriteWorkload(api, spec, requestedCount) {
  const count = Math.min(requestedCount, spec.limit ?? requestedCount);
  const isMap = spec.collection.endsWith('Map');
  const keys = Array.from({ length: count }, (_, i) => `${spec.unicode ? '路段-🙂-' : 'key-'}${i}`);
  const values = Array.from({ length: count }, (_, i) => {
    if (spec.type === 'number') return i + 0.25;
    if (spec.type === 'object') return {
      id: i, label: spec.ascii ? `Lane ${i} - road segment` : `Lane ${i} — 道路 🙂`, active: (i & 1) === 0,
      position: [i * 0.25, -i * 0.5], meta: { revision: i % 7, source: 'survey' },
    };
    if (spec.repeated) return `category-${i % 8}`;
    const prefix = spec.unicode ? `道路🙂 café ${i} \u0000 \ufeff ` : `value-${i}-`;
    return prefix + 'x'.repeat(Math.max(0, (spec.textLength ?? 48) - prefix.length));
  });
  const expected = values.map(value => spec.type === 'object'
    ? JSON.parse(JSON.stringify(value)) : spec.type === 'string' ? decoder.decode(encoder.encode(value)) : value);
  const oldValues = spec.update ? values.map(value => ({ ...value, label: `previous-${value.id}` })) : [];
  const entries = keys.map((key, i) => [key, values[i]]);
  const oldEntries = keys.map((key, i) => [key, oldValues[i]]);
  let base, retained, retainedSize = 0;

  const put = (collection, index) => isMap ? collection.set(keys[index], values[index])
    : spec.collection === 'SharedQueue' ? collection.enqueue(values[index])
    : spec.collection === 'SharedPriorityQueue' ? collection.enqueue(values[index], index)
    : spec.collection.endsWith('LinkedList') ? collection.append(values[index]) : collection.push(values[index]);

  function setup() {
    api[resetNames[spec.collection]]();
    base = new api[spec.collection](spec.type);
    if (spec.update) base = base.setMany(oldEntries);
    retained = base; retainedSize = base.size;
  }
  function run() {
    let result = base;
    if (spec.bulk) result = isMap ? result.setMany(entries) : result.pushMany(values);
    else for (let i = 0; i < count; i++) {
      result = put(result, i);
      if (i === (count >>> 1)) { retained = result; retainedSize = i + 1; }
    }
    return result;
  }
  function verifyValues(result, expectedValues, size) {
    check(result.size === size, `${spec.name}: wrong size`);
    const entries = utf8WriteUsesBulkMap(spec, count) ? [] : undefined;
    if (isMap) {
      for (let i = 0; i < size; i++) {
        const actual = result.get(keys[i]);
        check(equalValue(actual, expectedValues[i]), `${spec.name}: value ${i}`);
        if (entries) entries.push([keys[i], actual]);
      }
    } else if (spec.collection === 'SharedQueue' || spec.collection === 'SharedStack') {
      let cursor = result;
      for (let j = 0; j < size; j++) {
        const i = spec.collection === 'SharedStack' ? size - j - 1 : j;
        check(equalValue(cursor.peek(), expectedValues[i]), `${spec.name}: value ${i}`);
        cursor = spec.collection === 'SharedStack' ? cursor.pop() : cursor.dequeue();
      }
    } else if (spec.collection === 'SharedPriorityQueue') {
      const seen = new Set();
      for (const [value, priority] of result.entries()) {
        check(Number.isInteger(priority) && priority >= 0 && priority < size && !seen.has(priority), `${spec.name}: priority`);
        check(equalValue(value, expectedValues[priority]), `${spec.name}: value ${priority}`);
        seen.add(priority);
      }
      check(seen.size === size, `${spec.name}: missing heap entries`);
    } else {
      for (let i = 0; i < size; i++) check(equalValue(result.get(i), expectedValues[i]), `${spec.name}: value ${i}`);
    }
    return entries;
  }
  function mapEvidence(role, map, entries) {
    const size = entries.length;
    const descriptor = map.toWorkerData();
    check(JSON.stringify(Object.keys(descriptor).sort()) === JSON.stringify(['root', 'size', 'valueType']),
      `${spec.name}: unexpected map descriptor fields`);
    check(descriptor.valueType === 'object' && descriptor.size === size && map.size === size,
      `${spec.name}: map type or size`);
    check(Number.isSafeInteger(descriptor.root) && (size ? descriptor.root >= 65536 : descriptor.root === 0),
      `${spec.name}: invalid map root`);
    check(JSON.stringify([...map.keys()].sort()) === JSON.stringify(keys.slice(0, size).sort()),
      `${spec.name}: map key set`);
    return { role, valueType: descriptor.valueType, size: map.size, keyCount: entries.length, entries };
  }
  function verify(result) {
    check(Object.isFrozen(result), `${spec.name}: mutable handle`);
    const resultEntries = verifyValues(result, expected, count);
    let baseEntries, retainedEntries;
    if (spec.update) {
      baseEntries = verifyValues(base, oldValues, count);
      const partial = oldValues.map((value, i) => i < retainedSize ? expected[i] : value);
      retainedEntries = verifyValues(retained, partial, count);
    } else {
      check(base.size === 0, `${spec.name}: changed empty base`);
      baseEntries = [];
      retainedEntries = verifyValues(retained, expected, retainedSize);
    }
    let logical;
    if (utf8WriteUsesBulkMap(spec, count)) {
      const snapshots = [mapEvidence('result', result, resultEntries),
        mapEvidence('base', base, baseEntries), mapEvidence('retained', retained, retainedEntries)];
      logical = { collection: 'SharedMap', snapshotCount: snapshots.length,
        snapshots: snapshots.map(({ entries, ...metadata }) => metadata), canonical: JSON.stringify(snapshots) };
    }
    const a = api.getWorkerData({ result }, { copy: false }).arenas;
    check(a.length === 1, `${spec.name}: unexpected dependencies`);
    return { usedBytes: a[0].used - 65536, backingBytes: a[0].memory.buffer.byteLength,
      payload: new Uint8Array(a[0].memory.buffer, 65536, a[0].used - 65536),
      descriptor: result.toWorkerData(), logical };
  }
  return { spec, count, setup, run, verify };
}
