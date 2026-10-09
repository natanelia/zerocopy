"""Synthetic parser checks; no real module compilation or execution."""
import unittest,tempfile,pathlib,os
from artifact_checks import uleb, wasm_shape, scalar_fixture
import controller

class ArtifactTests(unittest.TestCase):
    def test_bounded_leb(self):
        self.assertEqual(uleb(bytes([0xac,2]),0),(300,2))
        for value in (b'', bytes([128]), bytes([255]*5+[0])):
            with self.assertRaises(AssertionError):uleb(value,0)
    def test_sections_and_body_bytes(self):
        # One synthetic code section: count 1, body length 2, locals 0, end.
        record=wasm_shape(b'\0asm\x01\0\0\0'+bytes([10,4,1,2,0,11]))
        self.assertEqual(record['bytes'],14)
        self.assertEqual(record['sections'][0]['id'],10)
        self.assertEqual(record['bodies'][0]['bytes'],2)
        changed=wasm_shape(b'\0asm\x01\0\0\0'+bytes([10,4,1,2,0,1]))
        self.assertNotEqual(record['bodies'][0]['sha256'],changed['bodies'][0]['sha256'])
    def test_malformed_section_is_rejected(self):
        for data in (b'wrong', b'\0asm\x01\0\0\0'+bytes([10,20,1]), b'\0asm\x01\0\0\0'+bytes([10,2,1,3])):
            with self.assertRaises(AssertionError):wasm_shape(data)
    def test_scalar_fixture_is_distinct_and_final_hash_bound(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder);(root/'dist').mkdir();source=root/'dist/numeric.js';source.write_bytes(b'export const value=1;\n')
            record=scalar_fixture(root,create=True);target=root/record['path']
            self.assertFalse(record['officialOutput']);self.assertEqual(record['kind'],'generated-test-fixture')
            self.assertEqual(len(list((root/'dist').glob('*.js'))),1)
            self.assertEqual(source.read_bytes(),target.read_bytes());self.assertNotEqual(source.stat().st_ino,target.stat().st_ino)
            self.assertEqual(scalar_fixture(root),record)
            manifest={'sources':{},'sourceReview':{'files':[]},'tools':[], 'harness':[{'path':str(target),'sha256':record['sha256']}]}
            self.assertTrue(controller.verify(manifest)['ok'])
            target.write_bytes(b'changed')
            with self.assertRaisesRegex(AssertionError,'Changed harness'):controller.verify(manifest)
            with self.assertRaises(AssertionError):scalar_fixture(root)
    def test_scalar_fixture_never_overwrites_or_accepts_aliases(self):
        for shape in ('existing','symlink','dangling','hardlink','source-symlink'):
            with self.subTest(shape=shape),tempfile.TemporaryDirectory() as folder:
                root=pathlib.Path(folder);(root/'dist').mkdir();source=root/'dist/numeric.js';target=root/'dist/numeric-scalar-control.mjs'
                source.write_bytes(b'original')
                if shape=='existing':target.write_bytes(b'keep this')
                elif shape=='symlink':target.symlink_to(source)
                elif shape=='dangling':target.symlink_to(root/'missing')
                elif shape=='hardlink':os.link(source,target)
                else:
                    source.rename(root/'actual');source.symlink_to(root/'actual')
                with self.assertRaises((AssertionError,FileExistsError)):scalar_fixture(root,create=True)
                if shape in ('symlink','dangling','hardlink'):
                    with self.assertRaises(AssertionError):scalar_fixture(root)
                if shape=='existing':self.assertEqual(target.read_bytes(),b'keep this')
                self.assertEqual(source.read_bytes(),b'original')

if __name__=='__main__':unittest.main()
