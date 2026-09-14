/** Bounded, process-local address cache. Never part of a published snapshot.
 * The root is part of every hit check. Forks and old versions cannot share a
 * result merely because their string keys are equal.
 * Flat words avoid allocating a JavaScript record for each cached key.
 */
export class ReadCache {
  private readonly slots = new Map<string, number>();
  private words = new Uint32Array(4 * 256);
  private chars = 0;
  private readonly values: unknown[] = [];
  private valueBytes = 0;
  code(slot: number): number { return this.words[slot + 3]; }
  value(slot: number): unknown { return this.values[slot >>> 2]; }
  cacheValue(slot: number, code: number, value: string | number | boolean | undefined): void {
    const index = slot >>> 2, bytes = typeof value === 'string' ? value.length * 2 : 8;
    this.valueBytes -= this.words[slot + 3] ? (typeof this.values[index] === 'string' ? (this.values[index] as string).length * 2 : 8) : 0;
    if (this.valueBytes + bytes > 1048576) {
      this.values[index] = undefined; this.words[slot + 3] = 0; return;
    }
    this.values[index] = value; this.valueBytes += bytes; this.words[slot + 3] = code;
  }
  private static readonly MAX_ENTRIES = 16384;
  private static readonly MAX_CHARS = 131072;

  slot(key: string): number | undefined { return this.slots.get(key); }
  keyLeaf(slot: number): number { return this.words[slot]; }
  root(slot: number): number { return this.words[slot + 1]; }
  leaf(slot: number): number { return this.words[slot + 2]; }
  update(slot: number, root: number, leaf: number): void {
    if (this.words[slot + 2] !== leaf) {
      const index = slot >>> 2;
      this.valueBytes -= this.words[slot + 3] ? (typeof this.values[index] === 'string' ? (this.values[index] as string).length * 2 : 8) : 0;
      this.values[index] = undefined; this.words[slot + 3] = 0;
    }
    this.words[slot + 1] = root; this.words[slot + 2] = leaf;
  }
  remember(key: string, root: number, leaf: number): void {
    const existing = this.slots.get(key);
    if (existing !== undefined) { this.update(existing, root, leaf); return; }
    // Do not let unrelated misses consume the cache's memory budget.
    if (!leaf || this.slots.size >= ReadCache.MAX_ENTRIES || this.chars + key.length > ReadCache.MAX_CHARS) return;
    const slot = this.slots.size * 4;
    if (slot === this.words.length) {
      const next = new Uint32Array(this.words.length * 2); next.set(this.words); this.words = next;
    }
    this.slots.set(key, slot); this.chars += key.length;
    this.words[slot] = leaf; this.update(slot, root, leaf);
  }
}
