import { appendFileSync, mkdirSync, openSync, closeSync, readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { atomicJSON } from './heap-compaction-records-command.mjs';
export function evidenceWriter(path, identity = {}) {
  if (!path) return () => {};
  mkdirSync(dirname(path), { recursive: true }); closeSync(openSync(path, 'wx'));
  let sequence = 0;
  return (type, value = {}) => {
    const record = { sequence: ++sequence, type, ...value };
    appendFileSync(path, JSON.stringify(record) + '\n');
    atomicJSON(`${path}.state.json`, { identity, lastSequence: sequence, lastType: type,
      status: type === 'complete' ? 'complete' : type === 'failed' ? 'failed' : 'incomplete', lastRecord: record });
  };
}

export function saveFocusedReceipt(source, directory, engine) {
  assert(['node22', 'bun142'].includes(engine));
  const data = JSON.parse(readFileSync(source, 'utf8'));
  assert.equal(data.runtime, engine === 'node22' ? 'v22.23.3' : 'Bun 1.4.2');
  assert.equal(data.passed, true);
  const target = join(directory, `focused-${engine}.json`);
  assert(!existsSync(target), 'Refuse to overwrite an engine-specific focused receipt');
  atomicJSON(target, data); return target;
}
