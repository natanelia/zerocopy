"""Read-only/pure final-admission positives and retained exploit negatives."""
import copy
import io
import json
import pathlib
import shutil
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import artifact_admission as a
import artifact_fixture as fixture


class PrimitiveAdmission(unittest.TestCase):
    def test_duplicate_json_keys_and_nonfinite_numbers_fail(self):
        for value in (b'{"id":1,"id":2}', b'{"value":NaN}', b'{"value":Infinity}'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                a.decode(value)

    def test_unsafe_paths_fail(self):
        for value in ('', '.', '../receipt', '/absolute', 'x/../receipt', 'x//receipt', './receipt', 'x\\receipt'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                a.relative(value)

    def test_typed_nonempty_ids(self):
        valid = {'GITHUB_RUN_ID': '42', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_SHA': 'a'*40, 'GITHUB_WORKFLOW_SHA': 'a'*40,
                 'GITHUB_REPOSITORY': 'natanelia/zerocopy', 'GITHUB_REF': 'refs/heads/proof/numeric-portability-20261009'}
        a.validate_run_identity(valid)
        for key in a.RUN_KEYS:
            for value in (None, '', 1):
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    a.validate_run_identity({**valid, key: value})
        for value in ('0', '-1', '01', '2'):
            key = 'GITHUB_RUN_ATTEMPT' if value == '2' else 'GITHUB_RUN_ID'
            with self.subTest(value=value), self.assertRaises(ValueError):
                a.validate_run_identity({**valid, key: value})

    def test_current_checkout_must_be_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            proof = root / 'proofs/numeric-portability'
            fixture.write(root, 'proofs/numeric-portability/origin.json', {})
            fixture.write(root, 'proofs/numeric-portability/protocol.json', {})
            fixture.write(root, '.github/workflows/numeric-portability.yml', b'synthetic workflow')
            names = ['proofs/numeric-portability/origin.json', 'proofs/numeric-portability/protocol.json', '.github/workflows/numeric-portability.yml']
            packet = {'files': [fixture.item(root/name, name) for name in names], 'origin': {}, 'defaultOff': True, 'runtimeExecutionAuthorized': False}
            fixture.write(root, 'proofs/numeric-portability/packet.json', packet)
            packet_sha = a.digest((proof/'packet.json').read_bytes())
            fixture.write(root, 'proofs/numeric-portability/activation.json', {'enabled': True, 'reviewedPacketSha256': packet_sha, 'reviewedPacketCommit': 'b'*40})
            env = {'GITHUB_WORKSPACE': str(root), 'GITHUB_ACTIONS': 'true', 'GITHUB_RUN_ID': '42', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_SHA': 'a'*40, 'GITHUB_WORKFLOW_SHA': 'a'*40, 'GITHUB_REPOSITORY': 'natanelia/zerocopy', 'GITHUB_REF': 'refs/heads/proof/numeric-portability-20261009'}
            replies = {('rev-parse', 'HEAD'): 'a'*40, ('rev-parse', 'HEAD^'): 'b'*40, ('diff', '--name-only', 'HEAD^', 'HEAD'): 'proofs/numeric-portability/activation.json', ('status', '--porcelain', '--untracked-files=no'): ''}
            def git(command, **kwargs):
                self.assertEqual(command[:3], ['git', '-C', str(root)])
                return replies[tuple(command[3:])]
            with patch.dict(a.os.environ, env, clear=True), patch.object(a.subprocess, 'check_output', side_effect=git):
                self.assertEqual(a.checkout_expectation()['packetSha256'], packet_sha)
                replies[('status', '--porcelain', '--untracked-files=no')] = ' M proofs/numeric-portability/activation.json'
                with self.assertRaisesRegex(ValueError, 'tracked modifications'):
                    a.checkout_expectation()

    def test_source_archive_reconstructs_git_tree_and_rejects_forgery(self):
        files = {'alpha': ('100644', b'original\n'), 'directory/executable': ('100755', b'#!/bin/sh\n')}
        expected = a.git_tree(files)
        with tempfile.TemporaryDirectory() as tmp:
            archive = pathlib.Path(tmp) / 'source.tar'
            def save(mutation=None, duplicate=False):
                with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT, pax_headers={'comment': 'a'*40}) as out:
                    for name, (mode, original) in files.items():
                        data = mutation if mutation is not None and name == 'alpha' else original
                        member = tarfile.TarInfo(name); member.size = len(data); member.mode = 0o755 if mode == '100755' else 0o644
                        out.addfile(member, io.BytesIO(data))
                        if duplicate and name == 'alpha': out.addfile(member, io.BytesIO(data))
            save()
            self.assertEqual(a.source_archive(archive, 'a'*40, expected), files)
            save(mutation=b'forged\n')
            with self.assertRaisesRegex(ValueError, 'pinned Git tree'): a.source_archive(archive, 'a'*40, expected)
            save(duplicate=True)
            with self.assertRaisesRegex(ValueError, 'Duplicate archive member'): a.source_archive(archive, 'a'*40, expected)
            save()
            with self.assertRaisesRegex(ValueError, 'commit comment'): a.source_archive(archive, 'b'*40, expected)

    def test_exact_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            fixture.write(root, 'evidence.json', {'observed': True})
            fixture.inventory(root)
            self.assertEqual(set(a.validate_inventory(root)), {'evidence.json'})
            good = (root / 'artifact-inventory.json').read_bytes()
            cases = [[], [fixture.item(root/'evidence.json', 'evidence.json')]*2,
                     [fixture.item(root/'evidence.json', 'missing.json')]]
            for values in cases:
                fixture.write(root, 'artifact-inventory.json', {'files': values, 'quiescence': 'verified-from-owned-receipts', 'originalAttemptFilesIncluded': True})
                with self.subTest(values=values), self.assertRaises(ValueError): a.validate_inventory(root)
            (root / 'artifact-inventory.json').write_bytes(good)
            fixture.write(root, 'unlisted.json', {})
            with self.assertRaisesRegex(ValueError, 'exact archived file set'): a.validate_inventory(root)
            (root / 'unlisted.json').unlink()
            (root / 'symbolic').symlink_to(root / 'evidence.json')
            with self.assertRaisesRegex(ValueError, 'Non-regular artifact'): a.validate_inventory(root)

    def test_retained_empty_and_duplicate_exploit_inventories_fail_directly(self):
        root=pathlib.Path('/workspace/shared/zerocopy-numeric-portability-review-20261009/statistics')
        for name in ('synthetic-empty-ledgers','synthetic-duplicate-cells'):
            for lane in ('x64','arm64'):
                with self.subTest(name=name,lane=lane),self.assertRaises(ValueError):
                    a.validate_inventory(root/name/('numeric-portability-'+lane))


class CompleteArtificialGraph(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='numeric-admission-tests-')
        cls.directory = pathlib.Path(cls.temp.name)
        cache = fixture.prepare_source_cache(cls.directory)
        cls.roots, cls.expected, cls.canonical = {}, {}, {}
        for lane in ('arm64', 'x64'):
            root = cls.directory / ('numeric-portability-' + lane)
            expected, canonical = fixture.make_lane(root, lane, cache)
            cls.roots[lane], cls.expected[lane], cls.canonical[lane] = root, expected, canonical

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_positive_exact_source_and_complete_schedule(self):
        self.assertEqual(sum(len([s for s in c['slots'] if s['mode']=='measure']) for c in self.canonical.values()), 112)
        self.assertEqual(sum(len([s for s in c['slots'] if s['mode']=='calibrate']) for c in self.canonical.values()), 10)
        self.assertEqual(sum(len(c['phaseSlots']['untimed']) for c in self.canonical.values()), 14)
        self.assertEqual(len(self.canonical['x64']['phaseSlots']['semantics']), 6)
        self.assertTrue(all(c['packetSha256'] == self.expected[lane]['packetSha256'] for lane, c in self.canonical.items()))

    def mutate(self, changes, pattern=None, lane='arm64'):
        root = self.roots[lane]
        backup = {name: (root/name).read_bytes() if (root/name).exists() else None for name in changes}
        try:
            for name, operation in changes.items():
                if operation is None:
                    (root/name).unlink()
                elif callable(operation):
                    value = a.read(root/name); operation(value); fixture.write(root, name, value)
                else:
                    fixture.write(root, name, operation)
            fixture.inventory(root)
            with self.assertRaisesRegex((ValueError, AssertionError, KeyError), pattern or '.'):
                a.validate_lane(root, lane, self.expected[lane], archived=True)
        finally:
            for name, data in backup.items():
                if data is None: (root/name).unlink(missing_ok=True)
                else: (root/name).write_bytes(data)
            fixture.inventory(root)

    def test_missing_mandatory_links_and_receipts(self):
        names = ('harness/manifest.json', 'harness/protocol.json', 'packet.json', 'baseline-source.tar',
                 'generated-fixtures.json', 'build-comparison.json', 'gate-baseline-source.json',
                 'logs/gate-candidate/31.json', 'logs/gate-baseline/00.log', 'untimed/ledger.json',
                 'untimed/node-untimed-baseline.config.json', 'untimed/node-untimed-baseline.process.json',
                 'untimed/node-untimed-baseline.cleanup.json', 'untimed/node-untimed-baseline.stdout.jsonl',
                 'untimed/node-untimed-baseline.stderr.log', 'untimed/node-untimed-baseline.receipt.json')
        for name in names:
            with self.subTest(name=name): self.mutate({name: None}, 'Missing/nonregular evidence|No such file')

    def test_unexpected_archived_file(self):
        self.mutate({'run/forged-slot.stdout.jsonl': b'{}\n'}, 'Unexpected/unlinked archived evidence')

    def test_current_run_and_sealed_packet_bindings(self):
        for key, value in (('GITHUB_RUN_ID', '987654321'), ('GITHUB_RUN_ATTEMPT', '2'), ('GITHUB_SHA', 'f'*40), ('PROOF_LANE', 'x64')):
            with self.subTest(key=key): self.mutate({'run.json': lambda r,k=key,v=value: r.update({k:v})})
        self.mutate({'packet.json': lambda r: r.update(defaultOff=False)}, 'Wrong sealed packet bytes')
        self.mutate({'activation.json': lambda r: r.update(reviewedPacketCommit='f'*40)}, 'current reviewed activation')

    def test_gate_command_set_and_envelope(self):
        self.mutate({'gate-baseline.json': lambda r: r['commands'].pop()}, 'command count')
        self.mutate({'gate-candidate-envelope.json': lambda r: r.update(status='failed')}, 'stage envelope')
        self.mutate({'logs/gate-baseline/00.json': lambda r: r.update(command=['true'])}, 'command/cwd/status')

    def test_exact_ordered_slot_identity(self):
        self.mutate({'untimed/ledger.json': lambda r: r.update(slots=[])}, 'exact slot count')
        self.mutate({'untimed/ledger.json': lambda r: r['slots'].reverse()}, 'identity/order mismatch')
        self.mutate({'untimed/ledger.json': lambda r: r['slots'].__setitem__(1, copy.deepcopy(r['slots'][0]))}, 'identity/order mismatch')

    def test_missing_config_digest_is_not_self_attested(self):
        base = 'untimed/node-untimed-baseline'
        def remove(record): record.pop('configSha256')
        self.mutate({base+'.receipt.json': remove, 'untimed/ledger.json': lambda r: remove(r['slots'][0])}, 'configSha256')

    def test_false_raw_or_wrong_cleanup_stays_invalid_after_inventory_refresh(self):
        self.mutate({'untimed/node-untimed-baseline.stdout.jsonl': b'{"kind":"complete"}\n'}, 'digest mismatch')
        self.mutate({'untimed/node-untimed-baseline.cleanup.json': lambda r: r.update(ownedGroupGone=False)}, 'digest mismatch')

    def test_browser_journal_is_mandatory(self):
        self.mutate({'semantics/chromium-semantics-baseline.ownership.jsonl': None}, 'Missing/nonregular evidence', lane='x64')

    def test_missing_analysis_file_fails(self):
        self.mutate({'lane-analysis.json': None}, 'Missing/nonregular evidence')

    def test_retained_counterexamples_remain_blocked(self):
        review = pathlib.Path('/workspace/shared/zerocopy-numeric-portability-review-20261009/statistics')
        for case in ('synthetic-empty-ledgers', 'synthetic-duplicate-cells'):
            for lane in ('x64', 'arm64'):
                with self.subTest(case=case,lane=lane), self.assertRaises((ValueError, FileNotFoundError)):
                    a.validate_lane(review/case/('numeric-portability-'+lane), lane, self.expected[lane], archived=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
