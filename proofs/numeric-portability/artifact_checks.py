"""Read-only Wasm/portable artifact comparison. Never compile or execute Wasm."""
import base64, hashlib, pathlib, re

SCALAR_CONTROL_FILE = 'numeric-scalar-control.mjs'

def scalar_fixture(tree, create=False):
    """Exclusive generated fixture; official JS output inventories stay unchanged."""
    root = pathlib.Path(tree).absolute()
    directory = root/'dist'; source = directory/'numeric.js'; target = directory/SCALAR_CONTROL_FILE
    assert root.resolve() == root and directory.resolve() == directory, 'Fixture directory cannot use symlinks'
    assert source.is_file() and not source.is_symlink(), 'Official numeric source must be a regular file'
    data = source.read_bytes()
    if create:
        # Exclusive creation also rejects existing files and dangling symlinks.
        with target.open('xb') as output: output.write(data)
    assert target.is_file() and not target.is_symlink(), 'Scalar fixture must be a regular file'
    before, after = source.stat(), target.stat()
    assert (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino), 'Scalar fixture must be a separate physical file'
    assert target.read_bytes() == data == source.read_bytes(), 'Scalar fixture must be byte-identical'
    return {'path':'dist/'+SCALAR_CONTROL_FILE, 'kind':'generated-test-fixture',
        'sourcePath':'dist/numeric.js', 'bytes':len(data), 'sha256':digest(data),
        'byteIdenticalToOfficial':True, 'physicalFileDistinct':True, 'officialOutput':False}

def digest(data): return hashlib.sha256(data).hexdigest()

def uleb(data, offset):
    value = 0
    for shift in range(0, 35, 7):
        assert offset < len(data), 'Truncated u32 LEB'
        byte = data[offset]; offset += 1
        value |= (byte & 127) << shift
        if not byte & 128:
            assert value <= 0xffffffff
            return value, offset
    raise AssertionError('Oversized u32 LEB')

def wasm_shape(data):
    assert data[:8] == b'\0asm\x01\0\0\0'
    sections = []; bodies = []; offset = 8
    while offset < len(data):
        identifier = data[offset]; offset += 1
        size, offset = uleb(data, offset); end = offset + size
        assert end <= len(data)
        payload = data[offset:end]
        sections.append({'id': identifier, 'bytes': size, 'sha256': digest(payload)})
        if identifier == 10:
            assert not bodies, 'Duplicate code section'
            count, at = uleb(payload, 0)
            for index in range(count):
                length, at = uleb(payload, at); stop = at + length
                assert stop <= len(payload)
                bodies.append({'index':index, 'bytes':length, 'sha256':digest(payload[at:stop])})
                at = stop
            assert at == len(payload)
        offset = end
    return {'bytes': len(data), 'sha256': digest(data), 'sections':sections, 'bodies':bodies}

def verify_build_pair(baseline, candidate, origin):
    arms = {'baseline':pathlib.Path(baseline), 'candidate':pathlib.Path(candidate)}
    records = {}
    for arm, root in arms.items():
        records[arm] = {}
        for category, files in (
            ('wasm', sorted(root.glob('*.wasm'))),
            ('portable', sorted(root.glob('dist/*.js'))),
            ('types', sorted(root.glob('dist/types/**/*.d.ts'))),
        ):
            records[arm][category] = {p.relative_to(root).as_posix():digest(p.read_bytes()) for p in files}
        assert len(records[arm]['wasm']) == 12
        assert len(records[arm]['portable']) == 12
        assert len(records[arm]['types']) == 41
        for name, expected in origin['expectedWasm'][arm].items():
            assert records[arm]['wasm'][name] == expected, 'Unexpected fresh Wasm: '+arm+'/'+name
        numeric = root/'numeric-kernels-simd.wasm'
        assert wasm_shape(numeric.read_bytes()) == origin['expectedSimdShape'][arm]
        text = (root/'dist/numeric.js').read_text()
        embedded = re.findall(r'atob\(simd\s*\?\s*"([A-Za-z0-9+/=]+)"\s*:\s*"([A-Za-z0-9+/=]+)"\)', text)
        assert len(embedded) == 1, 'Exactly one official embedded numeric loader required'
        for name, encoded in zip(('numeric-kernels-simd.wasm','numeric-kernels.wasm'), embedded[0]):
            assert base64.b64decode(encoded, validate=True) == (root/name).read_bytes()
    changed = {}
    for category in ('wasm', 'portable', 'types'):
        assert records['baseline'][category].keys() == records['candidate'][category].keys()
        changed[category] = [name for name, value in records['baseline'][category].items() if value != records['candidate'][category][name]]
    assert changed == {'wasm':['numeric-kernels-simd.wasm'], 'portable':['dist/numeric.js'], 'types':[]}
    a, b = (origin['expectedSimdShape'][arm] for arm in ('baseline','candidate'))
    assert [s['id'] for s in a['sections']] == [s['id'] for s in b['sections']]
    assert [s['id'] for s,t in zip(a['sections'], b['sections']) if s != t] == [10]
    assert len(a['bodies']) == len(b['bodies']) == 5
    assert [s['index'] for s,t in zip(a['bodies'],b['bodies']) if s != t] == [2]
    assert (a['bytes'],b['bytes'],a['bodies'][2]['bytes'],b['bodies'][2]['bytes']) == (782,874,140,232)
    return {'changed':changed, 'simd':origin['expectedSimdShape'], 'allOtherBodiesAndSectionsIdentical':True,
        'portableEmbeddedBytesMatch':True, 'files':records, 'operationClocks':False, 'wasmExecuted':False}
