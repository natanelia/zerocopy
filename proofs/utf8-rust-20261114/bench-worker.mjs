import { parseUtf8JSON as original } from '../shared-bytes-20261113/direct-json.mjs';
import { parseUtf8JSON as guarded } from './direct-json-guarded.mjs';
import { decodeUtf8 } from '../shared-bytes-20261113/.runtime/utf8.mjs';
import { freezeJSON } from '../shared-bytes-20261113/.runtime/freeze-json.mjs';
import { fingerprint } from '../shared-bytes-20261113/fixtures.mjs';
import { parentPort } from 'node:worker_threads';

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const native = view => freezeJSON(JSON.parse(decodeUtf8(decoder, view)));
const parsers = { 'native-a': native, 'native-b': native, original, guarded };

function verifyFrozen(value) {
  const todo = [value];
  while (todo.length) {
    const item = todo.pop();
    if (item === null || typeof item !== 'object') continue;
    if (!Object.isFrozen(item)) throw Error('A decoded container is not frozen');
    for (const child of Object.values(item)) if (child !== null && typeof child === 'object') todo.push(child);
  }
}

parentPort.on('message', ({ fixture, method }) => {
  try {
    const bytes = new Uint8Array(fixture.buffer), parse = parsers[method];
    if (!parse) throw Error(`Unknown parser: ${method}`);
    const start = performance.now();
    const outputs = new Array(fixture.count);
    for (let i = 0; i < fixture.count; i++) outputs[i] = parse(bytes.subarray(fixture.offsets[i], fixture.offsets[i + 1]));
    const ms = performance.now() - start;
    // Retain and check every output after timing. No parser warmup or output cache.
    let hash = 2166136261;
    for (const value of outputs) {
      hash = fingerprint(JSON.stringify(value) + '\n', hash);
      verifyFrozen(value);
    }
    if (hash !== fixture.expectedHash) throw Error(`Content mismatch: ${hash} != ${fixture.expectedHash}`);
    parentPort.postMessage({ result: { ms, count: outputs.length, bytes: bytes.length, hash, verified: true } });
  } catch (error) {
    parentPort.postMessage({ error: error.stack });
  }
});
parentPort.postMessage({ ready: true });

