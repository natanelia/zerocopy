import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { recordedMemory } from '../memory-template.mjs';
import { pages } from '../config.mjs';
test('memory tables disclose Node, units, fixed workload, and shared backing accounting',()=>{
  const html=recordedMemory('/zerocopy/');
  for(const text of ['Node.js','MiB','100,000','counted once','not measurements of this device','One native owner','RSS'])assert.ok(html.includes(text),text);
  const table=html.match(/aria-label="Recorded worker memory comparison">([\s\S]*?)<\/table>/)[1];
  assert.equal((table.match(/scope="row"/g)||[]).length,3);
  assert.equal((html.match(/data-memory-chart=/g)||[]).length,2);
  assert.ok(html.includes('/zerocopy/docs/memory-comparison/'));
});
test('both comparison pages include the recorded table and its documentation route',()=>{
  for(const name of ['comparison-template.mjs','explorer-benchmark-template.mjs']) {
    const source=readFileSync(new URL('../'+name,import.meta.url),'utf8');
    assert.ok(source.includes("import { recordedMemory } from './memory-template.mjs'"));
    assert.ok(source.includes('${recordedMemory(base)}'));
  }
  assert.ok(pages.some(page=>page.source==='docs/memory-comparison.md'&&page.slug==='memory-comparison'));
});
test('recorded figures retain identity and all four architecture values',()=>{
  const data=JSON.parse(readFileSync(new URL('../recorded-memory.json',import.meta.url),'utf8'));
  assert.equal(data.runCount,90);assert.match(data.summarySHA256,/^[a-f0-9]{64}$/);
  assert.deepEqual(data.rows.map(row=>row.fixture),['repeated','unique','unicode']);
  for(const row of data.rows)for(const kind of ['shared','immutable','native','centralized'])assert.ok(row[kind]>0);
});
