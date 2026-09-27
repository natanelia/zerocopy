// Independent recursive reference. Production uses an iterative work stack.
export function distanceSquared(v, i, first, last) {
  let x=v[first*2], y=v[first*2+1];
  const dx=v[last*2]-x, dy=v[last*2+1]-y;
  if(dx!==0||dy!==0){const t=((v[i*2]-x)*dx+(v[i*2+1]-y)*dy)/(dx*dx+dy*dy);if(t>1){x=v[last*2];y=v[last*2+1];}else if(t>0){x+=dx*t;y+=dy*t;}}
  const vx=v[i*2]-x,vy=v[i*2+1]-y;return vx*vx+vy*vy;
}
export function farthestReference(v,first,last,threshold){let index=-1,distance=threshold;for(let i=first+1;i<last;i++){const d=distanceSquared(v,i,first,last);if(d>distance){distance=d;index=i;}}return{index,distance};}
export function simplifyReference(v,tolerance){
  const count=v.length/2;if(count<=2)return Array.from({length:count},(_,i)=>i);
  const result=[0],squared=tolerance*tolerance;
  function visit(first,last){const{index}=farthestReference(v,first,last,squared);if(index<0)return;if(index-first>1)visit(first,index);result.push(index);if(last-index>1)visit(index,last);}
  visit(0,count-1);result.push(count-1);return result;
}
export function simplifyWithKernel(k,p,tolerance){
  if(!k.finiteXY(p.root,p.depth,p.tail,p.size))throw new RangeError('Nonfinite coordinates');
  const count=p.size/2;if(count<=2)return Uint32Array.from({length:count},(_,i)=>i);
  const marked=new Uint8Array(count),stack=[0,count-1],squared=tolerance*tolerance;marked[0]=marked[count-1]=1;
  while(stack.length){const last=stack.pop(),first=stack.pop();const i=k.farthestXY(p.root,p.depth,p.tail,p.size,first,last,squared);if(i<0)continue;marked[i]=1;if(last-i>1)stack.push(i,last);if(i-first>1)stack.push(first,i);}
  let n=0;for(const m of marked)n+=m;const result=new Uint32Array(n);for(let i=0,j=0;i<count;i++)if(marked[i])result[j++]=i;return result;
}
