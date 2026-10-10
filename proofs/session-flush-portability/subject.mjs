import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { runWorkload } from './workload.mjs';
import { writeRow } from './writer.mjs';
const ROOT = dirname(fileURLToPath(import.meta.url));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function readInputs(argv) {
  const [mode, runtime, arm, slotText, caseName, output, runtimeManifestPath, frozenPath] = argv;
  const protocolBytes = readFileSync(resolve(ROOT, 'PROTOCOL.json')), protocol = JSON.parse(protocolBytes);
  const pinsBytes = readFileSync(resolve(ROOT, 'INPUT-PINS.json'));
  const runtimeBytes = readFileSync(runtimeManifestPath), runtimeManifest = JSON.parse(runtimeBytes);
  const frozenBytes = frozenPath ? readFileSync(frozenPath) : null;
  const frozen = frozenBytes ? JSON.parse(frozenBytes) : null;
  const slot = Number(slotText), item = protocol.cases.find(x => x.name === caseName);
  assert(item && ['calibrate', 'measure'].includes(mode)); assert(['baseline', 'candidate'].includes(arm));
  assert(Object.values(protocol.runtimeGroups).flat().includes(runtime));
  assert(Number.isInteger(slot));
  assert(mode === 'calibrate' ? slot === -1 : slot >= 0 && slot < 8 && protocol.armOrder[slot] === arm);
  const identity = { mode, runtime, arm, slot, caseName };
  const references = { protocolSHA256: hash(protocolBytes), inputPinsSHA256: hash(pinsBytes),
    runtimeManifestSHA256: hash(runtimeBytes), frozenCountsSHA256: frozenBytes ? hash(frozenBytes) : null,
    calibrationSHA256: frozen ? Object.fromEntries(Object.entries(frozen.cases[caseName].calibrations).map(([a,v]) => [a,v.sha256])) : null };
  assert.equal(process.platform, 'linux'); assert.deepEqual(process.execArgv, []);
  for (const variable of ['NODE_OPTIONS', 'BUN_OPTIONS', 'BUN_INSPECT', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PLAYWRIGHT_NODEJS_PATH', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD']) assert.equal(process.env[variable], undefined);
  assert.equal(hash(readFileSync(process.execPath)), runtimeManifest.executables[runtime === 'bun' ? 'bun' : 'node'].sha256);
  if (runtime === 'bun') assert.equal(process.versions.bun, '1.4.2');
  else { assert.equal(process.version, 'v22.23.3'); assert.equal(process.versions.bun, undefined); }
  assert.equal(process.arch, runtimeManifest.arch);
  if (runtime === 'node' || runtime === 'bun') assert.equal(process.arch, 'arm64');
  if (frozen) {
    assert.equal(frozen.runtime, runtime);
    for (const key of ['protocolSHA256','inputPinsSHA256','runtimeManifestSHA256']) assert.equal(frozen[key], references[key]);
  } else assert.equal(mode, 'calibrate');
  function checkPins() {
    assert.equal(hash(readFileSync(resolve(ROOT, 'INPUT-PINS.json'))), references.inputPinsSHA256);
    for (const row of JSON.parse(pinsBytes).files) {
      const bytes = readFileSync(resolve(ROOT, row.path)); assert.equal(bytes.length, row.bytes); assert.equal(hash(bytes), row.sha256);
    }
  }
  checkPins();
  return { ROOT, protocol, item, identity, references, output, runtimeManifest, checkPins, counts: frozen?.cases[caseName] };
}
export const log = writeRow;
export async function containment(rootPids) {
  const lines = createInterface({ input: process.stdin });
  const acknowledgment = new Promise((accept, reject) => {
    lines.once('line', line => { try { accept(JSON.parse(line)); } catch (e) { reject(e); } });
    lines.once('close', () => reject(new Error('Missing containment acknowledgment')));
  });
  await log({ event: 'containment-ready', rootPids });
  const ack = await acknowledgment;
  lines.close();
  assert.equal(ack.event, 'containment-verified');
  assert.equal(ack.method, 'linux-subreaper-descendant-census');
  assert.deepEqual(ack.roots.map(x => x.pid), rootPids); await log(ack);
}
export async function emit(row) {
  if (row.event === 'fixture') { row.fixtureSHA256 = hash(JSON.stringify(row.fixture)); await log(row); return row.fixtureSHA256; }
  await log(row);
}
export async function finish(input, result) {
  input.checkPins();
  const value = { schema: 1, ...input.identity, ...input.references, ...result };
  writeFileSync(input.output, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await log({ event: 'complete', resultSHA256: hash(readFileSync(input.output)), ...input.identity,
    cycles: result.cycles, capped: result.capped, batchCount: result.batches.length });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = readInputs(process.argv.slice(2));
  await log({ event: 'subject-start', ...input.identity, ...input.references });
  await containment([process.pid]);
  const start = process.hrtime.bigint();
  const result = await runWorkload({ ...input, sharedURL: pathToFileURL(resolve(ROOT, 'arms', input.identity.arm, 'dist/shared.js')).href,
    workerURL: pathToFileURL(resolve(ROOT, 'arms', input.identity.arm, 'dist/worker.js')).href,
    emit, now: () => Number(process.hrtime.bigint() - start) });
  await finish(input, result);
}
