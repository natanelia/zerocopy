/** Typed, single-writer snapshot sessions. No polling, shared locks, or store dependency. */
import { initWorker, type WorkerData } from './shared';
import {
  capture, same, identities, message, isMessage, listen, reserve, settings, strategy,
  uniqueId, defaultEndpoint, report, errorOf, notify, WIRE_VERSION,
  type Capture, type Frame, type Message, type ArenaWire,
  type SharedCollection, type SharedValue, type SharedSource, type SharedEndpoint,
  type SessionOptions, type StateOptions,
} from './worker-protocol';
export type { SharedCollection, SharedValue, SharedSource, SharedEndpoint, SessionOptions, StateOptions, PublishStrategy } from './worker-protocol';

export interface ConnectOptions { signal?: AbortSignal }
export interface SharedSession<T extends SharedValue> {
  readonly current: T;
  /** Last published version. Local auto-state updates become visible before publication. */
  readonly version: number;
  readonly closed: boolean;
  readonly ready: Promise<void>;
  getSnapshot(): T;
  publish(next: T): number;
  flush(): number;
  connect(endpoint: SharedEndpoint | readonly SharedEndpoint[], options?: ConnectOptions): Promise<void>;
  disconnect(endpoint: SharedEndpoint): void;
  subscribe(listener: (snapshot: T, version: number) => void): () => void;
  dispose(): void;
}
export interface SharedState<T extends SharedValue> extends SharedSession<T> {
  value: T;
  update(recipe: (current: T) => T): void;
  update<K extends T extends SharedCollection ? never : keyof T>(key: K, recipe: (current: T[K]) => T[K]): void;
  /** Batch publication, not a rollback transaction. Callbacks must be synchronous. */
  batch(action: () => void): void;
}
export interface SnapshotStreamOptions {
  strategy?: 'latest' | 'all';
  capacity?: number;
  emitCurrent?: boolean;
  signal?: AbortSignal;
}
export interface SharedReader<T extends SharedValue> {
  readonly current: T;
  readonly version: number;
  readonly closed: boolean;
  getSnapshot(): T;
  subscribe(listener: (snapshot: T, version: number) => void): () => void;
  snapshots(options?: SnapshotStreamOptions): AsyncIterableIterator<T>;
  dispose(): void;
}
export interface ReaderOptions extends SessionOptions, ConnectOptions { endpoint?: SharedEndpoint }
interface Peer {
  endpoint: SharedEndpoint;
  reader?: string;
  known: Set<string>;
  flight?: Frame;
  pending: Frame[];
  ready: Promise<void>;
  send(frame: Frame): void;
  close(error?: Error, remote?: boolean): void;
}

class Publisher<T extends SharedValue> implements SharedState<T> {
  private state: Capture<T> | undefined;
  private published: Capture<T> | undefined;
  private sequence = 0;
  private disposed = false;
  private scheduled = false;
  private depth = 0;
  private updating = false;
  private unsubscribeSource?: () => void;
  private readonly peers = new Map<SharedEndpoint, Peer>();
  private readonly listeners = new Set<(snapshot: T, version: number) => void>();
  private readonly config;
  private readonly publishStrategy;
  private readonly owner = uniqueId();
  ready: Promise<void> = Promise.resolve();
  constructor(initial: T, private readonly options: StateOptions) {
    this.config = settings(options);
    this.publishStrategy = strategy(options);
    this.state = this.published = capture(initial);
  }
  private assertOpen(): void { if (this.disposed) throw new Error('Shared session is closed'); }
  get current(): T { this.assertOpen(); return this.state!.value; }
  get value(): T { return this.current; }
  set value(next: T) { this.update(() => next); }
  get version(): number { return this.sequence; }
  get closed(): boolean { return this.disposed; }
  getSnapshot = (): T => this.current;
  subscribe = (listener: (snapshot: T, version: number) => void): (() => void) => {
    this.assertOpen(); this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private set(next: T): boolean {
    this.assertOpen();
    const captured = capture(next);
    if (captured.single !== this.state!.single) throw new TypeError('Cannot change between single-collection and record state');
    if (same(this.state!, captured)) return false;
    this.state = captured; return true;
  }
  private commit(): number {
    this.assertOpen();
    if (this.depth || same(this.state!, this.published!)) return this.sequence;
    if (this.sequence === Number.MAX_SAFE_INTEGER) throw new RangeError('Session version exhausted');
    const committed = this.state!;
    this.published = committed;
    const version = ++this.sequence;
    const frame: Frame = { ...committed, sequence: version };
    for (const peer of [...this.peers.values()]) peer.send(frame);
    notify(this.listeners, committed.value, version, this.options.onError);
    return version;
  }
  publish(next: T): number { this.set(next); return this.flush(); }
  flush(): number { this.scheduled = false; return this.commit(); }
  private schedule(): void {
    if (this.depth || this.scheduled) return;
    if (this.publishStrategy === 'immediate') { this.commit(); return; }
    this.scheduled = true;
    queueMicrotask(() => {
      if (this.disposed || !this.scheduled) return;
      this.scheduled = false;
      try { this.commit(); } catch (error) { this.dispose(); report(this.options.onError, error); }
    });
  }
  update(recipe: (current: T) => T): void;
  update<K extends T extends SharedCollection ? never : keyof T>(key: K, recipe: (current: T[K]) => T[K]): void;
  update(keyOrRecipe: any, recipe?: any): void {
    this.assertOpen();
    if (this.updating) throw new Error('Shared-state recipes must not call update recursively');
    this.updating = true;
    let changed = false;
    try {
      if (typeof keyOrRecipe === 'function' && recipe === undefined) changed = this.set(keyOrRecipe(this.current));
      else {
        if (this.state!.single || !Object.hasOwn(this.current, keyOrRecipe) || typeof recipe !== 'function') {
          throw new TypeError('update(key, recipe) requires an existing record key');
        }
        const value = recipe((this.current as any)[keyOrRecipe]);
        changed = this.set({ ...this.current, [keyOrRecipe]: value });
      }
    } finally { this.updating = false; }
    if (changed) this.schedule();
  }
  batch(action: () => void): void {
    this.assertOpen(); this.depth++;
    try {
      const result = action() as unknown;
      if (result && typeof (result as any).then === 'function') {
        Promise.resolve(result).catch(error => report(this.options.onError, error));
        throw new TypeError('batch callbacks must be synchronous');
      }
    } finally { if (--this.depth === 0 && !this.disposed) this.schedule(); }
  }
  bind(source: SharedSource<T>): void {
    const refresh = () => {
      if (this.disposed) return;
      try { if (this.set(source.getSnapshot())) this.schedule(); }
      catch (error) { this.dispose(); report(this.options.onError, error); }
    };
    const unsubscribe = source.subscribe(refresh);
    if (typeof unsubscribe !== 'function') throw new TypeError('Source.subscribe must return an unsubscribe function');
    if (this.disposed) unsubscribe(); else this.unsubscribeSource = unsubscribe;
    // Read again after subscribe to cover a change during subscription setup.
    refresh();
  }
  start(): this {
    if (this.options.workers) {
      this.ready = this.connect(this.options.workers);
      this.ready.catch(error => report(this.options.onError, error));
    }
    return this;
  }
  connect(endpoint: SharedEndpoint | readonly SharedEndpoint[], options: ConnectOptions = {}): Promise<void> {
    this.assertOpen();
    if (Array.isArray(endpoint)) {
      const added = endpoint.filter(item => !this.peers.has(item));
      return Promise.all(endpoint.map(item => this.connect(item, options))).then(() => undefined, error => {
        for (const item of added) this.disconnect(item);
        throw error;
      });
    }
    const target = endpoint as SharedEndpoint;
    const existing = this.peers.get(target);
    if (existing) return existing.ready;
    if (options.signal?.aborted) return Promise.reject(errorOf(options.signal.reason ?? 'Connection aborted'));
    this.flush();
    const release = reserve(target, `owner:${this.config.channel}`);
    let resolve!: () => void, reject!: (error: Error) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    ready.catch(() => {});
    let settled = false, closed = false, remove = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = (fields: Omit<Message, 'protocol' | 'version' | 'channel'>) => target.postMessage(message(this.config.channel, { owner: this.owner, reader: peer.reader, ...fields }));
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => peer.close(new Error('Shared session timed out waiting for worker acknowledgement')), this.config.timeoutMs);
    };
    const abort = () => peer.close(errorOf(options.signal?.reason ?? 'Connection aborted'));
    const peer: Peer = {
      endpoint: target, known: new Set(), pending: [], ready,
      send: frame => {
        if (closed || !peer.reader) return;
        if (peer.flight) {
          if (this.config.delivery === 'latest') peer.pending = [frame];
          else if (peer.pending.length < this.config.maxPending) peer.pending.push(frame);
          else peer.close(new Error('Shared session pending queue overflow'));
          return;
        }
        try {
          const arenas = frame.data.arenas.map(source => {
            if (this.config.copy) return { id: source.id, used: source.used, copy: new Uint8Array(source.memory!.buffer, 0, source.used).slice() };
            return peer.known.has(source.id) ? { id: source.id, used: source.used } : source;
          });
          peer.flight = frame;
          arm();
          send({ kind: 'snapshot', sequence: frame.sequence, single: frame.single, data: { ...frame.data, arenas } });
        } catch (error) { peer.close(errorOf(error)); }
      },
      close: (error, remote = false) => {
        if (closed) return;
        closed = true; clearTimeout(timer); remove(); release();
        options.signal?.removeEventListener('abort', abort);
        this.peers.delete(target);
        if (!remote) { try { send({ kind: error ? 'error' : 'close', message: error?.message }); } catch {} }
        peer.flight = undefined; peer.pending = []; peer.known.clear();
        if (!settled) { settled = true; reject(error ?? new Error('Shared connection closed before initialization')); }
        else if (error) report(this.options.onError, error);
      },
    };
    this.peers.set(target, peer);
    try {
      remove = listen(target, data => {
        if (closed || !isMessage(data, this.config.channel)) return;
        if (data.version !== WIRE_VERSION) { peer.close(new Error('Unsupported session protocol version')); return; }
        if (data.kind === 'ready') {
          if (typeof data.reader !== 'string' || !data.reader) return;
          if (peer.reader) return;
          peer.reader = data.reader;
          peer.send({ ...this.published!, sequence: this.sequence });
          return;
        }
        if (data.owner !== this.owner || data.reader !== peer.reader) return;
        if (data.kind === 'close' || data.kind === 'error') {
          peer.close(data.kind === 'error' ? new Error(data.message ?? 'Reader failed') : undefined, true); return;
        }
        if (data.kind !== 'ack' || !peer.flight || data.sequence !== peer.flight.sequence) return;
        peer.known = new Set(peer.flight.data.arenas.map(arena => arena.id));
        peer.flight = undefined; clearTimeout(timer);
        if (!settled) { settled = true; resolve(); }
        const next = peer.pending.shift();
        if (next) peer.send(next);
      }, error => peer.close(error));
      options.signal?.addEventListener('abort', abort, { once: true });
      arm(); send({ kind: 'offer' });
    } catch (error) { peer.close(errorOf(error)); }
    return ready;
  }
  disconnect(endpoint: SharedEndpoint): void { this.peers.get(endpoint)?.close(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.scheduled = false;
    try { this.unsubscribeSource?.(); } catch (error) { report(this.options.onError, error); }
    this.unsubscribeSource = undefined;
    for (const peer of [...this.peers.values()]) peer.close();
    this.listeners.clear(); this.state = this.published = undefined;
  }
}

export function createSharedState<T extends SharedValue>(initial: T, options: StateOptions = {}): SharedState<T> {
  return new Publisher(initial, options).start();
}
export function createSharedSession<T extends SharedValue>(input: { source: SharedSource<T> }, options?: StateOptions): SharedSession<T>;
export function createSharedSession<T extends SharedValue>(input: T, options?: StateOptions): SharedSession<T>;
export function createSharedSession<T extends SharedValue>(input: T | { source: SharedSource<T> }, options: StateOptions = {}): SharedSession<T> {
  const source = (input as { source?: SharedSource<T> }).source;
  if (source && typeof source.getSnapshot === 'function' && typeof source.subscribe === 'function') {
    const session = new Publisher(source.getSnapshot(), options);
    try { session.bind(source); return session.start(); }
    catch (error) { session.dispose(); throw error; }
  }
  return new Publisher(input as T, options).start();
}

class Reader<T extends SharedValue> implements SharedReader<T> {
  private state?: T;
  private sequence = -1;
  private disposed = false;
  private readonly listeners = new Set<(snapshot: T, version: number) => void>();
  private readonly endings = new Set<(error?: Error) => void>();
  constructor(private readonly closeTransport: () => void, private readonly onError?: SessionOptions['onError']) {}
  get current(): T { if (this.disposed || this.state === undefined) throw new Error('Shared reader is not open'); return this.state; }
  get version(): number { return this.sequence; }
  get closed(): boolean { return this.disposed; }
  getSnapshot = (): T => this.current;
  subscribe = (listener: (snapshot: T, version: number) => void): (() => void) => {
    if (this.disposed) throw new Error('Shared reader is closed');
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  accept(value: T, version: number): void {
    if (this.disposed) return;
    this.state = value; this.sequence = version;
    notify(this.listeners, value, version, this.onError);
  }
  finish(error?: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const end of [...this.endings]) end(error);
    this.endings.clear(); this.listeners.clear(); this.state = undefined;
  }
  dispose(): void { if (!this.disposed) { this.closeTransport(); this.finish(); } }
  snapshots(options: SnapshotStreamOptions = {}): AsyncIterableIterator<T> {
    if (this.disposed) throw new Error('Shared reader is closed');
    const mode = options.strategy ?? 'latest', capacity = options.capacity ?? 32;
    if (mode !== 'latest' && mode !== 'all') throw new TypeError('Invalid snapshot stream strategy');
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('capacity must be positive');
    let queue: T[] = options.emitCurrent === false ? [] : [this.current];
    let done = false, failure: Error | undefined;
    let waiter: { resolve: (value: IteratorResult<T>) => void; reject: (error: Error) => void } | undefined;
    let unsubscribe = () => {};
    const end = (error?: Error) => {
      if (done) return;
      done = true; failure = error; queue = []; unsubscribe(); this.endings.delete(end);
      options.signal?.removeEventListener('abort', abort);
      if (waiter) { const pending = waiter; waiter = undefined; error ? pending.reject(error) : pending.resolve({ done: true, value: undefined }); }
    };
    const abort = () => end(errorOf(options.signal?.reason ?? 'Snapshot stream aborted'));
    unsubscribe = this.subscribe(value => {
      if (waiter) { const pending = waiter; waiter = undefined; pending.resolve({ done: false, value }); }
      else if (mode === 'latest') queue = [value];
      else if (queue.length < capacity) queue.push(value);
      else end(new Error('Snapshot stream queue overflow'));
    });
    this.endings.add(end);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    return {
      [Symbol.asyncIterator]() { return this; },
      next: () => {
        if (failure) return Promise.reject(failure);
        if (done) return Promise.resolve({ done: true, value: undefined });
        if (queue.length) return Promise.resolve({ done: false, value: queue.shift()! });
        if (waiter) return Promise.reject(new Error('Call snapshot iterator.next() sequentially'));
        return new Promise<IteratorResult<T>>((resolve, reject) => { waiter = { resolve, reject }; });
      },
      return: async () => { end(); return { done: true, value: undefined }; },
      throw: async error => { end(errorOf(error)); throw error; },
    };
  }
}

export function connectSharedSession<T extends SharedValue>(options: ReaderOptions = {}): Promise<SharedReader<T>> {
  const config = settings(options);
  const endpoint = options.endpoint ?? defaultEndpoint();
  if (options.signal?.aborted) return Promise.reject(errorOf(options.signal.reason ?? 'Connection aborted'));
  const release = reserve(endpoint, `reader:${config.channel}`);
  const readerId = uniqueId();
  let owner: string | undefined, closed = false, initialized = false;
  let remove = () => {};
  let arenas = new Map<string, ArenaWire>();
  let previous: Readonly<Record<string, string>> = Object.create(null);
  let previousSingle: boolean | undefined;
  let chain = Promise.resolve();
  let resolve!: (reader: SharedReader<T>) => void, reject!: (error: Error) => void;
  const ready = new Promise<SharedReader<T>>((yes, no) => { resolve = yes; reject = no; });
  ready.catch(() => {});
  const send = (fields: Omit<Message, 'protocol' | 'version' | 'channel'>) => endpoint.postMessage(message(config.channel, { owner, reader: readerId, ...fields }));
  const shutdown = (error?: Error, remote = false) => {
    if (closed) return;
    closed = true; clearTimeout(timer); remove(); release(); options.signal?.removeEventListener('abort', abort);
    if (!remote) { try { send({ kind: error ? 'error' : 'close', message: error?.message }); } catch {} }
    arenas.clear(); previous = Object.create(null); reader.finish(error);
    if (!initialized) reject(error ?? new Error('Shared reader closed before initialization'));
    else if (error) report(options.onError, error);
  };
  const reader = new Reader<T>(() => shutdown(), options.onError);
  const abort = () => shutdown(errorOf(options.signal?.reason ?? 'Connection aborted'));
  const timer = setTimeout(() => shutdown(new Error('Shared reader timed out waiting for owner')), config.timeoutMs);
  const receive = async (data: Message) => {
    if (closed) return;
    if (!Number.isSafeInteger(data.sequence) || data.sequence! < 0 || typeof data.single !== 'boolean' || !data.data) throw new Error('Invalid snapshot message');
    if (data.sequence! <= reader.version) return;
    if (previousSingle !== undefined && data.single !== previousSingle) throw new Error('Snapshot shape changed');
    const payload = data.data;
    if (!Array.isArray(payload.arenas) || !payload.structures || typeof payload.structures !== 'object') throw new Error('Invalid snapshot payload');
    const next = new Map<string, ArenaWire>();
    for (const source of payload.arenas) {
      if (typeof source.id !== 'string' || !source.id || next.has(source.id)) throw new Error('Invalid or duplicate arena');
      if (source.memory && source.copy) throw new Error('Ambiguous arena transport');
      const known = arenas.get(source.id);
      if (!source.memory && !source.copy && !known?.memory) throw new Error('Missing shared arena; reconnect the session');
      if (known?.memory && source.memory) throw new Error('An existing arena cannot replace its memory');
      next.set(source.id, source.memory || source.copy ? source : { ...source, memory: known!.memory });
    }
    const values = await initWorker<Record<string, SharedCollection>>({ ...payload, arenas: [...next.values()] });
    if (closed) return;
    const ids = identities(payload);
    const result: Record<string, SharedCollection> = Object.create(null);
    for (const [key, value] of Object.entries(values)) {
      const oldValue = initialized ? (data.single ? reader.current : (reader.current as any)[key]) : undefined;
      result[key] = previous[key] === ids[key] && oldValue !== undefined ? oldValue : value;
    }
    if (data.single && (Object.keys(result).length !== 1 || !Object.hasOwn(result, 'value'))) throw new Error('Invalid single-collection snapshot');
    arenas = next; previous = ids; previousSingle = data.single;
    reader.accept((data.single ? result.value : Object.freeze(result)) as T, data.sequence!);
    if (closed) return;
    send({ kind: 'ack', sequence: data.sequence });
    if (!initialized) { initialized = true; clearTimeout(timer); resolve(reader); }
  };
  try {
    remove = listen(endpoint, data => {
      if (closed || !isMessage(data, config.channel)) return;
      if (data.version !== WIRE_VERSION) { shutdown(new Error('Unsupported session protocol version')); return; }
      if (data.kind === 'offer') { if (!owner || owner === data.owner) send({ kind: 'ready' }); return; }
      if (data.reader !== readerId || typeof data.owner !== 'string') return;
      if (owner && data.owner !== owner) return;
      owner = data.owner;
      if (data.kind === 'close' || data.kind === 'error') {
        shutdown(data.kind === 'error' ? new Error(data.message ?? 'Owner failed') : undefined, true); return;
      }
      if (data.kind === 'snapshot') chain = chain.then(() => receive(data)).catch(error => shutdown(errorOf(error)));
    }, error => shutdown(error));
    options.signal?.addEventListener('abort', abort, { once: true });
    send({ kind: 'ready' });
  } catch (error) { shutdown(errorOf(error)); }
  return ready;
}

/** One-shot convenience. The returned snapshots retain their arena independently. */
export async function shareWithWorker<T extends SharedValue>(endpoint: SharedEndpoint, value: T, options: SessionOptions = {}): Promise<void> {
  const session = createSharedSession(value, options);
  try { await session.connect(endpoint); } finally { session.dispose(); }
}
export async function receiveShared<T extends SharedValue>(options: ReaderOptions = {}): Promise<T> {
  const reader = await connectSharedSession<T>(options);
  const value = reader.current;
  reader.dispose();
  return value;
}
