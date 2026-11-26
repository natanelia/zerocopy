import { expect, it } from 'vitest';
import { buildSpatialIndex, querySpatialIndex, querySpatialJoin, applySpatialEdits, prepareSpatialQuery, pruneSpatialEdits, rebuildSpatialIndex } from './spatial.ts';
import { getWorkerData, initWorker } from './shared.ts';

const box = [0, 0, 2, 2] as const;
const far = [10, 10, 12, 12] as const;

it('joins ordered pairs after edits on both layers, with inclusive bounds and exact filtering', () => {
  const leftBase = buildSpatialIndex([{ id: 9, bounds: far }, { id: 2, bounds: box }]);
  const rightBase = buildSpatialIndex([{ id: 2, bounds: far }, { id: 11, bounds: box }]);
  const left = prepareSpatialQuery(leftBase, applySpatialEdits(undefined, 1, [
    { id: 9, bounds: box }, { id: 2, bounds: null }, { id: 0xffffffff, bounds: far },
  ]), 1);
  const right = prepareSpatialQuery(rightBase, applySpatialEdits(undefined, 3, [
    { id: 2, bounds: [2, 2, 12, 12] }, { id: 11, bounds: null }, { id: 9, bounds: box },
  ]), 3);
  expect(querySpatialJoin(structuredClone(left), structuredClone(right))).toEqual([[9, 2], [9, 9], [0xffffffff, 2]]);
  const calls: string[] = [];
  expect(querySpatialJoin(left, right, { bounds: [2, 2, 2, 2], filter(a, b) {
    calls.push(a + ':' + b);
    return a !== b;
  } })).toEqual([[9, 2]]);
  expect(calls.sort()).toEqual(['9:2', '9:9']);
  expect(querySpatialJoin(leftBase, rightBase)).toEqual([[2, 11], [9, 2]]);
  expect(querySpatialJoin(rightBase, left)).toEqual([[2, 0xffffffff], [11, 9]]);
  expect(querySpatialJoin(left, buildSpatialIndex([]))).toEqual([]);
  expect(() => querySpatialJoin(left, right, { bounds: [0, 1, 0, 0] })).toThrow(RangeError);
  expect(() => querySpatialJoin(left, right, { filter() { throw new Error('refinement failed'); } })).toThrow('refinement failed');
  expect(() => querySpatialJoin(left, right, { filter: (async () => true) as never })).toThrow(TypeError);
});

it('matches an all-pairs scan for both input orders and self joins across successive publications', () => {
  type Box = readonly [number, number, number, number];
  let seed = 673;
  const random = (n: number) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
  const rect = (): Box => { const x = random(61), y = random(67); return [x, y, x + random(14), y + random(14)]; };
  function layer(count: number) {
    const rows = new Map(Array.from({ length: count }, (_, id) => [id, rect()] as const));
    const base = buildSpatialIndex(Array.from(rows, ([id, bounds]) => ({ id, bounds })));
    return { rows, base, changes: applySpatialEdits(undefined, 0, []) };
  }
  function scan(left: Map<number, Box>, right: Map<number, Box>, q: Box) {
    const pairs: number[][] = [];
    for (const [a, l] of left) for (const [b, r] of right) {
      if (Math.max(l[0], r[0], q[0]) <= Math.min(l[2], r[2], q[2]) &&
          Math.max(l[1], r[1], q[1]) <= Math.min(l[3], r[3], q[3])) pairs.push([a, b]);
    }
    return pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  const left = layer(55), right = layer(30);
  for (let revision = 1; revision <= 64; revision++) {
    for (const layer of [left, right]) {
      const id = random(70), bounds = random(5) ? rect() : null;
      layer.changes = applySpatialEdits(layer.changes, revision, [{ id, bounds }]);
      if (bounds) layer.rows.set(id, bounds); else layer.rows.delete(id);
      if (revision % 11 === 0) layer.base = rebuildSpatialIndex(layer.base, layer.changes, revision);
    }
    const a = prepareSpatialQuery(left.base, left.changes, revision);
    const b = prepareSpatialQuery(right.base, right.changes, revision);
    const bounds: Box = revision % 3 ? rect() : [-Infinity, -Infinity, Infinity, Infinity];
    expect(querySpatialJoin(a, b, { bounds })).toEqual(scan(left.rows, right.rows, bounds));
    expect(querySpatialJoin(b, a, { bounds })).toEqual(scan(right.rows, left.rows, bounds));
    expect(querySpatialJoin(a, a, { bounds })).toEqual(scan(left.rows, left.rows, bounds));
  }
});

it('queries historical and rebuilt snapshots by stable ID, including boundary touches', async () => {
  const base = buildSpatialIndex([{ id: 42, bounds: box }, { id: 0xffffffff, bounds: far }], 4);
  const moved = applySpatialEdits(undefined, 5, [
    { id: 42, bounds: far }, { id: 0xffffffff, bounds: box }, { id: 0, bounds: [2, 2, 2, 2] },
  ]);
  const deleted = applySpatialEdits(moved, 6, [{ id: 0xffffffff, bounds: null }]);
  expect(querySpatialIndex(base, box)).toEqual([42]);
  expect(querySpatialIndex(base, box, moved)).toEqual([0, 0xffffffff]);
  expect(querySpatialIndex(base, box, deleted)).toEqual([0]);
  const replacement = buildSpatialIndex([
    { id: 0, bounds: [2, 2, 2, 2] }, { id: 0xffffffff, bounds: box }, { id: 42, bounds: far },
  ], 5);
  expect(querySpatialIndex(replacement, box, deleted)).toEqual([0]);
  const pruned = pruneSpatialEdits(deleted, 5);
  expect(pruned.size).toBe(1);
  expect(deleted.size).toBe(3);
  const wire = structuredClone({ base: replacement, roots: getWorkerData({ changes: pruned }, { copy: false }) });
  const { changes } = await initWorker<{ changes: typeof pruned }>(wire.roots);
  expect(querySpatialIndex(wire.base, [-Infinity, -Infinity, Infinity, Infinity], changes)).toEqual([0, 42]);
  const compacted = rebuildSpatialIndex(wire.base, changes, 6);
  expect(querySpatialIndex(compacted, box)).toEqual([0]);
  expect(querySpatialIndex(wire.base, box)).toEqual([0, 0xffffffff]);
  expect(querySpatialIndex(base, box, moved)).toEqual([0, 0xffffffff]);
});

it('rebuilds an empty or fully deleted tile and reuses packed buffers for absorbed edits', () => {
  const base = buildSpatialIndex([]);
  const add = applySpatialEdits(undefined, 2, [{ id: 0xffffffff, bounds: box }]);
  expect(() => rebuildSpatialIndex(base, add, 1)).toThrow(/newer/);
  const added = rebuildSpatialIndex(base, add, 2);
  expect(querySpatialIndex(added, box)).toEqual([0xffffffff]);
  expect(rebuildSpatialIndex(added, add, 2)).toBe(added);
  const later = rebuildSpatialIndex(added, add, 3);
  expect(later.revision).toBe(3);
  expect(later.buffer).toBe(added.buffer);
  expect(later.ids).toBe(added.ids);
  expect(() => rebuildSpatialIndex(later, add, 2)).toThrow(/before/);
  const gone = applySpatialEdits(add, 4, [{ id: 0xffffffff, bounds: null }, { id: 123, bounds: null }]);
  const removed = rebuildSpatialIndex(later, gone, 4);
  expect(removed.buffer).toBeNull();
  expect(querySpatialIndex(removed, box)).toEqual([]);
  expect(querySpatialIndex(added, box)).toEqual([0xffffffff]);
});

it('handles an empty base, empty overlay, repeated edits, and conflicting retries', () => {
  const empty = buildSpatialIndex([]);
  expect(querySpatialIndex(structuredClone(empty), box)).toEqual([]);
  const edits = [{ id: 1, bounds: far }, { id: 1, bounds: box }];
  const add = applySpatialEdits(undefined, 1, edits);
  expect(querySpatialIndex(empty, box, add)).toEqual([1]);
  expect(applySpatialEdits(add, 1, edits)).toBe(add);
  expect(pruneSpatialEdits(add, 0)).toBe(add);
  expect(() => applySpatialEdits(add, 0, [{ id: 1, bounds: box }])).toThrow(RangeError);
  expect(() => applySpatialEdits(add, 1, [{ id: 1, bounds: null }])).toThrow(RangeError);
});

it('prepares moved, inserted and deleted bounds once per captured revision', () => {
  const base = buildSpatialIndex([{ id: 0, bounds: box }, { id: 7, bounds: far }, { id: 0xffffffff, bounds: box }], 2);
  const absorbed = applySpatialEdits(undefined, 2, [{ id: 7, bounds: null }]);
  const changes = applySpatialEdits(absorbed, 3, [
    { id: 0, bounds: far }, { id: 0xffffffff, bounds: null }, { id: 21, bounds: box },
  ]);
  const view = prepareSpatialQuery(base, changes, 3);
  expect(view.base).toBe(base);
  expect(view.revision).toBe(3);
  expect([...view.changedIds]).toEqual([0, 21, 0xffffffff]);
  expect(view.changedIds.buffer).toBeInstanceOf(SharedArrayBuffer);
  expect(view.updates.buffer).toBeInstanceOf(SharedArrayBuffer);
  const clone = structuredClone(view);
  expect(querySpatialIndex(clone, box)).toEqual([21]);
  expect(querySpatialIndex(clone, far)).toEqual([0, 7]);
  expect(querySpatialIndex(clone, [-Infinity, -Infinity, Infinity, Infinity])).toEqual([0, 7, 21]);
  const deleted = applySpatialEdits(changes, 4, [{ id: 21, bounds: null }, { id: 0, bounds: null }]);
  expect(querySpatialIndex(prepareSpatialQuery(base, deleted, 4), box)).toEqual([]);
  expect(querySpatialIndex(view, box)).toEqual([21]);
  expect(() => prepareSpatialQuery(base, deleted, 3)).toThrow(/newer/);
  expect(() => prepareSpatialQuery(base, absorbed, 1)).toThrow(/before/);
  expect(querySpatialIndex(prepareSpatialQuery(buildSpatialIndex([]), absorbed, 2), far)).toEqual([]);
});

it('rejects duplicate IDs, invalid revisions and invalid boxes before publishing', () => {
  const feature = { id: 3, bounds: box };
  expect(() => buildSpatialIndex([feature, feature])).toThrow(/Duplicate/);
  expect(() => buildSpatialIndex([], 0.1)).toThrow(RangeError);
  for (const id of [NaN, -1, 1.5, 0x100000000]) expect(() => buildSpatialIndex([{ ...feature, id }])).toThrow();
  const add = applySpatialEdits(undefined, 1, [feature]);
  for (const bounds of [[0, 2, 0, 1], [0, 0, NaN, 2], [0, 0, Infinity, 2]] as const) {
    expect(() => applySpatialEdits(add, 2, [{ id: 3, bounds: null }, { id: 4, bounds }])).toThrow();
    expect(() => buildSpatialIndex([{ id: 3, bounds }])).toThrow();
  }
  expect(querySpatialIndex(buildSpatialIndex([]), box, add)).toEqual([3]);
});

it('agrees with a scan across sparse edits, retained snapshots and repeated index rebuilds', () => {
  type Box = readonly [number, number, number, number];
  let seed = 73;
  const random = (n: number) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n);
  const rect = (): Box => { const x = random(101), y = random(103); return [x, y, x + random(21), y + random(23)]; };
  const rows = new Map<number, Box>();
  for (let id = 0; id < 200; id++) rows.set(id, rect());
  const build = (r: number) => buildSpatialIndex(Array.from(rows, ([id, bounds]) => ({ id, bounds })), r);
  let base = build(0), changes = applySpatialEdits(undefined, 0, []);
  for (let r = 1; r <= 300; r++) {
    const id = random(250), bounds = r % 7 ? rect() : null;
    if (bounds) rows.set(id, bounds); else rows.delete(id);
    changes = applySpatialEdits(changes, r, [{ id, bounds }]);
    if (r % 43 === 0) { base = rebuildSpatialIndex(base, changes, r); changes = pruneSpatialEdits(changes, r); }
    const box = rect();
    const expected = [...rows].filter(([, b]) => Math.max(b[0], box[0]) <= Math.min(b[2], box[2]) &&
      Math.max(b[1], box[1]) <= Math.min(b[3], box[3])).map(([id]) => id).sort((a,b) => a-b);
    expect(querySpatialIndex(base, box, changes)).toEqual(expected);
    expect(querySpatialIndex(prepareSpatialQuery(base, changes, r), box)).toEqual(expected);
  }
});
