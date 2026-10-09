"""Read-only source/retained-build checks. No compiler, arm import, subject or clock."""
import argparse,hashlib,json,pathlib,subprocess
from artifact_checks import verify_build_pair

HERE=pathlib.Path(__file__).resolve().parent
ORIGIN=json.loads((HERE/'origin.json').read_text())
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def git(repo,*args):return subprocess.check_output(['git','-C',str(repo),*args])
def main():
    p=argparse.ArgumentParser()
    p.add_argument('--repository',type=pathlib.Path,required=True)
    p.add_argument('--retained-baseline',type=pathlib.Path,required=True)
    p.add_argument('--retained-candidate',type=pathlib.Path,required=True)
    p.add_argument('--output',type=pathlib.Path,required=True)
    a=p.parse_args();assert not a.output.exists()
    o=ORIGIN;repo=a.repository
    assert git(repo,'rev-parse',o['candidateCommit']+'^').decode().strip()==o['baselineCommit']
    assert git(repo,'rev-parse',o['baselineCommit']+'^').decode().strip()==o['historicalBaselineCommit']
    changes=git(repo,'diff','--name-only',o['historicalBaselineCommit'],o['baselineCommit']).decode().splitlines()
    assert changes==o['mainDocumentationChanges']
    assert git(repo,'diff','--name-only',o['baselineCommit'],o['candidateCommit']).decode().splitlines()==['numeric-kernels.as.ts']
    patch=git(repo,'diff',o['baselineCommit'],o['candidateCommit'],'--','numeric-kernels.as.ts')
    assert hashlib.sha256(patch).hexdigest()==o['runtimePatchSha256']==sha(HERE/'runtime.patch')
    for arm,retained in [('baseline',a.retained_baseline),('candidate',a.retained_candidate)]:
        assert git(repo,'rev-parse',o[arm+'Commit']+'^{tree}').decode().strip()==o[arm+'Tree']
        for name,expected in o['sourceHashes'][arm].items():
            assert hashlib.sha256(git(repo,'show',o[arm+'Commit']+':'+name)).hexdigest()==expected
            assert sha(retained/name)==expected
    assert sha(HERE/'correctness-v2.mjs')==o['correctnessV2Sha256']
    for record in o['upstreamFiles']:assert sha(HERE/record['path'])==record['sha256']
    history=json.loads((HERE/'history/manifest.json').read_text())
    for record in history['files']:
        target=HERE/'history'/record['path'];assert target.stat().st_size==record['bytes'];assert sha(target)==record['sha256']
    builds=verify_build_pair(a.retained_baseline,a.retained_candidate,o)
    result={'sourceChainVerified':True,'currentMainDocumentationChanges':changes,
        'sourceRuntimeEquivalentToHistorical':True,'retainedBuildComparison':builds,
        'historyFilesVerified':len(history['files']),'upstreamFilesVerified':o['upstreamFiles'],
        'freshBuilds':False,'freshGates':False,'armImports':False,'subjectsRun':False,'operationClocks':False}
    a.output.parent.mkdir(parents=True,exist_ok=True)
    with a.output.open('x') as output:json.dump(result,output,indent=2);output.write('\n')
    print(json.dumps({'verified':True,'output':str(a.output),'freshBuilds':False,'subjectsRun':False,'operationClocks':False}))
if __name__=='__main__':main()
