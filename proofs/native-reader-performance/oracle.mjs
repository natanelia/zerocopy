// Subject-independent constants, formula oracle, and sampled-view validation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const ROWS = Object.freeze(['P8', 'P1', 'N8', 'R8', 'C8', 'F8', 'W8']);
export const INITIAL = Object.freeze({ P8:32, P1:32, N8:256, R8:32, C8:32, F8:32, W8:128 });
export const CAPS = Object.freeze({ P8:8192, P1:8192, N8:1048576, R8:8192, C8:8192, F8:8192, W8:262144 });
export const KEYS = Object.freeze(Array.from({length:128}, (_, i) => `k${String(i).padStart(4,'0')}`));
export const QUERY = Object.freeze(Array.from({length:16}, (_, q) => KEYS[(17*q)%128]));
export const NAMES = Object.freeze(Array.from({length:8}, (_, j) => `m${j}`));
export const SESSION = Object.freeze({ copy:false, delivery:'all', maxPending:1, timeoutMs:10000 });
export const digest = value => createHash('sha256').update(value).digest('hex');
export const objectOracle = (j, i, variant, fresh=false) => ({
  id:(fresh ? 1024*variant : 0)+128*j+i,
  price:((fresh ? 4000*variant : 0)+400+40*j+i+(!fresh && variant===1 && j===0 && i===0 ? 4 : 0))/4,
  active:(i+j)%2===0,
});
export function query(snapshot, row) {
  let total=0;
  if (row==='P1') { for (const key of QUERY) total += snapshot.get(key); }
  else { for (const name of NAMES) for (const key of QUERY) total += snapshot[name].get(key).price; }
  return total;
}
export function oracleTotal(row, variant) {
  let quarters=0, numbers=0;
  for (let q=0;q<16;q++) {
    const i=(17*q)%128;
    if (row==='P1') numbers += variant===1 && i===0 ? 100000 : i;
    else for (let j=0;j<8;j++) quarters += (row==='F8' ? 4000*variant : 0)+400+40*j+i+(row!=='F8' && variant===1 && j===0 && i===0 ? 4 : 0);
  }
  return row==='P1' ? numbers : quarters/4;
}
export function expectedBatch(row, start, count, version) {
  assert(Number.isSafeInteger(count) && count>0 && count<=CAPS[row]);
  if (row==='N8') return count*version;
  if (row==='R8') return count*oracleTotal(row,0);
  if (row==='W8') return count*oracleTotal(row,start);
  const odd=Math.ceil(count/2), even=Math.floor(count/2);
  return odd*oracleTotal(row,1-start)+even*oracleTotal(row,start);
}
export function validateView(snapshot, row, variant) {
  const single=row==='P1';
  if (!single) { assert(Object.isFrozen(snapshot)); assert.deepEqual(Reflect.ownKeys(snapshot),NAMES); }
  for (let j=0;j<(single?1:8);j++) {
    const map=single?snapshot:snapshot[NAMES[j]];
    assert.equal(map.size,128); assert(Object.isFrozen(map));
    assert.deepEqual([...map.keys()].sort(),KEYS);
    for (let i=0;i<128;i++) {
      const got=map.get(KEYS[i]);
      if (single) { assert.equal(typeof got,'number'); assert.equal(got,variant===1&&i===0?100000:i); }
      else {
        const want=objectOracle(j,i,variant,row==='F8');
        assert.equal(typeof got,'object'); assert(got!==null); assert(Object.isFrozen(got));
        assert.deepEqual(Reflect.ownKeys(got),['id','price','active']);
        assert.equal(typeof got.id,'number'); assert.equal(typeof got.price,'number'); assert.equal(typeof got.active,'boolean');
        assert.deepEqual(got,want);
      }
    }
    if (!single) assert.equal(map.get('k0017'),map.get('k0017'));
  }
  assert.equal(query(snapshot,row),oracleTotal(row,variant));
}
export function validateTransition(previous,current,row) {
  if (row==='P1') { assert.notEqual(previous,current); return; }
  assert.notEqual(previous,current);
  if (row==='P8'||row==='C8') {
    assert.notEqual(previous.m0,current.m0);
    assert.notEqual(previous.m0.get('k0017'),current.m0.get('k0017'));
    for(let j=1;j<8;j++) {
      assert.equal(previous[NAMES[j]],current[NAMES[j]]);
      assert.equal(previous[NAMES[j]].get('k0017'),current[NAMES[j]].get('k0017'));
    }
  } else if(row==='F8') for(const name of NAMES) assert.notEqual(previous[name],current[name]);
}
