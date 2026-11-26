import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, release } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

// Run the website's owner, nested readers, timing boundaries and verification
// unchanged. Only the browser Worker / postMessage interface is adapted.
class WebWorker {
  constructor(url) {
    const bootstrap = String(url).startsWith('blob:') ? resolveObjectURL(String(url)) : undefined;
    this.worker = new Worker(new URL(import.meta.url), { workerData: { bootstrap, url: String(url) } });
    this.worker.on('message', data => this.onmessage?.({ data }));
    this.worker.on('error', error => this.onerror?.(error));
    this.worker.on('messageerror', error => this.onmessageerror?.(error));
  }
  postMessage(message) { this.worker.postMessage(message); }
  terminate() { void this.worker.terminate(); }
}
globalThis.Worker = WebWorker;

if (!isMainThread) {
  globalThis.self = globalThis;
  globalThis.postMessage = message => parentPort.postMessage(message);
  let url = workerData.url;
  if (workerData.bootstrap) {
    const match = /^import (".*");$/.exec(await workerData.bootstrap.text());
    assert(match, 'Unexpected website worker bootstrap');
    url = JSON.parse(match[1]);
  }
  assert.equal(new URL(url).protocol, 'file:');
  await import(url);
  parentPort.on('message', data => globalThis.onmessage({ data }));
} else {
  const [base, candidate, output, countArg = '10000', pairsArg = '11', caseArg = 'selective-shared-view,full-shared-get'] = process.argv.slice(2);
  const count = Number(countArg), pairs = Number(pairsArg), cases = caseArg.split(',');
  assert(base && candidate && output && Number.isSafeInteger(pairs) && pairs > 0);
  const read = path => readFileSync(path);
  const hash = data => createHash('sha256').update(data).digest('hex');
  const report = {
    node: process.version, cpu: cpus()[0].model, os: release(), count, pairs, cases,
    driverSha256: hash(read(new URL(import.meta.url))), builds: {}, samples: [],
  };
  const builds = {};
  for (const [label, dir] of Object.entries({ baseline: base, candidate })) {
    const cwd = resolve(dir), site = pathToFileURL(cwd + '/website/_site/');
    const manifest = JSON.parse(read(new URL('build.json', site)));
    assert.equal(manifest.sourceCommit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim());
    assert.equal(manifest.sourceDirty, false);
    report.builds[label] = manifest;
    const assets = new URL('investigation-benchmark/assets/', site);
    const { sampleReadCase } = await import(new URL('read-benchmark-runner.mjs', assets));
    const { readCase } = await import(new URL('catalog-read-workloads.mjs', assets));
    builds[label] = id => sampleReadCase(readCase(id), count);
  }
  assert.deepEqual(report.builds.baseline.benchmarkFilesSHA256, report.builds.candidate.benchmarkFilesSHA256);
  assert.deepEqual(report.builds.baseline.wasmFilesSHA256, report.builds.candidate.wasmFilesSHA256);
  writeFileSync(output, '', { flag: 'wx' });
  for (let pair = -2; pair < pairs; pair++) {
    for (let j = 0; j < cases.length; j++) {
      const i = (j + pair + 2) % cases.length, id = cases[i];
      for (const label of (pair + i) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const result = await builds[label](id);
        assert.equal(result.status, 'passed');
        report.samples.push({ pair, warmup: pair < 0, label, id, result });
        console.log(JSON.stringify({ count, pair, warmup: pair < 0, label, id, result }));
      }
    }
    writeFileSync(output, JSON.stringify(report));
    console.log('Finished pair', pair + 1, 'of', pairs);
  }
}
