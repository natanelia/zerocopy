import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep this function self-contained so the same workloads run in browsers.
async function benchmark({ baseline, candidate }) {
  const builds = await Promise.all([baseline, candidate].map(async path => ({
    ...await import(path + 'shared.js'),
    ...await import(path + 'geometry.js'),
  })));
  const cases = [
    { name: 'append-short-array', points: 24, repeats: 2048, input: 'array' },
    { name: 'append-short-f64', points: 24, repeats: 2048, input: 'f64' },
    { name: 'append-tile-array', points: 131072, repeats: 4, input: 'array' },
    { name: 'append-tile-f64', points: 131072, repeats: 4, input: 'f64' },
    { name: 'append-tile-f32', points: 131072, repeats: 4, input: 'f32' },
    { name: 'pack-short', points: 24, repeats: 2048, pack: true },
    { name: 'pack-tile', points: 131072, repeats: 8, pack: true },
    { name: 'pack-edited-tile', points: 131072, repeats: 8, pack: true, edit: true },
    { name: 'import-bounds-edit-pack', points: 131072, repeats: 2, input: 'f64', workflow: true },
  ];
  const warmups = 10, measured = 25;
  const median = values => values.toSorted((a, b) => a - b)[values.length >> 1];
  const rows = [];
  let checksum = 0;
  for (const workload of cases) {
    const { name, points, repeats, input, pack, edit, workflow } = workload;
    // Interleaved XY for 128-point lines in an 8 by 128 grid of road segments.
    const source = new Float64Array(points * 2);
    for (let i = 0; i < points; i++) {
      const lane = i >>> 7, position = i & 127;
      source[2 * i] = (lane & 7) * 40 + position / 4;
      source[2 * i + 1] = (lane >>> 3) * 3.5 + Math.sin(position / 31) * 1.25;
    }
    const values = input === 'array' ? Array.from(source) : input === 'f32' ? new Float32Array(source) : source;
    const edits = Array.from({ length: 128 }, (_, i) => {
      const index = (i * 1009 % points) * 2;
      return [[index, source[index] + 0.25], [index + 1, source[index + 1] - 0.125]];
    }).flat();
    const expected = new Float64Array(values);
    if (edit || workflow) for (const [i, value] of edits) expected[i] = value;
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    if (workflow) for (let i = 0; i < source.length; i += 2) {
      bounds[0] = Math.min(bounds[0], source[i]);
      bounds[1] = Math.min(bounds[1], source[i + 1]);
      bounds[2] = Math.max(bounds[2], source[i]);
      bounds[3] = Math.max(bounds[3], source[i + 1]);
    }
    const setups = await Promise.all(builds.map(async (build, variant) => {
      const { SharedList, resetSharedList, getWorkerData, initWorker, bboxXY } = build;
      const packCoordinates = variant === 0
        ? list => new Float64Array(list.toArray())
        : list => list.toFloat64Array();
      const editPoints = list => edit || workflow ? list.setMany(edits) : list;
      const newArena = () => { resetSharedList(); return new SharedList('number'); };
      if (pack) {
        const list = editPoints(newArena().pushMany(values));
        const { points: reader } = await initWorker(getWorkerData({ points: list }, { copy: false }));
        const run = () => packCoordinates(reader);
        return () => run;
      }
      return () => {
        const empty = newArena();
        // Provision pages outside timing for both builds, so memory growth
        // cannot mask a copy improvement. The full workflow grows normally.
        if (!workflow) getWorkerData({ empty }, { copy: false }).arenas[0].memory
          .grow(Math.ceil(values.length * 9 * repeats / 65536));
        if (workflow) return () => {
          const imported = empty.pushMany(values);
          const viewportBounds = bboxXY(imported);
          return { viewportBounds, coordinates: packCoordinates(editPoints(imported)) };
        };
        return () => empty.pushMany(values);
      };
    }));
    for (const prepare of setups) {
      const run = prepare(), result = run();
      const actual = pack ? result : workflow ? result.coordinates : result.toArray();
      if (actual.length !== expected.length || actual.some((value, i) => !Object.is(value, expected[i]))) {
        throw new Error(`Coordinate mismatch in ${name}`);
      }
      if (workflow && result.viewportBounds.some((value, i) => !Object.is(value, bounds[i]))) {
        throw new Error(`Bounds mismatch in ${name}`);
      }
    }
    const samples = [[], []];
    for (let round = -warmups; round < measured; round++) {
      for (const variant of round & 1 ? [1, 0] : [0, 1]) {
        const run = setups[variant]();
        const start = performance.now();
        for (let i = 0; i < repeats; i++) {
          const result = run();
          checksum += pack ? result.at(-1) : workflow ? result.coordinates.at(-1) + result.viewportBounds[2] : result.size;
        }
        const elapsed = performance.now() - start;
        if (round >= 0) samples[variant].push(elapsed);
      }
    }
    const [baselineMs, candidateMs] = samples.map(median);
    rows.push({ name, points, repeats, baselineMs, candidateMs, speedup: baselineMs / candidateMs, samples });
  }
  return { warmups, measured, checksum, rows };
}

const [baselinePath, candidatePath = 'dist', engine] = process.argv.slice(2);
if (!baselinePath || (engine && !['chromium', 'firefox', 'webkit'].includes(engine))) {
  throw new Error('Usage: node proofs/hd-map-performance.mjs BASELINE_DIST [CANDIDATE_DIST] [chromium|firefox|webkit]');
}
const roots = { baseline: resolve(baselinePath), candidate: resolve(candidatePath) };
const cpu = cpus()[0].model;
if (!engine) {
  const result = await benchmark({
    baseline: pathToFileURL(roots.baseline + '/').href,
    candidate: pathToFileURL(roots.candidate + '/').href,
  });
  console.log(JSON.stringify({ runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`, cpu, ...result }, null, 2));
} else {
  const playwright = await import('playwright');
  const server = createServer(async (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Geometry benchmark</title>'); return; }
    const match = /^\/(baseline|candidate)\/([\w.-]+\.js)$/.exec(req.url);
    try {
      if (!match) throw new Error('Unknown module');
      res.setHeader('Content-Type', 'application/javascript');
      res.end(await readFile(join(roots[match[1]], match[2])));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((ready, reject) => server.once('error', reject).listen(0, '127.0.0.1', ready));
  try {
    const browser = await playwright[engine].launch({
      headless: true,
      executablePath: engine === 'chromium' ? process.env.CHROMIUM_PATH : undefined,
    });
    try {
      const page = await browser.newPage();
      const origin = `http://127.0.0.1:${server.address().port}`;
      await page.goto(origin);
      if (!await page.evaluate(() => crossOriginIsolated)) throw new Error('Shared memory requires an isolated page');
      const result = await page.evaluate(benchmark, { baseline: origin + '/baseline/', candidate: origin + '/candidate/' });
      console.log(JSON.stringify({ runtime: `${engine} ${browser.version()}`, cpu, ...result }, null, 2));
    } finally { await browser.close(); }
  } finally { server.close(); }
}
