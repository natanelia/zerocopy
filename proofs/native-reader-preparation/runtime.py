"""Tokenless official archive retrieval; authenticate bytes, never execute runtimes."""
import os
from pathlib import Path
import sys
import tarfile
import urllib.parse
import urllib.request
import zipfile

from bounded_process import read, require, sha, write
from files import MAX_BYTES, MAX_FILES, relative, write_member, plain
from specification import RUNTIMES

URLS = {
    'node': 'https://nodejs.org/dist/v22.16.0/node-v22.16.0-linux-x64.tar.xz',
    'bun': 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip',
}

class OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        require(parsed.scheme == 'https' and parsed.hostname in ('nodejs.org', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'), 'Unofficial runtime redirect')
        return super().redirect_request(request, fp, code, message, headers, newurl)


def retrieve(url, destination, expected):
    require(url in URLS.values(), 'Unapproved official runtime URL')
    require(not os.environ.get('GH_TOKEN') and not os.environ.get('GITHUB_TOKEN'), 'Runtime provisioner must be tokenless')
    count = 0
    with urllib.request.build_opener(OfficialRedirect()).open(url, timeout=20) as response, destination.open('xb') as out:
        while block := response.read(2**20):
            count += len(block)
            require(count <= MAX_BYTES, 'Runtime archive byte cap')
            out.write(block)
    require(sha(destination) == expected, 'Runtime archive digest mismatch')
    return count


def restore_node(archive, destination, expected):
    prefix = 'node-v22.16.0-linux-x64/'
    require(expected and set(expected).issuperset({'bin/node', 'lib/node_modules/npm/bin/npm-cli.js'}), 'Complete pinned Node/npm selection required')
    require(all(name == 'bin/node' or name.startswith('lib/node_modules/npm/') for name in expected), 'Unexpected Node selection')
    destination.mkdir()
    seen, total, count = set(), 0, 0
    with tarfile.open(archive, 'r|xz') as bundle:
        for member in bundle:
            count += 1
            require(count <= MAX_FILES * 2, 'Node archive entry cap')
            name = relative(member.name.rstrip('/'))
            require(name == prefix.rstrip('/') or name.startswith(prefix), 'Node archive root mismatch')
            selected = name[len(prefix):]
            if member.isdir() or not (selected == 'bin/node' or selected.startswith('lib/node_modules/npm/')):
                continue
            require(member.isfile() and selected in expected and selected not in seen, 'Unexpected Node/npm entry')
            seen.add(selected); total += member.size
            require(total <= MAX_BYTES, 'Node/npm expansion cap')
            with bundle.extractfile(member) as stream:
                write_member(stream, destination / selected, expected[selected], member.size, 0o755 if selected == 'bin/node' else 0o644)
    require(seen == set(expected) and plain(destination) == expected, 'Node/npm selection incomplete')


def main():
    binding, work, raw = read(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    destination = work / 'provisioned'; destination.mkdir()
    records = {}
    for name in ('node', 'bun'):
        config = binding['runtimeArchives'][name]
        require(config['url'] == URLS[name], 'Runtime URL differs from method')
        archive = destination / (name + '.archive')
        records[name] = {'url': config['url'], 'sha256': config['sha256'], 'bytes': retrieve(config['url'], archive, config['sha256'])}
        if name == 'node':
            restore_node(archive, destination / 'node', config['selectedFiles'])
        else:
            target = destination / 'bun/bin/bun'; target.parent.mkdir(parents=True)
            with zipfile.ZipFile(archive) as bundle:
                members = bundle.infolist()
                require(len(members) <= 3, 'Unexpected Bun archive entries')
                regular = [entry for entry in members if not entry.is_dir()]
                require(len(regular) == 1 and regular[0].filename == 'bun-linux-x64/bun', 'Unexpected Bun distribution')
                with bundle.open(regular[0]) as stream:
                    write_member(stream, target, RUNTIMES['bun']['sha256'], regular[0].file_size, 0o755)
        executable = destination / name / 'bin' / name
        require(sha(executable) == RUNTIMES[name]['sha256'], 'Fixed runtime executable mismatch')
        records[name]['executableSHA256'] = sha(executable)
    npm = destination / 'node/lib/node_modules/npm/bin/npm-cli.js'
    require(sha(npm) == binding['npmEntrySHA256'], 'Audited bundled npm mismatch')
    records['npm'] = {'sha256': sha(npm), 'bundledWithPinnedNodeDistribution': True}
    regular_bytes = sum(path.stat().st_size for path in destination.rglob('*') if path.is_file())
    require(regular_bytes <= binding['sizing']['runtimeProvisionedRegularBytesCeiling'] and regular_bytes <= MAX_BYTES, 'Provisioned archive/Node/npm/Bun bytes exceed reviewed aggregate ceiling')
    records['aggregateRegularBytes'] = regular_bytes
    write(raw / 'runtime-provisioning.json', records)


if __name__ == '__main__':
    main()
