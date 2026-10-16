"""One fixed 38-child codec screen, consuming separately built/sealed artifacts.

run.py PROOF_DIR ADMISSION_DIR OUTPUT_DIR --node NODE --bun BUN
The output directory must be new. No building, installing, retrying or additional
validation process is performed here. Raw prefixes survive incomplete children.
"""
import argparse
import json
import math
import os
from pathlib import Path
import platform
import shutil
import signal
import sys
import time

from analyze import analyze, ROWS, PROCESS_ORDERS
from prepare import (Supervisor, sha, read, write, require, authenticate_sources,
                     effective_headroom, RUNTIME_PINS, MIN_AVAILABLE, RSS_LIMIT)

WHOLE_SECONDS = 600
FINAL_RESERVE = 30
ENGINES = ('node', 'bun')


def authenticate(proof, admission_dir, admission, tools, artifact_seal):
    require(sha(proof / 'source-pins.json') == admission['sourceManifestSha256'], 'source manifest changed')
    require(authenticate_sources(proof, read(proof / 'source-pins.json')) == admission['sources'], 'source inventory differs')
    for engine, path in tools.items():
        require(sha(path) == RUNTIME_PINS[engine]['sha256'] == admission['tools'][engine]['sha256'], 'runtime pin differs')
    for name, digest in artifact_seal.items():
        path = Path(name)
        require(not path.is_absolute() and '..' not in path.parts, 'artifact seal path')
        require(sha(admission_dir / path) == digest, 'artifact seal differs')
    for arm in ('baseline', 'candidate'):
        bundle = admission['bundles'][arm]
        require(bundle['path'] == arm + '.mjs', 'bundle name differs')
        require(sha(admission_dir / bundle['path']) == bundle['sha256'], 'bundle differs')


def environment():
    cpu = None
    try:
        for line in Path('/proc/cpuinfo').read_text().splitlines():
            if line.startswith('model name'):
                cpu = line.split(':', 1)[1].strip()
                break
    except OSError:
        pass
    # Explicit allowlist only; no environment dump, hostnames or filesystem data.
    return {
        'hosted': {key: os.environ.get(key) for key in
                   ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB', 'GITHUB_SHA')},
        'os': platform.system(), 'release': platform.release(),
        'architecture': platform.machine(), 'cpuModel': cpu,
        'logicalCPUs': os.cpu_count(), 'effectiveMemory': effective_headroom(),
    }


def parse_child(path, spec, spec_hash, corpus):
    """Authenticate a strict event prefix; only complete rows become observations."""
    events, issues, observations, counts = [], [], [], {}
    if path.exists():
        for line in path.read_text().splitlines():
            try:
                event = json.loads(line, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                require(isinstance(event, dict), 'event is not an object')
                events.append(event)
            except (ValueError, TypeError):
                issues.append('malformed-or-truncated-json-record')
                break
    cursor = 0

    def take(kind):
        nonlocal cursor
        require(cursor < len(events), 'missing-' + kind)
        value = events[cursor]
        cursor += 1
        require(value.get('event') == kind and value.get('id') == spec['id'], 'unexpected-' + kind)
        return value

    try:
        ready = take('ready')
        require(ready.get('specSha256') == spec_hash, 'specification binding')
        for key in ('engine', 'bundleSha256', 'driverSha256', 'methodSha256', 'sourceManifestSha256'):
            require(ready.get(key) == spec[key], 'ready binding ' + key)
        require(ready.get('runtimeVersion') == ('22.16.0' if spec['engine'] == 'node' else '1.4.2'), 'runtime version')
        metadata = ready.get('rows')
        require(isinstance(metadata, list) and [item.get('row') for item in metadata] == list(ROWS), 'corpus row order')
        require(isinstance(ready.get('sharedInputDecode'), bool), 'shared-input capability')
        require(sum(item['preparedBytes'] for item in metadata) < 1048576, 'prepared-byte cap')
        for item in metadata:
            require(0 <= item['bytes'] < 65536 and item['preparedBytes'] == item['bytes'] + 32 and 0 <= item['nodes'] < 2048, 'fixture guard')
        if corpus is None:
            corpus = metadata
        require(metadata == corpus, 'corpus hash/shape differs between children')

        def batch(row, trial, phase, index, count, meta):
            record = take('batch')
            for key, wanted in {'row': row, 'trial': trial, 'phase': phase, 'index': index, 'count': count}.items():
                require(record.get(key) == wanted, 'batch schedule differs')
            duration = record.get('elapsedNs')
            require(isinstance(duration, (float, int)) and not isinstance(duration, bool)
                    and math.isfinite(duration) and duration > 0, 'invalid duration')
            require(record.get('validated') is True and record.get('inputSha256') == meta['inputSha256']
                    and record.get('nodes') == meta['nodes'] and record.get('checksum') == meta['expectedScalar'] * count,
                    'batch value/input/checksum validation')
            return {'elapsedNs': duration, 'count': count}

        for meta in metadata:
            row = meta['row']
            cap = 2 ** (24 if row.startswith('C-') else 20)
            measured = []
            if spec['mode'] == 'calibration':
                count = 256
                for trial in range(1, 5):
                    for index in range(1, 6):
                        batch(row, trial, 'warmup', index, count, meta)
                    pilots = [batch(row, trial, 'pilot', index, count, meta)['elapsedNs'] for index in range(1, 4)]
                    median = sorted(pilots)[1]
                    calibrated = 20000000 <= median <= 50000000
                    result = take('trial')
                    require(all(result.get(key) == value for key, value in
                                {'row': row, 'trial': trial, 'count': count, 'medianNs': median, 'calibrated': calibrated}.items()), 'calibration trial differs')
                    if calibrated or trial == 4:
                        break
                    count = max(1, min(cap, math.floor(count * 30000000 / median + 0.5)))
            else:
                frozen = spec['counts'][row]
                count, calibrated = frozen['count'], frozen['calibrated']
                for index in range(1, 6):
                    batch(row, 1, 'warmup', index, count, meta)
                measured = [batch(row, 1, 'measurement', index, count, meta) for index in range(1, 10)]
            complete = take('row-complete')
            require(complete.get('row') == row and complete.get('count') == count
                    and complete.get('calibrated') is calibrated, 'row completion differs')
            if spec['mode'] == 'calibration':
                require(complete.get('trials') == trial, 'calibration trials differ')
                counts[row] = {'count': count, 'calibrated': calibrated}
            else:
                observations.append({key: spec[key] for key in ('engine', 'block', 'arm', 'order')} |
                                    {'row': row, 'calibrated': calibrated, 'sourceValid': True,
                                     'valueValid': True, 'measurements': measured})
        complete = take('complete')
        require(complete.get('status') == 'passed' and complete.get('rows') == list(ROWS)
                and cursor == len(events), 'terminal record differs')
    except (ValueError, TypeError, KeyError, OverflowError) as error:
        issues.append(str(error) if isinstance(error, ValueError) else type(error).__name__)
    return {'complete': not issues, 'issues': issues, 'observations': observations,
            'counts': counts, 'corpus': corpus, 'events': len(events)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('proof_dir', 'admission_dir', 'output_dir'):
        parser.add_argument(name, type=Path)
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--bun', default=shutil.which('bun'))
    args = parser.parse_args()
    proof, admission_dir, output = (getattr(args, name).resolve() for name in ('proof_dir', 'admission_dir', 'output_dir'))
    require(admission_dir.is_relative_to(proof), 'sealed artifact directory must be within public proof root')
    require(args.node and args.bun, 'pinned runtimes required')
    tools = {engine: Path(getattr(args, engine)).resolve(strict=True) for engine in ENGINES}
    output.mkdir(parents=True, exist_ok=False)
    (output / 'STARTED').write_text('One study attempt. No retry or replacement children.\n')
    started, started_unix = time.monotonic(), time.time()
    deadline = started + WHOLE_SECONDS
    supervisor = Supervisor(output, [(proof, '$PROOF'), (admission_dir, '$ADMISSION'), (output, '$EVIDENCE'),
                                      *[(path, '$' + engine.upper()) for engine, path in tools.items()]])
    records, failures, phases, corpus, calibrations = [], [], {}, None, {}
    admission_complete = run_complete = False
    manifest = {'schemaVersion': 1, 'status': 'incomplete', 'startedUnix': started_unix,
                'limits': {'experimentalChildren': 38, 'wholeSeconds': 600,
                           'calibrationChildSeconds': 60, 'measurementChildSeconds': 30,
                           'analysisCleanupReserveSeconds': 30, 'childCleanupReserveSeconds': 2,
                           'rssBytes': RSS_LIMIT, 'rssSampleSeconds': 0.05}}

    def alarm(number, frame):
        if supervisor.active is not None:
            supervisor.on_signal(number, frame)
        else:
            raise TimeoutError('whole study deadline')

    def check_budget():
        require(not supervisor.interrupted and time.monotonic() < deadline - 2, 'whole deadline or interruption')

    signal.signal(signal.SIGALRM, alarm)
    signal.setitimer(signal.ITIMER_REAL, WHOLE_SECONDS - 2)
    try:
        require(sys.platform == 'linux' and platform.machine() == 'x86_64', 'Linux x86_64 runtime pins')
        admission = read(admission_dir / 'admission.json')
        artifact_seal = read(admission_dir / 'ARTIFACT-SEAL.json')
        require(isinstance(artifact_seal, dict) and {'admission.json', 'commands.json', 'baseline.mjs', 'candidate.mjs'}.issubset(artifact_seal), 'missing separately reviewed artifact seal')
        require(admission['status'] == 'passed' and admission['commandsStarted'] == 6, 'separate preparation admission incomplete')
        for engine in ENGINES:
            for arm in ('baseline', 'candidate'):
                require(admission['regressions'][engine][arm]['result']['status'] == 'passed', 'compiled regressions incomplete')
        authenticate(proof, admission_dir, admission, tools, artifact_seal)
        manifest['provenance'] = environment()
        require(manifest['provenance']['effectiveMemory']['effectiveAvailableBytes'] >= MIN_AVAILABLE, 'less than 2 GiB effective available')
        manifest.update(admissionSha256=sha(admission_dir / 'admission.json'), artifactSealSha256=sha(admission_dir / 'ARTIFACT-SEAL.json'),
                        sourceManifestSha256=admission['sourceManifestSha256'], methodSha256=admission['methodSha256'],
                        driverSha256=admission['driverSha256'], tools=admission['tools'], bundles=admission['bundles'])
        phases['studyAuthenticationSeconds'] = time.monotonic() - started
        write(output / 'study.json', manifest)

        def child(engine, mode, arm, block, order):
            nonlocal corpus
            check_budget()
            authenticate(proof, admission_dir, admission, tools, artifact_seal)
            label = f'calibration-{engine}' if mode == 'calibration' else f'block-{block}-{engine}-{arm.lower()}'
            bundle = admission['bundles']['candidate' if arm == 'C' else 'baseline']
            spec = {'schema': 1, 'id': label, 'engine': engine, 'mode': mode, 'arm': arm, 'block': block, 'order': order,
                    'bundle': (admission_dir / bundle['path']).relative_to(proof).as_posix(), 'bundleSha256': bundle['sha256'],
                    **{key: admission[key] for key in ('driverSha256', 'methodSha256', 'sourceManifestSha256')}}
            if mode == 'measurement':
                spec['counts'] = calibrations[engine]
            spec_path = output / (label + '.spec.json')
            write(spec_path, spec)
            launch_failed = False
            try:
                supervisor.run(label, [tools[engine], proof / 'subject.mjs', spec_path], proof,
                               deadline - FINAL_RESERVE, 60 if mode == 'calibration' else 30)
            except BaseException:
                launch_failed = True
            source_valid = True
            try:
                authenticate(proof, admission_dir, admission, tools, artifact_seal)
            except BaseException:
                source_valid = False
            parsed = parse_child(output / (label + '.stdout'), spec, sha(spec_path), corpus)
            if corpus is None and parsed['corpus'] is not None:
                corpus = parsed['corpus']
                write(output / 'corpus.json', corpus)
            for observation in parsed['observations']:
                observation['sourceValid'] = source_valid
            records.extend(parsed['observations'])
            write(output / 'observations.json', records)
            write(output / (label + '.validation.json'), parsed)
            require(source_valid and not launch_failed and parsed['complete'], 'child incomplete: ' + label)
            return parsed['counts']

        calibration_start = time.monotonic()
        for engine in ENGINES:
            calibrations[engine] = child(engine, 'calibration', 'B', 0, 0)
        phases['calibrationSeconds'] = time.monotonic() - calibration_start
        write(output / 'calibration.json', calibrations)
        require(all(calibrations[engine][row]['calibrated'] for engine in ENGINES for row in ROWS[:2]), 'primary calibration failed')
        admission_complete = True
        measurement_start = time.monotonic()
        order = 0
        for block in range(1, 7):
            for engine in (ENGINES if block % 2 else ENGINES[::-1]):
                for arm in PROCESS_ORDERS[block - 1]:
                    order += 1
                    child(engine, 'measurement', arm, block, order)
        phases['measurementSeconds'] = time.monotonic() - measurement_start
        require(len(supervisor.receipts) == 38 and len(records) == 360, 'experimental count incomplete')
        authenticate(proof, admission_dir, admission, tools, artifact_seal)
        check_budget()
        run_complete = True
    except BaseException as error:
        failures.append(str(error) if isinstance(error, (ValueError, TimeoutError)) else type(error).__name__)
    finally:
        analysis_start = time.monotonic()
        if supervisor.active is not None:
            failures.append('owned leader not reaped within child cleanup cap')
        if supervisor.interrupted:
            failures.append('interrupted')
        if time.monotonic() >= deadline - 2:
            failures.append('whole study cap')
        # Keep the final bound active while serializing the finite report.
        def final_alarm(_number, _frame):
            raise TimeoutError('whole study final-report deadline')
        signal.signal(signal.SIGALRM, final_alarm)
        signal.setitimer(signal.ITIMER_REAL, max(0.001, deadline - time.monotonic()))
        report = analyze(records, admission_complete=admission_complete,
                         run_complete=run_complete and not failures, incomplete_reasons=failures)
        write(output / 'analysis.json', report)
        phases['analysisSeconds'] = time.monotonic() - analysis_start
        manifest.update(status='complete' if report['complete'] else 'incomplete', decision=report['decision'],
                        experimentalChildrenStarted=len(supervisor.receipts), completeObservations=len(records),
                        failures=failures, phases=phases, endedUnix=time.time(),
                        elapsedSecondsForSafety=time.monotonic() - started)
        write(output / 'study.json', manifest)
        files = {path.name: sha(path) for path in sorted(output.iterdir()) if path.is_file()}
        write(output / 'RESULT-SEAL.json', files)
        print(json.dumps({'status': manifest['status'], 'decision': report['decision'],
                          'experimentalChildrenStarted': len(supervisor.receipts)}), flush=True)
        signal.setitimer(signal.ITIMER_REAL, 0)
    return 0 if manifest['status'] == 'complete' else 1


if __name__ == '__main__':
    try:
        result = main()
    except BaseException as error:
        # A terminal report failure still leaves prior raw logs/receipts. Avoid
        # traceback paths or a success claim if the final deadline expires.
        print(json.dumps({'status': 'incomplete', 'failureType': type(error).__name__}), flush=True)
        result = 1
    raise SystemExit(result)
