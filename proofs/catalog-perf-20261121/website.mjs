import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, arch, release } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox } from 'playwright';

// Build both checkouts (including website/build.mjs) with the same toolchain first.
const [baseline, candidate, output, entries = '10000', pairs = '9', cases = 'full-shared-get,selective-shared-view'] = process.argv.slice(2);
assert(baseline && candidate && output, 'Pass baseline checkout, candidate checkout and output JSON');
const count = Number(entries), repetitions = Number(pairs), workloads = cases.split(',');
assert(Number.isSafeInteger(repetitions) && repetitions > 0);
const engine = process.env.BROWSER ?? 'firefox';
assert(['firefox', 'chromium'].includes(engine));
const report = { complete: false, startedAt: new Date().toISOString(), driverSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'), environment: { node: process.version, cpu: cpus()[0]?.model, arch: arch(), os: release() }, count, repetitions, workloads, builds: {}, samples: [] };
const servers = [], pages = {};
closeSync(openSync(output, 'wx'));
const browser = await ({ firefox, chromium })[engine].launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
try {
  report.environment[engine] = browser.version();
  for (const [label, dir] of Object.entries({ baseline, candidate })) {
    const root = resolve(dir), url = pathToFileURL(root + '/');
    const file = name => readFileSync(new URL(name, url));
    const identity = JSON.parse(file('website/_site/build.json'));
    const workloadSha256 = createHash('sha256').update(file('website/_site/investigation-benchmark/assets/catalog-read-workloads.mjs')).digest('hex');
    report.builds[label] = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), identity, workloadSha256 };
    assert.equal(identity.sourceCommit, report.builds[label].commit);
    assert.equal(identity.sourceDirty, false);
    const { createPreview } = await import(new URL('website/serve.mjs', url));
    const server = createPreview(); servers.push(server);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const page = await browser.newPage(); pages[label] = page;
    await page.goto(`http://127.0.0.1:${server.address().port}/investigation-benchmark/`);
    assert(await page.evaluate(() => globalThis.crossOriginIsolated));
  }
  assert.equal(report.builds.baseline.workloadSha256, report.builds.candidate.workloadSha256);
  for (let pair = -2; pair < repetitions; pair++) {
    for (let i = 0; i < workloads.length; i++) {
      const id = workloads[(i + pair + 2) % workloads.length];
      for (const label of (pair + workloads.indexOf(id)) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const result = await pages[label].evaluate(async ({ id, count }) => {
          const { sampleReadCase } = await import('./assets/read-benchmark-runner.mjs');
          const { readCase } = await import('./assets/catalog-read-workloads.mjs');
          return sampleReadCase(readCase(id), count);
        }, { id, count });
        assert.equal(result.status, 'passed');
        report.samples.push({ pair, warmup: pair < 0, label, id, result });
        writeFileSync(output, JSON.stringify(report));
      }
    }
    console.log(`Finished pair ${pair + 1} of ${repetitions}`);
  }
  report.complete = true;
  report.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(report));
} finally {
  await browser.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
