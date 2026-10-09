import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const base = 'ad2a19d65a836985a2364b181bc9bd8dce6e42ad';
assert.equal(execFileSync('git', ['merge-base', base, 'HEAD'], { encoding: 'utf8' }).trim(), base);
const baseline = execFileSync('git', ['show', `${base}:compaction.ts`], { encoding: 'utf8' });
const candidate = readFileSync('compaction.ts', 'utf8');
const old = '      if (!ready) { todo.push([old, true], [right, false], [left, false]); continue; }';
const next = `      if (!ready) {
        todo.push([old, true]);
        if (right) todo.push([right, false]);
        if (left) todo.push([left, false]);
        continue;
      }`;
assert.equal(candidate, baseline.replace(old, next), 'Only the preselected child-push edit is permitted');
mkdirSync('.proof-tools/heap-compaction-records', { recursive: true });
const hash = text => createHash('sha256').update(text).digest('hex');
function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length, 2, `Unique injection anchor: ${from}`);
  return source.replace(from, to);
}
function instrument(source, arm) {
  let s = source.replaceAll("from './", "from '../../");
  s += `\nexport { Compactor };\nexport const counts = { heapCalls: 0, stackArrays: 0, tupleExpressions: 0, pops: 0, zeroPops: 0, heapKeys: 0, expanded: 0, pushCalls: 0, childGuards: 0 };\nexport function resetCounts() { for (const key of Object.keys(counts)) counts[key] = 0; }\n`;
  s = replaceOnce(s, 'private key(a: Arena, kind: string, p: number): string { return', "private key(a: Arena, kind: string, p: number): string { if (kind.startsWith('heap/')) counts.heapKeys++; return");
  s = replaceOnce(s, 'private heap(a: Arena, type: string, root: number): number {', 'private heap(a: Arena, type: string, root: number): number { counts.heapCalls++;');
  s = replaceOnce(s, 'const todo: [number, boolean][] = [[root, false]];', 'counts.stackArrays++; counts.tupleExpressions++; const todo: [number, boolean][] = [[root, false]];');
  s = replaceOnce(s, 'const [old, ready] = todo.pop()!, key =', 'counts.pops++; const [old, ready] = todo.pop()!; if (!old) counts.zeroPops++; const key =');
  if (arm === 'baseline') {
    s = replaceOnce(s, old, '      if (!ready) { counts.expanded++; counts.pushCalls++; counts.tupleExpressions += 3; todo.push([old, true], [right, false], [left, false]); continue; }');
  } else {
    s = replaceOnce(s, next, `      if (!ready) {
        counts.expanded++; counts.pushCalls++; counts.tupleExpressions++; counts.childGuards += 2;
        todo.push([old, true]);
        if (right) { counts.pushCalls++; counts.tupleExpressions++; todo.push([right, false]); }
        if (left) { counts.pushCalls++; counts.tupleExpressions++; todo.push([left, false]); }
        continue;
      }`);
  }
  writeFileSync(`.proof-tools/heap-compaction-records/${arm}.ts`, s);
  return hash(s);
}
const pins = { base, baselineSourceSha256: hash(baseline), candidateSourceSha256: hash(candidate), baselineInstrumentedSha256: instrument(baseline, 'baseline'), candidateInstrumentedSha256: instrument(candidate, 'candidate') };
writeFileSync('.proof-tools/heap-compaction-records/source-pins.json', JSON.stringify(pins, null, 2) + '\n');
console.log(JSON.stringify(pins));
