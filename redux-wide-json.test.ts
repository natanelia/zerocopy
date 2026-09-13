import { expect, it } from 'vitest';
import { SharedMap } from './shared';
import { createZerocopyCodec } from './redux';

it('restores a wide JSON object without spreading its fields into function arguments', () => {
  const record = Object.fromEntries(Array.from({ length: 150_000 }, (_, i) => [`field${i}`, i]));
  const source = new SharedMap('object').set('wide', record), codec = createZerocopyCodec();
  const restored = codec.parse(codec.stringify(source)) as SharedMap<'object'>;
  expect(Object.keys(restored.get('wide')!).length).toBe(150_000);
  expect((restored.get('wide') as any).field149999).toBe(149_999);
  expect(Object.isFrozen(restored.get('wide'))).toBe(true);
}, 15_000);
