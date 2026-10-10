import"./chunk-myjykkzh.js";
import {
  SharedMap2
} from "./chunk-x9dsfj5b.js";

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
  insert(item) {
    return new SharedCollection(this.id, this.data.set(item.id, item));
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
function sharedCollectionConfig(config) {
  const { id, primaryKey = "id", initialData } = config;
  let collection = new SharedCollection(id);
  let syncWrite = null;
  let syncBegin = null;
  let syncCommit = null;
  const confirmMutations = (mutations) => {
    if (!syncBegin || !syncWrite || !syncCommit)
      return;
    syncBegin();
    for (const m of mutations)
      syncWrite({ type: m.type, value: m.modified });
    syncCommit();
  };
  return {
    id,
    primaryKey,
    sync: {
      sync: (params) => {
        syncBegin = params.begin;
        syncWrite = params.write;
        syncCommit = params.commit;
        if (initialData?.length) {
          params.begin();
          for (const item of initialData) {
            params.write({ type: "insert", value: item });
            collection = collection.insert(item);
          }
          params.commit();
        }
        params.markReady();
        return () => {};
      },
      getSyncMetadata: () => ({})
    },
    onInsert: async ({ transaction }) => {
      confirmMutations(transaction.mutations);
    },
    onUpdate: async ({ transaction }) => {
      confirmMutations(transaction.mutations);
    },
    onDelete: async ({ transaction }) => {
      confirmMutations(transaction.mutations);
    },
    startSync: true,
    gcTime: 0,
    getSharedState: () => ({ id, root: collection.getRoot(), size: collection.size }),
    fromSharedState: (state) => {
      collection = SharedCollection.fromRoot(id, state.root, state.size);
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
            cache = cache.insert(msg.value);
          } else if (msg.type === "update" && msg.value) {
            cache = cache.update(msg.value[pk], msg.value);
          } else if (msg.type === "delete" && msg.key) {
            cache = cache.delete(msg.key);
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
