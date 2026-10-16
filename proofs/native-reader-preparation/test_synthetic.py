"""Bounded standard-library fixtures only. No network, child process or target."""
import hashlib
import io
import json
import signal
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile
from unittest.mock import patch

import files
from files import inventory, plain, pack_exact, untar_exact, unzip_exact, validate_inventory
from gates import binding_at, seal_raw
from bounded_process import sha, write
from scratch import summarize, cleanup
from runtime import restore_node
from assemble import restore_bun_install_bytes
from authentication import validate_transport_contract
from specification import RUNTIMES

H = hashlib.sha256(b'fixture').hexdigest()


class Fixtures(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='reader-restore-synthetic-', dir='/tmp')
        self.root = Path(self.tmp.name)
    def tearDown(self): self.tmp.cleanup()
    def tar(self, entries, filename='fixture.tar', mode='w'):
        archive = self.root / filename
        with tarfile.open(archive, mode) as bundle:
            for name, content, kind in entries:
                member = tarfile.TarInfo(name); member.mode = 0o644
                if kind == 'file':
                    member.size = len(content); bundle.addfile(member, io.BytesIO(content))
                else:
                    member.type = tarfile.SYMTYPE; member.linkname = content; bundle.addfile(member)
        return archive
    def test_roundtrip_full_inventory_and_contained_links(self):
        source = self.root / 'source'
        (source / 'dependencies/node_modules/pkg').mkdir(parents=True)
        (source / 'dependencies/node_modules/.bin').mkdir()
        (source / 'dependencies/node_modules/pkg/cli').write_bytes(b'fixture')
        (source / 'dependencies/node_modules/pkg/cli').chmod(0o755)
        (source / 'dependencies/node_modules/.bin/cli').symlink_to('../pkg/cli')
        (source / 'sources/candidate/proofs/example').mkdir(parents=True)
        for index in range(518): (source / 'sources/candidate/proofs/example' / str(index)).write_bytes(b'')
        expected = inventory(source, links=True, modes=True)
        archive = self.root / 'ready.tar'; pack_exact(source, archive, expected)
        untar_exact(archive, self.root / 'restored', expected)
        self.assertEqual(inventory(self.root / 'restored', links=True, modes=True), expected)
    def test_tar_escape_extra_missing_duplicate_and_link_rejected(self):
        for index, entries in enumerate([
            [('../escape', b'fixture', 'file')], [('extra', b'fixture', 'file')], [],
            [('file', b'fixture', 'file'), ('file', b'fixture', 'file')], [('file', 'other', 'link')],
        ]):
            archive = self.tar(entries, str(index) + '.tar')
            with self.assertRaises(ValueError): untar_exact(archive, self.root / ('out' + str(index)), {'file': {'sha256': H}})
        self.assertFalse((self.root.parent / 'escape').exists())
    def test_inventory_alias_collision_link_and_mode_rejected(self):
        for bad in [
            {'../x': {'sha256': H}}, {'a//b': {'sha256': H}}, {'a': {'sha256': H}, 'a/b': {'sha256': H}},
            {'x': {'link': 'target'}}, {'dependencies/node_modules/x': {'link': '/etc/passwd'}},
            {'x': {'sha256': H, 'mode': 0o777}}, {'x': {'sha256': H, 'extra': True}},
        ]:
            with self.assertRaises(ValueError): validate_inventory(bad)
    def test_dependency_link_escape_rejected(self):
        archive = self.tar([('dependencies/node_modules/pkg/file', b'fixture', 'file')])
        expected = {'dependencies/node_modules/pkg/file': {'sha256': H}, 'dependencies/node_modules/link': {'link': '../../../outside'}}
        with self.assertRaises(ValueError): untar_exact(archive, self.root / 'restored', expected)
    def test_wrong_digest_and_mode_rejected(self):
        archive = self.tar([('file', b'bad', 'file')])
        with self.assertRaises(ValueError): untar_exact(archive, self.root / 'restored', {'file': {'sha256': H}})
        source = self.root / 'source'; source.mkdir(); (source / 'file').write_bytes(b'fixture')
        expected = inventory(source, modes=True); (source / 'file').chmod(0o755)
        with self.assertRaises(ValueError): pack_exact(source, self.root / 'ready.tar', expected)
    def test_zip_exact_and_escape(self):
        archive = self.root / 'input.zip'
        with zipfile.ZipFile(archive, 'w') as bundle: bundle.writestr('one/file', b'fixture')
        unzip_exact(archive, self.root / 'ok', {'one/file': H})
        self.assertEqual(plain(self.root / 'ok'), {'one/file': H})
        with self.assertRaises(ValueError): unzip_exact(archive, self.root / 'bad', {'wrong': H})
    def test_bounded_file_count(self):
        source = self.root / 'source'; source.mkdir()
        for index in range(3): (source / str(index)).write_bytes(b'')
        with patch.object(files, 'MAX_FILES', 2):
            with self.assertRaises(ValueError): inventory(source)
    def test_setup_scratch_above_old_512_cap_and_no_link_follow(self):
        work = self.root / 'work'; work.mkdir(); raw = self.root / 'raw'; raw.mkdir()
        outside = self.root / 'outside'; outside.write_bytes(b'preserved')
        for name in ('home', 'npm-cache', 'tmp'): (work / name).mkdir()
        for index in range(600): (work / 'tmp' / str(index)).write_bytes(b'x')
        (work / 'tmp/link').symlink_to(outside)
        self.assertEqual(summarize(work / 'tmp')['entries'], 601)
        cleanup(work, raw)
        self.assertTrue(outside.exists())
        report = json.loads((raw / 'setup-scratch.json').read_text())
        self.assertFalse(report['packageOrLeakClaim']); self.assertTrue(report['allOwnedSetupScratchRemoved'])
    def test_node_archive_selection_and_symlink_rejected(self):
        selected = {'bin/node': H, 'lib/node_modules/npm/bin/npm-cli.js': H}
        prefix = 'node-v22.16.0-linux-x64/'
        archive = self.tar([(prefix + name, b'fixture', 'file') for name in selected], 'node.tar.xz', 'w:xz')
        restore_node(archive, self.root / 'node', selected)
        self.assertEqual(plain(self.root / 'node'), selected)
        bad = self.tar([(prefix + 'bin/node', 'outside', 'link')], 'bad.tar.xz', 'w:xz')
        with self.assertRaises(ValueError): restore_node(bad, self.root / 'badnode', selected)
    def test_bun_repair_rejects_symlink_ancestor_before_writes(self):
        ready = self.root / 'ready'; root = ready / 'dependencies/node_modules'
        root.mkdir(parents=True); outside = self.root / 'outside'; (outside / 'bin').mkdir(parents=True)
        (root / 'bun').symlink_to(outside, target_is_directory=True)
        expected = {'bun/bin/bun.exe': {'sha256': RUNTIMES['bun']['sha256']}}
        with self.assertRaises(ValueError): restore_bun_install_bytes(ready, expected)
        self.assertFalse((outside / 'bin/bun.exe').exists())
    def test_bun_fixed_move_and_copy_record_exact_layout(self):
        ready = self.root / 'ready'; root = ready / 'dependencies/node_modules'
        for name in ('bun/bin', '.bin', '@oven/bun-linux-x64/bin'): (root / name).mkdir(parents=True, exist_ok=True)
        (ready / 'runtimes').mkdir(); (ready / 'runtimes/bun').write_bytes(b'fixture')
        (root / '@oven/bun-linux-x64/bin/bun').write_bytes(b'fixture')
        (root / 'bun/bin/bun.exe').write_bytes(b'stub')
        expected = {name: {'sha256': H} for name in ('bun/bin/bun.exe', 'bun/bin/bunx.exe')}
        expected.update({'.bin/bun': {'link': '../bun/bin/bun.exe'}, '.bin/bunx': {'link': '../bun/bin/bunx.exe'}})
        with patch.dict(RUNTIMES, {'bun': {'sha256': H}}): records = restore_bun_install_bytes(ready, expected)
        self.assertEqual(inventory(root, links=True), expected)
        self.assertEqual(len(records), 5)
        self.assertEqual(records[0]['after'], {'absent': True})
        self.assertEqual(records[1]['before'], {'sha256': hashlib.sha256(b'stub').hexdigest()})
    def test_unsealed_binding_cannot_enter(self):
        path = self.root / 'binding.json'; write(path, {'schemaVersion': 1, 'sealed': False})
        with self.assertRaises(ValueError): binding_at(path, sha(path), 'native-reader-preparation-inputs', self.root)
    def test_seal_excludes_only_itself_and_refuses_second_write(self):
        raw = self.root / 'raw'; raw.mkdir(); (raw / 'file').write_bytes(b'fixture')
        digest = seal_raw(raw)
        self.assertEqual(digest, sha(raw / 'raw-evidence-seal.json'))
        self.assertEqual(json.loads((raw / 'raw-evidence-seal.json').read_text()), {'file': {'sha256': H}})
        with self.assertRaises(ValueError): seal_raw(raw)
    def test_future_transport_receipt_not_required_for_recipe_review(self):
        prep = {'readyInputArchiveSHA256': H, 'readyInputInventorySHA256': H}
        review = {**prep, 'reviewedTransportMethodSHA256': H, 'checks': {'boundedTransportReviewed': True}}
        receipt = {**prep, 'schemaVersion': 1, 'kind': 'native-reader-performance-transport', 'status': 'complete',
            'preparationReceiptSHA256': H, 'reviewedTransportMethodSHA256': H, 'rawEvidenceSealSHA256': H,
            'elapsedSeconds': 1, 'wholeCapSeconds': 180}
        receipt.update({flag: True for flag in ('bounded', 'noRebuild', 'noTargetImports', 'extractionVerified', 'ownedGroupsEmpty')})
        validate_transport_contract(receipt, prep, review, {'wholeCapSeconds': 180}, H)
        for key, value in [('elapsedSeconds', 181), ('noRebuild', False), ('preparationReceiptSHA256', '0' * 64)]:
            with self.assertRaises(ValueError): validate_transport_contract({**receipt, key: value}, prep, review, {'wholeCapSeconds': 180}, H)


if __name__ == '__main__':
    signal.alarm(30)
    unittest.main()
