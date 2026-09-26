import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
let code = readFileSync(new URL('./lab.mjs', import.meta.url), 'utf8');
function replace(before, after) { assert.equal(code.split(before).length, 2); code = code.replace(before, after); }
replace('const mismatch = i8x16.bitmask(i8x16.ne(v128.load(a + i), v128.load(b + i)));\n      if (mismatch) return i + <usize>ctz<u32>(mismatch);',
  'const left = v128.load(a + i), right = v128.load(b + i);\n      if (v128.any_true(v128.xor(left, right))) return i + <usize>ctz<u32>(i8x16.bitmask(i8x16.ne(left, right)));');
replace('const i = commonPrefix(a, b, n);\n  return i == n ? 0 : <i32>load<u8>(a + i) - <i32>load<u8>(b + i);',
  'if (!n || a == b) return 0;\n  const first = <i32>load<u8>(a) - <i32>load<u8>(b);\n  if (first) return first;\n  const i = commonPrefix(a, b, n);\n  return i == n ? 0 : <i32>load<u8>(a + i) - <i32>load<u8>(b + i);');
replace("source = source.replaceAll('memory.compare(', 'compareBytes(');", "source = source.replaceAll('memory.compare(', 'compareBytes(');\n  source = source.replace(/compareBytes\\(([^;\\n]*?)\\) == 0/g, 'bytesEqual($1)');");
writeFileSync(new URL('./refined-generated.mjs', import.meta.url), code);
await import('./refined-generated.mjs');
execFileSync('bun', ['proofs/simd/public-build.ts'], { stdio: 'inherit' });
execFileSync(process.execPath, ['--expose-gc', 'proofs/simd/public.mjs'], { stdio: 'inherit' });
