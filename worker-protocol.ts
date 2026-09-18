/** Internal session protocol. Keep the existing worker-data format unchanged. */
import { Snapshot } from './arena';
import { getWorkerData, type WorkerData } from './shared';

export type SharedCollection = Parameters<typeof getWorkerData>[0][string];
export type SharedValue = SharedCollection | Readonly<Record<string, SharedCollection>>;
/** A self-keyed shape also accepts named interfaces without an index signature. */
export type SharedShape<T> = SharedCollection | { readonly [K in keyof T]: SharedCollection };
export interface SharedSource<T extends SharedShape<T>> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}
/** Browser Worker/MessagePort/worker global, or Node Worker/MessagePort. */
export interface SharedEndpoint {
  postMessage(message: any): void;
  addEventListener?: (...args: any[]) => any;
  removeEventListener?: (...args: any[]) => any;
  on?: (...args: any[]) => any;
  off?: (...args: any[]) => any;
  start?: () => void;
}
export type PublishStrategy = 'microtask' | 'immediate';
export interface SessionOptions {
  channel?: string;
  copy?: boolean;
  timeoutMs?: number;
  delivery?: 'latest' | 'all';
  maxPending?: number;
  onError?: (error: Error) => void;
}
export interface StateOptions extends SessionOptions {
  publish?: { strategy?: PublishStrategy };
  workers?: SharedEndpoint | readonly SharedEndpoint[];
}
export const PROTOCOL = 'zerocopy/session';
export const WIRE_VERSION = 1;
export type ArenaWire = WorkerData['arenas'][number];
export interface Capture<T extends object = SharedValue> {
  value: T;
  single: boolean;
  data: WorkerData;
  identities: Readonly<Record<string, string>>;
}
export type Frame = Pick<Capture, 'single' | 'data' | 'identities'> & { sequence: number };
export type Message = {
  protocol: typeof PROTOCOL;
  version: typeof WIRE_VERSION;
  channel: string;
  kind: 'offer' | 'ready' | 'snapshot' | 'ack' | 'close' | 'error';
  owner?: string;
  reader?: string;
  sequence?: number;
  single?: boolean;
  data?: WorkerData;
  message?: string;
};
export function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
export function report(handler: SessionOptions['onError'], error: unknown): void {
  try { if (handler) handler(errorOf(error)); else console.error('[zerocopy/worker]', error); }
  catch (failure) { console.error('[zerocopy/worker] onError failed', failure); }
}
export function notify<T>(listeners: Set<(value: T, version: number) => void>, value: T, version: number, onError?: SessionOptions['onError']): void {
  for (const listener of [...listeners]) {
    try {
      // Also observe a rejected Promise from an accidentally async subscriber.
      const result = listener(value, version) as unknown;
      if (result && typeof (result as any).then === 'function') Promise.resolve(result).catch(error => report(onError, error));
    } catch (error) { report(onError, error); }
  }
}
let nextId = 0;
export function uniqueId(): string { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${++nextId}`; }
export function settings(options: SessionOptions) {
  const channel = options.channel ?? 'default';
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxPending = options.maxPending ?? 32;
  const delivery = options.delivery ?? 'latest';
  if (typeof channel !== 'string' || !channel.length) throw new TypeError('channel must be a non-empty string');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be positive');
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new RangeError('maxPending must be a positive integer');
  if (delivery !== 'latest' && delivery !== 'all') throw new TypeError('Invalid delivery strategy');
  if (options.copy !== undefined && typeof options.copy !== 'boolean') throw new TypeError('copy must be boolean');
  return { channel, timeoutMs, maxPending, delivery, copy: options.copy ?? (typeof Bun !== 'undefined') };
}
export function strategy(options: StateOptions): PublishStrategy {
  const value = options.publish?.strategy ?? 'microtask';
  if (value !== 'microtask' && value !== 'immediate') throw new TypeError('Invalid publish strategy');
  return value;
}
export function recordOf(value: object): { single: boolean; structures: Record<string, SharedCollection> } {
  if (value instanceof Snapshot) return { single: true, structures: { value: value as SharedCollection } };
  if (!value || typeof value !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('Shared state must be a collection or a plain record of collections');
  }
  if (Object.getOwnPropertySymbols(value).some(key => Object.getOwnPropertyDescriptor(value, key)?.enumerable)) {
    throw new TypeError('Shared state cannot have enumerable symbol keys');
  }
  const structures = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (!('value' in descriptor)) throw new TypeError('Shared state cannot have getters or setters');
    structures[key] = descriptor.value;
  }
  return { single: false, structures };
}
export function identities(data: WorkerData): Readonly<Record<string, string>> {
  const result = Object.create(null);
  for (const [name, item] of Object.entries(data.structures)) {
    result[name] = JSON.stringify([item.type, item.arena, item.data]);
  }
  return Object.freeze(result);
}
export function capture<T extends object>(value: T): Capture<T> {
  const { single, structures } = recordOf(value);
  const data = getWorkerData(structures, { copy: false });
  return { value: (single ? value : Object.freeze(structures)) as T, single, data, identities: identities(data) };
}
export function same(a: Pick<Capture, 'single' | 'identities'>, b: Pick<Capture, 'single' | 'identities'>): boolean {
  const keys = Object.keys(a.identities);
  return a.single === b.single && keys.length === Object.keys(b.identities).length && keys.every(key => a.identities[key] === b.identities[key]);
}
export function isMessage(value: any, channel: string): value is Message {
  return value?.protocol === PROTOCOL && value.channel === channel;
}
export function message(channel: string, fields: Omit<Message, 'protocol' | 'version' | 'channel'>): Message {
  return { protocol: PROTOCOL, version: WIRE_VERSION, channel, ...fields };
}
const reservations = new WeakMap<object, Set<string>>();
export function reserve(endpoint: SharedEndpoint, key: string): () => void {
  let keys = reservations.get(endpoint);
  if (!keys) reservations.set(endpoint, keys = new Set());
  if (keys.has(key)) throw new Error(`A session already uses this endpoint and channel (${key})`);
  keys.add(key);
  return () => { keys!.delete(key); if (!keys!.size) reservations.delete(endpoint); };
}
export function defaultEndpoint(): SharedEndpoint {
  if (typeof document !== 'undefined' || typeof (globalThis as any).postMessage !== 'function') {
    throw new Error('Pass endpoint explicitly outside a browser worker (for Node, use parentPort)');
  }
  return globalThis as unknown as SharedEndpoint;
}
/** Add listeners without replacing application handlers or closing caller-owned ports. */
export function listen(endpoint: SharedEndpoint, receive: (data: any) => void, fail: (error: Error) => void): () => void {
  if (!endpoint || typeof endpoint.postMessage !== 'function') throw new TypeError('Invalid shared-session endpoint');
  const remove: (() => void)[] = [];
  if (endpoint.addEventListener && endpoint.removeEventListener) {
    const onMessage = (event: any) => receive(event.data);
    const onError = (event: any) => fail(errorOf(event.error ?? event.message ?? 'Worker message error'));
    endpoint.addEventListener('message', onMessage);
    endpoint.addEventListener('messageerror', onError);
    endpoint.addEventListener('error', onError);
    remove.push(() => {
      endpoint.removeEventListener!('message', onMessage);
      endpoint.removeEventListener!('messageerror', onError);
      endpoint.removeEventListener!('error', onError);
    });
  } else if (endpoint.on && endpoint.off) {
    const onError = (error: any) => fail(errorOf(error));
    endpoint.on('message', receive);
    endpoint.on('messageerror', onError);
    endpoint.on('error', onError);
    remove.push(() => { endpoint.off!('message', receive); endpoint.off!('messageerror', onError); endpoint.off!('error', onError); });
  } else throw new TypeError('Endpoint must support addEventListener/removeEventListener or on/off');
  if (endpoint.on && endpoint.off) {
    const onClose = () => fail(new Error('Worker or port closed'));
    endpoint.on('exit', onClose); endpoint.on('close', onClose);
    remove.push(() => { endpoint.off!('exit', onClose); endpoint.off!('close', onClose); });
  }
  try { endpoint.start?.(); } catch (error) { for (const cleanup of remove) cleanup(); throw error; }
  return () => { for (const cleanup of remove) cleanup(); };
}
