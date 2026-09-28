import {
  Snapshot
} from "./chunk-73x5aaea.js";
import {
  getWorkerData2,
  initWorker2
} from "./chunk-5p5nefz2.js";

// worker-protocol.ts
var PROTOCOL = "zerocopy/session";
var WIRE_VERSION = 1;
function errorOf(value) {
  return value instanceof Error ? value : new Error(String(value));
}
function report(handler, error) {
  try {
    if (handler)
      handler(errorOf(error));
    else
      console.error("[zerocopy/worker]", error);
  } catch (failure) {
    console.error("[zerocopy/worker] onError failed", failure);
  }
}
function notify(listeners, value, version, onError) {
  for (const listener of [...listeners]) {
    try {
      const result = listener(value, version);
      if (result && typeof result.then === "function")
        Promise.resolve(result).catch((error) => report(onError, error));
    } catch (error) {
      report(onError, error);
    }
  }
}
var nextId = 0;
function uniqueId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${++nextId}`;
}
function settings(options) {
  const channel = options.channel ?? "default";
  const timeoutMs = options.timeoutMs ?? 1e4;
  const maxPending = options.maxPending ?? 32;
  const delivery = options.delivery ?? "latest";
  if (typeof channel !== "string" || !channel.length)
    throw new TypeError("channel must be a non-empty string");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("timeoutMs must be positive");
  if (!Number.isSafeInteger(maxPending) || maxPending < 1)
    throw new RangeError("maxPending must be a positive integer");
  if (delivery !== "latest" && delivery !== "all")
    throw new TypeError("Invalid delivery strategy");
  if (options.copy !== undefined && typeof options.copy !== "boolean")
    throw new TypeError("copy must be boolean");
  return { channel, timeoutMs, maxPending, delivery, copy: options.copy ?? typeof Bun !== "undefined" };
}
function strategy(options) {
  const value = options.publish?.strategy ?? "microtask";
  if (value !== "microtask" && value !== "immediate")
    throw new TypeError("Invalid publish strategy");
  return value;
}
function recordOf(value) {
  if (value instanceof Snapshot)
    return { single: true, structures: { value } };
  if (!value || typeof value !== "object" || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Shared state must be a collection or a plain record of collections");
  }
  if (Object.getOwnPropertySymbols(value).some((key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable)) {
    throw new TypeError("Shared state cannot have enumerable symbol keys");
  }
  const structures = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable)
      continue;
    if (!("value" in descriptor))
      throw new TypeError("Shared state cannot have getters or setters");
    structures[key] = descriptor.value;
  }
  return { single: false, structures };
}
function identities(data) {
  const result = Object.create(null);
  for (const [name, item] of Object.entries(data.structures)) {
    result[name] = JSON.stringify([item.type, item.arena, item.data]);
  }
  return Object.freeze(result);
}
function capture(value) {
  const { single, structures } = recordOf(value);
  const data = getWorkerData2(structures, { copy: false });
  return { value: single ? value : Object.freeze(structures), single, data, identities: identities(data) };
}
function same(a, b) {
  const keys = Object.keys(a.identities);
  return a.single === b.single && keys.length === Object.keys(b.identities).length && keys.every((key) => a.identities[key] === b.identities[key]);
}
function isMessage(value, channel) {
  return value?.protocol === PROTOCOL && value.channel === channel;
}
function message(channel, fields) {
  return { protocol: PROTOCOL, version: WIRE_VERSION, channel, ...fields };
}
var reservations = new WeakMap;
function reserve(endpoint, key) {
  let keys = reservations.get(endpoint);
  if (!keys)
    reservations.set(endpoint, keys = new Set);
  if (keys.has(key))
    throw new Error(`A session already uses this endpoint and channel (${key})`);
  keys.add(key);
  return () => {
    keys.delete(key);
    if (!keys.size)
      reservations.delete(endpoint);
  };
}
function defaultEndpoint() {
  if (typeof document !== "undefined" || typeof globalThis.postMessage !== "function") {
    throw new Error("Pass endpoint explicitly outside a browser worker (for Node, use parentPort)");
  }
  return globalThis;
}
function listen(endpoint, receive, fail) {
  if (!endpoint || typeof endpoint.postMessage !== "function")
    throw new TypeError("Invalid shared-session endpoint");
  const remove = [];
  if (endpoint.addEventListener && endpoint.removeEventListener) {
    const onMessage = (event) => receive(event.data);
    const onError = (event) => fail(errorOf(event.error ?? event.message ?? "Worker message error"));
    endpoint.addEventListener("message", onMessage);
    endpoint.addEventListener("messageerror", onError);
    endpoint.addEventListener("error", onError);
    remove.push(() => {
      endpoint.removeEventListener("message", onMessage);
      endpoint.removeEventListener("messageerror", onError);
      endpoint.removeEventListener("error", onError);
    });
  } else if (endpoint.on && endpoint.off) {
    const onError = (error) => fail(errorOf(error));
    endpoint.on("message", receive);
    endpoint.on("messageerror", onError);
    endpoint.on("error", onError);
    remove.push(() => {
      endpoint.off("message", receive);
      endpoint.off("messageerror", onError);
      endpoint.off("error", onError);
    });
  } else
    throw new TypeError("Endpoint must support addEventListener/removeEventListener or on/off");
  if (endpoint.on && endpoint.off) {
    const onClose = () => fail(new Error("Worker or port closed"));
    endpoint.on("exit", onClose);
    endpoint.on("close", onClose);
    remove.push(() => {
      endpoint.off("exit", onClose);
      endpoint.off("close", onClose);
    });
  }
  try {
    endpoint.start?.();
  } catch (error) {
    for (const cleanup of remove)
      cleanup();
    throw error;
  }
  return () => {
    for (const cleanup of remove)
      cleanup();
  };
}

// worker-tasks.ts
var PROTOCOL2 = "zerocopy/tasks";
var VERSION = 1;
var clients = 0;
function endpointOf(value) {
  const endpoint = value?.port ?? value;
  if (!endpoint || typeof endpoint.postMessage !== "function")
    throw new TypeError("Expected a Worker, SharedWorker, or MessagePort");
  endpoint.start?.();
  return endpoint;
}
function listen2(endpoint, receive, fail) {
  if (endpoint.addEventListener && endpoint.removeEventListener) {
    const onMessage = (event) => receive(event.data), onError = (event) => fail(event.error instanceof Error ? event.error : new Error(event.message ?? "Worker error"));
    endpoint.addEventListener("message", onMessage);
    endpoint.addEventListener("messageerror", onError);
    endpoint.addEventListener("error", onError);
    return () => {
      endpoint.removeEventListener("message", onMessage);
      endpoint.removeEventListener("messageerror", onError);
      endpoint.removeEventListener("error", onError);
    };
  }
  if (endpoint.on && endpoint.off) {
    const onError = (error) => fail(error instanceof Error ? error : new Error(String(error)));
    endpoint.on("message", receive);
    endpoint.on("messageerror", onError);
    endpoint.on("error", onError);
    return () => {
      endpoint.off("message", receive);
      endpoint.off("messageerror", onError);
      endpoint.off("error", onError);
    };
  }
  throw new TypeError("Endpoint does not support message events");
}
function msg(channel, client, fields) {
  return { protocol: PROTOCOL2, version: VERSION, channel, client, ...fields };
}
function valid(value, channel) {
  return value?.protocol === PROTOCOL2 && value.version === VERSION && value.channel === channel && typeof value.client === "string";
}
function sourceOf(state) {
  return state && typeof state.getSnapshot === "function" && typeof state.subscribe === "function" ? state : { getSnapshot: () => state, subscribe: () => () => {} };
}
function defineTasks2() {
  return (tasks) => Object.freeze({ ...tasks });
}
function releaseResource(resource) {
  try {
    Promise.resolve(resource.terminate?.()).catch(() => {});
  } catch {}
  try {
    resource.port?.close?.();
  } catch {}
}
function report2(options, error) {
  try {
    options.onError?.(error);
  } catch (failure) {
    console.error("[zerocopy/worker]", failure);
  }
}
function client(resource, options, owned) {
  if (options.memory !== undefined && options.memory !== "share" && options.memory !== "copy") {
    throw new TypeError("memory must be share or copy");
  }
  const endpoint = endpointOf(resource), channel = options.channel ?? "default";
  const clientId = Date.now().toString(36) + "-" + ++clients;
  const source = sourceOf(options.state);
  let closed = false, id = 0, constructed = false;
  let state;
  let remove = () => {};
  let timer;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  ready.catch(() => {});
  const pending = new Map;
  function close(error, releaseOwned = true) {
    if (closed)
      return;
    closed = true;
    clearTimeout(timer);
    try {
      endpoint.postMessage(msg(channel, clientId, { kind: "close" }));
    } catch {}
    remove();
    state?.dispose();
    readyReject(error);
    for (const item of pending.values()) {
      item.cleanup();
      item.complete();
      item.reject(error);
    }
    pending.clear();
    if (owned && releaseOwned && constructed)
      releaseResource(resource);
  }
  function fail(error) {
    close(error);
    report2(options, error);
  }
  let stateReady;
  try {
    state = createSharedSession2({ source }, {
      channel: "tasks:" + channel + ":" + clientId,
      copy: options.memory === undefined ? undefined : options.memory === "copy",
      timeoutMs: options.timeoutMs,
      onError: (error) => fail(error)
    });
    if (closed)
      throw new Error("Shared state initialization failed");
    remove = listen2(endpoint, (data) => {
      if (!valid(data, channel) || data.client !== clientId)
        return;
      if (data.kind === "ready") {
        readyResolve();
        return;
      }
      if (data.kind === "close") {
        close(new Error(data.message ?? "Task server closed"));
        return;
      }
      if ((data.kind === "result" || data.kind === "error") && data.id !== undefined) {
        const item = pending.get(data.id);
        if (!item)
          return;
        pending.delete(data.id);
        item.cleanup();
        item.complete();
        data.kind === "result" ? item.resolve(data.value) : item.reject(new Error(data.message ?? "Worker task failed"));
      }
    }, fail);
    stateReady = Promise.all([state.connect(endpoint), ready]).then(() => {
      clearTimeout(timer);
    });
    stateReady.catch(() => {});
    timer = setTimeout(() => fail(new Error("Worker executor handshake timed out")), options.timeoutMs ?? 1e4);
    endpoint.postMessage(msg(channel, clientId, { kind: "hello" }));
  } catch (error) {
    close(error instanceof Error ? error : new Error(String(error)), false);
    throw error;
  }
  function invoke(task, input, call = {}) {
    let complete;
    const settled = new Promise((resolve) => {
      complete = resolve;
    });
    const result = new Promise((resolve, reject) => {
      try {
        if (closed)
          throw new Error("Worker executor is closed");
        if (call.signal?.aborted)
          throw call.signal.reason ?? new Error("Task aborted");
        if (call.timeoutMs !== undefined && (!Number.isFinite(call.timeoutMs) || call.timeoutMs <= 0)) {
          throw new RangeError("timeoutMs must be positive");
        }
        const revision = state.publish(source.getSnapshot());
        if (closed)
          throw new Error("Worker executor is closed");
        if (id === Number.MAX_SAFE_INTEGER)
          throw new RangeError("Task IDs exhausted");
        const callId = ++id;
        let callTimer;
        const cleanup = () => {
          clearTimeout(callTimer);
          call.signal?.removeEventListener("abort", abort);
        };
        const cancel = (error) => {
          if (!pending.has(callId))
            return;
          cleanup();
          reject(error);
          try {
            endpoint.postMessage(msg(channel, clientId, { kind: "cancel", id: callId }));
          } catch (failure) {
            fail(failure instanceof Error ? failure : new Error(String(failure)));
          }
        };
        const abort = () => cancel(call.signal?.reason instanceof Error ? call.signal.reason : new Error("Task aborted"));
        pending.set(callId, { resolve, reject, cleanup, complete });
        call.signal?.addEventListener("abort", abort, { once: true });
        if (call.timeoutMs !== undefined)
          callTimer = setTimeout(() => cancel(new Error("Worker task timed out")), call.timeoutMs);
        try {
          endpoint.postMessage(msg(channel, clientId, { kind: "call", id: callId, task, input, revision }));
        } catch (error) {
          pending.delete(callId);
          cleanup();
          complete();
          reject(error);
        }
      } catch (error) {
        complete();
        reject(error);
      }
    });
    return Object.assign(result, { settled });
  }
  const methods = Object.create(null);
  const run = new Proxy(methods, { get: (_target, key) => {
    if (typeof key !== "string")
      return;
    return methods[key] ??= (input, call) => invoke(key, input, call);
  } });
  constructed = true;
  return { run, _ready: stateReady, get closed() {
    return closed;
  }, dispose() {
    close(new Error("Worker executor is closed"));
  } };
}
async function connect2(endpoint, options) {
  const value = client(endpoint, options, false);
  try {
    await value._ready;
    return value;
  } catch (error) {
    value.dispose();
    throw error;
  }
}
async function spawn2(factory, options) {
  const resource = factory();
  let value;
  try {
    value = client(resource, options, true);
    await value._ready;
    return value;
  } catch (error) {
    if (value)
      value.dispose();
    else
      releaseResource(resource);
    throw error;
  }
}
function local2(tasks, options) {
  let closed = false;
  const source = sourceOf(options.state);
  const run = Object.fromEntries(Object.entries(tasks).map(([name, task]) => [name, async (input, call = {}) => {
    if (closed)
      throw new Error("Worker executor is closed");
    if (call.signal?.aborted)
      throw call.signal.reason ?? new Error("Task aborted");
    const controller = new AbortController;
    const abort = () => controller.abort(call.signal?.reason);
    call.signal?.addEventListener("abort", abort, { once: true });
    let timer;
    if (call.timeoutMs)
      timer = setTimeout(() => controller.abort(new Error("Worker task timed out")), call.timeoutMs);
    try {
      return await task({ state: source.getSnapshot(), signal: controller.signal }, input);
    } finally {
      if (timer)
        clearTimeout(timer);
      call.signal?.removeEventListener("abort", abort);
    }
  }]));
  return { run, get closed() {
    return closed;
  }, dispose() {
    closed = true;
  } };
}
async function atRevision(reader, revision, signal) {
  signal.throwIfAborted();
  if (reader.closed)
    throw new Error("Shared state reader closed");
  if (revision === undefined || reader.version >= revision)
    return reader.current;
  const snapshots = reader.snapshots({ emitCurrent: false, signal });
  for await (const value of snapshots)
    if (reader.version >= revision)
      return value;
  throw new Error("Shared state reader closed");
}
async function serve2(tasks, options = {}) {
  const endpoint = endpointOf(options.endpoint ?? globalThis), channel = options.channel ?? "default";
  const readers = new Map, running = new Map;
  let closed = false;
  const remove = listen2(endpoint, (data) => {
    if (closed || !valid(data, channel))
      return;
    if (data.kind === "hello") {
      if (!readers.has(data.client)) {
        const reader = connectSharedSession2({ endpoint, channel: "tasks:" + channel + ":" + data.client, timeoutMs: options.timeoutMs, onError: options.onError });
        readers.set(data.client, reader);
        running.set(data.client, new Map);
        reader.catch((error) => {
          try {
            endpoint.postMessage(msg(channel, data.client, { kind: "close", message: error instanceof Error ? error.message : String(error) }));
          } catch {}
          report2(options, error instanceof Error ? error : new Error(String(error)));
        });
      }
      endpoint.postMessage(msg(channel, data.client, { kind: "ready" }));
      return;
    }
    if (data.kind === "close") {
      for (const controller of running.get(data.client)?.values() ?? [])
        controller.abort(new Error("Task client closed"));
      readers.get(data.client)?.then((r) => r.dispose()).catch(() => {});
      readers.delete(data.client);
      running.delete(data.client);
      return;
    }
    if (data.kind === "cancel" && data.id !== undefined) {
      running.get(data.client)?.get(data.id)?.abort(new Error("Task aborted"));
      return;
    }
    if (data.kind !== "call" || typeof data.id !== "number" || !Number.isSafeInteger(data.id) || data.id < 1 || typeof data.task !== "string" || !readers.has(data.client))
      return;
    const task = Object.hasOwn(tasks, data.task) ? tasks[data.task] : undefined;
    if (typeof task !== "function") {
      endpoint.postMessage(msg(channel, data.client, { kind: "error", id: data.id, message: "Unknown task: " + data.task }));
      return;
    }
    const callId = data.id, controller = new AbortController;
    running.get(data.client)?.set(callId, controller);
    Promise.resolve(readers.get(data.client)).then((reader) => {
      if (!reader)
        throw new Error("Task client has no shared state");
      return atRevision(reader, data.revision, controller.signal).then((snapshot) => {
        controller.signal.throwIfAborted();
        return task({ state: snapshot, signal: controller.signal }, data.input);
      });
    }).then((value) => {
      if (!closed)
        endpoint.postMessage(msg(channel, data.client, { kind: "result", id: callId, value }));
    }).catch((error) => {
      if (!closed)
        endpoint.postMessage(msg(channel, data.client, { kind: "error", id: callId, message: error instanceof Error ? error.message : String(error) }));
    }).finally(() => running.get(data.client)?.delete(callId)).catch((error) => report2(options, error instanceof Error ? error : new Error(String(error))));
  }, (error) => options.onError?.(error));
  return () => {
    if (closed)
      return;
    closed = true;
    remove();
    for (const clientId of readers.keys()) {
      try {
        endpoint.postMessage(msg(channel, clientId, { kind: "close", message: "Task server closed" }));
      } catch {}
    }
    for (const m of running.values())
      for (const c of m.values())
        c.abort(new Error("Task server closed"));
    for (const r of readers.values())
      r.then((x) => x.dispose()).catch(() => {});
    readers.clear();
    running.clear();
  };
}
async function pool2(workers, options) {
  const owned = !Array.isArray(workers);
  const size = owned ? options.size ?? Math.max(1, Math.min(4, typeof navigator === "undefined" ? 4 : navigator.hardwareConcurrency || 4)) : workers.length;
  if (!Number.isSafeInteger(size) || size < 1)
    throw new RangeError("Pool size must be a positive integer");
  const max = options.maxPending ?? 128;
  if (!Number.isSafeInteger(max) || max < 0)
    throw new RangeError("maxPending must be a non-negative integer");
  const resources = [];
  const executors = [];
  try {
    if (owned)
      for (let index = 0;index < size; index++)
        resources.push(workers());
    else
      resources.push(...workers);
    for (const resource of resources)
      executors.push(client(resource, options, owned));
    await Promise.all(executors.map((executor) => executor._ready));
  } catch (error) {
    for (const executor of executors)
      executor.dispose();
    if (owned)
      for (const resource of resources.slice(executors.length))
        releaseResource(resource);
    throw error;
  }
  let closed = false;
  const idle = executors.slice();
  const queue = [];
  const schedule = (operation) => new Promise((resolve, reject) => {
    if (closed) {
      reject(new Error("Worker pool is closed"));
      return;
    }
    if (!idle.length && queue.length >= max) {
      reject(new Error("Worker pool queue overflow"));
      return;
    }
    const item = { reject, run(executor) {
      let released = false;
      const release = () => {
        if (released)
          return;
        released = true;
        if (closed)
          return;
        const next = queue.shift();
        if (next)
          next.run(executor);
        else
          idle.push(executor);
      };
      let result;
      try {
        result = operation(executor);
      } catch (error) {
        release();
        reject(error);
        return;
      }
      const completed = result.settled ?? result.then(() => {}, () => {});
      completed.then(release);
      result.then((value) => completed.then(() => {
        release();
        resolve(value);
      }), reject);
    } };
    const executor = idle.shift();
    if (executor)
      item.run(executor);
    else
      queue.push(item);
  });
  const run = new Proxy(Object.create(null), { get: (_t, key) => typeof key === "string" ? (input, call) => schedule((e) => e.run[key](input, call)) : undefined });
  const map = new Proxy(Object.create(null), { get: (_t, key) => typeof key === "string" ? async (inputs, call) => {
    if (closed)
      throw new Error("Worker pool is closed");
    if (call?.signal?.aborted)
      throw call.signal.reason ?? new Error("Task aborted");
    const results = new Array(inputs.length);
    const width = call?.chunkSize ?? size;
    if (!Number.isSafeInteger(width) || width < 1)
      throw new RangeError("chunkSize must be a positive integer");
    if (!inputs.length)
      return results;
    let next = 0, failed = false;
    const feed = async () => {
      try {
        while (!failed) {
          const index = next++;
          if (index >= inputs.length)
            return;
          results[index] = await schedule((e) => e.run[key](inputs[index], call));
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, size, inputs.length) }, () => feed()));
    return results;
  } : undefined });
  return { run, map, size, get closed() {
    return closed;
  }, dispose() {
    if (closed)
      return;
    closed = true;
    const error = new Error("Worker pool is closed");
    for (const q of queue.splice(0))
      q.reject(error);
    for (const e of executors)
      e.dispose();
  } };
}

// worker.ts
class Publisher {
  options;
  state;
  published;
  sequence = 0;
  disposed = false;
  scheduled = false;
  depth = 0;
  updating = false;
  unsubscribeSource;
  peers = new Map;
  listeners = new Set;
  config;
  publishStrategy;
  owner = uniqueId();
  ready = Promise.resolve();
  constructor(initial, options) {
    this.options = options;
    this.config = settings(options);
    this.publishStrategy = strategy(options);
    this.state = this.published = capture(initial);
  }
  assertOpen() {
    if (this.disposed)
      throw new Error("Shared session is closed");
  }
  get current() {
    this.assertOpen();
    return this.state.value;
  }
  get value() {
    return this.current;
  }
  set value(next) {
    this.update(() => next);
  }
  get version() {
    return this.sequence;
  }
  get closed() {
    return this.disposed;
  }
  getSnapshot = () => this.current;
  subscribe = (listener) => {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(next) {
    this.assertOpen();
    const captured = capture(next);
    this.assertOpen();
    if (captured.single !== this.state.single)
      throw new TypeError("Cannot change between single-collection and record state");
    if (same(this.state, captured))
      return false;
    this.state = captured;
    return true;
  }
  commit() {
    this.assertOpen();
    if (this.depth || same(this.state, this.published))
      return this.sequence;
    if (this.sequence === Number.MAX_SAFE_INTEGER)
      throw new RangeError("Session version exhausted");
    const committed = this.state;
    this.published = committed;
    const version = ++this.sequence;
    const frame = { ...committed, sequence: version };
    for (const peer of [...this.peers.values()])
      peer.send(frame);
    notify(this.listeners, committed.value, version, this.options.onError);
    return version;
  }
  publish(next) {
    this.set(next);
    return this.flush();
  }
  flush() {
    this.scheduled = false;
    return this.commit();
  }
  schedule() {
    if (this.depth || this.scheduled)
      return;
    if (this.publishStrategy === "immediate") {
      this.commit();
      return;
    }
    this.scheduled = true;
    queueMicrotask(() => {
      if (this.disposed || !this.scheduled)
        return;
      this.scheduled = false;
      try {
        this.commit();
      } catch (error) {
        this.dispose();
        report(this.options.onError, error);
      }
    });
  }
  update(keyOrRecipe, recipe) {
    this.assertOpen();
    if (this.updating)
      throw new Error("Shared-state recipes must not call update recursively");
    this.updating = true;
    let changed = false;
    try {
      const run = (fn, current) => {
        const result = fn(current);
        if (result && typeof result.then === "function") {
          Promise.resolve(result).catch((error) => report(this.options.onError, error));
          throw new TypeError("Shared-state recipes must be synchronous");
        }
        return result;
      };
      if (typeof keyOrRecipe === "function" && recipe === undefined)
        changed = this.set(run(keyOrRecipe, this.current));
      else {
        if (this.state.single || !Object.hasOwn(this.current, keyOrRecipe) || typeof recipe !== "function") {
          throw new TypeError("update(key, recipe) requires an existing record key");
        }
        const value = run(recipe, this.current[keyOrRecipe]);
        changed = this.set({ ...this.current, [keyOrRecipe]: value });
      }
    } finally {
      this.updating = false;
    }
    if (changed)
      this.schedule();
  }
  batch(action) {
    this.assertOpen();
    this.depth++;
    try {
      const result = action();
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch((error) => report(this.options.onError, error));
        throw new TypeError("batch callbacks must be synchronous");
      }
    } finally {
      if (--this.depth === 0 && !this.disposed)
        this.schedule();
    }
  }
  bind(source) {
    const refresh = () => {
      if (this.disposed)
        return;
      try {
        if (this.set(source.getSnapshot()))
          this.schedule();
      } catch (error) {
        this.dispose();
        report(this.options.onError, error);
      }
    };
    const unsubscribe = source.subscribe(refresh);
    if (typeof unsubscribe !== "function")
      throw new TypeError("Source.subscribe must return an unsubscribe function");
    if (this.disposed)
      unsubscribe();
    else
      this.unsubscribeSource = unsubscribe;
    refresh();
  }
  start() {
    if (this.options.workers) {
      this.ready = this.connect(this.options.workers);
      this.ready.catch((error) => report(this.options.onError, error));
    }
    return this;
  }
  connect(endpoint, options = {}) {
    this.assertOpen();
    if (Array.isArray(endpoint)) {
      const added = endpoint.filter((item) => !this.peers.has(item));
      try {
        return Promise.all(endpoint.map((item) => this.connect(item, options))).then(() => {
          return;
        }, (error) => {
          for (const item of added)
            this.disconnect(item);
          throw error;
        });
      } catch (error) {
        for (const item of added)
          this.disconnect(item);
        return Promise.reject(error);
      }
    }
    const target = endpoint;
    const existing = this.peers.get(target);
    if (existing)
      return existing.ready;
    if (options.signal?.aborted)
      return Promise.reject(errorOf(options.signal.reason ?? "Connection aborted"));
    this.flush();
    const release = reserve(target, `owner:${this.config.channel}`);
    let resolve, reject;
    const ready = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    ready.catch(() => {});
    let settled = false, closed = false, remove = () => {};
    let timer;
    const send = (fields) => target.postMessage(message(this.config.channel, { owner: this.owner, reader: peer.reader, ...fields }));
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => peer.close(new Error("Shared session timed out waiting for worker acknowledgement")), this.config.timeoutMs);
    };
    const abort = () => peer.close(errorOf(options.signal?.reason ?? "Connection aborted"));
    const peer = {
      endpoint: target,
      known: new Set,
      pending: [],
      ready,
      send: (frame) => {
        if (closed || !peer.reader)
          return;
        if (peer.flight) {
          if (this.config.delivery === "latest")
            peer.pending = [frame];
          else if (peer.pending.length < this.config.maxPending)
            peer.pending.push(frame);
          else
            peer.close(new Error("Shared session pending queue overflow"));
          return;
        }
        try {
          const arenas = frame.data.arenas.map((source) => {
            if (this.config.copy)
              return { id: source.id, used: source.used, copy: new Uint8Array(source.memory.buffer, 0, source.used).slice() };
            return peer.known.has(source.id) ? { id: source.id, used: source.used } : source;
          });
          peer.flight = frame;
          arm();
          send({ kind: "snapshot", sequence: frame.sequence, single: frame.single, data: { ...frame.data, arenas } });
        } catch (error) {
          peer.close(errorOf(error));
        }
      },
      close: (error, remote = false) => {
        if (closed)
          return;
        closed = true;
        clearTimeout(timer);
        remove();
        release();
        options.signal?.removeEventListener("abort", abort);
        this.peers.delete(target);
        if (!remote) {
          try {
            send({ kind: error ? "error" : "close", message: error?.message });
          } catch {}
        }
        peer.flight = undefined;
        peer.pending = [];
        peer.known.clear();
        if (!settled) {
          settled = true;
          reject(error ?? new Error("Shared connection closed before initialization"));
        } else if (error)
          report(this.options.onError, error);
      }
    };
    this.peers.set(target, peer);
    try {
      remove = listen(target, (data) => {
        if (closed || !isMessage(data, this.config.channel))
          return;
        if (data.version !== WIRE_VERSION) {
          peer.close(new Error("Unsupported session protocol version"));
          return;
        }
        if (data.kind === "ready") {
          if (typeof data.reader !== "string" || !data.reader)
            return;
          if (peer.reader)
            return;
          peer.reader = data.reader;
          peer.send({ ...this.published, sequence: this.sequence });
          return;
        }
        if (data.owner !== this.owner || data.reader !== peer.reader)
          return;
        if (data.kind === "close" || data.kind === "error") {
          peer.close(data.kind === "error" ? new Error(data.message ?? "Reader failed") : undefined, true);
          return;
        }
        if (data.kind !== "ack" || !peer.flight || data.sequence !== peer.flight.sequence)
          return;
        peer.known = new Set(peer.flight.data.arenas.map((arena) => arena.id));
        peer.flight = undefined;
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve();
        }
        const next = peer.pending.shift();
        if (next)
          peer.send(next);
      }, (error) => peer.close(error));
      options.signal?.addEventListener("abort", abort, { once: true });
      arm();
      send({ kind: "offer" });
    } catch (error) {
      peer.close(errorOf(error));
    }
    return ready;
  }
  disconnect(endpoint) {
    this.peers.get(endpoint)?.close();
  }
  dispose() {
    if (this.disposed)
      return;
    this.disposed = true;
    this.scheduled = false;
    try {
      this.unsubscribeSource?.();
    } catch (error) {
      report(this.options.onError, error);
    }
    this.unsubscribeSource = undefined;
    for (const peer of [...this.peers.values()])
      peer.close();
    this.listeners.clear();
    this.state = this.published = undefined;
  }
}
function createSharedState2(initial, options = {}) {
  return new Publisher(initial, options).start();
}
function createSharedSession2(input, options = {}) {
  const source = input.source;
  if (source && typeof source.getSnapshot === "function" && typeof source.subscribe === "function") {
    const session = new Publisher(source.getSnapshot(), options);
    try {
      session.bind(source);
      return session.start();
    } catch (error) {
      session.dispose();
      throw error;
    }
  }
  return new Publisher(input, options).start();
}

class Reader {
  closeTransport;
  onError;
  state;
  sequence = -1;
  disposed = false;
  listeners = new Set;
  endings = new Set;
  constructor(closeTransport, onError) {
    this.closeTransport = closeTransport;
    this.onError = onError;
  }
  get current() {
    if (this.disposed || this.state === undefined)
      throw new Error("Shared reader is not open");
    return this.state;
  }
  get version() {
    return this.sequence;
  }
  get closed() {
    return this.disposed;
  }
  getSnapshot = () => this.current;
  subscribe = (listener) => {
    if (this.disposed)
      throw new Error("Shared reader is closed");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  accept(value, version) {
    if (this.disposed)
      return;
    this.state = value;
    this.sequence = version;
    notify(this.listeners, value, version, this.onError);
  }
  finish(error) {
    if (this.disposed)
      return;
    this.disposed = true;
    for (const end of [...this.endings])
      end(error);
    this.endings.clear();
    this.listeners.clear();
    this.state = undefined;
  }
  dispose() {
    if (!this.disposed) {
      this.closeTransport();
      this.finish();
    }
  }
  snapshots(options = {}) {
    if (this.disposed)
      throw new Error("Shared reader is closed");
    const mode = options.strategy ?? "latest", capacity = options.capacity ?? 32;
    if (mode !== "latest" && mode !== "all")
      throw new TypeError("Invalid snapshot stream strategy");
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError("capacity must be positive");
    let queue = options.emitCurrent === false ? [] : [this.current];
    let done = false, failure;
    let waiter;
    let unsubscribe = () => {};
    const end = (error) => {
      if (done)
        return;
      done = true;
      failure = error;
      queue = [];
      unsubscribe();
      this.endings.delete(end);
      options.signal?.removeEventListener("abort", abort);
      if (waiter) {
        const pending = waiter;
        waiter = undefined;
        error ? pending.reject(error) : pending.resolve({ done: true, value: undefined });
      }
    };
    const abort = () => end(errorOf(options.signal?.reason ?? "Snapshot stream aborted"));
    unsubscribe = this.subscribe((value) => {
      if (waiter) {
        const pending = waiter;
        waiter = undefined;
        pending.resolve({ done: false, value });
      } else if (mode === "latest")
        queue = [value];
      else if (queue.length < capacity)
        queue.push(value);
      else
        end(new Error("Snapshot stream queue overflow"));
    });
    this.endings.add(end);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted)
      abort();
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => {
        if (failure)
          return Promise.reject(failure);
        if (done)
          return Promise.resolve({ done: true, value: undefined });
        if (queue.length)
          return Promise.resolve({ done: false, value: queue.shift() });
        if (waiter)
          return Promise.reject(new Error("Call snapshot iterator.next() sequentially"));
        return new Promise((resolve, reject) => {
          waiter = { resolve, reject };
        });
      },
      return: async () => {
        end();
        return { done: true, value: undefined };
      },
      throw: async (error) => {
        end(errorOf(error));
        throw error;
      }
    };
  }
}
function connectSharedSession2(options = {}) {
  const config = settings(options);
  const endpoint = options.endpoint ?? defaultEndpoint();
  if (options.signal?.aborted)
    return Promise.reject(errorOf(options.signal.reason ?? "Connection aborted"));
  const release = reserve(endpoint, `reader:${config.channel}`);
  const readerId = uniqueId();
  let owner, closed = false, initialized = false;
  let remove = () => {};
  let arenas = new Map;
  let previous = Object.create(null);
  let previousSingle;
  let chain = Promise.resolve();
  let resolve, reject;
  const ready = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  ready.catch(() => {});
  const send = (fields) => endpoint.postMessage(message(config.channel, { owner, reader: readerId, ...fields }));
  const shutdown = (error, remote = false) => {
    if (closed)
      return;
    closed = true;
    clearTimeout(timer);
    remove();
    release();
    options.signal?.removeEventListener("abort", abort);
    if (!remote) {
      try {
        send({ kind: error ? "error" : "close", message: error?.message });
      } catch {}
    }
    arenas.clear();
    previous = Object.create(null);
    reader.finish(error);
    if (!initialized)
      reject(error ?? new Error("Shared reader closed before initialization"));
    else if (error)
      report(options.onError, error);
  };
  const reader = new Reader(() => shutdown(), options.onError);
  const abort = () => shutdown(errorOf(options.signal?.reason ?? "Connection aborted"));
  const timer = setTimeout(() => shutdown(new Error("Shared reader timed out waiting for owner")), config.timeoutMs);
  const receive = async (data) => {
    if (closed)
      return;
    if (!Number.isSafeInteger(data.sequence) || data.sequence < 0 || typeof data.single !== "boolean" || !data.data)
      throw new Error("Invalid snapshot message");
    if (data.sequence <= reader.version)
      return;
    if (previousSingle !== undefined && data.single !== previousSingle)
      throw new Error("Snapshot shape changed");
    const payload = data.data;
    if (!Array.isArray(payload.arenas) || !payload.structures || typeof payload.structures !== "object")
      throw new Error("Invalid snapshot payload");
    const next = new Map;
    for (const source of payload.arenas) {
      if (typeof source.id !== "string" || !source.id || next.has(source.id))
        throw new Error("Invalid or duplicate arena");
      if (source.memory && source.copy)
        throw new Error("Ambiguous arena transport");
      const known = arenas.get(source.id);
      if (!source.memory && !source.copy && !known?.memory)
        throw new Error("Missing shared arena; reconnect the session");
      if (known?.memory && source.memory)
        throw new Error("An existing arena cannot replace its memory");
      next.set(source.id, source.memory || source.copy ? source : { ...source, memory: known.memory });
    }
    const values = await initWorker2({ ...payload, arenas: [...next.values()] });
    if (closed)
      return;
    const ids = identities(payload);
    const result = Object.create(null);
    for (const [key, value] of Object.entries(values)) {
      const oldValue = initialized ? data.single ? reader.current : reader.current[key] : undefined;
      result[key] = previous[key] === ids[key] && oldValue !== undefined ? oldValue : value;
    }
    if (data.single && (Object.keys(result).length !== 1 || !Object.hasOwn(result, "value")))
      throw new Error("Invalid single-collection snapshot");
    arenas = next;
    previous = ids;
    previousSingle = data.single;
    reader.accept(data.single ? result.value : Object.freeze(result), data.sequence);
    if (closed)
      return;
    send({ kind: "ack", sequence: data.sequence });
    if (!initialized) {
      initialized = true;
      clearTimeout(timer);
      resolve(reader);
    }
  };
  try {
    remove = listen(endpoint, (data) => {
      if (closed || !isMessage(data, config.channel))
        return;
      if (data.version !== WIRE_VERSION) {
        shutdown(new Error("Unsupported session protocol version"));
        return;
      }
      if (data.kind === "offer") {
        if (!owner || owner === data.owner)
          send({ kind: "ready" });
        return;
      }
      if (data.reader !== readerId || typeof data.owner !== "string")
        return;
      if (owner && data.owner !== owner)
        return;
      owner = data.owner;
      if (data.kind === "close" || data.kind === "error") {
        shutdown(data.kind === "error" ? new Error(data.message ?? "Owner failed") : undefined, true);
        return;
      }
      if (data.kind === "snapshot")
        chain = chain.then(() => receive(data)).catch((error) => shutdown(errorOf(error)));
    }, (error) => shutdown(error));
    options.signal?.addEventListener("abort", abort, { once: true });
    send({ kind: "ready" });
  } catch (error) {
    shutdown(errorOf(error));
  }
  return ready;
}
async function shareWithWorker2(endpoint, value, options = {}) {
  const session = createSharedSession2(value, options);
  try {
    await session.connect(endpoint);
  } finally {
    session.dispose();
  }
}
async function receiveShared2(options = {}) {
  const reader = await connectSharedSession2(options);
  const value = reader.current;
  reader.dispose();
  return value;
}

export { defineTasks2, connect2, spawn2, local2, serve2, pool2, createSharedState2, createSharedSession2, connectSharedSession2, shareWithWorker2, receiveShared2 };
