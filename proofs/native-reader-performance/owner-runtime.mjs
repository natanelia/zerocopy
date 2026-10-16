import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { readFileSync,writeFileSync,openSync,fsyncSync,closeSync,renameSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROWS,INITIAL,CAPS,SESSION,digest,expectedBatch,oracleTotal } from './oracle.mjs';
import { endpoint,protocolState,sentSnapshot,observedAck,verifyProtocol } from './endpoint.mjs';
import { buildFixtures } from './fixtures.mjs';

const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
function durable(path,value) {
  const temporary=`${path}.checkpoint`;
  writeFileSync(temporary,`${JSON.stringify(value,null,2)}\n`,{flag:'w'});
  const fd=openSync(temporary,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,path);
}
export async function runOwner(mechanism=false) {
  const now=mechanism?()=>0:()=>performance.now();
  const processStarted=now();
  assert.equal(process.argv.length,3);
  const config=JSON.parse(readFileSync(resolve(process.argv[2]),'utf8'));
  assert.equal(config.schemaVersion,1);assert.equal(config.mode==='mechanism',mechanism);
  assert(['mechanism','calibration','rehearsal','measurement'].includes(config.mode));
  assert(['node','bun'].includes(config.engine));assert(['B','C','A'].includes(config.arm));
  assert.equal(typeof globalThis.Bun==='undefined'?'node':'bun',config.engine);
  assert.equal(config.engine==='node'?process.versions.node:globalThis.Bun.version,config.engine==='node'?'22.16.0':'1.4.2');
  for(const key of ['bindingSHA256','caseSHA256','sequenceSHA256']) assert.match(config[key],/^[a-f0-9]{64}$/);
  assert.equal(resolve(config.sharedEntry),resolve(config.artifactRoot,'dist/shared.js'));
  assert.equal(resolve(config.workerEntry),resolve(config.artifactRoot,'dist/worker.js'));
  const caseFile=JSON.parse(readFileSync(new URL('./cases.json',import.meta.url),'utf8'));
  assert.equal(digest(canonical(caseFile)),config.caseSHA256);
  if(config.mode==='calibration') assert.equal(config.arm,'B');
  if(config.mode==='rehearsal') assert.equal(config.arm,'B');
  if(['measurement','rehearsal'].includes(config.mode)) {
    assert.deepEqual(Object.keys(config.counts).sort(),[...ROWS].sort());
    for(const row of ROWS) assert(Number.isSafeInteger(config.counts[row])&&config.counts[row]>0&&config.counts[row]<=CAPS[row]);
  }
  assert(!existsSync(config.output),'never overwrite existing group evidence');
  const identity=Object.fromEntries(['mode','engine','arm','block','processOrder','bindingSHA256','caseSHA256','sequenceSHA256'].map(key=>[key,config[key]??null]));
  const report={schemaVersion:1,identity,status:'running',workerCount:0,sourceAuthenticated:false,untimed:mechanism,
    valueValid:false,coldValueValid:false,failures:[],cold:{},rows:{},counts:{},phases:{setupMs:0,validationMs:0,teardownMs:0},
    fixture:null,protocol:{realWorker:false,workerRoute:'node:worker_threads',rowOrder:ROWS,
      sequential:true,ackBeforeApplicationResponse:false,countsVerified:false,orderingVerified:false,snapshotsN8:null,rowCounts:{}},
    disposed:false,workerTerminated:false,sourceAuthentication:'controller verifies the bound inventory before and after this group'};
  const save=()=>durable(config.output,report);
  let subjectWorker=null,workerFailure=null,fixtures=null;
  const sessions=new Map(),pending=new Map(),publications=new Map();let nextRequest=0,appResponses=0,badResponseOrder=0;
  let workerExitExpected=false;
  function rejectPending(error) {
    workerFailure=error;
    for(const entry of pending.values()) entry.reject(error);
    for(const entry of publications.values()) entry.reject(error);
    pending.clear();publications.clear();
  }
  function rpc(op,fields={}) {
    if(workerFailure) return Promise.reject(workerFailure);
    const id=++nextRequest;
    return new Promise((yes,no)=>{
      pending.set(id,{resolve:yes,reject:no});
      subjectWorker.postMessage({_nativeReaderScreen:1,kind:'request',id,op,...fields});
    });
  }
  function nextPublication(row) {
    if(workerFailure) return Promise.reject(workerFailure);
    return new Promise((yes,no)=>publications.set(row,{resolve:yes,reject:no}));
  }
  const onSessionError=error=>rejectPending(error);
  const validate=async(row,wireRow=row)=>{
    const began=now();
    const reader=await rpc('validate',{row:wireRow});
    const session=sessions.get(wireRow);
    assert.equal(session.session.version,reader.version);
    assert.equal(session.variant,reader.variant);
    const transport=verifyProtocol(session.wire,wireRow);
    assert.equal(badResponseOrder,0);
    const receipt={passed:true,reader,transport,ackBeforeApplicationResponse:true};
    report.phases.validationMs+=now()-began;
    report.rows[row]?.validations.push(receipt);
    return receipt;
  };
  async function openRow(workerApi,row) {
    assert(!sessions.has(row));
    const wire=protocolState(row);
    const adapted=endpoint(subjectWorker,{send:data=>sentSnapshot(wire,data),receive:data=>observedAck(wire,data)});
    const begin=now();
    const session=workerApi.createSharedSession(fixtures.variants[row][0],{...SESSION,copy:row==='C8',channel:row,onError:onSessionError});
    sessions.set(row,{session,wire,variant:0,adapted});
    const readyApplication=rpc('start',{row,descriptors:fixtures.descriptors[row]});
    const connected=session.connect(adapted);
    const ready=await readyApplication;
    await connected;
    const elapsedMs=now()-begin;
    assert.equal(ready.version,0);assert.equal(ready.initialChecksum,oracleTotal(row,0));
    assert.equal(wire.lastAck,0);assert.equal(wire.snapshots,1);
    return {...ready,elapsedMs};
  }
  async function publishOne(row) {
    const state=sessions.get(row),response=nextPublication(row);
    state.variant=1-state.variant;
    const version=state.session.publish(fixtures.variants[row][state.variant]);
    const value=await response;
    // ACK was dispatched to the library in the previous message event, before
    // this application response. Any mismatch is retained and checked untimed.
    if(value.version!==version||value.variant!==state.variant||state.wire.lastAck!==version) badResponseOrder++;
    return value;
  }
  async function closeRow(row) {
    const started=now();
    const state=sessions.get(row);assert(state);
    report.protocol.rowCounts[row]=verifyProtocol(state.wire,row);
    await rpc('dispose',{row});state.session.dispose();state.wire.lastFrame=null;sessions.delete(row);
    report.phases.teardownMs+=now()-started;
  }
  async function batch(row,count,stage,trial=null) {
    const destination=report.rows[row];
    assert(Number.isSafeInteger(count)&&count>0&&count<=CAPS[row]);
    const state=sessions.get(row==='N8'||row==='W8'?'P8':row);
    const beforeVariant=state?.variant??0,sessionSequenceStart=state?.session.version??0;
    const sequenceStart=destination.operationCount??0;
    destination.pendingBatch={stage,trial,index:destination.batches.length,count,beforeVariant,sequenceStart};save();
    let elapsedMs,checksum=0,acceptanceMs,queryMs,nativeInstances=null,workerValidation=null;
    if(['P8','P1','C8','F8'].includes(row)) {
      acceptanceMs=0;queryMs=0;
      const started=now();
      for(let i=0;i<count;i++) {
        const response=await publishOne(row);
        checksum+=response.checksum;acceptanceMs+=response.acceptanceMs;queryMs+=response.queryMs;
        if(mechanism) nativeInstances=(nativeInstances??0)+response.nativeInstances;
      }
      elapsedMs=now()-started;
    } else if(row==='N8') {
      const started=now();
      for(let i=0;i<count;i++) checksum+=state.session.publish(state.session.current);
      elapsedMs=now()-started;
    } else {
      const response=await rpc(row,{count,...(row==='R8'?{payload:fixtures.payload}:{})});
      ({elapsedMs,checksum,nativeInstances}=response);workerValidation=response.validation;
    }
    const expectedChecksum=expectedBatch(row,beforeVariant,count,sessionSequenceStart);
    const startVariant=['P8','P1','C8','F8'].includes(row)?1-beforeVariant:beforeVariant;
    const endVariant=['P8','P1','C8','F8'].includes(row)?(count%2?1-beforeVariant:beforeVariant):beforeVariant;
    const receipt={stage,trial,index:destination.batches.length,count,beforeVariant,startVariant,endVariant,
      elapsedMs:mechanism?null:elapsedMs,...(acceptanceMs===undefined?{}:{acceptanceMs:mechanism?null:acceptanceMs,queryMs:mechanism?null:queryMs}),checksum,expectedChecksum,
      validated:false,sequenceStart,sequenceEnd:sequenceStart+count,sessionSequenceStart,
      sessionSequenceEnd:state?.session.version??0};
    if(mechanism) receipt.nativeInstances=nativeInstances;
    receipt.sequenceReceiptSHA256=digest(canonical({row,count,beforeVariant,startVariant,endVariant,
      sequenceStart,sequenceEnd:sequenceStart+count,sessionSequenceStart,sessionSequenceEnd:receipt.sessionSequenceEnd}));
    destination.batches.push(receipt);destination.operationCount=sequenceStart+count;delete destination.pendingBatch;save();
    // All assertions and expected-checksum/receipt construction happen after
    // the two main endpoint clock reads (or outside the worker's batch timer).
    if(!mechanism) assert(Number.isFinite(elapsedMs)&&elapsedMs>0);assert.equal(checksum,expectedChecksum);
    if(!mechanism&&acceptanceMs!==undefined) {assert(Number.isFinite(acceptanceMs)&&acceptanceMs>0);assert(Number.isFinite(queryMs)&&queryMs>0);}
    if(row==='R8') {
      const began=now();assert.equal(workerValidation.passed,true);
      destination.validations.push({passed:true,reader:workerValidation});report.phases.validationMs+=now()-began+(workerValidation.elapsedMs??0);
    } else await validate(row,row==='N8'||row==='W8'?'P8':row);
    if(row==='N8') {
      const now=sessions.get('P8').wire.snapshots;
      assert.equal(now,destination.snapshotsBefore);report.protocol.snapshotsN8=now-destination.snapshotsBefore;
    }
    receipt.validated=true;save();return receipt;
  }
  try {
    save();
    const imports=now();
    const shared=await import(pathToFileURL(config.sharedEntry).href);
    const workerApi=await import(pathToFileURL(config.workerEntry).href);
    report.phases.ownerImportsMs=now()-imports;
    const firstCreate=now();
    const cold=new shared.SharedMap('number').set('cold',1);
    report.cold.ownerFirstCreateMs=mechanism?null:now()-firstCreate;
    assert.equal(cold.get('cold'),1);
    const fixtureStart=now();fixtures=buildFixtures(shared,cold);
    report.fixture=fixtures.manifest;report.phases.fixtureMs=now()-fixtureStart;save();
    let bootResolve,bootReject;
    const boot=new Promise((yes,no)=>{bootResolve=yes;bootReject=no;});
    const created=now();
    subjectWorker=new Worker(new URL(mechanism?'./preflight-worker.mjs':'./worker.mjs',import.meta.url),{workerData:{config}});
    report.workerCount=1;
    subjectWorker.on('error',error=>{bootReject(error);rejectPending(error);});
    subjectWorker.on('exit',code=>{if(!workerExitExpected){const e=new Error(`Unexpected worker exit ${code}`);bootReject(e);rejectPending(e);}});
    subjectWorker.on('message',message=>{
      if(message?._nativeReaderScreen!==1) return;
      if(message.kind==='boot') {bootResolve(message);return;}
      if(message.kind==='fatal') {rejectPending(new Error(message.message));return;}
      if(message.kind==='reply') {
        const waiting=pending.get(message.id);if(!waiting){rejectPending(new Error('Unexpected command response'));return;}
        pending.delete(message.id);message.error?waiting.reject(new Error(message.error)):waiting.resolve(message.result);return;
      }
      if(message.kind==='publication') {
        const waiting=publications.get(message.row),state=sessions.get(message.row);
        if(!waiting||!state){rejectPending(new Error('Unexpected publication response'));return;}
        if(state.wire.lastAck!==message.version) badResponseOrder++;
        appResponses++;publications.delete(message.row);waiting.resolve(message);
      }
    });
    const ready=await boot;assert(ready.realWorker && ready.threadId>0);assert.equal(ready.workerRoute,'node:worker_threads');
    report.protocol.realWorker=true;report.cold.workerImportMs=mechanism?null:ready.workerImportMs;
    report.phases.workerCreationToReadyMs=now()-created;
    report.coldSourceBytesBefore={passed:true,arenas:report.fixture.sourceByteManifest};
    const p8=await openRow(workerApi,'P8');
    report.cold.initialConnectMs=mechanism?null:p8.elapsedMs;report.cold.initialReceiverConnectMs=mechanism?null:p8.receiverConnectMs;
    report.rows.P8={batches:[],validations:[],valueValid:false};
    await validate('P8');
    const first=now();const response=await publishOne('P8');
    report.cold.firstP8Ms=mechanism?null:now()-first;
    report.cold.firstP8AcceptanceMs=mechanism?null:response.acceptanceMs;report.cold.firstP8QueryMs=mechanism?null:response.queryMs;
    assert.equal(response.checksum,oracleTotal('P8',1));assert.equal(response.version,1);
    await validate('P8');report.coldSourceBytesAfter=fixtures.checkBytes();report.coldValueValid=true;
    report.coldReceipt={initialVersion:0,firstChangedVersion:1,initialChecksum:p8.initialChecksum,firstChangedChecksum:response.checksum,
      firstEligibleReuse:true,validated:true};
    if(mechanism) report.mechanism={checks:{initialP8:p8.nativeInstances,laterP8:response.nativeInstances},passed:false};
    report.phases.setupMs=now()-processStarted;save();
    for(const row of ROWS) {
      report.rows[row]??={batches:[],validations:[],valueValid:false};
      const destination=report.rows[row];
      const before=now();destination.initialSourceBytes=fixtures.checkBytes();
      if(['P1','C8','F8'].includes(row)) {
        const initial=await openRow(workerApi,row);await validate(row);
        if(mechanism) destination.initialNativeInstances=initial.nativeInstances;
      } else if(row==='P8') await validate(row);
      else if(row==='N8'||row==='W8') {
        await validate(row,'P8');destination.retainedVariant=sessions.get('P8').variant;
        destination.initialVersion=sessions.get('P8').session.version;
        if(row==='N8') destination.snapshotsBefore=sessions.get('P8').wire.snapshots;
      } else if(row==='R8') {
        // The payload is checked without making an extra attachment/target group.
        assert.equal(fixtures.payload.arenas.length,8);destination.validations.push({passed:true,preparedPayloadArenas:8});
      }
      destination.setupMs=now()-before;
      if(mechanism) {
        const receipt=await batch(row,['N8','W8'].includes(row)?2:1,'mechanism');
        if(['P1','R8','C8','F8'].includes(row)) report.mechanism.checks[row==='P1'?'laterP1':row]=receipt.nativeInstances;
      } else if(config.mode==='calibration') {
        let count=INITIAL[row],qualified=false,attempted=0;
        for(let trial=0;trial<3;trial++) {
          attempted++;
          for(let i=0;i<2;i++) await batch(row,count,'warmup',trial);
          const pilots=[];
          for(let i=0;i<3;i++) pilots.push((await batch(row,count,'pilot',trial)).elapsedMs);
          pilots.sort((a,b)=>a-b);const median=pilots[1];assert(Number.isFinite(median)&&median>0);
          qualified=median>=40&&median<=80;
          destination.calibration={count,qualified,trials:attempted,medianMs:median};
          report.counts[row]=count;save();
          if(qualified||trial===2) break;
          count=Math.min(CAPS[row],Math.max(1,Math.round(count*50/median)));
        }
        if(['P1','P8'].includes(row)) assert(qualified,`primary calibration window missed: ${row}`);
      } else {
        const count=config.counts[row];report.counts[row]=count;
        for(let i=0;i<3;i++) await batch(row,count,'warmup');
        for(let i=0;i<7;i++) await batch(row,count,'measured');
      }
      const bytesStart=now();destination.finalSourceBytes=fixtures.checkBytes();
      destination.valueValid=true;
      report.phases.validationMs+=now()-bytesStart;
      if(['P1','C8','F8'].includes(row)) await closeRow(row);
      if(row==='R8') await rpc('dropR8');
      if(row==='W8') await closeRow('P8');
      destination.complete=true;save();
    }
    if(mechanism) {
      const want={initialP8:8,laterP8:config.arm==='C'?0:8,laterP1:config.arm==='C'?0:1,R8:8,C8:8,F8:8};
      assert.deepEqual(report.mechanism.checks,want);
      assert.equal(report.rows.P1.initialNativeInstances,1);
      assert.equal(report.rows.C8.initialNativeInstances,8);assert.equal(report.rows.F8.initialNativeInstances,8);
      report.mechanism.passed=true;
    }
    const teardown=now();
    const finished=await rpc('finish');assert.equal(finished.passed,true);assert.equal(sessions.size,0);
    assert.equal(pending.size,0);assert.equal(publications.size,0);assert.equal(badResponseOrder,0);
    report.protocol.applicationResponses=appResponses;report.protocol.countsVerified=true;report.protocol.orderingVerified=true;
    report.protocol.ackBeforeApplicationResponse=true;report.disposed=true;
    workerExitExpected=true;await subjectWorker.terminate();report.workerTerminated=true;
    report.phases.teardownMs+=now()-teardown;
    fixtures.checkBytes();report.valueValid=true;report.status='complete';
  } catch(error) {
    report.status='failed';report.valueValid=false;
    report.failures.push({message:String(error?.message??error),phase:'owner',noRetry:true});
    process.exitCode=1;
  } finally {
    if(!report.workerTerminated && subjectWorker) {
      const teardown=now();
      for(const state of sessions.values()) {try{state.session.dispose();}catch{}}
      sessions.clear();workerExitExpected=true;
      try{await subjectWorker.terminate();report.workerTerminated=true;}catch(error){report.failures.push({message:'worker termination failed',phase:'cleanup'});}
      report.phases.teardownMs+=now()-teardown;
    }
    report.phases.processWallMs=now()-processStarted;save();
  }
}
