/** Exact differential tests against the public decoded-string contract. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
const entry = process.env.QUERY_PROOF_ENTRY ?? new URL('../dist/shared.js', import.meta.url).href;
const { SharedList, getWorkerData, initWorker, resetSharedList } = await import(entry);
function verify(list, terms) {
  for (const term of terms) for (const caseSensitive of [true, false]) {
    const match = list.compileTextSearch(term, { caseSensitive });
    const query = caseSensitive ? term : term.toLowerCase();
    for (let i = 0; i < list.size; i++) {
      const value = list.get(i);
      assert.equal(match(i), (caseSensitive ? value : value.toLowerCase()).includes(query), JSON.stringify({ term, value, i, caseSensitive }));
    }
  }
}
if (!isMainThread) {
  const { text } = await initWorker(workerData);
  const matches = text.compileTextSearch('request', { caseSensitive: false });
  parentPort.postMessage({ ready: true });
  parentPort.once('message', () => {
    try {
      for (let i = 0; i < text.size; i++) assert.equal(matches(i), text.get(i).toLowerCase().includes('request'));
      parentPort.postMessage({ ok: true });
    } catch (error) { parentPort.postMessage({ error: error.stack }); }
  });
} else {
  test('literal search preserves case, punctuation, null bytes and every short-needle boundary', () => {
    const terms = ['', 'a', 'A', '.', '[', '\\', '0', '\0', '[a-z]+', ...Array.from({ length: 70 }, (_, i) => 'a'.repeat(i) + 'b')];
    const strings = ['', 'Aa 0 .[a-z]+\\', 'nul\0byte', 'a'.repeat(400), 'a'.repeat(100) + 'b', ...terms.flatMap(term => [term, 'x'+term, term+'x', 'x'+term+'x', term.toUpperCase()])];
    verify(new SharedList('string').pushMany(strings), terms);
  });
  test('seeded ASCII data exercises short and long needles at every byte position', () => {
    let state=0x42; const rand=()=>{state=Math.imul(state,1664525)+1013904223;return state>>>0;};
    const texts=Array.from({length:180},()=>Array.from({length:rand()%240},()=>String.fromCharCode(rand()%128)).join(''));
    const terms=['[','{','@','`','^','~','\\','|'];
    for(let i=0;i<180;i++){const text=texts[rand()%texts.length],start=rand()%(text.length+1);terms.push(text.slice(start,start+rand()%65));}
    verify(new SharedList('string').pushMany(texts),terms);
  });
  test('Unicode case expansion, contextual casing, surrogate halves and UTF-8 replacements match JavaScript', async () => {
    const strings = ['Kelvin', 'İSTANBUL', 'I\u0307', 'Σ', 'ΟΣ', 'ΟΣΑ', 'ß', 'ẞ', 'ﬃ', 'ſ', 'CAFÉ', 'e\u0301', '日本語', '中文 REQUEST', 'request 中文', 're中quest', '\uFEFFRequest', '\ud800', '\udfff', '😀', '𐐀', 'ΟΣ\u0301', '\0REQUEST\0'];
    const terms = ['', 'k', 'i', '\u0307', 'σ', 'ς', 'οσ', 'ος', 'ss', 'ß', 'ffi', 's', 'request', 'REQUEST', 'café', 'É', 'é', 'e\u0301', '日', '中', '😀', '\ud83d', '\ude00', '\ud800', '\udfff', '\uFFFD', '𐐨', '\uFEFF', '\0'];
    const original = new SharedList('string').pushMany(strings);
    for (const list of [original, (await initWorker(getWorkerData({ original }, { copy: false }))).original, (await initWorker(getWorkerData({ original }, { copy: true }))).original]) verify(list, terms);
  });
  test('seeded arbitrary UTF-16 texts and needles preserve includes semantics', () => {
    let seed = 0x7331aab; const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const chars = ['a','A','Z','z','0','[',']','^','{','|','@','`','!','\0','K','İ','Σ','ς','ß','é','中','😀','\ud800','\udfff'];
    const strings = Array.from({length:250}, () => Array.from({length:next()%120},()=>chars[next()%chars.length]).join(''));
    const list = new SharedList('string').pushMany(strings);
    const terms = ['k','i','s','z','@','[','`','{'];
    for (let i=0;i<150;i++) { const s=strings[next()%strings.length], start=next()%(s.length+1); terms.push(s.slice(start,start+next()%45)); }
    verify(list,terms);
  });
  test('query compilation never materializes an ASCII dataset or writes into a reader arena', async () => {
    resetSharedList();
    const list = new SharedList('string').pushMany(Array.from({length:4097},(_,i)=>`Request completed successfully with result=200 and id=${i}`));
    const { list: attached } = await initWorker(getWorkerData({ list }, { copy:false }));
    // Long unique strings must not reach TextDecoder, including after the
    // existing decoded-string cache limit. No reader memory may be written.
    const memory = getWorkerData({ list: attached }, { copy: false }).arenas[0];
    const before = new Uint8Array(memory.memory.buffer, 0, memory.used).slice();
    const decoder = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = () => { throw Error('Unexpected string decoding'); };
    try {
    for (const term of ['request','missing','ID=40','=', 'completed','']) {
      const match = attached.compileTextSearch(term,{caseSensitive:false});
      for(let i=0;i<list.size;i++) assert.equal(match(i),`Request completed successfully with result=200 and id=${i}`.toLowerCase().includes(term.toLowerCase()));
    }
    } finally { TextDecoder.prototype.decode = decoder; }
    assert.deepEqual(new Uint8Array(memory.memory.buffer, 0, memory.used), before);
    assert.throws(()=>attached.push('x'),/read-only/);
  });
  test('invalid indices, invalid options and non-string collections are rejected predictably', () => {
    const list=new SharedList('string').pushMany(['Request','']);
    const contains=list.compileTextSearch('');
    for(const i of [-1,2,0.5,NaN,Infinity,'0',undefined,null,2**32]) assert.equal(contains(i),false);
    assert.equal(contains(-0),true); assert.equal(list.compileTextSearch('request')(0),false);
    assert.throws(()=>list.compileTextSearch(1),TypeError);
    assert.throws(()=>list.compileTextSearch(/request/),TypeError);
    assert.throws(()=>list.compileTextSearch('',{caseSensitive:'false'}),TypeError);
    assert.throws(()=>list.compileTextSearch('',null),TypeError);
    assert.throws(()=>new SharedList('number').compileTextSearch(''),TypeError);
    const options={caseSensitive:false},match=list.compileTextSearch('request',options); options.caseSensitive=true;assert.equal(match(0),true);
  });
  test('compiled predicates retain their snapshot after forks, growth, pops and resets', async () => {
    resetSharedList();
    const values=Array.from({length:32769},(_,i)=>i%3?'Request #'+i:'Timeout #'+i);
    const list=new SharedList('string').pushMany(values),contains=list.compileTextSearch('request',{caseSensitive:false});
    const memory=getWorkerData({list},{copy:false}).arenas[0].memory,oldBytes=memory.buffer.byteLength;
    const changed=list.set(0,'Request updated').set(32,'Timeout updated').pushMany(Array.from({length:100000},(_,i)=>'Additional request '+i));
    assert.ok(memory.buffer.byteLength>oldBytes);
    resetSharedList(); new SharedList('string').push('Other');
    for(let i=0;i<list.size;i++) assert.equal(contains(i),values[i].toLowerCase().includes('request'));
    assert.equal(changed.compileTextSearch('updated')(0),true);assert.equal(contains(0),false);
    const popped=list.pop(); assert.equal(popped.compileTextSearch('request',{caseSensitive:false})(32768),false);
    const copies=await initWorker(getWorkerData({list,changed},{copy:true}));
    verify(copies.list,['request','timeout','updated']);verify(copies.changed,['updated','Additional request 99999']);
  });
  test('real readers keep their compiled snapshot while the owner grows memory', async () => {
    resetSharedList();const text=new SharedList('string').pushMany(Array.from({length:1025},(_,i)=>`Request ${i} 日本語`));
    const workers=Array.from({length:2},()=>new Worker(new URL(import.meta.url),{workerData:getWorkerData({text},{copy:false})}));
    const receive=worker=>new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('message',value=>value.error?reject(Error(value.error)):resolve(value));});
    try {
      await Promise.all(workers.map(receive)); text.pushMany(Array.from({length:100000},(_,i)=>'Grow memory '+i));
      const replies=workers.map(receive);for(const worker of workers)worker.postMessage('check');
      assert.deepEqual(await Promise.all(replies),[{ok:true},{ok:true}]);
    } finally {await Promise.all(workers.map(worker=>worker.terminate()));}
  });
}
