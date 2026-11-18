#!/usr/bin/env node
/** Paired public-API benchmark. Example:
 * node benchmark.mjs --baseline /path/main --candidate /path/candidate \
 *   --runtimes node,bun --bun /path/bun --group map --pairs 7 --output results.json
 * --only accepts comma-separated names from workloads.mjs. --group accepts map/list/json-array.
 * --count defaults to 10000; beyond-cache and cached-map cases set their own counts.
 * --batch-scale 0.01 --warmups 0 --pairs 1 is a correctness smoke, not perf evidence.
 * Use identical baseline/candidate paths for an A/A noise control. No pass/fail speed gate.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, freemem, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url), directory = dirname(script);
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1]; };
const hash = data => createHash('sha256').update(data).digest('hex');
const median = values => { const sorted = [...values].sort((a, b) => a - b), i = sorted.length >> 1; return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2; };
const git = (root, ...args) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
function files(root, relative = '') {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const name = join(relative, entry.name);
    return entry.isDirectory() ? files(root, name) : entry.isFile() ? [name] : [];
  }).sort();
}
function inventory(root) {
  const sourceFiles = [...readdirSync(root).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')),
    ...files(join(root, 'rust', 'src')).map(name => `rust/src/${name}`),
    'package.json', 'rust/Cargo.toml', 'rust/Cargo.lock', 'rust-toolchain.toml', 'rust/wasm-abi.json',
    'scripts/build-wasm.mjs', 'scripts/rust-wasm.mjs', 'scripts/build-browser.ts'].sort();
  const source = sourceFiles.map(file => ({ file, sha256: hash(readFileSync(join(root, file))) }));
  const bundles = files(join(root, 'dist')).filter(file => extname(file) === '.js').map(file => {
    const bytes = readFileSync(join(root, 'dist', file)); return { file: `dist/${file}`, bytes: bytes.length, sha256: hash(bytes) };
  });
  if (!bundles.some(file => file.file === 'dist/shared.js')) throw new Error(`Missing built shared.js in ${root}`);
  return { path: root, commit: git(root, 'rev-parse', 'HEAD'), trackedDiffSha256: hash(git(root, 'diff', 'HEAD', '--') ?? ''),
    status: git(root, 'status', '--short'), source, sourceManifestSha256: hash(JSON.stringify(source)), bundles,
    bundleManifestSha256: hash(JSON.stringify(bundles)), dependencyVersions: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies };
}

if (process.argv.includes('--worker')) {
  const { run } = await import(pathToFileURL(join(directory, 'workloads.mjs')).href);
  const config = JSON.parse(readFileSync(arg('config'), 'utf8'));
  const lib = await import(pathToFileURL(arg('entry')).href);
  const result = await run(lib, config, Number(arg('rotation', 0)));
  process.stdout.write(JSON.stringify({ versions: process.versions, ...result }));
} else {
  const baseline = resolve(arg('baseline', '')), candidate = resolve(arg('candidate', ''));
  if (!arg('baseline') || !arg('candidate')) throw new Error('Pass --baseline and --candidate checkout paths');
  const pairs = Number(arg('pairs', 7)), runtimes = arg('runtimes', 'node,bun').split(',');
  if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 30) throw new Error('--pairs must be 1..30');
  if (runtimes.some(name => !['node', 'bun', 'chromium'].includes(name))) throw new Error('Supported runtimes: node,bun,chromium');
  const config = { count: Number(arg('count', 10000)), warmups: Number(arg('warmups', 8)), batchScale: Number(arg('batch-scale', 1)),
    group: arg('group', ''), only: arg('only', '').split(',').filter(Boolean) };
  if (!Number.isFinite(config.batchScale) || config.batchScale <= 0 || config.batchScale > 16) throw new Error('Invalid --batch-scale');
  const output = resolve(arg('output', join(directory, 'results.json')));
  if (existsSync(output)) throw new Error(`Refusing to overwrite existing evidence: ${output}`);
  mkdirSync(dirname(output), { recursive: true });
  const temporary = mkdtempSync(join(tmpdir(), 'zerocopy-perf-'));
  const report = { schema: 'zerocopy-paired-public-api/v1', complete: false, startedAt: new Date().toISOString(), pairs, runtimes, config,
    harness: { driverSha256: hash(readFileSync(script)), workloadsSha256: hash(readFileSync(join(directory, 'workloads.mjs'))) },
    environment: { platform: platform(), release: release(), architecture: process.arch, cpus: cpus().map(cpu => ({ model: cpu.model, speed: cpu.speed })),
      totalMemoryBytes: totalmem(), freeMemoryBytesAtStart: freemem(), loadAtStart: loadavg() },
    variants: { baseline: inventory(baseline), candidate: inventory(candidate) },
    notes: [
      'Each variant/pair/runtime is a fresh process; browser samples launch a fresh Chromium process and isolated page.',
      'Baseline/candidate order alternates by pair; workload order rotates by pair. No simultaneous benchmark processes.',
      'Inputs, construction for read cases, fresh read-only attachments, warmup, forced GC if supported, and verification are outside timing.',
      'Fresh read cases use one untouched reader per timed iteration. Warm case reuses one primed reader. Updated case alternates retained/changed roots.',
      'Cold means empty process-local reader caches; copying shared bytes for integrity checks can warm CPU caches. This is not a cold-hardware-cache benchmark.',
      'Reader attachments run in the same JS process/page as the writer. This measures local attached-reader work, not cross-worker transport latency.',
      'List timing includes pushMany encoding/allocation/publication only; all resulting snapshots are retained and verified after timing.',
      'Read correctness checks compare all values, deep freezing, shared used bytes/capacity and every byte in the pre-read shared arena prefix.',
      'Shared allocation is measured; JavaScript heap, allocation counts, peak RSS and GC pause attribution are not measured.',
      'Built JavaScript is snapshotted before measuring and fingerprinted with source/manifests. No historical evidence is modified.',
      'Short batches under 20 ms are flagged, not silently omitted. These local measurements do not guarantee other-platform gains.',
    ], samples: [] };
  const save = () => writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  save();
  let server;
  try {
    copyFileSync(script, join(temporary, 'benchmark.mjs'));
    copyFileSync(join(directory, 'workloads.mjs'), join(temporary, 'workloads.mjs'));
    writeFileSync(join(temporary, 'config.json'), JSON.stringify(config));
    for (const variant of ['baseline', 'candidate']) {
      const root = join(temporary, variant); mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
      for (const file of report.variants[variant].bundles) {
        const source = readFileSync(join(report.variants[variant].path, file.file));
        if (hash(source) !== file.sha256) throw new Error('Bundle changed while creating immutable benchmark snapshot');
        mkdirSync(dirname(join(root, file.file)), { recursive: true }); writeFileSync(join(root, file.file), source);
      }
    }
    let browserOrigin, chromium;
    if (runtimes.includes('chromium')) {
      ({ chromium } = await import(pathToFileURL(join(candidate, 'node_modules/playwright/index.mjs')).href));
      server = createServer((request, response) => {
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        response.setHeader('Cache-Control', 'no-store');
        const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>zerocopy paired benchmark</title>'); return; }
        const file = resolve(temporary, `.${path}`);
        if (!file.startsWith(`${temporary}/`) || !existsSync(file) || !['.js', '.mjs'].includes(extname(file))) { response.writeHead(404).end(); return; }
        response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(file));
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening'); browserOrigin = `http://127.0.0.1:${server.address().port}`;
    }
    for (const runtime of runtimes) for (let pair = 0; pair < pairs; pair++) {
      for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        let result;
        if (runtime === 'chromium') {
          const browser = await chromium.launch({ headless: true, executablePath: arg('chromium', process.env.CHROMIUM_PATH || undefined), args: ['--js-flags=--expose-gc'] });
          try {
            const page = await browser.newPage(); await page.goto(browserOrigin);
            result = await page.evaluate(async ({ variant, config, pair }) => {
              if (!crossOriginIsolated) throw new Error('Missing browser isolation');
              const { run } = await import('/workloads.mjs'), lib = await import(`/${variant}/dist/shared.js`);
              return { versions: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency }, ...await run(lib, config, pair) };
            }, { variant, config, pair });
            result.versions.chromium = browser.version();
          } finally { await browser.close(); }
        } else {
          const executable = runtime === 'node' ? arg('node', process.execPath) : arg('bun', 'bun');
          result = JSON.parse(execFileSync(executable, ['--expose-gc', join(temporary, 'benchmark.mjs'), '--worker',
            '--entry', join(temporary, variant, 'dist/shared.js'), '--config', join(temporary, 'config.json'), '--rotation', String(pair)],
          { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 }));
        }
        report.samples.push({ runtime, pair, variant, ...result }); save();
        process.stderr.write(`${runtime} pair ${pair + 1}/${pairs} ${variant}: ${result.rows.length} workloads verified\n`);
      }
    }
    report.summary = runtimes.flatMap(runtime => {
      const first = report.samples.find(sample => sample.runtime === runtime);
      return first.rows.map(item => {
        const get = (variant, pair) => report.samples.find(sample => sample.runtime === runtime && sample.variant === variant && sample.pair === pair).rows.find(row => row.name === item.name);
        const ratios = Array.from({ length: pairs }, (_, pair) => get('candidate', pair).elapsedMs / get('baseline', pair).elapsedMs);
        const rows = variant => Array.from({ length: pairs }, (_, pair) => get(variant, pair));
        return { runtime, name: item.name, baselineMedianMsPer10000: median(rows('baseline').map(row => row.millisecondsPer10000)),
          candidateMedianMsPer10000: median(rows('candidate').map(row => row.millisecondsPer10000)), pairedRatios: ratios,
          medianPairedRatio: median(ratios), candidateFasterPairs: ratios.filter(ratio => ratio < 1).length,
          minimumBatchMs: Math.min(...rows('baseline').map(row => row.elapsedMs), ...rows('candidate').map(row => row.elapsedMs)),
          shortBatchWarning: [...rows('baseline'), ...rows('candidate')].some(row => row.elapsedMs < 20) };
      });
    });
    report.complete = true; report.finishedAt = new Date().toISOString(); report.environment.loadAtEnd = loadavg(); save();
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
  } catch (error) { report.error = error.stack; save(); throw error; }
  finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    rmSync(temporary, { recursive: true, force: true });
  }
}
