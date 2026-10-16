"""One hosted correctness admission. No benchmark, calibration, or retry."""
import os
from pathlib import Path
import shutil
import signal
import sys
import time

import bounded_process as bounded
from bounded_process import Supervisor, require, sha, read, write
from headroom import effective_memory
from workflow_guard import check as check_workflow
from artifact_checks import built_artifacts

BASE = 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e'
PREFIX = 'proofs/native-reader-correctness/'
WHOLE_SECONDS = 1620
RSS_LIMIT = 4 * 1024 ** 3
MIN_AVAILABLE = 6 * 1024 ** 3
SOURCE_DELTA = {'arena.ts', 'worker.ts', 'worker.test.ts', 'native-reader.test.ts'}
FOCUSED = ['worker.test.ts', 'worker-attachment.test.ts', 'worker-records.test.ts',
           'descriptor-validation.test.ts', 'checkpoint-descriptor-validation.test.ts',
           'block-traversal-view.test.ts']


def validate_focused_report(report, expected):
    require(report['success'] and report['numFailedTests'] == 0 and report['numTotalTests'] > 0, 'Focused Node semantic tests did not pass')
    require({Path(suite['name']).name for suite in report['testResults']} == expected, 'Focused Node suite coverage mismatch')

def inventory(root, excluded=()):
    result = {}
    for directory, folders, files in os.walk(root, followlinks=False):
        folders[:] = sorted(name for name in folders if name not in excluded)
        for name in sorted(files + [name for name in folders if (Path(directory) / name).is_symlink()]):
            path = Path(directory) / name
            relative = str(path.relative_to(root))
            result[relative] = {'link': os.readlink(path)} if path.is_symlink() else {'sha256': sha(path)}
    return result


def main():
    require(len(sys.argv) == 5, 'Expected candidate, baseline, evidence and work directories')
    candidate, baseline, output, work = [Path(value).resolve() for value in sys.argv[1:]]
    require(os.environ.get('GITHUB_ACTIONS') == 'true', 'Hosted Actions execution only')
    require(os.environ.get('GITHUB_REPOSITORY') == 'natanelia/zerocopy', 'Unexpected repository')
    require(os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'No reruns')
    require(os.environ.get('GITHUB_EVENT_NAME') == 'push', 'Exact branch-push execution only')
    require(read(os.environ['GITHUB_EVENT_PATH']).get('before') == BASE, 'Push must advance the baseline exactly once')
    require(os.environ.get('GITHUB_REF') == 'refs/heads/proof/native-reader-reuse-correctness-complete-20261016', 'Unexpected ref')
    require(candidate == Path(os.environ['GITHUB_WORKSPACE']).resolve(), 'Unexpected candidate directory')
    temporary = Path(os.environ['RUNNER_TEMP']).resolve()
    for path, name in [(baseline, 'baseline'), (output, 'evidence'), (work, 'work')]:
        require(path == temporary / ('native-reader-correctness-' + name), 'Unexpected runtime directory')
        require(not path.exists(), 'Fresh runtime directories required')
    output.mkdir()
    proof = candidate / PREFIX
    executables = {name: str(Path(shutil.which(name)).resolve()) for name in ['node', 'bun', 'npm']}
    executables['python'] = str(Path(sys.executable).resolve())
    supervisor = Supervisor(output, [(candidate, '$CANDIDATE'), (baseline, '$BASELINE'),
                                    (output, '$EVIDENCE'), (work, '$WORK'), (temporary, '$RUNNER_TEMP')])
    status = {'status': 'incomplete', 'correctnessOnly': True, 'performanceClaim': False,
              'targetCommandsAttempted': 0, 'requiresSuccessfulControllerExit': True}
    write(output / 'status.json', status)
    started = time.monotonic()
    deadline = started + WHOLE_SECONDS
    admissions = []

    def alarm(number, _frame):
        if supervisor.active is not None:
            supervisor.interrupted = number
        else:
            raise TimeoutError('Whole-run deadline with cleanup reserve')

    signal.signal(signal.SIGALRM, alarm)
    signal.setitimer(signal.ITIMER_REAL, WHOLE_SECONDS - 2)

    def run(label, argv, cwd, wall):
        accounting = effective_memory()
        require(bool(accounting['cgroups']), 'Usable cgroup memory accounting required')
        require(accounting['effectiveAvailableBytes'] >= MIN_AVAILABLE, 'Insufficient effective memory headroom')
        admissions.append({'command': label, 'effectiveAvailableBytes': accounting['effectiveAvailableBytes'],
                           'effectiveLimitBytes': accounting['effectiveLimitBytes'],
                           'hostAvailableBytes': accounting['host']['MemAvailable'],
                           'effectiveCpuBudget': accounting['cpu']['effectiveCpuBudget']})
        write(output / 'headroom.json', admissions)
        receipt = supervisor.run(label, argv, cwd, deadline, wall, RSS_LIMIT)
        return receipt

    def metadata(label, argv, cwd=candidate):
        run(label, argv, cwd, 10)
        return (output / (label + '.stdout')).read_text().strip()

    try:
        require(not os.environ.get('NODE_OPTIONS') and not os.environ.get('BUN_OPTIONS'), 'Unexpected runtime tuning')
        check_workflow(candidate / '.github/workflows/native-reader-correctness.yml')
        work.mkdir()
        for name in ['home', 'tmp', 'npm-cache']:
            (work / name).mkdir()
        bounded.CHILD_ENVIRONMENT.update({
            'PATH': ':'.join(dict.fromkeys([str(Path(executables[name]).parent) for name in ['node', 'bun', 'npm']] + ['/usr/bin', '/bin'])),
            'HOME': str(work / 'home'), 'TMPDIR': str(work / 'tmp'),
            'npm_config_cache': str(work / 'npm-cache'), 'npm_config_registry': 'https://registry.npmjs.org',
        })
        commit = metadata('candidate-commit', ['git', 'rev-parse', 'HEAD'])
        require(commit == os.environ['GITHUB_SHA'], 'Candidate commit differs from the selected Actions commit')
        require(metadata('candidate-parent', ['git', 'rev-parse', 'HEAD^']) == BASE, 'Candidate must be one exact delta on the baseline')
        require(metadata('candidate-clean', ['git', 'status', '--porcelain', '--untracked-files=all']) == '', 'Candidate checkout must be clean')
        base_pins, overlay = read(proof / 'baseline-sources.json'), read(proof / 'source-pins.json')
        require(len(base_pins) == 502, 'Unexpected baseline inventory')
        changed = set(metadata('candidate-delta', ['git', 'diff', '--name-only', BASE, 'HEAD']).splitlines())
        require(changed == set(overlay) | {PREFIX + 'source-pins.json'}, 'Unexpected candidate delta')
        require({name for name in overlay if not name.startswith(PREFIX) and not name.startswith('.github/workflows/')} == SOURCE_DELTA, 'Unexpected production or test delta')
        require({name for name in overlay if name.startswith('.github/workflows/')} == {'.github/workflows/native-reader-correctness.yml'}, 'Unexpected workflow delta')
        source_pins = {'baseline': base_pins, 'candidate': {**base_pins, **overlay, PREFIX + 'source-pins.json': sha(proof / 'source-pins.json')}}
        for name, digest in source_pins['candidate'].items():
            require(sha(candidate / name) == digest, 'Candidate source mismatch: ' + name)
        tracked = set(metadata('candidate-tracked', ['git', 'ls-files']).splitlines())
        require(tracked == set(source_pins['candidate']), 'Unexpected tracked sources')
        runtime = {}
        for name in ['node', 'bun', 'npm']:
            runtime[name] = {'command': name, 'version': metadata(name + '-version', [executables[name], '--version']), 'sha256': sha(executables[name])}
        runtime['python'] = {'command': 'python3', 'version': sys.version, 'sha256': sha(executables['python'])}
        require(runtime['node']['version'] == 'v22.16.0' and runtime['bun']['version'] == '1.4.2', 'Unexpected runtime versions')
        dependencies = proof / 'dependencies'
        package, lock = read(dependencies / 'package.json'), read(dependencies / 'package-lock.json')
        required = read(candidate / 'package.json')['devDependencies']
        require(package['dependencies'] == {**required, 'bun': '1.4.2'}, 'Dependency versions differ from source')
        require(lock['packages']['']['dependencies'] == package['dependencies'], 'Dependency manifest/lock mismatch')
        require(all(not record.get('resolved') or record['resolved'].startswith('https://registry.npmjs.org/') for record in lock['packages'].values()), 'Non-official dependency source')
        write(output / 'inputs.json', {'baselineCommit': BASE, 'candidateCommit': commit, 'sourceFiles': source_pins,
                                      'executables': runtime, 'lockSha256': sha(dependencies / 'package-lock.json'),
                                      'limits': {'wholeSeconds': WHOLE_SECONDS, 'sampledGroupRssBytes': RSS_LIMIT,
                                                 'minimumEffectiveAvailableBytes': MIN_AVAILABLE, 'sampleIntervalSeconds': .05,
                                                 'cleanupReserveSeconds': 2, 'hardCgroupCap': False}})
        run('baseline-checkout', ['git', 'worktree', 'add', '--detach', str(baseline), BASE], candidate, 30)
        for name, digest in base_pins.items():
            require(sha(baseline / name) == digest, 'Baseline source mismatch: ' + name)
        run('dependencies-install', [executables['npm'], 'ci', '--no-audit', '--no-fund'], dependencies, 180)
        dependency_root = dependencies / 'node_modules'
        dependency_pins = inventory(dependency_root, excluded=('.vite', '.vite-temp', '.cache'))
        write(output / 'dependencies.json', dependency_pins)
        for root in [baseline, candidate]:
            require(not (root / 'node_modules').exists() and not (root / 'dist').exists(), 'Fresh build directories required')
            require(not list(root.glob('*.wasm')) and not list(root.glob('*.wat')), 'Fresh native outputs required')
            (root / 'node_modules').symlink_to(dependency_root, target_is_directory=True)
        bun, node, npm = (executables[name] for name in ['bun', 'node', 'npm'])
        commands = []
        for arm, root in [('baseline', baseline), ('candidate', candidate)]:
            for script, wall in [('build:wasm', 120), ('build:browser', 60), ('build:types', 60),
                                 ('typecheck', 60), ('typecheck:redux', 60), ('typecheck:values', 60), ('typecheck:geometry', 60)]:
                commands.append((arm + '-' + script.replace(':', '-'), [bun, 'run', script], root, wall))
            commands.append((arm + '-worker-types', [node, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.worker.json'], root, 60))
        for arm, root in [('baseline', baseline), ('candidate', candidate)]:
            commands.append((arm + '-full-bun', [bun, 'run', 'test'], root, 600))
            selected = FOCUSED + (['native-reader.test.ts'] if arm == 'candidate' else [])
            commands.append((arm + '-focused-node', [node, 'node_modules/vitest/vitest.mjs', 'run', *selected,
                             '--reporter=json', '--outputFile=' + str(output / (arm + '-focused-node.json'))], root, 120))
            for proof_name in ['worker-sessions', 'node-worker', 'typed-json-worker']:
                commands.append((arm + '-' + proof_name, [node, 'proofs/' + proof_name + '.mjs'], root, 60))
        commands.extend([
            ('candidate-redux-proof', [node, 'proofs/redux-node.mjs'], candidate, 60),
            ('candidate-docs-unit', [node, '--test', 'scripts/check-docs.node.mjs'], candidate, 30),
            ('candidate-docs-guard', [node, 'scripts/check-docs.mjs', '--base', BASE, '--preserve'], candidate, 60),
            ('candidate-doc-examples', [node, 'scripts/check-doc-examples.mjs'], candidate, 60),
            ('candidate-package-dry-run', [npm, 'pack', '--dry-run', '--ignore-scripts', '--json'], candidate, 60),
            ('candidate-package-consumer', [node, 'scripts/check-package.mjs'], candidate, 180),
        ])
        write(output / 'command-plan.json', [{'label': label, 'argv': [supervisor.display(value) for value in argv],
                                             'cwd': supervisor.display(root), 'wallSeconds': wall} for label, argv, root, wall in commands])
        artifacts, bindings = {}, {}
        for label, argv, root, wall in commands:
            status['targetCommandsAttempted'] += 1
            write(output / 'status.json', status)
            run(label, argv, root, wall)
            if label.endswith('-build-types'):
                arm = label.split('-', 1)[0]
                artifacts[arm], bindings[arm] = built_artifacts(root)
                saved = output / 'builds' / arm
                saved.mkdir(parents=True)
                for relative in artifacts[arm]:
                    destination = saved / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(root / relative, destination)
                write(output / 'outputs.json', {'builds': artifacts, 'portableNativeBindings': bindings})
                if len(artifacts) == 2:
                    require({name: digest for name, digest in artifacts['baseline'].items() if name.endswith(('.wasm', '.wat'))} ==
                            {name: digest for name, digest in artifacts['candidate'].items() if name.endswith(('.wasm', '.wat'))}, 'Native artifacts changed despite no native source delta')
            if label.endswith('-focused-node'):
                report = read(output / (label + '.json'))
                expected = set(FOCUSED + (['native-reader.test.ts'] if label.startswith('candidate-') else []))
                validate_focused_report(report, expected)
        package_output = output / 'package'
        package_output.mkdir()
        run('candidate-package-archive', [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', str(package_output)], candidate, 60)
        for arm, root in [('baseline', baseline), ('candidate', candidate)]:
            for relative, digest in {**source_pins[arm], **artifacts[arm]}.items():
                require(sha(root / relative) == digest, 'Source or output changed after validation: ' + relative)
        for name, path in executables.items():
            require(sha(path) == runtime[name]['sha256'], 'Runtime changed: ' + name)
        require(inventory(dependency_root, excluded=('.vite', '.vite-temp', '.cache')) == dependency_pins, 'Dependencies changed outside allowed build caches')
        require(not list((work / 'tmp').iterdir()), 'Package consumer temporary files remain')
        require(supervisor.active is None and all(row['leaderReaped'] and not row['descendantsAfterCleanup'] for row in supervisor.receipts), 'Owned-process cleanup incomplete')
        write(output / 'outputs.json', {'builds': artifacts, 'portableNativeBindings': bindings, 'packageFiles': inventory(package_output)})
        status.update(status='complete', baselineCommit=BASE, candidateCommit=commit)
    except BaseException as error:
        status.update(status='incomplete', error=supervisor.display(str(error)), errorType=type(error).__name__)
        raise
    finally:
        try:
            status['elapsedSecondsForSafety'] = time.monotonic() - started
            status['ownedGroupStillActive'] = supervisor.active is not None
            if time.monotonic() >= deadline or supervisor.interrupted:
                status['status'] = 'incomplete'
            write(output / 'status.json', status)
            write(output / 'cleanup.json', {'ownedGroupStillActive': supervisor.active is not None,
                                           'commands': [{'label': row['label'], 'leaderReaped': row['leaderReaped'],
                                                         'descendantsAfterCleanup': row['descendantsAfterCleanup'],
                                                         'cleanupSignals': row['cleanupSignals']} for row in supervisor.receipts]})
            write(output / 'evidence-sha256.json', inventory(output, excluded=()))
            require(status['status'] == 'complete' and time.monotonic() < deadline and not supervisor.interrupted, 'Correctness admission incomplete')
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)


if __name__ == '__main__':
    main()
