// One unchanged public-API kernel. Only one physical original package is loaded.
// Variant names, source paths, pins, controller settings and role labels are absent.
import assert from 'node:assert/strict';
import { writeSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
const S = await import('zerocopy');
const W = await import('zerocopy/worker');
const emit = event => writeSync(1, JSON.stringify(event) + '\n');
const clock = () => process.hrtime.bigint();

if (!isMainThread) {
  const { workload, config, timed } = workerData;
  const reader = await W.connectSharedSession({ endpoint: parentPort, timeoutMs: config.sessionTimeoutMs });
  const retained = reader.current;
  let busy = false;
  parentPort.on('message', message => {
    if (message.screen !== 'arm') return;
    assert.equal(busy, false); busy = true;
    runRound(message).then(result => { busy = false; parentPort.postMessage({ screen: 'done', ...result }); }, error => parentPort.postMessage({ screen: 'error', error: error.stack }));
  });
  parentPort.postMessage({ screen: 'connected' });
  async function runRound({ id, startVersion }) {
    const { updates, streams: count, consumer } = workload;
    assert.equal(reader.version, startVersion);
    const target = startVersion + updates, versions = new WeakMap([[reader.current, startVersion]]);
    const delivered = new Float64Array(updates), deliveredValues = new Uint8Array(updates);
    const consumed = Array.from({ length: count }, () => new Float64Array(consumer === 'paused' ? 1 : updates));
    const values = consumed.map(x => new Uint8Array(x.length));
    let accepted = 0, finalDelivery;
    const arrived = new Promise(resolve => { finalDelivery = resolve; });
    // This listener precedes stream listeners so their returned snapshot has a version.
    const unsubscribe = reader.subscribe((snapshot, version) => {
      versions.set(snapshot, version); delivered[accepted] = version;
      deliveredValues[accepted++] = snapshot.get('key0');
      if (version === target) finalDelivery();
    });
    const streams = Array.from({ length: count }, () => reader.snapshots());
    const initialConsumed = [];
    const consume = async (stream, index) => {
      for (let n = 0; n < consumed[index].length; n++) {
        const item = await stream.next();
        if (item.done) throw new Error('Stream ended before final publication');
        consumed[index][n] = versions.get(item.value) ?? -1;
        values[index][n] = item.value.get('key0');
      }
    };
    let readers;
    if (consumer === 'waiting') {
      for (const stream of streams) {
        const initial = await stream.next();
        assert.equal(initial.done, false); assert.equal(versions.get(initial.value), startVersion);
        initialConsumed.push(startVersion);
      }
      // Each function reaches next() synchronously before ready is sent.
      readers = Promise.all(streams.map(consume));
    }
    parentPort.postMessage({ screen: 'ready', id, startVersion });
    if (consumer === 'paused') {
      // Await resumes after the entire final notify(), including all stream listeners.
      await arrived;
      readers = Promise.all(streams.map(consume));
    }
    await readers;
    const endNs = timed ? clock().toString() : null;
    // Everything below is outside the interval, including serialization and assertions.
    unsubscribe();
    assert.equal(accepted, updates, 'Every promised update must reach Reader');
    assert.equal(reader.version, target);
    for (let n = 0; n < updates; n++) {
      assert.equal(delivered[n], startVersion + n + 1);
      assert.equal(deliveredValues[n], (n + 1) % 2);
    }
    for (let i = 0; i < count; i++) for (let n = 0; n < consumed[i].length; n++) {
      const expected = consumer === 'paused' ? target : startVersion + n + 1;
      assert.equal(consumed[i][n], expected); assert.equal(values[i][n], expected % 2);
    }
    assert.equal(retained.size, config.fixtureEntries); assert.equal(retained.get('key0'), 0); assert.equal(retained.get('key255'), 255);
    assert.equal(reader.current.get('key0'), 0);
    await Promise.all(streams.map(stream => stream.return()));
    return { id, startVersion, endNs, delivered: [...delivered], deliveredValues: [...deliveredValues],
      consumed: consumed.map(x => [...x]), consumedValues: values.map(x => [...x]), initialConsumed,
      overwritten: consumer === 'paused' ? { initialVersion: startVersion, updateVersions: Array.from({ length: updates - 1 }, (_, n) => startVersion + n + 1), perStreamCount: updates } : { updateVersions: [], perStreamCount: 0 },
      retainedInitialValid: true };
  }
} else {
  const request = JSON.parse(process.argv[2]), { workload, config, phase } = request;
  assert(['verify', 'pilot', 'measure'].includes(phase));
  const timed = phase !== 'verify';
  const metadata = { node: process.versions.node, platform: process.platform, arch: process.arch,
    pid: process.pid, executable: realpathSync(process.execPath), subjectPath: realpathSync(fileURLToPath(import.meta.url)),
    sharedPath: realpathSync(fileURLToPath(import.meta.resolve('zerocopy'))), workerPath: realpathSync(fileURLToPath(import.meta.resolve('zerocopy/worker'))),
    publisher: { delivery: 'all', maxPending: workload.updates, timeoutMs: config.sessionTimeoutMs },
    streams: { strategy: 'latest', emitCurrent: true, count: workload.streams },
    fixture: { entries: config.fixtureEntries, fixedSnapshots: 2, constructionTimed: false } };
  emit({ event: 'start', metadata, request });
  S.resetMap();
  let even = new S.SharedMap('number');
  for (let n = 0; n < config.fixtureEntries; n++) even = even.set(`key${n}`, n);
  const odd = even.set('key0', 1);
  const owner = W.createSharedSession(even, { copy: workload.copy, delivery: 'all', maxPending: workload.updates, timeoutMs: config.sessionTimeoutMs });
  const remote = new Worker(new URL(import.meta.url), { workerData: { workload, config, timed } });
  let rejectCurrent, pending;
  const receive = expected => new Promise((resolve, reject) => { assert.equal(pending, undefined); pending = { expected, resolve }; rejectCurrent = reject; });
  remote.on('error', error => rejectCurrent?.(error));
  remote.on('exit', code => { if (pending) rejectCurrent?.(new Error(`Worker exited ${code}`)); });
  remote.on('message', message => {
    if (!message.screen) return;
    if (message.screen === 'error') { rejectCurrent?.(new Error(message.error)); return; }
    if (!pending || message.screen !== pending.expected) { rejectCurrent?.(new Error(`Unexpected worker message ${message.screen}`)); return; }
    const { resolve } = pending; pending = undefined; resolve(message);
  });
  let ordinal = 0;
  try {
    const connected = receive('connected'); await owner.connect(remote); await connected;
    emit({ event: 'setup', metadata });
    async function round() {
      const id = ordinal++, startVersion = owner.version, ready = receive('ready');
      remote.postMessage({ screen: 'arm', id, startVersion });
      const armed = await ready; assert.equal(armed.id, id); assert.equal(armed.startVersion, startVersion);
      const done = receive('done'), startNs = timed ? clock() : null;
      // Publication performs actual publisher state replacement/capture. Immutable
      // map construction is deliberately excluded to bound arena history.
      for (let n = 0; n < workload.updates; n++) owner.publish(n % 2 === 0 ? odd : even);
      const result = await done, completionNs = timed ? clock() : null;
      assert.equal(owner.version, startVersion + workload.updates); assert.equal(result.id, id);
      assert.equal(even.get('key0'), 0); assert.equal(odd.get('key0'), 1);
      let elapsedMs = null;
      if (timed) {
        const endNs = BigInt(result.endNs);
        assert(endNs >= startNs && endNs <= completionNs, 'Cross-thread monotonic timestamp bounds');
        elapsedMs = Number(endNs - startNs) / 1e6;
      }
      return { ...result, startNs: startNs?.toString() ?? null, completionNs: completionNs?.toString() ?? null, elapsedMs };
    }
    async function batch(repeat, kind, index) {
      let elapsedMs = timed ? 0 : null;
      for (let n = 0; n < repeat; n++) {
        const trace = await round(); if (timed) elapsedMs += trace.elapsedMs;
        // Lossless per-round traces are retained; writing is outside every interval.
        emit({ event: 'round', kind, index, repetition: n, trace });
      }
      const row = { repeat, elapsedMs, msPerBurst: timed ? elapsedMs / repeat : null };
      emit({ event: 'batch', kind, index, row }); return row;
    }
    let result;
    if (phase === 'verify') {
      await batch(2, 'verify', 0); result = { phase, verified: true, rounds: ordinal };
    } else if (phase === 'pilot') {
      const warmup = [await batch(1, 'pilot-warmup', 0), await batch(1, 'pilot-warmup', 1)], calibration = [];
      let repeat = 1, calibrated = false;
      for (let step = 0; step < config.pilotMaxSteps; step++) {
        const samples = [];
        for (let index = 0; index < config.pilotSamples; index++) samples.push(await batch(repeat, 'pilot', step * config.pilotSamples + index));
        const fastest = Math.min(...samples.map(x => x.elapsedMs)); calibration.push({ repeat, samples });
        if (fastest >= config.pilotTargetMs) { calibrated = true; break; }
        if (repeat === config.maxRepeats) break;
        repeat = Math.min(config.maxRepeats, Math.max(repeat + 1, Math.ceil(repeat * config.pilotTargetMs / Math.max(fastest, .001))));
      }
      repeat = calibration.at(-1).repeat;
      result = { phase, warmup, calibration, repeat, capped: !calibrated, rounds: ordinal };
    } else {
      assert(Number.isSafeInteger(request.repeat) && request.repeat >= 1 && request.repeat <= config.maxRepeats);
      const warmup = [], measured = [];
      for (let i = 0; i < config.warmupBatches; i++) warmup.push(await batch(request.repeat, 'warmup', i));
      for (let i = 0; i < config.samples; i++) measured.push(await batch(request.repeat, 'measured', i));
      result = { phase, repeat: request.repeat, warmup, measured, rounds: ordinal };
    }
    emit({ event: 'result', result });
  } finally { owner.dispose(); await remote.terminate(); }
}
