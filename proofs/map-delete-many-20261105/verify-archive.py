"""Reassemble archived evidence and run the unchanged verifiers; no timings run."""
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
RECORDS = ("pilot-v1.json.gz", "pilot-v2.json.gz", "pilot-v3.json.gz", "final-v3.json.gz")
CHUNK_LIMIT = 192 * 1024


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def artifact(name):
    path = (ROOT / name).resolve()
    assert ROOT in path.parents, f"Artifact must stay inside the evidence directory: {name}"
    return path


def main():
    manifest_bytes = (ROOT / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    assert set(manifest["evidence"]) == set(RECORDS)
    for name, digest in manifest["artifacts"].items():
        assert sha256(artifact(name).read_bytes()) == digest, f"Artifact digest mismatch: {name}"

    with tempfile.TemporaryDirectory(prefix="zerocopy-delete-archive-") as directory:
        temporary = Path(directory)
        # Keep the original recording name and manifest lookup. The frozen
        # verifiers find driver/workload sources beside their own scripts.
        (temporary / "manifest.json").write_bytes(manifest_bytes)
        paths = {}
        for name in RECORDS:
            metadata = manifest["evidence"][name]
            storage = metadata.get("storage")
            if storage is None:
                paths[name] = artifact(name)
                stored = paths[name].read_bytes()
            else:
                assert name == "final-v3.json.gz"
                assert storage["type"] == "concatenated-chunks"
                assert storage["chunkLimitBytes"] == CHUNK_LIMIT
                assert storage["chunks"]
                assert len({part["path"] for part in storage["chunks"]}) == len(storage["chunks"])
                pieces = []
                for part in storage["chunks"]:
                    piece = artifact(part["path"]).read_bytes()
                    assert 0 < len(piece) == part["bytes"] <= CHUNK_LIMIT, part["path"]
                    assert sha256(piece) == part["sha256"], part["path"]
                    pieces.append(piece)
                stored = b"".join(pieces)
                assert len(stored) == storage["bytes"]
                paths[name] = temporary / name
                paths[name].write_bytes(stored)
            assert sha256(stored) == metadata["sha256"], name
            raw = gzip.decompress(stored)
            assert len(raw) == metadata["uncompressedBytes"], name
            assert sha256(raw) == metadata["uncompressedSha256"], name

        for verifier, names in (("verify.py", RECORDS[:2]), ("verify-v3.py", RECORDS[2:])):
            subprocess.run([sys.executable, str(ROOT / verifier), *(str(paths[name]) for name in names)], check=True)
    print("Verified all four records, chunk reconstruction, original hashes and frozen artifact hashes; no timings run.")


if __name__ == "__main__":
    main()
