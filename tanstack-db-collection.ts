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
  private data: SharedMap<'object'>;
  readonly id: string;

  constructor(id: string) {
    this.id = id;
    this.data = new SharedMap('object');
  }

  get(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  insert(item: T): SharedCollection<T> {
    const result = new SharedCollection<T>(this.id);
    result.data = this.data.set(item.id, item);
    return result;
  }

  update(key: string, changes: Partial<T>): SharedCollection<T> {
    const existing = this.get(key);
    if (!existing) return this;
    const result = new SharedCollection<T>(this.id);
    result.data = this.data.set(key, { ...existing, ...changes });
    return result;
  }

  delete(key: string): SharedCollection<T> {
    const result = new SharedCollection<T>(this.id);
    result.data = this.data.delete(key);
    return result;
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
    const result = new SharedCollection<T>(id);
    result.data = new SharedMap('object', root, size);
    return result;
  }
}

type SyncWrite<T> = (msg: { type: 'insert' | 'update' | 'delete'; value?: T }) => void;

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
      sync: (params: { begin: () => void; write: SyncWrite<T>; commit: () => void; markReady: () => void }) => {
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
    // Worker sharing
    getSharedState: () => ({ id, root: collection.getRoot(), size: collection.size }),
    fromSharedState: (state: { root: number; size: number }) => {
      collection = SharedCollection.fromRoot<T>(id, state.root, state.size);
    },
  };
}
