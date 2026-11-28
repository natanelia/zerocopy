// Varying-length road-like fixture adapted from the pinned #99 synthetic tile.
// No proprietary or real-world map data; coordinates in projected metres.
export const key=i=>(i%31===0?'道路/':'lane/')+(Math.imul(i,2654435761)>>>0).toString(36)+'/'+i;
export const schema={left:'float64',bottom:'float64',right:'float64',top:'float64',start:'uint32',count:'uint32',kind:'uint8',active:'boolean'};
export const fields=Object.keys(schema);
export function bounds(xy){
  let left=Infinity,bottom=Infinity,right=-Infinity,top=-Infinity;
  for(let j=0;j<xy.length;j+=2){left=Math.min(left,xy[j]);right=Math.max(right,xy[j]);bottom=Math.min(bottom,xy[j+1]);top=Math.max(top,xy[j+1]);}
  return {left,bottom,right,top};
}
export function lane(id){
  const n=id%97===0?256:4+(Math.imul(id+1,2654435761)>>>0)%61;
  const x=id%64*8,y=Math.floor(id/64)*12,xy=[];
  for(let j=0;j<n;j++)xy.push(x+Math.round(500*j/(n-1))/100,y+(j%5)/8);
  return {id,kind:id%4,active:true,...bounds(xy),xy};
}
// Synthetic mixed lane records: stable UTF-8 labels, optional speed and links,
// and independent metadata changes. Null, empty, and nonempty are distinct.
export function mixedMetadata(id,rev=0){
  const k=id+rev,labels=['Main Street','道路/北','école','道路/🛣️',''];
  return {roadName:k%7===0?null:labels[k%labels.length]+(k%5===4?'':String(id%128)),
    speedLimit:k%6===0?null:20+(k%7)*10,reviewed:k%3!==0,
    connections:k%5===0?null:k%5===1?[]:Array.from({length:k%5},(_,j)=>(id*7+j)%100003)};
}
export const mixedMode=m=>m.includes('-mixed-');
export function mixedLane(id){return {...lane(id),...mixedMetadata(id)};}
export function mixedQuery(n,rev,w){return {...queryFor(n,rev,w),reviewedOnly:(rev+w)%2===0,minimumSpeed:(rev+w)%3===0?40:0};}
export function mixedMatches(r,q){return matches(r,q)&&(!q.reviewedOnly||r.reviewed===true)&&(!q.minimumSpeed||(r.speedLimit!==null&&r.speedLimit>=q.minimumSpeed));}
export function validateMixed(r){return [...validate(r),r.roadName,r.speedLimit,r.reviewed,r.connections];}
export function editsFor(rows,rev){
  const n=rows.length,count=rev%12===0?Math.max(1,Math.floor(n/20)):rev%6===0?25:1;
  return Array.from({length:Math.min(n,count)},(_,j)=>{
    const i=((Math.imul(rev,8191)>>>0)+Math.floor(j*n/count))%n,old=rows[i],xy=old.xy.slice();
    if(rev%8===3){xy.splice(2,0,(xy[0]+xy[2])/2,(xy[1]+xy[3])/2);}
    else if(rev%8===4&&xy.length>8)xy.splice(2,2);
    else xy[(j%(xy.length/2))*2]+=rev%2?2:-1;
    // Soft removal/reinstatement, not physical row insert/delete.
    const active=rev%8===5?false:rev%8===6?true:old.active;
    return [i,{...old,active,xy,...bounds(xy)}];
  });
}
export function queryFor(n,rev,worker){
  const y=(Math.floor(rev/4)*19+worker*37)%Math.max(1,Math.floor(n/64)*12-120);
  const x=(Math.floor(rev/3)*31+worker*53)%340;
  return {left:x,bottom:y,right:x+132,top:y+120,kind:(Math.floor(rev/4)+worker)%4};
}
export const matches=(r,q)=>r.active&&r.kind===q.kind&&r.left<=q.right&&r.right>=q.left&&r.bottom<=q.top&&r.top>=q.bottom;
// Validate full visible geometry: degenerate segments, integer vertex count, and
// bounding boxes. Return per-row values, not just a count/sum.
export function validate(r){
  const xy=r.xy,b=bounds(xy);let zero=0;
  for(let j=2;j<xy.length;j+=2)if(xy[j]===xy[j-2]&&xy[j+1]===xy[j-1])zero++;
  const valid=Number.isFinite(b.left)&&Number.isFinite(b.bottom)&&Number.isFinite(b.right)&&Number.isFinite(b.top)&&xy.length>=4&&xy.length%2===0&&b.left===r.left&&b.right===r.right&&b.bottom===r.bottom&&b.top===r.top;
  return [r.id,xy.length/2,zero,valid,b.left,b.bottom,b.right,b.top];
}
export function equal(a,b,label){if(JSON.stringify(a)!==JSON.stringify(b))throw Error(label+' mismatch');}
export async function digest(n,get){
  // Bounded diagnostic memory for 100k rows. Hash ordered 512-row chunks,
  // then hash their fixed-width digests. Every row and field remains checked.
  // This is intentionally outside the measured edit-to-answer path.
  const block=512,hashes=new Uint8Array(Math.ceil(n/block)*32),encoder=new TextEncoder();
  for(let start=0;start<n;start+=block){
    const chunks=[];
    for(let i=start;i<Math.min(n,start+block);i++){
      const r=get(i);chunks.push(JSON.stringify([r.id,r.kind,r.active,r.left,r.bottom,r.right,r.top,r.xy,...(Object.hasOwn(r,'roadName')?[r.roadName,r.speedLimit,r.reviewed,r.connections]:[])]));
    }
    hashes.set(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(chunks.join('\n')))),start/block*32);
  }
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',hashes)),x=>x.toString(16).padStart(2,'0')).join('');
}
