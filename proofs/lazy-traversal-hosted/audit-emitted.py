"""Exact portable graph check adapted from the completed conditional-cache gate."""
from pathlib import Path
import base64
import hashlib
import json
import re

root = Path(__file__).resolve().parent
source = json.loads((root / 'PROVENANCE.json').read_text())
sha = lambda data: hashlib.sha256(data).hexdigest()
for name, digest in source['baselineSourceHashes'].items():
    assert sha((root / 'baseline' / name).read_bytes()) == digest, name
    expected = source['candidateArenaSHA256'] if name == 'arena.ts' else digest
    assert sha((root / 'candidate' / name).read_bytes()) == expected, name

# Exact expected emitter substitutions. An unexpected emitter shape stops the
# gate before any subject import; it is not accepted via fuzzy normalization.
changes = [
    ('const lanes = new Uint32Array(16), patches = [];', 'let lanes, patches;'),
    ('      if (tag & 2147483648) {\n        const bitmap = dv.getUint32(p + 8, true) >>> 16;',
     '      if (tag & 2147483648) {\n        lanes ??= new Uint32Array(16);\n        patches ??= [];\n        const bitmap = dv.getUint32(p + 8, true) >>> 16;'),
]
baseline = {p.name: p.read_text() for p in sorted((root / 'baseline/dist').glob('*.js'))}
candidate = {p.name: p.read_text() for p in sorted((root / 'candidate/dist').glob('*.js'))}
assert len(baseline) == len(candidate) == 12
for old, new in changes:
    assert sum(text.count(old) for text in baseline.values()) == 1, old
    assert sum(text.count(new) for text in candidate.values()) == 1, new
    assert not any(old in text for text in candidate.values()), old
def replace(text):
    for old, new in changes:
        text = text.replace(old, new)
    return text
normalize = lambda text: re.sub(r'chunk-[a-z0-9]+\.js', 'chunk-HASH.js', text)
mapping = {}
for name, text in baseline.items():
    matches = [other for other, content in candidate.items() if normalize(content) == normalize(replace(text))]
    assert len(matches) == 1, (name, matches)
    mapping[name] = matches[0]
assert len(set(mapping.values())) == 12
for name, text in baseline.items():
    expected = re.sub(r'(?<=\./)[A-Za-z0-9-]+\.js', lambda m: mapping.get(m.group(0), m.group(0)), replace(text))
    assert candidate[mapping[name]] == expected, name
types = {}
for arm in ['baseline', 'candidate']:
    types[arm] = {str(p.relative_to(root / arm / 'dist/types')): p.read_bytes() for p in sorted((root / arm / 'dist/types').rglob('*.d.ts'))}
assert len(types['baseline']) == 41 and types['baseline'] == types['candidate']
wasm = {}
for item in json.loads((root / 'REUSE-WASM.json').read_text())['records']:
    a, b = [(root / arm / item['name']).read_bytes() for arm in ['baseline', 'candidate']]
    assert a == b and sha(a) == item['sha256'] and len(a) == item['bytes']
    wasm[item['name']] = sha(a)
for modules in [baseline, candidate]:
    embedded = set()
    for text in modules.values():
        for literal in re.findall(r'["\']([A-Za-z0-9+/]{128,}={0,2})["\']', text):
            value = base64.b64decode(literal, validate=True)
            if value.startswith(b'\0asm'):
                embedded.add(sha(value))
    assert embedded == set(wasm.values()) and len(embedded) == 4
outputs = []
for arm in ['baseline', 'candidate']:
    for path in sorted((root / arm / 'dist').rglob('*')):
        if path.is_file():
            assert path.suffix == '.js' or path.name.endswith('.d.ts'), path
            data = path.read_bytes()
            outputs.append({'path': str(path), 'bytes': len(data), 'sha256': sha(data)})
assert len(outputs) == 106
result = {'passed': True, 'sourceCommit': source['commit'], 'allFourWasmBytesUnchanged': True,
          'moduleCountPerArm': 12, 'declarationsPerArm': 41, 'declarationsIdentical': True,
          'moduleMapping': mapping, 'wasmSHA256': wasm, 'outputs': outputs}
with (root / 'execution/emitted-audit.json').open('x') as stream:
    json.dump(result, stream, indent=2); stream.write('\n')
print(json.dumps(result))
