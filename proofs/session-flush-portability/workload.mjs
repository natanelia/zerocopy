// Portable public workload. No Node API, private instrumentation, peers or listeners.
const check = (condition, message) => { if (!condition) throw new Error(message); };
export async function runWorkload({ sharedURL, workerURL, item, protocol, identity, counts, emit, now }) {
  const { SharedMap } = await import(sharedURL);
  const { createSharedState } = await import(workerURL);
  const maps = [new SharedMap('number').set('n', 0)];
  maps.push(maps[0].set('n', 1));
  const keys = Array.from({ length: item.names }, (_, i) => 'lane' + String(i).padStart(3, '0'));
  const records = item.names ? [0, 1].map(bit => Object.freeze(Object.fromEntries(
    keys.map((key, i) => [key, maps[i === keys.length - 1 ? bit : 0]])))) : null;
  const inputs = records || maps, errors = [];
  const session = createSharedState(inputs[0], { copy: false, onError: error => errors.push(String(error)) });
  await session.ready;
  let expectedVersion = 0, active = 0, originalPublished = session.current;
  if (item.name === 'reverted-one') {
    check(session.publish(inputs[1]) === 1, 'setup publish'); expectedVersion = 1; active = 1;
    originalPublished = session.current;
    session.update(() => inputs[0]); session.update(() => inputs[1]);
    check(session.current !== originalPublished && session.current[keys[0]] === originalPublished[keys[0]], 'distinct equal fixture');
    check(session.flush() === 1, 'fallback setup');
    await Promise.resolve(); await Promise.resolve();
  }
  const retainedInitial = inputs[0];
  const fixture = { names: keys, initialValues: [0, 1], changedName: keys.at(-1) || null,
    publishesPerCycle: item.publishesPerCycle, flushesPerCycle: item.flushesPerCycle,
    operationsPerCycle: 32, setupVersion: expectedVersion, changedThenReverted: item.name === 'reverted-one' };
  // Hashing is adapter-side, outside every timed interval.
  const fixtureSHA256 = await emit({ event: 'fixture', fixture });
  function validateState() {
    check(session.version === expectedVersion, 'version');
    if (item.names) {
      check(Object.isFrozen(session.current), 'frozen record');
      check(JSON.stringify(Object.keys(session.current)) === JSON.stringify(keys), 'names');
      for (let i = 0; i < keys.length; i++) {
        check(session.current[keys[i]] === maps[i === keys.length - 1 ? active : 0], 'current alias');
        check(retainedInitial[keys[i]] === maps[0], 'retained alias');
      }
    } else check(session.current === maps[active] && retainedInitial === maps[0], 'single alias');
    check(maps[0].get('n') === 0 && maps[1].get('n') === 1, 'retained values');
    if (item.name === 'reverted-one') check(session.current !== originalPublished, 'fallback remains distinct');
    check(errors.length === 0, 'reported errors');
  }
  function mixed(cycles) {
    let checksum = 0;
    for (let c = 0; c < cycles; c++) {
      active ^= 1; checksum = (checksum + session.publish(inputs[active])) >>> 0;
      for (let f = 0; f < 31; f++) checksum = (checksum + session.flush()) >>> 0;
    }
    return checksum;
  }
  function changed(cycles) {
    let checksum = 0;
    for (let c = 0; c < cycles; c++) for (let op = 0; op < 32; op++) {
      active ^= 1; checksum = (checksum + session.publish(inputs[active])) >>> 0;
    }
    return checksum;
  }
  function fallback(cycles) {
    let checksum = 0;
    for (let op = 0; op < cycles * 32; op++) checksum = (checksum + session.flush()) >>> 0;
    return checksum;
  }
  const perform = item.name.startsWith('mixed-') ? mixed : item.name === 'changed-single' ? changed : fallback;
  const batches = [];
  async function batch(phase, index, cycles) {
    check(Number.isInteger(cycles) && cycles > 0 && cycles <= item.maxCycles, 'cycles');
    validateState();
    const versionBefore = expectedVersion;
    await emit({ event: 'batch-start', ...identity, phase, index, cycles, operations: cycles * 32, versionBefore });
    const start = now();
    const checksum = perform(cycles);
    const ns = now() - start;
    const operations = cycles * 32, publications = cycles * item.publishesPerCycle;
    expectedVersion += publications;
    const count = BigInt(publications), before = BigInt(versionBefore);
    const expectedChecksum = Number((publications ?
      (count * before + count * (count + 1n) / 2n) * BigInt(item.name.startsWith('mixed-') ? 32 : 1) :
      BigInt(operations) * before) & 0xffffffffn);
    const row = { event: 'batch', ...identity, phase, index, cycles, operations, publications,
      explicitFlushes: cycles * item.flushesPerCycle, ns, nsPerOperation: ns / operations, nsPerCycle: ns / cycles,
      versionBefore, versionAfter: expectedVersion, checksum, expectedChecksum,
      belowFloor: ns < protocol.floorNs, overTimeCap: ns > protocol.batchCeilingNs, fixtureSHA256 };
    batches.push(row); await emit(row); // Completed duration survives subsequent validation failure.
    validateState(); check(checksum === expectedChecksum, 'returned-version checksum');
    await emit({ event: 'validation', phase, index, cycles, version: expectedVersion, checksum,
      expectedChecksum, passed: true, aliases: true, retainedSnapshots: true, errors: [] });
    check(Number.isFinite(ns) && ns > 0 && !row.overTimeCap, 'batch time cap');
    return row;
  }
  let cycles, capped = false, capReason = null;
  try {
    if (identity.mode === 'calibrate') {
      for (let i = 0; i < protocol.calibrationSeedWarmups; i++) await batch('seed-warmup', i, protocol.seedCycles);
      cycles = protocol.seedCycles;
      for (let i = 0; i < protocol.maxPilots; i++) {
        const row = await batch('pilot', i, cycles);
        if (row.ns >= protocol.targetNs) break;
        if (cycles === item.maxCycles || i + 1 === protocol.maxPilots) {
          capped = true; capReason = cycles === item.maxCycles ? 'count' : 'pilot-count'; break;
        }
        cycles = Math.min(item.maxCycles, Math.ceil(cycles * Math.min(protocol.growthMax,
          Math.max(protocol.growthMin, protocol.growthHeadroom * protocol.targetNs / row.ns))));
      }
    } else {
      check(counts && counts.cycles[identity.arm], 'frozen counts required');
      cycles = counts.cycles[identity.arm];
      ({ capped, capReason } = counts.calibrations[identity.arm]);
      for (let i = 0; i < protocol.warmups; i++) await batch('warmup', i, cycles);
      for (let i = 0; i < protocol.samples; i++) await batch('measure', i, cycles);
    }
    validateState();
  } finally {
    session.dispose(); await Promise.resolve(); await Promise.resolve();
    await emit({ event: 'dispose', closed: session.closed, errors });
  }
  check(session.closed && errors.length === 0, 'ordinary disposal');
  return { cycles, capped, capReason, fixture, fixtureSHA256, batches, disposed: true, passed: true,
    operationsPerBatch: cycles * 32 };
}
