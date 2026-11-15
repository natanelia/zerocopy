import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WEBSITE_CASE_IDS } from './website-cases.mjs';
const args = Object.fromEntries(process.argv.slice(2).map((value, i, all) => value.startsWith('--') ? [value.slice(2), all[i + 1]] : []).filter(item => item.length));
for (const key of ['manifest', 'browser', 'out']) if (!args[key]) throw new Error(`Missing --${key}`);
if (!['chromium', 'firefox', 'webkit'].includes(args.browser)) throw new Error('Use chromium, firefox or webkit');
const sourceManifest = JSON.parse(readFileSync(resolve(args.manifest))), output = resolve(args.out), study = dirname(fileURLToPath(import.meta.url));
const mode = args.mode ?? 'both';
if (!['website', 'local', 'both'].includes(mode)) throw new Error('Use --mode website, local or both');
if (existsSync(output)) throw new Error('Output path exists; never overwrite browser evidence');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const identity of Object.values(sourceManifest.identities)) {
  const actualCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: identity.directory, encoding: 'utf8' }).trim();
  if (actualCommit !== identity.commit) throw new Error('Repository moved since recorded manifest');
  for (const [path, digest] of Object.entries(identity.sourceHashes)) if (hash(readFileSync(resolve(identity.directory, path))) !== digest) throw new Error(`Source changed: ${path}`);
  for (const [path, digest] of Object.entries(identity.libraryHashes)) if (hash(readFileSync(resolve(identity.directory, 'dist', path))) !== digest) throw new Error(`Library changed: ${path}`);
}
for (const [path, digest] of Object.entries(sourceManifest.studyHashes)) if (hash(readFileSync(resolve(study, path))) !== digest) throw new Error(`Study code changed: ${path}`);
const playwrightPath = args.playwright ?? resolve(sourceManifest.identities.candidate.directory, 'node_modules/playwright/index.mjs');
const playwright = await import(pathToFileURL(playwrightPath).href);
const mounts = {
  '/run/baseline/assets/': resolve(sourceManifest.identities.harness.directory, 'website/assets'),
  '/run/candidate/assets/': resolve(sourceManifest.identities.harness.directory, 'website/assets'),
  '/run/baseline/library/': resolve(sourceManifest.identities.baseline.directory, 'dist'),
  '/run/candidate/library/': resolve(sourceManifest.identities.candidate.directory, 'dist'),
  '/run/baseline/vendor/': resolve(sourceManifest.identities.harness.directory, 'website/_site/vendor'),
  '/run/candidate/vendor/': resolve(sourceManifest.identities.harness.directory, 'website/_site/vendor'),
  '/study/': study, '/harness/': sourceManifest.identities.harness.directory,
  '/baseline/': sourceManifest.identities.baseline.directory, '/candidate/': sourceManifest.identities.candidate.directory };
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><meta charset="utf-8"><title>Fixed .get() study</title>'); return; }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname), mount = Object.keys(mounts).find(prefix => pathname.startsWith(prefix));
    if (!mount) throw new Error('Unknown mount');
    const file = resolve(mounts[mount], pathname.slice(mount.length));
    if (!file.startsWith(mounts[mount] + sep)) throw new Error('Invalid path');
    const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json' };
    if (!types[extname(file)]) throw new Error('Unsupported file');
    response.setHeader('Content-Type', types[extname(file)]); response.end(readFileSync(file));
  } catch { response.statusCode = 404; response.end('Not found'); }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`, pairs = Number(args.pairs ?? sourceManifest.pairs);
if (!Number.isInteger(pairs) || pairs < 2) throw new Error('Invalid predetermined pair count');
mkdirSync(output, { recursive: true });
const manifest = { ...sourceManifest, browser: args.browser, pairs, sourceManifestSHA256: hash(readFileSync(resolve(args.manifest))),
  mode, cases: [...(mode !== 'local' ? WEBSITE_CASE_IDS : []), ...(mode !== 'website' ? sourceManifest.cases : [])],
  schedule: Array.from({ length: pairs }, (_, pair) => (pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']).map(variant => ({ pair, variant, runtime: { name: args.browser } }))).flat(),
  methodology: sourceManifest.methodology + ' Browser records use a fresh browser process per variant. Website cases run first and use exact frozen Track A worker runners with selected runtime libraries. Optional local fixture cases follow and use warm code with fresh read-only attachment; these are distinct timer boundaries.' };
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const completions = [];
try {
  for (let pair = 0; pair < pairs; pair++) for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const filename = `${args.browser}-pair-${String(pair).padStart(2, '0')}-${variant}.jsonl`, stream = createWriteStream(resolve(output, filename));
    const emit = value => stream.write(JSON.stringify(value) + '\n');
    let browser, code = 0, failure;
    try {
      browser = await playwright[args.browser].launch({ headless: true, ...(args.executable ? { executablePath: args.executable } : {}) });
      const page = await browser.newPage();
      await page.exposeFunction('recordStudySample', record => { emit({ ...record, type: 'sample' }); });
      await page.goto(origin);
      emit({ type: 'process-start', pair, variant, runtime: { name: args.browser, version: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent),
        crossOriginIsolated: await page.evaluate(() => crossOriginIsolated) } });
      const conclusion = await page.evaluate(async configuration => {
        if (!crossOriginIsolated || typeof SharedArrayBuffer !== 'function') throw new Error('Shared-memory isolation unavailable');
        const digest = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        let websiteRecords = [];
        if (configuration.mode !== 'local') {
          const { runWebsiteStudy } = await import('/study/website-cases.mjs');
          websiteRecords = await runWebsiteStudy(configuration, { hash: digest, onRecord: record => globalThis.recordStudySample(record) });
          if (websiteRecords.some(record => record.status !== 'passed') || configuration.mode === 'website') {
            return { status: websiteRecords.every(record => record.status === 'passed') ? 'passed' : 'failed', records: websiteRecords.length };
          }
        }
        const { runStudy } = await import('/study/study-core.mjs');
        const start = performance.now(), api = await import(`/${configuration.variant}/dist/shared.js`), importMs = performance.now() - start;
        const [catalog, reads, readReference, catalogReference] = await Promise.all([
          'catalog-core.mjs', 'catalog-read-workloads.mjs', 'catalog-read-reference.mjs', 'catalog-reference.mjs',
        ].map(path => import(`/harness/website/assets/${path}`)));
        const records = await runStudy(api, { catalog, reads, readReference, catalogReference }, {
          warmups: configuration.warmups, rotation: configuration.pair, cases: configuration.cases,
          hash: digest,
          memory: () => performance.memory ? { available: true, source: 'performance.memory; browser-specific estimate', usedJSHeapSize: performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit, gcAvailable: false } : { available: false, reason: 'No portable browser heap API' },
          onRecord: record => globalThis.recordStudySample(record),
        });
        return { status: records.every(record => record.status === 'passed') ? 'passed' : 'failed', records: records.length + websiteRecords.length, importMs };
      }, { variant, pair, warmups: manifest.warmups, cases: sourceManifest.cases, mode });
      emit({ ...conclusion, type: 'process-end' });
      if (conclusion.status !== 'passed') code = 1;
    } catch (error) {
      code = 1; failure = { name: error?.name, message: error?.message ?? String(error), stack: error?.stack };
      emit({ ...failure, type: 'process-failure' });
    } finally {
      await browser?.close();
      await new Promise(resolveFinish => stream.end(resolveFinish));
    }
    completions.push({ runtime: { name: args.browser }, pair, variant, code, file: filename, sha256: hash(readFileSync(resolve(output, filename))), ...(failure ? { failure } : {}) });
    writeFileSync(resolve(output, 'completions.json'), JSON.stringify(completions, null, 2));
    process.stdout.write(`${args.browser} pair ${pair + 1}/${pairs} ${variant}: ${code === 0 ? 'passed' : 'FAILED'}\n`);
  }
} finally { await new Promise(resolveClosed => server.close(resolveClosed)); }
writeFileSync(resolve(output, 'study-complete.json'), JSON.stringify({ completed: completions.length, planned: pairs * 2, failed: completions.filter(item => item.code !== 0).length }, null, 2));
if (completions.some(item => item.code !== 0)) process.exitCode = 1;
