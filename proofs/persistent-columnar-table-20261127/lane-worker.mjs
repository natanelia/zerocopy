import {attach,get,scan} from './lane-runtime.mjs';
import {digest} from './lane-fixture.mjs';
let current,last=-1;const retained=new Map();
self.onmessage=async({data:m})=>{
  try{
    if(m.verify){self.postMessage({digests:await Promise.all([...retained].map(async([rev,s])=>[rev,await digest(m.n,i=>get(m.mode,s,i))]))});return;}
    if(m.rev!==last+1)throw Error('out of order revision');
    const a=performance.now();current=await attach(m.mode,m.wire,current);const attachMs=performance.now()-a;
    if(m.hold)retained.set(m.rev,current);
    const p=performance.now(),points=m.ids.map(i=>get(m.mode,current,i)),pointMs=performance.now()-p;
    const t=performance.now(),visible=m.query?scan(m.mode,current,m.n,m.query):null,scanMs=performance.now()-t;
    last=m.rev;self.postMessage({rev:last,points,visible,attachMs,pointMs,scanMs});
  }catch(e){self.postMessage({error:String(e?.stack??e)});}
};
