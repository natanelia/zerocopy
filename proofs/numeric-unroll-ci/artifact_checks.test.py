"""Synthetic parser checks; no real module compilation or execution."""
import unittest
from artifact_checks import uleb, wasm_shape

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

if __name__=='__main__':unittest.main()
