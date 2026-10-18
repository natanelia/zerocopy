import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const dir = resolve(process.env.MODULE_DIR ?? '.');
const shared = await import(pathToFileURL(resolve(dir, 'dist/shared.js')).href);
const numeric = await import(pathToFileURL(resolve(dir, 'dist/numeric.js')).href);
const compiled = ['scalar', 'simd'].map(mode => ({ mode, module: new WebAssembly.Module(readFileSync(resolve(dir, `numeric-kernels${mode === 'simd' ? '-simd' : ''}.wasm`))) }));
const bounds = [[-Infinity, Infinity], [-0, 0], [-Number.MIN_VALUE, Number.MIN_VALUE], [Infinity, Infinity], [-Infinity, -Infinity], [-1000, 1000], [1, 1], [NaN, 1], [0, NaN], [1, -1]];
const edge = [NaN, Infinity, -Infinity, -0, 0, Number.MIN_VALUE, -Number.MIN_VALUE, 1, -1, 1001, -1001];
const reference = (values, lo, hi) => values.reduce((sum, x) => sum + Number(x >= lo && x <= hi), 0);
let oracleChecks = 0;
let maxArenaBytes = 0;
const sameBytes = (memory, copy) => {
  assert.equal(memory.buffer.byteLength, copy.length, 'Read must not grow memory');
  assert.ok(Buffer.from(memory.buffer).equals(copy), 'Read must not change any snapshot byte');
};
const verify = (value, expected, note) => { assert.equal(value, expected, note); oracleChecks++; };
for (const {mode, module} of compiled) {
  test(`${mode}: all full-leaf group sizes and tail lengths, with memory-end loads`, () => {
    assert.deepEqual(WebAssembly.Module.imports(module), [{ module: 'env', name: 'memory', kind: 'memory' }]);
    assert.deepEqual(WebAssembly.Module.exports(module).map(x => [x.name, x.kind]), [['countInRange','function'],['countPointsInBox','function'],['memory','memory']]);
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const { countInRange } = new WebAssembly.Instance(module, { env: { memory } }).exports;
    const view = new DataView(memory.buffer);
    const root = 64, tail = 512, bad = 0xffffff00;
    const tailValues = Array.from({ length: 32 }, (_, i) => edge[(i + 3) % edge.length]);
    tailValues.forEach((x, i) => view.setFloat64(tail + i * 8, x, true));
    for (let children = 1; children <= 32; children++) {
      for (let j = 0; j < 32; j++) view.setUint32(root + j * 4, bad, true);
      const values = [];
      for (let child = 0; child < children; child++) {
        const pointer = child === children - 1 ? memory.buffer.byteLength - 256 : 1024 + child * 256;
        view.setUint32(root + child * 4, pointer, true);
        for (let i = 0; i < 32; i++) {
          const x = edge[(child * 32 + i) % edge.length]; values.push(x);
          view.setFloat64(pointer + i * 8, x, true);
        }
      }
      const before = Buffer.from(new Uint8Array(memory.buffer));
      const fullCounts = bounds.map(([lo,hi]) => reference(values,lo,hi));
      for (let tailSize = 1; tailSize <= 32; tailSize++) {
        bounds.forEach(([lo,hi], b) => verify(countInRange(root, 1, tail, values.length + tailSize, lo,hi),
          fullCounts[b] + reference(tailValues.slice(0,tailSize),lo,hi), `${mode}/${children}/${tailSize}/${b}`));
      }
      sameBytes(memory, before);
    }
    for (const [lo,hi] of [[NaN,1],[0,NaN],[1,-1]]) verify(countInRange(bad,1,bad,1057,lo,hi),0);
    verify(countInRange(bad,0,bad,0,-Infinity,Infinity),0);
  });
  test(`${mode}: raw binary64 values and one-root-leaf boundaries`, () => {
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const { countInRange, countPointsInBox } = new WebAssembly.Instance(module, {env:{memory}}).exports;
    const view = new DataView(memory.buffer); const root = memory.buffer.byteLength - 256, tail = 64;
    let seed = 0x9e3779b9;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    for (let trial = 0; trial < 24; trial++) {
      const values = [];
      for (let i=0;i<64;i++) {
        const p=i<32?root+i*8:tail+(i-32)*8;
        if (i%7===0) view.setFloat64(p, edge[(i+trial)%edge.length],true);
        else { view.setUint32(p,random(),true);view.setUint32(p+4,random(),true); }
        values.push(view.getFloat64(p,true));
      }
      const before=Buffer.from(new Uint8Array(memory.buffer));
      for(let size=33;size<=64;size++) {
        for(const [lo,hi] of bounds) verify(countInRange(root,0,tail,size,lo,hi),reference(values.slice(0,size),lo,hi));
        if(!(size&1)) {
          let expected=0; for(let i=0;i<size;i+=2) expected+=Number(values[i]>=-1000&&values[i]<=1000&&values[i+1]>=-1000&&values[i+1]<=1000);
          verify(countPointsInBox(root,0,tail,size,-1000,-1000,1000,1000),expected);
        } else assert.throws(()=>countPointsInBox(root,0,tail,size,-1000,-1000,1000,1000),WebAssembly.RuntimeError);
      }
      sameBytes(memory,before);
    }
  });
}
test('public scans: depth boundaries, read-only attachments, forks, and all bytes', async () => {
  const sizes=[0,1,2,3,15,16,17,31,32,...Array.from({length:32},(_,i)=>33+i),65,1023,1024,1025,1056,1057,32767,32768,32769,32800,32801,262144,1048609];
  for(const size of sizes) {
    shared.resetSharedList();
    const values=Array.from({length:size},(_,i)=>i%31===0?edge[Math.floor(i/31)%edge.length]:(i*7919)%10007-5000);
    const original=new shared.SharedList('number').pushMany(values);
    const data=shared.getWorkerData({original},{copy:false});const memory=data.arenas[0].memory;
    maxArenaBytes=Math.max(maxArenaBytes,memory.buffer.byteLength);
    assert.ok(memory.buffer.byteLength<=64*1024*1024,'64 MiB fixture limit');
    const before=Buffer.from(new Uint8Array(memory.buffer));
    const { original: attached }=await shared.initWorker(data);
    for(const [lo,hi] of bounds) {
      const expected=reference(values,lo,hi);
      verify(numeric.countInRange(original,lo,hi),expected,`public/${size}`);
      verify(numeric.countInRange(attached,lo,hi),expected,`attached/${size}`);
    }
    sameBytes(memory,before);
    assert.throws(()=>attached.push(9999));
    if(size>0) {
      const changed=original.set(0,9999);
      verify(numeric.countInRange(original,9999,9999),0);
      verify(numeric.countInRange(changed,9999,9999),1);
      const fork=changed.pop();verify(numeric.countInRange(fork,9999,9999),size>1?1:0);
    }
  }
});
test('public error contracts',()=>{
  assert.throws(()=>numeric.countInRange(null,0,1),TypeError);
  assert.throws(()=>numeric.countInRange(new shared.SharedList('string'),0,1),TypeError);
  assert.throws(()=>numeric.countInRange(new shared.SharedList('number'),'0',1),TypeError);
  assert.throws(()=>numeric.countPointsInBox(new shared.SharedList('number').push(1),{minX:0,minY:0,maxX:1,maxY:1}),RangeError);
});
after(()=>console.log('UNROLL-SAFETY',JSON.stringify({oracleChecks,maxArenaBytes,wasm:compiled.map(({mode})=>({mode,sha256:createHash('sha256').update(readFileSync(resolve(dir,`numeric-kernels${mode==='simd'?'-simd':''}.wasm`))).digest('hex')}))})));
