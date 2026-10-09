import assert from 'node:assert/strict';
import {readFileSync,lstatSync,realpathSync,writeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {runCore} from './core.mjs';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
const manifest=JSON.parse(readFileSync(config.manifestPath,'utf8'));
assert.equal(createHash('sha256').update(readFileSync(config.manifestPath)).digest('hex'),config.manifestSha256);
assert.equal(config.admitted,true);assert.equal(config.lane,process.arch);assert.equal(process.platform,'linux');
assert.equal(config.runtime,typeof Bun==='undefined'?'node':'bun');
assert.equal(config.runtime==='node'?process.version:Bun.version,config.protocol.runtimeVersions[config.runtime]);
const dist=path.join(manifest.sources[config.arm].path,'dist');assert.equal(dist,config.dist);
assert.equal(realpathSync(dist),dist);
for(const name of ['numeric.js','numeric-scalar-control.mjs'])assert(lstatSync(path.join(dist,name)).isFile());
assert.notEqual(lstatSync(path.join(dist,'numeric.js')).ino,lstatSync(path.join(dist,'numeric-scalar-control.mjs')).ino);
assert(readFileSync(path.join(dist,'numeric.js')).equals(readFileSync(path.join(dist,'numeric-scalar-control.mjs'))));
const emit=row=>writeSync(1,JSON.stringify(row)+'\n');
const now=performance.now.bind(performance);
if(config.mode==='untimed')Object.defineProperty(performance,'now',{value:()=>{throw Error('Untimed operation clocks forbidden');},configurable:true});
let highRss=0;
await runCore(config,{
  importModule:name=>import(pathToFileURL(path.join(dist,name)).href),
  sha256:bytes=>createHash('sha256').update(bytes).digest('hex'),emit,now,
  gcKind:'explicit inherited Node/Bun collection',collect:()=>{if(config.runtime==='bun')Bun.gc(true);else{assert.equal(typeof globalThis.gc,'function');globalThis.gc();}},
  memory:()=>{const m=process.memoryUsage();highRss=Math.max(highRss,m.rss);assert(m.rss<=config.protocol.memory.maximumSubjectRssBytes);return m;}
});
emit({kind:'process-complete',pid:process.pid,version:config.runtime==='node'?process.version:Bun.version,highRss,resourceUsage:process.resourceUsage(),resourceUnits:config.protocol.resourceUnits});
