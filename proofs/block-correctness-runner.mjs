import { VitestTestRunner } from 'vitest/runners';
import { makeRunner, makeWriter } from './block-correctness-trace.mjs';
export default makeRunner(VitestTestRunner, makeWriter('worker'));
