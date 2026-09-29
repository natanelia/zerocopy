/** Browser contract checks use the published bundle, not a test replacement. */
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { once } from 'node:events';
import { createPreview } from '../website/serve.mjs';
const server=createPreview();server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}/`;

try {
  for(const [engine,type]of Object.entries({chromium,webkit})) {
    const browser=await type.launch({headless:true});
    try {
      const page=await browser.newPage();await page.goto(origin+'compare/');
      const result=await page.evaluate(async()=>{
        const {SharedList,getWorkerData,initWorker,resetSharedList}=await import('./library/shared.js');
        const strings=['KELVIN','İSTANBUL','ΟΣ','ΟΣΑ','ẞ','CAFÉ','e\u0301','日本語 request','request 日本語','😀','\ud800','\udfff','\uFEFFhello','\0HELLO'];
        const terms=['','k','i','σ','ς','ß','é','e\u0301','request','REQUEST','😀','\ud83d','\ude00','\ud800','\uFFFD','\uFEFF','\0','absent'];
        const original=new SharedList('string').pushMany(strings);
        let checks=0;
        for(const list of [original,(await initWorker(getWorkerData({original},{copy:false}))).original,(await initWorker(getWorkerData({original},{copy:true}))).original])for(const term of terms)for(const caseSensitive of [true,false]) {
          const match=list.compileTextSearch(term,{caseSensitive});const query=caseSensitive?term:term.toLowerCase();
          for(let i=0;i<list.size;i++){const s=list.get(i);if(match(i)!==(caseSensitive?s:s.toLowerCase()).includes(query))throw Error('Unicode mismatch');checks++;}
        }
        resetSharedList();const ascii=new SharedList('string').pushMany(Array.from({length:5000},(_,i)=>'Request '+i+' completed successfully with no timeout'));
        const match=ascii.compileTextSearch('REQUEST',{caseSensitive:false});const before=TextDecoder.prototype.decode;
        try {TextDecoder.prototype.decode=()=>{throw Error('ASCII search decoded a string');};for(let i=0;i<ascii.size;i++)if(!match(i))throw Error('ASCII mismatch');}
        finally {TextDecoder.prototype.decode=before;}
        const frozen=ascii.compileTextSearch('request',{caseSensitive:false});ascii.set(0,'Different').pushMany(Array(100000).fill('growth'));if(!frozen(0))throw Error('Snapshot changed');
        return{checks,asciiChecks:ascii.size,isolated:crossOriginIsolated};
      });
      assert.ok(result.isolated);assert.ok(result.checks>1000);assert.equal(result.asciiChecks,5000);console.log(engine,JSON.stringify(result));
    }finally{await browser.close();}
  }
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
