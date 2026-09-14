/**
 * TanStack DB Collection backed by SharedArrayBuffer
 * 
 * Enables zero-copy sharing of collection data across Web Workers.
 */

import { SharedMap } from './shared-map.ts';

type CollectionItem = { id: string; [key: string]: unknown };

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

  insert(item: T): SharedCollection<T> {
    return new SharedCollection<T>(this.id, this.data.set(item.id, item));
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

  get size(): number { return this.data.size; }
  getRoot(): number { return (this.data as any).root; }

  static fromRoot<T extends CollectionItem>(id: string, root: number, size: number): SharedCollection<T> {
    return new SharedCollection<T>(id, new SharedMap('object', root, size));
  }
}

type SyncWrite<T> = (msg: { type: 'insert' | 'update' | 'delete'; value?: T; key?: string }) => void;
type SyncParams<T> = { begin: () => void; write: SyncWrite<T>; commit: () => void; markReady: () => void };

/**
 * Create TanStack DB collection config backed by SharedArrayBuffer
 */
export function sharedCollectionConfig<T extends CollectionItem>(config: {
  id: string;
  primaryKey?: keyof T & string;
  initialData?: T[];
}) {
  const { id, primaryKey = 'id' as keyof T & string, initialData } = config;
  let collection = new SharedCollection<T>(id);
  let syncWrite: SyncWrite<T> | null = null;
  let syncBegin: (() => void) | null = null;
  let syncCommit: (() => void) | null = null;

  const confirmMutations = (mutations: Array<{ type: 'insert' | 'update' | 'delete'; modified: T }>) => {
    if (!syncBegin || !syncWrite || !syncCommit) return;
    syncBegin();
    for (const m of mutations) syncWrite({ type: m.type, value: m.modified });
    syncCommit();
  };

  return {
    id,
    primaryKey,
    sync: {
      sync: (params: SyncParams<T>) => {
        syncBegin = params.begin;
        syncWrite = params.write;
        syncCommit = params.commit;
        if (initialData?.length) {
          params.begin();
          for (const item of initialData) {
            params.write({ type: 'insert', value: item });
            collection = collection.insert(item);
          }
          params.commit();
        }
        params.markReady();
        return () => {};
      },
      getSyncMetadata: () => ({}),
    },
    onInsert: async ({ transaction }: { transaction: { mutations: Array<{ type: 'insert' | 'update' | 'delete'; modified: T }> } }) => {
      confirmMutations(transaction.mutations);
    },
    onUpdate: async ({ transaction }: { transaction: { mutations: Array<{ type: 'insert' | 'update' | 'delete'; modified: T }> } }) => {
      confirmMutations(transaction.mutations);
    },
    onDelete: async ({ transaction }: { transaction: { mutations: Array<{ type: 'insert' | 'update' | 'delete'; modified: T }> } }) => {
      confirmMutations(transaction.mutations);
    },
    startSync: true,
    gcTime: 0,
    getSharedState: () => ({ id, root: collection.getRoot(), size: collection.size }),
    fromSharedState: (state: { root: number; size: number }) => {
      collection = SharedCollection.fromRoot<T>(id, state.root, state.size);
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
            cache = cache.insert(msg.value);
          } else if (msg.type === 'update' && msg.value) {
            cache = cache.update(msg.value[pk] as string, msg.value);
          } else if (msg.type === 'delete' && msg.key) {
            cache = cache.delete(msg.key);
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
