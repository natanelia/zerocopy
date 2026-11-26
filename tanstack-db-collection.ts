import { SharedMap } from './shared-map.ts';
import type { JsonType } from './types.ts';

type CollectionItem = { id: string };

/**
 * SharedCollection - A TanStack DB compatible collection using SharedArrayBuffer
 */
export class SharedCollection<T extends CollectionItem> {
  private readonly data: SharedMap<'object'>;
  readonly id: string;

  constructor(id: string, data: SharedMap<'object'> = new SharedMap('object')) {
    this.id = id;
    this.data = data;
    Object.freeze(this);
  }

  get(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  insert(item: T, key = item.id): SharedCollection<T> {
    return new SharedCollection<T>(this.id, this.data.set(key, item));
  }

  update(key: string, changes: Partial<T>): SharedCollection<T> {
    const existing = this.get(key);
    if (!existing) return this;
    return new SharedCollection<T>(this.id, this.data.set(key, { ...existing, ...changes }));
  }

  delete(key: string): SharedCollection<T> {
    return new SharedCollection<T>(this.id, this.data.delete(key));
  }

  toArray(): T[] {
    const items: T[] = [];
    for (const [_, value] of this.data.entries()) items.push(value as T);
    return items;
  }

  *entries(): Generator<[string, T]> {
    for (const [key, value] of this.data.entries()) yield [key, value as T];
  }

  // JsonType is an erased descriptor for the existing 'object' encoding.
  getSnapshot(): SharedMap<JsonType<T>> { return this.data as unknown as SharedMap<JsonType<T>>; }

  get size(): number { return this.data.size; }
  getRoot(): number { return this.data.root; }

  static fromRoot<T extends CollectionItem>(id: string, root: number, size: number): SharedCollection<T> {
    return new SharedCollection<T>(id, new SharedMap('object', root, size));
  }
}

type Write<T, K extends string | number = string> =
  | { type: 'insert' | 'update' | 'delete'; value: T; key?: never }
  | { type: 'delete'; key: K; value?: never };
type SyncWrite<T, K extends string | number = string> = (message: Write<T, K>) => void;
type Receipt = void | true | Promise<void>;
type SyncParams<T, K extends string | number = string> = {
  begin: () => void;
  write: SyncWrite<T, K>;
  commit: (signal?: AbortSignal) => Receipt;
  markReady: () => void;
  markError?: (error: unknown) => void;
  collection?: { cleanup?: () => Promise<void> };
};
type Mutation<T> = { type: 'insert' | 'update' | 'delete'; modified: T; changes?: Partial<T>; collection?: object };
type Transaction<T> = { mutations: readonly Mutation<T>[] };

function stringKey<T>(item: T, field: keyof T): string {
  const key = item[field];
  if (typeof key !== 'string') throw new TypeError(`Expected a string collection key in ${String(field)}`);
  return key;
}

// Some TanStack versions defer visibility until the optimistic handler settles.
// Its acceptance receipt can safely be awaited inside that same handler.
async function accepted(receipt: Promise<void>): Promise<void> {
  // Attach a rejection handler before loading the peer. A visibility receipt
  // can also reject on cleanup after its underlying commit was accepted.
  void receipt.catch(() => {});
  const db = await import('@tanstack/db');
  await (db.whenSyncAccepted?.(receipt) ?? receipt);
}

// The current TanStack sync API discards uncommitted writes with an aborted
// signal. Older cores discard pending writes when their sync run is cleaned up.
async function rejectSyncWrite<T, K extends string | number>(sync: SyncParams<T, K>, error: unknown): Promise<never> {
  if (sync.collection) {
    const db = await import('@tanstack/db');
    if (typeof db.whenSyncAccepted === 'function') {
      const receipt = sync.commit(AbortSignal.abort());
      if (receipt && receipt !== true) await receipt.catch(() => {});
    } else {
      await sync.collection.cleanup?.();
    }
  }
  throw error;
}

function writeSyncBatch<T, K extends string | number>(sync: SyncParams<T, K>, write: () => void): Receipt {
  sync.begin();
  try { write(); } catch (error) { return rejectSyncWrite(sync, error); }
  return sync.commit();
}

function writeSyncRows<T>(sync: SyncParams<T>, messages: Iterable<Write<T>>): Receipt {
  return writeSyncBatch(sync, () => {
    for (const message of messages) {
      // TanStack DB 0.5 uses the row itself as its writable draft proxy target.
      // Shared reads are deeply frozen, including nested fields.
      if ('value' in message) sync.write({ type: message.type, value: structuredClone(message.value) });
      else sync.write(message);
    }
  });
}

type ViewportSync<K extends string | number> = SyncParams<{ id: K }, K> & {
  collection: { keys(): Iterable<K> };
};

/** Read-only TanStack membership rows for a spatial query, including worker-produced results. */
export function viewportCollectionConfig<K extends string | number = number>({ id }: { id: string }) {
  let membership = new Set<K>();
  let active: { params: ViewportSync<K>; pending: Promise<void> } | undefined;
  let latest: object | undefined;

  function reconcile(params: ViewportSync<K>, previous: Set<K>, next: Set<K>): Receipt {
    const writes: Write<{ id: K }, K>[] = [];
    for (const id of previous) {
      if (!next.has(id)) writes.push({ type: 'delete', value: { id } });
    }
    for (const id of next) {
      if (!previous.has(id)) writes.push({ type: 'insert', value: { id } });
    }
    if (!writes.length) return;
    return writeSyncBatch(params, () => {
      for (const message of writes) params.write(message);
    });
  }

  async function setVisibleIds(input: readonly K[] | PromiseLike<readonly K[]>): Promise<boolean> {
    // Supersede at dispatch. An unresolved worker search never holds the write queue.
    const request = {};
    latest = request;
    let ids: readonly K[];
    try {
      ids = Array.isArray(input) ? input : await input;
    } catch (error) {
      if (request !== latest) return false;
      throw error;
    }
    if (request !== latest) return false;
    if (!Array.isArray(ids)) throw new TypeError('Expected an array of viewport IDs');
    const next = new Set(ids);
    for (const key of next) {
      if (typeof key !== 'string' && !Number.isFinite(key)) throw new TypeError('Viewport IDs must be strings or finite numbers');
    }
    const run = active;
    if (!run) {
      membership = next;
      return true;
    }
    const publication = run.pending.then(async () => {
      if (request !== latest || active !== run) return false;
      const receipt = reconcile(run.params, membership, next);
      if (receipt && receipt !== true) await receipt;
      if (active !== run) return false;
      membership = next;
      return true;
    });
    run.pending = publication.then(() => {}, () => {});
    return publication;
  }

  return {
    id, getKey: (row: { id: K }) => row.id, startSync: true, gcTime: 0,
    utils: { setVisibleIds },
    sync: {
      sync(params: ViewportSync<K>) {
        if (active) throw new Error('Viewport sync is already active');
        const run = { params, pending: Promise.resolve() };
        active = run;
        const close = () => {
          if (active !== run) return;
          active = undefined;
          latest = undefined;
        };
        try {
          // Reload can retain rows while cleanup starts a new, empty collection.
          const seed = reconcile(params, new Set(params.collection.keys()), membership);
          if (seed && seed !== true) {
            run.pending = seed.then(() => { if (active === run) params.markReady(); }, error => {
              if (active === run) { close(); params.markError?.(error); }
            });
          } else params.markReady();
        } catch (error) { close(); throw error; }
        return close;
      },
    },
  };
}

/** Local collection options with an immutable snapshot of confirmed rows. */
export function sharedCollectionConfig<T extends CollectionItem>(config: {
  id: string;
  primaryKey?: keyof T & string;
  initialData?: T[];
}) {
  const { id, primaryKey = 'id' as keyof T & string } = config;
  let initialRows = config.initialData;
  const getKey = (row: T) => stringKey(row, primaryKey);
  let collection = new SharedCollection<T>(id);
  let active: SyncParams<T> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const confirmations = new WeakMap<Transaction<T>, Promise<void>>();

  function acceptMutations(transaction: Transaction<T>): Promise<void> {
    const prior = confirmations.get(transaction);
    if (prior) return prior;
    const sync = active;
    const apply = async () => {
      if (!sync || active !== sync) throw new Error('Collection sync is inactive');
      const mutations = transaction.mutations.filter(m => !m.collection || m.collection === sync.collection);
      if (!mutations.length) return;
      // Encode every row before opening the sync transaction. A failed write
      // must leave both the old root and the TanStack collection readable.
      let next = collection;
      const writes: Write<T>[] = [];
      for (const { type, modified, changes } of mutations) {
        const key = getKey(modified);
        if (type === 'delete') {
          next = next.delete(key);
          writes.push({ type, value: modified });
        } else {
          if (type === 'insert' && next.getSnapshot().has(key)) throw new Error(`Duplicate collection key: ${key}`);
          let value = modified;
          if (type === 'update' && changes) {
            const confirmed = next.get(key);
            if (!confirmed) throw new Error(`Cannot update missing confirmed row: ${key}`);
            value = { ...confirmed, ...changes };
          }
          next = next.insert(value, key);
          writes.push({ type, value: next.get(key)! });
        }
      }
      const receipt = writeSyncRows(sync, writes);
      if (receipt && receipt !== true) await accepted(receipt);
      if (active !== sync) throw new Error('Collection sync ended during confirmation');
      collection = next;
    };
    const result = pending.then(apply);
    confirmations.set(transaction, result);
    pending = result.catch(() => { confirmations.delete(transaction); });
    return result;
  }

  const confirm = ({ transaction }: { transaction: Transaction<T> }) => acceptMutations(transaction);
  return {
    id, primaryKey, getKey,
    sync: {
      rowUpdateMode: 'full' as const,
      sync: (params: SyncParams<T>) => {
        if (active) throw new Error('Collection sync is already active');
        let next = collection;
        if (initialRows?.length) {
          const entries = initialRows.map(row => [getKey(row), row] as const);
          const data = new SharedMap('object').setMany(entries);
          if (data.size !== entries.length) throw new Error('Duplicate initial collection key');
          next = new SharedCollection<T>(id, data);
        }
        const ready = () => {
          if (active !== params) return;
          collection = next;
          initialRows = undefined;
          params.markReady();
        };
        active = params;
        try {
          let receipt: Receipt = undefined;
          if (next.size) {
            function* seedRows(): Generator<Write<T>> {
              for (const [, value] of next.entries()) yield { type: 'insert', value };
            }
            receipt = writeSyncRows(params, seedRows());
          }
          if (receipt && receipt !== true) {
            pending = accepted(receipt).then(ready, error => {
              if (active === params) {
                active = undefined;
                params.markError?.(error);
              }
            });
          } else ready();
        } catch (error) {
          active = undefined;
          throw error;
        }
        return () => { if (active === params) active = undefined; };
      },
      getSyncMetadata: () => ({}),
    },
    onInsert: confirm,
    onUpdate: confirm,
    onDelete: confirm,
    utils: { acceptMutations },
    startSync: true,
    gcTime: 0,
    getSnapshot: () => collection.getSnapshot(),
    getSharedState: () => ({ id, root: collection.getRoot(), size: collection.size }),
    fromSharedState: (state: { root: number; size: number }) => {
      collection = SharedCollection.fromRoot<T>(id, state.root, state.size);
      initialRows = undefined;
    },
  };
}

/**
 * Wrap any TanStack DB sync config to mirror data into SharedArrayBuffer.
 * Provides fast zero-copy reads for workers while upstream (e.g., Electric) handles persistence.
 */
export function withSharedCache<T extends CollectionItem>(
  upstreamSync: { sync: (params: SyncParams<T>) => void | (() => void) },
  options: { primaryKey?: keyof T & string } = {}
) {
  const pk = options.primaryKey ?? 'id' as keyof T & string;
  let cache = new SharedCollection<T>('cache');

  return {
    sync: {
      sync: (params: SyncParams<T>) => {
        // Intercept writes to mirror into SharedArrayBuffer
        const wrappedWrite: SyncWrite<T> = (msg) => {
          if (msg.type === 'insert' && msg.value) {
            cache = cache.insert(msg.value, stringKey(msg.value, pk));
          } else if (msg.type === 'update' && msg.value) {
            cache = cache.update(msg.value[pk] as string, msg.value);
          } else if (msg.type === 'delete') {
            cache = cache.delete(msg.key ?? stringKey(msg.value, pk));
          }
          params.write(msg);
        };

        return upstreamSync.sync({ ...params, write: wrappedWrite });
      },
    },
    // Fast SharedArrayBuffer reads
    getCache: () => cache,
    get: (key: string) => cache.get(key),
    toArray: () => cache.toArray(),
    getSharedState: () => ({ root: cache.getRoot(), size: cache.size }),
    fromSharedState: (state: { root: number; size: number }) => {
      cache = SharedCollection.fromRoot<T>('cache', state.root, state.size);
    },
  };
}
