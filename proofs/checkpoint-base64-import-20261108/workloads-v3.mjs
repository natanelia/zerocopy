import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const study = {
  id: 'checkpoint-base64-import-v3-20261108',
  baseline: '0ca99c1da67e4d3e36e098b3f0e85d392c9c1d5e',
  changedSources: ['redux-checkpoint.ts'],
  pilotCases: ['decode-text-512k', 'deserialize-text-512k', 'small-snapshot', 'plain-state-control', 'portable-decode-text-512k'],
  aaCases: ['decode-text-512k', 'plain-state-control', 'portable-decode-text-512k'],
  cases: [
    { name: 'decode-text-512k', role: 'byte-decoder target', fixture: 'text', count: 128, width: 4096, repetitions: 4 },
    { name: 'deserialize-text-512k', role: 'byte-decoder target', fixture: 'text', count: 128, width: 4096, deserialize: true, repetitions: 4 },
    { name: 'decode-text-2m', role: 'byte-decoder target', fixture: 'text', count: 128, width: 16384, repetitions: 2 },
    { name: 'small-snapshot', role: 'boundary', fixture: 'text', count: 1, width: 8, repetitions: 32 },
    { name: 'plain-state-control', role: 'no-arena control', fixture: 'plain', count: 64, repetitions: 128 },
    { name: 'portable-decode-text-512k', role: 'forced-portable control', fixture: 'text', count: 128, width: 4096, portable: true, repetitions: 4 },
  ],
};

function freezeCheck(value) {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const key of Object.keys(value)) freezeCheck(value[key]);
}

export async function createWorkload(directory, spec) {
  const nativeDescriptor = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
  const bufferDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
  if (spec.portable) {
    Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, writable: true, value: undefined });
    Object.defineProperty(globalThis, 'Buffer', { configurable: true, writable: true, value: undefined });
  }
  let S, R;
  try {
    S = await import(pathToFileURL(join(directory, 'dist/shared.js')));
    R = await import(pathToFileURL(join(directory, 'dist/redux.js')));
  } finally {
    if (spec.portable) {
      if (nativeDescriptor) Object.defineProperty(Uint8Array, 'fromBase64', nativeDescriptor); else delete Uint8Array.fromBase64;
      if (bufferDescriptor) Object.defineProperty(globalThis, 'Buffer', bufferDescriptor); else delete globalThis.Buffer;
    }
  }
  let expected, source, state;
  if (spec.fixture === 'plain') {
    expected = Array.from({ length: spec.count }, (_, i) => ({ id: `row-${i}`, position: [i / 4, -i / 8], ready: i % 2 === 0 }));
    state = expected;
  } else {
    // Distinct, exactly sized ASCII values prevent string interning from
    // reducing the arena to a single repeated blob. All output bytes are read.
    expected = Array.from({ length: spec.count }, (_, i) => (`text-${String(i).padStart(4, '0')}:` + '0123456789abcdefghijklmnopqrstuvwxyz'.repeat(Math.ceil(spec.width / 36))).slice(0, spec.width));
    source = new S.SharedList('string').pushMany(expected);
    state = { source, again: source, ui: { selected: 17, label: '街道 / 🙂' } };
  }
  const packet = R.encodeZerocopyState(state), text = JSON.stringify(packet);
  const original = source ? S.getWorkerData({ source }, { copy: false }) : null;
  const sourceRecords = original?.arenas.map(arena => ({
    id: arena.id, used: arena.used, memory: arena.memory,
    bytes: new Uint8Array(arena.memory.buffer, 0, arena.used).slice(),
  })) ?? [];
  const sourceArenaIds = new Set(sourceRecords.map(arena => arena.id));
  const expectedDigest = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
  return {
    operation: spec.deserialize ? () => R.deserializeZerocopyState(text) : () => R.decodeZerocopyState(packet),
    verify(result) {
      if (spec.fixture === 'plain') { assert.deepEqual(result, expected); freezeCheck(result); return; }
      assert.deepEqual(Object.keys(result), ['source', 'again', 'ui']);
      assert.ok(Object.isFrozen(result)); assert.strictEqual(result.source, result.again);
      assert.deepEqual(result.ui, { selected: 17, label: '街道 / 🙂' }); freezeCheck(result.ui);
      assert.ok(result.source instanceof S.SharedList); assert.ok(Object.isFrozen(result.source));
      assert.equal(result.source.size, expected.length); assert.equal(result.source.toWorkerData().type, 'string');
      assert.deepEqual(result.source.toArray(), expected);
      const arenas = S.getWorkerData({ restored: result.source }, { copy: false }).arenas;
      assert.equal(arenas.length, 1); assert.ok(!sourceArenaIds.has(arenas[0].id));
    },
    checkInvariant() {
      assert.equal(JSON.stringify(packet), text);
      if (!source) return;
      assert.deepEqual(source.toArray(), expected);
      const current = S.getWorkerData({ source }, { copy: false }).arenas;
      assert.equal(current.length, sourceRecords.length);
      for (let i = 0; i < current.length; i++) {
        assert.equal(current[i].id, sourceRecords[i].id); assert.equal(current[i].used, sourceRecords[i].used);
        assert.equal(current[i].memory, sourceRecords[i].memory);
        assert.deepEqual(new Uint8Array(current[i].memory.buffer, 0, sourceRecords[i].used), sourceRecords[i].bytes);
      }
    },
    expectedDigest,
    fixture: {
      kind: spec.fixture, count: spec.count, width: spec.width ?? null,
      operation: spec.deserialize ? 'deserializeZerocopyState' : 'decodeZerocopyState',
      nativeFromBase64: !spec.portable && typeof Uint8Array.fromBase64 === 'function',
      bufferFromBase64: !spec.portable && typeof globalThis.Buffer?.from === 'function',
      forcedPortable: !!spec.portable,
      arenaBytes: packet.arenas.map(arena => arena.used),
    },
  };
}
