import { parseUtf8JSON, parseUtf8JSONPlain } from './direct-json.mjs';
import { compileJsonFieldEquals } from './byte-query.mjs';
import { decodeUtf8 } from './.runtime/utf8.mjs';
import { freezeJSON } from './.runtime/freeze-json.mjs';
import { fingerprint } from './fixtures.mjs';

const browser = typeof globalThis.postMessage === 'function' && typeof window === 'undefined';
const endpoint = browser ? globalThis : (await import('node:worker_threads')).parentPort;
const send = message => endpoint.postMessage(message);
const listen = handler => browser ? addEventListener('message', e => handler(e.data)) : endpoint.on('message', handler);
const decoder = new TextDecoder('utf-8', {ignoreBOM:true});

function frozenTree(value) {
  const stack = [value];
  while (stack.length) {
    const item = stack.pop();
    if (item === null || typeof item !== 'object') continue;
    if (!Object.isFrozen(item)) return false;
    for (const child of Object.values(item)) if (child !== null && typeof child === 'object') stack.push(child);
  }
  return true;
}

function run({fixture, method, field = 'category', expected = 'books'}) {
  const {buffer, offsets, count} = fixture, bytes = new Uint8Array(buffer);
  let outputs, matches, sink = 0;
  const native = view => freezeJSON(JSON.parse(decodeUtf8(decoder, view)));
  const parse = method === 'codec-native' ? native : method === 'codec-direct' ? parseUtf8JSON
    : method === 'codec-native-plain' ? view => JSON.parse(decodeUtf8(decoder, view)) : parseUtf8JSONPlain;
  let started = performance.now();
  if (method.startsWith('codec-')) {
    outputs = new Array(count);
    for (let i=0;i<count;i++) outputs[i] = parse(bytes.subarray(offsets[i],offsets[i+1]));
  } else if (method === 'decode-only') {
    outputs = new Array(count);
    for (let i=0;i<count;i++) outputs[i] = decodeUtf8(decoder,bytes.subarray(offsets[i],offsets[i+1]));
  } else if (method === 'query-native') {
    matches = 0;
    for (let i=0;i<count;i++) if (native(bytes.subarray(offsets[i],offsets[i+1]))[field] === expected) matches++;
  } else if (method === 'query-bytes') {
    const test = compileJsonFieldEquals(field, expected); // query compilation is timed
    matches = 0;
    for (let i=0;i<count;i++) if (test(bytes,offsets[i],offsets[i+1])) matches++;
  } else if (method === 'query-cached') {
    outputs = new Array(count);
    for (let i=0;i<count;i++) outputs[i] = native(bytes.subarray(offsets[i],offsets[i+1]));
    const materializeMs = performance.now()-started;
    started = performance.now(); matches=0;
    for (let i=0;i<count;i++) if (outputs[i][field] === expected) matches++;
    return {ms:performance.now()-started, materializeMs, matches, count, verified:matches === (field==='absent'?0:fixture.expectedCount)};
  } else throw Error(`Unknown method ${method}`);
  const ms = performance.now()-started;
  if (matches !== undefined) {
    if (matches !== (field==='absent'?0:fixture.expectedCount)) throw Error(`Predicate mismatch ${matches}`);
    return {ms,matches,count,verified:true};
  }
  let hash=2166136261;
  for (const output of outputs) hash=fingerprint((method==='decode-only'?output:JSON.stringify(output))+'\n',hash);
  if (hash!==fixture.expectedHash) throw Error(`Content mismatch ${method} ${hash} != ${fixture.expectedHash}`);
  if (!method.endsWith('plain') && method!=='decode-only') {
    for (const output of outputs) if(!frozenTree(output)) throw Error('Missing deep freeze');
  }
  sink += outputs.length;
  return {ms,hash,sink,count,verified:true};
}

listen(async message => {
  try { send({result:run(message)}); }
  catch(error) { send({error:error.stack ?? String(error)}); }
});
send({ready:true});
