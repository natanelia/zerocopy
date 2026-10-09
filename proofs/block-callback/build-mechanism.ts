import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const [subject, entry, outfile] = process.argv.slice(2);
let arena = readFileSync(resolve(subject, 'arena.ts'), 'utf8');
function replace(old: string, next: string) { if (!arena.includes(old)) throw new Error(`Missing source anchor: ${old}`); arena = arena.replace(old, next); }
replace('get dv(): DataView { this.refresh();', 'get dv(): DataView { (globalThis as any).__blockCounts.dv++; this.refresh();');
replace('refresh(): void {', 'refresh(): void { (globalThis as any).__blockCounts.refresh++;');
replace('*blocks(root: number, reverse = false): Generator<number> {', '*blocks(root: number, reverse = false): Generator<number> { (globalThis as any).__blockCounts.generatorStarts++;');
const start = arena.indexOf('  *blocks('), end = arena.indexOf('  *vector(', start);
let blocks = arena.slice(start,end);
blocks = blocks.replace('const stack: number[] = [];', '(globalThis as any).__blockCounts.stackArrays++; const stack: number[] = [];');
blocks = blocks.replaceAll('yield this.dv.getFloat64(data + i * 8, true)', 'yield ((globalThis as any).__blockCounts.scalarYields++, this.dv.getFloat64(data + i * 8, true))');
blocks = blocks.replaceAll('yield dv.getFloat64(data + i * 8, true)', 'yield ((globalThis as any).__blockCounts.scalarYields++, dv.getFloat64(data + i * 8, true))');
arena = arena.slice(0,start)+blocks+arena.slice(end);
if (arena.includes('function visitBlockSpans(')) {
  replace('  visitBlockSpans(arena, root, reverse,', '  (globalThis as any).__blockCounts.spanClosures++;\n  visitBlockSpans(arena, root, reverse,');
  replace('    visit(data, length);', '    (globalThis as any).__blockCounts.spanCallbacks++; visit(data, length);');
  replace('function visitBlockSpans(arena: Arena, root: number, reverse: boolean, visit: (data: number, length: number) => void): void {', 'function visitBlockSpans(arena: Arena, root: number, reverse: boolean, visit: (data: number, length: number) => void): void { (globalThis as any).__blockCounts.stackArrays++;');
}
writeFileSync(`${outfile}.instrumented-arena.ts`, arena);
const wasm = readFileSync(resolve(subject,'persistent-core.wasm')).toString('base64');
const result = await Bun.build({ entrypoints:[entry], outfile, target:'node', format:'esm', plugins:[{name:'mechanism-counts',setup(build) {
  build.onLoad({filter:/[\\/]arena\.ts$/},()=>({contents:arena,loader:'ts'}));
  build.onLoad({filter:/[\\/]wasm-utils\.ts$/},()=>({contents:`export function loadWasm() { return Buffer.from(${JSON.stringify(wasm)}, 'base64'); }`,loader:'js'}));
}}]});
if (!result.success) throw new Error(JSON.stringify(result.logs));
if (result.outputs.length !== 1) throw new Error('Expected one mechanism bundle');
await Bun.write(outfile, result.outputs[0]);
