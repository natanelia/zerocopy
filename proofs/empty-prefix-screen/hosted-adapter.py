"""Held adapter for an already provisioned, separately authenticated hosted run.

No downloads, installs, builds, subject imports or automatic dispatch. A separately
reviewed preparation wrapper must supply roots and final execution pins first.
"""
import json
import os
from pathlib import Path
import re
import sys


def main():
    pins = Path(os.environ['PREFIX_EXECUTION_PINS']).resolve(strict=True)
    output = Path(os.environ['PREFIX_SCREEN_OUTPUT']).resolve()
    data = json.loads(pins.read_text())
    if data.get('executionReleased') is not True:
        raise SystemExit('Screen execution is held; no subject launched.')
    head = data.get('expectedHostedHead')
    if not isinstance(head, str) or not re.fullmatch('[0-9a-f]{40}', head):
        raise SystemExit('A separately reviewed exact hosted head is required.')
    if os.environ.get('GITHUB_SHA') != head or os.environ.get('GITHUB_RUN_ATTEMPT') != '1':
        raise SystemExit('Only the released hosted head, attempt 1, may execute.')
    if os.environ.get('GITHUB_REPOSITORY') != 'natanelia/zerocopy':
        raise SystemExit('Unexpected repository.')
    if output.exists():
        raise SystemExit('Output already exists; retries/replacement cohorts are forbidden.')
    os.execv(sys.executable, [sys.executable, str(Path(__file__).with_name('supervisor.py')), str(pins), str(output)])


if __name__ == '__main__':
    main()
