import { describe, it, expect, beforeEach } from 'vitest';
import { SharedSortedMap, SharedSortedSet, resetSortedMap } from './shared';

beforeEach(() => resetSortedMap());

describe('SharedSortedMap', () => {
  it('basic operations', () => {
    const m = new SharedSortedMap('string').set('b', 'B').set('a', 'A').set('c', 'C');
    expect(m.get('a')).toBe('A');
    expect(m.has('b')).toBe(true);
    expect([...m.keys()]).toEqual(['a', 'b', 'c']);
  });

  it('delete', () => {
    const m = new SharedSortedMap('string').set('a', 'A').set('b', 'B');
    const m2 = m.delete('a');
    expect([...m2.keys()]).toEqual(['b']);
  });

  it('branching creates independent versions', () => {
    const base = new SharedSortedMap('string').set('a', 'A').set('b', 'B').set('c', 'C');
    const branch1 = base.delete('a');
    const branch2 = base.delete('c');
    
    expect([...base.keys()]).toEqual(['a', 'b', 'c']);
    expect([...branch1.keys()]).toEqual(['b', 'c']);
    expect([...branch2.keys()]).toEqual(['a', 'b']);
  });

  it('set branching', () => {
    const base = new SharedSortedMap('number').set('x', 1);
    const branch1 = base.set('y', 2);
    const branch2 = base.set('z', 3);
    
    expect([...base.keys()]).toEqual(['x']);
    expect([...branch1.keys()]).toEqual(['x', 'y']);
    expect([...branch2.keys()]).toEqual(['x', 'z']);
  });
});

describe('SharedSortedSet', () => {
  it('basic operations', () => {
    const s = new SharedSortedSet().add('c').add('a').add('b');
    expect(s.has('a')).toBe(true);
    expect([...s.values()]).toEqual(['a', 'b', 'c']);
  });

  it('delete', () => {
    const s = new SharedSortedSet().add('a').add('b');
    const s2 = s.delete('a');
    expect([...s2.values()]).toEqual(['b']);
  });

  it('branching creates independent versions', () => {
    const base = new SharedSortedSet().add('a').add('b').add('c');
    const branch1 = base.delete('a');
    const branch2 = base.delete('c');
    
    expect([...base.values()]).toEqual(['a', 'b', 'c']);
    expect([...branch1.values()]).toEqual(['b', 'c']);
    expect([...branch2.values()]).toEqual(['a', 'b']);
  });

  it('add branching', () => {
    const base = new SharedSortedSet().add('m');
    const branch1 = base.add('a');
    const branch2 = base.add('z');
    
    expect([...base.values()]).toEqual(['m']);
    expect([...branch1.values()]).toEqual(['a', 'm']);
    expect([...branch2.values()]).toEqual(['m', 'z']);
  });
});
