"""Packaging only: retain partial evidence and a digest without changing inputs."""
from pathlib import Path
import hashlib, json, sys, tarfile

root, archive = map(Path, sys.argv[1:])
root.mkdir(parents=True, exist_ok=True)
if not any(root.iterdir()):
    (root / 'missing-evidence.json').write_text(json.dumps({'state': 'incomplete', 'reason': 'No preparation evidence survived'}) + '\n')
with archive.open('xb') as output:
    with tarfile.open(fileobj=output, mode='w:gz') as tar:
        tar.add(root, arcname=root.name, recursive=True)
with Path(str(archive) + '.sha256').open('x') as output:
    output.write(hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name + '\n')
