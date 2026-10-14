// No execution is authorized by this file. The released controller owns launches.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CASES, subject, fixture, batch } from './draft-workload.mjs';

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
try {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  assert.equal(config.protocol, 'set-insert-screen-v1');
  const engine = typeof Bun === 'undefined' ? 'node' : 'bun';
  const version = engine === 'bun' ? Bun.version : process.version.slice(1);
  assert.equal(engine, config.engine);
  assert.equal(version, engine === 'node' ? '22.16.0' : '1.4.2');
  emit({ event: 'started', engine, version, flags: process.execArgv,
    mode: config.mode, case: config.case, variant: config.variant });
  if (config.mode === 'smoke') {
    // Four finite smoke children cover all cells once. Timing values are discarded.
    const startup = await subject(config.sharedURL, 'startup', 0, 1);
    const z = await import(config.sharedURL);
    z.configureMemory({ maximumBytes: 64 * 1024 * 1024 });
    const cells = [{ case: 'startup', checksum: startup.checksum }];
    for (const c of CASES.filter(c => c.kind !== 'startup')) {
      const f = fixture(c), row = batch(z, c, f);
      const { elapsedMs, wallMs, ...evidence } = row;
      cells.push({ case: c.id, fixture: f.evidence, ...evidence });
    }
    emit({ event: 'smoke-result', validationOnly: true, cells });
  } else {
    assert.ok(['calibration', 'measurement'].includes(config.mode));
    const value = await subject(config.sharedURL, config.case, config.warmCount, config.measureCount);
    emit({ event: 'result', value });
  }
  emit({ event: 'done' });
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  emit({ event: 'fatal', error: String(error) });
  process.exitCode = 1;
}
