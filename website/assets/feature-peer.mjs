import { RPC } from './feature-core.mjs';

/** Whole-operation messages with owned worker cleanup. No per-field RPC. */
export class Peer {
  constructor(url) {
    this.moduleURL = typeof document === 'undefined' ? URL.createObjectURL(new Blob([`import ${JSON.stringify(url.href)};`], { type: 'text/javascript' })) : undefined;
    try { this.worker = new Worker(this.moduleURL ?? url, { type: 'module' }); }
    catch (error) { if (this.moduleURL) URL.revokeObjectURL(this.moduleURL); throw error; }
    this.pending = new Map(); this.sequence = 0; this.closed = false;
    this.worker.onmessage = ({ data }) => {
      if (data?.protocol !== RPC) return;
      const item = this.pending.get(data.id); if (!item) return;
      this.pending.delete(data.id); clearTimeout(item.timer);
      data.error ? item.reject(new Error(data.error)) : item.resolve(data.value);
    };
    this.worker.onerror = event => this.close(new Error(event.message || 'Feature worker could not load'));
    this.worker.onmessageerror = () => this.close(new Error('Unreadable feature worker reply'));
  }
  request(type, body = {}, timeout = 60_000) {
    if (this.closed) return Promise.reject(new Error('Worker connection is closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error(`Feature operation timed out: ${type}`)), timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ ...body, protocol: RPC, type, id }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  close(error = new Error('Worker connection is closed')) {
    if (this.closed) return;
    this.closed = true; this.worker.terminate();
    if (this.moduleURL) URL.revokeObjectURL(this.moduleURL);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
}
export function listen(run) {
  let busy = false;
  self.onmessage = async ({ data }) => {
    if (data?.protocol !== RPC) return;
    if (busy) { self.postMessage({ protocol: RPC, id: data.id, error: 'Another operation is running' }); return; }
    busy = true;
    try { const value = await run(data); self.postMessage({ protocol: RPC, id: data.id, value }); }
    catch (error) { self.postMessage({ protocol: RPC, id: data.id, error: error?.message ?? String(error) }); }
    finally { busy = false; }
  };
}
