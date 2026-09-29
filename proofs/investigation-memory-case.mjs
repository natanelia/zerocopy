/** One fresh OS process, containing one owner and zero to four actual readers. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker, MessageChannel } from 'node:worker_threads';
import { validateCase, compareMemory } from './investigation-memory-model.mjs';
const config = validateCase(JSON.parse(process.argv[2]));
const peers = [];
function spawn(role) {
  const worker = new Worker(new URL('./investigation-memory-agent.mjs', import.meta.url), { workerData: { ...config, role } });
  const ready = once(worker,'message').then(([value]) => assert.equal(value.ready,true));
  let next=0; const pending=new Map();
  function rejectAll(error) { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); }
  worker.on('error', rejectAll);
  worker.on('exit', code => rejectAll(new Error(`Worker ${role} exited (${code})`)));
  worker.on('message', data => { const item=pending.get(data.id); if (!item) return; pending.delete(data.id);clearTimeout(item.timer); data.error ? item.reject(new Error(data.error)) : item.resolve(data.value); });
  const peer = { worker, ready, role, request(type, body={}, transferList=[]) { return new Promise((resolve,reject)=>{const id=++next; const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout: ${role} ${type}`));},60000);pending.set(id,{resolve,reject,timer});try {worker.postMessage({id,type,...body},transferList);} catch(error) {pending.delete(id);clearTimeout(timer);reject(error);}}); } };
  peers.push(peer); return peer;
}
async function sample() {
  // All computation and publication has finished before this barrier.
  const threads = [];
  for (const peer of peers) threads.push(await peer.request('sample'));
  for (let i=0;i<4;i++) { await new Promise(setImmediate); global.gc(); }
  threads.push({ role: 'controller', usage: process.memoryUsage(), arenas: [] });
  return { threads, rssBytes: process.memoryUsage.rss(), processHighWaterRSSBytes: process.resourceUsage().maxRSS * 1024 };
}
const output = value => process.stdout.write(JSON.stringify(value)+'\n');
try {
  const owner=spawn('owner'), readers=Array.from({length:config.readers},(_,i)=>spawn(`reader-${i}`));
  await Promise.all(peers.map(p=>p.ready));
  const channels=readers.map(()=>new MessageChannel());
  await Promise.all(readers.map((r,i)=>r.request('connect-reader',{port:channels[i].port1},[channels[i].port1])));
  await owner.request('connect-owner',{ports:channels.map(c=>c.port2)},channels.map(c=>c.port2));
  await Promise.all(peers.map(p=>p.request('ping')));
  const baseline=await sample(); output({type:'baseline',...baseline});
  async function stage(name) {
    const reading=await sample(), memory=compareMemory(baseline.threads,reading.threads);
    output({type:'stage',name,...reading,memory});
  }
  async function verify(frozen=false) {
    output({type:'answer',frozen,value:await owner.request('query',{frozen})});
  }
  await owner.request('load',{count:config.entries}); await stage('loaded');
  await verify(); await verify(); await stage('queried');
  await owner.request('retain',{enabled:true});
  await owner.request('append',{count:2000}); await verify(); await verify(true); await stage('append-retained');
  await owner.request('retain',{enabled:false}); await verify(); await stage('released');
  for (let i=0;i<20;i++) await owner.request('append',{count:2000});
  await verify(); await stage('streamed');
  await Promise.all(peers.map(peer=>peer.worker.terminate())); peers.length=0;
  output({type:'stopped',...(await sample())});
} finally { await Promise.all(peers.map(peer=>peer.worker.terminate())); }
