import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const modes = ['native', 'missing-encodeInto', 'reject-shared-destination'];
if (process.argv[2] === '--child') {
  const [mode, entry] = process.argv.slice(3), NativeEncoder = TextEncoder;
  assert.ok(modes.includes(mode));
  const native = new NativeEncoder(), decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let encoded = 0, into = 0, ordinaryDestinations = 0;
  const capability = {};
  try {
    const destination = new Uint8Array(new SharedArrayBuffer(32));
    const result = native.encodeInto('界🙂\ud800', destination);
    assert.equal(result.read, 4); assert.equal(result.written, 10);
    assert.deepEqual(destination.slice(0, result.written), native.encode('界🙂\ud800'));
    Object.assign(capability, { sharedEncodeInto: true, ...result });
  } catch (error) { Object.assign(capability, { sharedEncodeInto: false, error: String(error) }); }
  class InstrumentedEncoder extends NativeEncoder {
    encode(text) { encoded++; return super.encode(text); }
    encodeInto(text, destination) {
      into++;
      if (destination.buffer instanceof SharedArrayBuffer && mode === 'reject-shared-destination') throw new TypeError('Shared destination rejected by compatibility fixture');
      if (destination.buffer instanceof ArrayBuffer) ordinaryDestinations++;
      return super.encodeInto(text, destination);
    }
  }
  class EncoderWithoutInto { encode(text) { encoded++; return native.encode(text); } }
  globalThis.TextEncoder = mode === 'missing-encodeInto' ? EncoderWithoutInto : InstrumentedEncoder;
  const api = await import(pathToFileURL(resolve(entry)).href);
  const cases = [
    ['short', '界🙂\ud800', true],
    ['eligible-limit', '界'.repeat(16381), true],
    ['eligible-pair', '界'.repeat(16379) + '🙂', true],
    ['eligible-lone', '界'.repeat(16380) + '\ud800', true],
    ['native-fitting', 'a'.repeat(16381) + '界', false],
    ['native-byte-limit', '界'.repeat(16381) + 'a', false],
    ['native-over-limit', '界'.repeat(16382), false],
    ['after-overflow', 'retryé🙂', true],
  ];
  const observations = [], storage = [];
  for (const [collection, reset] of [['SharedMap', 'resetMap'], ['SharedOrderedMap', 'resetOrderedMap'], ['SharedSortedMap', 'resetSortedMap']]) {
    api[reset](); let current = new api[collection]('number'); const expected = new Map();
    for (const [index, [name, key, reusable]] of cases.entries()) {
      encoded = 0; into = 0; ordinaryDestinations = 0;
      current = current.set(key, index + .5);
      const counts = { encoded, into, ordinaryDestinations };
      if (reusable && mode !== 'missing-encodeInto') {
        assert.equal(into, 1); assert.equal(ordinaryDestinations, 1); assert.equal(encoded, 0);
      } else { assert.equal(into, 0); assert.ok(encoded >= 1); }
      expected.set(decoder.decode(native.encode(key)), index + .5);
      observations.push({ collection, name, ...counts });
    }
    // Read only after every borrowed buffer has been reused several times.
    assert.equal(current.size, expected.size);
    assert.equal([...current.entries()].length, expected.size);
    for (const [key, value] of expected) assert.equal(current.get(key), value);
    const arena = api.getWorkerData({ current }, { copy: false }).arenas[0];
    storage.push({ collection, descriptor: current.toWorkerData(), used: arena.used,
      payloadSha256: sha(new Uint8Array(arena.memory.buffer, 65536, arena.used - 65536)) });
  }
  process.stdout.write(JSON.stringify({ status: 'complete', mode, runtime: process.versions.bun ? 'bun' : 'node', versions: process.versions, capability, observations, storage }));
} else {
  const [entry, output] = process.argv.slice(2);
  assert.ok(entry && output, 'Usage: node|bun compatibility.mjs BUILT_SHARED_ENTRY NEW_OUTPUT.json');
  assert.ok(!existsSync(output), 'Choose a new output');
  const result = { status: 'running', startedAt: new Date().toISOString(), processes: [] };
  const save = () => writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  save();
  try {
    for (const mode of modes) {
      const child = spawnSync(process.execPath, [import.meta.filename, '--child', mode, resolve(entry)], { encoding: 'utf8', timeout: 60000 });
      const record = { mode, status: child.status, stdout: child.stdout, stderr: child.stderr, error: child.error ? String(child.error) : undefined };
      result.processes.push(record); save();
      assert.equal(child.status, 0, child.stderr || child.stdout);
      record.result = JSON.parse(child.stdout); delete record.stdout; save();
    }
    for (const process of result.processes) assert.deepEqual(process.result.storage, result.processes[0].result.storage, 'Compatibility path changed full published layout');
    result.status = 'complete'; result.completedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ status: result.status, runtime: result.processes[0].result.runtime, freshProcesses: result.processes.length, capability: result.processes[0].result.capability }));
  } catch (error) { result.status = 'failed'; result.error = String(error?.stack ?? error); save(); throw error; }
}
