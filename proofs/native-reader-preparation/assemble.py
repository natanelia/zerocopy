"""Restore audited bytes. This module never imports or executes target code."""
from pathlib import Path
import shutil
import sys

from bounded_process import read, require, sha, write
from files import inventory, plain, relative, unzip_exact, untar_exact, pack_exact
from authentication import _terminal_correctness, verified_json
from specification import RUNTIMES
from scratch import cleanup


def original(work, binding):
    root = work / 'downloaded' / relative(binding['evidencePrefix'])
    audit = verified_json(work / 'ready/correctness-audit.json', binding['correctnessAuditSHA256']) if (work / 'ready').exists() else verified_json(Path(binding['correctnessAuditPath']), binding['correctnessAuditSHA256'])
    inputs, outputs = _terminal_correctness(root, audit)
    require(audit['candidateCommit'] == binding['sourceCommit'] and audit['evidenceSealSHA256'] == binding['evidenceSealSHA256'], 'Exact successful evidence required')
    return root, inputs, outputs


def restore(binding_path, work, raw):
    binding = read(binding_path)
    unzip_exact(work / 'download/artifact.zip', work / 'downloaded', binding['artifactFiles'])
    evidence, inputs, outputs = original(work, binding)
    audit = verified_json(Path(binding['correctnessAuditPath']), binding['correctnessAuditSHA256'])
    terminal = verified_json(Path(binding['correctnessTerminalReceiptPath']), binding['correctnessTerminalReceiptSHA256'])
    require(terminal.get('schemaVersion') == 1 and terminal.get('kind') == 'native-reader-correctness-controller-exit' and terminal.get('exitCode') == 0 and
            terminal.get('conclusion') == 'success' and terminal.get('finished') is True and terminal['candidateCommit'] == binding['sourceCommit'] and
            terminal['evidenceSealSHA256'] == binding['evidenceSealSHA256'] and terminal['sourceURL'] == audit['terminalControllerReceipt']['sourceURL'] and
            audit['terminalControllerReceipt']['receiptSHA256'] == binding['correctnessTerminalReceiptSHA256'], 'Successful terminal receipt required')
    require(inputs['baselineCommit'] == binding['baselineCommit'] and inputs['candidateCommit'] == binding['sourceCommit'], 'Correctness input commits mismatch')
    proof = Path(__file__).resolve().parent
    require(sha(proof / 'baseline-sources.json') == '9a68795d3c96706ddcad035e7e0cf37c8635753eeb18afe128dbf32ac27f5b59' and inputs['sourceFiles']['baseline'] == read(proof / 'baseline-sources.json'), 'Original baseline source map differs')
    require(all(inputs['sourceFiles']['candidate'].get(name) == value for name, value in read(proof / 'candidate-pins.json').items()), 'Fixed production/test source delta differs')
    ready = work / 'ready'; ready.mkdir(mode=0o700)
    shutil.copytree(evidence, ready / 'correctness')
    for arm in ('baseline', 'candidate'):
        source = ready / 'sources' / arm
        source.parent.mkdir(exist_ok=True)
        untar_exact(work / (arm + '.tar'), source, {name: {'sha256': value} for name, value in inputs['sourceFiles'][arm].items()})
        artifact = ready / 'artifacts' / arm
        shutil.copytree(evidence / 'builds' / arm, artifact)
        require(plain(artifact) == outputs['builds'][arm], 'Original build files mismatch')
        require('package.json' not in outputs['builds'][arm], 'Audited build/package collision')
        shutil.copyfile(source / 'package.json', artifact / 'package.json')
        require(read(artifact / 'package.json')['type'] == 'module', 'Original ESM package context required')
    dependency_source = ready / 'sources/candidate/proofs/direct-native-reader-correctness/dependencies'
    dependencies = ready / 'dependencies'; dependencies.mkdir()
    for name in ('package.json', 'package-lock.json'):
        shutil.copyfile(dependency_source / name, dependencies / name)
    require(sha(dependencies / 'package-lock.json') == inputs['lockSha256'], 'Original dependency lock mismatch')
    package, lock = read(dependencies / 'package.json'), read(dependencies / 'package-lock.json')
    require(package['dependencies'] == {**read(ready / 'sources/candidate/package.json')['devDependencies'], 'bun': '1.4.2'} and
            lock['packages']['']['dependencies'] == package['dependencies'] and not package.get('scripts'), 'Dependency manifest/lock mismatch')
    require(all(not row.get('resolved') or row['resolved'].startswith('https://registry.npmjs.org/') for row in lock['packages'].values()), 'Non-official dependency URL')
    (ready / 'runtimes').mkdir()
    for name in ('node', 'bun'):
        executable = work / 'provisioned' / name / 'bin' / name
        require(sha(executable) == inputs['executables'][name]['sha256'] == RUNTIMES[name]['sha256'], 'Runtime differs from correctness')
        shutil.copyfile(executable, ready / 'runtimes' / name); (ready / 'runtimes' / name).chmod(0o755)
    require(sha(work / 'provisioned/node/lib/node_modules/npm/bin/npm-cli.js') == inputs['executables']['npm']['sha256'] == binding['npmEntrySHA256'], 'npm differs from correctness preparation')
    for field, name in [('correctnessAuditPath', 'correctness-audit.json'), ('correctnessTerminalReceiptPath', 'correctness-terminal.json')]:
        shutil.copyfile(binding[field], ready / name)
    write(raw / 'restoration.json', {'originalBuilds': outputs['builds'], 'sourceFiles': inputs['sourceFiles'],
        'sourceCounts': {arm: len(files) for arm, files in inputs['sourceFiles'].items()},
        'lockSHA256': inputs['lockSha256'], 'noRebuild': True, 'noTargetImports': True})


def restore_bun_install_bytes(ready, expected):
    repairs = []
    root = ready / 'dependencies/node_modules'
    require(root.is_dir() and root == root.resolve(strict=True), 'Real dependency root required')
    def contained_parent(destination):
        require(destination.parent == destination.parent.resolve(strict=True) and destination.parent.is_relative_to(root), 'Dependency ancestor symlink/escape')
        require(destination.resolve(strict=False).is_relative_to(root), 'Dependency repair escape')
    for name in ('bun/bin/bun.exe', 'bun/bin/bunx.exe'):
        require(expected.get(name) == {'sha256': RUNTIMES['bun']['sha256']}, 'Audited Bun installed bytes differ')
        destination = root / name
        contained_parent(destination)
        require(destination.parent.is_dir() and not destination.is_symlink() and (not destination.exists() or destination.is_file()), 'Unexpected Bun install destination')
        before = {'sha256': sha(destination)} if destination.exists() else {'absent': True}
        if name == 'bun/bin/bun.exe':
            original_name = '@oven/bun-linux-x64/bin/bun'
            original = root / original_name
            contained_parent(original)
            require(original_name not in expected and original.is_file() and not original.is_symlink() and
                    sha(original) == RUNTIMES['bun']['sha256'], 'Exact original Bun executable layout required')
            original.replace(destination)
            repairs.append({'path': original_name, 'before': {'sha256': RUNTIMES['bun']['sha256']},
                'after': {'absent': True}, 'movedTo': name})
        else:
            shutil.copyfile(ready / 'runtimes/bun', destination)
        destination.chmod(0o755)
        repairs.append({'path': name, 'before': before, 'after': {'sha256': sha(destination)}, 'source': 'authenticated Bun runtime bytes'})
    for name, target in (('.bin/bun', '../bun/bin/bun.exe'), ('.bin/bunx', '../bun/bin/bunx.exe')):
        require(expected.get(name) == {'link': target}, 'Unexpected audited Bun launcher')
        destination = root / name
        contained_parent(destination)
        before = {'link': destination.readlink().as_posix()} if destination.is_symlink() else {'absent': not destination.exists()}
        if not destination.is_symlink() and not destination.exists(): destination.symlink_to(target)
        require(destination.is_symlink() and destination.readlink().as_posix() == target, 'Bun launcher differs')
        repairs.append({'path': name, 'before': before, 'after': {'link': target}})
    return repairs


def finish(binding_path, work, raw):
    binding = read(binding_path)
    evidence, inputs, outputs = original(work, binding)
    ready = work / 'ready'
    expected_dependencies = read(evidence / 'dependencies.json')
    require(plain(work / 'provisioned/node') == binding['runtimeArchives']['node']['selectedFiles'], 'Authenticated Node/npm bytes changed during restoration')
    require(sha(work / 'provisioned/bun/bin/bun') == RUNTIMES['bun']['sha256'], 'Provisioned Bun runtime changed')
    repairs = restore_bun_install_bytes(ready, expected_dependencies)
    write(raw / 'dependency-byte-restoration.json', {'lifecycleScriptsExecuted': False, 'repairs': repairs})
    require(inventory(ready / 'dependencies/node_modules', links=True, excluded=('.vite', '.vite-temp', '.cache')) == expected_dependencies, 'Restored locked dependency bytes differ')
    for arm in ('baseline', 'candidate'):
        require(plain(ready / 'sources' / arm) == inputs['sourceFiles'][arm], 'Source snapshot changed')
        require(plain(ready / 'artifacts' / arm) == {**outputs['builds'][arm], 'package.json': inputs['sourceFiles'][arm]['package.json']}, 'Artifact/package context changed')
    for name in ('node', 'bun'): require(sha(ready / 'runtimes' / name) == RUNTIMES[name]['sha256'], 'Copied runtime changed')
    require(inventory(ready / 'correctness') == inventory(evidence), 'Original evidence copy changed')
    cleanup(work, raw)
    files = inventory(ready, links=True, modes=True)
    regular_bytes = sum((ready / name).stat().st_size for name, row in files.items() if 'sha256' in row)
    require(regular_bytes <= binding['sizing']['readyRegularBytesCeiling'], 'Ready-tree bytes exceed reviewed aggregate ceiling')
    write(raw / 'ready-inventory.json', files)
    pack_exact(ready, raw.parent / 'ready-inputs.tar', files)
    write(raw / 'archive.json', {'sha256': sha(raw.parent / 'ready-inputs.tar'),
        'bytes': (raw.parent / 'ready-inputs.tar').stat().st_size, 'regularBytes': regular_bytes, 'inventorySHA256': sha(raw / 'ready-inventory.json')})


if __name__ == '__main__':
    stage, binding, work, raw = sys.argv[1:]
    require(stage in ('restore', 'finish'), 'Unknown restoration stage')
    {'restore': restore, 'finish': finish}[stage](Path(binding), Path(work), Path(raw))
