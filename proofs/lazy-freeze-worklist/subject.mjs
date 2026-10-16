// Fixed actual-codec subject. All imports and setup precede any timed region.
import { readFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = dirname(fileURLToPath(import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = path => digest(readFileSync(path));
const emit = value => writeSync(1, JSON.stringify(value) + '\n');
const check = (condition, code) => { if (!condition) throw new Error(code); };
const now = performance.now.bind(performance);
const ROWS = ['P-record', 'P-array', 'E-object', 'E-array', 'N-record', 'D-array', 'W-array', 'C-string', 'C-number', 'C-boolean'];
let stage = 'specification';
let spec;

function withinRoot(name) {
  check(typeof name === 'string' && !isAbsolute(name), 'relative-input-path');
  const path = resolve(root, name);
  check(!relative(root, path).startsWith('..'), 'input-outside-proof');
  return path;
}

function treeCheck(actual, expected, frozen) {
  const todo = [[actual, expected]];
  let nodes = 0;
  while (todo.length) {
    const [value, wanted] = todo.pop();
    if (wanted === null || typeof wanted !== 'object') {
      check(Object.is(value, wanted), 'value-mismatch');
      continue;
    }
    check(value !== null && typeof value === 'object', 'object-mismatch');
    check(Array.isArray(value) === Array.isArray(wanted), 'array-kind');
    check(Object.getPrototypeOf(value) === (Array.isArray(wanted) ? Array.prototype : Object.prototype), 'prototype');
    check(!frozen || Object.isFrozen(value), 'not-deeply-frozen');
    nodes++;
    check(nodes < 2048, 'node-cap');
    const actualKeys = Reflect.ownKeys(value);
    const wantedKeys = Reflect.ownKeys(wanted);
    check(actualKeys.length === wantedKeys.length, 'own-key-count');
    for (let i = 0; i < wantedKeys.length; i++) {
      const key = wantedKeys[i];
      check(actualKeys[i] === key, 'own-key-order');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const wantedDescriptor = Object.getOwnPropertyDescriptor(wanted, key);
      check(descriptor && 'value' in descriptor && descriptor.enumerable === wantedDescriptor.enumerable, 'data-descriptor');
      check(!frozen || (descriptor.writable === false && descriptor.configurable === false), 'frozen-descriptor');
      todo.push([descriptor.value, wantedDescriptor.value]);
    }
  }
  return nodes;
}

function loopFor(decode, bytes, length, expression) {
  // Expressions are fixed below, never supplied by the specification or payload.
  return new Function('decode', 'bytes', 'length', 'now', `return function(count) {
    let latest;
    let checksum = 0;
    const start = now();
    for (let i = 0; i < count; i++) {
      latest = decode(bytes, 16, length);
      checksum += (${expression});
    }
    const end = now();
    return { latest, checksum, elapsedNs: (end - start) * 1000000 };
  };`)(decode, bytes, length, now);
}

function makeRows(getCodec) {
  const record = {id:104729,kind:'metric',source:'worker-07',name:'queue.depth',value:37.5,unit:'items',timestamp:1760000000123,sequence:8192,ok:true,sampled:false,region:'eu-west',host:'node-04',label:'café / 東京',note:null,attempt:2,ttl:60};
  const nested = {requestId:'req-0042',ok:true,user:{id:42,name:'Ada',locale:'en-GB'},items:[{sku:'A1',qty:2,price:12.5},{sku:'B2',qty:1,price:7}],meta:{page:1,next:null}};
  const definitions = [
    ['P-record','object',record,'latest.id + latest.sequence'],
    ['P-array','object',Array.from({length:64}, (_, i) => 20 + ((17*i)%101)/10),'latest.length'],
    ['E-object','object',{},'latest.missing === undefined ? 1 : 0'],
    ['E-array','object',[],'latest.length + 1'],
    ['N-record','object',nested,'latest.user.id + latest.items.length'],
    ['D-array','object',null,'latest.length','['.repeat(256)+'1'+']'.repeat(256)],
    ['W-array','object',Array.from({length:128}, (_, i) => ({id:i,active:i%2===0,value:i/8,label:'item-'+i})),'latest.length'],
    ['C-string','string','worker-07 / café / 東京 / 🔔','latest.length'],
    ['C-number','number',12345.25,'latest'],
    ['C-boolean','boolean',true,'latest ? 1 : 0'],
  ];
  const encoder = new TextEncoder();
  let totalBytes = 0;
  return definitions.map(([id,type,value,expression,exactJSON]) => {
    const codec = getCodec(type);
    let payload, expected;
    if (type === 'object') {
      const json = exactJSON ?? JSON.stringify(value);
      payload = encoder.encode(json);
      expected = JSON.parse(json);
    } else {
      expected = value;
      payload = new Uint8Array(codec.size(value));
      check(codec.encode(value, payload, 0) === payload.length, 'encoded-length');
    }
    check(payload.length < 65536, 'input-cap');
    const bytes = new Uint8Array(new SharedArrayBuffer(payload.length + 32));
    bytes.set(payload, 16);
    totalBytes += bytes.length;
    check(totalBytes < 1048576, 'prepared-byte-cap');
    const scalar = new Function('latest', `return (${expression});`);
    const row = {id,type,expected,bytes,length:payload.length,payloadSha256:digest(payload),inputSha256:digest(bytes),scalar,expectedScalar:scalar(expected),cap:type === 'object' ? 2**20 : 2**24};
    row.decode = codec.decode;
    row.loop = loopFor(codec.decode, bytes, payload.length, expression);
    row.nodes = treeCheck(expected, expected, false);
    return row;
  });
}

function validate(row, latest, checksum, count) {
  check(checksum === row.expectedScalar * count, 'checksum');
  check(treeCheck(latest, row.expected, row.type === 'object') === row.nodes, 'node-count');
  check(digest(row.bytes) === row.inputSha256, 'input-mutated');
}

function preflight(row) {
  const first = row.decode(row.bytes, 16, row.length);
  validate(row, first, row.scalar(first), 1);
  const second = row.decode(row.bytes, 16, row.length);
  validate(row, second, row.scalar(second), 1);
  check(row.type !== 'object' || first !== second, 'root-reused');
}

function batch(row, count, trial, phase, index) {
  stage = `${row.id}/${phase}/${trial}/${index}`;
  const result = row.loop(count);
  const record = {event:'batch',id:spec.id,row:row.id,trial,phase,index,count,elapsedNs:result.elapsedNs,checksum:result.checksum,validated:false};
  try {
    check(Number.isFinite(result.elapsedNs) && result.elapsedNs > 0, 'duration');
    validate(row, result.latest, result.checksum, count);
    record.validated = true;
    record.inputSha256 = row.inputSha256;
    record.nodes = row.nodes;
  } finally {
    // Even a failed validation keeps the elapsed time and checksum, without outputs.
    emit(record);
  }
  return result.elapsedNs;
}

try {
  const specBytes = readFileSync(process.argv[2]);
  spec = JSON.parse(specBytes);
  check(spec.schema === 1 && ['calibration','measurement'].includes(spec.mode), 'mode');
  const engine = process.versions.bun ? 'bun' : 'node';
  const runtimeVersion = process.versions.bun ?? process.versions.node;
  check(engine === spec.engine && runtimeVersion === (engine === 'node' ? '22.16.0' : '1.4.2'), 'runtime');
  check(['B','C','A'].includes(spec.arm) && (spec.mode !== 'calibration' || spec.arm === 'B'), 'arm');
  const bundle = withinRoot(spec.bundle);
  check(fileHash(bundle) === spec.bundleSha256, 'bundle-pin');
  check(fileHash(fileURLToPath(import.meta.url)) === spec.driverSha256, 'driver-pin');
  check(fileHash(resolve(root, 'METHOD.md')) === spec.methodSha256, 'method-pin');
  check(fileHash(resolve(root, 'source-pins.json')) === spec.sourceManifestSha256, 'manifest-pin');
  stage = 'import';
  const { getCodec } = await import(pathToFileURL(bundle).href);
  stage = 'fixtures';
  const rows = makeRows(getCodec);
  check(rows.map(row => row.id).join('|') === ROWS.join('|'), 'row-order');
  let sharedInputDecode;
  try { sharedInputDecode = new TextDecoder().decode(new Uint8Array(new SharedArrayBuffer(1))) === '\0'; }
  catch { sharedInputDecode = false; }
  for (const row of rows) preflight(row);
  emit({event:'ready',id:spec.id,specSha256:digest(specBytes),engine,runtimeVersion,bundleSha256:spec.bundleSha256,driverSha256:spec.driverSha256,methodSha256:spec.methodSha256,sourceManifestSha256:spec.sourceManifestSha256,sharedInputDecode,rows:rows.map(row => ({row:row.id,codec:row.type,bytes:row.length,preparedBytes:row.bytes.length,payloadSha256:row.payloadSha256,inputSha256:row.inputSha256,nodes:row.nodes,expectedScalar:row.expectedScalar}))});
  for (const row of rows) {
    stage = `${row.id}/preflight`;
    preflight(row);
    if (spec.mode === 'calibration') {
      let count = 256;
      for (let trial = 1; trial <= 4; trial++) {
        for (let index = 1; index <= 5; index++) batch(row, count, trial, 'warmup', index);
        const pilots = [];
        for (let index = 1; index <= 3; index++) pilots.push(batch(row, count, trial, 'pilot', index));
        const medianNs = pilots.sort((a,b) => a-b)[1];
        const calibrated = medianNs >= 20000000 && medianNs <= 50000000;
        emit({event:'trial',id:spec.id,row:row.id,trial,count,medianNs,calibrated});
        if (calibrated || trial === 4) {
          emit({event:'row-complete',id:spec.id,row:row.id,count,calibrated,trials:trial});
          break;
        }
        count = Math.max(1, Math.min(row.cap, Math.round(count * 30000000 / medianNs)));
      }
    } else {
      const frozen = spec.counts[row.id];
      check(frozen && Number.isInteger(frozen.count) && frozen.count > 0 && frozen.count <= row.cap && typeof frozen.calibrated === 'boolean', 'frozen-count');
      for (let index = 1; index <= 5; index++) batch(row, frozen.count, 1, 'warmup', index);
      for (let index = 1; index <= 9; index++) batch(row, frozen.count, 1, 'measurement', index);
      emit({event:'row-complete',id:spec.id,row:row.id,count:frozen.count,calibrated:frozen.calibrated});
    }
  }
  stage = 'final-source-binding';
  check(fileHash(bundle) === spec.bundleSha256 && fileHash(fileURLToPath(import.meta.url)) === spec.driverSha256 && fileHash(resolve(root, 'METHOD.md')) === spec.methodSha256 && fileHash(resolve(root, 'source-pins.json')) === spec.sourceManifestSha256, 'final-pins');
  emit({event:'complete',id:spec.id,rows:ROWS,status:'passed'});
} catch (error) {
  // Paths/stacks and arbitrary runtime metadata are deliberately absent.
  emit({event:'failure',id:spec?.id ?? null,stage,name:error?.name ?? 'Error'});
  process.exitCode = 1;
}
