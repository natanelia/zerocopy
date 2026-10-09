"""Read-only evidence admission. No library imports, subjects, or operation clocks.

The checkout's sealed packet and current original CI run are the trust anchor.
Archived paths are translated only through the original root recorded in run.json.
Artifact inventories cover every regular archived file except the inventory itself
and its preservation receipt. Those two receipts are validated explicitly.
"""
import argparse
import hashlib
import json
import math
import os
import pathlib
import re
import subprocess
import sys
import tarfile

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
ARMS = ('baseline', 'candidate')
BROWSERS = ('chromium', 'firefox', 'webkit')
RUN_KEYS = ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'GITHUB_WORKFLOW_SHA', 'GITHUB_REPOSITORY', 'GITHUB_REF')
FROZEN = ('protocol.json', 'core.mjs', 'launch-guard.mjs', 'node-subject.mjs', 'browser-subject.mjs',
          'browser-semantics.mjs', 'semantic-worker.mjs', 'math.mjs', 'controller.py', 'run.py',
          'report.mjs', 'ci.py', 'artifact_checks.py', 'origin.json', 'correctness-v2.mjs',
          'inventory-browsers.mjs', 'packet.json', 'evidence.py', 'expected-fixtures.json',
          'artifact_admission.py', 'resource_ownership.py', 'engine-ownership.mjs')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def nonempty(value, label):
    require(type(value) is str and bool(value.strip()) and value == value.strip(), label + ' must be a nonempty string')
    return value


def number(value, label, minimum=0):
    require(type(value) in (int, float) and math.isfinite(value) and value >= minimum, label + ' must be finite and in range')
    return value


def integer(value, label, minimum=0):
    require(type(value) is int and value >= minimum, label + ' must be an integer in range')
    return value


def hexid(value, length, label):
    require(type(value) is str and re.fullmatch('[0-9a-f]{' + str(length) + '}', value) is not None, 'Invalid ' + label)
    return value


def digest(data):
    return hashlib.sha256(data).hexdigest()


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key: ' + key)
        result[key] = value
    return result


def decode(data):
    def finite_float(value):
        result = float(value)
        require(math.isfinite(result), 'Nonfinite JSON number')
        return result
    return json.loads(data, object_pairs_hook=_pairs, parse_float=finite_float, parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Nonfinite JSON: ' + value)))


def read(path):
    return decode(pathlib.Path(path).read_bytes())


def relative(value):
    nonempty(value, 'Relative path')
    path = pathlib.PurePosixPath(value)
    require(bool(path.parts) and not path.is_absolute() and value == path.as_posix() and all(p not in ('.', '..') for p in path.parts) and '\\' not in value, 'Unsafe or noncanonical relative path: ' + value)
    return value


def absolute(value):
    nonempty(value, 'Absolute path')
    path = pathlib.PurePosixPath(value)
    require(path.is_absolute() and value == path.as_posix() and '..' not in path.parts and '\\' not in value, 'Unsafe or noncanonical absolute path: ' + value)
    return path


def entries(values, label, absolute_paths=False):
    require(type(values) is list and bool(values), label + ' must be a nonempty inventory')
    result = {}
    for entry in values:
        require(type(entry) is dict, label + ' entry must be an object')
        name = entry.get('path')
        (absolute if absolute_paths else relative)(name)
        require(name not in result, label + ' contains duplicate path: ' + name)
        hexid(entry.get('sha256'), 64, label + ' SHA-256')
        integer(entry.get('bytes'), label + ' byte count')
        result[name] = entry
    return result


def verify_bytes(data, entry, label):
    require(len(data) == entry['bytes'] and digest(data) == entry['sha256'], 'Digest/size mismatch: ' + label)


def regular_files(root):
    root = pathlib.Path(root)
    require(root.is_dir() and not root.is_symlink(), 'Artifact directory missing or symbolic')
    result = set()
    for directory, dirs, names in os.walk(root, followlinks=False):
        for name in dirs:
            require(not (pathlib.Path(directory) / name).is_symlink(), 'Symbolic artifact directory')
        for name in names:
            item = pathlib.Path(directory) / name
            require(item.is_file() and not item.is_symlink(), 'Non-regular artifact: ' + str(item))
            result.add(item.relative_to(root).as_posix())
    return result


def validate_inventory(root):
    root = pathlib.Path(root)
    actual = regular_files(root)
    require({'artifact-inventory.json', 'preservation.json'} <= actual, 'Missing artifact inventory/preservation')
    inventory = read(root / 'artifact-inventory.json')
    require(inventory.get('quiescence') == 'verified-from-owned-receipts' and inventory.get('originalAttemptFilesIncluded') is True, 'Inventory is not an original quiescent attempt')
    listed = entries(inventory.get('files'), 'Artifact')
    require(set(listed) == actual - {'artifact-inventory.json', 'preservation.json'}, 'Artifact inventory is not the exact archived file set')
    for name, entry in listed.items():
        verify_bytes((root / name).read_bytes(), entry, name)
    preservation = read(root / 'preservation.json')
    require(preservation.get('status') == 'complete' and preservation.get('quiescence') == 'verified-from-owned-receipts' and preservation.get('archivesVerified') is True and preservation.get('unresolvedWriters') == [], 'Preservation did not establish complete quiescence')
    return listed


def git_oid(kind, data):
    return hashlib.sha1(kind.encode() + b' ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def git_tree(files):
    """Reconstruct Git tree IDs from path -> (Git mode, original bytes)."""
    tree = {}
    for name, (mode, data) in files.items():
        relative(name)
        require(mode in ('100644', '100755', '120000'), 'Unsupported Git mode')
        node = tree
        parts = name.split('/')
        for part in parts[:-1]:
            require(not isinstance(node.get(part), tuple), 'Source file/directory collision')
            node = node.setdefault(part, {})
        require(parts[-1] not in node, 'Duplicate source path')
        node[parts[-1]] = (mode, git_oid('blob', data))
    def build(node):
        records = []
        for name, value in node.items():
            mode, oid = ('40000', build(value)) if isinstance(value, dict) else value
            records.append((name.encode() + (b'/' if mode == '40000' else b''), mode.encode() + b' ' + name.encode() + b'\0' + bytes.fromhex(oid)))
        return git_oid('tree', b''.join(record for _, record in sorted(records)))
    require(bool(files), 'Empty source tree')
    return build(tree)


def source_archive(path, commit, tree):
    """Read tar members without extraction; their bytes must reconstruct the pin."""
    hexid(commit, 40, 'source commit'); hexid(tree, 40, 'source tree')
    files, seen = {}, set()
    with tarfile.open(path, 'r:') as archive:
        require(archive.pax_headers.get('comment') == commit, 'Source archive commit comment does not match pin')
        for member in archive:
            name = relative(member.name.rstrip('/') if member.isdir() else member.name)
            require(name not in seen, 'Duplicate archive member: ' + name)
            seen.add(name)
            if member.isdir():
                continue
            require(member.isfile() or member.issym(), 'Unsupported archive member: ' + name)
            if member.issym():
                data, mode = member.linkname.encode(), '120000'
            else:
                data = archive.extractfile(member).read()
                require(len(data) == member.size, 'Truncated source archive member')
                mode = '100755' if member.mode & 0o111 else '100644'
            files[name] = (mode, data)
    require(git_tree(files) == tree, 'Source archive does not reconstruct pinned Git tree')
    return files


def checkout_expectation():
    """Only CLI trust anchor: current checkout + sealed packet + original CI env."""
    repo = pathlib.Path(str(absolute(os.environ.get('GITHUB_WORKSPACE'))))
    proof = repo / 'proofs/numeric-portability'
    packet = read(proof / 'packet.json')
    sealed = entries(packet.get('files'), 'Sealed packet')
    expected_names = {p.relative_to(repo).as_posix() for p in proof.iterdir() if p.is_file() and p.name not in ('packet.json', 'activation.json')} | {'.github/workflows/numeric-portability.yml'}
    require(set(sealed) == expected_names, 'Sealed packet inventory is not exact checkout file set')
    for name, entry in sealed.items():
        verify_bytes((repo / name).read_bytes(), entry, name)
    require(packet.get('defaultOff') is True and packet.get('runtimeExecutionAuthorized') is False, 'Invalid sealed packet policy')
    origin, protocol = read(proof / 'origin.json'), read(proof / 'protocol.json')
    require(packet.get('origin') == origin, 'Packet/source origin differs')
    run = {key: os.environ.get(key) for key in RUN_KEYS}
    validate_run_identity(run)
    require(os.environ.get('GITHUB_ACTIONS') == 'true', 'Final admission requires original GitHub run context')
    git = lambda *args: subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
    require(git('rev-parse', 'HEAD') == run['GITHUB_SHA'], 'Admission checkout does not match current run SHA')
    require(git('status', '--porcelain', '--untracked-files=no') == '', 'Admission checkout has tracked modifications')
    activation = read(proof / 'activation.json')
    packet_sha = digest((proof / 'packet.json').read_bytes())
    require(activation.get('enabled') is True and activation.get('reviewedPacketSha256') == packet_sha, 'Packet has no matching activation')
    require(git('rev-parse', 'HEAD^') == activation.get('reviewedPacketCommit'), 'Activated parent is not reviewed packet commit')
    require(git('diff', '--name-only', 'HEAD^', 'HEAD') == 'proofs/numeric-portability/activation.json', 'Activation changed more than the activation file')
    return {'packet': packet, 'packetSha256': packet_sha, 'origin': origin, 'protocol': protocol, 'run': run, 'activation': activation}


def validate_run_identity(run):
    require(type(run) is dict, 'Run identity must be an object')
    for key in RUN_KEYS:
        nonempty(run.get(key), key)
    require(re.fullmatch('[1-9][0-9]*', run['GITHUB_RUN_ID']) is not None, 'Run ID must be a positive decimal string')
    require(run['GITHUB_RUN_ATTEMPT'] == '1', 'Original attempt only')
    for key in ('GITHUB_SHA', 'GITHUB_WORKFLOW_SHA'):
        hexid(run[key], 40, key)
    require(run['GITHUB_SHA'] == run['GITHUB_WORKFLOW_SHA'], 'Workflow is not from current push commit')
    require(run['GITHUB_REPOSITORY'] == 'natanelia/zerocopy' and run['GITHUB_REF'] == 'refs/heads/proof/numeric-portability-20261009', 'Unexpected original repository/ref')


class EvidenceFiles:
    def __init__(self, root, run, lane, archived):
        self.root, self.archived = pathlib.Path(root), archived
        self.original = absolute(run['RUNNER_TEMP']) / ('numeric-portability-' + run['GITHUB_RUN_ID'] + '-' + run['GITHUB_RUN_ATTEMPT'] + '-' + lane)
        self.workspace = absolute(run['GITHUB_WORKSPACE'])
        self.inventory = validate_inventory(root) if archived else None
        self.used = set()

    def data(self, name):
        name = relative(name)
        path = self.root / name
        require(path.is_file() and not path.is_symlink(), 'Missing/nonregular evidence: ' + name)
        require(not any(p.is_symlink() for p in path.parents if p != self.root.parent), 'Symbolic evidence path: ' + name)
        if self.archived:
            require(name in self.inventory, 'Uninventoried evidence: ' + name)
        self.used.add(name)
        return path.read_bytes()

    def json(self, name):
        return decode(self.data(name))

    def mapped(self, value):
        value = absolute(value)
        try:
            suffix = value.relative_to(self.original).as_posix()
        except ValueError:
            try:
                suffix = value.relative_to(self.workspace / 'proofs/numeric-portability').as_posix()
            except ValueError:
                raise ValueError('Evidence path outside recorded original root/workspace: ' + str(value))
            return 'packet.json' if suffix == 'packet.json' else 'harness/' + suffix
        if suffix.startswith('sources/') and self.archived:
            return 'builds/' + suffix[len('sources/'):]
        return suffix

    def link(self, entry):
        entries([entry], 'Linked evidence', absolute_paths=True)
        name = self.mapped(entry['path'])
        verify_bytes(self.data(name), entry, name)
        return name


def validate_manifest(files, lane, expected):
    manifest = files.json('harness/manifest.json')
    manifest_sha = digest(files.data('harness/manifest.json'))
    require(files.data('harness/manifest.sha256').decode() == manifest_sha + '  manifest.json\n', 'Manifest digest receipt mismatch')
    require(manifest.get('schema') == 3 and manifest.get('lane') == lane, 'Wrong manifest schema/lane')
    require(manifest.get('origin') == expected['origin'], 'Manifest origin not sealed origin')
    require(files.json('harness/origin.json') == expected['origin'], 'Archived origin not sealed origin')
    require(files.json('harness/protocol.json') == expected['protocol'], 'Protocol not sealed protocol')
    for name in ('packet.json', 'harness/packet.json'):
        require(digest(files.data(name)) == expected['packetSha256'] and files.json(name) == expected['packet'], 'Wrong sealed packet bytes')
    require(files.json('activation.json') == expected['activation'], 'Activation is not current reviewed activation')
    ci_run = manifest.get('ciRun')
    validate_run_identity(ci_run)
    run = files.json('run.json')
    validate_run_identity(run)
    for key in RUN_KEYS:
        require(run[key] == ci_run[key] == expected['run'][key], 'Run identity differs from current original CI run: ' + key)
    for key in ('GITHUB_WORKSPACE', 'RUNNER_TEMP', 'PROOF_LANE', 'ImageOS', 'ImageVersion', 'RUNNER_ARCH'):
        nonempty(run.get(key), key)
        require(run[key] == ci_run.get(key), 'Mutable original run identity: ' + key)
    require(run['PROOF_LANE'] == lane and run['RUNNER_ARCH'] == {'x64': 'X64', 'arm64': 'ARM64'}[lane], 'Wrong recorded lane/architecture')
    for key in ('workDeadlineMonotonicSeconds',):
        number(run.get(key), key, 1)
        require(run[key] == ci_run.get(key), 'Original run deadline changed')
    number(run.get('supplementalAdmissionDeadlineMonotonicSeconds'), 'Supplemental deadline', 1)
    sealed = entries(expected['packet']['files'], 'Sealed packet')
    harness = entries(manifest.get('harness'), 'Harness', absolute_paths=True)
    expected_harness = {str(files.original / 'harness' / name) for name in FROZEN if name != 'manifest.json'} | {str(files.original / 'harness/admission.json')} | {str(files.original / 'sources' / arm / 'dist/numeric-scalar-control.mjs') for arm in ARMS}
    require(set(harness) == expected_harness, 'Harness inventory differs from mandatory frozen file set')
    for name in FROZEN:
        data = files.data('harness/' + name)
        if name != 'packet.json':
            key = 'proofs/numeric-portability/' + name
            require(key in sealed, 'Harness file missing from sealed packet: ' + name)
            verify_bytes(data, sealed[key], name)
    for entry in harness.values():
        files.link(entry)
    tools = entries(manifest.get('tools'), 'Tool receipts', absolute_paths=True)
    require(any(pathlib.PurePosixPath(name).name.startswith('python3') for name in tools), 'Python runtime digest receipt missing')
    require(manifest['tools'] == files.json('toolchain-before.json'), 'Toolchain receipt changed since setup')
    runtimes = manifest.get('runtimes')
    require(type(runtimes) is dict and set(runtimes) == {'node', 'bun'}, 'Missing/extra runtime identity')
    for runtime in ('node', 'bun'):
        record = runtimes[runtime]
        absolute(record.get('path'))
        require(record['path'] in tools and record.get('args') == (['--expose-gc'] if runtime == 'node' else []), 'Runtime not bound to tool digest/args')
    package_names = ('assemblyscript', 'binaryen', 'long', 'typescript', 'playwright', 'playwright-core')
    package_sets = {}
    for arm in ARMS:
        prefix = str(files.original / 'sources' / arm / 'node_modules') + '/'
        package_sets[arm] = {name[len(prefix):]: {'sha256': entry['sha256'], 'bytes': entry['bytes']} for name, entry in tools.items() if name.startswith(prefix)}
        require(all(name + '/package.json' in package_sets[arm] for name in package_names), 'Required tool package metadata digest absent')
    require(package_sets['baseline'] == package_sets['candidate'], 'Tool package receipts differ between arms')
    pins = files.json('browser-pins.json')
    require(pins.get('version') == expected['protocol']['browserVersion'], 'Wrong Playwright pin')
    engines = pins.get('engines')
    require(type(engines) is list and [e.get('name') for e in engines] == (list(BROWSERS) if lane == 'x64' else ['chromium']), 'Wrong installed browser inventory')
    for engine in engines:
        absolute(engine.get('executable'))
        require(engine['executable'] in tools and type(engine.get('registry')) is list and bool(engine['registry']), 'Missing browser executable/registry receipt')
        for pin in engine['registry']:
            require(pin.get('name') in (engine['name'], engine['name'] + '-headless-shell'), 'Unexpected browser registry entry')
            nonempty(pin.get('revision'), 'Browser revision')
    pin_path = str(files.original / 'browser-pins.json')
    require(pin_path in tools, 'Browser pin digest missing')
    files.link(tools[pin_path])
    return manifest, manifest_sha, run, pins


def validate_sources(files, manifest, expected):
    from artifact_checks import scalar_fixture, verify_build_pair
    origin = expected['origin']
    require(type(manifest.get('sources')) is dict and set(manifest['sources']) == set(ARMS), 'Wrong source arm set')
    generated = files.json('generated-fixtures.json')
    require(type(generated) is dict and set(generated) == set(ARMS), 'Wrong generated fixture set')
    for arm in ARMS:
        source = manifest['sources'][arm]
        require(source.get('path') == str(files.original / 'sources' / arm), 'Source not under recorded original root')
        require(source.get('commit') == origin[arm + 'Commit'] and source.get('tree') == origin[arm + 'Tree'], 'Wrong source commit/tree')
        listed = entries(source.get('files'), arm + ' sources')
        if files.archived:
            files.data(arm + '-source.tar')
            archived = source_archive(files.root / (arm + '-source.tar'), origin[arm + 'Commit'], origin[arm + 'Tree'])
        else:
            tree = pathlib.Path(source['path'])
            output = subprocess.check_output(['git', '-C', str(tree), 'ls-tree', '-rz', 'HEAD'])
            archived = {}
            for record in output.split(b'\0'):
                if not record:
                    continue
                meta, name = record.split(b'\t', 1)
                mode, kind, oid = meta.decode().split()
                name = name.decode()
                require(kind == 'blob' and mode in ('100644', '100755'), 'Unexpected live source mode')
                data = (tree / relative(name)).read_bytes()
                require(git_oid('blob', data) == oid, 'Live tracked source differs from Git')
                archived[name] = (mode, data)
            require(git_tree(archived) == origin[arm + 'Tree'], 'Live source does not match pinned Git tree')
        require(set(listed) == set(archived), 'Source manifest is not exact Git tree inventory')
        for name, entry in listed.items():
            verify_bytes(archived[name][1], entry, arm + '/' + name)
        for name, sha in origin['sourceHashes'][arm].items():
            require(digest(archived[name][1]) == sha, 'Source pin mismatch')
        builds = entries(source.get('builds'), arm + ' builds')
        require(source['builds'] == origin['expectedOutputs'][arm], 'Build inventory differs from exact retained outputs')
        for name, entry in builds.items():
            data = files.data(('builds/' if files.archived else 'sources/') + arm + '/' + name)
            verify_bytes(data, entry, arm + '/' + name)
        build_root = files.root / ('builds' if files.archived else 'sources') / arm
        fixture = scalar_fixture(build_root)
        require(source.get('generatedFixtures') == [fixture] and generated[arm] == fixture, 'Generated scalar fixture receipt mismatch')
        files.data(('builds/' if files.archived else 'sources/') + arm + '/dist/numeric-scalar-control.mjs')
    prefix = 'builds' if files.archived else 'sources'
    require(files.json('build-comparison.json') == verify_build_pair(files.root / prefix / 'baseline', files.root / prefix / 'candidate', origin), 'Build comparison receipt differs from recomputed equality')


def validate_stage(files, name, commands, seconds, cwd):
    stage = files.json(name + '.json')
    require(stage.get('name') == name and stage.get('status') == 'passed' and stage.get('budgetSeconds') == seconds, 'Incomplete/wrong stage: ' + name)
    records = stage.get('commands')
    require(type(records) is list and len(records) == len(commands), 'Wrong stage command count: ' + name)
    receipt_entries = []
    for index, (record, command) in enumerate(zip(records, commands)):
        name_part = 'logs/' + name + '/' + str(index).zfill(2)
        receipt_path = name_part + '.json'
        require(record == {'receipt': str(files.original / receipt_path), 'status': 'passed'}, 'Stage command link mismatch: ' + receipt_path)
        result = files.json(receipt_path)
        require(result.get('status') == 'passed' and result.get('command') == command and result.get('cwd') == str(cwd[index] if isinstance(cwd, list) else cwd), 'Stage command/cwd/status mismatch: ' + receipt_path)
        require(type(result.get('returncode')) is int and result['returncode'] == 0, 'Stage command did not exit successfully')
        number(result.get('elapsedWallSeconds'), 'Stage elapsed')
        require(result['elapsedWallSeconds'] <= seconds + 2, 'Stage command exceeded envelope')
        cleanup = result.get('cleanup', {})
        pid = integer(result.get('pid'), 'Stage PID', 1)
        require(result.get('group') == pid and cleanup.get('pid') == pid and cleanup.get('group') == pid and cleanup.get('ownedGroupGone') is True and type(cleanup.get('returncode')) is int and cleanup.get('returncode') == 0, 'Stage cleanup/process mismatch')
        require(not any(key in result for key in ('error', 'cleanupError', 'finalizationError')), 'Stage retained failure')
        log = files.data(name_part + '.log')
        require(digest(log) == hexid(result.get('logSha256'), 64, 'stage log digest'), 'Stage log digest mismatch')
        for path in (receipt_path, name_part + '.log'):
            data = files.data(path)
            receipt_entries.append({'path': str(files.original / path), 'sha256': digest(data), 'bytes': len(data)})
    return receipt_entries


def validate_envelope(files, name, seconds):
    value = files.json(name + '-envelope.json')
    require(value.get('stage') == name and value.get('status') == 'passed' and value.get('budgetSeconds') == seconds and value.get('cleanupGraceSeconds') == 2, 'Missing/failed stage envelope: ' + name)
    require(number(value.get('elapsedWallSeconds'), 'Envelope elapsed') <= seconds + 2, 'Envelope exceeded budget')


def validate_gates(files, manifest, expected, lane):
    import ci
    reviews = []
    proof = files.workspace / 'proofs/numeric-portability'
    for arm in ARMS:
        source = files.original / 'sources' / arm
        commands = [[str(source) if value == '{source}' else str(proof / pathlib.Path(value).name) if value.startswith(str(ci.HERE) + '/') else value for value in command] for command in ci.GATES]
        name = 'gate-' + arm
        validate_envelope(files, name, 900)
        reviews.extend(validate_stage(files, name, commands, 900, source))
        require(files.json(name + '-source.json') == {'commit': expected['origin'][arm + 'Commit'], 'tree': expected['origin'][arm + 'Tree']}, 'Gate source receipt mismatch')
        for suffix in ('.json', '-source.json', '-envelope.json'):
            data = files.data(name + suffix)
            reviews.append({'path': str(files.original / (name + suffix)), 'sha256': digest(data), 'bytes': len(data)})
    policy = files.json('harness/admission.json')
    require(policy.get('mode') == 'ci-screen' and policy.get('promotionAllowed') is False and policy.get('historicalEvidenceTransferred') is False, 'Wrong lane policy')
    require(policy.get('fullStandardGateStatus') == {arm: 'passed-fresh-exact-source' for arm in ARMS}, 'Both complete fresh gates required')
    require(policy.get('standardCommandsPerArm') == 23 and policy.get('numericCommandsPerArm') == 9 and policy.get('gateReceiptFiles') == reviews, 'Gate receipt inventory is incomplete/mislinked')
    packet_entry = {'path': str(proof / 'packet.json'), 'sha256': expected['packetSha256'], 'bytes': len(files.data('packet.json'))}
    require(manifest.get('sourceReview') == {'files': [packet_entry, *reviews]}, 'Manifest source-review links are incomplete/mislinked')
    validate_envelope(files, 'setup', 600)
    sources = [files.original / 'sources' / arm for arm in ARMS]
    commands = [['bun', 'install', '--frozen-lockfile']] * 2 + [['node', 'node_modules/playwright/cli.js', 'install', '--with-deps', *(BROWSERS if lane == 'x64' else ('chromium',))], ['node', str(proof / 'inventory-browsers.mjs'), str(sources[0]), str(files.original / 'browser-pins.json'), lane]]
    validate_stage(files, 'setup', commands, 600, [*sources, sources[0], sources[0]])
    validate_envelope(files, 'freeze', 120)


def validate_http(rows, files, manifest, slot, pins):
    responses = [r for r in rows if r.get('kind') == 'http-response']
    require([r.get('request') for r in responses] == list(range(len(responses))) and bool(responses), 'Browser HTTP receipt sequence missing/reordered')
    complete = [r for r in rows if r.get('kind') == 'browser-complete']
    require(len(complete) == 1 and complete[0].get('requests') == len(responses), 'Browser request total differs from retained receipts')
    origin = complete[0].get('origin')
    require(type(origin) is str and re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}', origin) is not None and int(origin.rsplit(':', 1)[1]) <= 65535, 'Invalid local browser origin')
    source = manifest['sources'][slot['arm']]
    source_files = {e['path']: e for e in source['builds'] + source['generatedFixtures']}
    for row in responses:
        name = row.get('path')
        if name == '/':
            data = b'<!doctype html><title>Numeric portability proof</title>'
        elif name in ('/core.mjs', '/browser-semantics.mjs', '/semantic-worker.mjs'):
            data = files.data('harness' + name)
        else:
            require(type(name) is str and name.startswith('/') and name[1:] in source_files, 'HTTP receipt served non-frozen path')
            data = files.data(('builds/' if files.archived else 'sources/') + slot['arm'] + name)
        require(row.get('bytes') == len(data) and row.get('sha256') == digest(data) and row.get('cacheControl') == 'no-store' and row.get('originIsolation') is True, 'HTTP receipt differs from frozen bytes/isolation')
    processes = [r for r in rows if r.get('kind') == 'browser-process']
    require(len(processes) == 1, 'Browser engine process receipt missing/duplicate')
    pin = next(e for e in pins['engines'] if e['name'] == slot['runtime'])
    require(processes[0].get('executable') == pin['executable'], 'Browser executable differs from frozen pin')


def validate_ledgers(files, manifest, manifest_sha, expected, lane, pins):
    from evidence import schedule, validate_raw, derive_work
    from resource_ownership import validate_resource_receipts
    protocol = expected['protocol']
    phases = ('semantics', 'untimed', 'run') if lane == 'x64' else ('untimed', 'run')
    phase_slots = {}
    process_births, engine_births, browser_profiles = set(), set(), set()
    for phase in phases:
        planned = schedule(lane, phase, protocol)
        require(bool(planned), 'Expected schedule is empty')
        expected_phase_files = {'ledger.json'}
        for planned_slot in planned:
            suffixes = ['.receipt.json', '.config.json', '.process.json', '.cleanup.json', '.stdout.jsonl', '.stderr.log']
            if planned_slot['runtime'] in BROWSERS: suffixes.append('.ownership.jsonl')
            expected_phase_files.update(planned_slot['id'] + suffix for suffix in suffixes)
        require(regular_files(files.root / phase) <= expected_phase_files, 'Unexpected/unlinked archived evidence in phase ' + phase)
        ledger = files.json(phase + '/ledger.json')
        require(ledger.get('phase') == phase and ledger.get('lane') == lane and ledger.get('status') == 'complete' and ledger.get('manifestSha256') == manifest_sha and ledger.get('verificationAfter', {}).get('ok') is True, 'Incomplete/misbound lane ledger: ' + phase)
        recorded = ledger.get('slots')
        require(type(recorded) is list and len(recorded) == len(planned), 'Wrong exact slot count: ' + phase)
        validated, calibrations, common_work = [], {}, {}
        for slot, record in zip(planned, recorded):
            require(type(record) is dict and all(type(record.get(key)) is type(value) and record.get(key) == value for key, value in slot.items()), 'Scheduled slot identity/order mismatch')
            slot_path = phase + '/' + slot['id']
            receipt = files.json(slot_path + '.receipt.json')
            require(receipt == record and record.get('status') == 'complete' and record.get('manifestSha256') == manifest_sha, 'Slot receipt/ledger mismatch')
            config = files.json(slot_path + '.config.json')
            require(all(type(config.get(key)) is type(value) and config.get(key) == value for key, value in slot.items()), 'Slot configuration identity mismatch')
            require(config.get('lane') == lane and config.get('protocol') == protocol and config.get('admitted') is True, 'Slot config protocol/lane/admission mismatch')
            require(config.get('manifestPath') == str(files.original / 'harness/manifest.json') and config.get('manifestSha256') == manifest_sha, 'Slot manifest link mismatch')
            require(config.get('dist') == str(files.original / 'sources' / slot['arm'] / 'dist'), 'Slot source dist link mismatch')
            allowed_config = set(slot) | {'lane', 'protocol', 'manifestPath', 'manifestSha256', 'dist', 'admitted'}
            if slot['mode'] == 'measure' and slot['warm']: allowed_config.add('work')
            if slot['runtime'] in BROWSERS: allowed_config |= {'ownershipJournal', 'ownershipBinding'}
            require(set(config) == allowed_config, 'Unexpected/missing config fields')
            for suffix, key in (('.config.json', 'configSha256'), ('.process.json', 'processSha256'), ('.cleanup.json', 'cleanupSha256'), ('.stdout.jsonl', 'stdoutSha256'), ('.stderr.log', 'stderrSha256')):
                require(digest(files.data(slot_path + suffix)) == hexid(record.get(key), 64, key), 'Slot evidence digest mismatch: ' + suffix)
            process = files.json(slot_path + '.process.json')
            cleanup = files.json(slot_path + '.cleanup.json')
            require(record.get('cleanup') == cleanup, 'Duplicated cleanup receipt differs')
            browser = slot['runtime'] in BROWSERS
            runtime = manifest['runtimes']['node' if browser else slot['runtime']]
            command = [runtime['path'], *runtime['args'], str(files.original / 'harness' / ('browser-subject.mjs' if browser else 'node-subject.mjs')), str(files.original / (slot_path + '.config.json'))]
            require(record.get('command') == command and process.get('command') == command, 'Subject command does not link exact config/runtime')
            journal = None
            if browser:
                journal_name = slot_path + '.ownership.jsonl'
                require(config.get('ownershipJournal') == str(files.original / journal_name), 'Browser journal path mismatch')
                journal_data = files.data(journal_name)
                require(digest(journal_data) == hexid(record.get('ownershipSha256'), 64, 'ownership digest'), 'Browser journal digest mismatch')
                require(digest(journal_data) == cleanup.get('ownership', {}).get('sha256'), 'Cleanup ownership digest mismatch')
                journal = [decode(line) for line in journal_data.splitlines()]
            validate_resource_receipts(slot, config, process, cleanup, record, journal)
            birth = (process['identity']['pid'], process['identity']['startTicks'])
            require(birth not in process_births, 'Repeated subject process birth across scheduled slots')
            process_births.add(birth)
            require(not any(key in record for key in ('error', 'validationError', 'resourceAccountingError')), 'Slot retained failure')
            require(record['maximumTreeRssBytes'] <= protocol['memory']['maximumBrowserTreeRssBytes' if browser else 'maximumSubjectRssBytes'], 'Subject sampled RSS cap exceeded')
            require(record['controllerMaximumRssBytes'] <= protocol['memory']['maximumControllerRssBytes'], 'Controller sampled RSS cap exceeded')
            require(len(files.data(slot_path + '.stdout.jsonl')) + len(files.data(slot_path + '.stderr.log')) <= protocol['memory']['maximumOutputBytes'], 'Subject output cap exceeded')
            rows = [decode(line) for line in files.data(slot_path + '.stdout.jsonl').splitlines()]
            require(bool(rows), 'Empty raw subject evidence')
            if slot['mode'] == 'measure' and slot['warm']:
                runtime_name = slot['runtime']
                if runtime_name not in common_work:
                    common_work[runtime_name] = derive_work(calibrations[runtime_name], protocol)
                work = common_work[runtime_name]
                require(config.get('work') == work, 'Common calibrated work differs from independent selection')
            else:
                work = None
                require('work' not in config, 'Unexpected calibrated work in this slot')
            result = validate_raw(rows, slot, config, protocol=protocol, work=work, identity={'process': process, 'cleanup': cleanup, 'pins': pins})
            if browser:
                validate_http(rows, files, manifest, slot, pins)
                engine = next(r for r in rows if r.get('kind') == 'browser-process')
                ownership_engine = next(r['identity'] for r in journal if r.get('kind') == 'engine-spawned')
                require(all(engine.get(k) == v for k, v in ownership_engine.items()), 'Raw browser birth differs from durable ownership receipt')
                birth = (ownership_engine['pid'], ownership_engine['startTicks'])
                require(birth not in engine_births and engine['profile'] not in browser_profiles, 'Repeated browser engine birth/profile')
                engine_births.add(birth); browser_profiles.add(engine['profile'])
            else:
                terminal = [row for row in rows if row.get('kind') == 'process-complete']
                require(len(terminal) == 1 and terminal[0].get('pid') == process.get('pid'), 'Raw runtime PID differs from process receipt')
            if slot['mode'] == 'calibrate':
                calibrations.setdefault(slot['runtime'], {})[slot['arm']] = result
            validated.append({**slot, 'evidence': result})
        phase_slots[phase] = validated
        validate_envelope(files, 'admission-' + phase, 120)
        budget = protocol['budgets']['controllerWallSeconds'][lane] if phase == 'run' else 360
        command = ['python3', str(files.original / 'harness/run.py'), phase, '--root', str(files.original), '--lane', lane]
        validate_stage(files, 'launch-' + phase, [command], budget + 2, files.workspace)
    return phase_slots


def validate_lane(root, lane, expected=None, archived=False):
    require(lane in ('x64', 'arm64'), 'Unsupported lane')
    expected = checkout_expectation() if expected is None else expected
    validate_run_identity(expected.get('run'))
    run = read(pathlib.Path(root) / 'run.json')
    validate_run_identity(run)
    files = EvidenceFiles(root, run, lane, archived)
    manifest, manifest_sha, run, pins = validate_manifest(files, lane, expected)
    validate_sources(files, manifest, expected)
    validate_gates(files, manifest, expected, lane)
    phases = validate_ledgers(files, manifest, manifest_sha, expected, lane, pins)
    if archived:
        command = ['node', str(files.original / 'harness/report.mjs'), str(files.original), lane]
        validate_stage(files, 'report', [command], 120, files.workspace)
        files.data('lane-analysis.json')
        require(files.used == set(files.inventory), 'Unexpected/unlinked archived evidence: ' + ', '.join(sorted(set(files.inventory) - files.used)))
    return {'lane': lane, 'manifest': manifest, 'manifestSha256': manifest_sha, 'run': manifest['ciRun'], 'packetSha256': expected['packetSha256'], 'slots': phases['run'], 'phaseSlots': phases}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('lane', 'archived'))
    parser.add_argument('root')
    parser.add_argument('lane', choices=('x64', 'arm64'))
    args = parser.parse_args()
    try:
        result = validate_lane(args.root, args.lane, archived=args.mode == 'archived')
        print(json.dumps({'admitted': True, 'canonical': result}, allow_nan=False))
    except Exception as error:
        print(json.dumps({'admitted': False, 'error': str(error), 'cells': []}, allow_nan=False))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
