/** Bind the actual compiled portable module before the unchanged historical subject runs. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { subject } from './noop-sequence-case.mjs';
import { sha256, CORE_HASHES } from './vector-reservation-source.mjs';
export async function importVerified(entry, expected) {
  assert(Object.values(CORE_HASHES).includes(expected), 'Unreviewed expected WASM hash');
  const actualCompiledWasm = [], OriginalModule = WebAssembly.Module;
  try {
    WebAssembly.Module = new Proxy(OriginalModule, { construct(target, args) {
      actualCompiledWasm.push(sha256(Buffer.from(args[0])));
      return Reflect.construct(target, args);
    } });
    await import(pathToFileURL(resolve(entry)).href);
  } finally { WebAssembly.Module = OriginalModule; }
  assert.deepEqual(actualCompiledWasm, [expected], 'Actual portable import compiled stale or unexpected core WASM');
  return actualCompiledWasm;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = JSON.parse(process.argv[2]);
  const actualCompiledWasm = await importVerified(config.module, config.expectedWasm);
  const result = await subject(config);
  console.log(JSON.stringify({ ...result, actualCompiledWasm }));
}
