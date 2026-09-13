// The demo imports the production implementation, not a second data-structure engine.
export * from '../dist/shared.js';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Todo-specific binary format for true zero-copy
// Format: [count:u32][todo0][todo1]...
// Todo: [idLen:u8][titleLen:u16][completed:u8][categoryIdx:u8][dueDate:f64][id bytes][title bytes]
export function serializeTodosToBuffer(todos: any[]): SharedArrayBuffer {
  // Encode once so byte lengths, not UTF-16 lengths, determine the buffer size.
  const encoded = todos.map(t => ({ todo: t, id: encoder.encode(t.id), title: encoder.encode(t.title) }));
  let size = 4;
  for (const t of encoded) {
    if (t.id.length > 255 || t.title.length > 65535) throw new RangeError('Todo text exceeds the binary field size');
    size += 13 + t.id.length + t.title.length;
  }
  
  const buffer = new SharedArrayBuffer(size);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const categories = ['work', 'personal', 'shopping', 'health', 'finance'];
  
  view.setUint32(0, todos.length, true);
  let off = 4;
  for (const { todo: t, id: idBytes, title: titleBytes } of encoded) {
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
  private readonly categories = Object.freeze(['work', 'personal', 'shopping', 'health', 'finance']);
  
  constructor(buffer: SharedArrayBuffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.count = this.view.getUint32(0, true);
    Object.freeze(this);
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
      fn(Object.freeze({ id, title, completed, category, dueDate }));
      off += 13 + idLen + titleLen;
    }
  }
}
