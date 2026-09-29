import { RPC } from './explorer-core.mjs';
/** A small application protocol for whole operations. Never used for per-field reads. */
export class Peer {
  constructor(url, onStatus = () => {}, onFatal = () => {}) {
    // WebKit does not reliably apply a page's service worker to nested-worker
    // entry requests. A local module wrapper inherits the parent's isolation.
    // Its only import is the same trusted, absolute module URL used normally.
    this.moduleURL = typeof document === 'undefined'
      ? URL.createObjectURL(new Blob([`import ${JSON.stringify(url.href)};`], { type: 'text/javascript' }))
      : undefined;
    try { this.worker = new Worker(this.moduleURL ?? url, { type: 'module' }); }
    catch (error) { if (this.moduleURL) URL.revokeObjectURL(this.moduleURL); throw error; }
    this.onFatal = onFatal; this.pending = new Map(); this.sequence = 0; this.closed = false;
    this.worker.onmessage = ({ data }) => {
      if (data?.protocol !== RPC) return;
      if (data.type === 'status') { onStatus(data); return; }
      const item = this.pending.get(data.id);
      if (!item) return;
      this.pending.delete(data.id); clearTimeout(item.timer);
      data.error ? item.reject(new Error(data.error)) : item.resolve(data.value);
    };
    this.worker.onerror = event => this.fail(new Error(event.message || `Worker script could not load (${url.pathname}). Check the isolation headers.`), onFatal);
    this.worker.onmessageerror = () => this.fail(new Error('Unreadable worker response'), onFatal);
  }
  request(type, body = {}, timeoutMs = 60_000) {
    if (this.closed) return Promise.reject(new Error('Worker connection is closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Worker operation timed out: ${type}`), this.onFatal), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ ...body, protocol: RPC, type, id }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  fail(error, callback = () => {}) { this.close(error); callback(error); }
  close(error = new Error('Worker connection closed')) {
    if (this.closed) return;
    this.closed = true; this.worker.terminate();
    if (this.moduleURL) { URL.revokeObjectURL(this.moduleURL); this.moduleURL = undefined; }
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
}
export function reply(id, value) { self.postMessage({ protocol: RPC, id, value }); }
export function failure(id, error) { self.postMessage({ protocol: RPC, id, error: error?.message ?? String(error) }); }
export function status(message, values = {}) { self.postMessage({ protocol: RPC, type: 'status', message, ...values }); }
