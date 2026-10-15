// This file imports the subject only when a separately reviewed hosted launch runs it.
import {readFileSync,writeFileSync,appendFileSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {CASES,G0,GMAX,D,S,M,DENSE,key,missing,check,quantum,allocation,propose,validateContents} from './protocol.mjs';

const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
const output=process.argv[3], events=output+'.events.jsonl';
const result={...config,complete:false,validatedEndpoints:[],startup:{},cases:{},validation:{startup:[],cases:{}}};
const retained=[], arenas=new Set(), retainedChecks=[];
const digest=x=>createHash('sha256').update(x).digest('hex');
const emit=x=>appendFileSync(events,JSON.stringify(x)+'\n');
const now=()=>process.hrtime.bigint();
const elapsed=start=>Number(now()-start)/1e6;
function contents(map,expected) { return digest(JSON.stringify(validateContents(map,expected))); }

try {
  check(process.execArgv.length===0,'custom runtime flags forbidden');
  check(!process.env.NODE_OPTIONS&&!process.env.BUN_OPTIONS,'custom runtime options forbidden');
  check(config.engine==='Bun'?process.versions.bun==='1.4.2':!process.versions.bun&&process.versions.node==='22.16.0','runtime mismatch');
  check(CASES.length===config.order.length&&new Set(config.order).size===8&&config.order.every(x=>CASES.includes(x)),'bad case order');
  for(const name of CASES) check(Number.isSafeInteger(config.counts[name])&&config.counts[name]>=G0[name]&&config.counts[name]<=GMAX[name]&&(Math.log2(config.counts[name])%1===0),'bad frozen count');
  const expectedPath=realpathSync(resolve(config.armRoot,config.engine==='Node'?'dist/shared.js':'shared.ts'));
  const resolvedPath=realpathSync(fileURLToPath(import.meta.resolve('zerocopy')));
  check(resolvedPath===expectedPath,'public export resolved outside exact arm');
  result.resolution={specifier:'zerocopy',path:resolvedPath,expected:expectedPath};
  const keys=Array.from({length:4096},(_,i)=>key(i));
  const seedEntries=keys.map((k,i)=>[k,i]);
  const objectEntries=keys.map((k,i)=>[k,{id:i,label:'item-'+i,active:i%2===0}]);
  const readKeys=[...keys.slice(0,128),...Array.from({length:128},(_,i)=>missing(i))];
  const fixtures=Object.fromEntries(CASES.map(name=>{
    const indexes=name==='Dense16'?DENSE:Array.from({length:{P8:8,P128:128,One:1,Four:4}[name]??0},(_,i)=>i);
    const variants=[10000,20000].map(offset=>indexes.map(i=>[keys[i],i+offset]));
    const expectedSeed=new Map(name==='Large'?[]:seedEntries);
    const expected=variants.map(entries=>new Map([...expectedSeed,...entries]));
    return [name,{variants,expectedSeed,expected,largeExpected:new Map(objectEntries.map(([k,v])=>[k,{...v}]))}];
  }));
  const startupEntries=seedEntries.slice(0,8), startupExpected=new Map(startupEntries);
  // All 4096 raw readings are kept. No subject has been imported yet.
  const readings=Array(4096);
  for(let i=0;i<4096;i++) readings[i]=now();
  result.clockReadingsNs=readings.map(String); result.q=quantum(result.clockReadingsNs);
  emit({event:'preflight',...result});
  let t=now();
  const subject=await import('zerocopy');
  result.startup.import=elapsed(t);
  emit({event:'startup-import',ms:result.startup.import});
  const {SharedMap,configureMemory,resetMap,getWorkerData}=subject;
  configureMemory({maximumBytes:M});
  function descriptor(map) {
    const data=getWorkerData({map},{copy:false});
    check(data.arenas.length===1&&data.structures.map.data.root===map.root,'unexpected transport shape');
    const {used,memory}=data.arenas[0]; check(memory&&memory.buffer,'missing shared arena');
    return {used,capacity:memory.buffer.byteLength,memory};
  }
  function endpoint(map,label) {
    const d=descriptor(map), bytes=new Uint8Array(d.memory.buffer);
    return {label,root:map.root,size:map.size,used:d.used,capacity:d.capacity,payloadSha256:digest(bytes.subarray(65536,d.used)),linearSha256:digest(bytes)};
  }
  t=now(); const firstEmpty=new SharedMap('number'); result.startup.constructor=elapsed(t);
  const firstDescriptor=descriptor(firstEmpty); check(firstDescriptor.used===65536&&firstDescriptor.capacity===131072,'startup initial backing');
  // Scalar capture only: do not pre-touch/hash the fresh backing before firstSetMany.
  result.validation.startup.push({label:'constructor',root:firstEmpty.root,size:firstEmpty.size,used:firstDescriptor.used,capacity:firstDescriptor.capacity});
  let startupSink=0;
  t=now(); const firstMap=firstEmpty.setMany(startupEntries); startupSink=(startupSink+firstMap.root)|0; result.startup.firstSetMany=elapsed(t);
  emit({event:'startup-timers',startup:result.startup,sink:startupSink});
  result.validation.startup.push(endpoint(firstMap,'firstSetMany'));
  check(descriptor(firstMap).used<=65536+4974&&descriptor(firstMap).capacity===131072,'startup allocation bound');
  result.validation.startup.push({emptyContents:contents(firstEmpty,new Map()),populatedContents:contents(firstMap,startupExpected),sink:startupSink});
  retained.push(firstEmpty,firstMap); arenas.add(firstDescriptor.memory);
  retainedChecks.push({snapshots:[{map:firstEmpty,expected:new Map()},{map:firstMap,expected:startupExpected}],digests:[contents(firstEmpty,new Map()),contents(firstMap,startupExpected)]});
  result.validatedEndpoints.push('import','constructor','firstSetMany');
  emit({event:'startup-complete',startup:result.startup,validation:result.validation.startup});

  for(const name of config.order) {
    const G=config.counts[name], fixture=fixtures[name];
    resetMap();
    const empty=new SharedMap(name==='Large'?'object':'number');
    const initial=descriptor(empty); check(initial.used===65536&&initial.capacity===131072,'case initial backing');
    check(!arenas.has(initial.memory),'reset reused a retained arena'); arenas.add(initial.memory);
    let current=name==='Large'?empty:empty.setMany(seedEntries), sink=0, cumulative=0;
    const snapshots=[{map:empty,expected:new Map()},{map:current,expected:fixture.expectedSeed}];
    const points=[endpoint(empty,'empty'),endpoint(current,'seed')], warm=[], measured=[];
    allocation(name,points[1],points[1],0,0);
    let before=points[1], prefix=null, prefixSha=null, prefixUsed=null;
    emit({event:'case-seed',name,G,points});
    for(let chunk=0;chunk<6;chunk++) {
      // The timed loops include only public calls, assignments, and integer sinks.
      const entries=name==='Empty'?fixture.variants[0]:fixture.variants;
      t=now();
      if(name==='Read') {
        for(let i=0;i<G;i++) { const value=current.get(readKeys[i%256]); sink=(sink+(value===undefined?1:value))|0; }
      } else if(name==='Large') {
        for(let i=0;i<G;i++) { current=empty.setMany(objectEntries); sink=(sink+current.root)|0; }
      } else if(name==='Empty') {
        for(let i=0;i<G;i++) { current=current.setMany(entries); sink=(sink+current.root)|0; }
      } else {
        for(let i=0;i<G;i++) { current=current.setMany(entries[(cumulative+i)%2]); sink=(sink+current.root)|0; }
      }
      const ms=elapsed(t);
      (chunk<2?warm:measured).push(ms); cumulative+=G;
      const point=endpoint(current,chunk<2?`warm${chunk+1}`:`measured${chunk-1}`);
      point.pagesAdded=(point.capacity-before.capacity)/65536; point.crossedCapacity=point.capacity>before.capacity;
      emit({event:'chunk',name,chunk,G,ms,sink,point});
      allocation(name,before,point,cumulative,G);
      points.push(point); before=point;
      snapshots.push({map:current,expected:name==='Large'?fixture.largeExpected:name==='Read'||name==='Empty'?fixture.expectedSeed:fixture.expected[(cumulative-1)%2]});
      if(chunk===1) { prefixUsed=point.used; prefix=new Uint8Array(initial.memory.buffer,65536,prefixUsed-65536).slice(); prefixSha=digest(prefix); }
    }
    const prefixAfter=digest(new Uint8Array(initial.memory.buffer,65536,prefixUsed-65536));
    check(prefixSha===prefixAfter&&digest(prefix)===prefixAfter,'published prefix changed');
    // Every endpoint digest above precedes these post-timing semantic reads.
    const contentDigests=snapshots.map(({map,expected})=>contents(map,expected));
    result.validation.cases[name]={points,prefixUsed,prefixSha,prefixAfter,contentDigests};
    result.cases[name]={warm,measured,sink,G,pagesAdded:points.slice(2).reduce((a,p)=>a+p.pagesAdded,0),timedChunksCrossingCapacity:points.slice(2).filter(p=>p.crossedCapacity).map(p=>p.label)};
    if(config.kind==='calibration') result.cases[name].proposal=propose(name,measured,result.q);
    retained.push(...snapshots.map(x=>x.map));
    retainedChecks.push({snapshots,digests:contentDigests,memory:initial.memory,prefixUsed,prefixSha});
    result.validatedEndpoints.push(name);
    emit({event:'case-complete',name,result:result.cases[name],validation:result.validation.cases[name]});
  }
  check(arenas.size===9,'nine arenas must remain retained');
  for(const old of retainedChecks) {
    if(old.memory) check(digest(new Uint8Array(old.memory.buffer,65536,old.prefixUsed-65536))===old.prefixSha,'later case changed retained payload');
    check(JSON.stringify(old.snapshots.map(({map,expected})=>contents(map,expected)))===JSON.stringify(old.digests),'later case changed retained snapshot');
  }
  result.validation.retainedAcrossAllCases=true;
  result.retainedArenas=arenas.size; result.retainedSnapshots=retained.length;
  result.finalBackingBytes=[...arenas].reduce((sum,memory)=>sum+memory.buffer.byteLength,0);
  check(result.finalBackingBytes<=9*M,'aggregate backing ceiling');
  result.complete=true;
} catch(error) { result.error={name:error.name,message:error.message,stack:error.stack}; emit({event:'failure',error:result.error}); }
writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({id:config.id,complete:result.complete,error:result.error??null}));
if(!result.complete) process.exitCode=1;
