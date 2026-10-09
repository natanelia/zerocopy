import { loadTextWasm } from './text-wasm';
import type { Arena } from './arena';

type TextKernel = Pick<Arena['wasm'], 'textContains16' | 'textContainsBlock16'>;
let compiled: WebAssembly.Module | false | undefined;
let instances: WeakMap<WebAssembly.Memory, TextKernel> | undefined;

/** Experimental optional reader. No probe, byte decoding, cache, or instance until use. */
export function textKernelFor(memory: WebAssembly.Memory): TextKernel | undefined {
  if (compiled === false) return undefined;
  const cached = instances?.get(memory);
  if (cached) return cached;
  if (compiled === undefined) {
    const probe = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,9,1,7,0,65,0,253,15,26,11]);
    if (!WebAssembly.validate(probe)) { compiled = false; return undefined; }
    compiled = new WebAssembly.Module(loadTextWasm() as BufferSource);
  }
  const kernel = new WebAssembly.Instance(compiled, { env: { memory } }).exports as unknown as TextKernel;
  (instances ??= new WeakMap()).set(memory, kernel);
  return kernel;
}
