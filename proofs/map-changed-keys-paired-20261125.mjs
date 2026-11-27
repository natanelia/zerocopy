import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox } from 'playwright';

const [checkout, candidateCheckout, output, rounds = '11'] = process.argv.slice(2);
assert(checkout && candidateCheckout && output && Number.isInteger(+rounds) && +rounds > 0);
const root = resolve(checkout);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const identity = JSON.parse(readFileSync(join(root, 'website/_site/build.json'), 'utf8'));
assert.equal(identity.sourceCommit, commit);
assert.equal(identity.sourceDirty, false);
const candidateRoot = resolve(candidateCheckout);
const candidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidateRoot, encoding: 'utf8' }).trim();
const candidateIdentity = JSON.parse(readFileSync(join(candidateRoot, 'website/_site/build.json'), 'utf8'));
assert.equal(candidateIdentity.sourceCommit, candidateCommit);
assert.equal(candidateIdentity.sourceDirty, false);
assert.notEqual(candidateCommit, commit);
assert.deepEqual(candidateIdentity.dependencies, identity.dependencies);
const report = { complete: false, commit, identity, candidateCommit, candidateIdentity, driverSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'), cases: [], samples: [], engines: {} };
const save = () => writeFileSync(resolve(output), JSON.stringify(report, null, 2));
const { createPreview } = await import(pathToFileURL(join(root, 'website/serve.mjs')).href);
const server = createPreview();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + server.address().port + '/investigation-benchmark/';
const { createPreview: createCandidatePreview } = await import(pathToFileURL(join(candidateRoot, 'website/serve.mjs')).href);
const candidateServer = createCandidatePreview();
await new Promise(r => candidateServer.listen(0, '127.0.0.1', r));
const candidateURL = 'http://127.0.0.1:' + candidateServer.address().port + '/investigation-benchmark/';


/** Sequential notifications, retaining reader state, never equating addresses across arenas. */
function reader() {
  let prior, index, issues, revision = -1, api, first, firstSignature;
  const endpoints = v => [v.start, v.end];
  const add = (key, v) => { for (const point of new Set(endpoints(v))) { let set = index.get(point); if (!set) index.set(point, set = new Set()); set.add(key); } };
  const remove = (key, v) => { for (const point of new Set(endpoints(v))) { const set = index.get(point); if (!set?.delete(key)) throw Error('Missing index entry'); if (!set.size) index.delete(point); } };
  function validate(key, map) {
    issues.delete(key + ':start'); issues.delete(key + ':end');
    const v = map.get(key); if (!v) return;
    for (const side of ['start', 'end']) if ((index.get(v[side])?.size ?? 0) < 2) issues.add(key + ':' + side);
  }
  function signature(map, key) { return JSON.stringify(map.get(key)); }
  self.onmessage = async ({ data }) => {
    try {
      if (data.revision !== revision + 1) throw Error('Out of order revision');
      api ??= await import(data.apiURL);
      const start = performance.now();
      const current = await api.initWorker(data.payload, prior ? { previous: { after: prior } } : undefined);
      const { before, after } = current;
      const attachMs = performance.now() - start;
      if (!after.arena.readOnly || !(after.arena.memory.buffer instanceof SharedArrayBuffer)) throw Error('Expected shared reader');
      if (!prior) {
        if (before) throw Error('Unexpected initial before');
        const initial = performance.now();
        index = new Map(); issues = new Set();
        for (const [key, value] of after.entries()) add(key, value);
        for (const [key] of after.entries()) validate(key, after);
        prior = first = after; firstSignature = signature(first, data.probe);
        revision = data.revision;
        self.postMessage({ attachMs, initialMs: performance.now() - initial, issues: [...issues].sort(), size: after.size });
        return;
      }
      if (!before || before.root !== prior.root || before.size !== prior.size || before.arena.id !== prior.arena.id) throw Error('Stream predecessor mismatch');
      // Arena wrappers are recreated on each initWorker; compare only roots
      // co-published in this exact attachment, not prior.memory.buffer identity.
      const a = before.arena, view = a.dv;
      const safe = a === after.arena && a.readOnly && a.memory.buffer instanceof SharedArrayBuffer;
      let changed = new Set();
      let visited = 0, enumerated = 0, skipped = 0;
      function scan(left, right) {
        // Strong baseline: scan addresses, not decoded JSON. Also handles
        // non-branch shape mismatches, collision buckets and journal roots.
        const old = new Set();
        for (const p of a.leaves(left)) { old.add(p); enumerated++; }
        for (const p of a.leaves(right)) {
          enumerated++;
          if (!old.delete(p)) changed.add(a.leafKey(p, view));
        }
        for (const p of old) changed.add(a.leafKey(p, view));
      }
      const detectStart = performance.now();
      if (data.mode === 'producer') {
        for (const key of data.keys) changed.add(key);
      } else if (data.mode === 'tree') {
        if (typeof after.changedKeysSince !== 'function') throw Error('Candidate method missing');
        changed = after.changedKeysSince(before);
      } else if (!safe) {
        // Compaction/unrelated arenas: conservatively invalidate all keys.
        for (const [key] of before.entries()) changed.add(key);
        for (const [key] of after.entries()) changed.add(key);
      } else if (data.mode === 'scan') scan(before.root, after.root);
      else throw Error('Unknown mode');
      const detectMs = performance.now() - detectStart;
      const expandStart = performance.now();
      const affected = new Set(changed), points = new Set(), edits = [];
      for (const key of changed) {
        const prev = before.get(key), next = after.get(key);
        if (prev) for (const p of endpoints(prev)) points.add(p);
        if (next) for (const p of endpoints(next)) points.add(p);
        edits.push([key, prev, next]);
      }
      // Collect old neighbors BEFORE mutating the index; collect new after.
      for (const p of points) for (const key of index.get(p) ?? []) affected.add(key);
      for (const [key, prev] of edits) if (prev) remove(key, prev);
      for (const [key, , next] of edits) if (next) add(key, next);
      for (const p of points) for (const key of index.get(p) ?? []) affected.add(key);
      const expandMs = performance.now() - expandStart;
      const validationStart = performance.now();
      for (const key of affected) validate(key, after);
      const validationMs = performance.now() - validationStart;
      const totalMs = performance.now() - detectStart;
      if (signature(first, data.probe) !== firstSignature) throw Error('Retained initial snapshot changed');
      const sameRootAcrossMessages = prior.root === before.root;
      const sameWrapperAcrossMessages = prior.arena === before.arena;
      const sameBufferAcrossMessages = prior.arena.memory.buffer === before.arena.memory.buffer;
      prior = after; revision = data.revision;
      self.postMessage({ attachMs, detectMs, expandMs, validationMs, totalMs, keys: [...changed].sort(), issues: [...issues].sort(), affected: affected.size,
        visited, enumerated, skipped, fallback: !safe && data.mode !== 'producer', sameRootAcrossMessages, sameWrapperAcrossMessages, sameBufferAcrossMessages, size: after.size });
    } catch(error) { self.postMessage({ error: String(error.stack || error) }); }
  };
}
const cases = [
  { count: 1000, edits: 10, kind: 'edges' },
  { count: 10000, edits: 100, kind: 'sparse' },
  { count: 100000, edits: 100, kind: 'sparse' },
  { count: 100000, edits: 1000, kind: 'churn' },
  { count: 10000, edits: 5000, kind: 'dense' },
  { count: 100000, edits: 10000, kind: 'medium' }
];
async function prepare(page, c, url) {
  await page.goto(url); assert(await page.evaluate(() => crossOriginIsolated));
  return page.evaluate(async ({c, source}) => {
    const apiURL = new URL('./library/shared.js', location.href).href;
    const api = await import(apiURL), mid = c.count / 2;
    const id = i => (i < mid ? 'west/' : 'east/') + i;
    const v = i => ({ start: i, end: i + 1, tile: i < mid ? 'west' : 'east', geometry: [[i, 0], [i+1, 0]], revision: 0 });
    const native = new Map(Array.from({length:c.count}, (_,i) => [id(i),v(i)]));
    // Deliberate FNV-1a collision, verify the actual hash.
    function hash(s) { let h=2166136261; for(const x of new TextEncoder().encode(s)) h=Math.imul(h^x,16777619); return h>>>0; }
    if (hash('costarring') !== hash('liquid')) throw Error('Collision fixture mismatch');
    native.set('costarring', {start:-3,end:-2}); native.set('liquid',{start:-2,end:-1});
    // Oracle independent of incremental index: count endpoints across full map.
    function oracle() {
      const counts = new Map();
      for (const row of native.values()) for(const p of new Set([row.start,row.end])) counts.set(p,(counts.get(p)||0)+1);
      const result = [];
      for (const [key,row] of native) for(const side of ['start','end']) if(counts.get(row[side])<2) result.push(key+':'+side);
      return result.sort();
    }
    let map = new api.SharedMap('object').setMany([...native]);
    const probe = id(mid-1);
    const pack = (before, after) => api.getWorkerData(before ? {before,after} : {after}, {copy:false});
    const revisions = [{payload:pack(null,map),issues:oracle(),size:map.size,keys:[],required:[],fallback:false}];
    function commit(writes, deletes=[], replacement) {
      const before=map, keys=new Set([...writes.map(([k])=>k),...deletes]), required=[];
      const previous = new Map([...keys].map(k=>[k,JSON.stringify(native.get(k))]));
      for(const k of deletes) native.delete(k);
      for(const [k,row] of writes) native.set(k,row);
      for(const k of keys) if(previous.get(k)!==JSON.stringify(native.get(k))) required.push(k);
      map = replacement ? replacement(before) : before.deleteMany(deletes).setMany(writes);
      if(map.size!==native.size) throw Error('Size mismatch');
      let n=0; for(const [k,row] of map.entries()) { if(JSON.stringify(row)!==JSON.stringify(native.get(k))) throw Error('Content mismatch '+k); n++; }
      if(n!==native.size) throw Error('Traversal mismatch');
      const payload=pack(before,map);
      if(payload.arenas.some(a=>a.copy||!(a.memory.buffer instanceof SharedArrayBuffer))) throw Error('Not shared');
      revisions.push({payload,issues:oracle(),size:map.size,keys:[...keys].sort(),required:required.sort(),fallback:before.arena!==map.arena});
    }
    // Move west boundary endpoint off the old east neighbor and onto a new
    // neighbor. Neither east lane is modified. Exact issue IDs must change.
    const boundary = native.get(probe);
    const oldIssue = revisions[0].issues;
    commit([[probe,{...boundary,end:mid+1,geometry:[[mid-1,0],[mid+1,0]],revision:1}]]);
    const oldNeighbor=id(mid)+':start';
    if(oldIssue.includes(oldNeighbor)||!revisions[1].issues.includes(oldNeighbor)||revisions[1].keys.includes(id(mid))) throw Error('Old dependency fixture');
    // Second movement creates a new match for the now isolated old neighbor.
    commit([[probe,{...boundary,end:mid,revision:2}]]);
    if(revisions[2].issues.includes(oldNeighbor)) throw Error('New dependency fixture');
    // Keep both collision keys and exercise replacement/delete/Unicode.
    commit([['costarring',{start:-4,end:-2}],['新增/車道',{start:-2,end:-1}]],['liquid']);
    // Same-value write: structural diff is allowed to return conservative keys.
    commit([[probe,native.get(probe)]]);
    for(let rev=0;rev<2;rev++){
      const writes=[], deletes=[];
      for(let i=0;i<c.edits;i++){
        // Unique for all counts; skip the fixture boundary.
        const j=(i*7919+rev*31)%c.count, key=id(j);
        if(key===probe) continue;
        if(c.kind==='churn'&&i%2===0){deletes.push(key);writes.push(['tile/new/'+rev+'/'+i,{...v(j),end:j+2,revision:rev+3}]);}
        else if(native.has(key))writes.push([key,{...native.get(key),end:j+2+rev,revision:rev+3}]);
      }
      commit(writes,deletes);
    }
    // Identity and compaction, then a logically equivalent unrelated arena.
    commit([]);
    if(c.kind==='edges'){
      commit([],[],m=>api.compact(m));
      commit([],[],()=>new api.SharedMap('object').setMany([...native]));
      if(!revisions.at(-2).fallback) throw Error('Compaction must fall back');
      // defaultArena may be shared with another owner; require explicit fresh
      // compaction if the last map landed in the same arena.
    }
    const workerURL=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
    globalThis.__seq={workerURL,apiURL,probe,revisions};
    return revisions.map(({payload,...rest})=>({...rest,arenaCount:payload.arenas.length,arenaBytes:payload.arenas.reduce((s,a)=>s+a.used,0)}));
  },{c,source:'('+reader.toString()+')();'});
}
async function sample(page, mode, expected) {
  const data=await page.evaluate(async mode=>{
    const p=globalThis.__seq;
    const workers=Array.from({length:2},()=>new Worker(p.workerURL,{type:'module'}));
    try {
      const rows=[];
      for(let i=0;i<p.revisions.length;i++){
        const rev=p.revisions[i], start=performance.now();
        const readers=await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{
          w.onmessage=e=>e.data.error?reject(Error(e.data.error)):resolve(e.data);
          w.onerror=e=>reject(Error(e.message));
          w.postMessage({revision:i,mode,payload:rev.payload,apiURL:p.apiURL,probe:p.probe,...(mode==='producer'?{keys:rev.keys}:{})});
        })));
        rows.push({roundTripMs:performance.now()-start,readers});
      }
      return rows;
    }finally{workers.forEach(w=>w.terminate());}
  },mode);
  assert.equal(data.length,expected.length);
  for(let i=0;i<data.length;i++)for(const row of data[i].readers){
    const e=expected[i];
    assert.deepEqual(row.issues,e.issues);assert.equal(row.size,e.size);
    if(i){
      assert.equal(row.fallback,e.fallback&&mode!=='producer');
      assert(row.sameRootAcrossMessages);
      const keys=new Set(row.keys);
      for(const key of e.required)assert(keys.has(key),'missed '+key);
      if(!row.fallback) { const allowed=new Set(e.keys); for(const key of keys)assert(allowed.has(key),'unexpected '+key); }
      for(const m of ['attachMs','detectMs','expandMs','validationMs','totalMs'])assert(Number.isFinite(row[m])&&row[m]>=0);
      row.keyHash=createHash('sha256').update(JSON.stringify(row.keys)).digest('hex');row.keyCount=row.keys.length;delete row.keys;
    }
    row.issueHash=createHash('sha256').update(JSON.stringify(row.issues)).digest('hex');row.issueCount=row.issues.length;delete row.issues;
  }
  return data;
}
try {
  for(const [engine,launcher] of Object.entries({chromium,firefox})){
    const browser=await launcher.launch();report.engines[engine]=browser.version();
    try{
      for(const c of cases){
        const page=await browser.newPage(), candidatePage=await browser.newPage();
        try{
          const expected=await prepare(page,c,url), candidateExpected=await prepare(candidatePage,c,candidateURL),id=engine+'/'+c.count+'/'+c.kind;
          assert.deepEqual(candidateExpected,expected);
          report.cases.push({id,...c,expected});save();
          for(const mode of ['scan','tree','producer'])await sample(mode==='tree'?candidatePage:page,mode,expected);
          for(let pair=0;pair<+rounds;pair++){
            const groups=pair%2?['producer','ab','aa']:['aa','ab','producer'];
            for(const group of groups){
              const modes=group==='aa'?['scan','scan']:group==='ab'?['scan','tree']:['scan','producer'];
              if(pair%2)modes.reverse();
              for(let order=0;order<2;order++){
                const mode=modes[order],revisions=await sample(mode==='tree'?candidatePage:page,mode,expected);
                report.samples.push({id,group,pair,order,mode,revisions});save();
              }
            }
          }
          console.log(id+': verified sequential reader issue sets');
        }finally{await page.close();await candidatePage.close();}
      }
    }finally{await browser.close();}
  }
  report.complete=true;
}finally{save();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>candidateServer.close(r))]);}
