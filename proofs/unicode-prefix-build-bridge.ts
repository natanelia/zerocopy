import {readFileSync} from 'node:fs';
const encoded=readFileSync('persistent-core.wasm').toString('base64');
const result=await Bun.build({
  entrypoints:['proofs/unicode-prefix-bridge.ts'],outdir:'.unicode-prefix-bridge',naming:'bridge.mjs',target:'browser',format:'esm',
  plugins:[{name:'embedded-core',setup(build){
    build.onLoad({filter:/[\\/]wasm-utils\.ts$/},()=>({contents:'export function loadWasm(){return Uint8Array.from(atob('+JSON.stringify(encoded)+'), c=>c.charCodeAt(0));}',loader:'js'}));
  }}],
});
if(!result.success) throw new Error(result.logs.map(String).join('\n'));
console.log(JSON.stringify({outputs:result.outputs.map(x=>({path:x.path,size:x.size}))}));

