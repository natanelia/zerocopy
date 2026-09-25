import { createSharedSession, connectSharedSession, type SharedEndpoint, type SharedShape, type SharedSource, type SharedReader } from './worker';

export interface TaskContext<S> { readonly state: S; readonly signal: AbortSignal }
export type Task<I = void, O = unknown, S = unknown> = (context: TaskContext<S>, input: I) => O | Promise<O>;
export type TaskSet<S = unknown> = Record<string, Task<any, any, S>>;
type Input<F> = F extends (c: any, ...args: infer A) => any ? A extends [infer I, ...any[]] ? I : void : never;
type Output<F> = F extends (...a: any[]) => infer O ? Awaited<O> : never;
export interface CallOptions { signal?: AbortSignal; timeoutMs?: number }
type Call<F> = [Input<F>] extends [void] ? (input?: void, options?: CallOptions) => Promise<Output<F>> : (input: Input<F>, options?: CallOptions) => Promise<Output<F>>;
export type TaskCalls<T extends TaskSet<any>> = { readonly [K in keyof T]: Call<T[K]> };
export interface Executor<T extends TaskSet<any>> { readonly run: TaskCalls<T>; readonly closed: boolean; dispose(): void }
export interface PoolExecutor<T extends TaskSet<any>> extends Executor<T> { readonly size: number; readonly map: { readonly [K in keyof T]: (inputs: readonly Input<T[K]>[], options?: CallOptions & { chunkSize?: number }) => Promise<Output<T[K]>[]> } }
export interface ClientOptions<S extends SharedShape<S>> { state: S | SharedSource<S>; channel?: string; timeoutMs?: number; memory?: 'share' | 'copy'; onError?: (error: Error) => void }
export interface ServeOptions { endpoint?: SharedEndpoint; channel?: string; timeoutMs?: number; onError?: (error: Error) => void }
export interface PoolOptions<S extends SharedShape<S>> extends ClientOptions<S> { size?: number; maxPending?: number }

const PROTOCOL = 'zerocopy/tasks', VERSION = 1;
let clients = 0;
type Msg = { protocol: string; version: number; channel: string; client: string; kind: 'hello'|'ready'|'call'|'result'|'error'|'cancel'|'close'; id?: number; task?: string; input?: unknown; value?: unknown; message?: string; revision?: number };

function endpointOf(value: any): SharedEndpoint {
  const endpoint = value?.port ?? value;
  if (!endpoint || typeof endpoint.postMessage !== 'function') throw new TypeError('Expected a Worker, SharedWorker, or MessagePort');
  endpoint.start?.(); return endpoint;
}
function listen(endpoint: SharedEndpoint, receive: (data: any) => void, fail: (error: Error) => void): () => void {
  if (endpoint.addEventListener && endpoint.removeEventListener) {
    const onMessage = (event: any) => receive(event.data), onError = (event: any) => fail(event.error instanceof Error ? event.error : new Error(event.message ?? 'Worker error'));
    endpoint.addEventListener('message', onMessage); endpoint.addEventListener('messageerror', onError); endpoint.addEventListener('error', onError);
    return () => { endpoint.removeEventListener!('message', onMessage); endpoint.removeEventListener!('messageerror', onError); endpoint.removeEventListener!('error', onError); };
  }
  if (endpoint.on && endpoint.off) {
    const onError = (error: any) => fail(error instanceof Error ? error : new Error(String(error)));
    endpoint.on('message', receive); endpoint.on('messageerror', onError); endpoint.on('error', onError);
    return () => { endpoint.off!('message', receive); endpoint.off!('messageerror', onError); endpoint.off!('error', onError); };
  }
  throw new TypeError('Endpoint does not support message events');
}
function msg(channel: string, client: string, fields: Omit<Msg,'protocol'|'version'|'channel'|'client'>): Msg { return { protocol: PROTOCOL, version: VERSION, channel, client, ...fields }; }
function valid(value: any, channel: string): value is Msg { return value?.protocol === PROTOCOL && value.version === VERSION && value.channel === channel && typeof value.client === 'string'; }
function sourceOf<S extends SharedShape<S>>(state: S | SharedSource<S>): SharedSource<S> {
  return state && typeof (state as any).getSnapshot === 'function' && typeof (state as any).subscribe === 'function'
    ? state as SharedSource<S> : { getSnapshot: () => state as S, subscribe: () => () => {} };
}

export function defineTasks<S>() { return <T extends TaskSet<S>>(tasks: T): T => Object.freeze({ ...tasks }); }

function client<T extends TaskSet<any>, S extends SharedShape<S>>(resource: any, options: ClientOptions<S>, owned: boolean): Executor<T> & { readonly _ready: Promise<void> } {
  const endpoint = endpointOf(resource), channel = options.channel ?? 'default', clientId = Date.now().toString(36) + '-' + (++clients);
  const state = createSharedSession({ source: sourceOf(options.state) }, { channel: 'tasks:' + channel + ':' + clientId, copy: options.memory === 'copy', timeoutMs: options.timeoutMs, onError: options.onError });
  let closed = false, id = 0, readyResolve!: () => void, readyReject!: (e: Error) => void;
  const ready = new Promise<void>((yes,no) => { readyResolve=yes; readyReject=no; }); ready.catch(()=>{});
  const pending = new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;cleanup:()=>void}>();
  const fail = (error: Error) => { readyReject(error); for (const p of pending.values()) { p.cleanup(); p.reject(error); } pending.clear(); options.onError?.(error); };
  const remove = listen(endpoint, data => {
    if (!valid(data, channel) || data.client !== clientId) return;
    if (data.kind === 'ready') { readyResolve(); return; }
    if ((data.kind === 'result' || data.kind === 'error') && data.id !== undefined) {
      const p=pending.get(data.id); if(!p)return; pending.delete(data.id); p.cleanup();
      data.kind === 'result' ? p.resolve(data.value) : p.reject(new Error(data.message ?? 'Worker task failed'));
    }
  }, fail);
  let initialized=false; const stateReady = state.connect(endpoint).then(() => ready).then(()=>{ initialized=true; });
  endpoint.postMessage(msg(channel, clientId, { kind:'hello' }));
  const invoke = async (task:string,input:unknown,call:CallOptions={}) => {
    if(closed) throw new Error('Worker executor is closed');
    if(call.signal?.aborted) throw call.signal.reason ?? new Error('Task aborted');
    const revision=state.flush(); if(!initialized) await stateReady; const callId=++id;
    return new Promise<any>((resolve,reject)=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      const cleanup=()=>{if(timer)clearTimeout(timer);call.signal?.removeEventListener('abort',abort);};
      const stop=(e:Error)=>{if(!pending.delete(callId))return;cleanup();reject(e);};
      const abort=()=>{endpoint.postMessage(msg(channel,clientId,{kind:'cancel',id:callId}));stop(call.signal?.reason instanceof Error?call.signal.reason:new Error('Task aborted'));};
      pending.set(callId,{resolve,reject,cleanup}); call.signal?.addEventListener('abort',abort,{once:true});
      if(call.timeoutMs!==undefined){if(!Number.isFinite(call.timeoutMs)||call.timeoutMs<=0){stop(new RangeError('timeoutMs must be positive'));return;}timer=setTimeout(()=>{endpoint.postMessage(msg(channel,clientId,{kind:'cancel',id:callId}));stop(new Error('Worker task timed out'));},call.timeoutMs);}
      try { endpoint.postMessage(msg(channel,clientId,{kind:'call',id:callId,task,input,revision})); }
      catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
    });
  };
  const run=new Proxy(Object.create(null),{get:(_t,key)=>typeof key==='string'?(input?:unknown,call?:CallOptions)=>invoke(key,input,call):undefined}) as TaskCalls<T>;
  return {run,_ready:stateReady,get closed(){return closed;},dispose(){if(closed)return;closed=true;try{endpoint.postMessage(msg(channel,clientId,{kind:'close'}));}catch{}remove();state.dispose();const e=new Error('Worker executor is closed');for(const p of pending.values()){p.cleanup();p.reject(e);}pending.clear();if(owned){resource.terminate?.();resource.port?.close?.();}}};
}

export async function connect<T extends TaskSet<any>,S extends SharedShape<S>>(endpoint:any,options:ClientOptions<S>):Promise<Executor<T>> { const value=client<T,S>(endpoint,options,false); await value._ready; return value; }
export async function spawn<T extends TaskSet<any>,S extends SharedShape<S>>(factory:()=>any,options:ClientOptions<S>):Promise<Executor<T>> { const value=client<T,S>(factory(),options,true); try { await value._ready; return value; } catch (error) { value.dispose(); throw error; } }

export function local<T extends TaskSet<S>,S extends SharedShape<S>>(tasks:T,options:{state:S|SharedSource<S>}):Executor<T> {
  let closed=false; const source=sourceOf(options.state);
  const run=Object.fromEntries(Object.entries(tasks).map(([name,task])=>[name,async(input:unknown,call:CallOptions={})=>{if(closed)throw new Error('Worker executor is closed');if(call.signal?.aborted)throw call.signal.reason??new Error('Task aborted');const controller=new AbortController();const abort=()=>controller.abort(call.signal?.reason);call.signal?.addEventListener('abort',abort,{once:true});let timer:ReturnType<typeof setTimeout>|undefined;if(call.timeoutMs)timer=setTimeout(()=>controller.abort(new Error('Worker task timed out')),call.timeoutMs);try{return await task({state:source.getSnapshot(),signal:controller.signal},input);}finally{if(timer)clearTimeout(timer);call.signal?.removeEventListener('abort',abort);}}])) as TaskCalls<T>;
  return {run,get closed(){return closed;},dispose(){closed=true;}};
}

async function atRevision<S extends SharedShape<S>>(reader: SharedReader<S>, revision: number | undefined): Promise<S> {
  if (revision === undefined || reader.version >= revision) return reader.current;
  const snapshots = reader.snapshots({ emitCurrent: false });
  for await (const value of snapshots) if (reader.version >= revision) return value;
  throw new Error('Shared state reader closed');
}

export async function serve<T extends TaskSet<S>,S extends SharedShape<S>>(tasks:T,options:ServeOptions={}):Promise<()=>void> {
  const endpoint=endpointOf(options.endpoint??globalThis),channel=options.channel??'default';
  const readers=new Map<string,Promise<SharedReader<S>>>(), running=new Map<string,Map<number,AbortController>>(); let closed=false;
  const remove=listen(endpoint,data=>{
    if(closed||!valid(data,channel))return;
    if(data.kind==='hello'){if(!readers.has(data.client)){readers.set(data.client,connectSharedSession<S>({endpoint,channel:'tasks:'+channel+':'+data.client,timeoutMs:options.timeoutMs,onError:options.onError}));running.set(data.client,new Map());}endpoint.postMessage(msg(channel,data.client,{kind:'ready'}));return;}
    if(data.kind==='close'){for(const controller of running.get(data.client)?.values()??[])controller.abort(new Error('Task client closed'));readers.get(data.client)?.then(r=>r.dispose()).catch(()=>{});readers.delete(data.client);running.delete(data.client);return;}
    if(data.kind==='cancel'&&data.id!==undefined){running.get(data.client)?.get(data.id)?.abort(new Error('Task aborted'));return;}
    if(data.kind!=='call'||data.id===undefined||typeof data.task!=='string')return;
    const task=tasks[data.task];if(!task){endpoint.postMessage(msg(channel,data.client,{kind:'error',id:data.id,message:'Unknown task: '+data.task}));return;}
    const callId=data.id,controller=new AbortController();running.get(data.client)?.set(callId,controller);
    Promise.resolve(readers.get(data.client)).then(reader=>{if(!reader)throw new Error('Task client has no shared state');return atRevision(reader,data.revision).then(snapshot=>task({state:snapshot,signal:controller.signal},data.input));})
      .then(value=>{if(!closed)endpoint.postMessage(msg(channel,data.client,{kind:'result',id:callId,value}));},error=>{if(!closed)endpoint.postMessage(msg(channel,data.client,{kind:'error',id:callId,message:error instanceof Error?error.message:String(error)}));})
      .finally(()=>running.get(data.client)?.delete(callId));
  },error=>options.onError?.(error));
  return ()=>{if(closed)return;closed=true;remove();for(const m of running.values())for(const c of m.values())c.abort(new Error('Task server closed'));for(const r of readers.values())r.then(x=>x.dispose()).catch(()=>{});readers.clear();running.clear();};
}

export async function pool<T extends TaskSet<any>,S extends SharedShape<S>>(workers:readonly any[]|(()=>any),options:PoolOptions<S>):Promise<PoolExecutor<T>> {
  const owned=!Array.isArray(workers);
  const size=owned ? (options.size ?? Math.max(1,Math.min(4,typeof navigator==='undefined'?4:(navigator.hardwareConcurrency||4)))) : (workers as readonly any[]).length;
  if(!Number.isSafeInteger(size)||size<1)throw new RangeError('Pool size must be a positive integer');
  const resources:any[]=[];
  const executors:(Executor<T> & { readonly _ready: Promise<void> })[]=[];
  try {
    if(owned) for(let index=0;index<size;index++) resources.push((workers as ()=>any)());
    else resources.push(...workers as readonly any[]);
    for(const resource of resources) executors.push(client<T,S>(resource,options,owned));
    await Promise.all(executors.map(executor=>executor._ready));
  } catch(error) {
    for(const executor of executors) executor.dispose();
    if(owned) for(const resource of resources.slice(executors.length)){try{resource.terminate?.();}catch{}try{resource.port?.close?.();}catch{}}
    throw error;
  }
  const max=options.maxPending??128;let closed=false,cursor=0,active=0;const queue:{run:()=>void;reject:(e:Error)=>void}[]=[];
  const schedule=<R>(op:(e:Executor<T>)=>Promise<R>)=>new Promise<R>((resolve,reject)=>{if(closed){reject(new Error('Worker pool is closed'));return;}if(queue.length>=max){reject(new Error('Worker pool queue overflow'));return;}const item={reject,run:()=>{active++;const e=executors[cursor++%size];op(e).then(resolve,reject).finally(()=>{active--;queue.shift()?.run();});}};active<size?item.run():queue.push(item);});
  const run=new Proxy(Object.create(null),{get:(_t,key)=>typeof key==='string'?(input?:unknown,call?:CallOptions)=>schedule(e=>(e.run as any)[key](input,call)):undefined}) as TaskCalls<T>;
  const map=new Proxy(Object.create(null),{get:(_t,key)=>typeof key==='string'?async(inputs:readonly unknown[],call?:CallOptions&{chunkSize?:number})=>{
    const results:any[]=new Array(inputs.length);
    if(!inputs.length)return results;
    const width=call?.chunkSize??size;
    if(!Number.isSafeInteger(width)||width<1)throw new RangeError('chunkSize must be a positive integer');
    let next=0;
    const feed=async()=>{for(;;){const index=next++;if(index>=inputs.length)return;results[index]=await schedule(e=>(e.run as any)[key](inputs[index],call));}};
    await Promise.all(Array.from({length:Math.min(width,size,inputs.length)},()=>feed()));
    return results;
  }:undefined}) as PoolExecutor<T>['map'];
  return {run,map,size,get closed(){return closed;},dispose(){if(closed)return;closed=true;const error=new Error('Worker pool is closed');for(const q of queue.splice(0))q.reject(error);for(const e of executors)e.dispose();}};
}
