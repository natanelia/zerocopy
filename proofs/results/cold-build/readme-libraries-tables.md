**SharedMap vs Immutable.Map vs Native Map**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| set | 6.5211ms | 4.2956ms | 1.52x slower | 0.2764ms | 23.60x slower |

**SharedList vs Immutable.List vs Native Array**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| push | 4.8919ms | 1.2278ms | 3.98x slower | 0.0722ms | 67.73x slower |

**SharedStack vs Immutable.Stack vs Native Array**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| push | 5.1639ms | 0.1569ms | 32.91x slower | 0.0358ms | 144.11x slower |

**SharedQueue vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| enqueue | 5.4300ms | 0.0391ms | 138.70x slower |

**SharedLinkedList vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| prepend | 8.0629ms | 8.0962ms | 1.00x faster |
| append | 5.5976ms | 0.0351ms | 159.69x slower |

**SharedDoublyLinkedList vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| prepend | 8.3827ms | 7.9232ms | 1.06x slower |
| append | 5.7047ms | 0.0272ms | 209.95x slower |

**SharedOrderedMap vs Immutable.OrderedMap vs Native Map**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| set | 8.4028ms | 7.5247ms | 1.12x slower | 0.4379ms | 19.19x slower |

**SharedSortedMap vs Native Map**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| set | 8.7470ms | 0.4384ms | 19.95x slower |
