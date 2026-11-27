import { normalizeKey } from './arena.ts';
import { SharedMap } from './shared-map.ts';
import { notifySubscribers } from './snapshot-listeners.ts';
import type { JsonType } from './types.ts';

type Receipt = void | true | Promise<void>;
type Cleanup = (() => void) | (() => Promise<void>);
type SourceWrite<T> = { type: 'insert' | 'update' | 'delete'; value: T; metadata?: Record<string, unknown> }
  | { type: 'delete'; key: string; metadata?: Record<string, unknown> };
// Structural types keep zerocopy/tanstack importable without its optional peer.
// Real adapters still receive the original collection, metadata and sync hooks.
interface SyncControls<T> {
  collection: { getKeyFromItem(value: T): string };
  begin(options?: { snapshot?: boolean }): void;
  truncate(options?: { markReady?: boolean }): void;
  write(message: SourceWrite<T>): void;
  commit(signal?: AbortSignal): Receipt;
  markReady(): void;
  fail?(reason: unknown): void;
}
interface SyncHooks {
  cleanup?: Cleanup;
  loadSubset?(options: unknown): true | Promise<void>;
  unloadSubset?(options: unknown): void;
  restartAfterScopedRecovery?(ready: Promise<void>): void | Promise<void>;
}
interface Upstream<T> {
  sync(params: SyncControls<T>): void | Cleanup | SyncHooks;
  rowUpdateMode?: 'partial' | 'full';
  getSyncMetadata?(): Record<string, unknown>;
  exportSyncMeta?(): unknown;
  importSyncMeta?(metadata: unknown): void;
  mergeSyncMeta?(current: unknown, incoming: unknown): unknown;
}
type Patch<T> = { value: T; merge: boolean } | null;
type Batch<T> = { replace: boolean; patches: Map<string, Patch<T>> };

function capturePatch<T extends object>(value: T, merge: boolean, prior: Patch<T> | undefined): Patch<T> {
  // Providers can reuse their arguments. Invalid JSON must fail before the
  // downstream write, and pending batches must retain the original fields.
  const copy = JSON.parse(JSON.stringify(value));
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new TypeError('Expected a JSON row object');
  if (!merge) return { value: copy, merge: false };
  // An explicitly undefined field overwrites an earlier value and disappears
  // on JSON encoding. An omitted field leaves the earlier value intact.
  for (const field of Object.keys(value)) {
    if (!Object.hasOwn(copy, field)) Object.defineProperty(copy, field, { value: undefined, enumerable: true });
  }
  return prior ? { value: { ...prior.value, ...copy }, merge: prior.merge }
    : { value: copy, merge: prior !== null };
}

function applyBatch<T extends object>(before: SharedMap<'object'>, batch: Batch<T>): SharedMap<'object'> {
  const base = batch.replace ? new SharedMap('object') : before;
  const writes: [string, T][] = [], deletes: string[] = [];
  for (const [key, patch] of batch.patches) {
    if (!patch) deletes.push(key);
    else writes.push([key, patch.merge ? { ...base.get(key), ...patch.value } : patch.value]);
  }
  return base.deleteMany(deletes).setMany(writes);
}

/** Publish an upstream adapter's visible sync batches as immutable string-keyed row snapshots. */
export function withConfirmedSharedCache<T extends object, Config extends Upstream<T> = Upstream<T>>(upstream: Config & Upstream<T>) {
  let rows = new SharedMap('object');
  let attached = false;
  const listeners = new Set<() => void>();
  const sync = {
    ...upstream,
    sync(params: SyncControls<T>) {
      if (attached) throw new Error('This confirmed cache already has an active sync run');
      attached = true;
      let live = true;
      let open: Batch<T> | undefined;
      type Pending = {
        batch: Batch<T>; base: typeof rows; next: typeof rows;
        status: 'waiting' | 'visible' | 'rejected';
      };
      const pending = new Map<number, Pending>();
      let head = 0, tail = 0;

      function close() {
        if (!live) return;
        live = false; attached = false; open = undefined; pending.clear();
      }
      function settle(sequence: number, status: 'visible' | 'rejected') {
        const entry = pending.get(sequence);
        if (!entry) return;
        entry.status = status;
        let ready: Pending | undefined;
        while ((ready = pending.get(head)) && ready.status !== 'waiting') {
          pending.delete(head++);
          if (ready.status === 'rejected') continue;
          // A preceding receipt may have rejected. Merge this batch's captured
          // fields over the last successful root, never over the rejected rows.
          const next = ready.base === rows ? ready.next : applyBatch(rows, ready.batch);
          if (next === rows) continue;
          rows = next;
          notifySubscribers(listeners, error => console.error('[zerocopy/tanstack] snapshot listener failed', error));
        }
      }
      try {
        const result = upstream.sync({
          ...params,
          begin(options) {
            if (!live) return;
            params.begin(options);
            open = { replace: options?.snapshot === true, patches: new Map() };
          },
          truncate(options) {
            if (!live) return;
            params.truncate(options);
            if (open) { open.replace = true; open.patches.clear(); }
          },
          write(message) {
            if (!live) return;
            if (!open) throw new Error('Begin a sync batch before writing rows');
            const key = 'key' in message ? message.key : params.collection.getKeyFromItem(message.value);
            if (typeof key !== 'string') throw new TypeError('Confirmed cache keys must be strings');
            if (normalizeKey(key) !== key) throw new TypeError('Confirmed cache keys must be well-formed Unicode');
            const merge = message.type === 'update' && upstream.rowUpdateMode !== 'full';
            const patch = message.type === 'delete' ? null : capturePatch(message.value, merge, open.patches.get(key));
            params.write(message);
            open.patches.set(key, patch);
          },
          commit(signal) {
            if (!live) return true;
            if (!open) return params.commit(signal);
            const batch = open;
            const base = pending.get(tail - 1)?.next ?? rows;
            const entry: Pending = { batch, base, next: applyBatch(base, batch), status: 'waiting' };
            open = undefined;
            const sequence = tail++;
            pending.set(sequence, entry);
            let receipt: Receipt;
            try { receipt = params.commit(signal); }
            catch (error) {
              settle(sequence, 'rejected');
              if (live && !open && sequence + 1 === tail) open = batch;
              throw error;
            }
            if (receipt && receipt !== true) {
              void receipt.then(() => settle(sequence, 'visible'), () => settle(sequence, 'rejected')).catch(error => {
                // Rebasing after another receipt failed can need fresh storage.
                // Retire the run if that allocation fails after downstream commit.
                close();
                if (params.fail) params.fail(error);
                else console.error('[zerocopy/tanstack] confirmed cache publication failed', error);
              });
            } else settle(sequence, 'visible');
            // Keep the upstream's original visibility and acceptance receipt.
            return receipt;
          },
        });
        return { ...(typeof result === 'object' ? result : {}), cleanup() {
          close();
          if (typeof result === 'function') return result();
          if (result) return result.cleanup?.();
        } };
      } catch (error) { close(); throw error; }
    },
  };
  return {
    sync,
    getSnapshot: () => rows as unknown as SharedMap<JsonType<T>>,
    subscribe(listener: () => void) {
      const subscription = () => listener();
      listeners.add(subscription);
      return () => { listeners.delete(subscription); };
    },
  };
}
