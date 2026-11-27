import {attach,get,scan,size} from './dynamic-runtime.mjs';
import {digest} from './lane-fixture.mjs';
let current,last=-1;const retained=new Map();
self.onmessage=async({data:m})=>{
  try{
    if(m.release){
      retained.clear();
      self.postMessage({digest:await digest(m.ids.length,i=>get(m.mode,current,m.ids[i]))});return;
    }
    if(m.verify||m.expire){
      const out=[];
      for(const {rev,ids,missing} of m.history){
        const s=retained.get(rev);if(!s||size(m.mode,s)!==ids.length)throw Error('retained size');
        for(const id of missing)if(get(m.mode,s,id)!==undefined)throw Error('deleted identity resurrected');
        out.push([rev,await digest(ids.length,i=>get(m.mode,s,ids[i]))]);
      }
      if(m.expire)for(const {rev} of m.history)retained.delete(rev);
      self.postMessage({digests:out});return;
    }
    if(m.rev!==last+1)throw Error('out of order revision');
    const a=performance.now();current=await attach(m.mode,m.wire,current);const attachMs=performance.now()-a;
    if(m.hold)retained.set(m.rev,current);
    const p=performance.now(),points=m.ids.map(i=>get(m.mode,current,i)),pointMs=performance.now()-p;
    const t=performance.now(),visible=m.query?scan(m.mode,current,m.query):null,scanMs=performance.now()-t;
    last=m.rev;self.postMessage({rev:last,points,visible,attachMs,pointMs,scanMs,size:size(m.mode,current)});
  }catch(e){self.postMessage({error:String(e?.stack??e)});}
};
