"""Exact, bounded file transport for the native-reader prerequisite packet."""
import hashlib
import os
from pathlib import Path, PurePosixPath
import stat
import struct
import tarfile
import zipfile

from bounded_process import require, sha

MAX_FILES = 10000
MAX_BYTES = 1 * 2**30
MAX_ZIP_BYTES = MAX_BYTES


def relative(name):
    require(isinstance(name, str) and name and '\\' not in name and '\0' not in name, 'Invalid relative name')
    path = PurePosixPath(name)
    require(not path.is_absolute() and path.as_posix() == name and all(p not in ('', '.', '..') for p in path.parts), 'Unsafe relative name')
    return name


def inventory(root, links=False, modes=False, excluded=()):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), 'Real inventory root required')
    result, total, entries_seen = {}, 0, 0
    def visit(directory, depth=0):
        nonlocal total, entries_seen
        require(depth <= 64, 'Inventory depth cap')
        with os.scandir(directory) as entries:
            for entry in entries:
                entries_seen += 1
                require(entries_seen <= MAX_FILES * 2, 'Inventory entry cap')
                if entry.name in excluded:
                    continue
                path = Path(entry.path)
                name = relative(path.relative_to(root).as_posix())
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    visit(path, depth + 1)
                    continue
                require(len(result) < MAX_FILES, 'File inventory cap')
                if stat.S_ISLNK(info.st_mode):
                    require(links and path.resolve(strict=True).is_relative_to(root.resolve()), 'Escaping or unapproved symlink')
                    result[name] = {'link': os.readlink(path)}
                else:
                    require(stat.S_ISREG(info.st_mode), 'Nonregular file')
                    total += info.st_size
                    require(total <= MAX_BYTES, 'File byte cap')
                    result[name] = {'sha256': sha(path)}
                    if modes:
                        result[name]['mode'] = stat.S_IMODE(info.st_mode)
    visit(root)
    return dict(sorted(result.items()))


def plain(root):
    return {name: row['sha256'] for name, row in inventory(root).items()}


def write_member(stream, destination, expected, size, mode=0o644):
    require(0 <= size <= MAX_BYTES, 'Archive member size cap')
    destination.parent.mkdir(parents=True, exist_ok=True)
    digest, count = hashlib.sha256(), 0
    with destination.open('xb') as output:
        while block := stream.read(min(2**20, size - count + 1)):
            count += len(block)
            require(count <= size, 'Archive member exceeds declared size')
            digest.update(block)
            output.write(block)
    require(count == size and digest.hexdigest() == expected, 'Archive file digest/length mismatch')
    require(mode in (0o600, 0o644, 0o700, 0o755), 'Unexpected file permissions')
    destination.chmod(mode)


def unzip_exact(archive, destination, expected):
    validate_inventory({name: {'sha256': value} for name, value in expected.items()})
    require(archive.stat().st_size <= MAX_ZIP_BYTES and len(expected) <= MAX_FILES, 'ZIP bound')
    with archive.open('rb') as stream:
        stream.seek(max(0, archive.stat().st_size - 65557))
        tail = stream.read(65557)
    offset = tail.rfind(b'PK\x05\x06')
    require(offset >= 0 and len(tail) - offset >= 22, 'ZIP end record missing')
    end = struct.unpack('<4s4H2LH', tail[offset:offset + 22])
    require(end[1] == end[2] == 0 and end[3] == end[4] <= MAX_FILES and end[5] <= 16 * 2**20 and len(tail) - offset == 22 + end[7], 'ZIP directory bound')
    destination.mkdir(mode=0o700)
    seen, total = set(), 0
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            name = relative(member.filename.rstrip('/') if member.is_dir() else member.filename)
            mode = member.external_attr >> 16
            require(not stat.S_ISLNK(mode) and not (mode and stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)), 'ZIP special entry')
            if member.is_dir():
                require(any(key.startswith(name + '/') for key in expected), 'Extra ZIP directory')
                continue
            require(name in expected and name not in seen, 'Extra or duplicate ZIP file')
            seen.add(name)
            total += member.file_size
            require(total <= MAX_BYTES, 'ZIP expansion bound')
            with bundle.open(member) as stream:
                write_member(stream, destination / name, expected[name], member.file_size)
    require(seen == set(expected), 'Missing ZIP file')


def untar_exact(archive, destination, expected):
    validate_inventory(expected)
    require(archive.stat().st_size <= MAX_BYTES and len(expected) <= MAX_FILES, 'TAR bound')
    destination.mkdir(mode=0o700)
    seen, total, count = set(), 0, 0
    with tarfile.open(archive, 'r|') as bundle:
        for member in bundle:
            count += 1
            require(count <= MAX_FILES * 2, 'TAR entry bound')
            name = relative(member.name.rstrip('/') if member.isdir() else member.name)
            if member.isdir():
                require(any(key.startswith(name + '/') for key in expected), 'Extra TAR directory')
                continue
            require(member.isfile() and name in expected and name not in seen and 'sha256' in expected[name], 'Extra, duplicate or nonregular TAR file')
            seen.add(name)
            total += member.size
            require(total <= MAX_BYTES, 'TAR byte cap')
            with bundle.extractfile(member) as stream:
                write_member(stream, destination / name, expected[name]['sha256'], member.size, expected[name].get('mode', 0o644))
    require(seen == {name for name, row in expected.items() if 'sha256' in row}, 'Missing TAR file')
    for name, row in expected.items():
        if 'link' not in row:
            continue
        require(name.startswith('dependencies/node_modules/'), 'Only dependency links are allowed')
        path = destination / relative(name)
        target = row['link']
        require(isinstance(target, str) and not Path(target).is_absolute(), 'Absolute dependency link')
        require((path.parent / target).resolve().is_relative_to((destination / 'dependencies/node_modules').resolve()), 'Dependency link escapes root')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(target)
    require(inventory(destination, links=True, modes=all('mode' in row for row in expected.values() if 'sha256' in row)) == expected, 'Restored inventory mismatch')


def pack_exact(root, destination, expected):
    validate_inventory(expected, modes=True)
    require(not destination.exists(), 'Fresh archive destination required')
    require(inventory(root, links=True, modes=True) == expected, 'Input changed before packing')
    with tarfile.open(destination, 'w', format=tarfile.PAX_FORMAT) as bundle:
        for name, row in expected.items():
            if 'link' in row:
                continue
            path = root / name
            member = tarfile.TarInfo(name)
            member.size, member.mode, member.mtime = path.stat().st_size, row['mode'], 0
            with path.open('rb') as stream:
                bundle.addfile(member, stream)
    require(destination.stat().st_size <= MAX_BYTES, 'Ready archive byte cap')


def validate_inventory(expected, modes=False):
    import re
    require(type(expected) is dict and 0 < len(expected) <= MAX_FILES, 'Invalid inventory size')
    for name, row in expected.items():
        relative(name)
        require(type(row) is dict, 'Invalid inventory record')
        if 'link' in row:
            require(set(row) == {'link'} and name.startswith('dependencies/node_modules/'), 'Unexpected link record')
            require(type(row['link']) is str and row['link'] and not Path(row['link']).is_absolute() and '\\' not in row['link'] and '\0' not in row['link'], 'Invalid link target')
        else:
            require(set(row) in ({'sha256'}, {'sha256', 'mode'}) and re.fullmatch('[0-9a-f]{64}', row.get('sha256', '')), 'Invalid file record')
            require(not modes or 'mode' in row, 'File permission inventory required')
            if 'mode' in row: require(type(row['mode']) is int and row['mode'] in (0o600, 0o644, 0o700, 0o755), 'Invalid file mode')
        require(not any(parent.as_posix() in expected for parent in Path(name).parents if parent.as_posix() != '.'), 'File/link ancestor collision')
