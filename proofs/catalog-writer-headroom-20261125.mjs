import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox } from 'playwright';

// Diagnostic only. No library patch and no claimed application speedup.
// Model the current bounded packed record writer vs direct encoding to its
// private stage; preserve native JSON serialization in both. The modeled
// destination is ordinary memory, not WASM; allocation/hooks/HAMT are absent.
const [checkout, output, reps = '11'] = process.argv.slice(2);
assert(checkout && output && Number.isInteger(+reps) && +reps > 0);
const root = resolve(checkout);
const identity = JSON.parse(readFileSync(join(root, 'website/_site/build.json'), 'utf8'));
assert.equal(identity.sourceDirty, false);
const report = { identity, complete: false, samples: [], engines: {}, node: process.version,
  driverSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex') };
const save = () => writeFileSync(output, JSON.stringify(report, null, 2));
const { createPreview } = await import(pathToFileURL(join(root, 'website/serve.mjs')).href);
const server = createPreview();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + server.address().port + '/investigation-benchmark/';

async function sample(page, count, mode) {
  await page.goto(url);
  return page.evaluate(async ({count, mode}) => {
    if (!crossOriginIsolated) throw new Error('Not isolated');
    const { entriesFor } = await import('./assets/catalog-core.mjs');
    const { deepFreeze } = await import('./assets/feature-core.mjs');
    const entries = entriesFor(count);
    for (const [, value] of entries) deepFreeze(value);
    const encoder = new TextEncoder();
    const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    // Independent byte oracle outside timing: exactly one aligned record per
    // input, including headers, key bytes, payload bytes and zero padding.
    function verify(output, used) {
      const view = new DataView(output.buffer);
      let at = 0, payloadBytes = 0;
      for (const [key, value] of entries) {
        const k = encoder.encode(key), v = encoder.encode(JSON.stringify(value));
        let h = 2166136261;
        for (const b of k) h = Math.imul(h ^ b, 16777619);
        if (view.getUint32(at, true) !== 0 || view.getUint32(at+4, true) !== h>>>0 ||
            view.getUint32(at+8, true) !== k.length || view.getUint32(at+12, true) !== v.length)
          throw new Error('Header mismatch ' + key);
        for (let i=0;i<k.length;i++) if (output[at+16+i] !== k[i]) throw new Error('Key mismatch '+key);
        for (let i=0;i<v.length;i++) if (output[at+16+k.length+i] !== v[i]) throw new Error('Value mismatch '+key);
        const end = at+16+k.length+v.length, aligned = Math.ceil(end/4)*4;
        // Current packedLeaves can retain prior bytes in alignment padding
        // after a flush. Only logical record bytes are part of this oracle.
        at = aligned; payloadBytes += v.length;
      }
      if (at !== used) throw new Error('Record extent mismatch');
      return payloadBytes;
    }
    if (mode === 'stringify') {
      // Separate, deliberately non-additive measurement. Holding strings
      // changes GC behavior; do not subtract this from application timing.
      const texts = new Array(count);
      const start = performance.now();
      for (let i=0;i<count;i++) texts[i] = JSON.stringify(entries[i][1]);
      const ms = performance.now()-start;
      let chars=0, payloadBytes=0;
      for (let i=0;i<count;i++) {
        if (texts[i] !== JSON.stringify(entries[i][1])) throw new Error('String mismatch');
        chars += texts[i].length; payloadBytes += encoder.encode(texts[i]).length;
      }
      return {ms, chars, payloadBytes, verified:true};
    }
    const stage = new Uint8Array(Math.min(1048576, Math.max(65536, count*256)));
    const view = new DataView(stage.buffer), scratch = new Uint8Array(49152);
    const output = new Uint8Array(count*512);
    let length=0, used=0, flushes=0, direct=0, fallback=0;
    const flush = () => {
      if (!length) return;
      if (used+length>output.length) throw new Error('Diagnostic destination exhausted');
      output.set(stage.subarray(0,length),used); used+=length; length=0; flushes++;
    };
    const encode = text => {
      if (text.length>49152) return encoder.encode(text);
      const r=encoder.encodeInto(text,scratch);
      return r.read===text.length?scratch.subarray(0,r.written):encoder.encode(text);
    };
    const start=performance.now();
    for (const [key,value] of entries) {
      const text=JSON.stringify(value);
      let keyLength=key.length, keyBytes;
      for(let i=0;i<key.length;i++) if(key.charCodeAt(i)>127){keyBytes=encoder.encode(key);keyLength=keyBytes.length;break;}
      let valueLength, valueBytes;
      // Conservative 3 bytes per UTF-16 unit and alignment slack. No
      // premature flush: use the exact-length scratch path at boundaries.
      if(mode==='direct' && length+16+keyLength+text.length*3+3<=stage.length && text.length<=49152){
        const r=encoder.encodeInto(text,stage.subarray(length+16+keyLength));
        if(r.read!==text.length) throw new Error('Unexpected partial encode');
        valueLength=r.written; direct++;
      }else{
        valueBytes=encode(text); valueLength=valueBytes.length; fallback++;
        const n=Math.ceil((16+keyLength+valueLength)/4)*4;
        if(n>stage.length) throw new Error('Oversize outside diagnostic model');
        if(length+n>stage.length){flush();valueBytes=encode(text);if(valueBytes.length!==valueLength)throw new Error('Unstable encoding');}
      }
      let h=2166136261;
      for(let i=0;i<keyLength;i++){const c=keyBytes?keyBytes[i]:key.charCodeAt(i);stage[length+16+i]=c;h=Math.imul(h^c,16777619);}
      view.setUint32(length,0,true);view.setUint32(length+4,h>>>0,true);
      view.setUint32(length+8,keyLength,true);view.setUint32(length+12,valueLength,true);
      if(valueBytes)stage.set(valueBytes,length+16+keyLength);
      length+=Math.ceil((16+keyLength+valueLength)/4)*4;
    }
    flush();
    const ms=performance.now()-start;
    const payloadBytes=verify(output,used);
    return {ms,used,payloadBytes,flushes,direct,fallback,sha256:await digest(output.subarray(0,used)),verified:true};
  }, {count,mode});
}
try {
  for (const [engine, launcher] of Object.entries({chromium,firefox})) {
    const browser=await launcher.launch();
    try {
      report.engines[engine]=browser.version();
      for(const count of [10000,100000]){
        // Interleave identical-control and candidate pairs; each page is fresh.
        for(let pair=-2;pair<+reps;pair++){
          const groups=pair%2?[['scratch','direct'],['scratch','scratch']]:[['scratch','scratch'],['scratch','direct']];
          for(const [g,modes] of groups.entries()){
            const kind=modes[1]==='direct'?'AB':'AA';
            const order=pair%2?[1,0]:[0,1];
            let records=[];
            for(const arm of order){
              const page=await browser.newPage();
              try{
                const result=await sample(page,count,modes[arm]);
                records.push(result);
                report.samples.push({engine,count,pair,warmup:pair<0,kind,arm,mode:modes[arm],...result});
                save();
              }finally{await page.close();}
            }
            assert.equal(records[0].sha256,records[1].sha256);
            assert.equal(records[0].payloadBytes,records[1].payloadBytes);
          }
          const page=await browser.newPage();
          try{report.samples.push({engine,count,pair,warmup:pair<0,kind:'stringify',...await sample(page,count,'stringify')});save();}
          finally{await page.close();}
        }
      }
    }finally{await browser.close();}
  }
  report.complete=true;save();
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
