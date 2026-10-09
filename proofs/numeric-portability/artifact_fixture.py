"""Pure artificial CI evidence graph around read-only retained source/build bytes.

No subjects, engines, builds, operation clocks, or external writes are performed.
The returned expected identity is injected only into tests; the production CLI
accepts no override and derives its expectation from the current original CI run.
"""
import copy
import json
import pathlib
import shutil
import subprocess

import artifact_admission as a
import ci
import evidence
from artifact_checks import scalar_fixture, verify_build_pair
from synthetic_fixture import make_config, make_raw

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
RETAINED = pathlib.Path('/workspace/shared/zerocopy-numeric-sibling-ci-37952544553/artifact/builds')


def write(root, name, value):
    path = pathlib.Path(root) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value if type(value) is bytes else (json.dumps(value, indent=2) + '\n').encode())
    return path


def item(path, name=None):
    path = pathlib.Path(path)
    data = path.read_bytes()
    return {'path': str(name if name is not None else path), 'sha256': a.digest(data), 'bytes': len(data)}


def inventory(root):
    root = pathlib.Path(root)
    names = sorted(a.regular_files(root) - {'artifact-inventory.json', 'preservation.json'})
    write(root, 'artifact-inventory.json', {'files': [item(root / name, name) for name in names], 'quiescence': 'verified-from-owned-receipts', 'originalAttemptFilesIncluded': True})
    write(root, 'preservation.json', {'status': 'complete', 'quiescence': 'verified-from-owned-receipts', 'unresolvedWriters': [], 'archivesVerified': True})


def prepare_source_cache(directory):
    """git archive reads pinned existing objects; copying retained builds is not a build."""
    directory = pathlib.Path(directory)
    origin = a.read(HERE / 'origin.json')
    for arm in a.ARMS:
        archive = directory / (arm + '-source.tar')
        with archive.open('wb') as output:
            subprocess.run(['git', '-C', str(REPO), 'archive', origin[arm + 'Commit']], stdout=output, check=True)
        for entry in origin['expectedOutputs'][arm]:
            source = RETAINED / arm / entry['path']
            a.verify_bytes(source.read_bytes(), entry, arm + '/' + entry['path'])
    return directory


def make_lane(root, lane, cache, *, write_analysis=False):
    root = pathlib.Path(root)
    root.mkdir(parents=True, exist_ok=True)
    protocol = copy.deepcopy(evidence.P)
    origin = a.read(HERE / 'origin.json')
    run = {'GITHUB_RUN_ID': '123456789', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_SHA': 'a' * 40, 'GITHUB_WORKFLOW_SHA': 'a' * 40,
           'GITHUB_REPOSITORY': 'natanelia/zerocopy', 'GITHUB_REF': 'refs/heads/proof/numeric-portability-20261009',
           'GITHUB_WORKSPACE': '/synthetic/workspace', 'RUNNER_TEMP': '/synthetic/temp', 'PROOF_LANE': lane,
           'ImageOS': 'ubuntu24', 'ImageVersion': 'synthetic', 'RUNNER_ARCH': {'x64': 'X64', 'arm64': 'ARM64'}[lane],
           'workDeadlineMonotonicSeconds': 5000}
    original = pathlib.PurePosixPath(run['RUNNER_TEMP']) / ('numeric-portability-' + run['GITHUB_RUN_ID'] + '-1-' + lane)
    workspace = pathlib.PurePosixPath(run['GITHUB_WORKSPACE'])
    proof = workspace / 'proofs/numeric-portability'
    sealed = []
    for path in sorted(p for p in HERE.iterdir() if p.is_file() and p.name not in ('packet.json', 'activation.json')):
        sealed.append(item(path, 'proofs/numeric-portability/' + path.name))
    sealed.append(item(REPO / '.github/workflows/numeric-portability.yml', '.github/workflows/numeric-portability.yml'))
    packet = {'schema': 1, 'origin': origin, 'files': sorted(sealed, key=lambda value: value['path']), 'defaultOff': True, 'runtimeExecutionAuthorized': False}
    packet_path = write(root, 'packet.json', packet)
    packet_sha = a.digest(packet_path.read_bytes())
    activation = {'enabled': True, 'reviewedPacketSha256': packet_sha, 'reviewedPacketCommit': 'b' * 40}
    write(root, 'activation.json', activation)
    write(root, 'run.json', {**run, 'supplementalAdmissionDeadlineMonotonicSeconds': 1000})
    for name in a.FROZEN:
        write(root, 'harness/' + name, packet_path.read_bytes() if name == 'packet.json' else (HERE / name).read_bytes())
    expected = {'packet': packet, 'packetSha256': packet_sha, 'origin': origin, 'protocol': protocol, 'run': {key: run[key] for key in a.RUN_KEYS}, 'activation': activation}
    sources, fixtures = {}, {}
    for arm in a.ARMS:
        shutil.copyfile(pathlib.Path(cache) / (arm + '-source.tar'), root / (arm + '-source.tar'))
        archived = a.source_archive(root / (arm + '-source.tar'), origin[arm + 'Commit'], origin[arm + 'Tree'])
        for entry in origin['expectedOutputs'][arm]:
            path = root / 'builds' / arm / entry['path']
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(RETAINED / arm / entry['path'], path)
        fixtures[arm] = scalar_fixture(root / 'builds' / arm, create=True)
        sources[arm] = {'path': str(original / 'sources' / arm), 'commit': origin[arm + 'Commit'], 'tree': origin[arm + 'Tree'],
                        'files': [{'path': name, 'bytes': len(data), 'sha256': a.digest(data)} for name, (mode, data) in sorted(archived.items())],
                        'builds': origin['expectedOutputs'][arm], 'generatedFixtures': [fixtures[arm]]}
    write(root, 'generated-fixtures.json', fixtures)
    write(root, 'build-comparison.json', verify_build_pair(root / 'builds/baseline', root / 'builds/candidate', origin))
    engines = a.BROWSERS if lane == 'x64' else ('chromium',)
    pins = {'version': protocol['browserVersion'], 'engines': [{'name': name, 'executable': '/synthetic/tools/' + name, 'registry': [{'name': name, 'revision': '1'}]} for name in engines]}
    write(root, 'browser-pins.json', pins)
    tools = [{'path': '/synthetic/tools/' + name, 'sha256': a.digest(name.encode()), 'bytes': len(name)} for name in ('node', 'bun', 'python3', *engines)]
    for arm in a.ARMS:
        for name in ('assemblyscript', 'binaryen', 'long', 'typescript', 'playwright', 'playwright-core'):
            tools.append({'path': str(original / 'sources' / arm / 'node_modules' / name / 'package.json'), 'sha256': a.digest(name.encode()), 'bytes': len(name)})
    tools.append(item(root / 'browser-pins.json', original / 'browser-pins.json'))
    write(root, 'toolchain-before.json', tools)

    def envelope(name, seconds):
        write(root, name + '-envelope.json', {'stage': name, 'status': 'passed', 'budgetSeconds': seconds, 'cleanupGraceSeconds': 2, 'elapsedWallSeconds': 1})

    def stage(name, commands, seconds, cwd):
        records, links = [], []
        for index, command in enumerate(commands):
            base = 'logs/' + name + '/' + str(index).zfill(2)
            write(root, base + '.log', b'artificial successful stage; no command executed\n')
            cleanup = {'pid': 10, 'group': 10, 'returncode': 0, 'ownedGroupGone': True}
            receipt = {'command': command, 'cwd': str(cwd[index] if isinstance(cwd, list) else cwd), 'status': 'passed', 'pid': 10, 'group': 10, 'returncode': 0, 'elapsedWallSeconds': 1, 'cleanup': cleanup, 'logSha256': a.digest((root / (base + '.log')).read_bytes())}
            write(root, base + '.json', receipt)
            records.append({'receipt': str(original / (base + '.json')), 'status': 'passed'})
            links += [item(root / (base + suffix), original / (base + suffix)) for suffix in ('.json', '.log')]
        write(root, name + '.json', {'name': name, 'status': 'passed', 'budgetSeconds': seconds, 'commands': records})
        return links

    reviews = []
    for arm in a.ARMS:
        name = 'gate-' + arm
        source = original / 'sources' / arm
        commands = [[str(source) if value == '{source}' else str(proof / pathlib.Path(value).name) if value.startswith(str(ci.HERE) + '/') else value for value in command] for command in ci.GATES]
        envelope(name, 900)
        reviews.extend(stage(name, commands, 900, source))
        write(root, name + '-source.json', {'commit': origin[arm + 'Commit'], 'tree': origin[arm + 'Tree']})
        reviews.extend(item(root / (name + suffix), original / (name + suffix)) for suffix in ('.json', '-source.json', '-envelope.json'))
    policy = {'mode': 'ci-screen', 'promotionAllowed': False, 'historicalEvidenceTransferred': False,
              'fullStandardGateStatus': {arm: 'passed-fresh-exact-source' for arm in a.ARMS}, 'gateReceiptFiles': reviews,
              'standardCommandsPerArm': 23, 'numericCommandsPerArm': 9}
    write(root, 'harness/admission.json', policy)
    source_paths = [original / 'sources' / arm for arm in a.ARMS]
    setup_commands = [['bun', 'install', '--frozen-lockfile']] * 2 + [['node', 'node_modules/playwright/cli.js', 'install', '--with-deps', *engines], ['node', str(proof / 'inventory-browsers.mjs'), str(source_paths[0]), str(original / 'browser-pins.json'), lane]]
    stage('setup', setup_commands, 600, [*source_paths, source_paths[0], source_paths[0]])
    envelope('setup', 600); envelope('freeze', 120)
    harness = [item(root / 'harness' / name, original / 'harness' / name) for name in (*a.FROZEN, 'admission.json')]
    harness += [item(root / 'builds' / arm / 'dist/numeric-scalar-control.mjs', original / 'sources' / arm / 'dist/numeric-scalar-control.mjs') for arm in a.ARMS]
    manifest = {'schema': 3, 'lane': lane, 'sources': sources, 'runtimes': {name: {'path': '/synthetic/tools/' + name, 'args': ['--expose-gc'] if name == 'node' else []} for name in ('node', 'bun')},
                'tools': tools, 'harness': harness, 'sourceReview': {'files': [item(packet_path, proof / 'packet.json'), *reviews]}, 'origin': origin, 'ciRun': run}
    write(root, 'harness/manifest.json', manifest)
    manifest_sha = a.digest((root / 'harness/manifest.json').read_bytes())
    write(root, 'harness/manifest.sha256', (manifest_sha + '  manifest.json\n').encode())
    controller = {'pid': 100, 'state': 'S', 'ppid': 50, 'group': 100, 'session': 100, 'startTicks': 1}
    serial = 0
    for phase in (('semantics', 'untimed', 'run') if lane == 'x64' else ('untimed', 'run')):
        records, calibrations, works = [], {}, {}
        for slot in evidence.schedule(lane, phase, protocol):
            serial += 1
            pid, engine_pid = 1000 + serial * 2, 1001 + serial * 2
            browser = slot['runtime'] in a.BROWSERS
            work = None
            if slot['mode'] == 'measure' and slot['warm']:
                if slot['runtime'] not in works:
                    works[slot['runtime']] = evidence.derive_work(calibrations[slot['runtime']], protocol)
                work = works[slot['runtime']]
            config = make_config(slot, lane, root=str(original), manifest_sha=manifest_sha, work=work)
            base = phase + '/' + slot['id']
            rows = make_raw(slot, config, work=work, pid=pid, browser_pid=engine_pid)
            for row in rows:
                if row.get('kind') == 'http-response' and row.get('path') in ('/core.mjs', '/browser-semantics.mjs', '/semantic-worker.mjs'):
                    frozen = (root / 'harness' / row['path'][1:]).read_bytes()
                    row.update(bytes=len(frozen), sha256=a.digest(frozen))
            root_birth = {'pid': pid, 'state': 'S', 'ppid': 100, 'group': pid, 'session': pid, 'startTicks': 100 + serial}
            engine_birth = {'pid': engine_pid, 'state': 'S', 'ppid': pid, 'group': engine_pid, 'session': engine_pid, 'startTicks': 200 + serial}
            ownership = None
            if browser:
                for row in rows:
                    if row['kind'] == 'browser-process':
                        row.update(engine_birth, executable='/synthetic/tools/' + slot['runtime'])
                binding = config['ownershipBinding']
                journal = [{'kind': 'ownership-ready', 'adapter': root_birth}, {'kind': 'engine-spawn-intent', 'attempt': 1}, {'kind': 'engine-spawned', 'attempt': 1, 'identity': engine_birth}, {'kind': 'ownership-sealed', 'attempts': 1, 'engineExited': True}]
                journal = [{'schema': 1, 'sequence': index, 'binding': binding, **row} for index, row in enumerate(journal)]
                journal_path = write(root, base + '.ownership.jsonl', b''.join((json.dumps(row) + '\n').encode() for row in journal))
                ownership = {'path': config['ownershipJournal'], 'sha256': a.digest(journal_path.read_bytes()), 'binding': binding, 'registeredEngine': engine_birth, 'sealed': True, 'complete': True, 'problems': [], 'durability': 'fsync'}
            runtime = manifest['runtimes']['node' if browser else slot['runtime']]
            command = [runtime['path'], *runtime['args'], str(original / 'harness' / ('browser-subject.mjs' if browser else 'node-subject.mjs')), str(original / (base + '.config.json'))]
            process = {'pid': pid, 'group': pid, 'command': command, 'status': 'spawned', 'identity': root_birth}
            cleanup = {'pid': pid, 'group': pid, 'ownedGroups': sorted([pid, engine_pid] if browser else [pid]), 'ownedProcessIdentities': [root_birth, engine_birth] if browser else [root_birth], 'returncode': 0,
                       'ownedGroupGone': True, 'quiescence': 'verified', 'survivors': [], 'problems': [], 'ownership': ownership,
                       'descendantScope': {'controller': controller, 'subreaperVerified': True, 'initialKernelChildrenAbsent': True, 'finalKernelChildrenAbsent': True, 'adoptedChildrenReaped': []}}
            for suffix, content in (('.config.json', config), ('.process.json', process), ('.cleanup.json', cleanup), ('.stdout.jsonl', b''.join((json.dumps(row) + '\n').encode() for row in rows)), ('.stderr.log', b'')):
                write(root, base + suffix, content)
            record = {**slot, 'command': command, 'status': 'complete', 'manifestSha256': manifest_sha, 'cleanup': cleanup, 'maximumTreeRssBytes': 33554432, 'controllerMaximumRssBytes': 33554432,
                      'resourceAccounting': {'status': 'complete', 'strictRss': True, 'sampledNotPeak': True, 'rssSampleCount': 1}}
            for suffix, key in (('.config.json', 'configSha256'), ('.process.json', 'processSha256'), ('.cleanup.json', 'cleanupSha256'), ('.stdout.jsonl', 'stdoutSha256'), ('.stderr.log', 'stderrSha256')):
                record[key] = a.digest((root / (base + suffix)).read_bytes())
            if browser: record['ownershipSha256'] = ownership['sha256']
            write(root, base + '.receipt.json', record)
            records.append(record)
            if slot['mode'] == 'calibrate':
                calibrations.setdefault(slot['runtime'], {})[slot['arm']] = evidence.validate_raw(rows, slot, config, protocol=protocol)
        write(root, phase + '/ledger.json', {'phase': phase, 'lane': lane, 'status': 'complete', 'manifestSha256': manifest_sha, 'slots': records, 'verificationAfter': {'ok': True}})
        envelope('admission-' + phase, 120)
        budget = protocol['budgets']['controllerWallSeconds'][lane] if phase == 'run' else 360
        stage('launch-' + phase, [['python3', str(original / 'harness/run.py'), phase, '--root', str(original), '--lane', lane]], budget + 2, workspace)
    stage('report', [['node', str(original / 'harness/report.mjs'), str(original), lane]], 120, workspace)
    write(root, 'lane-analysis.json', {})
    inventory(root)
    canonical = a.validate_lane(root, lane, expected, archived=True)
    if write_analysis:
        canonical_path = root.parent / (lane + '-canonical.json')
        write(canonical_path.parent, canonical_path.name, canonical)
        subprocess.run(['node', '--input-type=module', '-e', "import {readFileSync,writeFileSync} from 'node:fs';import {analyzeLane} from './proofs/numeric-portability/report.mjs';const [input,output]=process.argv.slice(1);writeFileSync(output,JSON.stringify(analyzeLane(JSON.parse(readFileSync(input)),JSON.parse(readFileSync('./proofs/numeric-portability/protocol.json'))))+'\\n');", str(canonical_path), str(root / 'lane-analysis.json')], cwd=REPO, check=True)
        inventory(root)
    return expected, canonical
