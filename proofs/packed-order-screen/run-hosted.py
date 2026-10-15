"""Prospective packed-ordered-storage preparation and fixed 36-child screen.

This source has not been executed. A separately sealed publication and explicit
execution release are required. Importing it launches no processes.
"""
import base64
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
PREFIX = 'proofs/packed-order-screen'
WORKFLOW = '.github/workflows/packed-order-screen.yml'
BRANCH = 'proof/packed-order-screen-20261015'
BASE = 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e'
METHOD_SHA = '2ac7f4c1979eef5bf41cb798c4d9a1deb7f3312d987ada61d87b1ded13f65267'
CANDIDATE_SOURCE_SHA = '817bfb4fa24e6968d7699e7eec20a6bce9d55cd9484afe17d196ee1ab2883642'
FOCUSED_SOURCE_SEAL = 'f62fe13c044cbf13b066c674d42e7fa02a533812233bf229c38a471c4cfae1f4'
MEMORY_CASES = ('E0', 'N1', 'N32', 'N4096', 'N4097', 'N8192', 'N8193', 'P')
CLOSE_CASES = ('N4096', 'N4097', 'N8193', 'P')
CASES = ('P', 'E0', 'F128', 'F513', 'F100k', 'D100k', 'O32k')
ENGINES = ('node', 'bun')
ARMS = ('baseline', 'candidate')
GIB = 1 << 30
PHASES = {'probe': [('probe', 20)],
          'calibration': [('setup', 20), ('calibration', 90), ('final', 10)],
          'comparison': [('startup', 5), ('setup', 20), ('memory', 30), ('latency', 25), ('final', 5), ('exit', 5)]}
CORRECTNESS_PLAN = [(arm, kind, cap) for kind, cap in
                    [('bun-full-suite', 240), ('typecheck', 60), ('node-worker', 60)] for arm in ARMS]
BUILD_PLAN = [('baseline', 'native', 90), ('baseline', 'portable', 60),
              ('candidate', 'native', 90), ('candidate', 'portable', 60)]
PREP_COMMANDS = ['proof-head', 'proof-parent', 'proof-tree', 'proof-delta',
                 'locked-dependencies', 'node-version', 'node-identity', 'bun-version', 'bun-identity',
                 'archive-exact-main', 'check-fixed-patch', 'apply-fixed-patch',
                 'baseline-native', 'baseline-portable', 'candidate-native', 'candidate-portable'] + \
                [arm + '-' + kind for arm, kind, _ in CORRECTNESS_PLAN]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w') as stream:
        json.dump(data, stream, indent=2, allow_nan=False)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def append(path, data):
    with Path(path).open('a') as stream:
        stream.write(json.dumps(data, allow_nan=False) + '\n')
        stream.flush()


def substitute(value, bindings):
    """Only absolute host paths and the externally verified proof head vary."""
    if isinstance(value, dict):
        return {key: substitute(item, bindings) for key, item in value.items()}
    if isinstance(value, list):
        return [substitute(item, bindings) for item in value]
    if not isinstance(value, str):
        return value
    for token in re.findall(r'\$\{[A-Z_]+\}', value):
        require(token in bindings, 'unapproved template substitution: ' + token)
        value = value.replace(token, bindings[token])
    require('${' not in value, 'malformed template substitution')
    return value


def inventory(folder, generated=False, check=lambda: None):
    result = {}
    for directory, directories, files in os.walk(folder, followlinks=False):
        directories[:] = [name for name in directories if name not in ('.git', 'node_modules')
                          and (generated or name != 'dist')]
        for name in files:
            check()
            path = Path(directory) / name
            relative = path.relative_to(folder)
            native = len(relative.parts) == 1 and path.suffix in ('.wasm', '.wat')
            if (native or relative.parts[0] == 'dist') != generated:
                continue
            require(not path.is_symlink(), 'arm file symlink: ' + str(path))
            result[relative.as_posix()] = ({'sha256': sha(path), 'bytes': path.stat().st_size}
                                          if generated else sha(path))
    return dict(sorted(result.items()))


def source_closure(folder, check=lambda: None):
    pending, result = ['shared.ts'], {}
    while pending:
        check()
        name = pending.pop()
        if name in result:
            continue
        path = (folder / name).resolve(strict=True)
        require(path.is_relative_to(folder), 'Bun source import escaped arm')
        source = path.read_text()
        result[name] = sha(path)
        for specifier in re.findall(r'(?:from\s*|import\s*\(?\s*)[\'"](\.[^\'"]+)[\'"]', source):
            target = path.parent / specifier
            if not target.suffix:
                target = target.with_suffix('.ts')
            pending.append(target.resolve(strict=True).relative_to(folder).as_posix())
    return dict(sorted(result.items()))


def authenticate_portable(folder, expected, check=lambda: None):
    core = (folder / 'persistent-core.wasm').read_bytes()
    graph, embedded = {}, []
    for path in sorted((folder / 'dist').glob('*.js')):
        check()
        source = path.read_text()
        graph[path.name] = re.findall(r'(?:from\s*|import\s*)[\'"](\./[^\'"]+\.js)[\'"]', source)
        for match in re.finditer(r'function loadWasm\(\)\s*\{\s*const text = atob\("([A-Za-z0-9+/=]+)"\)', source):
            require(base64.b64decode(match[1], validate=True) == core, 'embedded and native core differ')
            embedded.append(path.name)
    require(embedded == [expected['embeddedFile']], 'embedded core location differs')
    pending, seen = ['shared.js'], set()
    while pending:
        check()
        name = pending.pop()
        if name in seen:
            continue
        require(name in graph, 'missing public portable import: ' + name)
        seen.add(name)
        pending.extend(Path(item).name for item in graph[name])
    require(sorted(seen) == expected['sharedEntryReachableFiles'], 'portable public import closure differs')
    require(sha(folder / 'persistent-core.wasm') == expected['coreSha256'], 'native core differs')
    require({path.name: {'sha256': sha(path), 'bytes': path.stat().st_size}
             for path in sorted((folder / 'dist').glob('*.js'))} == expected['generated'],
            'portable modules differ from focused outputs')


def dependency_inventory(root, check=lambda: None):
    """Observe regular files, symlink targets and unsupported types without following links."""
    observed = {'files': {}, 'symlinks': {}, 'other': {}}
    if not stat.S_ISDIR(root.lstat().st_mode):
        observed['other']['.'] = stat.S_IFMT(root.lstat().st_mode)
        return observed
    def failed(error):
        raise error
    for folder, directories, files in os.walk(root, followlinks=False, onerror=failed):
        for name in directories[:] + files:
            check()
            path = Path(folder) / name
            relative = str(path.relative_to(root))
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                observed['symlinks'][relative] = os.readlink(path)
                if name in directories:
                    directories.remove(name)
            elif stat.S_ISREG(mode):
                observed['files'][relative] = sha(path)
            elif stat.S_ISDIR(mode):
                if relative in ('.vite', '.vite-temp'):
                    directories.remove(name)
            else:
                observed['other'][relative] = stat.S_IFMT(mode)
    return observed


def validate_dependency_inventory(observed, manifest, metadata_sha):
    """Only npm's generated root hidden lock receives a per-run content binding."""
    assert manifest['mutable_cache_exclusions'] == ['.vite', '.vite-temp']
    assert re.fullmatch('[0-9a-f]{64}', metadata_sha)
    assert '.package-lock.json' in manifest['files']
    expected = dict(manifest['files'])
    expected['.package-lock.json'] = metadata_sha
    assert observed['other'] == {}, 'unsupported dependency entry type'
    assert observed['files'] == expected, 'dependency file paths, types or bytes changed'
    assert observed['symlinks'] == manifest['symlinks'], 'dependency link paths, types or targets changed'



def effective_memory():
    """Read host headroom and every visible limiting cgroup ancestor."""
    host = {key: int(value) * 1024 for key, value in re.findall(
        r'^(MemTotal|MemAvailable):\s+(\d+) kB$', Path('/proc/meminfo').read_text(), re.M)}
    require('MemAvailable' in host and 'MemTotal' in host, 'host memory accounting unavailable')
    memberships = []
    for line in Path('/proc/self/cgroup').read_text().splitlines():
        _, controllers, group = line.split(':', 2)
        controllers = controllers.split(',') if controllers else []
        if not controllers or 'memory' in controllers or 'cpu' in controllers:
            memberships.append((not controllers, group, controllers))
    rows, cpu_rows = [], []
    def unescape(value):
        return re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), value)
    mounts = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left, right = line.split(' - ', 1)
        fields, tail = left.split(), right.split()
        controllers = tail[2].split(',')
        if tail[0] == 'cgroup2' or (tail[0] == 'cgroup' and ('memory' in controllers or 'cpu' in controllers)):
            mounts.append((tail[0] == 'cgroup2', Path(unescape(fields[3])), Path(unescape(fields[4])), controllers))
    for unified, group, controllers in memberships:
        matching = [(root, mount) for version, root, mount, supported in mounts
                    if version == unified and Path(group).is_relative_to(root) and
                    (unified or set(controllers).intersection(supported))]
        require(matching, 'cannot resolve effective resource cgroup')
        root, mount = max(matching, key=lambda item: len(item[0].parts))
        current = mount / Path(group).relative_to(root)
        while True:
            limit_file = current / ('memory.max' if unified else 'memory.limit_in_bytes')
            usage_file = current / ('memory.current' if unified else 'memory.usage_in_bytes')
            if (unified or 'memory' in controllers) and limit_file.exists():
                limit_text = limit_file.read_text().strip()
                usage = int(usage_file.read_text().strip())
                limit = None if limit_text == 'max' else int(limit_text)
                rows.append({'version': 2 if unified else 1, 'limitBytes': limit, 'usageBytes': usage,
                             'availableBytes': None if limit is None else max(0, limit - usage)})
            if unified and (current / 'cpu.max').exists():
                quota, period = (current / 'cpu.max').read_text().split()
                cpu_rows.append({'version': 2, 'quotaMicroseconds': None if quota == 'max' else int(quota),
                                 'periodMicroseconds': int(period)})
            elif not unified and 'cpu' in controllers and (current / 'cpu.cfs_quota_us').exists():
                quota = int((current / 'cpu.cfs_quota_us').read_text())
                cpu_rows.append({'version': 1, 'quotaMicroseconds': None if quota < 0 else quota,
                                 'periodMicroseconds': int((current / 'cpu.cfs_period_us').read_text())})
            require(current.is_relative_to(mount), 'cgroup ancestor escaped mount')
            if current == mount:
                break
            current = current.parent
    available = min([host['MemAvailable']] + [row['availableBytes'] for row in rows
                                            if row['availableBytes'] is not None])
    host_cpus, affinity_cpus = os.cpu_count(), len(os.sched_getaffinity(0))
    return {'host': host, 'cgroups': rows, 'effectiveAvailableBytes': available,
            'effectiveLimitBytes': min([host['MemTotal']] + [row['limitBytes'] for row in rows
                                                           if row['limitBytes'] is not None]),
            'cpu': {'hostLogicalCount': host_cpus, 'affinityCount': affinity_cpus, 'cgroupQuotas': cpu_rows,
                    'effectiveCpuBudget': min([host_cpus, affinity_cpus] +
                        [row['quotaMicroseconds'] / row['periodMicroseconds'] for row in cpu_rows
                         if row['quotaMicroseconds'] is not None])}}


def group_memory(group):
    rows = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) != group:
                continue
            values = {name: int(value) * 1024 for name, value in re.findall(
                r'^(VmRSS|VmHWM):\s+(\d+) kB$', (path / 'status').read_text(), re.M)}
            rows.append({'pid': int(path.name), **values})
        except (FileNotFoundError, ProcessLookupError):
            pass
    return rows


def signal_group(group):
    try:
        os.killpg(group, signal.SIGKILL)
    except ProcessLookupError:
        pass


def planned_jobs():
    jobs = []
    def add(mode, engine, arm=None, pair=None, position=None):
        rotation = 0 if pair is None else pair % len(CASES)
        order = list(CASES[rotation:] + CASES[:rotation])
        jobs.append({'schema': 1, 'jobId': f'{len(jobs)+1:02d}-{mode}-{engine}' +
                     ('' if pair is None else f'-p{pair}-{arm}'),
                     'mode': mode, 'engine': engine, 'arm': arm, 'pairIndex': pair,
                     'pairPosition': position, 'caseOrder': order,
                     'endpointOrder': ['full', 'first'] if pair is not None and pair % 2 else ['first', 'full'],
                     'entrypoint': None, 'calibration': None,
                     'phaseLimitsSeconds': dict(PHASES[mode])})
    for engine in ENGINES:
        add('probe', engine)
    for engine in ENGINES:
        add('calibration', engine, 'baseline')
    for pair in range(8):
        for engine in ENGINES if pair % 2 == 0 else ENGINES[::-1]:
            for position, arm in enumerate(ARMS if pair % 2 == 0 else ARMS[::-1]):
                add('comparison', engine, arm, pair, position)
    require(len(jobs) == 36, 'fixed scientific schedule differs')
    return jobs


def iteration_order(job):
    close_cases = CLOSE_CASES[::-1] if job['endpointOrder'][0] == 'full' else CLOSE_CASES
    return [(case, endpoint) for case in job['caseOrder'] for endpoint in job['endpointOrder']] + \
           [(case, 'close') for case in close_cases]


def calibration_endpoint_set():
    result = {case: {'first', 'full'} for case in CASES}
    for case in CLOSE_CASES:
        result.setdefault(case, set()).add('close')
    return result


def fixed_ladder(case, endpoint):
    ladder = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536]
    if endpoint == 'close' or case in ('E0', 'F128', 'F513'):
        ladder += [262144, 1048576]
    return ladder


def validate_comparison_records(job, records):
    """Keep complete raw chunks, startup states and each fixed memory cycle in custody."""
    results = [row['result'] for row in records if row.get('event') == 'result']
    require(len(results) == 1, 'missing or duplicate comparison result')
    result = results[0]
    require([row.get('event') for row in records] ==
            ['phase', 'startup', 'phase', 'phase', 'memory', 'phase'] + ['sample'] * 180 +
            ['phase', 'result', 'phase'], 'comparison record sequence or unexpected record differs')
    samples = [row for row in records if row.get('event') == 'sample']
    expected = [(case, endpoint, kind, index) for case, endpoint in iteration_order(job)
                for kind, count in [('warmup', 4), ('measured', 6)] for index in range(count)]
    require(len(samples) == len(expected) == 180, 'comparison raw chunk count differs')
    require(set(result['endpoints']) == {case + ':' + endpoint for case, endpoint in iteration_order(job)} |
            {'startup:import'}, 'comparison endpoint set differs')
    for sample, (case, endpoint, kind, index) in zip(samples, expected):
        summary = result['endpoints'][case + ':' + endpoint]
        frozen = job['calibration'][case][endpoint]
        require((sample.get('case'), sample.get('endpoint'), sample.get('kind'), sample.get('index')) ==
                (case, endpoint, kind, index), 'raw chunk identity/order differs')
        require(sample['k'] == summary['k'] == frozen['k'] and
                sample['milliseconds'] == summary[kind + '_ms'][index], 'raw chunk and process summary differ')
        require(type(sample['milliseconds']) in (int, float) and math.isfinite(sample['milliseconds']) and
                sample['milliseconds'] >= 0, 'invalid comparison raw duration')
        require(len(summary['warmup_ms']) == 4 and len(summary['measured_ms']) == 6, 'fixed chunk arrays differ')
        if frozen.get('resolved') is not True:
            require(summary.get('eligible') is False, 'unresolved baseline calibration was cleared')
    startup = [row for row in records if row.get('event') == 'startup']
    require(len(startup) == 1 and startup[0]['startup'] == result['startup'] and
            startup[0]['endpoint'] == result['endpoints']['startup:import'], 'startup raw/summary custody differs')
    endpoint = startup[0]['endpoint']
    require(endpoint['k'] == 1 and endpoint['warmup_ms'] == [] and len(endpoint['measured_ms']) == 1,
            'fresh import must contain one observation and no warmup')
    duration = endpoint['measured_ms'][0]
    require(type(duration) in (int, float) and math.isfinite(duration) and duration >= 0,
            'invalid fresh import raw duration')
    require(set(startup[0]['startup']) == {'before', 'after', 'eligible', 'invalid_reasons'},
            'startup memory state set differs')
    memory = [row['memory'] for row in records if row.get('event') == 'memory']
    require(len(memory) == 1 and memory[0] == result['memory'], 'raw memory and process summary differ')
    require(set(memory[0]['cases']) == set(MEMORY_CASES), 'memory case set differs')
    for case in MEMORY_CASES:
        cycles = memory[0]['cases'][case]['cycles']
        require(len(cycles) == (2 if case == 'P' else 1), 'memory cycle count differs: ' + case)
        for cycle in cycles:
            require(set(cycle) == {'before', 'rawPaused', 'paused', 'released', 'resumed_ok'},
                    'memory cycle state set differs: ' + case)
            require((cycle['rawPaused'] is not None) == (case in ('N4096', 'N4097', 'N8192', 'N8193', 'P')),
                    'fixed raw-pause diagnostic presence differs: ' + case)


def validate_calibration_records(job, records):
    results = [row['result'] for row in records if row.get('event') == 'result']
    require(len(results) == 1, 'missing or duplicate calibration result')
    calibration = results[0]['calibration']
    expected_set = calibration_endpoint_set()
    require(set(calibration) == set(expected_set), 'calibration case set differs')
    require(not any(row.get('event') == 'startup' for row in records), 'calibration must not measure import')
    for case, endpoints in expected_set.items():
        require(set(calibration[case]) == endpoints, 'calibration endpoint set differs')
    raw = [row for row in records if row.get('event') == 'calibration-chunk']
    require([row.get('event') for row in records] == ['phase', 'phase'] +
            ['calibration-chunk'] * len(raw) + ['phase', 'result'],
            'calibration raw record sequence differs')
    position = 0
    for case, endpoint in iteration_order(job):
        ladder = fixed_ladder(case, endpoint)
        summary = calibration[case][endpoint]
        observed, verification = summary['ladder'], summary['verification_ms']
        require(observed and len(observed) <= len(ladder) and len(verification) == 3, 'calibration chunk count differs')
        require([row['k'] for row in observed] == ladder[:len(observed)] and
                all(row['milliseconds'] < 20 for row in observed[:-1]) and
                (observed[-1]['milliseconds'] >= 20 or len(observed) == len(ladder)) and
                summary['k'] == observed[-1]['k'], 'calibration did not select first qualifying fixed rung')
        expected = [(row['k'], row['milliseconds'], 'ladder', None) for row in observed] + \
                   [(summary['k'], value, 'verification', index) for index, value in enumerate(verification)]
        for k, milliseconds, kind, index in expected:
            require(position < len(raw), 'missing calibration raw chunk')
            row = raw[position]
            position += 1
            require((row.get('case'), row.get('endpoint'), row.get('kind'), row.get('k'), row.get('milliseconds')) ==
                    (case, endpoint, kind, k, milliseconds), 'calibration raw/summary mismatch')
            require(index is None or row.get('index') == index, 'calibration verification order differs')
            require(type(milliseconds) in (int, float) and math.isfinite(milliseconds) and milliseconds >= 0,
                    'invalid calibration duration')
        if sum(verification) / 3 < 5:
            require(summary.get('resolved') is False, 'calibration below the 5 ms floor was cleared')
    require(position == len(raw), 'unexpected calibration raw chunks')


def invalidate_positive_summary(analysis, reason):
    """Revoke positive terminal conclusions without erasing valid adverse statistics."""
    analysis['complete'] = False
    analysis['all_38_latency_controls_cleared'] = False
    analysis['all_22_memory_contrasts_cleared'] = False
    analysis['scoped_node_lead_eligible'] = False
    analysis['strong_scoped_screen_clearance'] = False
    analysis['bun_material_benefit_corroborated'] = False
    analysis['terminal_eligibility_verified'] = False
    analysis['terminal_failure'] = reason
    if analysis.get('disposition') in ('scoped_node_retained_memory_lead', 'strong_scoped_screen_clearance'):
        analysis['disposition'] = ('material_adverse_control_veto' if analysis.get('unchanged_candidate_advancement_veto')
                                   else 'inconclusive_or_incomplete')


class Run:
    def __init__(self, mode, root, provision=None):
        self.mode, self.root, self.provision = mode, root, provision
        require(not root.exists() and not root.is_relative_to(REPO), 'fresh external output root required')
        self.start = time.monotonic()
        self.end = self.start + (1620 if mode == 'prepare' else 3430)
        self.deadline = self.start + (840 if mode == 'prepare' else 120)
        self.stage, self.active, self.interrupted = mode, None, None
        self.root.mkdir(parents=True)
        self.artifact = root / 'artifact' if mode == 'prepare' else root
        self.artifact.mkdir(exist_ok=True)
        self.receipts, self.sources, self.outputs, self.executables, self.jobs = [], {}, {}, {}, []
        self.config, self.payload, self.payload_sha = {}, {}, None
        self.hidden_lock_sha = None
        self.arms = {arm: (root if mode == 'prepare' else provision) / 'arms' / arm for arm in ARMS}
        self.env = {key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ')
                    if key in os.environ}
        self.env.update(CI='1', NODE_OPTIONS='', BUN_OPTIONS='', npm_config_audit='false',
                        npm_config_fund='false', npm_config_offline='true')
        self.result = {'kind': 'packed-order-' + mode, 'complete': False, 'firstFailure': None,
                       'baseCommit': BASE, 'methodSha256': METHOD_SHA, 'scientificChildrenStarted': 0,
                       'plannedScientificChildren': 36, 'preparationSeconds': 1620, 'screenSeconds': 3430,
                       'sampledGroupRssBytes': (4 if mode == 'prepare' else 2) * GIB,
                       'rssSamplePeriodSeconds': .05, 'hardCgroupCap': False,
                       'runId': os.environ.get('GITHUB_RUN_ID'), 'attempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
                       'unrunCommands': list(PREP_COMMANDS) if mode == 'prepare' else [],
                       'publicationRelease': False, 'ordinaryCorrectnessClearance': False}
        write(self.artifact / 'result.json', self.result)

    def fail(self, error):
        if self.result['firstFailure'] is None:
            self.result['firstFailure'] = str(error)
        self.result['complete'] = False
        self.result['readyForScreen'] = False
        self.result['eligibleForIndependentReview'] = False
        if 'analysis' in self.result:
            invalidate_positive_summary(self.result['analysis'], self.result['firstFailure'])

    def persist_analysis(self):
        if 'analysis' in self.result:
            write(self.artifact / 'analysis.json', self.result['analysis'])

    def budget(self):
        require(not self.interrupted or self.stage in ('analysis and sealing', 'final cleanup and preservation'), 'interrupted')
        require(time.monotonic() < self.deadline, self.stage + ' deadline exhausted')

    def stage_until(self, name, deadline):
        self.stage, self.deadline = name, min(deadline, self.end)
        self.budget()
        signal.setitimer(signal.ITIMER_REAL, max(.001, self.deadline - time.monotonic()))

    def packet(self, name):
        path = HERE / name
        resolved = path.resolve(strict=True)
        require(resolved.is_relative_to(HERE) and not path.is_symlink(), 'packet path escaped: ' + name)
        require(PREFIX + '/' + name in self.payload, 'unsealed packet input: ' + name)
        return resolved

    def authenticate_inputs(self):
        self.budget()
        require(self.payload_sha is not None and sha(HERE / 'INPUT-SHA256.json') == self.payload_sha,
                'immutable payload manifest changed')
        for name, digest in self.payload.items():
            self.budget()
            original = REPO / name
            path = original.resolve(strict=True)
            require(path.is_relative_to(REPO) and not original.is_symlink() and sha(path) == digest,
                    'publication file changed: ' + name)
        for arm, expected in self.sources.items():
            require(inventory(self.arms[arm], check=self.budget) == expected, 'source inventory changed: ' + arm)
        for arm, expected in self.outputs.items():
            require(inventory(self.arms[arm], True, self.budget) == expected, 'output inventory changed: ' + arm)
        for engine, pin in self.executables.items():
            self.budget()
            path = Path(pin['path'])
            require(sha(path) == pin['sha256'] and path.stat().st_size == pin['bytes'], 'executable changed: ' + engine)
        toolchain = (self.root if self.mode == 'prepare' else self.provision) / 'toolchain'
        if toolchain.exists():
            for key, name in [('package', 'package.json'), ('lock', 'package-lock.json')]:
                require(sha(toolchain / name) == sha(self.packet(self.config['toolchain'][key])), 'toolchain pin changed')
            if self.hidden_lock_sha is not None:
                metadata = toolchain / 'node_modules/.package-lock.json'
                require(stat.S_ISREG(metadata.lstat().st_mode), 'hidden lock must remain a regular file')
                require(sha(metadata) == self.hidden_lock_sha, 'hidden lock changed within this run')

    def begin(self):
        self.payload = read(HERE / 'INPUT-SHA256.json')
        self.payload_sha = sha(HERE / 'INPUT-SHA256.json')
        require(PREFIX + '/INPUT-SHA256.json' not in self.payload, 'payload manifest must not hash itself')
        require(WORKFLOW in self.payload and PREFIX + '/run-hosted.py' in self.payload,
                'required publication files missing')
        self.config = read(HERE / 'inputs.json')
        self.authenticate_inputs()
        require(self.config['schema'] == 1 and self.config['baseCommit'] == BASE, 'input identity differs')
        require(sha(self.packet(self.config['toolchain']['dependencyInventory'])) ==
                self.config['toolchain']['dependencyInventorySha256'], 'hosted dependency inventory identity differs')
        execution_template, release_template = read(HERE / 'EXECUTION-TEMPLATE.json'), read(HERE / 'RELEASE-TEMPLATE.json')
        require(execution_template.get('executionReleased') is True and release_template.get('approved') is True,
                'preparation/screen execution has not been released')
        for template in (execution_template, release_template):
            for name in ('run-hosted.py', 'subject.mjs', 'analysis.py'):
                pin = template.get('implementationFiles', {}).get(name)
                require(isinstance(pin, str) and re.fullmatch('[0-9a-f]{64}', pin) and
                        sha(self.packet(name)) == pin, 'released exact implementation pin absent/different: ' + name)
        for template in (execution_template, release_template):
            require(template.get('schema') == 1 and template.get('subjectChildren') == 36 and
                    template.get('screenSeconds') == 3430 and template.get('preparationSeconds') == 1620,
                    'released finite scope differs')
        require(self.config['method']['sha256'] == METHOD_SHA and
                sha(self.packet(self.config['method']['path'])) == METHOD_SHA, 'method differs')
        for supplement in (self.config['method']['implementationNote'], self.config['focusedEvidence']['localFullSuiteSummary']):
            require(sha(self.packet(supplement['path'])) == supplement['sha256'], 'method/correctness supplement changed')
        seal = self.config['focusedEvidence']['sourceSeal']
        require(seal['sha256'] == FOCUSED_SOURCE_SEAL and sha(self.packet(seal['path'])) == FOCUSED_SOURCE_SEAL,
                'focused packed-candidate source seal differs')
        require(set(self.config['requiredReviews']) ==
                {'controller', 'subject', 'analysis', 'correctness', 'hostedCorrectnessRunner'},
                'required independent review set differs')
        require(self.config['hostedCorrectness'].get('runnerReviewed') is True,
                'hosted correctness source has not passed independent review')
        require(self.config['criticalValues'].get('independentlyValidated') is True,
                'new critical values lack independent validation')
        for review_name, review in self.config['requiredReviews'].items():
            require(review.get('approved') is True and isinstance(review.get('sha256'), str) and
                    re.fullmatch('[0-9a-f]{64}', review['sha256']), 'missing approved independent review: ' + review_name)
            require(sha(self.packet(review['path'])) == review['sha256'], 'independent review differs: ' + review_name)
        for key in ('review', 'seal', 'values'):
            pin = self.config['criticalValues'].get(key + 'Sha256')
            require(isinstance(pin, str) and re.fullmatch('[0-9a-f]{64}', pin), 'critical-value exact pin absent: ' + key)
            require(sha(self.packet(self.config['criticalValues'][key])) == pin,
                    'independent critical-value provenance differs')
        require(self.config['criticalValues']['latencyContrasts'] == 38 and
                self.config['criticalValues']['memoryContrasts'] == 22, 'critical-value multiplicity differs')
        require(os.environ.get('GITHUB_REPOSITORY') == 'natanelia/zerocopy', 'repository differs')
        require(os.environ.get('GITHUB_EVENT_NAME') == 'push' and
                os.environ.get('GITHUB_REF') == 'refs/heads/' + BRANCH, 'unreleased event or branch')
        require(os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'attempt must be one; no retry')
        require(os.environ.get('RUNNER_OS') == 'Linux' and os.environ.get('RUNNER_ARCH') == 'X64', 'host differs')
        admission = effective_memory()
        system = os.uname()
        cpu_models = sorted(set(re.findall(r'^model name\s*:\s*(.+)$', Path('/proc/cpuinfo').read_text(), re.M)))
        write(self.artifact / 'host.json', {'resourceAdmission': admission,
              'system': {'name': system.sysname, 'release': system.release, 'machine': system.machine,
                         'cpuModels': cpu_models},
              'python': {'sha256': sha(Path(sys.executable).resolve()),
                         'version': sys.version}, 'actions': self.config['actions'],
              'runner': {key: os.environ.get(key) for key in ('ImageOS', 'ImageVersion', 'GITHUB_SHA',
                         'GITHUB_REF', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT')}})
        require(admission['effectiveAvailableBytes'] >= (5 if self.mode == 'prepare' else 4) * GIB,
                'insufficient effective host/container memory headroom')

    def command(self, label, argv, cwd, cap, extra_env=None, job=None, rss_limit=None):
        self.budget()
        require(self.active is None and not self.interrupted, 'previous process still owned')
        started = time.monotonic()
        limit = min(self.deadline, started + cap)
        logs = self.artifact / 'logs'
        logs.mkdir(exist_ok=True)
        receipt = {'label': label, 'argv': [str(item) for item in argv], 'cwd': str(cwd),
                   'capSeconds': cap, 'effectiveCapSeconds': limit - started, 'valid': False,
                   'sampledGroupRssLimitBytes': rss_limit if rss_limit is not None else (4 if job is None else 2) * GIB,
                   'peakObservedGroupRssBytes': 0, 'peakObservedProcessHwmBytes': 0,
                   'samplePeriodSeconds': .05, 'hardCgroupCap': False, 'cleanupSignals': [],
                   'environmentOverrides': extra_env or {}, 'phaseEvents': []}
        self.receipts.append(receipt)
        write(self.artifact / 'command-receipts.json', self.receipts)
        records = []
        if job is not None:
            self.jobs.append({'input': job, 'receipt': receipt, 'records': records})
        reason, seen, unexpected = None, set(), set()
        phase_index, phase_seen = 0, False
        phase_deadline = min(limit, started + PHASES[job['mode']][0][1]) if job else limit
        pending = b''
        def drain(stream, terminal=False):
            nonlocal pending, phase_index, phase_seen, phase_deadline, reason
            if job is None:
                return
            pending += stream.read()
            while b'\n' in pending:
                raw, pending = pending.split(b'\n', 1)
                observed = time.monotonic()
                try:
                    row = json.loads(raw)
                    require(row.get('schema') == 1 and row.get('jobId') == job['jobId'], 'JSONL identity differs')
                    records.append(row)
                    if observed >= limit or observed >= phase_deadline:
                        reason = reason or 'late child output after enforced deadline'
                    if row.get('event') == 'phase':
                        phases = PHASES[job['mode']]
                        expected = phase_index + (1 if phase_seen else 0)
                        require(expected < len(phases) and row.get('phase') == phases[expected][0], 'invalid phase transition')
                        phase_index = expected
                        if phase_seen:
                            phase_deadline = min(limit, observed + phases[phase_index][1])
                        phase_seen = True
                        receipt['phaseEvents'].append({'phase': row['phase'], 'receivedSeconds': observed - started,
                                                       'deadlineSeconds': phase_deadline - started})
                        if row['phase'] in ('memory', 'calibration'):
                            for key in ('postFixtureRssBytes', 'uniqueArenaCapacityBytes', 'uniqueArenaUsedBytes'):
                                require(isinstance(row.get(key), int) and row[key] >= 0, 'missing post-fixture admission: ' + key)
                            require(row['postFixtureRssBytes'] <= GIB, 'post-fixture RSS admission exceeded')
                            require(row['uniqueArenaCapacityBytes'] <= GIB // 2, 'unique arena admission exceeded')
                            require(row['uniqueArenaUsedBytes'] <= row['uniqueArenaCapacityBytes'], 'invalid unique arena use')
                            current = group_memory(self.active.pid)
                            require(sum(item.get('VmRSS', 0) for item in current) <= GIB,
                                    'externally sampled post-fixture RSS admission exceeded')
                    elif row.get('event') == 'error':
                        reason = reason or 'subject reported failure: ' + str(row.get('message', row))
                    elif row.get('event') == 'result':
                        result = row['result']
                        require(isinstance(result, dict) and result.get('engine') == job['engine'] and
                                result.get('mode') == job['mode'], 'subject result identity differs')
                        if job['mode'] != 'probe':
                            require(result.get('arm') == job['arm'] and result.get('identity_ok') is True and
                                    result.get('oracle_ok') is True and result.get('backing_ok') is True,
                                    'subject identity/oracle/backing check failed')
                        if job['mode'] == 'comparison':
                            require(result.get('pair') == job['pairIndex'] and result.get('eligible') is True,
                                    'subject comparison failed')
                except (ValueError, TypeError, KeyError) as error:
                    reason = reason or 'invalid child record: ' + str(error)
            if terminal and pending:
                reason = reason or 'unterminated JSONL record'
        with (logs / (label + '.stdout')).open('xb') as out, (logs / (label + '.stderr')).open('xb') as err:
            child = subprocess.Popen(receipt['argv'], cwd=cwd, env={**self.env, **(extra_env or {})},
                                     stdout=out, stderr=err, start_new_session=True)
            self.active = child
            receipt['ownedProcessGroup'] = child.pid
            if job:
                self.result['scientificChildrenStarted'] += 1
            if label in self.result['unrunCommands']:
                self.result['unrunCommands'].remove(label)
            append(self.artifact / 'progress.jsonl', {'event': 'command-start', 'label': label})
            with (logs / (label + '.stdout')).open('rb') as incoming:
                while True:
                    now = time.monotonic()
                    rows = group_memory(child.pid)
                    seen.update(row['pid'] for row in rows)
                    if job:
                        unexpected.update(row['pid'] for row in rows if row['pid'] != child.pid)
                    rss = sum(row.get('VmRSS', 0) for row in rows)
                    hwm = max([row.get('VmHWM', 0) for row in rows] or [0])
                    receipt['peakObservedGroupRssBytes'] = max(receipt['peakObservedGroupRssBytes'], rss)
                    receipt['peakObservedProcessHwmBytes'] = max(receipt['peakObservedProcessHwmBytes'], hwm)
                    append(logs / (label + '.rss.jsonl'), {'seconds': now - started, 'groupRssBytes': rss,
                                                        'processes': rows})
                    drain(incoming)
                    if self.interrupted:
                        reason = reason or 'interrupted'
                    if now >= limit or now >= phase_deadline:
                        reason = reason or 'child or phase wall deadline exceeded'
                    if max(rss, hwm) > receipt['sampledGroupRssLimitBytes']:
                        reason = reason or 'sampled process-group RSS cap exceeded'
                    if unexpected:
                        reason = reason or 'unexpected scientific process-group member'
                    if reason and not receipt['cleanupSignals']:
                        signal_group(child.pid)
                        receipt['cleanupSignals'].append('SIGKILL original group: ' + reason)
                    exited = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                    if exited:
                        drain(incoming, terminal=True)
                        break
                    if reason and time.monotonic() >= min(self.end, limit + 2):
                        raise RuntimeError('owned original group did not terminate after SIGKILL')
                    time.sleep(min(.05, max(.001, min(limit, phase_deadline) - time.monotonic())))
        descendants = lambda: [row for row in group_memory(child.pid) if row['pid'] != child.pid]
        leftover = descendants()
        if leftover:
            signal_group(child.pid)
            receipt['cleanupSignals'].append('SIGKILL descendants before leader reap')
            stop = min(self.end, time.monotonic() + 1)
            while descendants() and time.monotonic() < stop:
                time.sleep(.01)
        remaining = descendants()
        if remaining:
            receipt.update(failure=reason or 'descendants remain after bounded cleanup',
                           descendantsAfterCleanup=remaining, leaderReapedAfterCleanup=False)
            write(self.artifact / 'command-receipts.json', self.receipts)
            # Keep the unreaped leader as the original group identity for final cleanup.
            raise RuntimeError('original-group descendants remain before leader reap')
        # WNOWAIT preserves the original group identity until inspection finishes.
        # Clear signal authority before reap so PID reuse cannot redirect a kill.
        self.active = None
        _, status, usage = os.wait4(child.pid, 0)
        child.returncode = os.waitstatus_to_exitcode(status)
        if time.monotonic() >= limit or time.monotonic() >= phase_deadline:
            reason = reason or 'deadline exceeded at terminal cleanup'
        if usage.ru_maxrss * 1024 > receipt['sampledGroupRssLimitBytes']:
            reason = reason or 'terminal process high-water RSS cap exceeded'
        if job and (not phase_seen or phase_index != len(PHASES[job['mode']]) - 1):
            reason = reason or 'incomplete child phase sequence'
        if job and len([row for row in records if row.get('event') == 'result']) != 1:
            reason = reason or 'missing or duplicate subject result'
        if job and job['mode'] == 'probe' and [row.get('event') for row in records] != ['phase', 'result']:
            reason = reason or 'probe raw record sequence differs'
        if job and job['mode'] == 'comparison':
            try:
                validate_comparison_records(job, records)
            except (ValueError, TypeError, KeyError, IndexError) as error:
                reason = reason or 'raw comparison validation failed: ' + str(error)
        if job and job['mode'] == 'calibration':
            try:
                validate_calibration_records(job, records)
            except (ValueError, TypeError, KeyError, IndexError) as error:
                reason = reason or 'raw calibration validation failed: ' + str(error)
        receipt.update(exitCode=child.returncode, failure=reason, elapsedSecondsForCapOnly=time.monotonic() - started,
                       seenPids=sorted(seen), unexpectedSampledGroupMembers=sorted(unexpected),
                       leftoverDescendantsBeforeCleanup=leftover, descendantsAfterCleanup=remaining,
                       leaderReapedAfterCleanup=True, wait4MaxRssBytes=usage.ru_maxrss * 1024)
        for suffix in ('stdout', 'stderr', 'rss.jsonl'):
            path = logs / (label + '.' + suffix)
            receipt[suffix] = {'sha256': sha(path), 'bytes': path.stat().st_size}
        receipt['valid'] = not reason and child.returncode == 0 and not leftover and not remaining and not self.interrupted
        write(self.artifact / 'command-receipts.json', self.receipts)
        append(self.artifact / 'progress.jsonl', {'event': 'command-end', 'label': label,
                                                'exitCode': child.returncode, 'failure': reason})
        require(receipt['valid'], 'command failed without retry: ' + label + ': ' + str(reason or child.returncode))
        self.budget()
        return receipt, records

    def output(self, label):
        return (self.artifact / 'logs' / (label + '.stdout')).read_text().strip()

    def prepare(self):
        self.begin()
        self.command('proof-head', ['git', 'rev-parse', 'HEAD'], REPO, 10)
        self.head = self.output('proof-head')
        require(re.fullmatch('[0-9a-f]{40}', self.head) and self.head == os.environ.get('GITHUB_SHA'), 'proof/event HEAD differs')
        self.command('proof-parent', ['git', 'rev-list', '--parents', '-n', '1', 'HEAD'], REPO, 10)
        require(self.output('proof-parent').split() == [self.head, BASE], 'proof sole parent differs')
        self.command('proof-tree', ['git', 'rev-parse', 'HEAD^{tree}'], REPO, 10)
        self.command('proof-delta', ['git', 'diff', '--name-status', '-z', BASE, 'HEAD'], REPO, 10)
        delta = (self.artifact / 'logs/proof-delta.stdout').read_bytes().split(b'\0')[:-1]
        require(len(delta) % 2 == 0, 'invalid Git delta')
        changes = {delta[index+1].decode(): delta[index].decode() for index in range(0, len(delta), 2)}
        require(changes == {name: 'A' for name in set(self.payload) | {PREFIX + '/INPUT-SHA256.json'}},
                'proof tree has missing or unrelated changes')
        self.result.update(proofCommit=self.head, proofTree=self.output('proof-tree'), inputManifestSha256=self.payload_sha)
        write(self.artifact / 'proof-delta.json', changes)
        self.node = Path(shutil.which('node')).resolve(strict=True)
        require(sha(self.node) == self.config['executables']['node']['sha256'], 'Node executable differs')
        npm = self.node.parent.parent / 'lib/node_modules/npm/bin/npm-cli.js'
        require(sha(npm) == self.config['npmCliSha256'], 'npm CLI differs')
        toolchain = self.root / 'toolchain'
        toolchain.mkdir()
        for key, name in [('package', 'package.json'), ('lock', 'package-lock.json')]:
            self.budget()
            shutil.copyfile(self.packet(self.config['toolchain'][key]), toolchain / name)
        self.env['PATH'] = str(self.node.parent) + os.pathsep + self.env['PATH']
        self.command('locked-dependencies', [self.node, npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
                     toolchain, 180, {'npm_config_offline': 'false', 'npm_config_registry': 'https://registry.npmjs.org/'})
        observed = dependency_inventory(toolchain / 'node_modules', self.budget)
        metadata = toolchain / 'node_modules/.package-lock.json'
        require(stat.S_ISREG(metadata.lstat().st_mode), 'hidden lock must be a regular file')
        self.hidden_lock_sha = sha(metadata)
        validate_dependency_inventory(observed, read(self.packet(self.config['toolchain']['dependencyInventory'])),
                                      self.hidden_lock_sha)
        write(self.artifact / 'dependency-inventory.json', observed)
        shutil.copyfile(metadata, self.artifact / 'npm-hidden-lock.json')
        self.bun = (toolchain / 'node_modules/@oven/bun-linux-x64/bin/bun').resolve(strict=True)
        require(sha(self.bun) == self.config['executables']['bun']['sha256'], 'Bun executable differs')
        self.env['PATH'] = str(self.bun.parent) + os.pathsep + str(toolchain / 'node_modules/.bin') + os.pathsep + self.env['PATH']
        for engine, path in [('node', self.node), ('bun', self.bun)]:
            pin = self.config['executables'][engine]
            self.command(engine + '-version', [path, '--version'], toolchain, 5)
            require(self.output(engine + '-version').lstrip('v') == pin['version'], 'runtime version differs')
            self.command(engine + '-identity', [path, '-p', 'JSON.stringify({execPath:process.execPath,version:process.version,versions:process.versions})'], toolchain, 5)
            identity = json.loads(self.output(engine + '-identity'))
            require(Path(identity['execPath']).resolve() == path, 'runtime executable identity differs')
            self.executables[engine] = {**pin, 'path': str(path), 'identity': identity}
        self.authenticate_inputs()
        archive = self.root / 'main.tar'
        self.command('archive-exact-main', ['git', 'archive', '--format=tar', BASE, '-o', archive], REPO, 30)
        pristine = read(self.packet(self.config['pristineSources']))
        require(len(pristine) == 502, 'pristine source count differs')
        for arm, folder in self.arms.items():
            folder.mkdir(parents=True)
            with tarfile.open(archive) as source:
                for member in source:
                    self.budget()
                    require(not member.issym() and not member.islnk(), 'archive contains a link')
                    source.extract(member, folder, filter='data')
            require(inventory(folder, check=self.budget) == pristine, 'pristine extracted sources differ')
        patch = self.packet(self.config['candidatePatch'])
        self.command('check-fixed-patch', ['git', 'apply', '--check', '-p1', patch], self.arms['candidate'], 10)
        self.command('apply-fixed-patch', ['git', 'apply', '-p1', patch], self.arms['candidate'], 10)
        for arm, folder in self.arms.items():
            for overlay in self.config['commonOverlays']:
                self.budget()
                target = folder / overlay['target']
                require(target.resolve().is_relative_to(folder), 'overlay target escaped arm')
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(self.packet(overlay['source']), target)
            self.sources[arm] = read(self.packet(self.config['arms'][arm]['sources']))
            require(len(self.sources[arm]) == 504 and inventory(folder, check=self.budget) == self.sources[arm],
                    'execution source inventory differs: ' + arm)
            (folder / 'node_modules').symlink_to(toolchain / 'node_modules', target_is_directory=True)
        require(set(self.sources['baseline']) == set(self.sources['candidate']) and
                {name for name in self.sources['baseline'] if self.sources['baseline'][name] != self.sources['candidate'][name]}
                == {'shared-ordered-map.ts'}, 'unexpected production/source difference')
        require(self.sources['candidate']['shared-ordered-map.ts'] == CANDIDATE_SOURCE_SHA, 'candidate production bytes differ')
        for arm, kind, cap in BUILD_PLAN:
            self.authenticate_inputs()
            self.command(arm + '-' + kind,
                         [self.node, 'scripts/build-wasm.mjs'] if kind == 'native' else [self.bun, 'scripts/build-browser.ts'],
                         self.arms[arm], cap)
            expected = read(self.packet(self.config['arms'][arm]['generated']))
            require(len(expected) == 24, 'expected output count differs')
            if kind == 'native':
                # Native build emits diagnostic WAT; authenticate then retain outside the runtime arm.
                extra = read(self.packet(self.config['nativeBuildExtra']))
                for name, pin in extra.items():
                    path = self.arms[arm] / name
                    require(sha(path) == pin['sha256'] and path.stat().st_size == pin['bytes'],
                            'native diagnostic output differs')
                    destination = self.artifact / ('native-diagnostics-' + arm) / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(path, destination)
            actual = inventory(self.arms[arm], True, self.budget)
            require(actual == ({name: pin for name, pin in expected.items() if '/' not in name}
                               if kind == 'native' else expected), 'fresh build outputs differ: ' + arm + '/' + kind)
            if kind == 'portable':
                self.outputs[arm] = expected
        self.authenticate_closures()
        self.hosted_correctness()
        require([row['label'] for row in self.receipts] == PREP_COMMANDS, 'preparation is not exactly 22 commands')
        self.authenticate_closures()
        self.bind()

    def hosted_correctness(self):
        """Six ordinary correctness commands; never run the scientific subject here."""
        self.stage_until('hosted correctness prerequisites', min(self.end - 60, time.monotonic() + 720))
        gate = self.config['hostedCorrectness']
        plan = read(self.packet(gate['commandPlan']))
        require(sha(self.packet(gate['commandPlan'])) == gate['commandPlanSha256'], 'correctness command plan differs')
        expected_files = read(self.packet(plan['expectedFullSuiteFiles']))
        expected_cases = read(self.packet(plan['expectedFullSuiteCases']))
        require(len(expected_files) == 51 and len(expected_cases) == 1088,
                'fixed ordinary correctness identity inventory differs')
        # The unchanged suite has repeated fullName strings; preserve their exact multiplicities.
        require(plan['individualSuiteTestTimeoutMilliseconds'] == 5000 and plan['scientificChildren'] == 0 and
                plan['subjectTimingExecuted'] is False and len(plan['commands']) == 6,
                'correctness scope differs')
        report_root = self.artifact / 'reports'
        report_root.mkdir(exist_ok=True)
        bindings = {'${PROVISION_ROOT}': str(self.root), '${ARTIFACT_ROOT}': str(self.artifact),
                    '${NODE}': str(self.node), '${BUN}': str(self.bun)}
        accepted = []
        for specification, (arm, kind, cap) in zip(plan['commands'], CORRECTNESS_PLAN):
            label = arm + '-' + kind
            report_path = report_root / (label + '.json')
            argv = ([str(self.bun), '--bun', 'node_modules/vitest/vitest.mjs', 'run', '--cache=false',
                     '--reporter=default', '--reporter=json', '--outputFile.json=' + str(report_path)]
                    if kind == 'bun-full-suite' else
                    [str(self.node), 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']
                    if kind == 'typecheck' else
                    [str(self.node), '--test', '--test-concurrency=1', '--test-timeout=20000',
                     'proofs/ordered-map-packed-worker.node.mjs'])
            require(substitute(specification, bindings) == {'label': label, 'arm': arm, 'kind': kind,
                    'argv': argv, 'cwd': str(self.arms[arm]), 'capSeconds': cap,
                    'sampledGroupRssLimitBytes': 2 * GIB}, 'correctness command differs: ' + label)
            self.authenticate_closures()
            receipt, _ = self.command(label, argv, self.arms[arm], cap, {'NO_COLOR': '1'}, rss_limit=2 * GIB)
            if kind == 'bun-full-suite':
                report = read(report_path)
                require(report.get('success') is True, 'ordinary correctness report failed: ' + label)
                for key, expected in [('numTotalTests', 1088), ('numPassedTests', 1088), ('numFailedTests', 0),
                                      ('numPendingTests', 0), ('numTodoTests', 0)]:
                    require(report.get(key) == expected, 'ordinary correctness count differs: ' + label + '/' + key)
                suites = report['testResults']
                assertions = [case for suite in suites for case in suite['assertionResults']]
                require(len(suites) == 51 and len(assertions) == 1088 and
                        all(case.get('status') == 'passed' for case in assertions),
                        'ordinary correctness has skipped/pending/todo/failed cases')
                files = sorted(Path(suite['name']).relative_to(self.arms[arm]).as_posix() for suite in suites)
                cases = sorted([{'file': Path(suite['name']).relative_to(self.arms[arm]).as_posix(),
                                 'fullName': case['fullName']} for suite in suites for case in suite['assertionResults']],
                               key=lambda item: (item['file'], item['fullName']))
                require(files == expected_files and cases == expected_cases, 'ordinary correctness exact identities differ')
                receipt['correctness'] = {'passed': True, 'cases': 1088, 'files': 51,
                                         'report': 'reports/' + report_path.name, 'reportSha256': sha(report_path)}
            elif kind == 'node-worker':
                output = self.output(label)
                names = re.findall(r'^ok \d+ - (.+)$', output, re.M)
                require(names == plan['expectedWorkerCases'] ==
                        ['packed ordered histories in a real worker (copy=false)',
                         'packed ordered histories in a real worker (copy=true)'], 'worker case identities differ')
                for key, expected in [('tests', 2), ('suites', 0), ('pass', 2), ('fail', 0),
                                      ('cancelled', 0), ('skipped', 0), ('todo', 0)]:
                    require(re.findall(r'^# ' + key + r' (\d+)$', output, re.M) == [str(expected)],
                            'worker count differs: ' + key)
                require(receipt['stderr']['bytes'] == 0, 'worker stderr is not empty')
                receipt['correctness'] = {'passed': True, 'cases': 2, 'caseNames': names}
            else:
                require(kind == 'typecheck', 'unrecognized correctness command')
                receipt['correctness'] = {'passed': True, 'noEmit': True}
            self.authenticate_closures()
            accepted.append(label)
            write(self.artifact / 'command-receipts.json', self.receipts)
        require(accepted == [arm + '-' + kind for arm, kind, _ in CORRECTNESS_PLAN] and
                self.result['scientificChildrenStarted'] == 0, 'hosted correctness prerequisite sequence incomplete')
        write(self.artifact / 'hosted-correctness-receipt.json', {
            'schema': 'packed-order-hosted-correctness/v1', 'complete': True, 'passed': True,
            'proofHead': self.head, 'runId': self.result['runId'], 'runAttempt': '1',
            'inputManifestSha256': self.payload_sha, 'sources': self.sources, 'outputs': self.outputs,
            'executables': self.executables, 'hiddenLockSha256': self.hidden_lock_sha,
            'commandPlanSha256': gate['commandPlanSha256'], 'acceptedCommands': accepted,
            'fullSuiteFilesPerArm': 51, 'fullSuiteCasesPerArm': 1088, 'workerCasesPerArm': 2,
            'skippedPendingTodo': 0, 'scientificChildrenStarted': 0, 'subjectTimingExecuted': False})
        self.result['ordinaryCorrectnessClearance'] = True

    def authenticate_closures(self):
        self.authenticate_inputs()
        if self.hidden_lock_sha is not None:
            toolchain = (self.root if self.mode == 'prepare' else self.provision) / 'toolchain'
            validate_dependency_inventory(dependency_inventory(toolchain / 'node_modules', self.budget),
                                          read(self.packet(self.config['toolchain']['dependencyInventory'])), self.hidden_lock_sha)
        for arm, folder in self.arms.items():
            authenticate_portable(folder, read(self.packet(self.config['arms'][arm]['portableAuthentication'])), self.budget)
            require(source_closure(folder, self.budget) == read(self.packet(self.config['arms'][arm]['bunSourceClosure'])),
                    'Bun public source closure differs: ' + arm)
        require((self.arms['baseline'] / 'persistent-core.wasm').read_bytes() ==
                (self.arms['candidate'] / 'persistent-core.wasm').read_bytes(), 'cross-arm native cores differ')

    def bind(self):
        require(self.result.get('ordinaryCorrectnessClearance') is True, 'hosted correctness did not pass')
        bindings = {'${PROVISION_ROOT}': str(self.root), '${BUNDLE_ROOT}': str(HERE),
                    '${NODE}': str(self.node), '${BUN}': str(self.bun), '${PROOF_HEAD}': self.head}
        pins = substitute(read(HERE / 'EXECUTION-TEMPLATE.json'), bindings)
        release = substitute(read(HERE / 'RELEASE-TEMPLATE.json'), bindings)
        require(pins.get('executionReleased') is True and release.get('approved') is True, 'screen execution is not released')
        require(pins.get('expectedHostedHead') == self.head and release.get('expectedHostedHead') == self.head,
                'released proof HEAD differs')
        require(pins.get('subjectChildren') == 36 and release.get('subjectChildren') == 36 and
                pins.get('screenSeconds') == 3430 and release.get('screenSeconds') == 3430,
                'released scientific scope differs')
        for key in ('arms', 'executables', 'implementationFiles', 'evidence'):
            require(pins[key] == release[key], 'release/execution template mismatch: ' + key)
        require(pins['arms'] == {arm: {'root': str(self.arms[arm]),
                    'sources': self.config['arms'][arm]['sources'],
                    'generated': self.config['arms'][arm]['generated']} for arm in ARMS},
                'release arm identities differ from prepared roots')
        require(pins['executables'] == {engine: {'path': self.executables[engine]['path'],
                    **self.config['executables'][engine]} for engine in ENGINES},
                'release executable identity differs from prepared executables')
        require(pins['implementationFiles'] == {name: sha(self.packet(name))
                    for name in ('run-hosted.py', 'subject.mjs', 'analysis.py')}, 'released implementation differs')
        require(pins['evidence'] == {'methodSha256': METHOD_SHA,
                    'focusedSourceSealSha256': FOCUSED_SOURCE_SEAL,
                    'correctnessReviewSha256': self.config['requiredReviews']['correctness']['sha256'],
                    'criticalReviewSha256': self.config['criticalValues']['reviewSha256'],
                    'implementationNoteSha256': self.config['method']['implementationNote']['sha256'],
                    'localFullSuiteSummarySha256': self.config['focusedEvidence']['localFullSuiteSummary']['sha256']},
                'released evidence differs')
        write(self.root / 'EXECUTION-RELEASE.json', release)
        write(self.root / 'EXECUTION-PINS.json', pins)
        write(self.root / 'prepared-state.json', {'schema': 1, 'head': self.head,
              'inputManifestSha256': self.payload_sha, 'sources': self.sources, 'outputs': self.outputs,
              'executables': self.executables, 'hiddenLockSha256': self.hidden_lock_sha,
              'hostedCorrectnessReceiptSha256': sha(self.artifact / 'hosted-correctness-receipt.json'), 'executionPinsSha256': sha(self.root / 'EXECUTION-PINS.json'),
              'executionReleaseSha256': sha(self.root / 'EXECUTION-RELEASE.json')})
        self.result['readyForScreen'] = True

    def screen(self):
        self.begin()
        self.plan = planned_jobs()
        write(self.artifact / 'planned-jobs.json', self.plan)
        previous = read(self.provision / 'artifact/result.json')
        require(previous.get('complete') is True and previous.get('readyForScreen') is True and
                previous.get('cleanupVerified') is True and previous.get('finalIntegrityVerified') is True and
                previous.get('ordinaryCorrectnessClearance') is True,
                'preparation was not authenticated and complete')
        require(previous.get('runId') == self.result['runId'] and previous.get('attempt') == '1', 'preparation run differs')
        manifest_path = self.provision / 'artifact/ARTIFACT-SHA256.json'
        require(sha(manifest_path) == previous['artifactManifestSha256'], 'preparation artifact manifest differs')
        for name, digest in read(manifest_path).items():
            self.budget()
            path = self.provision / 'artifact' / name
            require(path.resolve(strict=True).is_relative_to(self.provision / 'artifact') and
                    not path.is_symlink() and sha(path) == digest, 'preparation artifact changed: ' + name)
        preparation_receipts = read(self.provision / 'artifact/command-receipts.json')
        require([row['label'] for row in preparation_receipts] == PREP_COMMANDS and
                all(row.get('valid') is True and row.get('leaderReapedAfterCleanup') is True and
                    not row.get('descendantsAfterCleanup') for row in preparation_receipts),
                'preparation command/ownership receipt missing')
        state = read(self.provision / 'prepared-state.json')
        require(state == read(self.provision / 'artifact/prepared-state.json'), 'prepared state differs from preserved evidence')
        require(state['head'] == os.environ.get('GITHUB_SHA') and state['inputManifestSha256'] == self.payload_sha,
                'prepared input/HEAD binding differs')
        require(sha(self.provision / 'EXECUTION-PINS.json') == state['executionPinsSha256'] and
                sha(self.provision / 'EXECUTION-RELEASE.json') == state['executionReleaseSha256'], 'prepared release changed')
        bindings = {'${PROVISION_ROOT}': str(self.provision), '${BUNDLE_ROOT}': str(HERE),
                    '${NODE}': state['executables']['node']['path'], '${BUN}': state['executables']['bun']['path'],
                    '${PROOF_HEAD}': state['head']}
        for template, actual in [('EXECUTION-TEMPLATE.json', 'EXECUTION-PINS.json'), ('RELEASE-TEMPLATE.json', 'EXECUTION-RELEASE.json')]:
            require(substitute(read(HERE / template), bindings) == read(self.provision / actual), 'bound release/template differs')
        require(read(self.provision / 'EXECUTION-RELEASE.json').get('approved') is True, 'screen release missing')
        self.sources, self.outputs, self.executables = state['sources'], state['outputs'], state['executables']
        for arm in ARMS:
            require(self.sources[arm] == read(self.packet(self.config['arms'][arm]['sources'])) and
                    self.outputs[arm] == read(self.packet(self.config['arms'][arm]['generated'])), 'prepared arm pin differs')
        for engine in ENGINES:
            require(all(self.executables[engine][key] == value for key, value in self.config['executables'][engine].items()),
                    'prepared executable pin differs')
        self.hidden_lock_sha = state['hiddenLockSha256']
        validate_dependency_inventory(dependency_inventory(self.provision / 'toolchain/node_modules', self.budget),
                                      read(self.packet(self.config['toolchain']['dependencyInventory'])), self.hidden_lock_sha)
        self.authenticate_closures()
        self.authenticate_hosted_correctness(state)
        self.stage_until('scientific children', self.end - 150)
        calibrations = {}
        probe_resolution = {}
        for planned in self.plan:
            self.budget()
            job = dict(planned)
            if job['mode'] != 'probe':
                job['entrypoint'] = str(self.arms[job['arm']] / ('dist/shared.js' if job['engine'] == 'node' else 'shared.ts'))
                job['clockResolutionMs'] = probe_resolution[job['engine']]
            if job['mode'] == 'comparison':
                job['calibration'] = calibrations[job['engine']]
            input_path = self.artifact / 'job-inputs' / (job['jobId'] + '.json')
            write(input_path, job)
            binary = self.executables[job['engine']]['path']
            argv = [binary] + (['--expose-gc'] if job['engine'] == 'node' else []) + [str(HERE / 'subject.mjs'), str(input_path)]
            receipt, records = self.command(job['jobId'], argv, HERE,
                                             sum(cap for _, cap in PHASES[job['mode']]), job=job)
            result = next(row['result'] for row in records if row.get('event') == 'result')
            require(result.get('engine') == job['engine'], 'subject result engine differs')
            if job['mode'] == 'probe':
                require(result.get('accountable') is True, 'runtime accounting probe is unresolved')
                probe_resolution[job['engine']] = result['clock_resolution_ms']
            elif job['mode'] == 'calibration':
                calibration = result['calibration']
                require(set(calibration) == set(calibration_endpoint_set()), 'calibration case set differs')
                for case, endpoints in calibration_endpoint_set().items():
                    require(set(calibration[case]) == endpoints, 'calibration endpoint set differs')
                    for endpoint in endpoints:
                        require(calibration[case][endpoint]['k'] in fixed_ladder(case, endpoint),
                                'calibration K outside fixed ladder')
                calibrations[job['engine']] = calibration
                write(self.artifact / ('calibration-' + job['engine'] + '.json'), calibration)
            else:
                require(result.get('pair') == job['pairIndex'] and result.get('arm') == job['arm'], 'comparison identity differs')
                require(result.get('eligible') is True, 'comparison process reported a non-noise failure')
            write(self.artifact / 'raw-jobs.json', self.jobs)
        self.result['scientificScheduleComplete'] = True

    def authenticate_hosted_correctness(self, state):
        """Require all six source-bound ordinary correctness receipts before any scientific child."""
        gate = self.config['hostedCorrectness']
        path = self.provision / 'artifact/hosted-correctness-receipt.json'
        require(sha(path) == state['hostedCorrectnessReceiptSha256'], 'hosted correctness receipt changed')
        receipt = read(path)
        require(receipt.get('schema') == 'packed-order-hosted-correctness/v1' and
                receipt.get('complete') is True and receipt.get('passed') is True,
                'hosted correctness prerequisite is incomplete')
        require(receipt.get('proofHead') == state['head'] and receipt.get('runId') == self.result['runId'] and
                receipt.get('runAttempt') == '1' and receipt.get('inputManifestSha256') == self.payload_sha,
                'hosted correctness identity binding differs')
        require(receipt.get('sources') == self.sources and receipt.get('outputs') == self.outputs and
                receipt.get('executables') == self.executables and receipt.get('hiddenLockSha256') == self.hidden_lock_sha,
                'hosted correctness source/output/runtime/dependency binding differs')
        require(receipt.get('scientificChildrenStarted') == 0 and receipt.get('subjectTimingExecuted') is False and
                receipt.get('commandPlanSha256') == gate['commandPlanSha256'] and
                receipt.get('acceptedCommands') == [arm + '-' + kind for arm, kind, _ in CORRECTNESS_PLAN] and
                receipt.get('fullSuiteFilesPerArm') == 51 and receipt.get('fullSuiteCasesPerArm') == 1088 and
                receipt.get('workerCasesPerArm') == 2 and receipt.get('skippedPendingTodo') == 0,
                'hosted correctness command/count/no-timing binding differs')
        commands = read(self.provision / 'artifact/command-receipts.json')[-6:]
        require([row['label'] for row in commands] == receipt['acceptedCommands'] and
                all(row.get('valid') is True and row.get('correctness', {}).get('passed') is True for row in commands),
                'hosted correctness command-level pass receipt missing')
        shutil.copyfile(path, self.artifact / 'hosted-correctness-receipt.json')
        self.result['ordinaryCorrectnessClearance'] = True

    def analyze(self):
        self.stage_until('analysis and sealing', min(self.end - 60, time.monotonic() + 90))
        processes = []
        for job in self.jobs:
            if job['input']['mode'] != 'comparison':
                continue
            matches = [row for row in job['records'] if row.get('event') == 'result']
            if len(matches) != 1:
                continue
            process = dict(matches[0]['result'])
            local_eligible = process.get('eligible') is True
            process['eligible'] = local_eligible and job['receipt'].get('valid') is True
            process['invalid_reasons'] = list(process.get('invalid_reasons', []))
            if not job['receipt'].get('valid'):
                process['invalid_reasons'].append(job['receipt'].get('failure') or 'supervisor receipt not valid')
            process['terminal_high_water_rss_bytes'] = job['receipt'].get('wait4MaxRssBytes')
            process['jobId'] = job['input']['jobId']
            processes.append(process)
        data = {'schema': 'packed-ordered-storage-analysis/v1', 'method_sha256': METHOD_SHA,
                'processes': processes, 'first_failure': self.result['firstFailure'],
                'complete': self.result.get('scientificScheduleComplete') is True}
        write(self.artifact / 'analysis-input.json', data)
        write(self.artifact / 'raw-jobs.json', self.jobs)
        # One small standard-library analysis module, inside this supervisor.
        # No additional scientific child and no dependency installation.
        self.packet('analysis.py')
        spec = importlib.util.spec_from_file_location('packed_ordered_storage_analysis', HERE / 'analysis.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        analysis = module.analyze(data)
        self.result['analysis'] = analysis
        if self.result['firstFailure'] is not None:
            invalidate_positive_summary(analysis, self.result['firstFailure'])
        self.persist_analysis()
        self.budget()

    def cleanup(self):
        if self.active is None:
            return
        owned = self.active
        signal_group(owned.pid)
        stop = min(self.end, time.monotonic() + 2)
        while not os.waitid(os.P_PID, owned.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) and time.monotonic() < stop:
            time.sleep(.01)
        descendants = lambda: [row for row in group_memory(owned.pid) if row['pid'] != owned.pid]
        if descendants():
            signal_group(owned.pid)
            while descendants() and time.monotonic() < stop:
                time.sleep(.01)
        remains = descendants()
        terminal = os.waitid(os.P_PID, owned.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        pid, usage = 0, None
        if terminal and not remains:
            self.active = None
            pid, status, usage = os.wait4(owned.pid, os.WNOHANG)
            if pid:
                owned.returncode = os.waitstatus_to_exitcode(status)
        for receipt in self.receipts:
            if receipt.get('ownedProcessGroup') == owned.pid:
                receipt['cleanupSignals'].append('SIGKILL exception cleanup before leader reap')
                receipt.update(valid=False, exitCode=owned.returncode,
                               failure=receipt.get('failure') or 'exception while command active',
                               descendantsAfterCleanup=remains, leaderReapedAfterCleanup=bool(pid))
                if usage is not None:
                    receipt['wait4MaxRssBytes'] = usage.ru_maxrss * 1024
                for suffix in ('stdout', 'stderr', 'rss.jsonl'):
                    path = self.artifact / 'logs' / (receipt['label'] + '.' + suffix)
                    if path.exists():
                        receipt[suffix] = {'sha256': sha(path), 'bytes': path.stat().st_size}
        require(pid and not remains, 'exception cleanup incomplete')

    def preserve(self):
        self.budget()
        for name, digest in self.payload.items():
            self.budget()
            target = self.artifact / ('workflow.yml' if name == WORKFLOW else 'publication/' + name)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / name, target)
            require(sha(target) == digest, 'preserved publication differs')
        write(self.artifact / 'workflow-source.json', {'publicationPath': WORKFLOW, 'artifactPath': 'workflow.yml',
                                                     'sha256': self.payload.get(WORKFLOW)})
        if (HERE / 'INPUT-SHA256.json').exists():
            shutil.copyfile(HERE / 'INPUT-SHA256.json', self.artifact / 'INPUT-SHA256.json')
        if self.mode == 'prepare':
            for arm, folder in self.arms.items():
                if not folder.exists():
                    continue
                sources = inventory(folder, check=self.budget)
                outputs = inventory(folder, True, self.budget)
                write(self.artifact / (arm + '-final-sources.json'), sources)
                write(self.artifact / (arm + '-final-generated.json'), outputs)
                with tarfile.open(self.artifact / (arm + '-sources.tar'), 'w') as archive:
                    for name in sources:
                        self.budget()
                        archive.add(folder / name, arcname=name, recursive=False)
                for name, pin in outputs.items():
                    self.budget()
                    target = self.artifact / 'generated' / arm / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(folder / name, target)
                    require(sha(target) == pin['sha256'], 'preserved generated output differs')
            for name in ('EXECUTION-PINS.json', 'EXECUTION-RELEASE.json', 'prepared-state.json', 'main.tar'):
                if (self.root / name).exists():
                    self.budget()
                    shutil.copyfile(self.root / name, self.artifact / name)
        else:
            for arm, folder in self.arms.items():
                if folder.exists():
                    write(self.artifact / (arm + '-final-sources.json'), inventory(folder, check=self.budget))
                    write(self.artifact / (arm + '-final-generated.json'), inventory(folder, True, self.budget))
            write(self.artifact / 'raw-jobs.json', self.jobs)
        write(self.artifact / 'command-receipts.json', self.receipts)

    def finish(self):
        self.stage_until('final cleanup and preservation', min(self.end, time.monotonic() + 60))
        try:
            self.cleanup()
            self.result['cleanupVerified'] = self.active is None and all(
                row.get('leaderReapedAfterCleanup') and not row.get('descendantsAfterCleanup')
                for row in self.receipts if 'ownedProcessGroup' in row)
            require(self.result['cleanupVerified'], 'original-group cleanup not verified')
            self.authenticate_inputs()
            if len(self.outputs) == 2:
                self.authenticate_closures()
            self.result['finalIntegrityVerified'] = True
        except BaseException as error:
            self.fail(error)
            self.result['finalizationError'] = repr(error)
        try:
            self.persist_analysis()
            self.preserve()
            self.budget()
            manifest = {}
            for path in sorted(self.artifact.rglob('*')):
                self.budget()
                relative = path.relative_to(self.artifact).as_posix()
                if path.is_file() and relative not in ('ARTIFACT-SHA256.json', 'result.json'):
                    manifest[relative] = sha(path)
            write(self.artifact / 'ARTIFACT-SHA256.json', manifest)
            self.result['artifactManifestSha256'] = sha(self.artifact / 'ARTIFACT-SHA256.json')
            self.result['complete'] = self.result['firstFailure'] is None and self.result.get('finalIntegrityVerified') is True
            if self.mode == 'prepare':
                self.result['readyForScreen'] = self.result['complete'] and self.result.get('readyForScreen') is True
            else:
                self.result['complete'] = self.result['complete'] and self.result.get('scientificScheduleComplete') is True
                self.result['eligibleForIndependentReview'] = self.result['complete']
            self.budget()
        except BaseException as error:
            self.fail(error)
            self.result.update(artifactManifestStale=True, preservationError=repr(error), eligibleForIndependentReview=False)
            try:
                self.persist_analysis()
            except BaseException as analysis_error:
                self.result['analysisPersistenceError'] = repr(analysis_error)
        write(self.artifact / 'result.json', self.result)
        self.budget()


def main():
    require(len(sys.argv) in (3, 4) and sys.argv[1] in ('prepare', 'screen'),
            'usage: run-hosted.py prepare NEW-ROOT | screen NEW-OUTPUT PREPARED-ROOT')
    mode = sys.argv[1]
    require(len(sys.argv) == (3 if mode == 'prepare' else 4), 'wrong mode arguments')
    run = Run(mode, Path(sys.argv[2]).resolve(), None if mode == 'prepare' else Path(sys.argv[3]).resolve(strict=True))
    def alarm(_number, _frame):
        if run.active is not None:
            signal_group(run.active.pid)
        if run.stage != 'final cleanup and preservation':
            raise TimeoutError(run.stage + ' wall deadline')
        run.fail('final cleanup/preservation wall deadline')
        run.result.update(artifactManifestStale=True, cleanupVerified=False, eligibleForIndependentReview=False)
        try:
            run.persist_analysis()
            write(run.artifact / 'result.json', run.result)
        finally:
            os._exit(124)
    def interrupted(number, _frame):
        run.interrupted = number
        if run.active is not None:
            signal_group(run.active.pid)
        raise InterruptedError('received signal ' + str(number))
    signal.signal(signal.SIGALRM, alarm)
    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, interrupted)
    signal.setitimer(signal.ITIMER_REAL, max(.001, run.deadline - time.monotonic()))
    try:
        run.prepare() if mode == 'prepare' else run.screen()
    except BaseException as error:
        run.fail(error)
    if mode == 'screen':
        try:
            # Never analyze while a failed scientific process is still active.
            run.cleanup()
            run.analyze()
        except BaseException as error:
            run.fail(error)
            run.result['analysisError'] = repr(error)
    try:
        run.finish()
    except BaseException as error:
        run.fail(error)
        run.result.update(artifactManifestStale=True, eligibleForIndependentReview=False)
        try:
            run.persist_analysis()
        except BaseException as analysis_error:
            run.result['analysisPersistenceError'] = repr(analysis_error)
        write(run.artifact / 'result.json', run.result)
    signal.setitimer(signal.ITIMER_REAL, 0)
    return 0 if run.result['complete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
