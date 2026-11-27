import {
  normalizeKey
} from "./chunk-953e7ch3.js";
import {
  SharedMap2
} from "./chunk-xp6v3e8t.js";
import {
  notifySubscribers
} from "./chunk-7vqyw3p7.js";
import {
  checkSpatialId
} from "./chunk-vt8h7fk7.js";

// confirmed-sync-cache.ts
function capturePatch(value, merge, prior) {
  const copy = JSON.parse(JSON.stringify(value));
  if (!copy || typeof copy !== "object" || Array.isArray(copy))
    throw new TypeError("Expected a JSON row object");
  if (!merge)
    return { value: copy, merge: false };
  for (const field of Object.keys(value)) {
    if (!Object.hasOwn(copy, field))
      Object.defineProperty(copy, field, { value: undefined, enumerable: true });
  }
  return prior ? { value: { ...prior.value, ...copy }, merge: prior.merge } : { value: copy, merge: prior !== null };
}
function applyBatch(before, batch) {
  const base = batch.replace ? new SharedMap2("object") : before;
  const writes = [], deletes = [];
  for (const [key, patch] of batch.patches) {
    if (!patch)
      deletes.push(key);
    else
      writes.push([key, patch.merge ? { ...base.get(key), ...patch.value } : patch.value]);
  }
  return base.deleteMany(deletes).setMany(writes);
}
function withConfirmedSharedCache(upstream) {
  let rows = new SharedMap2("object");
  let attached = false;
  const listeners = new Set;
  const sync = {
    ...upstream,
    sync(params) {
      if (attached)
        throw new Error("This confirmed cache already has an active sync run");
      attached = true;
      let live = true;
      let open;
      const pending = new Map;
      let head = 0, tail = 0;
      function close() {
        if (!live)
          return;
        live = false;
        attached = false;
        open = undefined;
        pending.clear();
      }
      function settle(sequence, status) {
        const entry = pending.get(sequence);
        if (!entry)
          return;
        entry.status = status;
        let ready;
        while ((ready = pending.get(head)) && ready.status !== "waiting") {
          pending.delete(head++);
          if (ready.status === "rejected")
            continue;
          const next = ready.base === rows ? ready.next : applyBatch(rows, ready.batch);
          if (next === rows)
            continue;
          rows = next;
          notifySubscribers(listeners, (error) => console.error("[zerocopy/tanstack] snapshot listener failed", error));
        }
      }
      try {
        const result = upstream.sync({
          ...params,
          begin(options) {
            if (!live)
              return;
            params.begin(options);
            open = { replace: options?.snapshot === true, patches: new Map };
          },
          truncate(options) {
            if (!live)
              return;
            params.truncate(options);
            if (open) {
              open.replace = true;
              open.patches.clear();
            }
          },
          write(message) {
            if (!live)
              return;
            if (!open)
              throw new Error("Begin a sync batch before writing rows");
            const key = "key" in message ? message.key : params.collection.getKeyFromItem(message.value);
            if (typeof key !== "string")
              throw new TypeError("Confirmed cache keys must be strings");
            if (normalizeKey(key) !== key)
              throw new TypeError("Confirmed cache keys must be well-formed Unicode");
            const merge = message.type === "update" && upstream.rowUpdateMode !== "full";
            const patch = message.type === "delete" ? null : capturePatch(message.value, merge, open.patches.get(key));
            params.write(message);
            open.patches.set(key, patch);
          },
          commit(signal) {
            if (!live)
              return true;
            if (!open)
              return params.commit(signal);
            const batch = open;
            const base = pending.get(tail - 1)?.next ?? rows;
            const entry = { batch, base, next: applyBatch(base, batch), status: "waiting" };
            open = undefined;
            const sequence = tail++;
            pending.set(sequence, entry);
            let receipt;
            try {
              receipt = params.commit(signal);
            } catch (error) {
              settle(sequence, "rejected");
              if (live && !open && sequence + 1 === tail)
                open = batch;
              throw error;
            }
            if (receipt && receipt !== true) {
              receipt.then(() => settle(sequence, "visible"), () => settle(sequence, "rejected")).catch((error) => {
                close();
                if (params.fail)
                  params.fail(error);
                else
                  console.error("[zerocopy/tanstack] confirmed cache publication failed", error);
              });
            } else
              settle(sequence, "visible");
            return receipt;
          }
        });
        return { ...typeof result === "object" ? result : {}, cleanup() {
          close();
          if (typeof result === "function")
            return result();
          if (result)
            return result.cleanup?.();
        } };
      } catch (error) {
        close();
        throw error;
      }
    }
  };
  return {
    sync,
    getSnapshot: () => rows,
    subscribe(listener) {
      const subscription = () => listener();
      listeners.add(subscription);
      return () => {
        listeners.delete(subscription);
      };
    }
  };
}

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
function jsonRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function sameJson(a, b) {
  if (a === b)
    return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => sameJson(value, b[index]));
  }
  if (!jsonRecord(a) || !jsonRecord(b))
    return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}
function ownField(object, key) {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}
function rebaseField(before, after, confirmed, path) {
  if (sameJson(before, after))
    return confirmed;
  if (sameJson(before, confirmed) || sameJson(after, confirmed))
    return after;
  if (jsonRecord(before) && jsonRecord(after) && jsonRecord(confirmed)) {
    const result = Object.assign(Object.create(null), confirmed);
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key))
        delete result[key];
    }
    for (const [key, value] of Object.entries(after)) {
      const next = rebaseField(ownField(before, key), value, ownField(confirmed, key), path + "." + key);
      if (next === undefined)
        delete result[key];
      else
        result[key] = next;
    }
    return result;
  }
  if (Array.isArray(before) && Array.isArray(after) || jsonRecord(before) && jsonRecord(after)) {
    throw new Error(`Cannot confirm overlapping edits to ${path}`);
  }
  return after;
}
function confirmedUpdate(confirmed, changes, original) {
  if (!original)
    return { ...confirmed, ...changes };
  const fields = Object.keys(changes);
  const updates = fields.map((key) => {
    const before = ownField(original, key), after = changes[key];
    if (before === after)
      return [key, ownField(confirmed, key)];
    if (before == null || after == null || typeof before !== "object" || typeof after !== "object")
      return [key, after];
    const pair = JSON.parse(JSON.stringify({ before, after }));
    return [key, rebaseField(pair.before, pair.after, ownField(confirmed, key), key)];
  });
  return { ...confirmed, ...Object.fromEntries(updates) };
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
function writeSyncBatch(sync, write) {
  sync.begin();
  try {
    write();
  } catch (error) {
    return rejectSyncWrite(sync, error);
  }
  return sync.commit();
}
function writeSyncRows(sync, messages) {
  return writeSyncBatch(sync, () => {
    for (const message of messages) {
      if ("value" in message)
        sync.write({ type: message.type, value: structuredClone(message.value) });
      else
        sync.write(message);
    }
  });
}
function isPending(input) {
  return typeof input?.then === "function";
}
function membershipOptions(id, memberKey, rowForKey) {
  const membership = new Set;
  let version = 0;
  let active;
  let latest;
  function difference(keys, excluded) {
    const result = [];
    for (const key of keys)
      if (!excluded.has(key))
        result.push(key);
    return result;
  }
  function writeChanges(params, { added, removed }) {
    if (!added.length && !removed.length)
      return;
    return writeSyncBatch(params, () => {
      for (const key of removed)
        params.write({ type: "delete", value: rowForKey(key) });
      for (const key of added)
        params.write({ type: "insert", value: rowForKey(key) });
    });
  }
  function keys(items) {
    if (!Array.isArray(items))
      throw new TypeError("Expected an array of spatial query results");
    const result = new Set;
    for (const item of items)
      result.add(memberKey(item));
    return result;
  }
  function accept({ added, removed }) {
    for (const key of removed)
      membership.delete(key);
    for (const key of added)
      membership.add(key);
    version++;
    return true;
  }
  async function publish(input, capture, current = () => true) {
    if (!current()) {
      if (isPending(input))
        Promise.resolve(input).catch(() => {});
      return false;
    }
    const request = {};
    latest = request;
    let value;
    try {
      value = isPending(input) ? await input : input;
    } catch (error) {
      if (request !== latest || !current())
        return false;
      throw error;
    }
    if (request !== latest || !current())
      return false;
    const changes = capture(value);
    const run = active;
    if (!run)
      return accept(changes());
    const publication = run.pending.then(async () => {
      if (request !== latest || active !== run || !current())
        return false;
      const delta = changes();
      const receipt = writeChanges(run.params, delta);
      if (receipt && receipt !== true)
        await receipt;
      if (active !== run)
        return false;
      return accept(delta);
    });
    run.pending = publication.then(() => {}, () => {});
    return publication;
  }
  function setMembers(input) {
    return publish(input, (items) => {
      const next = keys(items);
      return () => ({ added: difference(next, membership), removed: difference(membership, next) });
    });
  }
  function applyChanges(input, expectedVersion) {
    return publish(input, (delta) => {
      const added = keys(delta.added), removed = keys(delta.removed);
      for (const key of added)
        if (removed.has(key))
          throw new RangeError("A membership key cannot be both added and removed");
      return () => ({
        added: difference(added, membership),
        removed: Array.from(removed).filter((key) => membership.has(key))
      });
    }, () => version === expectedVersion);
  }
  const options = {
    id,
    getKey: (row) => row.id,
    startSync: true,
    gcTime: 0,
    sync: {
      sync(params) {
        if (active)
          throw new Error("Membership sync is already active");
        const run = { params, pending: Promise.resolve() };
        active = run;
        const close = () => {
          if (active !== run)
            return;
          active = undefined;
          latest = undefined;
        };
        try {
          const existing = new Set(params.collection.keys());
          const seed = writeChanges(params, { added: difference(membership, existing), removed: difference(existing, membership) });
          if (seed && seed !== true) {
            run.pending = seed.then(() => {
              if (active === run)
                params.markReady();
            }, (error) => {
              if (active === run) {
                close();
                params.markError?.(error);
              }
            });
          } else
            params.markReady();
        } catch (error) {
          close();
          throw error;
        }
        return close;
      }
    }
  };
  return { options, setMembers, applyChanges, getVersion: () => version };
}
function viewportCollectionConfig({ id }) {
  const { setMembers, applyChanges, getVersion, options } = membershipOptions(id, (key) => {
    if (typeof key !== "string" && !Number.isFinite(key))
      throw new TypeError("Viewport IDs must be strings or finite numbers");
    return key;
  }, (id) => ({ id }));
  return { ...options, utils: { setVisibleIds: setMembers, applyVisibleChanges: applyChanges, getVersion } };
}
function spatialJoinCollectionConfig({ id }) {
  const { setMembers, applyChanges, getVersion, options } = membershipOptions(id, (pair) => {
    if (!Array.isArray(pair) || pair.length !== 2)
      throw new TypeError("Expected a pair of spatial feature IDs");
    checkSpatialId(pair[0]);
    checkSpatialId(pair[1]);
    return pair[0] + ":" + pair[1];
  }, (id) => {
    const separator = id.indexOf(":");
    return { id, leftId: Number(id.slice(0, separator)), rightId: Number(id.slice(separator + 1)) };
  });
  return { ...options, utils: {
    setPairs: setMembers,
    getVersion,
    applyPairChanges: (delta, expectedVersion) => applyChanges(delta, expectedVersion)
  } };
}
function sharedCollectionConfig(config) {
  const { id, primaryKey = "id" } = config;
  let initialRows = config.initialData;
  const getKey = (row) => stringKey(row, primaryKey);
  let collection = new SharedCollection(id);
  let active;
  let pending = Promise.resolve();
  const confirmations = new WeakMap;
  const listeners = new Set;
  function install(next) {
    if (next.getSnapshot() === collection.getSnapshot())
      return;
    collection = next;
    notifySubscribers(listeners, (error) => console.error("[zerocopy/tanstack] snapshot listener failed", error));
  }
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
      for (const { type, modified, changes, original } of mutations) {
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
            value = confirmedUpdate(confirmed, changes, original);
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
      install(next);
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
          initialRows = undefined;
          install(next);
          if (active === params)
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
    subscribe: (listener) => {
      const subscription = () => listener();
      listeners.add(subscription);
      return () => {
        listeners.delete(subscription);
      };
    },
    getSharedState: () => ({ id, root: collection.getRoot(), size: collection.size }),
    fromSharedState: (state) => {
      const restored = SharedCollection.fromRoot(id, state.root, state.size);
      initialRows = undefined;
      install(restored);
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
  spatialJoinCollectionConfig,
  viewportCollectionConfig,
  withConfirmedSharedCache,
  withSharedCache
};
