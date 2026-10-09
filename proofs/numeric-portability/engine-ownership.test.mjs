// Pure FS/spawn models; no actual engine, child, /proc, signal or clock.
import assert from 'node:assert/strict';
import {createOwnershipJournal,readBirth} from './engine-ownership.mjs';
import {guardEngineSpawn} from './launch-guard.mjs';

const adapter={pid:111,state:'S',ppid:900,group:111,session:111,startTicks:10},engine={pid:222,state:'S',ppid:111,group:222,session:222,startTicks:20};
const binding={slotId:'chromium-untimed-baseline',manifestSha256:'a'.repeat(64),runtime:'chromium',lane:'x64',arm:'baseline',mode:'untimed'};
let checks=0;
function model({shortWrites=false,failSyncAt=Infinity,readEngine=()=>engine}={}){
  let contents='',syncs=0,spawns=0;const calls=[];
  const io={openSync:(name,mode)=>{calls.push(['open',name,mode]);return mode==='wx'?10:11;},writeSync:(_fd,buffer,offset,length)=>{const count=shortWrites?Math.min(7,length):length;contents+=buffer.subarray(offset,offset+count).toString();calls.push(['write',count]);return count;},fsyncSync:fd=>{calls.push(['fsync',fd]);if(++syncs===failSyncAt)throw Error('fsync failed');},closeSync:fd=>calls.push(['close',fd])};
  const journal=createOwnershipJournal({journalPath:'/synthetic/slot.ownership.jsonl',binding,adapterPid:111,io,readIdentity:pid=>pid===111?adapter:readEngine()});
  const child={pid:222,exitCode:null,signalCode:null,spawnargs:['/engine','--user-data-dir=/fresh']};
  const fake={spawn:()=>{calls.push(['spawn']);spawns++;return child;}};
  const guard=guardEngineSpawn(fake,{executable:'/engine',profile:'/fresh',ownership:journal,onSpawn:(_child,_args,_attempt,birth)=>{calls.push(['callback',birth]);}});
  return {journal,fake,guard,child,calls,get spawns(){return spawns;},get rows(){return contents.split('\n').filter(Boolean).map(JSON.parse);}};
}
{
  const m=model({shortWrites:true});m.fake.spawn('/engine',['--user-data-dir=/fresh'],{detached:true});
  assert.deepEqual(m.rows.map(row=>row.kind),['ownership-ready','engine-spawn-intent','engine-spawned']);
  assert.deepEqual(m.rows[2].identity,engine);
  const spawn=m.calls.findIndex(call=>call[0]==='spawn'),callback=m.calls.findIndex(call=>call[0]==='callback');
  assert.equal(m.calls[spawn-1][0],'fsync');assert.equal(m.calls[callback-1][0],'fsync');
  assert.throws(()=>m.guard.seal(),/exit is not established/);
  m.child.exitCode=0;m.guard.seal();assert.equal(m.rows.at(-1).kind,'ownership-sealed');
  assert.throws(()=>m.fake.spawn('/engine',['--user-data-dir=/fresh'],{detached:true}),/already sealed/);assert.equal(m.spawns,1);
  m.journal.close();checks+=8;
}
{
  const m=model({failSyncAt:3});
  assert.throws(()=>m.fake.spawn('/engine',['--user-data-dir=/fresh'],{detached:true}),/fsync failed/);
  assert.equal(m.spawns,0);assert.equal(m.rows.at(-1).kind,'engine-spawn-intent');m.journal.close();checks+=3;
}
{
  const m=model({failSyncAt:4});
  assert.throws(()=>m.fake.spawn('/engine',['--user-data-dir=/fresh'],{detached:true}),/fsync failed/);
  assert.equal(m.spawns,1);assert.equal(m.guard.state.identity,null);assert.throws(()=>m.guard.seal(),/exit is not established/);m.journal.close();checks+=4;
}
{
  const m=model({readEngine:()=>{throw Error('birth unreadable');}});
  assert.throws(()=>m.fake.spawn('/engine',['--user-data-dir=/fresh'],{detached:true}),/birth unreadable/);
  assert.equal(m.spawns,1);assert.equal(m.rows.at(-1).kind,'engine-spawn-intent');
  assert.throws(()=>m.fake.spawn('/engine',['--user-data-dir=/fresh'],{detached:true}),/retry forbidden/);m.journal.close();checks+=4;
}
{
  const m=model();assert.throws(()=>m.fake.spawn('/engine',['--user-data-dir=/fresh'],{detached:false}),/detached process group/);assert.equal(m.spawns,0);m.journal.close();checks+=2;
}
{
  const values=['S','111','222','222',...Array(15).fill('0'),'20'];
  assert.deepEqual(readBirth(222,()=>`222 (engine with ) in name) ${values.join(' ')}\n`),engine);
  assert.throws(()=>readBirth(222,()=>`222 (bad) S 111`),/identity unavailable/);checks+=2;
}
console.log(JSON.stringify({syntheticChecks:checks,librarySubjectsExecuted:false,browserEnginesLaunched:false,processesSpawned:false,signalsSent:false,realOperationClocksRead:false,actualProcReads:false,actualPrctlCalls:false}));
