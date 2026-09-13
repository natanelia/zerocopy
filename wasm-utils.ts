// Shared WASM utilities
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadWasm(filename: string): Uint8Array {
  return readFileSync(join(__dirname, filename));
}

export function createSharedMemory(initial = 256, maximum = 65536): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial, maximum, shared: true });
}

export interface WasmModule {
  memory: WebAssembly.Memory;
  instance: WebAssembly.Instance;
  exports: any;
}

export function instantiateWasm(wasmBytes: Uint8Array, memory: WebAssembly.Memory): WasmModule {
  const module = new WebAssembly.Module(wasmBytes as BufferSource);
  const instance = new WebAssembly.Instance(module, { env: { memory } });
  return { memory, instance, exports: instance.exports };
}

// Memory view management
export class MemoryView {
  buf: Uint8Array;
  dv: DataView;
  private lastBuffer: ArrayBufferLike;

  constructor(private memory: WebAssembly.Memory) {
    this.lastBuffer = memory.buffer;
    this.buf = new Uint8Array(this.lastBuffer);
    this.dv = new DataView(this.lastBuffer);
  }

  refresh(): void {
    if (this.lastBuffer !== this.memory.buffer) {
      this.lastBuffer = this.memory.buffer;
      this.buf = new Uint8Array(this.lastBuffer);
      this.dv = new DataView(this.lastBuffer);
    }
  }
}
