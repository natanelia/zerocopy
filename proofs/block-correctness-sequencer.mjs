import { BaseSequencer } from 'vitest/node';
import { makeSequencer, makeWriter, expectedFiles } from './block-correctness-trace.mjs';
export default makeSequencer(BaseSequencer, makeWriter('sequencer'), expectedFiles());
