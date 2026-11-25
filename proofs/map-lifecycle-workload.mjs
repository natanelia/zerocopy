import { editsFor, entriesFor } from '../website/assets/catalog-core.mjs';

export const rows = 100_000;
export const queries = ['service-totals', 'metric-sum'];
export const workloads = [...queries, 'compact-catalog', 'compact-revisions', 'import-catalog'];
const expectedTotals = new Array(16).fill(0);
for (let i = 0; i < rows; i++) expectedTotals[i % 16] += i;
const sum = rows * (rows - 1) / 2;

function collect() {
  if (typeof globalThis.gc === 'function') globalThis.gc();
  else globalThis.Bun?.gc?.(true);
}

export function prepare(api) {
  api.resetMap();
  const metricRows = Array.from({ length: rows }, (_, i) =>
    [`service/${String(i % 16).padStart(2, '0')}/event-${String(i).padStart(6, '0')}`, i]);
  const metrics = new api.SharedMap('number').setMany(metricRows);
  const payload = api.getWorkerData({ metrics }, { copy: false });
  if (payload.arenas.length !== 1 || !(payload.arenas[0].memory?.buffer instanceof SharedArrayBuffer)) {
    throw new Error('Expected one shared metrics arena');
  }
  api.resetMap();
  const entries = entriesFor(rows), original = new api.SharedMap('object').setMany(entries);
  let current = original;
  const replacements = new Map();
  for (let revision = 1; revision <= 5; revision++) {
    const edits = editsFor(rows, revision);
    current = current.setMany(edits);
    for (const [key, value] of edits) replacements.set(key, value);
  }
  return { api, payload, entries, original, current, replacements };
}

export async function measureQuery(api, payload, name) {
  const { metrics } = await api.initWorker(payload);
  collect();
  const start = performance.now();
  let total = 0, visited = 0, groups;
  if (name === 'service-totals') {
    groups = new Array(16).fill(0);
    metrics.forEach((value, key) => {
      groups[Number(key.slice(8, 10))] += value;
      visited++;
    });
  } else {
    for (const value of metrics.values()) {
      total += value;
      visited++;
    }
  }
  const elapsedMs = performance.now() - start;
  if (visited !== rows || (groups ? groups.some((value, i) => value !== expectedTotals[i]) : total !== sum)) {
    throw new Error(`Wrong ${name} answer`);
  }
  return { elapsedMs, visited, answer: groups ?? total };
}

export function measureOwner(owner, name, exhaustive) {
  const { api, entries, original, current, replacements } = owner;
  let empty;
  if (name === 'import-catalog') {
    api.resetMap();
    empty = new api.SharedMap('object');
  }
  collect();
  const start = performance.now();
  const output = name === 'compact-revisions' ? api.compactMany({ original, current })
    : { current: name === 'compact-catalog' ? api.compact(current) : empty.setMany(entries) };
  const elapsedMs = performance.now() - start;
  const verify = (map, updated) => {
    if (map.size !== rows) throw new Error('Wrong catalog size');
    const selected = exhaustive ? entries : [entries[0], entries[1], entries[7919], entries[50000], entries.at(-1)];
    for (const [key, initial] of selected) {
      const expected = updated ? replacements.get(key) ?? initial : initial;
      if (JSON.stringify(map.get(key)) !== JSON.stringify(expected)) throw new Error(`Wrong product ${key}`);
    }
  };
  verify(output.current, name !== 'import-catalog');
  if (output.original) verify(output.original, false);
  const { arenas } = api.getWorkerData(output, { copy: false });
  if (arenas.length !== 1) throw new Error('Expected one output arena');
  return { elapsedMs, usedBytes: arenas[0].used, capacityBytes: arenas[0].memory.buffer.byteLength };
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  const api = import('../library/shared.js');
  globalThis.onmessage = async ({ data: { payload, name } }) => {
    try { postMessage(await measureQuery(await api, payload, name)); }
    catch (error) { postMessage({ error: String(error) }); }
  };
}
