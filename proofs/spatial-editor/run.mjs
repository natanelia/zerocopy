import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { cpus, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const soak = process.argv.includes('--soak');
const smoke = process.argv.includes('--smoke');
const option = name => process.argv.slice(2).find(arg => arg.startsWith('--' + name + '='))?.split('=').slice(1).join('=');
const selectedReaders = option('readers'), selectedTrial = option('trial'), output = option('output');
const transport = option('transport') ?? 'session';
if (!['session', 'manual'].includes(transport)) throw new Error('Expected --transport=session|manual');
const rebuild = option('rebuild') ?? 'packed';
if (!['packed', 'rows'].includes(rebuild)) throw new Error('Expected --rebuild=packed|rows');
const graphicsMode = option('renderer') ?? 'swiftshader';
if (!['hardware', 'swiftshader'].includes(graphicsMode)) throw new Error('Expected --renderer=hardware|swiftshader');
const uploads = option('uploads') ?? 'range';
if (!['range', 'full'].includes(uploads)) throw new Error('Expected --uploads=range|full');
const readerCounts = selectedReaders === undefined ? (smoke ? [1] : [1, 4, 8]) : [Number(selectedReaders)];
const selectedMode = option('mode');
if (selectedMode !== undefined && !['copy','shared'].includes(selectedMode)) throw new Error('Expected --mode=copy|shared');
const trials = selectedTrial === undefined ? (smoke ? [0] : [0, 1, 2]) : [Number(selectedTrial)];
if (readerCounts.some(n => ![1, 4, 8].includes(n)) || trials.some(n => ![0, 1, 2].includes(n))) {
  throw new Error('Expected --readers=1|4|8 and --trial=0|1|2');
}
const config = smoke ? { count: 128, vertices: 24, steps: 40, warmup: 0, transport, rebuild, uploads } :
  { count: 4096, vertices: 256, steps: soak ? 1024 : 64, warmup: 16, transport, rebuild, uploads };

// Sample proportional set size across the entire fresh browser process tree.
// Every Chromium thread can fork children, including the zygote and GPU process.
async function browserPss(pid) {
  const visited = new Set();
  async function sum(pid) {
    if (visited.has(pid)) return 0;
    visited.add(pid);
    try {
      const tids = await readdir(`/proc/${pid}/task`);
      const children = await Promise.all(tids.map(tid => readFile(`/proc/${pid}/task/${tid}/children`, 'utf8')
        .catch(e => { if (e.code === 'ENOENT') return ''; throw e; })));
      const pss = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
      const descendants = [...new Set(children.join(' ').trim().split(/\s+/).filter(Boolean))];
      return Number(pss.match(/^Pss:\s+(\d+) kB$/m)[1]) + (await Promise.all(descendants.map(sum))).reduce((a, b) => a + b, 0);
    } catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return 0; throw e; }
  }
  return sum(String(pid));
}

const html = '<!doctype html><canvas width="320" height="200"></canvas>';
const dir = await mkdtemp(join(tmpdir(), 'zerocopy-spatial-editor-'));
const server = createServer(async (req, res) => {
  const js = ['/editor.js', '/reader.js'].includes(req.url);
  res.writeHead(js || req.url === '/' ? 200 : 404, {
    'Content-Type': js ? 'text/javascript' : 'text/html',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
  });
  res.end(js ? await readFile(join(dir, req.url.slice(1))) : html);
});
try {
  await build({ entryPoints: [join(here, 'editor.mjs'), join(here, 'reader.mjs')], outdir: dir,
    bundle: true, format: 'esm', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const report = { frameTimingVersion: 2, config, hardware: cpus()[0].model, platform: platform(), created: new Date().toISOString(),
    bundleSHA256: {}, cases: [] };
  for (const name of ['editor', 'reader']) {
    report.bundleSHA256[name] = createHash('sha256').update(await readFile(join(dir, name + '.js'))).digest('hex');
  }
  for (const readers of readerCounts) {
    for (const trial of trials) {
      for (const mode of selectedMode ? [selectedMode] : trial % 2 ? ['shared', 'copy'] : ['copy', 'shared']) {
        const instance = await chromium.launchServer({ executablePath: process.env.CHROMIUM_PATH || undefined,
          ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
          args: graphicsMode === 'hardware' ? ['--enable-gpu', '--disable-software-rasterizer'] :
            ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
        let timer, sampling, memoryError;
        const pss = [];
        try {
          const browser = await chromium.connect(instance.wsEndpoint());
          report.chromium = browser.version();
          const page = await browser.newPage();
          await page.goto(`http://127.0.0.1:${server.address().port}/`);
          const collect = async () => pss.push([Date.now(), await browserPss(instance.process().pid)]);
          if (platform() === 'linux') {
            await collect();
            timer = setInterval(() => {
              if (!sampling) sampling = collect().catch(error => { memoryError = error; }).finally(() => sampling = undefined);
            }, 100);
          }
          const run = page.evaluate(async args => (await import('/editor.js')).replay(args), { ...config, readers, mode, graphicsMode });
          let timeout;
          const { samples, graphics } = await Promise.race([run, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Replay timed out')), Math.max(180000, config.steps * 1000));
          })]).finally(() => clearTimeout(timeout));
          if (report.graphics) assert.deepEqual(graphics, report.graphics, 'WebGL renderer changed between cases');
          report.graphics = graphics;
          clearInterval(timer); await sampling;
          if (platform() === 'linux') await collect();
          if (memoryError) throw memoryError;
          const p95 = key => samples.map(s => s[key]).sort((a,b) => a-b)[Math.ceil(samples.length * .95) - 1];
          report.cases.push({ readers, mode, trial, p95FrameMs: p95('frameMs'), p95ValidationMs: p95('validationMs'),
            peakSampledPssKiB: pss.length ? Math.max(...pss.map(s => s[1])) : null, samples, pss });
          if (output) {
            await writeFile(output + '.partial', JSON.stringify(report) + '\n');
            await rename(output + '.partial', output);
          }
          console.error(`${mode}, ${readers} readers, trial ${trial + 1} completed`);
        } finally { clearInterval(timer); await sampling; await instance.close(); }
      }
    }
  }
  if (!output) console.log(JSON.stringify(report));
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
