from pathlib import Path
import json, os, subprocess
root=Path('/workspace/scratch/e7ec22ef2609')
out=Path('/workspace/shared/zerocopy-heap-compaction-records-20261009/first-screen')
node=root/'zerocopy-node22-tools/node_modules/.bin/node'
bun=root/'zerocopy-tools/node_modules/.bin/bun'
assert subprocess.check_output([str(node),'--version'],text=True).strip()=='v22.23.3'
assert subprocess.check_output([str(bun),'--version'],text=True).strip()=='1.4.2'
arms={'baseline':root/'zerocopy-heap-compaction-baseline-20261009','candidate':root/'zerocopy-heap-compaction-records-20261009'}
steps=[
 ('build-wasm',['node','scripts/build-wasm.mjs']),
 ('build-portable',['bun','scripts/build-browser.ts']),
 ('build-types',['node','node_modules/typescript/bin/tsc','--emitDeclarationOnly','--noEmit','false','--declarationMap','false','--outDir','dist/types']),
 ('types-main',['node','node_modules/typescript/bin/tsc','--noEmit']),
 ('types-redux',['node','node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.redux.json']),
 ('types-values',['node','node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.typed-values.json']),
 ('types-values-loose-optional',['node','node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.typed-values.json','--exactOptionalPropertyTypes','false']),
 ('types-geometry',['node','node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.geometry.json']),
 ('types-worker',['node','node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.worker.json']),
 ('unit-standard',['bun','run','test']),
 ('worker-tasks',['node','--test','proofs/worker-tasks.mjs']),
 ('list-query',['node','--test','proofs/list-query.mjs']),
 ('list-query-regression',['node','--test','proofs/list-query-regression.mjs']),
 ('memory-startup',['node','--test','proofs/memory-startup.mjs']),
 ('node-worker',['node','proofs/node-worker.mjs']),
 ('redux-node',['node','proofs/redux-node.mjs']),
 ('typed-json-worker',['node','proofs/typed-json-worker.mjs']),
 ('package',['node','scripts/check-package.mjs']),
]
records=[]
for stage,command in steps:
  for arm,cwd in arms.items():
    directory=out/'standard-gates'/arm; directory.mkdir(parents=True,exist_ok=True)
    env=os.environ.copy();env['PATH']=f'{node.parent}:{bun.parent}:'+env.get('PATH','')
    env['npm_config_cache']=str(out/'caches'/arm/'npm');env['BUN_INSTALL_CACHE_DIR']=str(out/'caches'/arm/'bun')
    log=directory/(stage+'.log')
    record={'arm':arm,'stage':stage,'command':command,'cwd':str(cwd),'log':str(log),'nodeVersion':'v22.23.3','bunVersion':'1.4.2'}
    print(json.dumps({'start':stage,'arm':arm}),flush=True)
    with log.open('w') as stream:
      try:
        result=subprocess.run(command,cwd=cwd,env=env,stdout=stream,stderr=subprocess.STDOUT,timeout=300)
        record['exitCode']=result.returncode
      except subprocess.TimeoutExpired:
        record['exitCode']=None;record['timeout']=True
    records.append(record)
    (out/'standard-gates.json').write_text(json.dumps({'passed':all(r['exitCode']==0 for r in records),'complete':False,'records':records},indent=2)+'\n')
    print(json.dumps({'finish':stage,'arm':arm,'exitCode':record['exitCode']}),flush=True)
    if record['exitCode']!=0:
      print(log.read_text()[-16000:],flush=True)
      raise SystemExit(1)
(out/'standard-gates.json').write_text(json.dumps({'passed':True,'complete':True,'records':records},indent=2)+'\n')
print(json.dumps({'passed':True,'stagesPerArm':len(steps),'arms':2}),flush=True)
