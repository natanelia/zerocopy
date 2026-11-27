import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { cpus, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { execFileSync } from 'node:child_process';
const S = await import(process.env.ZEROCOPY_SCAN_BUILD ?? '../dist/shared.js');

const key = i => (i % 97 === 0 ? '道路:' : 'lane:') + i;
const changed = (i, n) => i % Math.max(100, Math.floor(n / 100)) === 0;
function row(i, revision = 0) {
  return { id: i, x: (i * 137 % 4096) + revision * 31, y: i * 73 % 4096,
    width: 3 + i % 5, kind: i % 3, revision, name: 'lane-' + i };
}
const windows = [0, 371, 1043, 1971, 2641];
function inside(v, start) {
  return v.x + v.width >= start && v.x < start + 1024 && v.y >= 512 && v.y < 3584 && v.kind !== 2;
}
const hash = ids => createHash('sha256').update(ids.join(',')).digest('hex');
function expected(n, rev, start) {
  const ids = [];
  for (let i = 0; i < n; i++) if (inside(row(i, rev && changed(i, n) ? 1 : 0), start)) ids.push(i);
  return hash(ids);
}
function scan(map, api, start) {
  const ids = [];
  const visit = (v, k) => { if (inside(v, start)) ids.push(v.id); };
  const t = performance.now();
  if (api === 'entries') for (const [k, v] of map.entries()) visit(v, k);
  else map.forEach(visit);
  const ms = performance.now() - t;
  const ordered = hash(ids);
  ids.sort((a, b) => a - b);
  return { ms, count: ids.length, ordered, digest: hash(ids) };
}
function verify(map, n, rev) {
  const seen = new Uint8Array(n);
  for (const [k, v] of map.entries()) {
    const i = v.id;
    assert(Number.isInteger(i) && i >= 0 && i < n && !seen[i]);
    seen[i] = 1;
    assert.equal(k, key(i));
    assert.deepEqual(v, row(i, rev && changed(i, n) ? 1 : 0));
  }
  assert.equal(map.size, n);
  assert(seen.every(v => v === 1));
}
if (!isMainThread) {
  const { api, n, shared, profileEnabled } = workerData;
  let old, next;
  parentPort.on('message', async ({ phase, payload }) => {
    try {
      const t = performance.now();
      let map, starts;
      if (phase === 'first') {
        old = shared ? (await S.initWorker(payload)).map : payload;
        map = old; starts = [windows[0]];
      } else if (phase === 'repeat') { map = old; starts = windows; }
      else if (phase === 'updated') {
        next = shared ? (await S.initWorker(payload)).map : payload;
        map = next; starts = windows;
      } else if (phase === 'retained') { map = old; starts = windows; }
      else if (phase === 'points') {
        const ids = Array.from({length: 1000}, (_, j) => (j * 7919 + 17) % n);
        const values = [];
        const t0 = performance.now();
        for (const i of ids) values.push(old.get(key(i)), next.get(key(i)));
        const ms = performance.now() - t0;
        for (let j = 0; j < ids.length; j++) {
          const i = ids[j];
          assert.deepEqual(values[j * 2], row(i));
          assert.deepEqual(values[j * 2 + 1], row(i, changed(i,n) ? 1 : 0));
        }
        parentPort.postMessage({ms, heapUsed: process.memoryUsage().heapUsed, verified: true}); return;
      } else if (phase === 'verify') {
        verify(old, n, 0); verify(next, n, 1);
        if (shared) assert.throws(() => old.set('x', row(0)), /read-only/);
        parentPort.postMessage({ verified: true }); return;
      } else throw Error('bad phase');
      const attachmentMs = performance.now() - t;
      let session, profile, scans;
      const command = (method, params = {}) => new Promise((resolve, reject) =>
        session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
      try {
        if (profileEnabled) {
          session = new Session();
          session.connect();
          await command('Profiler.enable');
          await command('Profiler.setSamplingInterval', { interval: 200 });
          await command('Profiler.start');
        }
        scans = starts.map(start => ({ start, ...scan(map, api, start) }));
        if (session) ({ profile } = await command('Profiler.stop'));
      } finally { session?.disconnect(); }
      parentPort.postMessage({ attachmentMs, scans, heapUsed: process.memoryUsage().heapUsed, profile });
    } catch (error) { parentPort.postMessage({ error: error.stack }); }
  });
} else {
  const n = Number(process.argv[2] ?? 10000), rounds = Number(process.argv[3] ?? 8), output = process.argv[4];
  assert(output && [1000,10000,100000].includes(n) && Number.isInteger(rounds) && rounds > 0);
  const profileEnabled = process.env.ZEROCOPY_SCAN_PROFILE === '1';
  const cases = ['shared-forEach'];
  const report = { source: execFileSync('git', ['rev-parse','HEAD'], {encoding:'utf8'}).trim(), node: process.version,
    cpu: cpus()[0].model, os: release(), n, rounds, profileEnabled, runtimeBuild: process.env.ZEROCOPY_SCAN_BUILD, samples: [] };
  const expectedDigests = new Map();
  for (const rev of [0,1]) for (const start of windows) expectedDigests.set(rev + ':' + start, expected(n, rev, start));
  async function trial(id, round) {
    const shared = id !== 'native-forEach', api = id === 'shared-entries' ? 'entries' : 'forEach';
    const rows = Array.from({length:n}, (_,i) => [key(i), row(i)]);
    const edits = [];
    for (let i = 0; i < n; i++) if (changed(i,n)) edits.push([key(i),row(i,1)]);
    if (shared) S.resetMap();
    let t = performance.now();
    const old = shared ? new S.SharedMap('object').setMany(rows) : new Map(rows);
    const constructionMs = performance.now() - t;
    const workers = Array.from({length:2}, () => new Worker(new URL(import.meta.url), {workerData:{api,n,shared,profileEnabled:profileEnabled && round >= 0}}));
    async function exchange(phase, payload, revision) {
      const start = performance.now();
      const pending = workers.map(async worker => {
        const response = once(worker,'message'); worker.postMessage({phase,payload});
        const [result] = await response;
        if (result.error) throw Error(result.error);
        return result;
      });
      const readers = await Promise.all(pending);
      const roundTripMs = performance.now() - start;
      if (phase === 'verify') { assert(readers.every(r => r.verified)); return {verified:true}; }
      if (phase === 'points') { assert(readers.every(r => r.verified)); return {roundTripMs, readers, rss: process.memoryUsage.rss()}; }
      for (const reader of readers) for (const scan of reader.scans)
        assert.equal(scan.digest, expectedDigests.get(revision + ':' + scan.start));
      if (shared) assert.deepEqual(readers[0].scans.map(x=>x.ordered),readers[1].scans.map(x=>x.ordered));
      if (profileEnabled && round >= 0) {
        for (const [readerIndex, reader] of readers.entries()) {
          const { profile } = reader;
          assert(profile?.samples?.length && profile.samples.length === profile.timeDeltas.length);
          const file = output + '.' + round + '.' + phase + '.' + readerIndex + '.cpuprofile';
          writeFileSync(file, JSON.stringify(profile));
          const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame]));
          const self = new Map();
          for (const [i, nodeId] of profile.samples.entries()) {
            const frame = nodes.get(nodeId);
            assert(frame);
            const key = (frame.functionName || '(anonymous)') + ' @ ' + frame.url.split('/').slice(-2).join('/') + ':' + (frame.lineNumber + 1);
            self.set(key, (self.get(key) ?? 0) + profile.timeDeltas[i]);
          }
          console.log('SCAN_PROFILE ' + JSON.stringify({ n, round, phase, readerIndex,
            samples: profile.samples.length, totalUs: profile.timeDeltas.reduce((a,b)=>a+b,0),
            top: [...self.entries()].sort((a,b)=>b[1]-a[1]).slice(0,20) }));
          delete reader.profile;
        }
      }
      return {roundTripMs, readers, rss: process.memoryUsage.rss()};
    }
    try {
      t = performance.now();
      const initial = shared ? S.getWorkerData({map:old},{copy:false}) : old;
      if (shared) assert(initial.arenas.every(a => a.memory && !a.copy));
      const prepareInitialMs = performance.now() - t;
      const first = await exchange('first',initial,0);
      const repeat = await exchange('repeat',undefined,0);
      t = performance.now();
      const next = shared ? old.setMany(edits) : new Map(old);
      if (!shared) for (const [k,v] of edits) next.set(k,v);
      const mutationMs = performance.now() - t;
      t = performance.now();
      const payload = shared ? S.getWorkerData({map:next},{copy:false}) : next;
      const prepareUpdateMs = performance.now() - t;
      const updated = await exchange('updated',payload,1);
      const retained = await exchange('retained',undefined,0);
      const points = await exchange('points');
      await exchange('verify');
      return {id,round,warmup:round<0,constructionMs,prepareInitialMs,prepareUpdateMs,mutationMs,edits:edits.length,first,repeat,updated,retained,points,peakProcessRssKiB:process.resourceUsage().maxRSS,verified:true};
    } finally { await Promise.all(workers.map(w=>w.terminate())); }
  }
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? cases : [...cases].reverse();
    for (const id of order) {
      const sample = await trial(id,round);
      report.samples.push(sample);
      console.log(JSON.stringify(sample));
      writeFileSync(output,JSON.stringify(report));
    }
  }
}
