import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseline = resolve(process.argv[2] || '');
const candidate = resolve(process.argv[3] || '');
if (!baseline || !candidate || baseline === candidate) throw new Error('Pass distinct baseline and candidate directories');
const script = resolve(fileURLToPath(import.meta.url), '../case.mjs');
const cases = ['number-256', 'number-32768', 'boolean-256', 'boolean-32768', 'string-4096', 'object-2048'];
const runtimes = ['node', 'bun'];
const PAIRS = 6;
const criticalT = 2.571; // Student's t, 5 df, two-sided 95%
const results = { baseCommit: 'a4265a0608ec25eec5719496225212db6b251989',
  baseline, candidate, runner: process.platform + '-' + process.arch,
  pairs: PAIRS, cases: [], identicalControls: [] };
function run(which, runtime, workload) {
  const cwd = which === 'baseline' ? baseline : candidate;
  const proc = spawnSync(runtime, [script, workload], {
    cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
    env: { ...process.env, NODE_ENV: 'production' },
  });
  if (proc.error || proc.status !== 0) throw new Error(JSON.stringify({
    which, runtime, workload, status: proc.status, error: String(proc.error ?? ''),
    stdout: proc.stdout?.slice(-1600), stderr: proc.stderr?.slice(-1800),
  }));
  const parsed = JSON.parse(proc.stdout.trim().split('\n').at(-1));
  if (parsed.runtime !== runtime || parsed.case !== workload || parsed.samplesUs.length !== 9 ||
      parsed.samplesUs.some(x => !Number.isFinite(x) || x <= 0)) throw new Error('Bad benchmark record');
  return parsed;
}
function stats(pairs) {
  const logs = pairs.map(p => Math.log(p.after.estimateUs / p.before.estimateUs));
  const mean = logs.reduce((a,b)=>a+b,0)/logs.length;
  const s = Math.sqrt(logs.reduce((a,b)=>a+(b-mean)**2,0)/(logs.length-1));
  const half = criticalT*s/Math.sqrt(logs.length);
  const med = x => [...x].sort((a,b)=>a-b)[Math.floor(x.length/2)];
  return {
    beforeMedianUs: med(pairs.map(p=>p.before.estimateUs)),
    afterMedianUs: med(pairs.map(p=>p.after.estimateUs)),
    geometricRatio: Math.exp(mean), confidence95: [Math.exp(mean-half),Math.exp(mean+half)],
    fasterPairs: logs.filter(x=>x<0).length,
  };
}
for (const runtime of runtimes) for (const workload of cases) {
  const pairs = [];
  for (let n=0;n<PAIRS;n++) {
    const names = n%2 ? ['candidate','baseline'] : ['baseline','candidate'];
    const records = {};
    for (const which of names) records[which] = run(which, runtime, workload);
    if (records.baseline.checksum !== records.candidate.checksum ||
        records.baseline.size !== records.candidate.size ||
        records.baseline.sourceSha256 === records.candidate.sourceSha256)
      throw new Error('Baseline/candidate not independently built or return different output');
    pairs.push({before: records.baseline,after: records.candidate});
  }
  const record = {runtime,workload,stats:stats(pairs),pairs};
  results.cases.push(record);
  const s = record.stats;
  console.log([runtime,workload,s.beforeMedianUs.toFixed(2)+'us',s.afterMedianUs.toFixed(2)+'us',
    (100*(1-s.geometricRatio)).toFixed(1)+'% less time',
    'ratio CI '+s.confidence95.map(x=>x.toFixed(3)).join('..'),
    s.fasterPairs+'/'+PAIRS+' faster'].join(' | '));
}
// Same-build repeatability controls are never subtracted from A/B.
for (const runtime of runtimes) for (const workload of ['number-32768','string-4096']) {
  const pairs = [];
  for (let n=0;n<PAIRS;n++) {
    const before = run('candidate',runtime,workload);
    const after = run('candidate',runtime,workload);
    if (before.sourceSha256 !== after.sourceSha256 || before.checksum !== after.checksum)
      throw new Error('Invalid same-build control');
    pairs.push({before,after});
  }
  const record={runtime,workload,stats:stats(pairs),pairs};
  results.identicalControls.push(record);
  console.log(['A/A',runtime,workload, 'ratio='+record.stats.geometricRatio.toFixed(3),
     'CI='+record.stats.confidence95.map(x=>x.toFixed(3)).join('..')].join(' | '));
}
writeFileSync('proofs/list-foreach-fastpath-20261109/results.json', JSON.stringify(results,null,2)+'\n');
console.log('Saved '+results.cases.length+' A/B workload records, '+results.identicalControls.length+' A/A controls.');
