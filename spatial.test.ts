import { expect, it, vi } from 'vitest';
import { arenaOf } from './arena.ts';
import { buildLineStringIndex, buildLineStringLookup, getLineStringById, buildSpatialIndex, querySpatialIndex, querySpatialJoin, diffSpatialJoin, applySpatialEdits, prepareSpatialQuery, pruneSpatialEdits, rebuildSpatialIndex, type SpatialBoundsChange } from './spatial.ts';
import { lineStringViewXY, pathIntersectsBoxXY } from './geometry';
import { getWorkerData, initWorker, resetMap } from './shared.ts';

const box = [0, 0, 2, 2] as const;
const far = [10, 10, 12, 12] as const;

it('borrows arbitrary feature IDs across uneven packed batches, including null, empty and absent lanes', () => {
  const empty = { ids: [], paths: { offsets: Int32Array.of(0), coordinates: new Float64Array(), validity: null } };
  const first = { offsets: Int32Array.of(0, 1, 1, 1), coordinates: Float64Array.of(10, 20), validity: Uint8Array.of(5) };
  const last = { offsets: Int32Array.of(0, 1, 3), coordinates: Float64Array.of(1, 2, 3, 4, 5, 6), validity: null };
  const ids = Uint32Array.of(4294967295, 0, 255);
  const lookup = buildLineStringLookup([empty, { paths: first, ids }, empty, { paths: last, ids: [42, 1] }, empty]);
  ids.fill(9);
  expect([...lookup.ids]).toEqual([0, 1, 42, 255, 4294967295]);
  expect([...lookup.batchEnds]).toEqual([0, 3, 3, 5, 5]);
  const lane = getLineStringById(lookup, 1)!;
  expect([...lane]).toEqual([3, 4, 5, 6]);
  expect(lane.buffer).toBe(last.coordinates.buffer);
  expect([...getLineStringById(lookup, 4294967295)!]).toEqual([10, 20]);
  expect([...getLineStringById(lookup, 42)!]).toEqual([1, 2]);
  expect(getLineStringById(lookup, 0)).toBeNull();
  expect([...getLineStringById(lookup, 255)!]).toEqual([]);
  expect(getLineStringById(lookup, 254)).toBeUndefined();
  expect(getLineStringById(buildLineStringLookup([empty]), 0)).toBeUndefined();
  const sorted = buildLineStringLookup([{ paths: first, ids: [0, 15, 399] }]);
  expect(sorted.rows).toBeNull();
  expect(getLineStringById(sorted, 15)).toBeNull();
  expect(getLineStringById(sorted, 400)).toBeUndefined();
  expect([...getLineStringById(sorted, 399)!]).toEqual([]);
  for (const view of [lookup.ids, lookup.rows!, lookup.batchEnds]) expect(view.buffer).toBeInstanceOf(SharedArrayBuffer);
});

it('rejects duplicate or invalid handles before publishing a lookup, including handles on null rows', () => {
  const paths = { offsets: Int32Array.of(0, 0), coordinates: new Float64Array(), validity: Uint8Array.of(0) };
  for (const invalid of [-1, 1.5, NaN, Infinity, 2 ** 32]) {
    expect(() => buildLineStringLookup([{ paths, ids: [invalid] }])).toThrow(RangeError);
    expect(() => getLineStringById(buildLineStringLookup([]), invalid)).toThrow(RangeError);
  }
  for (const ids of [[7, 7], [7, 1, 7]]) {
    expect(() => buildLineStringLookup(ids.map(id => ({ paths, ids: [id] })))).toThrow(/Duplicate/);
  }
  expect(() => buildLineStringLookup([{ paths, ids: [] }])).toThrow(/one spatial feature ID/);
  expect(() => buildLineStringLookup([{ paths: { ...paths, offsets: Int32Array.of(0, 2) }, ids: [1] }])).toThrow(RangeError);
});

it('indexes packed batches by stable ID and refines candidates across finite path breaks', () => {
  const paths = { offsets: Int32Array.of(0, 3, 4, 4, 6, 7),
    coordinates: Float64Array.of(-5, 1, NaN, 200, 5, 1, 100, 100, 2, 2, 3, 2, Infinity, 1),
    validity: Uint8Array.of(0b11101) };
  const second = { offsets: Int32Array.of(0, 1), coordinates: Float64Array.of(0, 1), validity: null };
  const batches = [{ paths, ids: Uint32Array.of(31, 3, 2, 7, 5) }, { paths: second, ids: [0xffffffff] }];
  const base = structuredClone(buildLineStringIndex(batches, 17));
  const desired = buildSpatialIndex([{ id: 31, bounds: [-5, 1, 5, 1] }, { id: 7, bounds: [2, 2, 3, 2] },
    { id: 0xffffffff, bounds: [0, 1, 0, 1] }], 17);
  expect(base.revision).toBe(17);
  expect(base.buffer).toBeInstanceOf(SharedArrayBuffer);
  expect([...base.ids]).toEqual([...desired.ids]);
  for (let i = -7; i < 8; i++) {
    const viewport = [i, -10, i + 1, 201] as const;
    expect(querySpatialIndex(base, viewport)).toEqual(querySpatialIndex(desired, viewport));
  }
  const viewport = [0, 1, 0, 1] as const;
  expect(querySpatialIndex(base, viewport)).toEqual([31, 0xffffffff]);
  expect(pathIntersectsBoxXY(lineStringViewXY(paths, 0)!, viewport)).toBe(false);
  expect(querySpatialIndex(base, [99, 99, 101, 101])).toEqual([]);
  expect(querySpatialIndex(base, [0, 199, 0, 201])).toEqual([]);
  const edits = applySpatialEdits(undefined, 18, [{ id: 31, bounds: null }, { id: 3, bounds: viewport }]);
  expect(querySpatialIndex(rebuildSpatialIndex(base, edits, 18), viewport)).toEqual([3, 0xffffffff]);
  expect(querySpatialIndex(base, viewport)).toEqual([31, 0xffffffff]);
});

it('validates packed geometry and reserves unique handles for empty, missing and all-nonfinite lanes', () => {
  const paths = { offsets: Int32Array.of(0, 1, 1), coordinates: Float64Array.of(NaN, NaN), validity: Uint8Array.of(1) };
  const input = { paths, ids: [1, 2] };
  expect(buildLineStringIndex([]).buffer).toBeNull();
  expect(buildLineStringIndex([input]).buffer).toBeNull();
  for (const ids of [[1, 1], [1], [1, -1], [1, 2 ** 32]]) {
    expect(() => buildLineStringIndex([{ paths, ids }])).toThrow(RangeError);
  }
  expect(() => buildLineStringIndex([input, input])).toThrow(/Duplicate/);
  for (const offsets of [Int32Array.of(1, 1, 1), Int32Array.of(0, 2, 1), Int32Array.of(0, 1, 2)]) {
    expect(() => buildLineStringIndex([{ ...input, paths: { ...paths, offsets } }])).toThrow(RangeError);
  }
  expect(() => buildLineStringIndex([{ ...input, paths: { ...paths, validity: new Uint8Array() } }])).toThrow(RangeError);
  expect(() => buildLineStringIndex([{ ...input, paths: { ...paths, coordinates: new Float32Array(2) as never } }])).toThrow(TypeError);
  expect(() => buildLineStringIndex([input], 0.5)).toThrow(RangeError);
});

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
  let previous = { left: prepareSpatialQuery(left.base, left.changes, 0), right: prepareSpatialQuery(right.base, right.changes, 0) };
  for (let revision = 1; revision <= 64; revision++) {
    const bounds: Box = revision % 3 ? rect() : [-Infinity, -Infinity, Infinity, Infinity];
    const before = scan(left.rows, right.rows, bounds);
    function edit(layer: typeof left): SpatialBoundsChange {
      const id = random(70), bounds = random(5) ? rect() : null;
      const before = layer.rows.get(id) ?? null;
      layer.changes = applySpatialEdits(layer.changes, revision, [{ id, bounds }]);
      if (bounds) layer.rows.set(id, bounds); else layer.rows.delete(id);
      if (revision % 11 === 0) layer.base = rebuildSpatialIndex(layer.base, layer.changes, revision);
      return { id, before, after: bounds };
    }
    const changes = { bounds, left: [edit(left)], right: [edit(right)] };
    const a = prepareSpatialQuery(left.base, left.changes, revision);
    const b = prepareSpatialQuery(right.base, right.changes, revision);
    const after = scan(left.rows, right.rows, bounds);
    expect(querySpatialJoin(a, b, { bounds })).toEqual(after);
    const next = { left: a, right: b };
    const oldKeys = new Set(before.map(String)), newKeys = new Set(after.map(String));
    expect(diffSpatialJoin(previous, next, changes)).toEqual({
      added: after.filter(pair => !oldKeys.has(String(pair))), removed: before.filter(pair => !newKeys.has(String(pair))),
    });
    previous = next;
    expect(querySpatialJoin(b, a, { bounds })).toEqual(scan(right.rows, left.rows, bounds));
    expect(querySpatialJoin(a, a, { bounds })).toEqual(scan(left.rows, left.rows, bounds));
  }
});

it('refines only pairs incident to an edit and compares retained geometry even with unchanged bounds', () => {
  const features = Array.from({ length: 4096 }, (_, id) => ({ id, bounds: [id, 0, id, 0] as const }));
  const index = buildSpatialIndex(features);
  const frame = { left: index, right: index };
  const edit = { id: 12, before: features[12].bounds, after: features[12].bounds };
  let candidates = 0;
  const oldFrame = { ...frame, filter: () => { candidates++; return true; } };
  const newFrame = { ...frame, filter: (a: number) => { candidates++; return a !== 12; } };
  expect(querySpatialJoin(index, index, newFrame)).toHaveLength(4095);
  expect(candidates).toBe(4096);
  candidates = 0;
  expect(diffSpatialJoin(oldFrame, newFrame, { left: [edit], right: [edit] })).toEqual({ added: [], removed: [[12, 12]] });
  expect(candidates).toBe(2);
  const inserted = { id: 77, before: null, after: box }, deleted = { id: 77, before: box, after: null };
  expect(diffSpatialJoin(frame, frame, { left: [inserted, deleted] })).toEqual({ added: [], removed: [] });
  expect(diffSpatialJoin(oldFrame, newFrame, { left: [edit], bounds: far })).toEqual({ added: [], removed: [] });
  expect(() => diffSpatialJoin(frame, frame, { right: [{ ...edit, before: [NaN, 0, 0, 0] }] })).toThrow(RangeError);
  expect(() => diffSpatialJoin(frame, frame, { left: [{ ...edit, id: -1 }] })).toThrow(RangeError);
  expect(() => diffSpatialJoin(frame, { ...frame, filter: (() => 1) as never }, { left: [edit] })).toThrow(TypeError);
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

it('installs a captured rebuild while retaining later moves, reinsertions and tombstones', async () => {
  const base = buildSpatialIndex([{ id: 1, bounds: box }, { id: 2, bounds: far }]);
  const captured = applySpatialEdits(undefined, 10, Array.from({ length: 512 }, (_, id) => ({
    id, bounds: id % 2 ? far : null,
  })));
  const rebuilt = rebuildSpatialIndex(base, captured, 10);
  const moved = applySpatialEdits(captured, 11, [{ id: 1, bounds: box }, { id: 2, bounds: box }]);
  const live = applySpatialEdits(moved, 12, [{ id: 1, bounds: null }, { id: 0xffffffff, bounds: far }]);
  const arena = arenaOf(live), reads = vi.spyOn(arena, 'leafValue');
  let pruned: typeof live;
  try {
    pruned = pruneSpatialEdits(live, 10, captured);
    expect(reads.mock.calls.length).toBeLessThan(32);
  } finally { reads.mockRestore(); }
  expect(pruned.size).toBe(3);
  expect(pruned.get('1')).toEqual({ revision: 12, bounds: null });
  expect(pruned.get('2')).toEqual({ revision: 11, bounds: box });
  expect(pruned.get('4294967295')).toEqual({ revision: 12, bounds: far });
  for (const key of pruned.keys()) expect(arena.find(pruned.root, key)).toBe(arena.find(live.root, key));
  for (const viewport of [box, far]) {
    expect(querySpatialIndex(rebuilt, viewport, pruned)).toEqual(querySpatialIndex(base, viewport, live));
  }
  const used = () => getWorkerData({ live }, { copy: false }).arenas[0].used;
  const before = used();
  expect(pruneSpatialEdits(captured, 10, captured).size).toBe(0);
  expect(used()).toBe(before);
  expect(pruneSpatialEdits(pruned, 10, captured)).toBe(pruned);
  expect(captured.size).toBe(512);
  expect(captured.get('1')?.bounds).toEqual(far);
  const wire = getWorkerData({ pruned, captured }, { copy: false });
  expect(wire.arenas).toHaveLength(1);
  const reader = await initWorker(wire);
  expect(reader.pruned.get('1')).toEqual(pruned.get('1'));
  expect(pruneSpatialEdits(reader.pruned, 10, reader.captured)).toBe(reader.pruned);
  expect(() => pruneSpatialEdits(reader.pruned, 11, reader.captured)).toThrow(/read-only/);
});

it('keeps newer collision-bucket leaves and handles a stale minimum after overwrite', () => {
  // The decimal keys of these two feature IDs have the same 32-bit FNV-1a hash.
  const left = 2624876701, right = 4111686543;
  const first = applySpatialEdits(undefined, 5, [{ id: left, bounds: box }, { id: right, bounds: far }]);
  const second = applySpatialEdits(first, 6, [{ id: left, bounds: null }]);
  const pruned = pruneSpatialEdits(second, 5, first);
  expect([...pruned.entries()]).toEqual([[String(left), { revision: 6, bounds: null }]]);
  const third = applySpatialEdits(second, 7, [{ id: right, bounds: box }]);
  expect(pruneSpatialEdits(third, 5, first)).toBe(third);
});

it('treats an unrelated, future, untracked or foreign rebuild capture only as a hint', () => {
  const captured = applySpatialEdits(undefined, 5, [{ id: 7, bounds: box }, { id: 99, bounds: far }]);
  const branch = applySpatialEdits(captured, 8, [{ id: 1, bounds: far }]);
  const future = applySpatialEdits(captured, 15, [{ id: 7, bounds: null }, { id: 8, bounds: far }]);
  // Historical batches on distinct IDs need not be applied in revision order.
  const current = applySpatialEdits(future, 9, [{ id: 99, bounds: box }]);
  const untracked = current.set('44', { revision: 20, bounds: null });
  resetMap();
  const foreign = applySpatialEdits(undefined, 5, [{ id: 7, bounds: far }]);
  for (const hint of [undefined, branch, future, untracked, foreign]) {
    const actual = pruneSpatialEdits(untracked, 10, hint);
    expect([...actual.keys()].sort()).toEqual(['44', '7', '8']);
    expect(actual.get('7')).toEqual({ revision: 15, bounds: null });
  }
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
  let captured = changes, replacement = base;
  for (let r = 1; r <= 300; r++) {
    const id = random(250), bounds = r % 7 ? rect() : null;
    if (bounds) rows.set(id, bounds); else rows.delete(id);
    changes = applySpatialEdits(changes, r, [{ id, bounds }]);
    if (r % 43 === 35) { captured = changes; replacement = rebuildSpatialIndex(base, captured, r); }
    if (r % 43 === 0) {
      base = replacement;
      changes = pruneSpatialEdits(changes, base.revision, captured);
    }
    const box = rect();
    const expected = [...rows].filter(([, b]) => Math.max(b[0], box[0]) <= Math.min(b[2], box[2]) &&
      Math.max(b[1], box[1]) <= Math.min(b[3], box[3])).map(([id]) => id).sort((a,b) => a-b);
    expect(querySpatialIndex(base, box, changes)).toEqual(expected);
    expect(querySpatialIndex(prepareSpatialQuery(base, changes, r), box)).toEqual(expected);
  }
});
