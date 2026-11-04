import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const median = a => [...a].sort((a,b)=>a-b)[a.length >> 1];
if (process.argv[2] === '--subject') {
  const [entry, type, method, n0] = process.argv.slice(3);
  const n = +n0, api = await import(entry);
  const values = Array.from({length:n},(_,i)=>type==='number'? (i % 8191)+0.25 : type==='boolean'?i%3===0:type==='string'?`row-${i}`:{id:i});
  const list = new api.SharedList(type).pushMany(values);
  assert.deepEqual(list.toArray(), values);
  const get = value => type==='number'?value:type==='boolean'?+value:type==='string'?value.length:value.id;
  const reference = values.reduce((s,v)=>s+get(v),0);
  let check = 0;
  function operation() {
    if (method === 'forEach') { let sum=0;list.forEach(v=>sum+=get(v)); return sum; }
    const result=list.toArray(); return get(result[0])+get(result[n>>>1])+get(result[n-1]);
  }
  const expected=method==='forEach'?reference:get(values[0])+get(values[n>>>1])+get(values[n-1]);
  let reps=Math.max(1,Math.ceil(250000/n));
  const sample=()=>{let sum=0;const start=performance.now();for(let i=0;i<reps;i++)sum+=operation();const ms=performance.now()-start;assert.equal(sum,expected*reps);check+=sum;return ms;};
  let until=performance.now()+80;while(performance.now()<until)sample();
  const samples=Array.from({length:9},sample);
  assert.deepEqual(list.toArray(),values);
  console.log(JSON.stringify({runtime:process.versions,node:process.version,type,method,n,reps,samples,ms:median(samples)/reps,check}));
} else {
  const base='/workspace/scratch/83f1d4baba1f/zerocopy/dist/shared.js', candidate='/workspace/scratch/83f1d4baba1f/zerocopy-list/dist/shared.js';
  const rows=[];
  for(const type of ['number','boolean','string','object'])for(const method of ['forEach','toArray'])for(const n of (type==='number'||type==='boolean'?[1024,65536]:[1024])){
    const row={type,method,n,subjects:[]};
    for(const variant of ['base','candidate','candidate','base']){
      const r=spawnSync(process.execPath,[import.meta.filename,'--subject',variant==='base'?base:candidate,type,method,String(n)],{encoding:'utf8'});
      if(r.status)throw new Error(r.stderr);
      row.subjects.push({variant,...JSON.parse(r.stdout)});
    }
    row.ratio=median(row.subjects.filter(s=>s.variant==='candidate').map(s=>s.ms))/median(row.subjects.filter(s=>s.variant==='base').map(s=>s.ms));
    rows.push(row);console.log(type,method,n,row.ratio);
  }
  writeFileSync(process.argv[2],JSON.stringify({version:'pilot-1',date:new Date().toISOString(),rows},null,2));
}
