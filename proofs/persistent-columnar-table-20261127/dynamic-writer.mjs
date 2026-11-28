// Proof only: never migrate writable arena handles across threads.
// One owner processes strictly ordered edits and publishes read-only roots.
import {configureMemory} from '../../dist/shared.js';
import {build,edit,payload,repack,shouldRepack,arenaUsage} from './schema-lane-runtime.mjs';
let owner,mode,last=-1;
self.onmessage=({data:m})=>{
  try{
    if(m.rev!==last+1)throw Error('writer revision out of order');
    let editMs=0,compactionMs=0,before=null;
    if(m.rev===0){
      mode=m.mode;
      if(m.maximumBytes!==undefined)configureMemory({maximumBytes:m.maximumBytes});
      owner=build(mode,m.initial);
    }else{
      if(m.mode!==mode)throw Error('writer mode mismatch');
      const t=performance.now();owner=edit(mode,owner,m.b);editMs=performance.now()-t;
      if(shouldRepack(mode,m.rev,owner,m.work)){
        const a=performance.now();before=arenaUsage(owner,mode);
        owner=repack(mode,owner,m.rev,m.work);
        compactionMs=performance.now()-a;
      }
    }
    const t=performance.now(),p=payload(mode,owner),payloadMs=performance.now()-t;
    const usage=arenaUsage(owner,mode);
    last=m.rev;
    self.postMessage({rev:last,p,usage,before,editMs,compactionMs,payloadMs});
  }catch(e){self.postMessage({error:String(e?.stack??e)});}
};
