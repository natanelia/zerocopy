"""Fixed 66-child screen. Importing this module launches nothing."""
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import time
from analysis import analyze
from runner import Runner, invalidate_terminal, read, sha, write

HERE = Path(__file__).resolve().parent
CASES = ('P1', 'S1', 'C1', 'C2', 'C3', 'C4')
BASE = 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e'
METHOD = 'f32eadded0fd6618754184f42339054c7efb8bdbef0709e512524043cc28df4d'
EXPECTED = {'P1': (2304, 8), 'S1': (36, 16), 'C1': (150994944, 8),
            'C2': (150994944, 8), 'C3': (192, 2), 'C4': (640, 4)}


def packet():
    manifest = read(HERE / 'INPUT-SHA256.json')
    for relative, digest in manifest.items():
        path = HERE / relative
        assert path.resolve().is_relative_to(HERE) and not path.is_symlink()
        assert sha(path) == digest, relative
    assert sha(HERE / 'METHOD.md') == METHOD
    release = read(HERE / 'RELEASE.json')
    assert release['approved'] is True and release['baseCommit'] == BASE and release['methodSha256'] == METHOD
    assert re.fullmatch('[0-9a-f]{64}', release['corpusSha256'] or '')
    return sha(HERE / 'INPUT-SHA256.json'), release


def inventory(root, exclude=()):
    out = {}
    for folder, directories, files in os.walk(root, followlinks=False):
        directories[:] = [name for name in directories if name not in exclude]
        for name in files:
            path = Path(folder) / name
            assert not path.is_symlink(), str(path)
            out[str(path.relative_to(root))] = sha(path)
    return out


def dependency_inventory(root):
    """Observe regular files, symlink targets and unsupported types without following links."""
    observed = {'files': {}, 'symlinks': {}, 'other': {}}
    if not stat.S_ISDIR(root.lstat().st_mode):
        observed['other']['.'] = stat.S_IFMT(root.lstat().st_mode)
        return observed
    def failed(error):
        raise error
    for folder, directories, files in os.walk(root, followlinks=False, onerror=failed):
        for name in directories[:] + files:
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


def authenticate_dependencies(provision, observed=None):
    toolchain = Path(provision['toolchain'])
    for name in ('package.json', 'package-lock.json'):
        path = toolchain / name
        assert stat.S_ISREG(path.lstat().st_mode), name
        assert sha(path) == sha(HERE / 'toolchain' / name)
    if observed is None:
        observed = dependency_inventory(toolchain / 'node_modules')
    validate_dependency_inventory(observed, read(HERE / 'manifests/dependencies.json'),
                                  provision['hiddenLockSha256'])


def authenticate(provision, dependencies=False):
    for arm in ('baseline', 'candidate'):
        root = Path(provision['arms'][arm])
        sources = read(HERE / f'manifests/{arm}-sources.json')
        native = read(HERE / 'manifests/native.json')
        expected = {**sources, **{key: value['sha256'] for key, value in native.items()}}
        assert inventory(root, ('node_modules', 'dist')) == expected, arm
        generated = read(HERE / f'manifests/{arm}-portable.json')
        assert inventory(root / 'dist') == {key: value['sha256'] for key, value in generated.items()}
        assert (root / 'node_modules').resolve() == (Path(provision['toolchain']) / 'node_modules').resolve()
    for pin in provision['engines'].values():
        assert sha(pin['path']) == pin['sha256']
    metadata = Path(provision['toolchain']) / 'node_modules/.package-lock.json'
    assert stat.S_ISREG(metadata.lstat().st_mode), 'hidden lock must remain a regular file'
    assert sha(metadata) == provision['hiddenLockSha256'], 'hidden lock changed within this run'
    if dependencies:
        authenticate_dependencies(provision)


def environment(provision, temporary):
    return {'PATH': str(Path(provision['engines']['node']['path']).parent) + ':'
            + str(Path(provision['engines']['bun']['path']).parent) + ':'
            + str(Path(provision['toolchain']) / 'node_modules/.bin') + ':/usr/local/bin:/usr/bin:/bin',
            'TMPDIR': str(temporary), 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'TZ': 'UTC',
            'CI': '1', 'npm_config_offline': 'true', 'npm_config_audit': 'false', 'npm_config_fund': 'false'}


def schedule():
    jobs = [{'mode': 'calibration', 'engine': engine, 'arm': 'baseline', 'round': None,
             'caseOrder': list(CASES)} for engine in ('node', 'bun')]
    for round_number in range(16):
        order = ('node', 'bun') if round_number % 2 == 0 else ('bun', 'node')
        arms = ('baseline', 'candidate') if round_number % 2 == 0 else ('candidate', 'baseline')
        offset = round_number % 6
        for engine in order:
            for arm in arms:
                jobs.append({'mode': 'comparison', 'engine': engine, 'arm': arm, 'round': round_number,
                             'caseOrder': list(CASES[offset:] + CASES[:offset])})
    assert len(jobs) == 66
    return jobs


def validate_output(job, rows):
    """Bind every raw batch, fixed rung and summary before admitting a record."""
    assert rows and rows[-1]['event'] == 'result'
    assert sum(row.get('event') == 'result' for row in rows) == 1
    result = rows[-1]['result']
    for name in ('engine', 'arm', 'round', 'corpusSha256'):
        assert result[name] == job[name], name
    position = 0
    summaries = result['calibration' if job['mode'] == 'calibration' else 'workloads']
    assert set(summaries) == set(CASES)
    for case in job['caseOrder']:
        prewarm = rows[position]; position += 1
        assert prewarm['event'] == 'prewarm' and prewarm['case'] == case
        assert math.isfinite(prewarm['milliseconds']) and prewarm['milliseconds'] >= 500
        assert type(prewarm['calls']) is int and prewarm['calls'] > 0
        assert prewarm['checksum'] == EXPECTED[case][0] * prewarm['calls']
        summary = summaries[case]
        trials = summary['trials'] if job['mode'] == 'calibration' else [summary]
        assert 1 <= len(trials) <= 21
        for level, trial in enumerate(trials):
            K = trial['K']
            if job['mode'] == 'calibration':
                assert K == 2 ** level
                median = sorted(trial['measuredMs'])[1]
                assert (median >= 50) == (level == len(trials) - 1)
            else:
                assert K == job['counts'][case] and trial['operationsPerRepetition'] == EXPECTED[case][1]
            assert trial['expectedChecksum'] == EXPECTED[case][0] * K
            assert len(trial['warmupMs']) == 8
            assert len(trial['measuredMs']) == len(trial['checksums']) == (3 if job['mode'] == 'calibration' else 4)
            for phase, values in [('warmup', trial['warmupMs']),
                                  ('calibration' if job['mode'] == 'calibration' else 'measured', trial['measuredMs'])]:
                for index, milliseconds in enumerate(values):
                    row = rows[position]; position += 1
                    assert row == {'event': 'batch', 'case': case, 'K': K, 'phase': phase, 'index': index,
                                   'milliseconds': milliseconds, 'checksum': EXPECTED[case][0] * K}
                    assert math.isfinite(milliseconds) and milliseconds > 0
            assert all(value == EXPECTED[case][0] * K for value in trial['checksums'])
        if job['mode'] == 'calibration':
            assert summary['K'] == trials[-1]['K']
    assert position == len(rows) - 1
    return result


def main(provision_file, output):
    packet_hash, release = packet()
    provision = read(provision_file)
    assert provision['ready'] and provision['baseCommit'] == BASE and provision['packetSha256'] == packet_hash
    runner = Runner(output, 900)
    (runner.root / 'jobs').mkdir(); (runner.root / 'tmp').mkdir()
    planned, counts, records = schedule(), {}, []
    result = {'status': 'running', 'methodSha256': METHOD, 'packetSha256': packet_hash,
              'plannedChildren': 66, 'completedChildren': 0, 'fullSuiteClearance': False, 'publicationRelease': False}
    write(runner.root / 'schedule.json', planned)
    write(runner.root / 'host.json', {'uname': list(os.uname()), 'cpu': Path('/proc/cpuinfo').read_text(),
                                    'affinity': sorted(os.sched_getaffinity(0))})
    try:
        authenticate(provision, True); runner.budget()
        for index, spec in enumerate(planned):
            assert packet()[0] == packet_hash
            authenticate(provision); runner.budget()
            arm = Path(provision['arms'][spec['arm']])
            entry = arm / ('dist/shared.js' if spec['engine'] == 'node' else 'shared.ts')
            job = {**spec, 'entry': entry.as_uri(), 'corpusSha256': release['corpusSha256'],
                   'counts': counts.get(spec['engine'])}
            label = f"{index + 1:02d}-{spec['mode']}-{spec['engine']}-{spec['arm']}-r{spec['round']}"
            jobfile = runner.root / 'jobs' / (label + '.json'); write(jobfile, job)
            argv = [provision['engines'][spec['engine']]['path'], str(HERE / 'subject.mjs'), '--job', str(jobfile)]
            path = runner.run(label, argv, arm, environment(provision, runner.root / 'tmp'),
                              30 if spec['mode'] == 'calibration' else 15)
            assert runner.receipts[-1]['stderr']['bytes'] == 0
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            record = validate_output(job, rows)
            if spec['mode'] == 'calibration':
                counts[spec['engine']] = {case: record['calibration'][case]['K'] for case in CASES}
                write(runner.root / 'frozen-counts.json', counts)
            else:
                records.append(record)
                write(runner.root / 'comparison-records.json', records)
            authenticate(provision); runner.budget()
            result['completedChildren'] += 1
            write(runner.root / 'result.json', result)
            print(json.dumps({'child': label, 'status': 'passed'}), flush=True)
        authenticate(provision, True)
        assert packet()[0] == packet_hash
        runner.budget()
        assert result['completedChildren'] == 66 and len(records) == 64
        result['status'] = 'completed'
    except BaseException as error:
        result.update(status='stopped', error=repr(error))
        raise
    finally:
        analysis = analyze(records)
        analysis['terminalComplete'] = result['status'] == 'completed'
        if not analysis['terminalComplete']:
            analysis['promisingPrimary'] = analysis['regressionClear'] = False
        files = {str(path.relative_to(runner.root)): sha(path) for path in runner.root.rglob('*')
                 if path.is_file() and path.name not in ('OUTPUT-SHA256.json', 'analysis.json', 'result.json')}
        result['budgetSecondsForSafetyOnly'] = time.monotonic() - runner.start
        invalidate_terminal(result, runner.interrupted, result['budgetSecondsForSafetyOnly'], analysis=analysis)
        write(runner.root / 'analysis.json', analysis)
        write(runner.root / 'result.json', result)
        files.update({name: sha(runner.root / name) for name in ('analysis.json', 'result.json')})
        write(runner.root / 'OUTPUT-SHA256.json', files)
    assert result['status'] == 'completed'


if __name__ == '__main__':
    assert len(sys.argv) == 3, 'supervisor.py PROVISION.json FRESH_OUTPUT'
    main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
