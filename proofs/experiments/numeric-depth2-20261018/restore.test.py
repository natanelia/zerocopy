#!/usr/bin/env python3
"""Regression checks for the evidence restore path; no timing measurements."""
from pathlib import Path
import io
import math
import shutil
import tarfile
import tempfile
import unittest
import restore

SOURCE = Path(__file__).resolve().parent / 'retained.tar.xz.parts'

class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.parts = self.root / 'parts'
        shutil.copytree(SOURCE, self.parts)
        self.out = self.root / 'restored'

    def tearDown(self):
        self.temp.cleanup()

    def test_complete_replay(self):
        restore.restore(self.parts, self.out)
        for stage in (13, 14):
            files = list((self.out / f'raw-stage{stage}').iterdir())
            self.assertEqual(len(files), 75)

    def test_missing_part(self):
        (self.parts / '04').unlink()
        with self.assertRaisesRegex(ValueError, 'missing or extra'):
            restore.restore(self.parts, self.out)

    def test_extra_part(self):
        (self.parts / '12').write_bytes(b'bad')
        with self.assertRaisesRegex(ValueError, 'missing or extra'):
            restore.restore(self.parts, self.out)

    def test_corrupted_part(self):
        p = self.parts / '06'
        value = bytearray(p.read_bytes()); value[-1] ^= 1; p.write_bytes(value)
        with self.assertRaisesRegex(ValueError, 'part identity'):
            restore.restore(self.parts, self.out)

    def test_truncated_part(self):
        (self.parts / '11').write_bytes(b'bad')
        with self.assertRaisesRegex(ValueError, 'part length'):
            restore.restore(self.parts, self.out)

    def test_existing_output(self):
        self.out.mkdir()
        marker = self.out / 'keep'; marker.write_text('unchanged')
        with self.assertRaisesRegex(ValueError, 'output already exists'):
            restore.restore(self.parts, self.out)
        self.assertEqual(marker.read_text(), 'unchanged')

    def test_derived_last_bit_is_not_a_gate_margin(self):
        restore.same_replay({'lower': 0.94, 'pass': False}, {'lower': math.nextafter(0.94, 1.0), 'pass': False})

    def test_false_pass_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'replay field'):
            restore.same_replay({'lower': 0.94, 'pass': False}, {'lower': 0.94, 'pass': True})

    def test_large_derived_edit_is_rejected(self):
        value = 1.0
        for _ in range(5):
            value = math.nextafter(value, 2.0)
        with self.assertRaisesRegex(ValueError, 'derived estimate'):
            restore.same_replay({'lower': 1.0}, {'lower': value})

    def test_unsafe_member(self):
        for name, kind in (('../outside', tarfile.REGTYPE), ('link', tarfile.SYMTYPE)):
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w') as archive:
                member = tarfile.TarInfo(name); member.type = kind
                archive.addfile(member)
            with self.assertRaises(ValueError):
                restore.unpack(data.getvalue(), self.out)
            self.assertFalse(self.out.exists())

if __name__ == '__main__':
    unittest.main()
