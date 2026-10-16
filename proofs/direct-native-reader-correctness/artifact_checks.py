"""Fresh native and portable artifact authentication."""
import base64
from bounded_process import sha

def built_artifacts(root):
    expected = {'persistent-core.wasm', 'shared-map.wasm', 'shared-list.wasm', 'linked-list.wasm', 'singly-linked-list.wasm',
                'doubly-linked-list.wasm', 'ordered-map.wasm', 'sorted-tree.wasm', 'priority-queue.wasm',
                'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm'}
    wasm = {path.name: sha(path) for path in root.glob('*.wasm')}
    assert set(wasm) == expected and (root / 'geometry-kernels.wat').is_file()
    for name in wasm:
        assert (root / name).read_bytes()[:8] == b'\x00asm\x01\x00\x00\x00'
        if name not in {'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm'}:
            assert wasm[name] == wasm['persistent-core.wasm']
    chunks = {str(path.relative_to(root)): sha(path) for path in (root / 'dist').rglob('*') if path.is_file()}
    assert all('dist/' + name in chunks for name in ['shared.js', 'worker.js', 'state.js', 'redux.js', 'tanstack-db-collection.js', 'numeric.js', 'geometry.js'])
    js = {name: (root / name).read_text() for name in chunks if name.endswith('.js')}
    assert 7 <= len(js) <= 32
    embedded = {}
    for name in ['persistent-core.wasm', 'numeric-kernels.wasm', 'numeric-kernels-simd.wasm', 'geometry-kernels.wasm']:
        token = base64.b64encode((root / name).read_bytes()).decode('ascii')
        found = [chunk for chunk, text in js.items() if token in text]
        assert found, 'Fresh native bytes missing from portable output: ' + name
        embedded[name] = {'sha256': wasm[name], 'chunks': sorted(found)}
    return {**wasm, 'geometry-kernels.wat': sha(root / 'geometry-kernels.wat'), **chunks}, embedded
