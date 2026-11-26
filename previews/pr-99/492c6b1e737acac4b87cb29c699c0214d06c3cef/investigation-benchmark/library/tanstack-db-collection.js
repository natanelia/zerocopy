import"./chunk-vb4t84x1.js";
import {
  SharedMap2
} from "./chunk-g5y5pv5w.js";

// tanstack-db-collection.ts
class SharedCollection {
  data;
  id;
  constructor(id, data = new SharedMap2("object")) {
    this.id = id;
    this.data = data;
    Object.freeze(this);
  }
  get(key) {
    return this.data.get(key);
  }
  insert(item, key = item.id) {
    return new SharedCollection(this.id, this.data.set(key, item));
  }
  update(key, changes) {
    const existing = this.get(key);
    if (!existing)
      return this;
    return new SharedCollection(this.id, this.data.set(key, { ...existing, ...changes }));
  }
  delete(key) {
    return new SharedCollection(this.id, this.data.delete(key));
  }
  toArray() {
    const items = [];
    for (const [_, value] of this.data.entries())
      items.push(value);
    return items;
  }
  *entries() {
    for (const [key, value] of this.data.entries())
      yield [key, value];
  }
  getSnapshot() {
    return this.data;
  }
  get size() {
    return this.data.size;
  }
  getRoot() {
    return this.data.root;
  }
  static fromRoot(id, root, size) {
    return new SharedCollection(id, new SharedMap2("object", root, size));
  }
}
function stringKey(item, field) {
  const key = item[field];
  if (typeof key !== "string")
    throw new TypeError(`Expected a string collection key in ${String(field)}`);
  return key;
}
async function accepted(receipt) {
  receipt.catch(() => {});
  const db = await import("@tanstack/db");
  await (db.whenSyncAccepted?.(receipt) ?? receipt);
}
async function rejectSyncWrite(sync, error) {
  if (sync.collection) {
    const db = await import("@tanstack/db");
    if (typeof db.whenSyncAccepted === "function") {
      const receipt = sync.commit(AbortSignal.abort());
      if (receipt && receipt !== true)
        await receipt.catch(() => {});
    } else {
      await sync.collection.cleanup?.();
    }
  }
  throw error;
}
function writeSyncRows(sync, messages) {
  sync.begin();
  try {
    for (const message of messages)
      sync.write(message);
  } catch (error) {
    return rejectSyncWrite(sync, error);
  }
  return sync.commit();
}
function sharedCollectionConfig(config) {
  const { id, primaryKey = "id" } = config;
  let initialRows = config.initialData;
  const getKey = (row) => stringKey(row, primaryKey);
  let collection = new SharedCollection(id);
  let active;
  let pending = Promise.resolve();
  const confirmations = new WeakMap;
  function acceptMutations(transaction) {
    const prior = confirmations.get(transaction);
    if (prior)
      return prior;
    const sync = active;
    const apply = async () => {
      if (!sync || active !== sync)
        throw new Error("Collection sync is inactive");
      const mutations = transaction.mutations.filter((m) => !m.collection || m.collection === sync.collection);
      if (!mutations.length)
        return;
      let next = collection;
      const writes = [];
      for (const { type, modified, changes } of mutations) {
        const key = getKey(modified);
        if (type === "delete") {
          next = next.delete(key);
          writes.push({ type, value: modified });
        } else {
          if (type === "insert" && next.getSnapshot().has(key))
            throw new Error(`Duplicate collection key: ${key}`);
          let value = modified;
          if (type === "update" && changes) {
            const confirmed = next.get(key);
            if (!confirmed)
              throw new Error(`Cannot update missing confirmed row: ${key}`);
            value = { ...confirmed, ...changes };
          }
          next = next.insert(value, key);
          writes.push({ type, value: next.get(key) });
        }
      }
      const receipt = writeSyncRows(sync, writes);
      if (receipt && receipt !== true)
        await accepted(receipt);
      if (active !== sync)
        throw new Error("Collection sync ended during confirmation");
      collection = next;
    };
    const result = pending.then(apply);
    confirmations.set(transaction, result);
    pending = result.catch(() => {
      confirmations.delete(transaction);
    });
    return result;
  }
  const confirm = ({ transaction }) => acceptMutations(transaction);
  return {
    id,
    primaryKey,
    getKey,
    sync: {
      rowUpdateMode: "full",
      sync: (params) => {
        if (active)
          throw new Error("Collection sync is already active");
        let next = collection;
        if (initialRows?.length) {
          const entries = initialRows.map((row) => [getKey(row), row]);
          const data = new SharedMap2("object").setMany(entries);
          if (data.size !== entries.length)
            throw new Error("Duplicate initial collection key");
          next = new SharedCollection(id, data);
        }
        const ready = () => {
          if (active !== params)
            return;
          collection = next;
          initialRows = undefined;
          params.markReady();
        };
        active = params;
        try {
          let receipt = undefined;
          if (next.size) {
            function* seedRows() {
              for (const [, value] of next.entries())
                yield { type: "insert", value };
            }
            receipt = writeSyncRows(params, seedRows());
          }
          if (receipt && receipt !== true) {
            pending = accepted(receipt).then(ready, (error) => {
              if (active === params) {
                active = undefined;
                params.markError?.(error);
              }
            });
          } else
            ready();
        } catch (error) {
          active = undefined;
          throw error;
        }
        return () => {
          if (active === params)
            active = undefined;
        };
      },
      getSyncMetadata: () => ({})
    },
    onInsert: confirm,
    onUpdate: confirm,
    onDelete: confirm,
    utils: { acceptMutations },
    startSync: true,
    gcTime: 0,
    getSnapshot: () => collection.getSnapshot(),
    getSharedState: () => ({ id, root: collection.getRoot(), size: collection.size }),
    fromSharedState: (state) => {
      collection = SharedCollection.fromRoot(id, state.root, state.size);
      initialRows = undefined;
    }
  };
}
function withSharedCache(upstreamSync, options = {}) {
  const pk = options.primaryKey ?? "id";
  let cache = new SharedCollection("cache");
  return {
    sync: {
      sync: (params) => {
        const wrappedWrite = (msg) => {
          if (msg.type === "insert" && msg.value) {
            cache = cache.insert(msg.value, stringKey(msg.value, pk));
          } else if (msg.type === "update" && msg.value) {
            cache = cache.update(msg.value[pk], msg.value);
          } else if (msg.type === "delete") {
            cache = cache.delete(msg.key ?? stringKey(msg.value, pk));
          }
          params.write(msg);
        };
        return upstreamSync.sync({ ...params, write: wrappedWrite });
      }
    },
    getCache: () => cache,
    get: (key) => cache.get(key),
    toArray: () => cache.toArray(),
    getSharedState: () => ({ root: cache.getRoot(), size: cache.size }),
    fromSharedState: (state) => {
      cache = SharedCollection.fromRoot("cache", state.root, state.size);
    }
  };
}
export {
  SharedCollection,
  sharedCollectionConfig,
  withSharedCache
};
