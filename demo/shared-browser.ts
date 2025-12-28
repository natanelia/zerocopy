/**
 * Browser-compatible shared-immutable
 * Loads WASM via fetch and provides async initialization
 */

let wasm: any;
let memory: WebAssembly.Memory;
let memBuf: Uint8Array;
let memDv: DataView;
let keyBufPtr: number;
let batchBufPtr: number;
let lastBuffer: ArrayBufferLike;

function refreshMem() {
  if (lastBuffer !== memory.buffer) {
    lastBuffer = memory.buffer;
    memBuf = new Uint8Array(lastBuffer);
    memDv = new DataView(lastBuffer);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SharedMap<T extends string = 'string'> {
  private root: number = 0;
  private _size: number = 0;
  private valueType: string;
  
  constructor(valueType: string) {
    this.valueType = valueType;
  }
  
  static async init(): Promise<void> {
    if (wasm) return;
    const resp = await fetch('/shared-map.wasm');
    const bytes = await resp.arrayBuffer();
    memory = new WebAssembly.Memory({ initial: 2, maximum: 65536, shared: true });
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, { env: { memory } });
    wasm = instance.exports;
    keyBufPtr = wasm.keyBuf();
    batchBufPtr = wasm.batchBuf();
    lastBuffer = memory.buffer;
    memBuf = new Uint8Array(lastBuffer);
    memDv = new DataView(lastBuffer);
  }
  
  private encodeKey(key: string): number {
    refreshMem();
    const bytes = encoder.encode(key);
    memBuf.set(bytes, keyBufPtr);
    return bytes.length;
  }
  
  private encodeValue(value: any): { len: number; write: (ptr: number) => void } {
    const str = this.valueType === 'object' ? JSON.stringify(value) : String(value);
    const bytes = encoder.encode(str);
    return { len: bytes.length, write: (ptr: number) => { refreshMem(); memBuf.set(bytes, ptr); } };
  }
  
  private decodeValue(ptr: number, len: number): any {
    refreshMem();
    const str = decoder.decode(memBuf.slice(ptr, ptr + len));
    if (this.valueType === 'object') return JSON.parse(str);
    if (this.valueType === 'number') return Number(str);
    if (this.valueType === 'boolean') return str === 'true';
    return str;
  }
  
  set(key: string, value: any): SharedMap<T> {
    const keyLen = this.encodeKey(key);
    const { len: valLen, write } = this.encodeValue(value);
    
    wasm.insertKey(this.root, keyLen, valLen);
    refreshMem();
    const newRoot = memDv.getUint32(batchBufPtr, true);
    const existed = memDv.getUint32(batchBufPtr + 4, true);
    const valPtr = memDv.getUint32(batchBufPtr + 8, true);
    write(valPtr);
    
    const m = new SharedMap<T>(this.valueType);
    m.root = newRoot;
    m._size = this._size + (existed ? 0 : 1);
    return m;
  }
  
  get(key: string): any | undefined {
    const keyLen = this.encodeKey(key);
    if (!wasm.getInfo(this.root, keyLen)) return undefined;
    refreshMem();
    const kLen = memDv.getUint32(batchBufPtr, true);
    const vLen = memDv.getUint32(batchBufPtr + 4, true);
    const keyPtr = memDv.getUint32(batchBufPtr + 8, true);
    return this.decodeValue(keyPtr + kLen, vLen);
  }
  
  has(key: string): boolean {
    return wasm.has(this.root, this.encodeKey(key)) === 1;
  }
  
  get size(): number { return this._size; }
  
  forEach(fn: (value: any, key: string) => void): void {
    wasm.initIter(this.root);
    let count;
    while ((count = wasm.nextLeaves(512))) {
      refreshMem();
      for (let i = 0, off = batchBufPtr; i < count; i++, off += 12) {
        const leafPtr = memDv.getUint32(off, true);
        const kLen = memDv.getUint32(off + 4, true);
        const vLen = memDv.getUint32(off + 8, true);
        const keyPtr = wasm.leafKeyPtr(leafPtr);
        const key = decoder.decode(memBuf.slice(keyPtr, keyPtr + kLen));
        const value = this.decodeValue(keyPtr + kLen, vLen);
        fn(value, key);
      }
    }
  }
  
  static getSharedBuffer(): SharedArrayBuffer {
    return memory.buffer as SharedArrayBuffer;
  }
}

type WorkerData = {
  __shared: true;
  mapBuffer: SharedArrayBuffer;
  structures: Record<string, { type: string; data: any }>;
};

export function getWorkerData(structures: Record<string, SharedMap<any>>): WorkerData {
  const serialized: Record<string, { type: string; data: any }> = {};
  for (const [name, struct] of Object.entries(structures)) {
    serialized[name] = { type: 'SharedMap', data: { root: (struct as any).root, valueType: (struct as any).valueType, size: (struct as any)._size } };
  }
  return { __shared: true, mapBuffer: memory.buffer as SharedArrayBuffer, structures: serialized };
}

export async function initWorker<T extends Record<string, SharedMap<any>>>(data: WorkerData): Promise<T> {
  if (!data.__shared) throw new Error('Invalid worker data - use getWorkerData() on main thread');
  const result: Record<string, SharedMap<any>> = {};
  for (const [name, { type, data: d }] of Object.entries(data.structures)) {
    if (type === 'SharedMap') {
      const map = new SharedMap(d.valueType);
      (map as any).root = d.root;
      (map as any)._size = d.size;
      result[name] = map;
    }
  }
  return result as T;
}

// Todo-specific binary format for true zero-copy
// Format: [count:u32][todo0][todo1]...
// Todo: [idLen:u8][titleLen:u16][completed:u8][categoryIdx:u8][dueDate:f64][id bytes][title bytes]
export function serializeTodosToBuffer(todos: any[]): SharedArrayBuffer {
  // Calculate size
  let size = 4; // count
  for (const t of todos) {
    size += 1 + 2 + 1 + 1 + 8 + t.id.length + t.title.length;
  }
  
  const buffer = new SharedArrayBuffer(size);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const categories = ['work', 'personal', 'shopping', 'health', 'finance'];
  
  view.setUint32(0, todos.length, true);
  let off = 4;
  for (const t of todos) {
    const idBytes = encoder.encode(t.id);
    const titleBytes = encoder.encode(t.title);
    bytes[off] = idBytes.length;
    view.setUint16(off + 1, titleBytes.length, true);
    bytes[off + 3] = t.completed ? 1 : 0;
    bytes[off + 4] = categories.indexOf(t.category);
    view.setFloat64(off + 5, t.dueDate, true);
    bytes.set(idBytes, off + 13);
    bytes.set(titleBytes, off + 13 + idBytes.length);
    off += 13 + idBytes.length + titleBytes.length;
  }
  return buffer;
}

// Iterator for reading todos from SharedArrayBuffer without full deserialization
export class SharedTodoReader {
  private view: DataView;
  private bytes: Uint8Array;
  private count: number;
  private offset = 4;
  private categories = ['work', 'personal', 'shopping', 'health', 'finance'];
  
  constructor(buffer: SharedArrayBuffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.count = this.view.getUint32(0, true);
  }
  
  get length() { return this.count; }
  
  private decodeString(start: number, len: number): string {
    // Must copy to regular ArrayBuffer for TextDecoder
    const copy = new Uint8Array(len);
    copy.set(this.bytes.subarray(start, start + len));
    return decoder.decode(copy);
  }
  
  forEach(fn: (todo: { id: string; title: string; completed: boolean; category: string; dueDate: number }) => void) {
    let off = 4;
    for (let i = 0; i < this.count; i++) {
      const idLen = this.bytes[off];
      const titleLen = this.view.getUint16(off + 1, true);
      const completed = this.bytes[off + 3] === 1;
      const category = this.categories[this.bytes[off + 4]];
      const dueDate = this.view.getFloat64(off + 5, true);
      const id = this.decodeString(off + 13, idLen);
      const title = this.decodeString(off + 13 + idLen, titleLen);
      fn({ id, title, completed, category, dueDate });
      off += 13 + idLen + titleLen;
    }
  }
}
