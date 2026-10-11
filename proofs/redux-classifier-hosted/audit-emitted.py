"""Exact portable graph check adapted from the established current-main gate."""
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
    expected = source['candidateCodecSHA256'] if name == 'redux-codec.ts' else digest
    assert sha((root / 'candidate' / name).read_bytes()) == expected, name

# Exact source-module reordering and local-name changes predicted from the
# existing authenticated emitter. Unknown shapes fail before subject imports.
baseline = {p.name: p.read_text() for p in sorted((root / 'baseline/dist').glob('*.js'))}
candidate = {p.name: p.read_text() for p in sorted((root / 'candidate/dist').glob('*.js'))}
assert len(baseline) == len(candidate) == 12
old_function = """function sharedCollectionKind(value) {
  if (!value || typeof value !== \"object\" || !Object.isFrozen(value))
    return;
  const prototype = Object.getPrototypeOf(value);
  const kind = kinds.find((key) => prototype === classes[key].prototype);
  if (!kind)
    return;
  try {
    arenaOf(value);
    return kind;
  } catch {
    return;
  }
}"""
new_function = """function sharedCollectionKind(value) {
  return collectionKind(value);
}"""
labels = ['redux-heap-codec.ts', 'redux-codec.ts', 'redux-jsan.ts', 'redux-internal.ts', 'redux-checkpoint.ts', 'worker-redux.ts', 'redux.ts']
new_order = ['redux-heap-codec.ts', 'redux-internal.ts', 'redux-codec.ts', 'redux-jsan.ts', 'redux-checkpoint.ts', 'worker-redux.ts', 'redux.ts']
def replace(text):
    if '// redux-codec.ts\n' not in text:
        return text
    matches = list(re.finditer(r'^// ([a-z-]+\.ts)\n', text, re.M))
    assert [m.group(1) for m in matches] == labels
    sections = {m.group(1): text[m.start():matches[i+1].start() if i+1 < len(matches) else len(text)] for i,m in enumerate(matches)}
    codec = sections['redux-codec.ts']
    assert codec.count(old_function) == 1
    assert codec.count('var kinds = Object.freeze(Object.keys(classes));\n') == 1
    codec = codec.replace(old_function, new_function).replace('var kinds = Object.freeze(Object.keys(classes));\n', '')
    sections['redux-codec.ts'] = codec
    for label in ['redux-codec.ts', 'redux-jsan.ts', 'redux.ts']:
        sections[label] = re.sub(r'\bisPlainRecord\b', 'isPlainRecord2', sections[label])
    for label in ['redux-internal.ts', 'redux-checkpoint.ts']:
        sections[label] = re.sub(r'\bisPlainRecord2\b', 'isPlainRecord', sections[label])
    return text[:matches[0].start()] + ''.join(sections[label] for label in new_order)
assert sum(text.count(old_function) for text in baseline.values()) == 1
assert sum(text.count(new_function) for text in candidate.values()) == 1
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
