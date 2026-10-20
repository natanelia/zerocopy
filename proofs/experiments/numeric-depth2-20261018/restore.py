#!/usr/bin/env python3
"""Restore sealed Stage 13/14 evidence and replay it. Never run measurements."""
from pathlib import Path, PurePosixPath
import hashlib
import io
import json
import math
import shutil
import struct
import tempfile
import subprocess
import sys
import tarfile

ARCHIVE_SHA256 = '5ef478ea767ca458ab81f3473bbe22775cb9ad035bf5ac04f3810f4428f90e56'
PART_BLOBS = '''0629e8fac64bd64e69432482ba86163bdaf7a60a
683b18a8e432a6e0303845a2f42b63c752df38bd
672466fc13e8fc6234f1ed3ada7b56dff5c1e72a
113b626ec989585fd34776cdf412421969d5d672
55e79cb02405b6ab2a1a13c635274ff9b00fe05a
2bbcc46e5e7304fa50718fb5a3e8801454ce012a
134e955ecec408f970631e9df62a74694f454e12
0831d9b4c9dc1358482254463036742c1e9ada91
34a5f7b6f2fd90488ad22334e535051f64209534
0d15b2e40a9eb864266422515c3541e4d8647134
39fc724e1549522aa583a40b187af94553902704'''.splitlines()

def require(ok, message):
    if not ok:
        raise ValueError(message)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def same_replay(expected, actual, field=''):
    """Only derived exp/log summaries allow four ULPs; gate flags stay exact."""
    require(type(actual) is type(expected), 'replay type changed')
    if isinstance(expected, dict):
        require(expected.keys() == actual.keys(), 'replay keys changed')
        for key in expected:
            same_replay(expected[key], actual[key], key)
    elif isinstance(expected, list):
        require(len(expected) == len(actual), 'replay length changed')
        for a, b in zip(expected, actual):
            same_replay(a, b, field)
    elif field in ('speedup', 'lower', 'upper'):
        require(type(expected) is float and all(math.isfinite(x) and x > 0 for x in (expected, actual)), 'invalid estimate')
        bits = lambda value: struct.unpack('>Q', struct.pack('>d', value))[0]
        require(abs(bits(expected) - bits(actual)) <= 4, 'derived estimate changed')
    else:
        require(expected == actual, f'replay field changed: {field}')

def unpack(data, destination):
    """Extract regular files only, within a new directory and a fixed byte bound."""
    require(not destination.exists(), 'output already exists')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as archive:
        members = archive.getmembers()
        require(len(members) <= 1000, 'too many archive members')
        require(sum(m.size for m in members) <= 16 * 1024 * 1024, 'archive too large')
        seen = set()
        for member in members:
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and '..' not in path.parts and path.parts, 'unsafe path')
            require(str(path) not in seen, 'duplicate path')
            seen.add(str(path))
            require(member.isfile() or member.isdir(), 'links and special files are not allowed')
        destination.mkdir(parents=True)
        for member in members:
            target = destination / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as out:
                    out.write(archive.extractfile(member).read())

def restore(parts, destination):
    """Bind all chunks and every retained file to the immutable evidence seal."""
    names = [f'{i:02}' for i in range(1, 12)]
    require(sorted(p.name for p in parts.iterdir()) == names, 'missing or extra part')
    chunks = []
    for i, (name, expected) in enumerate(zip(names, PART_BLOBS)):
        chunk = (parts / name).read_bytes()
        require(len(chunk) == (2572 if i == 10 else 6000), 'wrong part length')
        blob = hashlib.sha1(f'blob {len(chunk)}\0'.encode() + chunk).hexdigest()
        require(blob == expected, 'part identity mismatch')
        chunks.append(chunk)
    data = b''.join(chunks)
    require(len(data) == 62572 and digest(data) == ARCHIVE_SHA256, 'archive identity mismatch')
    unpack(data, destination)
    manifest = json.loads((destination / 'EVIDENCE-MANIFEST.json').read_text())
    require(set(p.name for p in destination.iterdir()) == set(manifest) | {'EVIDENCE-MANIFEST.json'}, 'manifest coverage mismatch')
    for name, identity in manifest.items():
        content = (destination / name).read_bytes()
        require(len(content) == identity['bytes'] and digest(content) == identity['sha256'], f'changed retained file: {name}')
    for stage in (13, 14):
        staging = destination / f'expanded-{stage}'
        unpack((destination / f'raw-stage{stage}.tar.xz').read_bytes(), staging)
        require([p.name for p in staging.iterdir()] == [f'raw-stage{stage}'], 'wrong raw archive root')
        (staging / f'raw-stage{stage}').rename(destination / f'raw-stage{stage}')
        staging.rmdir()
    # Replay in private copies. Never replace the sealed source or summaries.
    verification = destination / 'verification'
    verification.mkdir()
    identities = {}
    with tempfile.TemporaryDirectory() as temporary:
        copy = Path(temporary) / 'evidence'
        shutil.copytree(destination, copy)
        for stage in (13, 14):
            name = f'independent-stage{stage}-replay.json'
            original = (destination / name).read_bytes()
            subprocess.run([sys.executable, str(copy / f'audit_stage{stage}.py')], check=True)
            replayed = (copy / name).read_bytes()
            same_replay(json.loads(original), json.loads(replayed))
            (verification / name).write_bytes(replayed)
            identities[str(stage)] = {'originalSha256': digest(original), 'replaySha256': digest(replayed),
                                       'byteIdentical': original == replayed, 'originalPreserved': True}
    (verification / 'replay-identities.json').write_text(json.dumps(identities, indent=2) + '\n')
    print('PASS: 26 sealed files, 48 child reports and journals; failed gates remain failed')

if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python3 restore.py NEW_OUTPUT_DIRECTORY')
    restore(Path(__file__).resolve().parent / 'retained.tar.xz.parts', Path(sys.argv[1]).resolve())
