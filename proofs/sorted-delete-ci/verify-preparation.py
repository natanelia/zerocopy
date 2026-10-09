"""Read-only exact-source/retained-build provenance. No build, import or subject run."""
import argparse, hashlib, json, pathlib, subprocess

HERE = pathlib.Path(__file__).resolve().parent
ORIGIN = json.loads((HERE/'origin.json').read_text())
def digest(path):
    value = hashlib.sha256()
    with pathlib.Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''): value.update(chunk)
    return value.hexdigest()
def git(repo, *args): return subprocess.check_output(['git','-C',str(repo),*args])
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--reviewed-repair',type=pathlib.Path,required=True)
    parser.add_argument('--repository',type=pathlib.Path,required=True)
    parser.add_argument('--output',type=pathlib.Path,required=True)
    args=parser.parse_args(); assert not args.output.exists(), 'Never replace original provenance evidence'
    repair=args.reviewed_repair.resolve(); manifest_path=repair/'MANIFEST.json'
    assert digest(manifest_path)==ORIGIN['reviewedRepairManifestSha256']
    manifest=json.loads(manifest_path.read_text())
    verified=[]
    for name, expected in manifest['files'].items():
        candidate=(repair/name).resolve()
        assert candidate.is_relative_to(repair)
        assert candidate.stat().st_size==expected['bytes'], name
        assert digest(candidate)==expected['sha256'], name
        verified.append(name)
    arms={}
    for arm in ('baseline','candidate'):
        head=ORIGIN[arm+'Commit']; artifact=repair/'artifacts'/arm
        assert git(args.repository,'rev-parse',head+'^{tree}').decode().strip()==ORIGIN[arm+'Tree']
        source_records=[]; build_records=[]; separately_recorded=[]
        for source in sorted(artifact.rglob('*')):
            if not source.is_file(): continue
            name=source.relative_to(artifact).as_posix()
            item={'path':name,'bytes':source.stat().st_size,'sha256':digest(source)}
            if name.startswith('dist/') or name.endswith('.wasm'):
                build_records.append(item); continue
            if arm=='baseline' and name=='sorted-delete.test.ts':
                # The focused author packet ran the common new regressions on both arms.
                separately_recorded.append({**item,'role':'historical common focused-test overlay, not baseline source'})
                continue
            raw=git(args.repository,'show',head+':'+name)
            assert hashlib.sha256(raw).hexdigest()==item['sha256'], arm+'/'+name
            source_records.append(item)
        for name, expected in ORIGIN['sourceHashes'][arm].items(): assert digest(artifact/name)==expected
        for name, expected in ORIGIN['expectedWasm'][arm].items():
            # The archive stores four unique modules; expected aliases are verified below.
            if (artifact/name).exists(): assert digest(artifact/name)==expected
            else: assert name in ORIGIN['coreAliases'] and digest(artifact/'persistent-core.wasm')==expected
        assert len(list((artifact/'dist').glob('*.js')))==12
        arms[arm]={'commit':head,'tree':ORIGIN[arm+'Tree'],'entrypoint':str(artifact/'dist/shared.js'),
            'sourceFilesMatchedToGit':source_records,'retainedBuilds':build_records,'historicalOverlay':separately_recorded,
            'freshBuild':False,'freshStandardGate':False}
    analysis=json.loads((repair/'build-analysis.json').read_text())
    tools={}
    for name, item in analysis['tools'].items():
        assert digest(item['path'])==item['sha256'], 'Changed pinned runtime: '+name
        tools[name]=item
    upstream={}
    for name in ORIGIN['byteIdenticalFiles']:
        expected=next(x for x in ORIGIN['upstreamFiles'] if x['path']==name)
        assert digest(HERE/name)==expected['sha256']; upstream[name]=expected['sha256']
    result={'scope':'Preparation-only exact retained-build/source provenance, never fresh hosted admission',
        'operationClocks':False,'subjectsRun':False,'buildsRun':False,'freshStandardGatesRun':False,
        'reviewedRepairManifest':str(manifest_path),'reviewedRepairManifestSha256':digest(manifest_path),
        'verifiedManifestFiles':len(verified),'arms':arms,'runtimeBinaries':tools,
        'unchangedControllerAndMath':upstream,'originalFailureEvidencePreserved':True}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    with args.output.open('x') as stream: json.dump(result,stream,indent=2);stream.write('\n')
    print(json.dumps({'verified':True,'manifestFiles':len(verified),'output':str(args.output),'operationClocks':False,'subjectsRun':False}))
if __name__=='__main__':main()
