import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
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
  const packers = builds.map(({ SharedList }) => typeof SharedList.prototype.toFloat64Array === 'function'
    ? list => list.toFloat64Array() : list => new Float64Array(list.toArray()));
  const measure = (name, points, repeats, setups, consume) => {
    const samples = [[], []];
    for (let round = -warmups; round < measured; round++) {
      for (const variant of round & 1 ? [1, 0] : [0, 1]) {
        const run = setups[variant]();
        const start = performance.now();
        for (let i = 0; i < repeats; i++) checksum += consume(run());
        const elapsed = performance.now() - start;
        if (round >= 0) samples[variant].push(elapsed);
      }
    }
    const [baselineMs, candidateMs] = samples.map(median);
    rows.push({ name, points, repeats, baselineMs, candidateMs, speedup: baselineMs / candidateMs, samples });
  };
  const roadCoordinates = points => {
    const source = new Float64Array(points * 2);
    for (let i = 0; i < points; i++) {
      const lane = i >>> 7, position = i & 127;
      source[2 * i] = (lane & 7) * 40 + position / 4;
      source[2 * i + 1] = (lane >>> 3) * 3.5 + Math.sin(position / 31) * 1.25;
    }
    return source;
  };
  const check = (actual, expected, name) => {
    if (actual.length !== expected.length || actual.some((value, i) => !Object.is(value, expected[i]))) {
      throw new Error(`Result mismatch in ${name}`);
    }
  };
  for (const workload of cases) {
    const { name, points, repeats, input, pack, edit, workflow } = workload;
    // Interleaved XY for 128-point lines in an 8 by 128 grid of road segments.
    const source = roadCoordinates(points);
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
      const packCoordinates = packers[variant];
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
      check(actual, expected, name);
      if (workflow) check(result.viewportBounds, bounds, name);
    }
    measure(name, points, repeats, setups, result => pack ? result.at(-1)
      : workflow ? result.coordinates.at(-1) + result.viewportBounds[2] : result.size);
  }

  // Both versions read only the requested lanes and reuse the output buffers.
  const points = 131072, laneSize = 256, source = roadCoordinates(points);
  const ranges = Array.from({ length: 16 }, (_, i) => {
    const start = (20 * 8 + 2 + (i >> 2) * 8 + (i & 3)) * laneSize;
    return { start, end: start + laneSize, offset: i * laneSize };
  });
  const [draggedLane] = ranges;
  const index = draggedLane.start + 96;
  const edits = [[[index, 35], [index + 1, 15]], [[index, 32], [index + 1, 12]]];
  const lane = source.slice(draggedLane.start, draggedLane.end);
  const patch = { ...draggedLane, offset: draggedLane.start };
  const scanBounds = (list, { start, end }) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = start; i < end; i += 2) {
      const x = list.get(i), y = list.get(i + 1);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return [minX, minY, maxX, maxY];
  };
  const referenceBounds = (values, range) => scanBounds({ get: index => values[index] }, range);
  const tiles = await Promise.all(builds.map(async ({ SharedList, resetSharedList, getWorkerData, initWorker, bboxXY }, variant) => {
    const makeTile = () => { resetSharedList(); return new SharedList('number').pushMany(source); };
    const tile = makeTile(), edited = tile.setMany(edits[0]);
    const { edited: reader } = await initWorker(getWorkerData({ edited }, { copy: false }));
    const canCopy = typeof reader.copyToFloat64Array === 'function';
    const copy = canCopy
      ? (list, out, range) => list.copyToFloat64Array(out, range)
      : (list, out, { start, end, offset }) => {
        for (let i = start; i < end; i++) out[offset++] = list.get(i);
      };
    const bounds = bboxXY(reader, { end: 0 })[0] === Infinity ? bboxXY : scanBounds;
    return {
      prepareFullBounds: () => () => bboxXY(reader),
      prepareFullCopy: () => {
        const out = new Float64Array(source.length);
        const refresh = canCopy ? () => reader.copyToFloat64Array(out) : () => out.set(packers[variant](reader));
        return () => { refresh(); return out; };
      },
      prepareCopy: () => {
        const out = new Float64Array(ranges.length * laneSize);
        return () => { for (const range of ranges) copy(reader, out, range); return out; };
      },
      prepareBounds: () => {
        const out = new Float64Array(ranges.length * 4);
        return () => {
          for (let i = 0; i < ranges.length; i++) out.set(bounds(reader, ranges[i]), i * 4);
          return out;
        };
      },
      prepareEdit: () => {
        let current = makeTile(), step = 0;
        const out = packers[variant](current);
        return () => {
          current = current.setMany(edits[step++ & 1]);
          copy(current, out, patch);
          return { out, bounds: bounds(current, patch) };
        };
      },
    };
  }));
  const editedSource = source.slice();
  for (const [i, value] of edits[0]) editedSource[i] = value;
  const expectedCopy = ranges.flatMap(({ start, end }) => Array.from(editedSource.subarray(start, end)));
  const expectedBounds = ranges.flatMap(range => referenceBounds(editedSource, range));
  const expectedFullBounds = referenceBounds(editedSource, { start: 0, end: editedSource.length });
  for (const tile of tiles) {
    check(tile.prepareFullBounds()(), expectedFullBounds, 'bound-full-tile');
    check(tile.prepareFullCopy()(), editedSource, 'copy-full-tile-into-buffer');
    check(tile.prepareCopy()(), expectedCopy, 'copy-visible-lanes');
    check(tile.prepareBounds()(), expectedBounds, 'bound-visible-lanes');
    const edit = tile.prepareEdit();
    for (const changes of edits) {
      const result = edit();
      for (const [i, value] of changes) lane[i - patch.start] = value;
      check(result.out.subarray(patch.start, patch.end), lane, 'edit-and-refresh-lane');
      check(result.bounds, referenceBounds(lane, { start: 0, end: laneSize }), 'edit-and-refresh-lane');
      if (result.out[patch.start - 1] !== source[patch.start - 1] || result.out[patch.end] !== source[patch.end]) {
        throw new Error('Edit changed geometry outside its lane');
      }
    }
  }
  measure('bound-full-tile', points, 32, tiles.map(tile => tile.prepareFullBounds), bounds => bounds[0]);
  measure('copy-full-tile-into-buffer', points, 16, tiles.map(tile => tile.prepareFullCopy), out => out[index]);
  measure('copy-visible-lanes', points, 512, tiles.map(tile => tile.prepareCopy), out => out[96] + out.at(-1));
  measure('bound-visible-lanes', points, 512, tiles.map(tile => tile.prepareBounds), out => out[0] + out.at(-1));
  measure('edit-and-refresh-lane', points, 512, tiles.map(tile => tile.prepareEdit), ({ out, bounds }) => out[index] + bounds[0]);
  return { warmups, measured, checksum, rows };
}

const [baselinePath, candidatePath = 'dist', engine] = process.argv.slice(2);
if (!baselinePath || (engine && !['chromium', 'firefox', 'webkit'].includes(engine))) {
  throw new Error('Usage: node proofs/hd-map-performance.mjs BASELINE_DIST [CANDIDATE_DIST] [chromium|firefox|webkit]');
}
const roots = { baseline: resolve(baselinePath), candidate: resolve(candidatePath) };
const buildDigests = Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([name, root]) => {
  const hash = createHash('sha256');
  for (const file of (await readdir(root)).filter(file => file.endsWith('.js')).sort()) {
    hash.update(file + '\0').update(await readFile(join(root, file)));
  }
  return [name, hash.digest('hex')];
})));
const host = { cpu: cpus()[0].model, arch: process.arch, date: new Date().toISOString(), buildDigests };
if (!engine) {
  const result = await benchmark({
    baseline: pathToFileURL(roots.baseline + '/').href,
    candidate: pathToFileURL(roots.candidate + '/').href,
  });
  console.log(JSON.stringify({ runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`, ...host, ...result }, null, 2));
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
      console.log(JSON.stringify({ runtime: `${engine} ${browser.version()}`, ...host, ...result }, null, 2));
    } finally { await browser.close(); }
  } finally { server.close(); }
}
