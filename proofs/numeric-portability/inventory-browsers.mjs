// Read installed metadata only. This command never launches an engine or imports an arm.
import {createRequire} from 'node:module';
import {writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
const [source,output,lane]=process.argv.slice(2),require=createRequire(path.join(source,'package.json')),playwright=require('playwright');
const version=require('playwright/package.json').version;if(version!=='1.63.0')throw Error('Unexpected Playwright version');
const registry=JSON.parse(readFileSync(path.join(path.dirname(require.resolve('playwright-core/package.json')),'browsers.json')));
const engines=(lane==='x64'?['chromium','firefox','webkit']:['chromium']).map(name=>({name,executable:playwright[name].executablePath(),registry:registry.browsers.filter(x=>x.name===name||x.name===name+'-headless-shell')}));
writeFileSync(output,JSON.stringify({version,engines},null,2)+'\n',{flag:'wx'});
