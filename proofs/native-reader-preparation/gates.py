"""Small shared admission and receipt checks; no subject execution."""
import os
from pathlib import Path
import re

from bounded_process import read, require, sha, write
from files import inventory, plain, relative, validate_inventory
from specification import BASELINE_COMMIT, METHOD_SHA256, SUPERVISION_PINS
from authentication import read_json


def digest(value):
    return type(value) is str and re.fullmatch('[0-9a-f]{64}', value) is not None


def binding_at(path, expected, kind, proof):
    require(digest(expected) and path.is_file() and not path.is_symlink() and sha(path) == expected, 'Exact externally reviewed binding digest required')
    binding = read_json(path)
    require(binding.get('schemaVersion') == 1 and binding.get('kind') == kind and binding.get('sealed') is True, 'Unresolved source-only binding')
    require(binding.get('methodSHA256') == METHOD_SHA256 and binding.get('singleAttempt') is True and
            type(binding.get('authorizationReference')) is str and binding['authorizationReference'], 'Released single-attempt authorization reference required')
    require(binding.get('proofFiles') == plain(proof), 'Exact complete adapter source inventory required')
    for name, expected in SUPERVISION_PINS.items(): require(sha(proof / name) == expected, 'Supervision changed')
    require(binding.get('repository') == 'natanelia/zerocopy' and type(binding.get('runId')) is int and binding['runId'] > 0 and
            type(binding.get('artifactId')) is int and binding['artifactId'] > 0 and re.fullmatch('[0-9a-f]{40}', binding.get('sourceCommit', '')), 'Exact successful official artifact identity required')
    require(binding['runId'] != 38863704317, 'Known incomplete correctness run cannot supply preparation')
    require(type(binding.get('artifactName')) is str and binding['artifactName'] and digest(binding.get('artifactZipSHA256')), 'Artifact pin absent')
    validate_inventory({name: {'sha256': value} for name, value in binding['artifactFiles'].items()})
    return binding


def hosted_context(branch):
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REPOSITORY') == 'natanelia/zerocopy' and
            os.environ.get('GITHUB_RUN_ATTEMPT') == '1' and os.environ.get('GITHUB_EVENT_NAME') == 'push', 'Single hosted push only')
    require(os.environ.get('GITHUB_REF') == 'refs/heads/' + branch and read(os.environ['GITHUB_EVENT_PATH'])['before'] == BASELINE_COMMIT,
            'Exact one-time baseline branch advance required')


def fresh_paths(output, work, phase):
    runner = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    require(output == runner / ('native-reader-' + phase + '-output') and work == runner / ('native-reader-' + phase + '-work'), 'Unexpected isolated setup paths')
    require(not output.exists() and not work.exists(), 'Fresh isolated directories required')
    output.mkdir(mode=0o700); work.mkdir(mode=0o700)
    raw = output / 'raw'; raw.mkdir(mode=0o700)
    return raw


def closed(supervisor):
    return supervisor.active is None and not supervisor.interrupted and bool(supervisor.receipts) and all(
        row.get('exitCode') == 0 and not row.get('failure') and row.get('leaderReaped') is True and row.get('descendantsAfterCleanup') == []
        for row in supervisor.receipts)


def seal_raw(raw):
    require(not (raw / 'raw-evidence-seal.json').exists(), 'Evidence seal must be written once')
    files = inventory(raw)
    write(raw / 'raw-evidence-seal.json', files)
    actual = inventory(raw); actual.pop('raw-evidence-seal.json')
    require(actual == read(raw / 'raw-evidence-seal.json'), 'Raw evidence seal verification failed')
    return sha(raw / 'raw-evidence-seal.json')
