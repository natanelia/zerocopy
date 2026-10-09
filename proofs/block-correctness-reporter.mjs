import { makeReporter, makeWriter, expectedFiles } from './block-correctness-trace.mjs';
export default makeReporter(makeWriter('reporter'), expectedFiles());
