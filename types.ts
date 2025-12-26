// Shared type definitions
export type PrimitiveType = 'string' | 'number' | 'boolean' | 'object';
export type StructureType = 'SharedMap' | 'SharedSet' | 'SharedList' | 'SharedStack' | 'SharedQueue' | 'SharedLinkedList' | 'SharedDoublyLinkedList' | 'SharedOrderedMap' | 'SharedOrderedSet' | 'SharedSortedMap' | 'SharedSortedSet' | 'SharedPriorityQueue';
export type ValueType = PrimitiveType | `${StructureType}<${string}>`;

export type ValueOf<T extends string> = 
  T extends 'string' ? string : 
  T extends 'number' ? number : 
  T extends 'boolean' ? boolean : 
  T extends 'object' ? object :
  T extends `${StructureType}<${string}>` ? any : // Nested structures resolved at runtime
  never;

export interface NestedTypeInfo {
  structureType: StructureType;
  innerType: string;
}

const STRUCTURE_TYPES = new Set<string>(['SharedMap', 'SharedSet', 'SharedList', 'SharedStack', 'SharedQueue', 'SharedLinkedList', 'SharedDoublyLinkedList', 'SharedOrderedMap', 'SharedOrderedSet', 'SharedSortedMap', 'SharedSortedSet', 'SharedPriorityQueue']);

export function parseNestedType(type: string): NestedTypeInfo | null {
  if (!type) return null;
  const match = type.match(/^(Shared\w+)<(.+)>$/);
  if (!match || !STRUCTURE_TYPES.has(match[1])) return null;
  return { structureType: match[1] as StructureType, innerType: match[2] };
}

export function isNestedType(type: string): boolean {
  return parseNestedType(type) !== null;
}
