import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { CASES, WARM, create, prepare, update, read, oracle, fixtureInfo, assertKeyHashes } from './cases.mjs';

const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const errorText = error => error?.stack ?? String(error);
const now = () => performance.now();
const SMOKE_CASE = { id: 'transport-smoke', kind: 'many', n: 1 };

// One set of lifetime listeners; every expectation has a bounded, cleared timer.
function monitor(worker) {
  const pending = new Map();
  let failure, stopping = false, exited = false, exitCode;
  let exitResolve;
  const exitPromise = new Promise(resolve => { exitResolve = resolve; });
  const fail = error => {
    failure ??= error;
    for (const entry of [...pending.values()]) entry.finish(failure);
  };
  const onMessage = data => {
    if (data?.bench === 'fatal') return fail(new Error(data.error));
    if (!data?.bench) return; // The public session owns its own protocol messages.
    const key = `${data.bench}:${data.sequence ?? ''}`;
    const entry = pending.get(key);
    if (!entry) return fail(new Error(`Unexpected benchmark message ${key}`));
    entry.finish(undefined, { data, receivedAt: now() });
  };
  const onError = error => fail(error);
  const onExit = code => {
    exited = true; exitCode = code; exitResolve(code);
    if (!stopping || code !== 0) fail(new Error(`Unexpected worker exit ${code}`));
    else if (pending.size) fail(new Error('Worker exited before its expected acknowledgement'));
  };
  worker.on('message', onMessage); worker.on('error', onError); worker.on('exit', onExit);
  return {
    check() { if (failure) throw failure; if (exited && !stopping) throw new Error('Worker already exited'); },
    fail,
    wait(bench, sequence, timeoutMs = 10000) {
      if (failure) return Promise.reject(failure);
      const key = `${bench}:${sequence ?? ''}`;
      if (pending.has(key)) return Promise.reject(new Error(`Duplicate expectation ${key}`));
      const promise = new Promise((resolve, reject) => {
        const finish = (error, value) => { clearTimeout(timer); pending.delete(key); error ? reject(error) : resolve(value); };
        const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${key}`)), timeoutMs);
        pending.set(key, { finish });
      });
      promise.catch(() => {});
      return promise;
    },
    async cleanup() {
      stopping = true;
      let stopped, cleanupError;
      try {
        if (!failure && !exited) {
          const waiting = this.wait('stopped', undefined, 2000);
          worker.postMessage({ bench: 'stop' });
          stopped = (await waiting).data;
        }
      } catch (error) { cleanupError = errorText(error); }
      let timer, terminateRequested = false;
      try {
        if (!exited) {
          await Promise.race([exitPromise, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]);
          if (!exited) { terminateRequested = true; await worker.terminate(); }
        }
      } catch (error) { cleanupError ??= errorText(error); }
      finally {
        clearTimeout(timer);
        for (const entry of [...pending.values()]) entry.finish(new Error('Worker cleanup'));
        worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit);
      }
      return { stopAcknowledged: !!stopped, worker: stopped, terminateRequested, exited, exitCode,
        pendingWaiters: pending.size, harnessListenersRemoved: true, error: cleanupError ?? (failure && errorText(failure)) };
    },
  };
}

async function readerWorker() {
  const c = workerData.smoke ? SMOKE_CASE : CASES.find(c => c.id === workerData.caseId);
  const z = await import(workerData.shared);
  const api = await import(workerData.worker);
  let reader, initial, current, unsubscribe, handling = Promise.resolve();
  const smokeFrames = [];
  const fatal = error => parentPort.postMessage({ bench: 'fatal', error: errorText(error) });
  const report = (state, sequence) => {
    const t = now(); const checksum = read(c, state); const readMs = now() - t;
    parentPort.postMessage({ bench: 'read', sequence, checksum, readMs,
      transport: workerData.smoke ? smokeFrames.at(-1) : undefined });
  };
  const onMessage = message => {
    if (workerData.smoke && message?.protocol === 'zerocopy/session' && message.kind === 'snapshot') {
      const transport = { sequence: message.sequence, arenas: message.data.arenas.length, memoryHandles: 0, copyEntries: 0 };
      for (const arena of message.data.arenas) {
        if (arena.copy !== undefined) transport.copyEntries++;
        if (arena.memory) {
          assert.ok(arena.memory instanceof WebAssembly.Memory);
          assert.ok(arena.memory.buffer instanceof SharedArrayBuffer);
          transport.memoryHandles++;
        }
      }
      assert.equal(transport.copyEntries, 0, 'copy:false was not shared transport');
      smokeFrames.push(transport);
      return;
    }
    if (!message?.bench) return;
    handling = handling.then(async () => {
      if (message.bench === 'initial-read') { report(current, 0); return; }
      if (message.bench === 'raw') {
        current = await z.initWorker(message.payload);
        if (message.sequence === 0) {
          initial = current;
          parentPort.postMessage({ bench: 'attached' });
        } else report(current, message.sequence);
        return;
      }
      if (message.bench === 'stop') {
        unsubscribe?.(); reader?.dispose();
        // Public re-export only, after measurements, with no copied payload.
        const memories = new Set();
        for (const state of [initial, current]) if (state) {
          for (const arena of z.getWorkerData(state, { copy: false }).arenas) memories.add(arena.memory);
        }
        const retainedHandleBackingBytes = [...memories].reduce((n, memory) => n + memory.buffer.byteLength, 0);
        parentPort.off('message', onMessage);
        parentPort.postMessage({ bench: 'stopped', retainedHandleBackingBytes, retainedMemoryHandles: memories.size,
          mayDoubleCountSharedBacking: c.copy !== true,
          messageListenersRemaining: parentPort.listenerCount('message') });
        initial = current = reader = undefined;
        parentPort.close(); return;
      }
      throw new Error(`Unknown worker command ${message.bench}`);
    }).catch(fatal);
  };
  parentPort.on('message', onMessage);
  if (!c.raw) {
    api.connectSharedSession({ endpoint: parentPort, channel: 'session-cache-screen', timeoutMs: 10000, onError: fatal })
      .then(connected => {
        reader = connected; initial = current = reader.current;
        unsubscribe = reader.subscribe((state, sequence) => { current = state; report(state, sequence); });
        parentPort.postMessage({ bench: 'attached' });
      }).catch(fatal);
  }
  parentPort.postMessage({ bench: 'ready' });
}

async function transportSmoke(z, api, config) {
  const initial = create(z, SMOKE_CASE), oracleState = oracle(SMOKE_CASE);
  let worker, watched, session, failure, evidence;
  try {
    session = api.createSharedState(initial, { copy: false, channel: 'session-cache-screen', timeoutMs: 10000,
      onError: error => watched?.fail(error) });
    worker = new Worker(new URL(import.meta.url), { workerData: { smoke: true, caseId: SMOKE_CASE.id,
      shared: config.shared, worker: config.worker } });
    watched = monitor(worker);
    const ready = watched.wait('ready'), attached = watched.wait('attached');
    await ready;
    await Promise.all([session.connect(worker), attached]);
    const first = watched.wait('read', 0);
    worker.postMessage({ bench: 'initial-read' });
    const firstData = (await first).data;
    assert.equal(firstData.checksum, oracleState.checksum);
    assert.deepEqual(firstData.transport, { sequence: 0, arenas: 1, memoryHandles: 1, copyEntries: 0 });
    const prepared = prepare(SMOKE_CASE, 1, oracleState), second = watched.wait('read', 1);
    session.update(state => update(SMOKE_CASE, state, prepared));
    const secondData = (await second).data;
    assert.equal(secondData.checksum, prepared.checksum);
    assert.deepEqual(secondData.transport, { sequence: 1, arenas: 1, memoryHandles: 0, copyEntries: 0 });
    evidence = { initialChecksum: firstData.checksum, updatedChecksum: secondData.checksum,
      initialTransport: firstData.transport, updatedTransport: secondData.transport };
  } catch (error) { failure = error; }
  finally {
    try { session?.dispose(); } catch (error) { failure ??= error; }
    const cleanup = watched ? await watched.cleanup() : { error: 'Worker was not initialized' };
    emit({ event: 'smoke-cleanup', ...cleanup });
    if (cleanup.error || !cleanup.stopAcknowledged || cleanup.worker?.messageListenersRemaining !== 0 || !cleanup.exited)
      failure ??= new Error(`Incomplete smoke cleanup: ${JSON.stringify(cleanup)}`);
    z.configureMemory({ maximumBytes: 2 * 1024 * 1024 }); z.resetMap(); z.resetSharedList();
  }
  if (failure) throw failure;
  emit({ event: 'transport-smoke-success', copy: false, realWorker: true, ...evidence });
}

function storage(z, c, state, totals) {
  const payload = z.getWorkerData(state, { copy: false });
  assert.equal(payload.arenas.length, c.kind === 'many' ? 64 : 1);
  const ids = new Set(payload.arenas.map(arena => arena.id));
  assert.equal(ids.size, payload.arenas.length);
  const usedBytes = payload.arenas.reduce((n, arena) => n + arena.used, 0);
  const backingBytes = payload.arenas.reduce((n, arena) => n + arena.memory.buffer.byteLength, 0);
  assert.ok(backingBytes <= 128 * 1024 * 1024, 'Declared native backing budget exceeded');
  if (c.copy) {
    totals.copyPrefixes += usedBytes;
    assert.ok(usedBytes <= 16 * 1024 * 1024, 'Copy prefix exceeds 16 MiB');
    assert.ok(totals.copyPrefixes <= 768 * 1024 * 1024, 'Cumulative copy prefixes exceed 768 MiB');
  }
  return { usedBytes, backingBytes, copyPrefixSumBytes: c.copy ? totals.copyPrefixes : 0 };
}

async function runCase(z, api, config, c, count) {
  const caseStart = now();
  const oracleState = oracle(c), totals = { copyPrefixes: 0 };
  const initial = create(z, c); // Deliberately retained until this case ends.
  let current = initial, session, worker, watched, result, failed, activeOperation;
  const info = fixtureInfo(c, count);
  const initialStorage = storage(z, c, initial, totals);
  const rows = [];
  let readinessMs, attachmentMs, initialReadMs, initialWorkerReadMs, warmWallMs, measuredWallMs;
  try {
    if (!c.raw) session = api.createSharedState(initial, { copy: c.copy === true,
      channel: 'session-cache-screen', timeoutMs: 10000, onError: error => watched?.fail(error) });
    const readyStart = now();
    worker = new Worker(new URL(import.meta.url), { workerData: { caseId: c.id, shared: config.shared, worker: config.worker } });
    watched = monitor(worker);
    const ready = watched.wait('ready');
    const attached = watched.wait('attached');
    readinessMs = (await ready).receivedAt - readyStart;
    const attachStart = now();
    if (c.raw) worker.postMessage({ bench: 'raw', sequence: 0, payload: z.getWorkerData(initial, { copy: false }) });
    const connection = c.raw ? Promise.resolve() : session.connect(worker);
    const [, attachedResult] = await Promise.all([connection, attached]);
    attachmentMs = attachedResult.receivedAt - attachStart;
    const first = watched.wait('read', 0);
    const readStart = now(); worker.postMessage({ bench: 'initial-read' });
    const firstRead = await first;
    initialReadMs = firstRead.receivedAt - readStart; initialWorkerReadMs = firstRead.data.readMs;
    emit({ event: 'initial', case: c.id, readinessMs, attachmentMs, initialReadMs, initialWorkerReadMs,
      checksum: firstRead.data.checksum, expectedChecksum: oracleState.checksum, storage: initialStorage, fixture: info });
    assert.equal(firstRead.data.checksum, oracleState.checksum);
    const loop = async (start, stop, phase) => {
      const wallStart = now();
      for (let revision = start; revision <= stop; revision++) {
        watched.check();
        const prepared = prepare(c, revision, oracleState); // Input generation and oracle outside timer.
        const waiting = watched.wait('read', revision);
        activeOperation = { phase, revision, startedAt: undefined, expectedChecksum: prepared.checksum };
        const t = now();
        activeOperation.startedAt = t;
        if (c.raw) {
          current = update(c, current, prepared);
          worker.postMessage({ bench: 'raw', sequence: revision, payload: z.getWorkerData(current, { copy: false }) });
        } else session.update(state => update(c, state, prepared));
        const received = await waiting;
        const elapsedMs = received.receivedAt - t;
        if (!c.raw) current = session.current;
        let memory, storageError;
        try { memory = storage(z, c, current, totals); } catch (error) { storageError = error; }
        const row = { event: 'revision', case: c.id, phase, revision, elapsedMs,
          workerReadMs: received.data.readMs, checksum: received.data.checksum, expectedChecksum: prepared.checksum,
          storage: memory, storageError: storageError && errorText(storageError) };
        rows.push(row); emit(row);
        assert.equal(received.data.sequence, revision);
        assert.equal(received.data.checksum, prepared.checksum, `${c.id} revision ${revision}`);
        if (!c.raw) assert.equal(session.version, revision);
        if (storageError) throw storageError;
        activeOperation = undefined;
      }
      return now() - wallStart;
    };
    warmWallMs = await loop(1, WARM, 'warm');
    measuredWallMs = await loop(WARM + 1, WARM + count, 'measured');
    const measured = rows.filter(row => row.phase === 'measured');
    result = { event: 'case', case: c.id, valid: true, fixture: info,
      readinessMs, attachmentMs, initialReadMs, initialWorkerReadMs, warmWallMs, measuredWallMs,
      aggregateMs: measured.reduce((sum, row) => sum + row.elapsedMs, 0), count,
      finalStorage: rows.at(-1).storage };
  } catch (error) {
    failed = error;
    emit({ event: 'failure', case: c.id, error: errorText(error), completedRevisions: rows.length,
      activeOperation: activeOperation && { ...activeOperation, failedAfterMs: now() - activeOperation.startedAt } });
  } finally {
    let sessionDisposed = false;
    try { session?.dispose(); sessionDisposed = true; } catch (error) { failed ??= error; }
    const cleanup = watched ? await watched.cleanup() : { error: 'Worker was not initialized' };
    emit({ event: 'cleanup', case: c.id, sessionDisposed, ...cleanup });
    if (cleanup.error || !cleanup.stopAcknowledged || cleanup.worker?.messageListenersRemaining !== 0 || !cleanup.exited)
      failed ??= new Error(`Incomplete worker cleanup: ${JSON.stringify(cleanup)}`);
    if (c.copy && cleanup.worker?.retainedHandleBackingBytes > 40 * 1024 * 1024)
      failed ??= new Error('Retained copy-reader backing exceeds 40 MiB');
    // Release both types' module defaults, including a previous fixture of the
    // other type. These fresh empty arenas have small reservations.
    let defaultArenasReleased = false;
    try {
      z.configureMemory({ maximumBytes: 2 * 1024 * 1024 });
      z.resetMap(); z.resetSharedList(); defaultArenasReleased = true;
    } catch (error) { failed ??= error; }
    emit({ event: 'default-arenas-released', case: c.id, valid: defaultArenasReleased });
  }
  if (failed) throw failed;
  result.wallMs = now() - caseStart;
  result.rssBytesAfterCase = process.memoryUsage().rss;
  emit(result);
}

if (!isMainThread) {
  readerWorker().catch(error => { parentPort.postMessage({ bench: 'fatal', error: errorText(error) }); parentPort.close(); });
} else {
  try {
    const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const runtime = { node: process.versions.node, bun: process.versions.bun ?? null, platform: process.platform, arch: process.arch };
    assert.equal(config.engine.name === 'bun' ? runtime.bun : runtime.node, config.engine.version);
    assert.equal(config.engine.name === 'bun', runtime.bun !== null);
    assert.equal(assertKeyHashes(), 1024);
    // Explicit retained paths bypass package aliases and variant deduplication.
    config.shared = pathToFileURL(config.shared).href; config.worker = pathToFileURL(config.worker).href;
    const z = await import(config.shared), api = await import(config.worker);
    emit({ event: 'start', runtime, variant: config.variant, pair: config.pair, mode: config.mode,
      bindingDigest: config.bindingDigest, modulePaths: { shared: config.shared, worker: config.worker } });
    if (config.mode === 'transport-smoke') await transportSmoke(z, api, config);
    else for (const id of config.order) {
        const c = CASES.find(c => c.id === id), count = config.counts[id];
        assert.ok(c && Number.isInteger(count) && count >= 8 && count <= c.max && count % 8 === 0);
        await runCase(z, api, config, c, count);
      }
    emit({ event: 'done', valid: true });
  } catch (error) { emit({ event: 'fatal', error: errorText(error) }); process.exitCode = 1; }
}
