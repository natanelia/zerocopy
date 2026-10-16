"""One 600-second hosted restoration. Never build/import/test target code."""
import os
from pathlib import Path
import shutil
import signal
import sys
import time

import bounded_process as bounded
from bounded_process import Supervisor, require, read, sha, write
from files import plain, MAX_BYTES, relative, validate_inventory
from gates import binding_at, hosted_context, fresh_paths, closed, seal_raw, digest
from headroom import effective_memory
from specification import BASELINE_COMMIT, RUNTIMES
from authentication import absolute_path, verified_json
from runtime import URLS

WHOLE_SECONDS = 600
FINAL_RESERVE = 20
RSS_LIMIT = 4 * 2**30
MIN_AVAILABLE = 6 * 2**30


def main():
    started = time.monotonic(); deadline = started + WHOLE_SECONDS
    def initial_alarm(_number, _frame):
        raise TimeoutError('Whole operation deadline during admission')
    signal.signal(signal.SIGALRM, initial_alarm)
    signal.setitimer(signal.ITIMER_REAL, WHOLE_SECONDS - 2)
    require(len(sys.argv) == 5, 'Expected binding, binding SHA256, output and work')
    binding_path, expected = Path(sys.argv[1]).resolve(strict=True), sys.argv[2]
    output, work = Path(sys.argv[3]).absolute(), Path(sys.argv[4]).absolute()
    proof = Path(__file__).resolve().parent
    binding = binding_at(binding_path, expected, 'native-reader-preparation-inputs', proof)
    require(binding.get('baselineCommit') == BASELINE_COMMIT and digest(binding.get('evidenceSealSHA256')) and
            digest(binding.get('correctnessAuditSHA256')) and digest(binding.get('correctnessTerminalReceiptSHA256')), 'Future successful correctness audit binding required')
    require(type(binding.get('sizing')) is dict and all(type(binding['sizing'].get(field)) is int and 0 < binding['sizing'][field] <= MAX_BYTES for field in ('readyRegularBytesCeiling', 'runtimeProvisionedRegularBytesCeiling')), 'Reviewed finite aggregate ceilings required before preparation')
    require(sha(proof / 'METHOD.md') == binding['reviewedPreparationMethodSHA256'], 'Preparation method mismatch')
    relative(binding['evidencePrefix'])
    audit = verified_json(absolute_path(binding['correctnessAuditPath']), binding['correctnessAuditSHA256'])
    terminal = verified_json(absolute_path(binding['correctnessTerminalReceiptPath']), binding['correctnessTerminalReceiptSHA256'])
    require(audit.get('disposition') == 'successful-terminal-correctness' and audit.get('independent') is True and
            terminal.get('exitCode') == 0 and terminal.get('finished') is True and terminal.get('conclusion') == 'success', 'Successful externally pinned audit/terminal documents required before retrieval')
    require(digest(binding.get('npmEntrySHA256')), 'Exact audited npm entry digest required')
    for name in ('node', 'bun'):
        archive = binding['runtimeArchives'][name]
        require(archive.get('url') == URLS[name] and digest(archive.get('sha256')), 'Externally reviewed official runtime archive pins required')
    selected = binding['runtimeArchives']['node']['selectedFiles']
    validate_inventory({name: {'sha256': value} for name, value in selected.items()})
    require(selected.get('bin/node') == RUNTIMES['node']['sha256'] and
            selected.get('lib/node_modules/npm/bin/npm-cli.js') == binding['npmEntrySHA256'], 'Node/npm selection pins mismatch')
    hosted_context('proof/native-reader-reuse-preparation-20261016')
    raw = fresh_paths(output, work, 'preparation')
    supervisor = Supervisor(raw, [(work, '$PREPARATION_WORK'), (output, '$PREPARATION_OUTPUT'), (proof, '$PREPARATION_PROOF'), (binding_path.parent, '$RELEASE')])
    admissions = []
    status = {'schemaVersion': 1, 'status': 'incomplete', 'noRebuild': True, 'noTargetImports': True}
    token = os.environ.pop('GH_TOKEN', None)
    os.environ.pop('GITHUB_TOKEN', None)
    def alarm(number, _frame):
        if supervisor.active is not None: supervisor.interrupted = number
        else: raise TimeoutError('Preparation whole-run deadline')
    signal.signal(signal.SIGALRM, alarm)
    signal.setitimer(signal.ITIMER_REAL, max(0.001, deadline - time.monotonic() - 2))
    def run(label, argv, cwd, wall, download=False):
        require(time.monotonic() + wall + FINAL_RESERVE <= deadline, 'Full phase and finalization allowance unavailable')
        accounting = effective_memory()
        require(accounting['cgroups'] and accounting['effectiveAvailableBytes'] >= MIN_AVAILABLE, 'Insufficient cgroup-accounted preparation headroom')
        admissions.append({'command': label, 'accounting': accounting}); write(raw / 'headroom.json', admissions)
        try:
            if download:
                require(token, 'Official Actions artifact token required'); bounded.CHILD_ENVIRONMENT['GH_TOKEN'] = token
            return supervisor.run(label, argv, cwd, deadline - FINAL_RESERVE, wall, RSS_LIMIT)
        finally:
            bounded.CHILD_ENVIRONMENT.pop('GH_TOKEN', None)
    try:
        tools = {name: str(Path(shutil.which(name)).resolve(strict=True)) for name in ('git', 'gh')}
        tools['python'] = str(Path(sys.executable).resolve(strict=True))
        tool_hashes = {name: sha(path) for name, path in tools.items()}
        write(raw / 'tools.json', tool_hashes); write(raw / 'inputs.json', binding)
        for name in ('home', 'npm-cache', 'tmp'): (work / name).mkdir(mode=0o700)
        bounded.CHILD_ENVIRONMENT.update({'PATH': ':'.join(dict.fromkeys([str(Path(path).parent) for path in tools.values()] + ['/usr/bin', '/bin'])),
            'HOME': str(work / 'home'), 'TMPDIR': str(work / 'tmp'), 'PYTHONDONTWRITEBYTECODE': '1',
            'npm_config_cache': str(work / 'npm-cache'), 'npm_config_registry': 'https://registry.npmjs.org',
            'npm_config_ignore_scripts': 'true', 'npm_config_audit': 'false', 'npm_config_fund': 'false'})
        python = tools['python']
        run('download-correctness', [python, '-B', str(proof / 'download.py'), str(binding_path), str(work / 'download')], work, 90, True)
        for name in ('run.json', 'artifact.json', 'download.json'): shutil.copyfile(work / 'download' / name, raw / name)
        run('provision-fixed-runtimes', [python, '-B', str(proof / 'runtime.py'), str(binding_path), str(work), str(raw)], work, 30)
        node = str(work / 'provisioned/node/bin/node')
        npm = str(work / 'provisioned/node/lib/node_modules/npm/bin/npm-cli.js')
        bounded.CHILD_ENVIRONMENT['PATH'] = str(Path(node).parent) + ':' + bounded.CHILD_ENVIRONMENT['PATH']
        repository = work / 'repository'
        run('source-init', [tools['git'], 'init', str(repository)], work, 10)
        run('source-fetch', [tools['git'], '-c', 'credential.helper=', 'fetch', '--no-tags', '--depth=1', 'https://github.com/natanelia/zerocopy.git', BASELINE_COMMIT, binding['sourceCommit']], repository, 90)
        for arm, commit in [('baseline', BASELINE_COMMIT), ('candidate', binding['sourceCommit'])]:
            run(arm + '-source-archive', [tools['git'], 'archive', '--format=tar', '--output=' + str(work / (arm + '.tar')), commit], repository, 30)
        run('restore-original-inputs', [python, '-B', str(proof / 'assemble.py'), 'restore', str(binding_path), str(work), str(raw)], work, 60)
        run('restore-locked-dependencies', [node, npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], work / 'ready/dependencies', 180)
        run('verify-and-archive', [python, '-B', str(proof / 'assemble.py'), 'finish', str(binding_path), str(work), str(raw)], work, 60)
        require(closed(supervisor), 'Preparation owned groups did not close')
        require(plain(proof) == binding['proofFiles'], 'Preparation source changed')
        for name, path in tools.items(): require(sha(path) == tool_hashes[name], 'Preparation tool changed')
        status.update(status='complete', ownedGroupsEmpty=True)
    except BaseException as error:
        status.update(errorType=type(error).__name__, error=supervisor.display(str(error)))
        raise
    finally:
        try:
            elapsed = time.monotonic() - started
            if elapsed >= WHOLE_SECONDS or supervisor.interrupted: status['status'] = 'incomplete'
            status.update(elapsedSecondsBeforeFinalSeal=elapsed, wholeCapSeconds=WHOLE_SECONDS, ownedGroupStillActive=supervisor.active is not None)
            write(raw / 'status.json', status)
            write(raw / 'cleanup.json', {'ownedGroupStillActive': supervisor.active is not None, 'commands': supervisor.receipts})
            raw_sha = seal_raw(raw)
            require(status['status'] == 'complete', 'Preparation incomplete')
            archive = read(raw / 'archive.json')
            write(output / 'preparation-receipt.json', {'schemaVersion': 1, 'status': 'complete', 'bounded': True,
                'correctnessAuditSHA256': binding['correctnessAuditSHA256'], 'builds': read(raw / 'restoration.json')['originalBuilds'],
                'noRebuild': True, 'noTargetImports': True, 'elapsedSeconds': time.monotonic() - started, 'wholeCapSeconds': WHOLE_SECONDS,
                'ownedGroupsEmpty': True, 'reviewedPreparationMethodSHA256': binding['reviewedPreparationMethodSHA256'],
                'rawEvidenceSealSHA256': raw_sha, 'readyInputArchiveSHA256': archive['sha256'],
                'readyInputInventorySHA256': archive['inventorySHA256'], 'readyInputRegularBytes': archive['regularBytes']})
            receipt_sha = sha(output / 'preparation-receipt.json')
            require(time.monotonic() < deadline and not supervisor.interrupted, 'Preparation finalization exceeded whole bound')
            print('Preparation terminal success; receipt SHA256 ' + receipt_sha + '; whole elapsed seconds ' + str(time.monotonic() - started))
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)


if __name__ == '__main__':
    main()
