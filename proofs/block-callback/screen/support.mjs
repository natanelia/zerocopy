import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync,readdirSync,lstatSync,statSync,realpathSync,mkdirSync,existsSync,copyFileSync} from 'node:fs';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
export const HERE=dirname(fileURLToPath(import.meta.url)),REPO=resolve(HERE,'../../..');
export const hash=data=>createHash('sha256').update(data).digest('hex');
export const readJson=file=>JSON.parse(readFileSync(file,'utf8'));
export const writeJson=(file,value)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file+'.tmp',JSON.stringify(value,null,2)+'\n');renameSync(file+'.tmp',file);};
export const pins=()=>readJson(join(HERE,'pins.json'));
export function inventory(root,skip=()=>false) {
  const files={};function walk(dir){for(const name of readdirSync(dir).sort()){
    const path=join(dir,name),rel=relative(root,path).split(sep).join('/');if(skip(rel))continue;
    const st=lstatSync(path);if(st.isDirectory())walk(path);else {assert(st.isFile(),`Unexpected symlink/nonfile: ${path}`);files[rel]={sha256:hash(readFileSync(path)),bytes:st.size};}
  }}walk(root);return files;
}
export function executable(file){const path=realpathSync(file),bytes=readFileSync(path);return{invoked:file,path,sha256:hash(bytes),bytes:bytes.length};}
export function command(args,cwd=REPO) {const p=spawnSync(args[0],args.slice(1),{cwd,encoding:'utf8'});assert.equal(p.status,0,`${args.join(' ')}: ${p.stderr}`);return p.stdout.trim();}
export function sourceCheck(root,role) {
  const expected=pins().roles[role].files;
  for(const [path,want]of Object.entries(expected)){
    const f=join(root,path),st=lstatSync(f);assert(st.isFile(),`${role}:${path} is not a file`);
    assert.equal(hash(readFileSync(f)),want.sha256,`${role}:${path} source changed`);
    assert.equal(st.mode&0o111,want.mode==='100755'?0o111:0,`${role}:${path} mode changed`);
  }
  const actual=inventory(root,path=>path.split('/').some(x=>['node_modules','.git','dist'].includes(x))||/\.(wasm|wat|tgz)$/.test(path)||path==='bun.lock');
  assert.deepEqual(Object.keys(actual).sort(),Object.keys(expected).sort(),`${role}: extra source inputs`);
  assert.equal(hash(readFileSync(join(root,'bun.lock'))),pins().lockSha256,'Pinned dependency lock changed');
  return {tree:pins().roles[role].tree,inventorySha256:hash(JSON.stringify(expected)),files:Object.keys(expected).length};
}
export function buildCheck(root,role) {
  const p=pins().roles[role],dist=inventory(join(root,'dist'));
  assert.deepEqual(dist,p.expectedDist,`${role}: emitted package mismatch`);
  for(const [name,want]of Object.entries(p.expectedWasm))assert.deepEqual({sha256:hash(readFileSync(join(root,name))),bytes:statSync(join(root,name)).size},want,`${role}:${name} mismatch`);
  return {dist,wasm:p.expectedWasm,packageSha256:hash(readFileSync(join(root,'package.json')))};
}
export function harnessFiles(){
  const files=inventory(HERE,path=>['manifest.json','intent.json'].includes(path));
  for(const path of ['proofs/block-callback/workers.mjs','block-callback.test.ts','.github/workflows/block-callback-screen.yml']){
    const f=join(REPO,path);if(existsSync(f))files['@repo/'+path]={sha256:hash(readFileSync(f)),bytes:statSync(f).size};
  }return files;
}
export function prospective() {return {schema:1,pinsSha256:hash(readFileSync(join(HERE,'pins.json'))),files:harnessFiles(),harnessSha256:hash(JSON.stringify(harnessFiles()))};}
export function verifyHarness(){const frozen=readJson(join(HERE,'manifest.json'));assert.deepEqual(prospective(),frozen,'Frozen harness changed');return frozen;}
export function requireCI(){
  const p=pins();assert.match(p.publication.candidateCommit??'',/^[0-9a-f]{40}$/,'Remote runtime SHA is not frozen');
  assert.equal(process.env.GITHUB_ACTIONS,'true','Execution is CI only');assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1','No reruns');
  assert.equal(process.env.GITHUB_EVENT_NAME,'push');assert.equal(process.env.GITHUB_REF,'refs/heads/'+p.publication.proofBranch);
  const event=readJson(process.env.GITHUB_EVENT_PATH);assert.equal(event.before,p.publication.candidateCommit);assert.equal(event.after,process.env.GITHUB_SHA);assert.equal(event.created,false);assert.equal(event.forced,false);assert.equal(event.deleted,false);
  assert.equal(command(['git','rev-parse','HEAD']),process.env.GITHUB_SHA);assert.equal(command(['git','rev-parse','HEAD^']),p.publication.candidateCommit);
  const tree=command(['git','rev-parse','HEAD^{tree}']),message=command(['git','show','-s','--format=%B','HEAD']);
  assert(message.split('\n').includes(`${p.publication.requiredReviewTrailer}: ${tree}`),'Missing exact reviewed-tree trailer');
  assert.equal(command(['git','rev-parse',p.publication.candidateCommit+'^{tree}']),p.roles.candidate.tree);
  assert.equal(process.versions.node,'22.23.3');assert.equal(process.arch,'x64');assert.equal(process.platform,'linux');
  assert.equal(process.env.NODE_OPTIONS??'','');assert.equal(process.env.BUN_OPTIONS??'','');
  return {commit:process.env.GITHUB_SHA,tree,runId:process.env.GITHUB_RUN_ID,attempt:1,runtime:executable(process.execPath)};
}
export function currentMain(){const actual=command(['git','ls-remote','origin','refs/heads/main']).split(/\s+/)[0];assert.equal(actual,pins().roles.main.localCommit,'Current main changed; re-review rather than silently rebase');return actual;}
export function archiveInputs(root,role,destination){for(const path of Object.keys(pins().roles[role].files)){const target=join(destination,path);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(root,path),target);}}
