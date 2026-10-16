"""A separate 180-second exact-byte transport on the final study host."""
import os
from pathlib import Path
import shutil
import signal
import sys
import time

import bounded_process as bounded
from bounded_process import Supervisor, require, read, sha, write
from files import plain, relative, MAX_BYTES
from gates import binding_at, fresh_paths, closed, seal_raw, digest
from authentication import absolute_path, verified_json
from headroom import effective_memory

WHOLE_SECONDS = 180
FINAL_RESERVE = 30
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
    binding = binding_at(binding_path, expected, 'native-reader-transport-inputs', proof)
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REPOSITORY') == 'natanelia/zerocopy' and
            os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'Single hosted final-study allocation required')
    require(binding.get('finalStudyHostExclusive') is True, 'Independently reserved exclusive final-study host required')
    relative(binding['preparationPrefix'])
    require(all(digest(binding.get(field)) for field in ('preparationReceiptSHA256', 'readyInputArchiveSHA256', 'readyInputInventorySHA256', 'performanceReviewSHA256', 'reviewedTransportMethodSHA256')), 'Complete reviewed transport pins required before retrieval')
    require(type(binding.get('readyInputRegularBytes')) is int and 0 < binding['readyInputRegularBytes'] <= MAX_BYTES, 'Exact already-prepared byte total required')
    review = verified_json(absolute_path(binding['performanceReviewPath']), binding['performanceReviewSHA256'])
    require(review.get('disposition') == 'source-clear-for-exact-bound-execution' and review.get('independent') is True and
            review.get('checks', {}).get('boundedPreparationReviewed') is True and review.get('checks', {}).get('boundedTransportReviewed') is True,
            'Independent exact preparation/recipe review required before retrieval')
    recipe_path = proof / 'transport-method.json'
    require(sha(recipe_path) == binding['reviewedTransportMethodSHA256'], 'Exact prospectively reviewed transport recipe required')
    recipe = read(recipe_path)
    require(recipe['wholeCapSeconds'] == WHOLE_SECONDS and recipe['sampledGroupRssLimitBytes'] == RSS_LIMIT and
            recipe['minimumEffectiveAvailableBytes'] == MIN_AVAILABLE and recipe['downloadAllowanceSeconds'] == 90 and
            recipe['restorationAllowanceSeconds'] == 60, 'Transport caps changed')
    for name, expected in recipe['files'].items(): require(sha(proof / name) == expected, 'Transport helper changed')
    raw = fresh_paths(output, work, 'transport')
    supervisor = Supervisor(raw, [(work, '$TRANSPORT_WORK'), (output, '$TRANSPORT_OUTPUT'), (proof, '$TRANSPORT_PROOF'), (binding_path.parent, '$RELEASE')])
    token = os.environ.pop('GH_TOKEN', None); os.environ.pop('GITHUB_TOKEN', None)
    status = {'schemaVersion': 1, 'status': 'incomplete', 'noRebuild': True, 'noTargetImports': True}
    admissions = []
    def alarm(number, _frame):
        if supervisor.active is not None: supervisor.interrupted = number
        else: raise TimeoutError('Transport whole-run deadline')
    signal.signal(signal.SIGALRM, alarm)
    signal.setitimer(signal.ITIMER_REAL, max(0.001, deadline - time.monotonic() - 2))
    def run(label, argv, wall, download=False):
        require(time.monotonic() + wall + FINAL_RESERVE <= deadline, 'Full transport phase and finalization allowance unavailable')
        accounting = effective_memory()
        require(accounting['cgroups'] and accounting['effectiveAvailableBytes'] >= MIN_AVAILABLE, 'Insufficient cgroup-accounted transport headroom')
        admissions.append({'command': label, 'accounting': accounting}); write(raw / 'headroom.json', admissions)
        try:
            if download:
                require(token, 'Official artifact token required'); bounded.CHILD_ENVIRONMENT['GH_TOKEN'] = token
            return supervisor.run(label, argv, work, deadline - FINAL_RESERVE, wall, RSS_LIMIT)
        finally:
            bounded.CHILD_ENVIRONMENT.pop('GH_TOKEN', None)
    try:
        tools = {'python': str(Path(sys.executable).resolve(strict=True)), 'gh': str(Path(shutil.which('gh')).resolve(strict=True))}
        hashes = {name: sha(path) for name, path in tools.items()}
        write(raw / 'tools.json', hashes); write(raw / 'inputs.json', binding)
        write(raw / 'host-custody.json', {'repository': os.environ['GITHUB_REPOSITORY'], 'runId': os.environ['GITHUB_RUN_ID'], 'attempt': os.environ['GITHUB_RUN_ATTEMPT'], 'commit': os.environ['GITHUB_SHA'], 'exclusiveAllocationExternallyReviewed': True})
        shutil.copyfile(recipe_path, raw / 'transport-method.json')
        # Fresh token-helper scratch; no HOME/TMPDIR or runtime is inherited.
        for name in ('home', 'tmp'): (work / name).mkdir(mode=0o700)
        bounded.CHILD_ENVIRONMENT.clear()
        bounded.CHILD_ENVIRONMENT.update({'PATH': ':'.join(dict.fromkeys([str(Path(path).parent) for path in tools.values()] + ['/usr/bin', '/bin'])),
            'HOME': str(work / 'home'), 'TMPDIR': str(work / 'tmp'), 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'CI': '1', 'NO_COLOR': '1', 'DO_NOT_TRACK': '1', 'PYTHONDONTWRITEBYTECODE': '1'})
        run('download-ready-inputs', [tools['python'], '-B', str(proof / 'download.py'), str(binding_path), str(work / 'download')], 90, True)
        for name in ('run.json', 'artifact.json', 'download.json'): shutil.copyfile(work / 'download' / name, raw / name)
        run('restore-ready-inputs', [tools['python'], '-B', str(proof / 'restore.py'), str(binding_path), str(work), str(raw)], 60)
        require(closed(supervisor), 'Transport owned groups did not close')
        require(plain(proof) == binding['proofFiles'], 'Transport source changed')
        for name, path in tools.items(): require(sha(path) == hashes[name], 'Transport tool changed')
        status.update(status='complete', ownedGroupsEmpty=True, extractionVerified=True)
    except BaseException as error:
        status.update(errorType=type(error).__name__, error=supervisor.display(str(error)))
        raise
    finally:
        try:
            if time.monotonic() >= deadline or supervisor.interrupted: status['status'] = 'incomplete'
            status.update(elapsedSecondsBeforeFinalSeal=time.monotonic() - started, wholeCapSeconds=WHOLE_SECONDS, ownedGroupStillActive=supervisor.active is not None)
            write(raw / 'status.json', status)
            write(raw / 'cleanup.json', {'ownedGroupStillActive': supervisor.active is not None, 'commands': supervisor.receipts,
                'scratchPolicy': 'Isolated helper home/tmp removed during restoration; authenticated staged inputs remain for final-host custody. No target/package scratch is created.'})
            raw_sha = seal_raw(raw)
            require(status['status'] == 'complete', 'Transport incomplete')
            receipt = {name: binding[name] for name in ('preparationReceiptSHA256', 'readyInputArchiveSHA256', 'readyInputInventorySHA256', 'reviewedTransportMethodSHA256')}
            receipt.update(schemaVersion=1, kind='native-reader-performance-transport', status='complete', bounded=True,
                rawEvidenceSealSHA256=raw_sha, elapsedSeconds=time.monotonic() - started, wholeCapSeconds=WHOLE_SECONDS,
                ownedGroupsEmpty=True, noRebuild=True, noTargetImports=True, extractionVerified=True)
            write(output / 'transport-receipt.json', receipt)
            receipt_sha = sha(output / 'transport-receipt.json')
            require(time.monotonic() < deadline and not supervisor.interrupted, 'Transport finalization exceeded whole bound')
            print('Transport terminal success; receipt SHA256 ' + receipt_sha + '; whole elapsed seconds ' + str(time.monotonic() - started))
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)


if __name__ == '__main__':
    main()
