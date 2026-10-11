import { describe, it, expect } from 'vitest';
import { createJsonReadWorkload, jsonReadCases, jsonReadUsesBulkMap,
  compareJsonReadStorage, checkJsonReadStorage } from './proofs/json-read-workloads.mjs';
import { createUtf8WriteWorkload, utf8WriteCases, utf8WriteUsesBulkMap,
  compareUtf8WriteStorage, checkUtf8WriteStorage } from './proofs/utf8-write-workloads.mjs';

const readSpec = jsonReadCases.find(spec => spec.name === 'cold-map-flat');
const writeSpec = utf8WriteCases.find(spec => spec.name === 'map-json-setMany');
const updateSpec = utf8WriteCases.find(spec => spec.name === 'map-json-update');
const physical = { usedBytes: 70000, backingBytes: 131072, payloadSha256: 'bytes',
  descriptor: { root: 69900, valueType: 'object', size: 4 } };
const logical = { collection: 'SharedMap', valueType: 'object', size: 4,
  snapshotCount: 1, keyCount: 4, canonicalSha256: 'verified-values' };
const moved = { ...physical, usedBytes: 69984, payloadSha256: 'moved-bytes',
  descriptor: { ...physical.descriptor, root: 69884 } };

// These mocks exercise the proof oracles, without running a library build or timer.
function mockApi() {
  const faults = {}, memory = { buffer: new SharedArrayBuffer(131072) };
  function freeze(value) {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  }
  class SharedMap {
    constructor(type, values = new Map()) {
      this.type = type; this.values = values; this.size = values.size; Object.freeze(this);
    }
    setMany(entries) {
      return new SharedMap(this.type, new Map(entries.map(([key, value]) =>
        [key, freeze(JSON.parse(JSON.stringify(value)))])));
    }
    set(key, value) {
      const values = new Map(this.values);
      values.set(key, freeze(JSON.parse(JSON.stringify(value))));
      return new SharedMap(this.type, values);
    }
    get(key) {
      const value = this.values.get(key);
      return faults.value && value ? freeze({ ...value, id: -1 }) : value;
    }
    keys() {
      const keys = [...this.values.keys()];
      if (faults.keys && keys.length) keys[keys.length - 1] = keys[0];
      return keys.values();
    }
    toWorkerData() {
      return { root: this.size ? 65536 : 0, valueType: faults.type ?? this.type,
        size: faults.size ?? this.size, ...(faults.field ? { unexpected: 1 } : {}) };
    }
  }
  return { faults, memory, SharedMap, resetMap() {},
    getWorkerData(owners) { return { owners, arenas: [{ memory, used: 65544 }] }; },
    async initWorker(payload) { return payload.owners; } };
}

async function readFixture() {
  const api = mockApi(), work = createJsonReadWorkload(api, readSpec, 4);
  await work.setup(); return { api, work, checksum: work.run() };
}
function writeFixture(spec = writeSpec) {
  const api = mockApi(), work = createUtf8WriteWorkload(api, spec, 4);
  work.setup(); return { api, work, result: work.run() };
}

describe('allocation-aware proof storage guards', () => {
  it('permits physical differences only for bounded generic-map construction, including update seeds', () => {
    for (const count of [1, 12288]) {
      expect(jsonReadUsesBulkMap(readSpec, count)).toBe(true);
      expect(utf8WriteUsesBulkMap(writeSpec, count)).toBe(true);
      expect(utf8WriteUsesBulkMap(updateSpec, count)).toBe(true);
      compareJsonReadStorage(readSpec, count,
        { integrity: physical, logical }, { integrity: moved, logical });
      compareUtf8WriteStorage(writeSpec, count, { ...physical, logical }, { ...moved, logical });
      compareUtf8WriteStorage(updateSpec, count, { ...physical, logical }, { ...moved, logical });
    }
    for (const count of [0, 12289]) {
      expect(() => compareJsonReadStorage(readSpec, count,
        { integrity: physical, logical }, { integrity: moved, logical })).toThrow('storage differs');
      expect(() => compareUtf8WriteStorage(writeSpec, count,
        { ...physical, logical }, { ...moved, logical })).toThrow('storage differs');
    }
  });

  it('retains exact cross-arm physical checks on every unchanged fixture path', () => {
    for (const spec of jsonReadCases.filter(spec => !jsonReadUsesBulkMap(spec, 512))) {
      expect(() => compareJsonReadStorage(spec, 512,
        { integrity: physical }, { integrity: moved })).toThrow('storage differs');
    }
    for (const spec of utf8WriteCases.filter(spec => !utf8WriteUsesBulkMap(spec, 512))) {
      expect(() => compareUtf8WriteStorage(spec, 512, physical, moved)).toThrow('storage differs');
    }
  });

  it('rejects missing or mismatched verified logical evidence', () => {
    expect(() => compareJsonReadStorage(readSpec, 4,
      { integrity: physical }, { integrity: moved })).toThrow('Missing verified');
    expect(() => compareUtf8WriteStorage(writeSpec, 4, physical, moved)).toThrow('Missing verified');
    for (const [key, value] of [['canonicalSha256', 'wrong-values'], ['keyCount', 3],
      ['size', 3], ['valueType', 'string'], ['snapshotCount', 2]]) {
      const changed = { ...logical, [key]: value };
      expect(() => compareJsonReadStorage(readSpec, 4,
        { integrity: physical, logical }, { integrity: moved, logical: changed })).toThrow('logical map differs');
      expect(() => compareUtf8WriteStorage(writeSpec, 4,
        { ...physical, logical }, { ...moved, logical: changed })).toThrow('logical map differs');
    }
  });

  it('still rejects within-build payload, descriptor, length and backing changes', () => {
    for (const changed of [{ ...physical, payloadSha256: 'changed' },
      { ...physical, descriptor: { ...physical.descriptor, root: 65540 } },
      { ...physical, usedBytes: physical.usedBytes + 4 },
      { ...physical, backingBytes: physical.backingBytes + 65536 }]) {
      expect(() => checkJsonReadStorage(changed, physical)).toThrow('A read changed');
      expect(() => checkUtf8WriteStorage(changed, physical)).toThrow('storage changed between runs');
    }
    checkJsonReadStorage(structuredClone(physical), physical);
    checkUtf8WriteStorage(structuredClone(physical), physical);
  });

  it('records verified actual outputs and all retained write snapshots', async () => {
    const { work, checksum } = await readFixture();
    const checked = work.verify(checksum);
    expect(JSON.parse(checked.logical.canonical).map(([key, value]) => [key, value.id]))
      .toEqual([['record-0', 0], ['record-1', 1], ['record-2', 2], ['record-3', 3]]);
    for (const spec of [writeSpec, updateSpec]) {
      const { work, result } = writeFixture(spec), checked = work.verify(result);
      const snapshots = JSON.parse(checked.logical.canonical);
      expect(snapshots.map(row => row.role)).toEqual(['result', 'base', 'retained']);
      expect(snapshots[0].entries.map(([key, value]) => [key, value.id]))
        .toEqual([['key-0', 0], ['key-1', 1], ['key-2', 2], ['key-3', 3]]);
      expect(snapshots[1].size).toBe(spec.update ? 4 : 0);
      expect(snapshots[2].size).toBe(spec.update ? 4 : 0);
    }
  });

  for (const fault of ['keys', 'value', 'type', 'size', 'field']) {
    it(`rejects actual ${fault} corruption in both fixture oracles`, async () => {
      const read = await readFixture();
      read.api.faults[fault] = fault === 'type' ? 'string' : fault === 'size' ? 3 : true;
      expect(() => read.work.verify(read.checksum)).toThrow();
      for (const spec of [writeSpec, updateSpec]) {
        const write = writeFixture(spec);
        write.api.faults[fault] = fault === 'type' ? 'string' : fault === 'size' ? 3 : true;
        expect(() => write.work.verify(write.result)).toThrow();
      }
    });
  }
});
