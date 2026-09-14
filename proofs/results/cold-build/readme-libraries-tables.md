**SharedMap vs Immutable.Map vs Native Map**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| set | 9.1937ms | 6.0396ms | 1.52x slower | 0.3310ms | 27.77x slower |

**SharedList vs Immutable.List vs Native Array**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| push | 8.3055ms | 1.3092ms | 6.34x slower | 0.0754ms | 110.19x slower |

**SharedStack vs Immutable.Stack vs Native Array**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| push | 8.7927ms | 0.1977ms | 44.47x slower | 0.0759ms | 115.86x slower |

**SharedQueue vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| enqueue | 9.1342ms | 0.0464ms | 196.92x slower |

**SharedLinkedList vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| prepend | 10.9289ms | 10.4679ms | 1.04x slower |
| append | 9.6980ms | 0.0426ms | 227.76x slower |

**SharedDoublyLinkedList vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| prepend | 11.1614ms | 10.2468ms | 1.09x slower |
| append | 10.2377ms | 0.0352ms | 290.71x slower |

**SharedOrderedMap vs Immutable.OrderedMap vs Native Map**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| set | 11.6101ms | 9.3478ms | 1.24x slower | 0.4130ms | 28.11x slower |

**SharedSortedMap vs Native Map**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| set | 12.4279ms | 0.4745ms | 26.19x slower |
