// Linux proof-only process-memory sampler. Never treat inaccessible processes as zero.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
const exec=promisify(execFile);
export function startTreeSampler(interval=250){
  const start=performance.now(),samples=[];
  let stopped=false,timer,pending;
  async function sample(){
    const elapsedMs=performance.now()-start;
    try{
      const {stdout}=await exec('ps',['-eo','pid=,ppid=,comm=']);
      const children=new Map();
      for(const line of stdout.trim().split('\n')){
        const [pid,ppid,...comm]=line.trim().split(/\s+/);
        if(comm.join(' ')==='ps')continue;
        const list=children.get(Number(ppid))??[];
        list.push(Number(pid));children.set(Number(ppid),list);
      }
      const pids=[],seen=new Set([process.pid]),stack=[process.pid];
      while(stack.length){
        for(const pid of children.get(stack.pop())??[]){
          if(seen.has(pid))continue;
          seen.add(pid);pids.push(pid);stack.push(pid);
        }
      }
      const values=await Promise.all(pids.map(async pid=>{
        try{
          const text=await readFile('/proc/'+pid+'/smaps_rollup','utf8');
          const m=text.match(/^Pss:\s+(\d+) kB$/m);
          return m?Number(m[1]):null;
        }catch{return null;}
      }));
      const missing=values.filter(v=>v===null).length;
      samples.push({elapsedMs,processes:pids.length,missing,pssKiB:pids.length&&!missing?values.reduce((a,b)=>a+b,0):null});
    }catch(e){samples.push({elapsedMs,processes:0,missing:null,pssKiB:null,error:String(e)});}
  }
  function tick(){
    pending=sample().finally(()=>{if(!stopped)timer=setTimeout(tick,interval);});
  }
  tick();
  return async()=>{
    stopped=true;clearTimeout(timer);await pending;
    const complete=samples.filter(s=>s.pssKiB!==null);
    return {intervalMs:interval,completeSamples:complete.length,incompleteSamples:samples.length-complete.length,
      peakSampledPssKiB:complete.length?Math.max(...complete.map(s=>s.pssKiB)):null,samples};
  };
}
