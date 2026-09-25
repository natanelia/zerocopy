import { createSharedSession, connectSharedSession, type SharedEndpoint, type SharedShape, type SharedSource, type SharedReader } from './worker';
export interface TaskContext<S> {
    readonly state: S;
    readonly signal: AbortSignal;
}
export type Task<I = void, O = unknown, S = unknown> = (context: TaskContext<S>, input: I) => O | Promise<O>;
export type TaskSet<S = unknown> = Record<string, Task<any, any, S>>;
type Input<F> = F extends (c: any, ...args: infer A) => any ? A extends [
    infer I,
    ...any[]
] ? I : void : never;
type StateFor<T extends TaskSet<any>> = Parameters<T[keyof T]>[0]['state'];
type Output<F> = F extends (...a: any[]) => infer O ? Awaited<O> : never;
export interface CallOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}
type Call<F> = [
    Input<F>
] extends [
    void
] ? (input?: void, options?: CallOptions) => Promise<Output<F>> : (input: Input<F>, options?: CallOptions) => Promise<Output<F>>;
export type TaskCalls<T extends TaskSet<any>> = {
    readonly [K in keyof T]: Call<T[K]>;
};
export interface Executor<T extends TaskSet<any>> {
    readonly run: TaskCalls<T>;
    readonly closed: boolean;
    dispose(): void;
}
export interface PoolExecutor<T extends TaskSet<any>> extends Executor<T> {
    readonly size: number;
    readonly map: {
        readonly [K in keyof T]: (inputs: readonly Input<T[K]>[], options?: CallOptions & {
            chunkSize?: number;
        }) => Promise<Output<T[K]>[]>;
    };
}
export interface ClientOptions<S extends SharedShape<S>> {
    state: S | SharedSource<S>;
    channel?: string;
    timeoutMs?: number;
    memory?: 'share' | 'copy';
    onError?: (error: Error) => void;
}
export interface ServeOptions {
    endpoint?: SharedEndpoint;
    channel?: string;
    timeoutMs?: number;
    onError?: (error: Error) => void;
}
export interface PoolOptions<S extends SharedShape<S>> extends ClientOptions<S> {
    size?: number;
    maxPending?: number;
}
const PROTOCOL = 'zerocopy/tasks', VERSION = 1;
let clients = 0;
type Msg = {
    protocol: string;
    version: number;
    channel: string;
    client: string;
    kind: 'hello' | 'ready' | 'call' | 'result' | 'error' | 'cancel' | 'close';
    id?: number;
    task?: string;
    input?: unknown;
    value?: unknown;
    message?: string;
    revision?: number;
};
/** Normalize browser and Node endpoints without taking ownership. */
function endpointOf(value: any): SharedEndpoint {
    const endpoint = value?.port ?? value;
    if (!endpoint || typeof endpoint.postMessage !== 'function')
        throw new TypeError('Expected a Worker, SharedWorker, or MessagePort');
    endpoint.start?.();
    return endpoint;
}
/** Install independent listeners; leave application message handlers intact. */
function listen(endpoint: SharedEndpoint, receive: (data: any) => void, fail: (error: Error) => void): () => void {
    if (endpoint.addEventListener && endpoint.removeEventListener) {
        const onMessage = (event: any) => receive(event.data), onError = (event: any) => fail(event.error instanceof Error ? event.error : new Error(event.message ?? 'Worker error'));
        endpoint.addEventListener('message', onMessage);
        endpoint.addEventListener('messageerror', onError);
        endpoint.addEventListener('error', onError);
        return () => { endpoint.removeEventListener!('message', onMessage); endpoint.removeEventListener!('messageerror', onError); endpoint.removeEventListener!('error', onError); };
    }
    if (endpoint.on && endpoint.off) {
        const onError = (error: any) => fail(error instanceof Error ? error : new Error(String(error)));
        endpoint.on('message', receive);
        endpoint.on('messageerror', onError);
        endpoint.on('error', onError);
        return () => { endpoint.off!('message', receive); endpoint.off!('messageerror', onError); endpoint.off!('error', onError); };
    }
    throw new TypeError('Endpoint does not support message events');
}
/** Build a versioned, namespaced task message. */
function msg(channel: string, client: string, fields: Omit<Msg, 'protocol' | 'version' | 'channel' | 'client'>): Msg { return { protocol: PROTOCOL, version: VERSION, channel, client, ...fields }; }
/** Match routing fields. This is not an authentication boundary. */
function valid(value: any, channel: string): value is Msg { return value?.protocol === PROTOCOL && value.version === VERSION && value.channel === channel && typeof value.client === 'string'; }
/** Adapt either a shared value or an existing subscribable source. */
function sourceOf<S extends SharedShape<S>>(state: S | SharedSource<S>): SharedSource<S> {
    return state && typeof (state as any).getSnapshot === 'function' && typeof (state as any).subscribe === 'function'
        ? state as SharedSource<S> : { getSnapshot: () => state as S, subscribe: () => () => { } };
}
/** Declare typed handlers without wrapping their implementations. */
export function defineTasks<S>() { return <T extends TaskSet<S>>(tasks: T): T => Object.freeze({ ...tasks }); }
/** A call can reject on cancellation before the remote handler has stopped. */
type TaskPromise<T> = Promise<T> & {
    readonly settled: Promise<void>;
};
/** Release only resources created by this API. Cleanup must not hide an error. */
function releaseResource(resource: any): void {
    try {
        Promise.resolve(resource.terminate?.()).catch(() => { });
    }
    catch { }
    try {
        resource.port?.close?.();
    }
    catch { }
}
/** Report application callbacks without breaking transport cleanup. */
function report(options: {
    onError?: (error: Error) => void;
}, error: Error): void {
    try {
        options.onError?.(error);
    }
    catch (failure) {
        console.error('[zerocopy/worker]', failure);
    }
}
/** Create one session and remove all of its listeners on every shutdown path. */
function client<T extends TaskSet<any>, S extends SharedShape<S>>(resource: any, options: ClientOptions<S>, owned: boolean): Executor<T> & {
    readonly _ready: Promise<void>;
} {
    if (options.memory !== undefined && options.memory !== 'share' && options.memory !== 'copy') {
        throw new TypeError('memory must be share or copy');
    }
    const endpoint = endpointOf(resource), channel = options.channel ?? 'default';
    const clientId = Date.now().toString(36) + '-' + (++clients);
    const source = sourceOf(options.state);
    let closed = false, id = 0, constructed = false;
    let state: ReturnType<typeof createSharedSession<S>> | undefined;
    let remove = () => { };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    ready.catch(() => { });
    const pending = new Map<number, {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        cleanup: () => void;
        complete: () => void;
    }>();
    /** Reject pending calls, release listeners, and finish owned-resource cleanup. */
    function close(error: Error, releaseOwned = true): void {
        if (closed)
            return;
        closed = true;
        clearTimeout(timer);
        try {
            endpoint.postMessage(msg(channel, clientId, { kind: 'close' }));
        }
        catch { }
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
    /** Transport failures close the executor before calling application code. */
    function fail(error: Error): void { close(error); report(options, error); }
    let stateReady: Promise<void>;
    try {
        state = createSharedSession({ source }, {
            channel: 'tasks:' + channel + ':' + clientId,
            copy: options.memory === undefined ? undefined : options.memory === 'copy',
            timeoutMs: options.timeoutMs,
            onError: error => fail(error),
        });
        if (closed)
            throw new Error('Shared state initialization failed');
        remove = listen(endpoint, data => {
            if (!valid(data, channel) || data.client !== clientId)
                return;
            if (data.kind === 'ready') {
                readyResolve();
                return;
            }
            if (data.kind === 'close') {
                close(new Error(data.message ?? 'Task server closed'));
                return;
            }
            if ((data.kind === 'result' || data.kind === 'error') && data.id !== undefined) {
                const item = pending.get(data.id);
                if (!item)
                    return;
                pending.delete(data.id);
                item.cleanup();
                item.complete();
                data.kind === 'result' ? item.resolve(data.value) : item.reject(new Error(data.message ?? 'Worker task failed'));
            }
        }, fail);
        stateReady = Promise.all([state.connect(endpoint), ready]).then(() => { clearTimeout(timer); });
        stateReady.catch(() => { });
        timer = setTimeout(() => fail(new Error('Worker executor handshake timed out')), options.timeoutMs ?? 10000);
        endpoint.postMessage(msg(channel, clientId, { kind: 'hello' }));
    }
    catch (error) {
        // The caller still owns rollback until construction returns successfully.
        close(error instanceof Error ? error : new Error(String(error)), false);
        throw error;
    }
    /** Refresh source state synchronously and track both result and completion. */
    function invoke(task: string, input: unknown, call: CallOptions = {}): TaskPromise<any> {
        let complete!: () => void;
        const settled = new Promise<void>(resolve => { complete = resolve; });
        const result = new Promise<any>((resolve, reject) => {
            try {
                if (closed)
                    throw new Error('Worker executor is closed');
                if (call.signal?.aborted)
                    throw call.signal.reason ?? new Error('Task aborted');
                if (call.timeoutMs !== undefined && (!Number.isFinite(call.timeoutMs) || call.timeoutMs <= 0)) {
                    throw new RangeError('timeoutMs must be positive');
                }
                // Source notifications may be microtask-batched. Read the source now,
                // instead of flushing a publisher that still has the previous snapshot.
                const revision = state!.publish(source.getSnapshot());
                if (closed)
                    throw new Error('Worker executor is closed');
                if (id === Number.MAX_SAFE_INTEGER)
                    throw new RangeError('Task IDs exhausted');
                const callId = ++id;
                let callTimer: ReturnType<typeof setTimeout> | undefined;
                const cleanup = () => { clearTimeout(callTimer); call.signal?.removeEventListener('abort', abort); };
                const cancel = (error: Error) => {
                    if (!pending.has(callId))
                        return;
                    cleanup();
                    reject(error);
                    // Keep the completion token until the handler settles. A pool must
                    // not reuse this worker while the cancelled handler is still running.
                    try {
                        endpoint.postMessage(msg(channel, clientId, { kind: 'cancel', id: callId }));
                    }
                    catch (failure) {
                        fail(failure instanceof Error ? failure : new Error(String(failure)));
                    }
                };
                const abort = () => cancel(call.signal?.reason instanceof Error ? call.signal.reason : new Error('Task aborted'));
                pending.set(callId, { resolve, reject, cleanup, complete });
                call.signal?.addEventListener('abort', abort, { once: true });
                if (call.timeoutMs !== undefined)
                    callTimer = setTimeout(() => cancel(new Error('Worker task timed out')), call.timeoutMs);
                try {
                    endpoint.postMessage(msg(channel, clientId, { kind: 'call', id: callId, task, input, revision }));
                }
                catch (error) {
                    pending.delete(callId);
                    cleanup();
                    complete();
                    reject(error);
                }
            }
            catch (error) {
                complete();
                reject(error);
            }
        });
        return Object.assign(result, { settled });
    }
    const methods = Object.create(null);
    const run = new Proxy(methods, { get: (_target, key) => {
            if (typeof key !== 'string')
                return undefined;
            return methods[key] ??= (input?: unknown, call?: CallOptions) => invoke(key, input, call);
        } }) as TaskCalls<T>;
    constructed = true;
    return { run, _ready: stateReady, get closed() { return closed; }, dispose() { close(new Error('Worker executor is closed')); } };
}
/** Attach to a caller-owned endpoint and wait for both startup handshakes. */
export async function connect<T extends TaskSet<any>, S extends SharedShape<S> = StateFor<T>>(endpoint: any, options: ClientOptions<S>): Promise<Executor<T>> {
    const value = client<T, S>(endpoint, options, false);
    try {
        await value._ready;
        return value;
    }
    catch (error) {
        value.dispose();
        throw error;
    }
}
/** Create and own a worker, including rollback when construction fails. */
export async function spawn<T extends TaskSet<any>, S extends SharedShape<S> = StateFor<T>>(factory: () => any, options: ClientOptions<S>): Promise<Executor<T>> {
    const resource = factory();
    let value: ReturnType<typeof client<T, S>> | undefined;
    try {
        value = client<T, S>(resource, options, true);
        await value._ready;
        return value;
    }
    catch (error) {
        if (value)
            value.dispose();
        else
            releaseResource(resource);
        throw error;
    }
}
/** Run handlers on the calling thread; cancellation is cooperative. */
export function local<T extends TaskSet<S>, S extends SharedShape<S>>(tasks: T, options: {
    state: S | SharedSource<S>;
}): Executor<T> {
    let closed = false;
    const source = sourceOf(options.state);
    const run = Object.fromEntries(Object.entries(tasks).map(([name, task]) => [name, async (input: unknown, call: CallOptions = {}) => {
            if (closed)
                throw new Error('Worker executor is closed');
            if (call.signal?.aborted)
                throw call.signal.reason ?? new Error('Task aborted');
            const controller = new AbortController();
            const abort = () => controller.abort(call.signal?.reason);
            call.signal?.addEventListener('abort', abort, { once: true });
            let timer: ReturnType<typeof setTimeout> | undefined;
            if (call.timeoutMs)
                timer = setTimeout(() => controller.abort(new Error('Worker task timed out')), call.timeoutMs);
            try {
                return await task({ state: source.getSnapshot(), signal: controller.signal }, input);
            }
            finally {
                if (timer)
                    clearTimeout(timer);
                call.signal?.removeEventListener('abort', abort);
            }
        }])) as TaskCalls<T>;
    return { run, get closed() { return closed; }, dispose() { closed = true; } };
}
/** Wait for a minimum revision, rejecting on reader closure or cancellation. */
async function atRevision<S extends SharedShape<S>>(reader: SharedReader<S>, revision: number | undefined, signal: AbortSignal): Promise<S> {
    signal.throwIfAborted();
    if (reader.closed)
        throw new Error('Shared state reader closed');
    if (revision === undefined || reader.version >= revision)
        return reader.current;
    const snapshots = reader.snapshots({ emitCurrent: false, signal });
    for await (const value of snapshots)
        if (reader.version >= revision)
            return value;
    throw new Error('Shared state reader closed');
}
/** Serve trusted task clients; each invocation retains one reader snapshot. */
export async function serve<T extends TaskSet<any>, S extends SharedShape<S> = StateFor<T>>(tasks: T, options: ServeOptions = {}): Promise<() => void> {
    const endpoint = endpointOf(options.endpoint ?? globalThis), channel = options.channel ?? 'default';
    const readers = new Map<string, Promise<SharedReader<S>>>(), running = new Map<string, Map<number, AbortController>>();
    let closed = false;
    const remove = listen(endpoint, data => {
        if (closed || !valid(data, channel))
            return;
        if (data.kind === 'hello') {
            if (!readers.has(data.client)) {
                const reader = connectSharedSession<S>({ endpoint, channel: 'tasks:' + channel + ':' + data.client, timeoutMs: options.timeoutMs, onError: options.onError });
                readers.set(data.client, reader);
                running.set(data.client, new Map());
                reader.catch(error => {
                    try {
                        endpoint.postMessage(msg(channel, data.client, { kind: 'close', message: error instanceof Error ? error.message : String(error) }));
                    }
                    catch { }
                    report(options, error instanceof Error ? error : new Error(String(error)));
                });
            }
            endpoint.postMessage(msg(channel, data.client, { kind: 'ready' }));
            return;
        }
        if (data.kind === 'close') {
            for (const controller of running.get(data.client)?.values() ?? [])
                controller.abort(new Error('Task client closed'));
            readers.get(data.client)?.then(r => r.dispose()).catch(() => { });
            readers.delete(data.client);
            running.delete(data.client);
            return;
        }
        if (data.kind === 'cancel' && data.id !== undefined) {
            running.get(data.client)?.get(data.id)?.abort(new Error('Task aborted'));
            return;
        }
        if (data.kind !== 'call' || typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id < 1 || typeof data.task !== 'string' || !readers.has(data.client))
            return;
        const task = Object.hasOwn(tasks, data.task) ? tasks[data.task] : undefined;
        if (typeof task !== 'function') {
            endpoint.postMessage(msg(channel, data.client, { kind: 'error', id: data.id, message: 'Unknown task: ' + data.task }));
            return;
        }
        const callId = data.id, controller = new AbortController();
        running.get(data.client)?.set(callId, controller);
        Promise.resolve(readers.get(data.client)).then(reader => {
            if (!reader)
                throw new Error('Task client has no shared state');
            return atRevision(reader, data.revision, controller.signal).then(snapshot => { controller.signal.throwIfAborted(); return task({ state: snapshot, signal: controller.signal }, data.input); });
        })
            .then(value => {
            if (!closed)
                endpoint.postMessage(msg(channel, data.client, { kind: 'result', id: callId, value }));
        }).catch(error => {
            if (!closed)
                endpoint.postMessage(msg(channel, data.client, { kind: 'error', id: callId, message: error instanceof Error ? error.message : String(error) }));
        })
            .finally(() => running.get(data.client)?.delete(callId)).catch(error => report(options, error instanceof Error ? error : new Error(String(error))));
    }, error => options.onError?.(error));
    return () => {
        if (closed)
            return;
        closed = true;
        remove();
        for (const clientId of readers.keys()) {
            try {
                endpoint.postMessage(msg(channel, clientId, { kind: 'close', message: 'Task server closed' }));
            }
            catch { }
        }
        for (const m of running.values())
            for (const c of m.values())
                c.abort(new Error('Task server closed'));
        for (const r of readers.values())
            r.then(x => x.dispose()).catch(() => { });
        readers.clear();
        running.clear();
    };
}
/** Create a bounded pool, or borrow existing endpoints without owning them. */
export async function pool<T extends TaskSet<any>, S extends SharedShape<S> = StateFor<T>>(workers: readonly any[] | (() => any), options: PoolOptions<S>): Promise<PoolExecutor<T>> {
    const owned = !Array.isArray(workers);
    const size = owned ? (options.size ?? Math.max(1, Math.min(4, typeof navigator === 'undefined' ? 4 : (navigator.hardwareConcurrency || 4)))) : (workers as readonly any[]).length;
    if (!Number.isSafeInteger(size) || size < 1)
        throw new RangeError('Pool size must be a positive integer');
    const max = options.maxPending ?? 128;
    if (!Number.isSafeInteger(max) || max < 0)
        throw new RangeError('maxPending must be a non-negative integer');
    const resources: any[] = [];
    const executors: (Executor<T> & {
        readonly _ready: Promise<void>;
    })[] = [];
    try {
        if (owned)
            for (let index = 0; index < size; index++)
                resources.push((workers as () => any)());
        else
            resources.push(...workers as readonly any[]);
        for (const resource of resources)
            executors.push(client<T, S>(resource, options, owned));
        await Promise.all(executors.map(executor => executor._ready));
    }
    catch (error) {
        for (const executor of executors)
            executor.dispose();
        if (owned)
            for (const resource of resources.slice(executors.length))
                releaseResource(resource);
        throw error;
    }
    let closed = false;
    const idle: Executor<T>[] = executors.slice();
    const queue: {
        run: (executor: Executor<T>) => void;
        reject: (error: Error) => void;
    }[] = [];
    const schedule = <R>(operation: (executor: Executor<T>) => Promise<R>): Promise<R> => new Promise((resolve, reject) => {
        if (closed) {
            reject(new Error('Worker pool is closed'));
            return;
        }
        if (!idle.length && queue.length >= max) {
            reject(new Error('Worker pool queue overflow'));
            return;
        }
        const item = { reject, run(executor: Executor<T>) {
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
                let result: Promise<R>;
                try {
                    result = operation(executor);
                }
                catch (error) {
                    release();
                    reject(error);
                    return;
                }
                // Cancelled calls may reject before the handler stops. Only actual
                // completion makes the worker idle. Release before refilling a batch.
                const completed = (result as Partial<TaskPromise<R>>).settled ?? result.then(() => { }, () => { });
                completed.then(release);
                result.then(value => completed.then(() => { release(); resolve(value); }), reject);
            } };
        const executor = idle.shift();
        if (executor)
            item.run(executor);
        else
            queue.push(item);
    });
    const run = new Proxy(Object.create(null), { get: (_t, key) => typeof key === 'string' ? (input?: unknown, call?: CallOptions) => schedule(e => (e.run as any)[key](input, call)) : undefined }) as TaskCalls<T>;
    const map = new Proxy(Object.create(null), { get: (_t, key) => typeof key === 'string' ? async (inputs: readonly unknown[], call?: CallOptions & {
            chunkSize?: number;
        }) => {
            if (closed)
                throw new Error('Worker pool is closed');
            if (call?.signal?.aborted)
                throw call.signal.reason ?? new Error('Task aborted');
            const results: any[] = new Array(inputs.length);
            const width = call?.chunkSize ?? size;
            if (!Number.isSafeInteger(width) || width < 1)
                throw new RangeError('chunkSize must be a positive integer');
            if (!inputs.length)
                return results;
            let next = 0, failed = false;
            const feed = async () => {
                try {
                    while (!failed) {
                        const index = next++;
                        if (index >= inputs.length)
                            return;
                        results[index] = await schedule(e => (e.run as any)[key](inputs[index], call));
                    }
                }
                catch (error) {
                    failed = true;
                    throw error;
                }
            };
            await Promise.all(Array.from({ length: Math.min(width, size, inputs.length) }, () => feed()));
            return results;
        } : undefined }) as PoolExecutor<T>['map'];
    return { run, map, size, get closed() { return closed; }, dispose() {
            if (closed)
                return;
            closed = true;
            const error = new Error('Worker pool is closed');
            for (const q of queue.splice(0))
                q.reject(error);
            for (const e of executors)
                e.dispose();
        } };
}
