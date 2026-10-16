"""Bounded setup scratch metadata and cleanup; no package/leak assertion."""
import os
from pathlib import Path
import shutil
import stat

from bounded_process import require, write

MAX_ENTRIES = 100000
MAX_LOGICAL_BYTES = 2 * 2**30


def summarize(root):
    require(root.is_dir() and not root.is_symlink(), 'Real owned setup scratch root required')
    result = {'entries': 0, 'regularFiles': 0, 'directories': 0, 'links': 0, 'logicalBytes': 0}
    def walk(directory, depth=0):
        require(depth <= 64, 'Setup scratch depth cap')
        with os.scandir(directory) as entries:
            for entry in entries:
                result['entries'] += 1
                require(result['entries'] <= MAX_ENTRIES, 'Setup scratch metadata cap')
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    result['directories'] += 1; walk(Path(entry.path), depth + 1)
                elif stat.S_ISREG(info.st_mode):
                    result['regularFiles'] += 1; result['logicalBytes'] += info.st_size
                    require(result['logicalBytes'] <= MAX_LOGICAL_BYTES, 'Setup scratch logical byte cap')
                elif stat.S_ISLNK(info.st_mode):
                    result['links'] += 1
                else:
                    raise ValueError('Unexpected setup scratch entry kind')
    walk(root)
    return result


def cleanup(work, raw, names=('home', 'npm-cache', 'tmp')):
    records = []
    for name in names:
        root = work / name
        info = root.lstat()
        before = summarize(root)
        require((root.lstat().st_dev, root.lstat().st_ino) == (info.st_dev, info.st_ino), 'Setup scratch root changed')
        require(shutil.rmtree.avoids_symlink_attacks, 'Descriptor-safe setup cleanup required')
        shutil.rmtree(root)
        require(not root.exists() and not root.is_symlink(), 'Setup scratch cleanup incomplete')
        records.append({'scope': name, 'before': before, 'removed': True})
    write(raw / 'setup-scratch.json', {'schemaVersion': 1, 'scope': 'owned setup scratch only',
        'packageOrLeakClaim': False, 'perScopeEntryCap': MAX_ENTRIES, 'perScopeLogicalByteCap': MAX_LOGICAL_BYTES,
        'contentsRead': False, 'linksFollowed': False, 'scopes': records, 'allOwnedSetupScratchRemoved': True})
