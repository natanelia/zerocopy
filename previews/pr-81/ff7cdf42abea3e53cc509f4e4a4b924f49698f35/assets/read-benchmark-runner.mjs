import { Peer } from './catalog-peer.mjs';
import { readCase } from './catalog-read-workloads.mjs';
import { validateCount } from './catalog-core.mjs';

/** A fresh owner and two fresh readers for every API/workload/sample. */
export async function sampleReadCase(definition, count, { signal } = {}) {
  readCase(definition.id); validateCount(count);
  signal?.throwIfAborted();
  const start = performance.now();
  const peer = new Peer(new URL('./read-benchmark-owner.mjs', import.meta.url));
  const abort = () => peer.close(signal?.reason instanceof Error ? signal.reason : new Error('Read benchmark cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await peer.request('prepare', { caseId: definition.id });
    const startupMs = performance.now() - start;
    signal?.throwIfAborted();
    const result = await peer.request('sample', { count });
    signal?.throwIfAborted();
    result.startupMs = startupMs;
    if (result.status !== 'passed') {
      const error = new Error(result.failure?.message ?? 'Read benchmark failed');
      error.sample = result;
      throw error;
    }
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    peer.close();
  }
}
