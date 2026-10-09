import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CASES,CONFIG} from './protocol.mjs';
import {measureSingle} from './reused/subject.mjs';
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.env.GITHUB_ACTIONS,'true','No local timing');assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');
  assert.equal(process.env.BLOCK_CALLBACK_MEASURE,'reviewed-ci-campaign');assert.equal(process.versions.node,CONFIG.node);assert.equal(process.arch,'x64');assert.equal(process.platform,'linux');
  const request=JSON.parse(readFileSync(process.argv[2],'utf8'));
  assert.deepEqual(request.workload,CASES.find(x=>x.id===request.workload.id));assert(['pilot','measure'].includes(request.phase));
  const {expectedJson,...raw}=await measureSingle(request);
  console.log(JSON.stringify({...raw,digest:createHash('sha256').update(expectedJson).digest('hex'),runtime:process.versions,arch:process.arch,execArgv:process.execArgv}));
}
