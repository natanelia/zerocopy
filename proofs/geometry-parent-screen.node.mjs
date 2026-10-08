import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, studyFor, commonPlan, validatePilot, validateMeasured, summarize, logInterval, hasControlDrift, CASES, METHODS } from './geometry-parent-screen-protocol.mjs';
const copy = value => structuredClone(value);
const cases = CASES;
const pilot = (rate = 1) => ({ phase: 'pilot', status: 'completed', expectedDigest: 'same',
  prewarm: { targetMs: 500, elapsedMs: 500, operations: 1024, capped: false },
  probes: [{ repeat: 40, samples: [40 * rate, 44 * rate, 48 * rate] }], estimateMsPerOperation: rate, flags: [] });
const measured = (plan, rate = 1) => ({ phase: 'measure', status: 'completed', expectedDigest: plan.expectedDigest,
  repeat: plan.repeat, prescribedWarmupOperations: plan.warmupOperations,
  warmup: { operations: plan.warmupOperations, elapsedMs: 500, batches: [{ repeat: plan.warmupOperations, ms: 500 }] },
  samples: Array(21).fill(plan.repeat * rate), flags: [] });
function subject(plan, rate) {
  const result = measured(plan, rate); result.warmup.batches = Array.from({ length: plan.warmupOperations / plan.repeat }, () => ({ repeat: plan.repeat, ms: 500 / (plan.warmupOperations / plan.repeat) }));
  result.warmup.elapsedMs = result.warmup.batches.reduce((sum, b) => sum + b.ms, 0); return result;
}
function row(ratio = 1, aaRatio = 1) {
  const planned = studyFor(cases).rows[0], pilots = { baseline: pilot(), candidate: pilot() }, plan = commonPlan(pilots);
  return { ...planned, pilots, plan, blocks: planned.schedule.map(block => ({ ...block, subjects: block.roles.map(role => ({
    ...subject(plan, role === 'left' ? 1 : block.mode === 'ab' ? ratio : aaRatio), role, build: block[role] })) })) };
}
test('protocol freezes40ms/500ms headroom and10ms/150ms floors with21 batches', () => {
  assert.equal(CONFIG.pilotCalibrationTargetMs, 40); assert.equal(CONFIG.batchTargetMs, 40); assert.equal(CONFIG.warmupTargetMs, 500);
  assert.equal(CONFIG.rateSafetyFactor, 1); assert.equal(CONFIG.minBatchMs, 10); assert.equal(CONFIG.minWarmupMs, 150); assert.equal(CONFIG.samples, 21);
});
test('seeded11-shape study has four balanced quartets per AB/baselineAA before pilots', () => {
  const study = studyFor(cases); assert.deepEqual(study, studyFor(cases)); assert.equal(study.measuredSubjects, 352); assert.equal(study.measuredBatches, 22176);
  for (const row of study.rows) for (const mode of ['ab', 'aa-baseline']) {
    const blocks = row.schedule.filter(b => b.mode === mode); assert.equal(blocks.length, 4);
    assert.equal(blocks.filter(b => b.roles.join('') === 'leftrightrightleft').length, 2);
    assert.equal(blocks.filter(b => b.roles.join('') === 'rightleftleftright').length, 2);
  }
});
test('common plan uses faster build, including fastest earlier post-warm sample', () => {
  const fast = pilot(0.25); fast.probes.push({ repeat: 200, samples: [50, 60, 70] });
  const plan = commonPlan({ baseline: pilot(2), candidate: fast }); assert.equal(plan.repeat, 160); assert.equal(plan.warmupOperations, 2080); assert(plan.valid);
  fast.estimateMsPerOperation = 0.26; assert.throws(() => validatePilot(fast), /fastest observed/);
});
test('pilot terminal undershoot/cap invalidates and never adds measured work', () => {
  const p = pilot(); p.probes[0].samples = [39, 40, 40]; p.estimateMsPerOperation = 39 / 40;
  const plan = commonPlan({ baseline: p, candidate: pilot() }); assert.equal(plan.valid, false); assert(plan.validityReasons.some(r => r.includes('calibration cap')));
  const tiny = pilot(0.00000001); tiny.probes.push({ repeat: 10000000, samples: [0.1, 0.2, 0.3] });
  assert.equal(commonPlan({ baseline: tiny, candidate: tiny }).valid, false);
});
test('pilot checks reject output mismatch, missing probe, bogus rate and short samples', () => {
  const wrong = pilot(); wrong.expectedDigest = 'different'; assert.throws(() => commonPlan({ baseline: pilot(), candidate: wrong }));
  const empty = pilot(); empty.probes = []; assert.throws(() => validatePilot(empty));
  const short = pilot(); short.probes[0].samples.pop(); assert.throws(() => validatePilot(short));
});
test('all21 batches and identical fixed warmup are required; floors only flag', () => {
  const plan = commonPlan({ baseline: pilot(), candidate: pilot() }), s = subject(plan, 1); assert.deepEqual(validateMeasured(s, plan), []);
  s.samples[0] = 9.99; assert(validateMeasured(s, plan).includes('batch below floor')); assert.equal(s.samples.length, 21);
  const short = copy(s); short.samples.pop(); assert.throws(() => validateMeasured(short, plan));
  const added = copy(s); added.warmup.operations++; assert.throws(() => validateMeasured(added, plan));
});
test('quartets, not pairs or batches, determine df3 Student-t intervals', () => {
  const values = [0, 0.01, 0.02, 0.03], interval = logInterval(values);
  const mean = 0.015, variance = values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / 3;
  assert.equal(interval.degreesOfFreedom, 3); assert.equal(interval.lower, Math.exp(mean - CONFIG.tCriticalDf3 * Math.sqrt(variance / 4)));
  assert.equal(logInterval(values.slice(0, 3)).lower, null); assert.throws(() => logInterval([0, 0, 0, 0, 0]));
});
test('AA drift uses point outside band plus CI excluding1, not CI outside band', () => {
  assert(hasControlDrift({ quartets: 4, geometricMean: 1.025, lower: 1.005, upper: 1.046 }));
  assert(hasControlDrift({ quartets: 4, geometricMean: 0.975, lower: 0.95, upper: 0.999 }));
  assert(!hasControlDrift({ quartets: 4, geometricMean: 1.01, lower: 1.001, upper: 1.019 }));
  assert(!hasControlDrift({ quartets: 4, geometricMean: 1.025, lower: 0.999, upper: 1.05 }));
});
test('AA drift invalidates AB without normalization; control floors invalidate row', () => {
  const r = row(0.8, 1.03), s = summarize(r); assert.equal(s.ab.interval.geometricMean, 0.8); assert.equal(s.ab.conclusion, 'control-drift-inconclusive');
  const low = row(); low.blocks.find(b => b.mode === 'aa-baseline').subjects[0].samples[0] = 9;
  assert.equal(summarize(low).ab.inferenceUsable, false);
});
test('loss, within margin and inconclusive remain distinct', () => {
  assert.equal(logInterval(Array(4).fill(Math.log(1.03))).classification, 'detected material loss');
  assert.equal(logInterval(Array(4).fill(Math.log(1.01))).classification, 'evidence within margin');
  assert.equal(logInterval([Math.log(0.9), Math.log(1.1), 0, 0]).classification, 'inconclusive');
});
import { readFileSync } from 'node:fs';
import { callableSource, requireTiming } from './geometry-parent-screen-subject.mjs';
import { assertEvent } from './geometry-parent-screen.mjs';
import { BASELINE, CANDIDATE, BRANCH, PROOF_FILES } from './geometry-parent-screen-source.mjs';
import { CHECKS, REQUIRED } from './geometry-parent-screen-prerequisites.mjs';
import { runPilot } from './geometry-parent-screen-timing.mjs';
test('only the scoped first push from reviewed runtime is authorized',()=>{
  const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'push',GITHUB_REF:BRANCH,GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'a'.repeat(40)};
  const event={before:CANDIDATE,after:env.GITHUB_SHA,ref:BRANCH,deleted:false,forced:false};assertEvent(env,event);
  for(const [key,value]of Object.entries({GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_RUN_ATTEMPT:'2',GITHUB_ACTIONS:'false'}))assert.throws(()=>assertEvent({...env,[key]:value},event));
  for(const patch of [{before:BASELINE},{after:CANDIDATE},{forced:true},{deleted:true}])assert.throws(()=>assertEvent(env,{...event,...patch}));
  assert.throws(()=>requireTiming('pilot',{}));requireTiming('verify',{});
});
test('exact original callables and sink loop are preserved',()=>{
  const source=readFileSync(new URL('./geometry-bbox.mjs',import.meta.url),'utf8');const extracted=callableSource(source);
  assert(extracted.fixture.includes('public: () => bboxXY(p)'));assert(extracted.fixture.includes("'scalar-kernel': () => call(kernel, p)"));
  assert(extracted.fixture.includes("'js-flat': () => bboxReference(values)"));
  assert(extracted.fixture.includes('turfBBox(geojson, { recompute: true })'));assert(extracted.fixture.includes('const values = kind'));
  assert.equal(extracted.timedLoop,'for (let i = 0; i < iterations; i++) sink += functions[name]()[0];');
  assert.throws(()=>callableSource(source+'\n'));
});
test('all eleven prescribed shapes retain random seed913 and full points',()=>{
  assert.deepEqual(CASES.map(c=>c.name),['random/16','random/17','random/32','random/512','random/528','random/529','random/16400','random/16401','random/131072','road/131072','late-zero/131072']);
  assert.deepEqual(METHODS,['public','scalar-kernel','js-flat']);
});
test('declarations precede package and built worker checks; original timed benchmark is never a prerequisite',()=>{
  const names=Object.keys(CHECKS);for(const name of ['worker-types','package','node-worker','worker-tasks','worker-docs'])assert(names.indexOf('build-types')<names.indexOf(name));
  assert.deepEqual(CHECKS.unit,['bun','run','test']);assert.equal(REQUIRED.length,33);
  assert(!Object.values(CHECKS).flat().includes('proofs/geometry-bbox.mjs'));assert(PROOF_FILES.every(p=>p.includes('geometry-parent-screen')||p.includes('geometry-parent-cache-screen')));
});
test('bounded pilot uses invented durations only and retains every probe',()=>{
  let clock=0;const result={flags:[]};runPilot(result,n=>{const ms=n*0.01;clock+=ms;return ms;},()=>clock);
  assert(result.prewarm.elapsedMs>=500);assert(result.prewarm.operations>=1024);assert(result.probes.at(-1).samples.every(ms=>ms>=40));
  assert.equal(result.estimateMsPerOperation,Math.min(...result.probes.flatMap(p=>p.samples.map(ms=>ms/p.repeat))));
  const failed={flags:[]};assert.throws(()=>runPilot(failed,n=>0.0000001,()=>20000),/cap/);
});
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { validateRecord } from './geometry-parent-screen.mjs';
import { SUBJECT_FILES, TOOLCHAIN, sha256 } from './geometry-parent-screen-source.mjs';
import { summarizeMethods, screenStatus, describeSamples } from './geometry-parent-screen-protocol.mjs';
test('complete synthetic396-process receipt replays; reordered, missing and altered evidence fails',()=>{
  const directory=mkdtempSync('/tmp/geometry-screen-synthetic-');
  try {
    mkdirSync(join(directory,'children'));
    const frozen={study:studyFor(CASES),proofHead:'synthetic-head',runtime:'node',arch:'x64',runId:'synthetic-run',
      proofFiles:Object.fromEntries(SUBJECT_FILES.map(name=>['proofs/'+name,'proof-'+name])),
      bundleFiles:{baseline:{'package.json':'same','geometry-kernels.wasm':'base'},candidate:{'package.json':'same','geometry-kernels.wasm':'cand'}},
      comparison:{builds:{baseline:{wasm:{'geometry-kernels.wasm':'base'}},candidate:{wasm:{'geometry-kernels.wasm':'cand'}}}}};
    writeFileSync(join(directory,'frozen.json'),JSON.stringify(frozen));
    const r={status:'completed',plansFrozenBeforeMeasurements:true,baseline:BASELINE,candidate:CANDIDATE,proofHead:frozen.proofHead,runtime:'node',arch:'x64',runId:frozen.runId,runAttempt:1,config:CONFIG,
      frozenSha256:sha256(readFileSync(join(directory,'frozen.json'))),neutral:join(directory,'neutral'),verifications:[],attempts:[],rows:frozen.study.rows.map(row=>({...row,pilots:{},plans:{},blocks:[]}))};
    function add(build,name,phase,methods={},role,offset=0) {
      const sequence=r.attempts.length,manifest={...frozen.bundleFiles[build]};for(const file of SUBJECT_FILES)manifest['proofs/'+file]=frozen.proofFiles['proofs/'+file];
      const canonical=Object.fromEntries(Object.entries(manifest).sort(([a],[b])=>a.localeCompare(b)));
      const raw={status:'completed',phase,workload:name,methods,physical:{root:r.neutral,files:canonical},runtime:{name:'node',version:TOOLCHAIN.node,arch:'x64',platform:'linux',execArgv:[]},
        before:{used:100,sha256:'untouched'},after:{used:100,sha256:'untouched'},expectedDigest:'same',actualDigest:'same',rawWasmSha256:frozen.comparison.builds[build].wasm['geometry-kernels.wasm']};
      if(phase==='measure')raw.batchOrder=Array.from({length:21},(_,i)=>(i+offset)&1?[...METHODS].reverse():[...METHODS]);
      const attempt={build,workload:name,phase,...(role?{role}:{}),status:0,signal:null,error:null,root:r.neutral,before:canonical,after:canonical};
      for(const stream of ['stdout','stderr']) {
        const path='children/'+sequence+'.'+stream;writeFileSync(join(directory,path),stream==='stdout'?JSON.stringify(raw):'');attempt[stream]={path,sha256:sha256(readFileSync(join(directory,path)))};
      }
      r.attempts.push(attempt);return {...raw,sequence,build,...(role?{role}:{}),orderOffset:offset};
    }
    for(const row of r.rows)for(const build of ['baseline','candidate'])r.verifications.push(add(build,row.workload.name,'verify'));
    for(const row of r.rows) {
      for(const build of row.pilotOrder)row.pilots[build]=add(build,row.workload.name,'pilot',Object.fromEntries(METHODS.map(m=>[m,pilot()])));
      for(const method of METHODS)row.plans[method]=commonPlan({baseline:row.pilots.baseline.methods[method],candidate:row.pilots.candidate.methods[method]});
    }
    for(const row of r.rows)for(const planned of row.schedule) {
      const block={...planned,subjects:[]};row.blocks.push(block);
      for(let slot=0;slot<4;slot++) {
        const role=planned.roles[slot],build=planned[role];
        const methods=Object.fromEntries(METHODS.map(method=>{
          const m=subject(row.plans[method],build==='candidate'?0.99:1);
          m.batches=[...m.warmup.batches.map(b=>({iterations:b.repeat,ms:b.ms,sink:123})),...m.samples.map(ms=>({iterations:m.repeat,ms,sink:123}))];
          m.consumedOperations=m.batches.length*m.repeat;m.statistics=describeSamples(m.samples,m.repeat);return [method,m];
        }));
        block.subjects.push(add(build,row.workload.name,'measure',methods,role,slot%2));
      }
    }
    for(const row of r.rows)row.summaries=summarizeMethods(row);r.screen=screenStatus(r.rows);
    writeFileSync(join(directory,'plans.json'),JSON.stringify(r.rows.map(row=>({workload:row.workload,plans:row.plans}))));r.plansSha256=sha256(readFileSync(join(directory,'plans.json')));
    validateRecord(r,frozen,directory);assert.equal(r.attempts.length,396);
    const missing=copy(r);missing.attempts.pop();assert.throws(()=>validateRecord(missing,frozen,directory));
    const swapped=copy(r);[swapped.verifications[0],swapped.verifications[1]]=[swapped.verifications[1],swapped.verifications[0]];assert.throws(()=>validateRecord(swapped,frozen,directory));
    const bad=copy(r);bad.rows[0].blocks[0].subjects[0].methods.public.statistics.meanMs=123;assert.throws(()=>validateRecord(bad,frozen,directory));
    writeFileSync(join(directory,r.attempts[0].stdout.path),'modified');assert.throws(()=>validateRecord(r,frozen,directory));
  } finally {rmSync(directory,{recursive:true,force:true});}
});
