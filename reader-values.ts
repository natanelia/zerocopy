/** Pure decoded values shared only by successive attachments in one session.
 * The byte budget counts encoded input, not JavaScript heap usage. There is no
 * eviction: values admitted by an earlier view remain immutable cache hits.
 * Entries never contain an Arena, memory handle, registry, or nested snapshot.
 * This relies on the supported append-only lifetime: published bytes must not
 * be overwritten through raw memory or a memory-plus-copy transport payload.
 */
export class DecodedValues<T> {
  private readonly entries = new Map<number, { length: number; value: T }>();
  private bytes = 0;
  private active: boolean;
  constructor(active = true) { this.active = active; }
  get(ptr: number, length: number): { length: number; value: T } | undefined {
    const entry = this.entries.get(ptr);
    return entry?.length === length ? entry : undefined;
  }
  remember(ptr: number, length: number, value: T): void {
    if (!this.active || !length || this.entries.has(ptr) || this.entries.size >= 2048 || this.bytes + length > 2097152) return;
    this.entries.set(ptr, { length, value }); this.bytes += length;
  }
  deactivate(): void {
    this.active = false; this.entries.clear(); this.bytes = 0;
  }
}

export class ReaderValues {
  private active = true;
  private jsonValues: DecodedValues<unknown> | undefined;
  private stringValues: DecodedValues<string> | undefined;
  get json(): DecodedValues<unknown> { return this.jsonValues ??= new DecodedValues(this.active); }
  get strings(): DecodedValues<string> { return this.stringValues ??= new DecodedValues(this.active); }
  deactivate(): void {
    this.active = false; this.jsonValues?.deactivate(); this.stringValues?.deactivate();
  }
}
