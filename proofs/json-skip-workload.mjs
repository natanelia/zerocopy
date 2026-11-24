export const rowCount = 10000;
export const workloads = ['message', 'nested-message', 'coordinates', 'escaped-message', 'short-record'];

const message = 'Inventory service update · 東京 warehouse · stock confirmation '.repeat(36);
const escaped = 'Inventory "update" \\ warehouse\n\t · 東京 '.repeat(35);
const coordinates = Array.from({ length: 128 }, (_, i) => [103.85 + i / 1234, 1.29 + i / 456]);

function detailFor(workload, index) {
  switch (workload) {
    case 'message': return `Trace ${index} · ${message}`;
    case 'nested-message': return { logs: [{ level: 'info', message: `Trace ${index} · ${message}` }] };
    case 'coordinates': return { route: { coordinates, attempt: index % 4 } };
    case 'escaped-message': return `Trace ${index} · ${escaped}`;
    case 'short-record': return { source: 'inventory', region: 'apac' };
    default: throw new Error(`Unknown workload ${workload}`);
  }
}

const ids = Array.from({ length: rowCount }, (_, index) => `trace/${index.toString().padStart(6, '0')}`);

export function createPayload(api) {
  const maps = {};
  for (const workload of workloads) {
    api.resetMap();
    maps[workload] = new api.SharedMap('object').setMany(ids.map((id, index) => [id, {
      timestamp: index, detail: detailFor(workload, index), duration: index % 200,
      status: index % 5 === 0 ? 'failed' : 'ok',
    }]));
  }
  const payload = api.getWorkerData(maps, { copy: false });
  if (payload.arenas.some(arena => arena.copy || !(arena.memory?.buffer instanceof SharedArrayBuffer))) {
    throw new Error('The workload requires shared memory');
  }
  return payload;
}

export function measureProjection(maps, workload) {
  const map = maps[workload];
  let matches = 0, timestampSum = 0;
  const start = performance.now();
  for (const id of ids) {
    const view = map.getView(id);
    if (view.get('duration') >= 100 && view.equals('status', 'failed')) {
      matches++;
      timestampSum += view.get('timestamp');
    }
  }
  return { elapsedMs: performance.now() - start, matches, timestampSum };
}

// A Chromium worker imports this module directly and receives the owner's
// payload. Node and Bun run the identical query through a local attachment.
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  let maps;
  globalThis.onmessage = async ({ data }) => {
    try {
      if (typeof data === 'string') globalThis.postMessage(measureProjection(maps, data));
      else {
        const api = await import('./library/shared.js');
        maps = await api.initWorker(data);
        globalThis.postMessage({ ready: true });
      }
    } catch (error) {
      globalThis.postMessage({ error: String(error) });
    }
  };
}
