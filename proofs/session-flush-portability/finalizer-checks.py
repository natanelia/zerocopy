"""Proposed synthetic export-boundary gate; no runtime subjects or subprocesses."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('packet_finalizer',Path(__file__).with_name('finalize.py'))
finalizer=importlib.util.module_from_spec(spec);spec.loader.exec_module(finalizer)

def fixture(root):
    for name in finalizer.PUBLIC_SOURCE_FILES:
        path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'public synthetic source\n')
    (root/'PUBLIC-WHITELIST.json').write_text(json.dumps({'sourceFiles':list(finalizer.PUBLIC_SOURCE_FILES)}))
    rows=[{'path':name,'bytes':len((root/name).read_bytes()),'sha256':finalizer.sha((root/name).read_bytes())}
      for name in finalizer.PUBLIC_SOURCE_FILES if name!='INPUT-PINS.json']
    (root/'INPUT-PINS.json').write_text(json.dumps({'files':rows}))
    private=root/'_private/secret.txt';private.parent.mkdir();private.write_bytes(b'PRIVATE SENTINEL MUST NEVER BE EXPORTED')
    science=root/'results/arm';science.mkdir(parents=True);(science/'SCREEN.json').write_text('{"state":"failed"}\n')
    return private

class ExportBoundary(unittest.TestCase):
    def test_valid_source_and_bounded_partial_science(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);fixture(root);target=root/'export';target.mkdir()
            rows=finalizer.export_sources(root,target)
            self.assertEqual(len(rows),len(finalizer.PUBLIC_SOURCE_FILES))
            science,rejected=finalizer.export_science(root,'arm',target)
            self.assertEqual([row['path'] for row in science],['results/SCREEN.json']);self.assertEqual(rejected,[])

    def test_mutable_whitelist_fails_closed_and_partial_science_survives(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);fixture(root);target=root/'export';target.mkdir()
            value=json.loads((root/'PUBLIC-WHITELIST.json').read_text());value['sourceFiles'].append('_private/secret.txt')
            (root/'PUBLIC-WHITELIST.json').write_text(json.dumps(value))
            with self.assertRaises(ValueError):finalizer.export_sources(root,target)
            self.assertFalse((target/'source').exists())
            science,rejected=finalizer.export_science(root,'arm',target)
            self.assertEqual(len(science),1);self.assertEqual(rejected,[])
            self.assertFalse(any(b'PRIVATE SENTINEL' in p.read_bytes() for p in target.rglob('*') if p.is_file()))

    def test_source_and_science_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);private=fixture(root);target=root/'export';target.mkdir()
            chosen=root/'workload.mjs';chosen.unlink();chosen.symlink_to(private)
            with self.assertRaises(OSError):finalizer.export_sources(root,target)
            self.assertFalse((target/'source').exists())
            science_path=root/'results/arm/SCREEN.json';science_path.unlink();science_path.symlink_to(private)
            rows,rejected=finalizer.export_science(root,'arm',target)
            self.assertEqual(rows,[]);self.assertEqual(len(rejected),1)
            self.assertFalse((target/'results/SCREEN.json').exists())

if __name__=='__main__':unittest.main()
