"""Resolve reviewed final-host paths and the fresh transport receipt; no targets."""
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native-reader-performance'))
from authentication import (absolute_path, hash_string, plain_inventory, read_json,
                            relative_name, sha, validate_hash_map, validate_transport_contract, verified_json)
from specification import (BASELINE_COMMIT, CANDIDATE_DIFF_SHA256, CASE_SHA256,
                           METHOD_SHA256, SEQUENCE_SHA256, require)

BRANCH = 'proof/native-reader-reuse-performance-20261016'
PERFORMANCE_SEAL = '4624c4a2908980f2cacc218b45e2641776760be41e97cd80ede44fee48e331ed'
REVIEW = 'native-reader-bindings/performance-review.json'
SUPPORT = {'native-reader-bindings/' + name for name in
           ('METHOD-v2-SEAL.json','candidate.diff','correctness-audit.json','correctness-terminal.json','performance-review.json')}
RELEASE_KEYS = {'schemaVersion','kind','sealed','authorized','authorizationReference','repository','publicationBranch',
                'requiredBranchBefore','singleAttempt','exclusiveStudyHost','maximumGroups','wholeStudySeconds',
                'performanceImplementationSealSHA256','compositionFiles','supportFiles','performanceProofFiles','transportBinding'}
TRANSPORT_KEYS = {'schemaVersion','sealed','singleAttempt','authorizationReference','methodSHA256','proofFiles','repository',
                  'runId','artifactId','artifactName','artifactZipSHA256','artifactFiles','sourceCommit','kind',
                  'finalStudyHostExclusive','preparationPrefix','preparationReceiptSHA256','readyInputArchiveSHA256',
                  'readyInputInventorySHA256','reviewedTransportMethodSHA256','performanceReviewPath','performanceReviewSHA256','readyInputRegularBytes'}


def validate_release(release):
    require(set(release) == RELEASE_KEYS, 'Unknown or missing release field')
    require(release['schemaVersion'] == 1 and release['kind'] == 'native-reader-performance-workflow-release' and
            release['sealed'] is True and release['authorized'] is True, 'Unresolved source-only release')
    require(release['repository'] == 'natanelia/zerocopy' and release['publicationBranch'] == BRANCH and
            release['requiredBranchBefore'] == BASELINE_COMMIT, 'Exact first branch advance required')
    require(release['singleAttempt'] is True and release['exclusiveStudyHost'] is True and
            release['maximumGroups'] == 80 and release['wholeStudySeconds'] == 900 and
            release['performanceImplementationSealSHA256'] == PERFORMANCE_SEAL, 'Released study scope changed')
    require(type(release['authorizationReference']) is str and release['authorizationReference'], 'Existing authorization reference required')
    require(set(release['supportFiles']) == SUPPORT and all(hash_string(v) for v in release['supportFiles'].values()), 'Unresolved support pins')
    transport = release['transportBinding']
    require(set(transport) == TRANSPORT_KEYS and transport['performanceReviewPath'] == REVIEW, 'Unknown transport field or path substitution')
    require(transport['schemaVersion'] == 1 and transport['kind'] == 'native-reader-transport-inputs' and
            transport['sealed'] is True and transport['singleAttempt'] is True and transport['finalStudyHostExclusive'] is True and
            transport['methodSHA256'] == METHOD_SHA256 and transport['repository'] == release['repository'] and
            transport['authorizationReference'] == release['authorizationReference'], 'Transport release scope mismatch')
    require(transport['performanceReviewSHA256'] == release['supportFiles'][REVIEW], 'Review pin mismatch')
    for field in ('preparationReceiptSHA256','readyInputArchiveSHA256','readyInputInventorySHA256','reviewedTransportMethodSHA256','artifactZipSHA256'):
        require(hash_string(transport[field]), 'Unresolved transport pin: '+field)
    relative_name(transport['preparationPrefix'])
    validate_hash_map(transport['artifactFiles'])
    require(all(type(transport[field]) is int and transport[field] > 0 for field in ('runId','artifactId','readyInputRegularBytes')),
            'Unresolved official artifact identity or sizing')
    return transport


def transport_binding(release, workspace):
    original = validate_release(release)
    # The only changed transport-binding value is this exact documented path.
    return {**original, 'performanceReviewPath':str(workspace / REVIEW)}


def performance_documents(release, workspace, runner, receipt, receipt_sha, review, preparation):
    t = validate_release(release)
    require(hash_string(receipt_sha), 'Actual fresh transport receipt digest required')
    for field in ('readyInputArchiveSHA256','readyInputInventorySHA256','reviewedTransportMethodSHA256'):
        require(review.get(field) == t[field], 'Prepared/reviewed pin changed: '+field)
    validate_transport_contract(receipt, preparation, review, {'wholeCapSeconds':180}, t['preparationReceiptSHA256'])
    out = runner / 'native-reader-transport-output'; ready = out / 'ready'
    manifest = {'schemaVersion':1,'kind':'native-reader-performance-prerequisites',
        'methodSHA256':METHOD_SHA256,'methodPath':str(workspace/'proofs/native-reader-performance/METHOD.md'),
        'methodSealPath':str(workspace/'native-reader-bindings/METHOD-v2-SEAL.json'),
        'candidateDiffSHA256':CANDIDATE_DIFF_SHA256,'candidateDiffPath':str(workspace/'native-reader-bindings/candidate.diff'),
        'baselineInventoryPath':str(workspace/'proofs/native-reader-preparation/baseline-sources.json'),
        'caseSHA256':CASE_SHA256,'sequenceSHA256':SEQUENCE_SHA256,
        'correctnessEvidenceRoot':str(ready/'correctness'),'correctnessAuditPath':str(ready/'correctness-audit.json'),
        'correctnessAuditSHA256':release['supportFiles']['native-reader-bindings/correctness-audit.json'],
        'correctnessTerminalReceiptPath':str(ready/'correctness-terminal.json'),
        'performanceReviewPath':str(workspace/REVIEW),'performanceReviewSHA256':t['performanceReviewSHA256'],
        'preparationReceiptPath':str(out/'preparation-receipt.json'),'preparationReceiptSHA256':t['preparationReceiptSHA256'],
        'readyInputArchivePath':str(out/'ready-inputs.tar'),'readyInputInventoryPath':str(out/'raw/ready-inventory.json'),
        'transportMethodPath':str(out/'raw/transport-method.json'),'transportReceiptPath':str(out/'transport-receipt.json'),
        'transportReceiptSHA256':receipt_sha,'transportEvidenceRoot':str(out/'raw'),
        'proofFiles':release['performanceProofFiles'],
        'artifactRoots':{arm:str(ready/'artifacts'/arm) for arm in ('baseline','candidate')},
        'sourceRoots':{arm:str(ready/'sources'/arm) for arm in ('baseline','candidate')},
        'dependencyRoot':str(ready/'dependencies/node_modules'),'lockPath':str(ready/'dependencies/package-lock.json'),
        'runtimePaths':{engine:str(ready/'runtimes'/engine) for engine in ('node','bun')}}
    approval = {'schemaVersion':1,'kind':'native-reader-performance-execution-approval','authorized':True,
        'methodSHA256':METHOD_SHA256,'correctnessAuditSHA256':manifest['correctnessAuditSHA256'],
        'performanceReviewSHA256':t['performanceReviewSHA256'],'maximumGroups':80,'wholeStudySeconds':900,
        'singleAttempt':True,'exclusiveStudyHost':True,'authorizationReference':release['authorizationReference']}
    return manifest, approval


def write(path, value):
    require(not path.exists(), 'Composition output already exists; no retries')
    path.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False)+'\n')
    return sha(path)


def main():
    require(len(sys.argv) == 4 and sys.argv[1] in ('transport','performance'), 'Expected stage, release and external release digest')
    stage, release_name, pin = sys.argv[1:]
    workspace = absolute_path(os.environ['GITHUB_WORKSPACE'], directory=True)
    runner = absolute_path(os.environ['RUNNER_TEMP'], directory=True)
    require(workspace == Path(__file__).resolve().parents[2], 'Unexpected checkout root')
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REPOSITORY') == 'natanelia/zerocopy' and
            os.environ.get('GITHUB_EVENT_NAME') == 'push' and os.environ.get('GITHUB_RUN_ATTEMPT') == '1' and
            os.environ.get('GITHUB_REF') == 'refs/heads/'+BRANCH and
            read_json(os.environ['GITHUB_EVENT_PATH'])['before'] == BASELINE_COMMIT, 'Single exact first branch advance required')
    require(not os.environ.get('GH_TOKEN') and not os.environ.get('GITHUB_TOKEN'), 'Composition is tokenless')
    release_path = absolute_path(str(Path(release_name).resolve(strict=True)))
    require(release_path == workspace/'native-reader-bindings/SCREEN-RELEASE.json', 'Unexpected release path')
    release = verified_json(release_path, pin); t = validate_release(release)
    for folder, expected in [('native-reader-performance',release['performanceProofFiles']),
                             ('native-reader-preparation',t['proofFiles']),('native-reader-screen-release',release['compositionFiles'])]:
        require(plain_inventory(workspace/'proofs'/folder) == expected, 'Reviewed source inventory changed: '+folder)
    for name, expected in release['supportFiles'].items():
        require(sha(absolute_path(str(workspace/name))) == expected, 'Support bytes changed: '+name)
    output = runner/'native-reader-screen-release-output'
    if stage == 'transport':
        require(not output.exists(), 'Fresh release output required'); output.mkdir(mode=0o700)
        (output/'SCREEN-RELEASE.json').write_bytes(release_path.read_bytes())
        write(output/'host-context.json', {key:os.environ[key] for key in ('GITHUB_REPOSITORY','GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_REF')})
        results = {'transport_binding_sha256':write(output/'transport-binding.json', transport_binding(release,workspace))}
    else:
        require(output.is_dir() and sha(output/'SCREEN-RELEASE.json') == pin, 'Original release changed')
        root = runner/'native-reader-transport-output'
        receipt_path = absolute_path(str(root/'transport-receipt.json')); receipt_sha = sha(receipt_path)
        receipt = verified_json(receipt_path, receipt_sha)
        preparation = verified_json(root/'preparation-receipt.json', t['preparationReceiptSHA256'])
        review = verified_json(workspace/REVIEW, t['performanceReviewSHA256'])
        require(sha(root/'raw/raw-evidence-seal.json') == receipt['rawEvidenceSealSHA256'], 'Fresh transport seal mismatch')
        status = read_json(root/'raw/status.json')
        require(status.get('status') == 'complete' and status.get('ownedGroupStillActive') is False, 'Transport terminal state incomplete')
        manifest, approval = performance_documents(release,workspace,runner,receipt,receipt_sha,review,preparation)
        binding_sha = write(output/'performance-binding.json',manifest)
        approval['bindingSHA256'] = binding_sha
        results = {'performance_binding_sha256':binding_sha,'execution_approval_sha256':write(output/'execution-approval.json',approval)}
        write(output/'receipt-substitution.json',{'releaseSHA256':pin,'transportReceiptSHA256':receipt_sha,
            'preparationReceiptSHA256':t['preparationReceiptSHA256'],'completeInputAuthentication':'required inside unchanged 900-second controller'})
    with open(os.environ['GITHUB_OUTPUT'],'a') as stream:
        for key,value in results.items(): stream.write(key+'='+value+'\n')


if __name__ == '__main__':
    main()
