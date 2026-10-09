import {pathToFileURL} from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [base, candidate, out] = process.argv.slice(2), report = { timings: false, arms: {} };
const {default: binaryen} = await import(pathToFileURL(base + '/node_modules/binaryen/index.js').href);
for (const [arm, root] of Object.entries({ baseline: base, candidate })) {
  const module = binaryen.readBinary(readFileSync(root + '/persistent-core.wasm')), functions = [], exports = [];
  writeFileSync(out + '/' + arm + '-core.wat', module.emitText());
  for (let i = 0; i < module.getNumFunctions(); i++) { const info = binaryen.getFunctionInfo(module.getFunctionByIndex(i)), body = binaryen.emitText(info.body); functions.push({ index: i, name: info.name, params: binaryen.expandType(info.params), results: binaryen.expandType(info.results), vars: info.vars, bodySHA256: createHash('sha256').update(body).digest('hex'), body }); }
  for (let i = 0; i < module.getNumExports(); i++) exports.push(binaryen.getExportInfo(module.getExportByIndex(i)));
  report.arms[arm] = { functions, exports }; module.dispose();
}
writeFileSync(out + '/emitted-functions.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ functionCounts: Object.fromEntries(Object.entries(report.arms).map(([a, r]) => [a, r.functions.length])), timings: false }));
