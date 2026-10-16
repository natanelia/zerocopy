"""Static guard for this workflow's context placement; launches nothing."""
from pathlib import Path
import re
import sys


def check(path):
    source = Path(path).read_text()
    # Runner context is not available in job-level env. Runtime shell variables
    # also avoid carrying this particular mistake into a future workflow edit.
    assert not re.search(r'\$\{\{\s*runner\.', source), 'Use runtime RUNNER_TEMP, not runner context expressions'
    assert not re.search(r'^    env\s*:', source, re.M), 'Job-level env is prohibited in this workflow'
    assert 'node-version: \'22.16.0\'' in source
    assert 'bun-version: \'1.4.2\'' in source
    assert 'timeout-minutes: 35' in source
    assert 'persist-credentials: false' in source
    assert "github.event.before == 'afdffdcfcbd61013f120de82411c0c4a6b2d1e0e'" in source
    assert 'branches: [proof/native-reader-reuse-correctness-final-20261016]' in source
    assert 'ref: ${{ github.sha }}' in source
    assert not re.search(r'^  (workflow_dispatch|pull_request|schedule|workflow_run)\s*:', source, re.M)
    assert source.count('python3 -B proofs/native-reader-correctness/run.py') == 1
    return {'workflowSha256GuardedSeparately': True, 'runnerContextExpressions': 0, 'jobLevelEnvironmentBlocks': 0}


if __name__ == '__main__':
    check(sys.argv[1])
    print('Workflow context guard passed.')
