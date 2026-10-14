// Fixtures only. No production module is imported by this file.
export const WARM = 32;
export const PILOT = 8;
export const TARGET_MS = 1000;
export const MIN_BATCH_MS = 100;
export const MIN_COLD_MS = 0.1;
export const BOOTSTRAP_SEED = 0x5e5510c4;
export const CASES = [
  { id: 'json-hot', kind: 'json', n: 1024, max: 512, primary: true },
  { id: 'list-string-hot', kind: 'list-string', n: 1024, max: 512, primary: true },
  { id: 'json-small', kind: 'json', n: 64, max: 4096 },
  { id: 'json-churn', kind: 'small-json', n: 1024, max: 128, all: true },
  { id: 'number', kind: 'number', n: 1024, max: 1024 },
  { id: 'map-string', kind: 'map-string', n: 1024, max: 512 },
  { id: 'copy', kind: 'json', n: 1024, max: 64, copy: true },
  { id: 'raw', kind: 'json', n: 1024, max: 512, raw: true },
  { id: 'many', kind: 'many', n: 64, max: 1024 },
  { id: 'rotate', kind: 'json', n: 1024, max: 512, rotate: true },
].map(Object.freeze);
const KEYS = Array.from({ length: 1024 }, (_, i) => `k${String(i).padStart(4, '0')}`);
export const KEY = i => KEYS[i];
const JSON_BODY = 'café-東京-🚀|'.repeat(24);
const STRING_BODY = 'café-東京-🚀|'.repeat(40);
const encoder = new TextEncoder();
export function value(c, i, r) {
  if (c.kind === 'number' || c.kind === 'many') return 100000 + i * 8192 + r;
  if (c.kind.includes('string')) return `${100000 + i}:${100000 + r}:${STRING_BODY}`;
  if (c.kind === 'small-json') return { id: 100000 + i, revision: 100000 + r, value: 200000 + i + r };
  return { id: 100000 + i, revision: 100000 + r, score: 200000 + i + r, active: i % 2 === 0,
    nested: { values: [100000 + i, 100000 + r, 200000 + i], label: 'naïve-雪' }, label: JSON_BODY };
}
export function changed(c, revision) {
  if (c.kind === 'many') return [(revision - 1) % c.n];
  const group = (revision - 1) % 10;
  const lo = c.rotate ? Math.floor(group * c.n / 10) : 0;
  const hi = c.all ? c.n : c.rotate ? Math.floor((group + 1) * c.n / 10) : Math.floor(c.n / 10);
  return Array.from({ length: hi - lo }, (_, j) => lo + j);
}
function scalar(c, v) {
  if (c.kind === 'number' || c.kind === 'many') return v;
  if (c.kind.includes('string')) {
    // Decode-dependent prefix and Unicode suffix, with no stringify or full hash.
    let n = v.length;
    for (let j = 0; j < 13; j++) n = (Math.imul(n, 33) + v.charCodeAt(j)) >>> 0;
    return (n + v.charCodeAt(v.length - 1)) >>> 0;
  }
  if (c.kind === 'small-json') return v.id + v.revision * 3 + v.value * 5;
  return v.id + v.revision * 3 + v.score * 5 + Number(v.active) * 7
    + v.nested.values[0] * 11 + v.nested.values[1] * 13 + v.nested.values[2] * 17
    + v.nested.label.length * 19 + v.label.length * 23 + v.label.charCodeAt(0);
}
function add(sum, c, v, i) { return (sum + Math.imul(scalar(c, v) >>> 0, (i * 2 + 1))) >>> 0; }
export function read(c, state) {
  let sum = 0;
  for (let i = 0; i < c.n; i++) {
    const v = c.kind === 'many' ? state[KEY(i)].get('v')
      : c.kind === 'list-string' ? state.data.get(i) : state.data.get(KEY(i));
    sum = add(sum, c, v, i);
  }
  return sum;
}
export function oracle(c) {
  const contributions = Uint32Array.from({ length: c.n }, (_, i) => add(0, c, value(c, i, 0), i));
  return { contributions, checksum: contributions.reduce((sum, term) => (sum + term) >>> 0, 0) };
}
export function create(z, c) {
  z.configureMemory({ maximumBytes: (c.kind === 'many' ? 2 : 128) * 1024 * 1024 });
  if (c.kind === 'many') {
    const state = {};
    for (let i = 0; i < c.n; i++) { z.resetMap(); state[KEY(i)] = new z.SharedMap('number').set('v', value(c, i, 0)); }
    return state;
  }
  if (c.kind === 'list-string') {
    z.resetSharedList();
    return { data: new z.SharedList('string').pushMany(Array.from({ length: c.n }, (_, i) => value(c, i, 0))) };
  }
  z.resetMap();
  const type = c.kind === 'number' ? 'number' : c.kind === 'map-string' ? 'string' : 'object';
  return { data: new z.SharedMap(type).setMany(Array.from({ length: c.n }, (_, i) => [KEY(i), value(c, i, 0)])) };
}
export function prepare(c, revision, oracleState) {
  const indexes = changed(c, revision);
  const entries = indexes.map(i => [KEY(i), value(c, i, revision)]);
  for (let j = 0; j < indexes.length; j++) {
    const i = indexes[j], contribution = add(0, c, entries[j][1], i);
    oracleState.checksum = (oracleState.checksum - oracleState.contributions[i] + contribution) >>> 0;
    oracleState.contributions[i] = contribution;
  }
  return { indexes, entries, checksum: oracleState.checksum };
}
export function update(c, state, prepared) {
  if (c.kind === 'many') {
    const key = prepared.entries[0][0];
    return { ...state, [key]: state[key].set('v', prepared.entries[0][1]) };
  }
  let data = state.data;
  if (c.kind === 'list-string') {
    for (let j = 0; j < prepared.indexes.length; j++) data = data.set(prepared.indexes[j], prepared.entries[j][1]);
  } else data = data.setMany(prepared.entries);
  return { data };
}
export function fixtureInfo(c, count) {
  const sizes = Array.from({ length: c.n }, (_, i) => {
    const v = value(c, i, 0);
    return typeof v === 'number' ? 8 : encoder.encode(typeof v === 'string' ? v : JSON.stringify(v)).length;
  });
  let records = c.n;
  for (let r = 1; r <= WARM + count; r++) records += changed(c, r).length;
  const encodedBytes = sizes.reduce((a, b) => a + b, 0);
  return { entriesPerFrame: c.n, initialEncodedBytes: encodedBytes, encodedValueBytesPerFrame: encodedBytes,
    minEncodedValueBytes: Math.min(...sizes), maxEncodedValueBytes: Math.max(...sizes),
    totalPublishedValueRecords: records,
    uniqueDecodedRecords: c.kind === 'number' || c.kind === 'many' ? 0 : records,
    warmRevisions: WARM, measuredRevisions: count, copy: c.copy === true, raw: c.raw === true,
    hotCount: c.all ? c.n : c.kind === 'many' ? 1 : Math.floor(c.n / 10),
    rotatingSizes: c.rotate ? [102, 103] : undefined };
}
export function assertKeyHashes() {
  const seen = new Set();
  for (let i = 0; i < 1024; i++) {
    let h = 2166136261;
    for (const ch of KEY(i)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    if (seen.has(h >>> 0)) throw new Error('Fixture full-key hash collision');
    seen.add(h >>> 0);
  }
  return seen.size;
}
