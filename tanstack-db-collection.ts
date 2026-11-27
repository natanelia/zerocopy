import { SharedMap } from './shared-map.ts';
import type { JsonObject, JsonType, JsonValue } from './types.ts';
import { checkSpatialId } from './spatial-id.ts';
import type { SpatialPair, SpatialJoinDelta } from './spatial.ts';
import { notifySubscribers } from './snapshot-listeners.ts';

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
type Mutation<T> = { type: 'insert' | 'update' | 'delete'; modified: T; original?: Partial<T>; changes?: Partial<T>; collection?: object };
type Transaction<T> = { mutations: readonly Mutation<T>[] };

function jsonRecord(value: JsonValue | undefined): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function sameJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => sameJson(value, b[index]));
  }
  if (!jsonRecord(a) || !jsonRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}

function ownField<T extends object>(object: T, key: keyof T) {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

// TanStack tracks the top-level field. A nested edit carries the entire
// optimistic field, including sibling values from other pending transactions.
function rebaseField(
  before: JsonValue | undefined, after: JsonValue | undefined,
  confirmed: JsonValue | undefined, path: string,
): JsonValue | undefined {
  if (sameJson(before, after)) return confirmed;
  if (sameJson(before, confirmed) || sameJson(after, confirmed)) return after;
  if (jsonRecord(before) && jsonRecord(after) && jsonRecord(confirmed)) {
    const result: Record<string, JsonValue> = Object.assign(Object.create(null), confirmed);
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) delete result[key];
    }
    for (const [key, value] of Object.entries(after)) {
      const next = rebaseField(ownField(before, key), value, ownField(confirmed, key), path + '.' + key);
      if (next === undefined) delete result[key];
      else result[key] = next;
    }
    return result;
  }
  // Arrays have no element identities. A descendant edit also needs its
  // original object to exist. Retrying from the current row resolves either.
  if ((Array.isArray(before) && Array.isArray(after)) || (jsonRecord(before) && jsonRecord(after))) {
    throw new Error(`Cannot confirm overlapping edits to ${path}`);
  }
  return after;
}

function confirmedUpdate<T extends object>(confirmed: T, changes: Partial<T>, original?: Partial<T>): T {
  if (!original) return { ...confirmed, ...changes };
  const fields = Object.keys(changes) as (keyof T & string)[];
  const updates = fields.map(key => {
    const before = ownField(original, key), after = changes[key];
    if (before === after) return [key, ownField(confirmed, key)];
    if (before == null || after == null || typeof before !== 'object' || typeof after !== 'object') return [key, after];
    // Compare in the shared map's JSON representation (including toJSON).
    const pair: { before?: JsonValue; after?: JsonValue } = JSON.parse(JSON.stringify({ before, after }));
    return [key, rebaseField(pair.before, pair.after, ownField(confirmed, key) as JsonValue, key)];
  });
  return { ...confirmed, ...Object.fromEntries(updates) };
}

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

type MembershipSync<Row, K extends string | number> = SyncParams<Row, K> & {
  collection: { keys(): Iterable<K> };
};

type MemberChanges<T> = { readonly added: readonly T[]; readonly removed: readonly T[] };
type MemberInput<T> = T | PromiseLike<T>;
function isPending<T>(input: MemberInput<T>): input is PromiseLike<T> {
  return typeof (input as PromiseLike<T> | null)?.then === 'function';
}

function membershipOptions<Item, K extends string | number, Row extends { id: K }>(
  id: string, memberKey: (item: Item) => K, rowForKey: (key: K) => Row,
) {
  const membership = new Set<K>();
  let version = 0;
  let active: { params: MembershipSync<Row, K>; pending: Promise<void> } | undefined;
  let latest: object | undefined;

  function difference(keys: Set<K>, excluded: Set<K>): K[] {
    const result: K[] = [];
    for (const key of keys) if (!excluded.has(key)) result.push(key);
    return result;
  }
  function writeChanges(params: MembershipSync<Row, K>, { added, removed }: MemberChanges<K>): Receipt {
    if (!added.length && !removed.length) return;
    return writeSyncBatch(params, () => {
      for (const key of removed) params.write({ type: 'delete', value: rowForKey(key) });
      for (const key of added) params.write({ type: 'insert', value: rowForKey(key) });
    });
  }
  function keys(items: readonly Item[]): Set<K> {
    if (!Array.isArray(items)) throw new TypeError('Expected an array of spatial query results');
    const result = new Set<K>();
    for (const item of items) result.add(memberKey(item));
    return result;
  }
  function accept({ added, removed }: MemberChanges<K>) {
    for (const key of removed) membership.delete(key);
    for (const key of added) membership.add(key);
    version++;
    return true;
  }
  async function publish<T>(input: MemberInput<T>, capture: (value: T) => () => MemberChanges<K>,
    current = () => true): Promise<boolean> {
    if (!current()) {
      if (isPending(input)) void Promise.resolve(input).catch(() => {});
      return false;
    }
    // Supersede at dispatch. An unresolved worker search never holds the write queue.
    const request = {};
    latest = request;
    let value: T;
    try {
      value = isPending(input) ? await input : input;
    } catch (error) {
      if (request !== latest || !current()) return false;
      throw error;
    }
    if (request !== latest || !current()) return false;
    const changes = capture(value);
    const run = active;
    if (!run) return accept(changes());
    const publication = run.pending.then(async () => {
      if (request !== latest || active !== run || !current()) return false;
      const delta = changes();
      const receipt = writeChanges(run.params, delta);
      if (receipt && receipt !== true) await receipt;
      if (active !== run) return false;
      return accept(delta);
    });
    run.pending = publication.then(() => {}, () => {});
    return publication;
  }

  function setMembers(input: MemberInput<readonly Item[]>) {
    return publish(input, items => {
      const next = keys(items);
      return () => ({ added: difference(next, membership), removed: difference(membership, next) });
    });
  }
  function applyChanges(input: MemberInput<MemberChanges<Item>>, expectedVersion: number) {
    return publish(input, delta => {
      const added = keys(delta.added), removed = keys(delta.removed);
      for (const key of added) if (removed.has(key)) throw new RangeError('A membership key cannot be both added and removed');
      return () => ({
        added: difference(added, membership),
        removed: Array.from(removed).filter(key => membership.has(key)),
      });
    }, () => version === expectedVersion);
  }

  const options = {
    id, getKey: (row: Row) => row.id, startSync: true, gcTime: 0,
    sync: {
      sync(params: MembershipSync<Row, K>) {
        if (active) throw new Error('Membership sync is already active');
        const run = { params, pending: Promise.resolve() };
        active = run;
        const close = () => {
          if (active !== run) return;
          active = undefined;
          latest = undefined;
        };
        try {
          // Reload can retain rows while cleanup starts a new, empty collection.
          const existing = new Set(params.collection.keys());
          const seed = writeChanges(params, { added: difference(membership, existing), removed: difference(existing, membership) });
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
  return { options, setMembers, applyChanges, getVersion: () => version };
}

/** Read-only TanStack membership rows for a spatial query, including worker-produced results. */
export function viewportCollectionConfig<K extends string | number = number>({ id }: { id: string }) {
  const { setMembers, applyChanges, getVersion, options } = membershipOptions(id, (key: K) => {
    if (typeof key !== 'string' && !Number.isFinite(key)) throw new TypeError('Viewport IDs must be strings or finite numbers');
    return key;
  }, (id: K) => ({ id }));
  return { ...options, utils: { setVisibleIds: setMembers, applyVisibleChanges: applyChanges, getVersion } };
}

/** Read-only TanStack rows keyed by ordered feature-ID pairs from a spatial join. */
export function spatialJoinCollectionConfig({ id }: { id: string }) {
  const { setMembers, applyChanges, getVersion, options } = membershipOptions(id, (pair: SpatialPair) => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError('Expected a pair of spatial feature IDs');
    checkSpatialId(pair[0]);
    checkSpatialId(pair[1]);
    return pair[0] + ':' + pair[1];
  }, (id: string) => {
    const separator = id.indexOf(':');
    return { id, leftId: Number(id.slice(0, separator)), rightId: Number(id.slice(separator + 1)) };
  });
  return { ...options, utils: {
    setPairs: setMembers, getVersion,
    applyPairChanges: (delta: MemberInput<SpatialJoinDelta>, expectedVersion: number) => applyChanges(delta, expectedVersion),
  } };
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
  const listeners = new Set<() => void>();

  function install(next: SharedCollection<T>): void {
    if (next.getSnapshot() === collection.getSnapshot()) return;
    collection = next;
    notifySubscribers(listeners, error => console.error('[zerocopy/tanstack] snapshot listener failed', error));
  }

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
      for (const { type, modified, changes, original } of mutations) {
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
            value = confirmedUpdate(confirmed, changes, original);
          }
          next = next.insert(value, key);
          writes.push({ type, value: next.get(key)! });
        }
      }
      const receipt = writeSyncRows(sync, writes);
      if (receipt && receipt !== true) await accepted(receipt);
      if (active !== sync) throw new Error('Collection sync ended during confirmation');
      install(next);
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
          initialRows = undefined;
          install(next);
          if (active === params) params.markReady();
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
    /** Observe changes to the confirmed snapshot. Read the current value with getSnapshot(). */
    subscribe: (listener: () => void) => {
      const subscription = () => listener();
      listeners.add(subscription);
      return () => { listeners.delete(subscription); };
    },
    getSharedState: () => ({ id, root: collection.getRoot(), size: collection.size }),
    fromSharedState: (state: { root: number; size: number }) => {
      const restored = SharedCollection.fromRoot<T>(id, state.root, state.size);
      initialRows = undefined;
      install(restored);
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
