import {fixture as legacyFixture,equal,materialize} from './reused/fixtures.mjs';
export {equal,materialize};
export function fixture(S,workload) {
  if(workload.kind!=='list')return legacyFixture(S,workload);
  const expected=Array.from({length:workload.size},(_,i)=>i+0.25);
  const item=S.compact(new S.SharedList('number')).pushMany(expected);
  return {item,retained:item,expected};
}
