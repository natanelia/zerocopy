// Prospective subject child. This file must not run before independent release.
import {readFileSync, openSync, writeSync, fsyncSync, closeSync, realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {CASES, LIMITS, fixture, chooseCount, readiness, describe, clockSummary, readResolution} from './protocol.mjs';

const METHOD_SHA = '70d4c38a862ce9caeae0c19904ee76cd1d0b2daed59f2943ae00b5b414bce6e4';
const FIXTURE_SHA = '019cc30dd93c240a6b6387dcdda642a6284f1789591a6552efb60bd1c7a4696a';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const output = process.argv[3];
const eventFd = openSync(output + '.events.jsonl', 'ax');
const now = () => process.hrtime.bigint();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const emit = value => { writeSync(eventFd, JSON.stringify(value) + '\n'); fsyncSync(eventFd); };
const report = value => writeSync(1, JSON.stringify(value) + '\n');
const result = {...config, complete:false, qualityClear:false, warmup:[], measured:[], verification:[], pilots:[], pilotWarmup:[], pilotStages:[], startup:{}, validation:[]};
const retained = {startup:[], writers:[], readers:[], payloads:[], readerBuffers:[], fixtures:[]};

try {
  check(config.methodSha256 === METHOD_SHA && config.fixtureSha256 === FIXTURE_SHA, 'method/fixture binding');
  check(process.execArgv.length === 0 && !process.env.NODE_OPTIONS && !process.env.BUN_OPTIONS && !process.env.NODE_PATH, 'runtime options forbidden');
  check(config.engine === 'bun' ? process.versions.bun === '1.4.2' : config.engine === 'node' && !process.versions.bun && process.versions.node === '22.16.0', 'runtime version mismatch');
  const expectedRelative = config.engine === 'node' ? 'dist/shared.js' : 'shared.ts';
  const expectedPath = realpathSync(resolve(config.armRoot, expectedRelative));
  const resolvedPath = realpathSync(fileURLToPath(import.meta.resolve('zerocopy')));
  check(config.expectedEntry.relativePath === expectedRelative && resolvedPath === expectedPath, 'public package resolved outside exact arm');
  check(sha(readFileSync(resolvedPath)) === config.expectedEntry.sha256, 'public entry hash mismatch');
  result.resolution = {specifier:'zerocopy', condition:config.engine === 'node' ? 'import' : 'bun', path:resolvedPath, sha256:config.expectedEntry.sha256};

  // Actual child clock, before subject import and any case dispatch/setup.
  const readings = Array.from({length:10001}, () => now());
  const deltasNs = readings.slice(1).map((value, i) => Number(value - readings[i]));
  const pairsNs = [];
  for (let i = 0; i < 1000; i++) { const begin = now(); const end = now(); pairsNs.push(Number(end - begin)); }
  result.clock = clockSummary(deltasNs, pairsNs);
  emit({event:'clock', domain:'process.hrtime.bigint', deltasNs, pairsNs, clock:result.clock});

  const importStart = now();
  const {SharedMap, getWorkerData, initWorker} = await import('zerocopy');
  const smokeEmpty = new SharedMap('number');
  check(smokeEmpty.get('k0100000') === undefined, 'startup empty miss');
  const smokeSingleton = smokeEmpty.set('k0000000', 1);
  check(smokeSingleton.get('k0000000') === 1 && smokeSingleton.get('k0100000') === undefined, 'startup singleton hit/miss');
  const importToReadyNs = Number(now() - importStart);
  // Supervisor readiness is reception of this complete line on its own clock.
  report({event:'ready', importToReadyNs});
  retained.startup.push(smokeEmpty, smokeSingleton);
  result.startup.importToReadyNs = importToReadyNs;
  emit({event:'ready', importToReadyNs, resolution:result.resolution});

  // All fixture arrays, hashing, dispatch, copy/attachment and checks start here.
  const setupStart = now();
  const fixtureBytes = readFileSync(config.fixturesPath);
  check(sha(fixtureBytes) === FIXTURE_SHA, 'fixed fixture file changed');
  const definitions = JSON.parse(fixtureBytes);
  check(JSON.stringify(definitions.case_order) === JSON.stringify(CASES.map(c => c.id)), 'fixed case order');

  function publicDescriptor(map) {
    const data = getWorkerData({map}, {copy:false});
    check(data.arenas.length === 1 && data.arenas[0].memory, 'one public numeric arena expected');
    const arena = data.arenas[0];
    check(Number.isSafeInteger(arena.used) && arena.used >= 65536 && arena.used <= arena.memory.buffer.byteLength, 'invalid public used length');
    return arena;
  }
  let retainedCopiedBytes = 0;
  const allocations = [];
  const byteLimit = 268435456;
  function reserve(bytes, label) {
    check(Number.isSafeInteger(bytes) && bytes > 0, 'invalid allocation bound');
    check(retainedCopiedBytes + bytes <= byteLimit, 'validator retained payload/reader byte cap before ' + label);
  }
  function copy(map, label, bounded) {
    const descriptor = publicDescriptor(map);
    if (bounded) reserve(descriptor.used, label);
    const payload = getWorkerData({map}, {copy:true});
    check(payload.arenas.length === 1, 'one public copied arena expected');
    const arena = payload.arenas[0];
    check(arena.used === descriptor.used && arena.copy?.byteLength === descriptor.used, 'public copy length differs from prechecked bound');
    if (bounded) {
      retainedCopiedBytes += arena.copy.byteLength;
      allocations.push({label, type:'payload', used:arena.used, bytes:arena.copy.byteLength, aggregateBytes:retainedCopiedBytes});
    }
    retained.payloads.push(payload);
    return payload;
  }
  async function attach(payload, label, bounded) {
    const bytes = Math.max(2, Math.ceil(payload.arenas[0].used / 65536)) * 65536;
    if (bounded) reserve(bytes, label);
    const {map} = await initWorker(payload);
    const descriptor = publicDescriptor(map);
    check(descriptor.used === payload.arenas[0].used && descriptor.memory.buffer.byteLength === bytes, 'reader committed bytes differ from prechecked bound');
    if (bounded) {
      retainedCopiedBytes += descriptor.memory.buffer.byteLength;
      allocations.push({label, type:'reader', used:descriptor.used, bytes:descriptor.memory.buffer.byteLength, aggregateBytes:retainedCopiedBytes});
    }
    retained.readers.push(map);
    retained.readerBuffers.push(descriptor.memory.buffer);
    return map;
  }
  function seed(map, f, changed=false) {
    for (let i = 0; i < f.seedKeys.length; i++) {
      const expected = changed && i === 0 ? -1 : changed && i === 1 ? undefined : i + 1;
      check(map.get(f.seedKeys[i]) === expected, 'prescribed public cache seed');
    }
  }
  function querySweep(map, f, changed=false) {
    let checksum = 0;
    for (let i = 0; i < f.queries.length; i++) {
      const identifier = f.queryStart + i;
      const expected = changed && identifier === 0 ? -1 : changed && identifier === 1 ? undefined :
        changed && identifier === 100000 ? 100001 : identifier < f.entryCount ? identifier + 1 : undefined;
      const actual = f.operation === 'has' ? map.has(f.queries[i]) : map.get(f.queries[i]);
      check(actual === (f.operation === 'has' ? expected !== undefined : expected), 'query result mismatch');
      checksum += f.operation === 'has' ? (actual ? 1 : 0) : f.queryStart < f.entryCount ? (actual ?? 0) : (actual === undefined ? 1 : 0);
    }
    if (!changed) check(checksum === f.expectedChecksumPerPass, 'full query checksum mismatch');
    return checksum;
  }
  function contents(map, f, changed=false) {
    check(map.size === (changed && f.entryCount === 0 ? 2 : f.entryCount), 'fixture/fork size mismatch');
    for (let i = 0; i < f.entries.length; i++) {
      const expected = changed && i === 0 ? -1 : changed && i === 1 ? undefined : i + 1;
      check(map.get(f.entries[i][0]) === expected, 'fixture value mismatch');
    }
    check(map.get('k0000000') === (changed ? -1 : f.entryCount ? 1 : undefined), 'retained key0 mismatch');
    check(map.get('k0000001') === (changed ? undefined : f.entryCount ? 2 : undefined), 'retained key1 mismatch');
    check(map.get('k0100000') === (changed ? 100001 : undefined), 'retained added key mismatch');
    return querySweep(map, f, changed);
  }
  function unchanged(before, after) {
    const a = before.arenas[0], b = after.arenas[0];
    check(a.used === b.used && a.copy.byteLength === b.copy.byteLength, 'reads changed arena used/copy lengths');
    for (let i = 0; i < a.copy.byteLength; i++) check(a.copy[i] === b.copy[i], 'reads changed copied arena byte');
    return {used:a.used, bytes:a.copy.byteLength, beforeSha256:sha(a.copy), afterSha256:sha(b.copy)};
  }

  if (config.kind === 'validation') {
    const absent = fixture('C4').queries;
    let inputEntries = 0;
    for (const definition of CASES) {
      const f = fixture(definition.id, absent);
      retained.fixtures.push(f);
      inputEntries += f.entries.length;
      const empty = new SharedMap('number');
      const writer = empty.setMany(f.entries);
      const oldPayload = copy(writer, f.id + '/old-before', true);
      const oldReader = await attach(oldPayload, f.id + '/old-reader', true);
      const overridden = writer.set('k0000000', -1);
      const deleted = overridden.delete('k0000001');
      const changed = deleted.set('k0100000', 100001);
      const changedPayload = copy(changed, f.id + '/changed-before', true);
      const changedReader = await attach(changedPayload, f.id + '/changed-reader', true);
      retained.writers.push(empty, writer, overridden, deleted, changed);
      seed(oldReader, f);
      seed(changedReader, f, true);
      // Warm through public reads, then independently recheck old and new views.
      contents(oldReader, f);
      contents(changedReader, f, true);
      const oldChecksum = contents(oldReader, f);
      const changedChecksum = contents(changedReader, f, true);
      contents(writer, f);
      contents(changed, f, true);
      const oldAfter = copy(oldReader, f.id + '/old-after', true);
      const changedAfter = copy(changedReader, f.id + '/changed-after', true);
      const validation = {caseId:f.id, oldSize:oldReader.size, changedSize:changedReader.size,
        oldChecksum, changedChecksum, oldBytes:unchanged(oldPayload, oldAfter), changedBytes:unchanged(changedPayload, changedAfter),
        entryArraySha256:f.entryArraySha256, queryArraySha256:f.queryArraySha256};
      result.validation.push(validation);
      emit({event:'validated-fixture', validation});
    }
    check(inputEntries === 41472 && retained.writers.length === 30 && retained.readers.length === 12 &&
      retained.payloads.length === 24 && retained.readerBuffers.length === 12 && retained.startup.length === 2, 'validator finite retention counts');
    check(retainedCopiedBytes <= byteLimit, 'validator final copied byte cap');
    result.retention = {inputEntries, writerHandles:30, readerHandles:12, startupHandles:2, totalHandles:44,
      payloadBuffers:24, readerMemoryBuffers:12, separateComparisonBuffers:0,
      aggregatePayloadAndReaderBytes:retainedCopiedBytes, allocations};
    result.qualityClear = true;
  } else {
    check(config.kind === 'calibration' || config.kind === 'main', 'unknown child kind');
    check(config.kind !== 'calibration' || config.variant === 'baseline', 'candidate calibration forbidden');
    const f = fixture(config.caseId);
    retained.fixtures.push(f);
    const empty = new SharedMap('number');
    const writer = empty.setMany(f.entries);
    retained.writers.push(empty, writer);
    const payload = copy(writer, f.id + '/before', false);
    const reader = await attach(payload, f.id + '/reader', false);
    check(writer.size === f.entryCount && reader.size === f.entryCount, 'fixture size');
    seed(reader, f);
    querySweep(reader, f);
    result.fixture = {entryArraySha256:f.entryArraySha256, queryArraySha256:f.queryArraySha256,
      queryCount:f.queryCount, expectedChecksumPerPass:f.expectedChecksumPerPass, readerUsed:payload.arenas[0].used};
    result.setupNs = Number(now() - setupStart);
    report({event:'setup', setupNs:result.setupNs});
    emit({event:'setup', setupNs:result.setupNs, fixture:result.fixture});
    const keys = f.queries, length = keys.length;
    // Separate direct loops avoid a public-operation selector inside every read.
    const loop = f.operation === 'has' ? function(count) {
      let checksum = 0;
      const start = now();
      for (let pass = 0; pass < count / length; pass++)
        for (let i = 0; i < length; i++) checksum += reader.has(keys[i]) ? 1 : 0;
      return {ns:Number(now() - start), checksum};
    } : f.queryStart < f.entryCount ? function(count) {
      let checksum = 0;
      const start = now();
      for (let pass = 0; pass < count / length; pass++)
        for (let i = 0; i < length; i++) checksum += reader.get(keys[i]);
      return {ns:Number(now() - start), checksum};
    } : function(count) {
      let checksum = 0;
      const start = now();
      for (let pass = 0; pass < count / length; pass++)
        for (let i = 0; i < length; i++) checksum += reader.get(keys[i]) === undefined ? 1 : 0;
      return {ns:Number(now() - start), checksum};
    };
    function batch(category, count, stageIndex = null) {
      check(Number.isSafeInteger(count) && count >= 16384 && count <= 16777216 && count % 16384 === 0 && count % length === 0, 'invalid aligned read count');
      const observation = loop(count);
      const value = {index:result[category].length, count, ...observation, milliseconds:observation.ns / 1e6,
        nanosecondsPerRead:observation.ns / count,
        checksumValid:observation.checksum === f.expectedChecksumPerPass * count / length};
      if (stageIndex !== null) {
        value.stageIndex = stageIndex;
        result.pilotStages[stageIndex][category === 'pilotWarmup' ? 'warmup' : 'pilots'].push(value);
      }
      result[category].push(value);
      emit({event:'batch', category, batch:value});
      check(value.checksumValid && Number.isFinite(value.ns) && value.ns > 0, 'batch checksum/duration mismatch');
      return value;
    }
    let N = config.N;
    if (config.kind === 'calibration') {
      let selection = chooseCount([], result.clock);
      while (selection.pending) {
        const stageIndex = result.pilotStages.length;
        const stage = {index:stageIndex, count:selection.nextCount, warmup:[], pilots:[]};
        result.pilotStages.push(stage);
        emit({event:'pilot-stage', stageIndex, count:stage.count});
        for (let i = 0; i < LIMITS.pilotWarmupBatches; i++) batch('pilotWarmup', stage.count, stageIndex);
        stage.readiness = readiness(stage.warmup.map(b => b.ns));
        if (stage.readiness.clear) {
          for (let i = 0; i < LIMITS.pilotSampleBatches; i++) {
            const observation = batch('pilots', stage.count, stageIndex);
            if (observation.ns > LIMITS.pilotMaximumNs) break;
          }
        }
        selection = chooseCount(result.pilotStages, result.clock);
        emit({event:'count-selection', selection});
      }
      result.countSelection = selection;
      check(selection.resolved, selection.reason);
      N = selection.N;
    }
    result.N = N;
    emit({event:'count', N});
    for (let i = 0; i < 8; i++) batch('warmup', N);
    const category = config.kind === 'calibration' ? 'verification' : 'measured';
    for (let i = 0; i < (config.kind === 'calibration' ? 3 : 4); i++) batch(category, N);
    result.readiness = readiness(result.warmup.map(b => b.ns));
    if (config.kind === 'calibration') {
      result.verificationStatistics = describe(result.verification.map(b => b.ns));
      result.qualityClear = result.clock.clear && result.readiness.clear && result.verificationStatistics.median >= 16000000 && result.verificationStatistics.median <= 40000000;
    } else {
      result.measuredReadiness = readiness(result.measured.map(b => b.ns), true);
      result.readResolution = readResolution(result.measured.map(b => b.ns), result.clock);
      result.qualityClear = result.readiness.clear && result.measuredReadiness.clear && result.readResolution.clear;
    }
    // Keep every writer/copy/reader/cache alive until the child has finished.
    check(retained.writers.length === 2 && retained.readers[0] === reader && retained.payloads[0] === payload,
      'fixture retention lost');
  }
  result.complete = true;
  result.retainedCounts = Object.fromEntries(Object.entries(retained).map(([name, values]) => [name, values.length]));
} catch (error) {
  result.error = {name:error.name, message:error.message, stack:error.stack};
  emit({event:'failure', error:result.error});
}
const outputFd = openSync(output, 'wx');
writeSync(outputFd, JSON.stringify(result, null, 2) + '\n');
fsyncSync(outputFd);
closeSync(outputFd);
closeSync(eventFd);
report({event:'complete', id:config.id, complete:result.complete, qualityClear:result.qualityClear});
if (!result.complete) process.exitCode = 1;
