// Generate a four-way scalar control so loop unrolling is not credited to SIMD.
// This source is only used by the proof. It is not a production module.
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const names = ['lx', 'ly', 'hx', 'hy'];
const init = name => name.startsWith('l') ? 'Infinity' : '-Infinity';
const update = (lane, offset) => `const x${lane}=load<f64>(q+${offset}), y${lane}=load<f64>(q+${offset+8}); if(x${lane}<lx${lane})lx${lane}=x${lane}; if(y${lane}<ly${lane})ly${lane}=y${lane}; if(x${lane}>hx${lane})hx${lane}=x${lane}; if(y${lane}>hy${lane})hy${lane}=y${lane};`;
let source = `let minX:f64=Infinity,minY:f64=Infinity,maxX:f64=-Infinity,maxY:f64=-Infinity;
export function bboxMinX():f64{return minX;} export function bboxMinY():f64{return minY;}
export function bboxMaxX():f64{return maxX;} export function bboxMaxY():f64{return maxY;}
function leaf(root:u32,depth:u32,tail:u32,size:u32,index:u32):u32 { if(index>=((size-1)&~31))return tail;let p=root;for(let d=depth;d>0;d--)p=load<u32>(p+((index>>(d*5))&31)*4);return p; }
export function bboxXY(root:u32,depth:u32,tail:u32,size:u32):void { if(size&1)unreachable();
`;
for (const name of names) for (let lane=0;lane<4;lane++) source += `let ${name}${lane}:f64=${init(name)};\n`;
source += `for(let base:u32=0;base<size;base+=32){const p=leaf(root,depth,tail,size,base),end=p+min(<u32>32,size-base)*8;let q=p;for(;end-q>=64;q+=64){`;
for (let lane=0;lane<4;lane++) source += update(lane,lane*16);
source += `}for(;q<end;q+=16){${update(0,0)}}}\n`;
for (const name of names) for (let lane=1;lane<4;lane++) source += `if(${name}${lane}${name.startsWith('l')?'<':'>'}${name}0)${name}0=${name}${lane};\n`;
source += `minX=lx0;minY=ly0;maxX=hx0;maxY=hy0;
let nx=minX==0||maxX==0,ny=minY==0||maxY==0;if(!nx&&!ny)return;
for(let base:u32=0;base<size;base+=32){const p=leaf(root,depth,tail,size,base),end=p+min(<u32>32,size-base)*8;for(let q=p;q<end;q+=16){
if(nx){const x=load<f64>(q);if(x==0){if(minX==0)minX=x;if(maxX==0)maxX=x;nx=false;}}
if(ny){const y=load<f64>(q+8);if(y==0){if(minY==0)minY=y;if(maxY==0)maxY=y;ny=false;}}if(!nx&&!ny)return;}}
}`;
writeFileSync('proofs/.geometry-bbox-control.as.ts', source);
execFileSync(process.execPath, ['node_modules/assemblyscript/bin/asc.js', 'proofs/.geometry-bbox-control.as.ts', '-o', 'geometry-bbox-control.wasm', '--textFile', 'geometry-bbox-control.wat', '--importMemory', '--sharedMemory', '--initialMemory', '2', '--maximumMemory', '65536', '--enable', 'threads', '--runtime', 'stub', '--optimizeLevel', '3', '--shrinkLevel', '0'], { stdio: 'inherit' });
