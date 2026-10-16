"""Fail-closed provenance checks; no installation, subprocess, or target import.

External trust roots are exact SHA256 pins supplied by the approved invocation.
No local success flag, driver echo, self-issued receipt, or existence of a file
can replace that review. See PREREQUISITES.md for receipt production contracts.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re

from specification import (BASELINE_COMMIT, CANDIDATE_DIFF_SHA256, CANDIDATE_SOURCES,
                           CASE_SHA256, METHOD_SHA256, METHOD_SEAL_SHA256, RUNTIMES,
                           SEQUENCE_SHA256, SUPERVISION_PINS, digest, require)


def sha(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(2**20), b''):
            result.update(block)
    return result.hexdigest()


def hash_string(value):
    return type(value) is str and re.fullmatch('[0-9a-f]{64}', value) is not None


def read_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'duplicate JSON property')
            result[key] = value
        return result
    def invalid_constant(_):
        raise ValueError('nonfinite JSON value')
    return json.loads(Path(path).read_text(), object_pairs_hook=unique, parse_constant=invalid_constant)


def relative_name(value):
    require(type(value) is str and value and '\\' not in value and '\x00' not in value, 'invalid inventory name')
    path = Path(value)
    require(not path.is_absolute() and path.as_posix() == value and all(p not in ('.','..') for p in path.parts),
            'inventory path escape or alias')
    return value


def absolute_path(value, directory=False):
    require(type(value) is str and Path(value).is_absolute(), 'absolute path required')
    path = Path(value)
    require(path == path.resolve(strict=True), 'unresolved path or symlink alias')
    require(path.is_dir() if directory else path.is_file(), 'wrong path kind')
    return path


def inventory(root, excluded=(), allow_links=False):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), 'inventory root must be a real directory')
    result = {}
    for directory, folders, files in os.walk(root, followlinks=False):
        folders[:] = sorted(name for name in folders if name not in excluded)
        for name in sorted(files+[name for name in folders if (Path(directory)/name).is_symlink()]):
            path = Path(directory)/name
            relative = relative_name(path.relative_to(root).as_posix())
            if path.is_symlink():
                require(allow_links and path.resolve(strict=True).is_relative_to(root.resolve()), 'unapproved symlink in inventory')
                result[relative] = {'link':os.readlink(path)}
            else:
                require(path.is_file(), 'nonregular file in inventory')
                result[relative] = {'sha256':sha(path)}
    return result


def plain_inventory(root):
    return {name: value['sha256'] for name,value in inventory(root).items()}


def validate_hash_map(mapping, nonempty=True):
    require(type(mapping) is dict and (mapping or not nonempty), 'missing hash inventory')
    for name, value in mapping.items():
        relative_name(name)
        require(hash_string(value), 'invalid inventory digest')


def verified_json(path, expected_sha256):
    require(hash_string(expected_sha256), 'external expected digest required')
    require(sha(path) == expected_sha256, 'externally pinned document mismatch')
    return read_json(path)


def verify_tree_seal(root, filename, expected_sha256):
    seal = verified_json(root/filename, expected_sha256)
    actual = inventory(root)
    actual.pop(filename, None)
    require(actual == seal, 'evidence tree differs from pinned seal')
    return seal


def verify_final_seal(root, expected_sha256):
    root = absolute_path(str(Path(root).resolve()), directory=True)
    seal = verified_json(root/'FINAL-SEAL.json', expected_sha256)
    require(seal.get('schemaVersion') == 1 and seal.get('methodSHA256') == METHOD_SHA256, 'invalid final seal')
    actual = inventory(root)
    actual.pop('FINAL-SEAL.json', None)
    require(seal.get('files') == actual, 'raw final evidence mismatch')
    return seal


def _terminal_correctness(root, audit):
    require(audit.get('schemaVersion') == 1 and audit.get('kind') == 'native-reader-terminal-correctness-audit', 'wrong correctness audit kind')
    require(audit.get('disposition') == 'successful-terminal-correctness' and audit.get('independent') is True,
            'successful independent terminal correctness audit required')
    require(audit.get('baselineCommit') == BASELINE_COMMIT and audit.get('candidateDiffSHA256') == CANDIDATE_DIFF_SHA256,
            'correctness audit candidate mismatch')
    require(audit.get('candidateSources') == CANDIDATE_SOURCES, 'correctness audit source mismatch')
    verify_tree_seal(root, 'evidence-sha256.json', audit['evidenceSealSHA256'])
    status = read_json(root/'status.json')
    require(status.get('status') == 'complete' and status.get('correctnessOnly') is True and status.get('performanceClaim') is False,
            'correctness run did not complete successfully')
    require(status.get('ownedGroupStillActive') is False and status.get('requiresSuccessfulControllerExit') is True,
            'correctness group custody/terminal requirement missing')
    terminal = audit.get('terminalControllerReceipt', {})
    require(terminal.get('exitCode') == 0 and terminal.get('conclusion') == 'success' and terminal.get('finished') is True,
            'successful terminal controller receipt missing')
    require(type(terminal.get('sourceURL')) is str and terminal['sourceURL'].startswith('https://'), 'terminal receipt source missing')
    require(hash_string(terminal.get('receiptSHA256')) and audit.get('controllerExitIndependentlyVerified') is True,
            'terminal controller exit not independently authenticated')
    checks = audit.get('checks', {})
    for name in ('exactSource', 'fullCorrectnessCoverage', 'perViewCacheRegistryIsolation', 'rawPromotionFailureRetry',
                 'completeBuildProvenance', 'allEmittedFiles', 'nativeBytesAcrossArms', 'runtimeIdentity', 'emptyOwnedGroups',
                 'portableImportClosureReviewed'):
        require(checks.get(name) is True, 'correctness audit prerequisite absent: '+name)
    commands = read_json(root/'commands.json')
    require(type(commands) is list and commands and len({c['label'] for c in commands}) == len(commands), 'correctness command list missing/duplicate')
    require(all(c.get('exitCode') == 0 and c.get('leaderReaped') is True and c.get('descendantsAfterCleanup') == [] and not c.get('failure')
                for c in commands), 'correctness command or cleanup failure')
    cleanup = read_json(root/'cleanup.json')
    require(cleanup.get('ownedGroupStillActive') is False and len(cleanup.get('commands', [])) == len(commands), 'correctness cleanup incomplete')
    inputs, outputs = read_json(root/'inputs.json'), read_json(root/'outputs.json')
    require(inputs.get('baselineCommit') == BASELINE_COMMIT and inputs.get('candidateCommit') == status.get('candidateCommit') == audit.get('candidateCommit'),
            'correctness run/commit binding mismatch')
    require(hash_string(inputs.get('candidateCommit')) is False and re.fullmatch('[0-9a-f]{40}', inputs.get('candidateCommit','')),
            'invalid candidate Git commit')
    source = inputs.get('sourceFiles', {})
    require(set(source) == {'baseline','candidate'}, 'correctness source inventories absent')
    for arm in source:
        validate_hash_map(source[arm])
    require(len(source['baseline']) == 502 and all(source['candidate'].get(name) == value for name,value in CANDIDATE_SOURCES.items()),
            'correctness source inventory mismatch')
    allowed_delta = {'arena.ts','worker.ts','worker.test.ts','native-reader.test.ts','.github/workflows/native-reader-correctness.yml'}
    for name,value in source['baseline'].items():
        require(name in allowed_delta or name.startswith('proofs/native-reader-correctness/') or source['candidate'].get(name) == value,
                'unapproved baseline source change: '+name)
    require(all(name in source['baseline'] or name in allowed_delta or name.startswith('proofs/native-reader-correctness/')
                for name in source['candidate']), 'unapproved added candidate source')
    for engine, pinned in RUNTIMES.items():
        require(all(inputs.get('executables', {}).get(engine, {}).get(key) == value for key,value in pinned.items()), 'correctness runtime mismatch')
    builds = outputs.get('builds', {})
    require(set(builds) == {'baseline','candidate'}, 'both audited build inventories required')
    for arm in builds:
        validate_hash_map(builds[arm])
        require({'dist/shared.js','dist/worker.js'}.issubset(builds[arm]), 'portable entries missing')
        require(plain_inventory(root/'builds'/arm) == builds[arm], 'preserved correctness build bytes mismatch')
    native = lambda arm: {name:value for name,value in builds[arm].items() if name.endswith(('.wasm','.wat'))}
    require(native('baseline') and native('baseline') == native('candidate'), 'native bytes differ across arms')
    provenance = audit.get('buildProvenance', {})
    expected_labels = [f'{arm}-build-{kind}' for arm in ('baseline','candidate') for kind in ('wasm','browser','types')]
    build_commands = [command for command in commands if command['label'] in expected_labels]
    require(len(build_commands) == 6 and provenance.get('commandReceiptsSHA256') == digest(build_commands), 'audited build command provenance mismatch')
    require(provenance.get('dependencyInventorySHA256') == sha(root/'dependencies.json') and
            provenance.get('lockSHA256') == inputs.get('lockSha256'), 'audited locked dependency provenance mismatch')
    for name in ('compilerIdentity', 'compilerOptions', 'buildScripts'):
        require(type(provenance.get(name)) is dict and provenance[name], 'audited compiler/build settings missing: '+name)
    require(provenance.get('ordinaryRepositoryBuild') is True and provenance.get('identicalSettingsAcrossArms') is True,
            'ordinary identical build provenance missing')
    return inputs, outputs


def validate_transport_contract(receipt, preparation, review, method, preparation_sha256):
    """A prospective recipe review binds later custody without reviewing future bytes."""
    require(receipt.get('schemaVersion') == 1 and receipt.get('kind') == 'native-reader-performance-transport' and
            receipt.get('status') == 'complete', 'complete transport receipt missing')
    for flag in ('bounded','noRebuild','noTargetImports','extractionVerified','ownedGroupsEmpty'):
        require(receipt.get(flag) is True, 'transport incomplete: '+flag)
    require(receipt.get('preparationReceiptSHA256') == preparation_sha256, 'transport changed original preparation receipt')
    for field in ('readyInputArchiveSHA256','readyInputInventorySHA256'):
        require(hash_string(preparation.get(field)) and preparation[field] == review.get(field) == receipt.get(field),
                'transport differs from prepared/reviewed bytes: '+field)
    require(hash_string(review.get('reviewedTransportMethodSHA256')) and
            receipt.get('reviewedTransportMethodSHA256') == review['reviewedTransportMethodSHA256'],
            'transport recipe not independently reviewed')
    require(review.get('checks',{}).get('boundedTransportReviewed') is True, 'bounded transport review absent')
    require(type(receipt.get('elapsedSeconds')) in (int,float) and 0 < receipt['elapsedSeconds'] <= 180 and
            receipt.get('wholeCapSeconds') == method.get('wholeCapSeconds') == 180,
            'transport cost exceeds separately reviewed bound or is absent')
    require(hash_string(receipt.get('rawEvidenceSealSHA256')), 'transport custody evidence absent')


def authenticate_transport(manifest, preparation, review):
    receipt_path = absolute_path(manifest['transportReceiptPath'])
    receipt = verified_json(receipt_path, manifest['transportReceiptSHA256'])
    method_path = absolute_path(manifest['transportMethodPath'])
    method = verified_json(method_path, review['reviewedTransportMethodSHA256'])
    validate_transport_contract(receipt, preparation, review, method, manifest['preparationReceiptSHA256'])
    archive = absolute_path(manifest['readyInputArchivePath'])
    inventory_path = absolute_path(manifest['readyInputInventoryPath'])
    require(sha(archive) == preparation['readyInputArchiveSHA256'] and
            sha(inventory_path) == preparation['readyInputInventorySHA256'], 'transport archive/inventory bytes mismatch')
    evidence = absolute_path(manifest['transportEvidenceRoot'], directory=True)
    verify_tree_seal(evidence, 'raw-evidence-seal.json', receipt['rawEvidenceSealSHA256'])
    return {'receipt':receipt, 'evidenceRoot':evidence,
            'inputFiles':{str(receipt_path):manifest['transportReceiptSHA256'],
                          str(method_path):review['reviewedTransportMethodSHA256'],
                          str(archive):preparation['readyInputArchiveSHA256'],
                          str(inventory_path):preparation['readyInputInventorySHA256']}}


def authenticate(manifest_path, expected_manifest_sha256, approval_path, expected_approval_sha256, proof):
    """Called inside the 900-second clock, before ANY target launch."""
    proof = absolute_path(str(proof), directory=True)
    manifest = verified_json(manifest_path, expected_manifest_sha256)
    approval = verified_json(approval_path, expected_approval_sha256)
    require(manifest.get('schemaVersion') == approval.get('schemaVersion') == 1, 'binding schema mismatch')
    require(manifest.get('kind') == 'native-reader-performance-prerequisites', 'wrong prerequisite binding')
    require(approval.get('kind') == 'native-reader-performance-execution-approval' and approval.get('authorized') is True,
            'specific execution approval missing')
    require(approval.get('bindingSHA256') == expected_manifest_sha256 and approval.get('methodSHA256') == METHOD_SHA256,
            'execution approval does not bind this manifest and method')
    require(approval.get('maximumGroups') == 80 and approval.get('wholeStudySeconds') == 900 and approval.get('singleAttempt') is True,
            'execution approval scope mismatch')
    require(type(approval.get('authorizationReference')) is str and approval['authorizationReference'], 'authorization evidence reference missing')
    require(manifest.get('methodSHA256') == METHOD_SHA256 and manifest.get('caseSHA256') == CASE_SHA256 and
            manifest.get('sequenceSHA256') == SEQUENCE_SHA256, 'method/case/sequence binding mismatch')
    require(sha(absolute_path(manifest['methodPath'])) == METHOD_SHA256 and
            sha(absolute_path(manifest['methodSealPath'])) == METHOD_SEAL_SHA256, 'sealed method mismatch')
    for name, expected in SUPERVISION_PINS.items():
        require(sha(proof/name) == expected, 'reviewed supervisor/headroom changed')
    require(manifest.get('candidateDiffSHA256') == CANDIDATE_DIFF_SHA256 and
            sha(absolute_path(manifest['candidateDiffPath'])) == CANDIDATE_DIFF_SHA256, 'candidate diff mismatch')
    audit_path = absolute_path(manifest['correctnessAuditPath'])
    audit = verified_json(audit_path, manifest['correctnessAuditSHA256'])
    root = absolute_path(manifest['correctnessEvidenceRoot'], directory=True)
    inputs, outputs = _terminal_correctness(root, audit)
    baseline_inventory = verified_json(absolute_path(manifest['baselineInventoryPath']),
                                       '9a68795d3c96706ddcad035e7e0cf37c8635753eeb18afe128dbf32ac27f5b59')
    require(inputs['sourceFiles']['baseline'] == baseline_inventory, 'baseline source inventory differs from reviewed method')
    terminal = verified_json(absolute_path(manifest['correctnessTerminalReceiptPath']), audit['terminalControllerReceipt']['receiptSHA256'])
    require(terminal.get('schemaVersion') == 1 and terminal.get('kind') == 'native-reader-correctness-controller-exit' and
            terminal.get('exitCode') == 0 and terminal.get('conclusion') == 'success' and terminal.get('finished') is True,
            'terminal controller evidence absent')
    require(terminal.get('candidateCommit') == audit['candidateCommit'] and terminal.get('evidenceSealSHA256') == audit['evidenceSealSHA256'] and
            terminal.get('sourceURL') == audit['terminalControllerReceipt']['sourceURL'], 'terminal controller receipt run mismatch')
    review = verified_json(absolute_path(manifest['performanceReviewPath']), manifest['performanceReviewSHA256'])
    require(review.get('schemaVersion') == 1 and review.get('kind') == 'native-reader-performance-implementation-audit' and
            review.get('disposition') == 'source-clear-for-exact-bound-execution' and review.get('independent') is True,
            'exact independent implementation review absent')
    require(review.get('methodSHA256') == METHOD_SHA256 and review.get('caseSHA256') == CASE_SHA256 and
            review.get('sequenceSHA256') == SEQUENCE_SHA256 and review.get('correctnessAuditSHA256') == manifest['correctnessAuditSHA256'],
            'implementation review provenance binding mismatch')
    proof_files = plain_inventory(proof)
    require(manifest.get('proofFiles') == review.get('proofFiles') == proof_files, 'driver/controller/analyzer source changed after review')
    for flag in ('completeDriverAnalyzerReview','unmodifiedSupervision','exactMeasurementProtocol','prerequisiteAuthentication','boundedPreparationReviewed'):
        require(review.get('checks', {}).get(flag) is True, 'implementation review incomplete: '+flag)
    require(review.get('builds') == outputs['builds'] and review.get('runtimes') == RUNTIMES, 'implementation review build/runtime mismatch')
    preparation = verified_json(absolute_path(manifest['preparationReceiptPath']), manifest['preparationReceiptSHA256'])
    require(preparation.get('schemaVersion') == 1 and preparation.get('status') == 'complete' and preparation.get('bounded') is True,
            'bounded prerequisite preparation receipt missing')
    require(preparation.get('correctnessAuditSHA256') == manifest['correctnessAuditSHA256'] and
            preparation.get('builds') == outputs['builds'] and preparation.get('noRebuild') is True,
            'preparation must preserve the exact audited build')
    require(type(preparation.get('elapsedSeconds')) in (int,float) and 0 <= preparation['elapsedSeconds'] < float('inf') and
            preparation.get('ownedGroupsEmpty') is True, 'preparation cost/cleanup absent')
    require(type(preparation.get('wholeCapSeconds')) in (int,float) and 0 < preparation['elapsedSeconds'] <= preparation['wholeCapSeconds'] and
            hash_string(preparation.get('reviewedPreparationMethodSHA256')) and hash_string(preparation.get('rawEvidenceSealSHA256')),
            'separately bounded/reviewed preparation provenance absent')
    require(review.get('preparationReceiptSHA256') == manifest['preparationReceiptSHA256'], 'preparation not reviewed')
    transport = authenticate_transport(manifest, preparation, review)
    paths = {'proof':proof, 'artifacts':{}, 'sources':{}, 'runtimes':{}, 'dependencies':None}
    import_roots = {}
    for arm in ('baseline','candidate'):
        artifact = absolute_path(manifest['artifactRoots'][arm], directory=True)
        source = absolute_path(manifest['sourceRoots'][arm], directory=True)
        # The untouched audited package.json preserves ordinary .js ESM package
        # resolution. It is copied verbatim from authenticated source, never made
        # up to make isolated portable files import successfully.
        import_roots[arm] = {**outputs['builds'][arm], 'package.json':inputs['sourceFiles'][arm]['package.json']}
        require(plain_inventory(artifact) == import_roots[arm], 'timing import root differs from audited build/package context')
        require(read_json(artifact/'package.json').get('type') == 'module', 'audited ESM package context missing')
        require(plain_inventory(source) == inputs['sourceFiles'][arm], 'full source snapshot differs from audited source')
        paths['artifacts'][arm], paths['sources'][arm] = artifact,source
        for name in ('persistent-core.wasm','numeric-kernels.wasm','numeric-kernels-simd.wasm','geometry-kernels.wasm'):
            require(name in outputs['builds'][arm] and (artifact/name).read_bytes()[:8] == b'\0asm\1\0\0\0', 'native module bytes missing')
            encoded = base64.b64encode((artifact/name).read_bytes())
            js = [artifact/name for name in outputs['builds'][arm] if name.startswith('dist/') and name.endswith('.js')]
            require(any(encoded in path.read_bytes() for path in js), 'native bytes absent from portable artifacts')
    dependencies = absolute_path(manifest['dependencyRoot'], directory=True)
    dependency_inventory = read_json(root/'dependencies.json')
    require(inventory(dependencies, ('.vite','.vite-temp','.cache'), True) == dependency_inventory, 'installed locked dependency bytes mismatch')
    paths['dependencies'] = dependencies
    require(sha(absolute_path(manifest['lockPath'])) == inputs['lockSha256'], 'lockfile mismatch')
    for engine,pinned in RUNTIMES.items():
        runtime = absolute_path(manifest['runtimePaths'][engine])
        require(os.access(runtime,os.X_OK) and sha(runtime) == pinned['sha256'], 'runtime bytes mismatch')
        paths['runtimes'][engine] = runtime
    require(approval.get('performanceReviewSHA256') == manifest['performanceReviewSHA256'] and
            approval.get('correctnessAuditSHA256') == manifest['correctnessAuditSHA256'], 'approval audit chain mismatch')
    return {'manifest':manifest, 'approval':approval, 'paths':paths, 'inputs':inputs, 'outputs':outputs,
            'dependencyInventory':dependency_inventory, 'proofFiles':proof_files, 'importRootFiles':import_roots,
            'preparation':preparation, 'transport':transport, 'bindingSHA256':expected_manifest_sha256,
            'approvalSHA256':expected_approval_sha256}


def reauthenticate(binding, full=False):
    """Every launch/return rehashes executable subjects; final check includes inputs."""
    paths = binding['paths']
    require(plain_inventory(paths['proof']) == binding['proofFiles'], 'performance source changed during study')
    for engine,path in paths['runtimes'].items():
        require(sha(path) == RUNTIMES[engine]['sha256'], 'runtime changed during study')
    for arm,path in paths['artifacts'].items():
        require(plain_inventory(path) == binding['importRootFiles'][arm], 'build/package import context changed during study')
    if full:
        for path, expected in binding['transport']['inputFiles'].items():
            require(sha(path) == expected, 'transport input changed during study')
        verify_tree_seal(binding['transport']['evidenceRoot'], 'raw-evidence-seal.json',
                         binding['transport']['receipt']['rawEvidenceSealSHA256'])
        for arm,path in paths['sources'].items():
            require(plain_inventory(path) == binding['inputs']['sourceFiles'][arm], 'source changed during study')
        require(inventory(paths['dependencies'], ('.vite','.vite-temp','.cache'), True) == binding['dependencyInventory'],
                'dependency bytes changed during study')
    return True
