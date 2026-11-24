import { initWorker } from '../dist/shared.js';
let old: any;
self.onmessage = async ({ data }) => {
  try {
    const s: any = await initWorker(data);
    if (!old) old = s;
    let blocked = false;
    try { s.map.set('illegal', 1); } catch (error) { blocked = /read-only/.test(String(error)); }
    const packed: Float64Array<ArrayBuffer> = s.list.toFloat64Array();
    self.postMessage({
      map: s.map.get('value'), original: old.map.get('value'), list: s.list.toArray(),
      nested: s.nested.get('list').toArray(), packed, frozen: Object.isFrozen(s.map.get('value')), blocked,
      shared: data.arenas.every((a: any) => a.memory?.buffer instanceof SharedArrayBuffer && !a.copy),
    }, [packed.buffer]);
  } catch (error) { self.postMessage({ error: String(error) }); }
};
