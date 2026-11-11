import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

if (process.argv[2] === '--subject') {
  const mode = process.argv[3], native = Uint8Array.prototype.toBase64;
  let calls = 0;
  if (mode === 'fallback') Object.defineProperty(Uint8Array.prototype, 'toBase64', { value: undefined, configurable: true });
  else if (typeof native === 'function') Object.defineProperty(Uint8Array.prototype, 'toBase64', {
    configurable: true,
    value() {
      calls++;
      const result = native.call(this);
      assert.equal(result, Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString('base64'));
      return result;
    },
  });
  const { SharedList, SharedMap, resetSharedList, getWorkerData, initWorker } = await import('../../dist/shared.js');
  const { encodeZerocopyState, decodeZerocopyState, serializeZerocopyState, deserializeZerocopyState } = await import('../../dist/redux.js');
  const callsBeforePlain = calls;
  assert.deepEqual(decodeZerocopyState(encodeZerocopyState({ plain: [1, '界🙂', null] })), { plain: [1, '界🙂', null] });
  assert.equal(calls, callsBeforePlain);
  let arenas = 0;
  const sizes = [0, 1, 2, 3, 31, 32, 33, 1023, 1024, 1025, 4096];
  for (const size of sizes) {
    resetSharedList();
    const expected = Array.from({ length: size }, (_, i) => [NaN, -0, Infinity, -Infinity, i / 256][i % 5]);
    const original = new SharedList('number').pushMany(expected);
    const packet = encodeZerocopyState({ original, alias: original });
    arenas += packet.arenas.length;
    for (const arena of packet.arenas) {
      const bytes = Buffer.from(arena.base64, 'base64');
      assert.equal(bytes.byteLength, arena.used);
      assert.equal(bytes.toString('base64'), arena.base64);
    }
    const restored = decodeZerocopyState(packet);
    assert.equal(restored.original, restored.alias);
    assert.deepEqual(restored.original.toArray(), expected);
    assert.deepEqual(original.toArray(), expected);
    assert.equal(Object.isFrozen(packet), true);
    assert.equal(Object.isFrozen(restored.original), true);
    const changed = restored.original.push(999);
    assert.equal(changed.size, size + 1);
    assert.deepEqual(restored.original.toArray(), expected);
  }
  const strings = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i) + `\uFEFF界🙂:${i}`);
  const child = new SharedList('string').pushMany(strings);
  const map = new SharedMap('SharedList<string>').set('__proto__', child).set('constructor', child);
  const packet = encodeZerocopyState({ map });
  const restored = decodeZerocopyState(packet);
  assert.deepEqual(restored.map.get('__proto__').toArray(), strings);
  assert.deepEqual(restored.map.get('constructor').toArray(), strings);
  assert.deepEqual(deserializeZerocopyState(serializeZerocopyState(child)).toArray(), strings);
  for (const copy of [true, false]) {
    const attached = await initWorker(getWorkerData({ restored: restored.map }, { copy }));
    assert.deepEqual(attached.restored.get('__proto__').toArray(), strings);
    assert.throws(() => attached.restored.set('new', child), /read-only/);
  }
  for (const mutate of [
    p => { p.arenas[0].base64 = '!!!!'; },
    p => { p.arenas[0].base64 += 'AAAA'; },
    p => { p.arenas[0].checksum ^= 1; },
    p => { p.arenas[0].used++; },
  ]) {
    const invalid = structuredClone(packet); mutate(invalid);
    assert.throws(() => decodeZerocopyState(invalid));
  }
  if (mode !== 'fallback' && typeof native === 'function') assert.ok(calls >= arenas);
  else assert.equal(calls, 0);
  process.stdout.write(JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', mode, nativeAvailable: typeof native === 'function', nativeCalls: calls, boundarySizes: sizes, passed: true }));
} else {
  const script = fileURLToPath(import.meta.url), bun = process.env.BUN ?? 'bun';
  for (const [name, runtime, mode] of [
    ['Node runtime path', process.execPath, 'auto'],
    ['Bun native runtime path', bun, 'auto'],
    ['Bun forced portable fallback', bun, 'fallback'],
  ]) test(name, () => {
    const result = JSON.parse(execFileSync(runtime, [script, '--subject', mode], { encoding: 'utf8', timeout: 60000 }));
    assert.equal(result.passed, true);
    console.log(JSON.stringify(result));
  });
}
