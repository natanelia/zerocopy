"""Narrow hosted provisioning; the released supervisor owns all 66 scientific children."""
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import time
from runner import Runner, invalidate_terminal, read, sha, write
from supervisor import HERE, BASE, METHOD, authenticate, environment, inventory, packet, main as screen

PREFIX = 'proofs/short-query-packing-screen'
WORKFLOW = '.github/workflows/short-query-packing-screen.yml'
NODE_SHA = '8142d37c6f2f372ef040419e7a111a6baf17df89f8078d02447d6c639ae20c1d'
BUN_SHA = 'a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c'


def prepare(root):
    packet_hash, release = packet()
    repo = HERE.parents[1]
    assert os.environ.get('GITHUB_REPOSITORY') == release['repository'] == 'natanelia/zerocopy'
    assert os.environ.get('GITHUB_REF') == 'refs/heads/' + release['branch']
    assert os.environ.get('GITHUB_RUN_ATTEMPT') == '1'
    assert sha(repo / WORKFLOW) == sha(HERE / 'workflow.yml')
    root.mkdir(parents=True, exist_ok=False)
    runner = Runner(root / 'evidence', 900)
    (root / 'tmp').mkdir(); toolchain = root / 'toolchain'; toolchain.mkdir()
    node = str(Path(shutil.which('node')).resolve())
    npm = str(Path(shutil.which('npm')).resolve())
    assert sha(node) == NODE_SHA
    env = {'PATH': str(Path(node).parent) + ':/usr/local/bin:/usr/bin:/bin',
           'TMPDIR': str(root / 'tmp'), 'CI': '1', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'TZ': 'UTC',
           'npm_config_audit': 'false', 'npm_config_fund': 'false', 'npm_config_cache': str(root / 'npm-cache')}
    result = {'ready': False, 'baseCommit': BASE, 'methodSha256': METHOD, 'packetSha256': packet_hash,
              'toolchain': str(toolchain), 'arms': {}, 'engines': {}, 'failure': None}
    try:
        def command(label, argv, cwd=repo, seconds=30):
            return runner.run(label, argv, cwd, env, seconds).read_text().strip()
        head = command('proof-head', ['/usr/bin/git', 'rev-parse', 'HEAD'])
        assert head == os.environ['GITHUB_SHA']
        assert command('proof-parent', ['/usr/bin/git', 'rev-parse', 'HEAD^']) == BASE
        expected_paths = {PREFIX + '/' + path for path in read(HERE / 'INPUT-SHA256.json')}
        expected_paths.update((PREFIX + '/INPUT-SHA256.json', WORKFLOW))
        delta = command('proof-delta', ['/usr/bin/git', 'diff', '--name-only', BASE, head]).splitlines()
        assert set(delta) == expected_paths
        assert command('clean-checkout', ['/usr/bin/git', 'status', '--porcelain']) == ''
        result['proofHead'] = head
        for name in ('package.json', 'package-lock.json'):
            shutil.copyfile(HERE / 'toolchain' / name, toolchain / name)
        command('locked-install', [node, npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], toolchain, 180)
        bun = str((toolchain / 'node_modules/@oven/bun-linux-x64/bin/bun').resolve())
        assert sha(bun) == BUN_SHA
        assert command('node-version', [node, '--version']) == 'v22.16.0'
        assert command('bun-version', [bun, '--version']) == '1.4.2'
        result['engines'] = {'node': {'path': node, 'sha256': NODE_SHA}, 'bun': {'path': bun, 'sha256': BUN_SHA}}
        archive = runner.root / 'pristine-main.tar'
        command('archive-main', ['/usr/bin/git', 'archive', '--format=tar', '--output=' + str(archive), BASE])
        arms = root / 'arms'; arms.mkdir(); baseline = arms / 'baseline'; baseline.mkdir()
        with tarfile.open(archive) as stream:
            stream.extractall(baseline, filter='data')
        assert inventory(baseline) == read(HERE / 'manifests/baseline-sources.json')
        candidate = arms / 'candidate'; shutil.copytree(baseline, candidate)
        shutil.copyfile(HERE / 'overlay/text-search.ts', candidate / 'text-search.ts')
        assert inventory(candidate) == read(HERE / 'manifests/candidate-sources.json')
        for arm, folder in [('baseline', baseline), ('candidate', candidate)]:
            result['arms'][arm] = str(folder)
            (folder / 'node_modules').symlink_to(toolchain / 'node_modules', target_is_directory=True)
        env = environment(result, root / 'tmp')
        command('baseline-native', [node, 'scripts/build-wasm.mjs'], baseline, 90)
        native = read(HERE / 'manifests/native.json')
        for name, pin in native.items():
            assert sha(baseline / name) == pin['sha256']
            shutil.copyfile(baseline / name, candidate / name)
        # The existing build also emits diagnostic WAT; preserve it outside both runtime arms.
        wat = baseline / 'geometry-kernels.wat'
        assert sha(wat) == read(HERE / 'manifests/native-build-extra.json')['geometry-kernels.wat']['sha256']
        shutil.move(wat, runner.root / 'geometry-kernels.wat')
        for arm, folder in [('baseline', baseline), ('candidate', candidate)]:
            command(arm + '-portable', [bun, 'scripts/build-browser.ts'], folder, 60)
        authenticate(result, True); runner.budget()
        assert packet()[0] == packet_hash
        result['ready'] = True
        # Preserve the actual emitted modules with metadata, without uploading installed dependencies.
        for arm, folder in [('baseline', baseline), ('candidate', candidate)]:
            shutil.copytree(folder / 'dist', runner.root / (arm + '-dist'))
        native_out = runner.root / 'native'; native_out.mkdir()
        for name in native:
            shutil.copyfile(baseline / name, native_out / name)
    except BaseException as error:
        result.update(ready=False, failure=repr(error))
        raise
    finally:
        files = {str(path.relative_to(runner.root)): sha(path)
                 for path in runner.root.rglob('*') if path.is_file()
                 and path.name not in ('OUTPUT-SHA256.json', 'PROVISION.json')}
        result['budgetSecondsForSafetyOnly'] = time.monotonic() - runner.start
        invalidate_terminal(result, runner.interrupted, result['budgetSecondsForSafetyOnly'])
        write(runner.root / 'PROVISION.json', result)
        files['PROVISION.json'] = sha(runner.root / 'PROVISION.json')
        write(runner.root / 'OUTPUT-SHA256.json', files)
    assert result['ready']


if __name__ == '__main__':
    assert len(sys.argv) in (3, 4)
    if sys.argv[1] == 'prepare':
        assert len(sys.argv) == 3
        prepare(Path(sys.argv[2]).resolve())
    elif sys.argv[1] == 'screen':
        assert len(sys.argv) == 4
        screen(Path(sys.argv[2]).resolve() / 'evidence/PROVISION.json', Path(sys.argv[3]).resolve())
    else:
        raise ValueError('prepare FRESH_ROOT | screen PROVISION_ROOT FRESH_OUTPUT')
