import { afterEach, describe, expect, it } from 'vitest';
import { SharedMap } from './shared';
import { createSharedState } from './worker';
import { defineTasks, connect, pool, serve } from './worker-tasks';

class Port {
  peer!: Port;
  handlers = new Map<string, Set<(event:any)=>void>>();
  postMessage(data:any) { queueMicrotask(()=>this.peer.emit('message',{data})); }
  addEventListener(name:string,fn:(event:any)=>void){let set=this.handlers.get(name);if(!set)this.handlers.set(name,set=new Set());set.add(fn);}
  removeEventListener(name:string,fn:(event:any)=>void){this.handlers.get(name)?.delete(fn);}
  emit(name:string,event:any){for(const fn of [...(this.handlers.get(name)??[])])fn(event);}
  start(){}
}
function pair(){const a=new Port(),b=new Port();a.peer=b;b.peer=a;return {a,b};}
interface Model { map: SharedMap<'number'> }
const tasks=defineTasks<Model>()({
  get({state},key:string){return state.map.get(key);},
  async stable({state}:any,key:string){const before=state.map.get(key);await Promise.resolve();return [before,state.map.get(key)] as const;},
});
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});

describe('typed task executors',()=>{
  it('dispatches against the requested shared-state revision',async()=>{
    const {a,b}=pair(),state=createSharedState<Model>({map:new SharedMap('number')});
    cleanup.push(()=>state.dispose());
    const stop=await serve(tasks,{endpoint:b});cleanup.push(stop);
    const executor=await connect<typeof tasks,Model>(a,{state});cleanup.push(()=>executor.dispose());
    state.update('map',map=>map.set('lane',42));
    expect(await executor.run.get('lane')).toBe(42);
  });
  it('keeps one immutable snapshot for an async task',async()=>{
    const {a,b}=pair(),state=createSharedState<Model>({map:new SharedMap('number').set('lane',1)});
    cleanup.push(()=>state.dispose());
    const stop=await serve(tasks,{endpoint:b});cleanup.push(stop);
    const executor=await connect<typeof tasks,Model>(a,{state});cleanup.push(()=>executor.dispose());
    const result=executor.run.stable('lane');
    state.update('map',map=>map.set('lane',2));
    expect(await result).toEqual([1,1]);
  });
  it('schedules work across borrowed pool endpoints and keeps input order',async()=>{
    const one=pair(),two=pair(),state=createSharedState<Model>({map:new SharedMap('number').set('a',1).set('b',2)});
    cleanup.push(()=>state.dispose());
    cleanup.push(await serve(tasks,{endpoint:one.b}),await serve(tasks,{endpoint:two.b}));
    const workers=await pool<typeof tasks,Model>([one.a,two.a],{state,maxPending:8});cleanup.push(()=>workers.dispose());
    expect(await workers.map.get(['b','a','b'])).toEqual([2,1,2]);
  });
});
