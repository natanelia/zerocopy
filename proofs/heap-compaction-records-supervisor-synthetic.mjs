// Synthetic lifecycle probes only. No library workloads, pilots, or measurement clocks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runOwnedCommand, assertOwnedClean, processGroupMembers } from './heap-compaction-records-command.mjs';
import { evidenceWriter } from './heap-compaction-records-evidence.mjs';
const [mode, name, prefix] = process.argv.slice(2);
if (mode === '--child') {
  const receipt = JSON.parse(readFileSync(`${prefix}.command.json`, 'utf8'));
  assert.equal(receipt.protocol, 'AB'); assert.equal(receipt.block, 2); assert.equal(receipt.pair, 1); assert.equal(receipt.label, 'right');
  process.on('SIGTERM', () => {});
  const emit = evidenceWriter(`${prefix}.partial.ndjson`, receipt);
  emit('batch', { known: 'preserve-this-record', synthetic: true });
  console.log('KNOWN-STDOUT'); console.error('KNOWN-STDERR');
  if (name === 'success') { emit('complete', { synthetic: true }); process.exit(0); }
  if (name === 'nonzero') process.exit(9);
  if (name === 'descendant') {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
    emit('descendant', { pid: child.pid }); process.exit(0);
  }
  setInterval(() => {}, 1000);
} else {
  assert.equal(mode, '--case');
  const identity = { engine: typeof Bun === 'undefined' ? 'node22' : 'bun142', case: 'synthetic', build: 'baseline', mode: name === 'nonzero' ? 'gate' : 'measure', protocol: 'AB', block: 2, pair: 1, label: 'right', frozenCounts: { chunks: 1, warmChunks: 2, samples: 5 } };
  if (name === 'exhausted') {
    const r = await runOwnedCommand({ command: process.execPath, args: ['-e', "throw new Error('must not launch')"], cwd: process.cwd(), prefix, totalMs: 1500, deadline: Date.now() - 1, identity });
    assert.equal(r.pid, null); assert.equal(r.status, 'not-started-budget-or-interrupt'); console.log(JSON.stringify({ passed: true, name, receipt: r }));
  } else {
    const pending = runOwnedCommand({ command: process.execPath, args: [resolve(import.meta.filename), '--child', name, prefix], cwd: process.cwd(), prefix, totalMs: 1500, identity });
    if (name === 'abrupt') {
      const poll = setInterval(() => { if (existsSync(`${prefix}.partial.ndjson`)) { clearInterval(poll); process.exit(7); } }, 5);
    }
    const result = await pending;
    assertOwnedClean();
    assert.equal(processGroupMembers(result.group).filter(p => !['Z', 'X'].includes(p.state)).length, 0);
    const receipt = JSON.parse(readFileSync(`${prefix}.command.json`, 'utf8'));
    for (const key of ['engine', 'case', 'build', 'mode', 'protocol', 'block', 'pair', 'label', 'frozenCounts']) assert.deepEqual(receipt[key], identity[key]);
    assert(readFileSync(`${prefix}.stdout.log`, 'utf8').includes('KNOWN-STDOUT'));
    assert(readFileSync(`${prefix}.stderr.log`, 'utf8').includes('KNOWN-STDERR'));
    assert(readFileSync(`${prefix}.partial.ndjson`, 'utf8').includes('preserve-this-record'));
    if (name === 'success' || name === 'descendant') assert(result.complete);
    if (name === 'nonzero') { assert.equal(result.exitCode, 9); assert.equal(result.complete, false); }
    if (name === 'cap') { assert(result.timedOut); assert(result.killSent); assert.equal(result.status, 'cap-invalid'); }
    if (name === 'interrupt') { assert.equal(result.interrupted, 'SIGTERM'); assert.equal(result.status, 'interrupted'); }
    writeFileSync(`${prefix}.assertions.json`, JSON.stringify({ passed: true, name, result }, null, 2));
    console.log(JSON.stringify({ passed: true, name, status: result.status }));
  }
}
