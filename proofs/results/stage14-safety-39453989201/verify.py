#!/usr/bin/env python3
"""Verify retained hosted logs without extraction, code execution, or measurements."""
from pathlib import Path
import hashlib
import io
import json
import tarfile

ARCHIVE_SHA256 = '54f0ca0fb29b0676bda411ef099ba531a121cb888b38270c97d871d144a81962'
COMMIT = '43463d517cc0127ceafb1171b47478c6dc0d2d45'
EXPECTED = {
    'arm64-node': (12279920589, '88bbd3b4471093f49e8bfad40daa08adf21ff732bfcb131240fc46233b65c70a'),
    'x64-node': (12279418750, '73fb6cf88e4cc56eab6a544e844334792c9217cbc44fa2ff98c60bcf7722071f'),
    'x64-bun': (12278979409, 'c038cb9e5438398b59ba52de37f230c4cfa360c3dc0991e6f13f22bbe5aee7aa'),
    'arm64-bun': (12278864593, '91a0fcefcfd860f61ab9f0a63e1c0c9df1583d8be1341f20107a8c950fa73f1c'),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def verify(path):
    data = path.read_bytes()
    require(len(data) == 6496 and sha(data) == ARCHIVE_SHA256, 'wrong log archive')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as archive:
        members = archive.getmembers()
        require(len(members) == 41 and all(m.isfile() for m in members), 'wrong archive members')
        require(sum(m.size for m in members) < 1024 * 1024, 'log archive exceeds bound')
        files = {m.name: archive.extractfile(m).read() for m in members}
        require(len(files) == 41, 'duplicate archive names')
    report = json.loads(files['VERIFIED.json'])
    require(report['sourceCommit'] == COMMIT and report['run'] == 39453989201, 'wrong run')
    require(set(report['jobs']) == set(EXPECTED), 'missing runtime or architecture')
    seen = {'VERIFIED.json'}
    for name, (artifact, digest) in EXPECTED.items():
        job = report['jobs'][name]
        require((job['artifactId'], job['artifactZipSha256']) == (artifact, digest), 'wrong artifact identity')
        require(len(job['fileSha256']) == job['artifactFiles'] == 10, 'wrong file coverage')
        for member, expected in job['fileSha256'].items():
            key = name + '/' + member
            require(key in files and sha(files[key]) == expected, 'changed log: ' + key)
            seen.add(key)
        content = lambda member: files[name + '/' + member]
        require(content('commit.txt').decode().strip() == COMMIT, 'wrong tested source')
        runtime = json.loads(content('runtime.json'))
        require(runtime == job['runtime'] and runtime['arch'] == name.split('-')[0], 'wrong runtime metadata')
        if name.endswith('bun'):
            require(runtime['versions'].get('bun') == '1.4.2', 'wrong Bun version')
        else:
            require(runtime['version'] == 'v22.16.0' and not runtime['versions'].get('bun'), 'wrong Node version')
        log = content('boundaries.log').decode()
        rows = [json.loads(line.split('STAGE14-BOUNDARIES ', 1)[1]) for line in log.splitlines() if 'STAGE14-BOUNDARIES ' in line]
        require(len(rows) == 1 and rows[0] == job['boundarySummary'], 'wrong boundary summary')
        require(rows[0]['oracleChecks'] == 46112 and rows[0]['fixtures'] == 1272, 'incomplete safety coverage')
        require(rows[0]['publicOverlay'] is True and rows[0]['maxArenaBytes'] == 8650752, 'wrong fixture limits')
        markers = ('5 pass', '0 fail') if name.endswith('bun') else ('# pass 5', '# fail 0', '# skipped 0')
        require(all(marker in log for marker in markers), 'safety tests did not pass')
        restore_log = content('restore-tests.log').decode()
        require('Ran 10 tests' in restore_log and '\nOK\n' in restore_log and job['restoreTests'] == 10, 'restore tests did not pass')
        build = json.loads(content('build-report.json'))
        require(build == report['build'] and len(build['compiled']) == 6, 'build identities differ')
        replay = json.loads(content('verification/replay-identities.json'))
        require(replay == job['replayIdentities'], 'wrong replay identities')
        require(all(r['originalPreserved'] is True and r['byteIdentical'] is True for r in replay.values()), 'original reports changed')
    require(seen == set(files), 'unverified archive entries')
    print('PASS: four runtime/architecture jobs, 40 original log files, exact source and build identities.')
    print('No measurements executed. All historical performance failures remain failures.')


if __name__ == '__main__':
    verify(Path(__file__).resolve().parent / 'validation.tar.xz')
