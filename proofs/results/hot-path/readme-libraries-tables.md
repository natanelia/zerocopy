**SharedMap vs Immutable.Map vs Native Map**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| set | 3.0362ms | 4.4199ms | 1.46x faster | 0.3952ms | 7.68x slower |
| get | 0.1598ms | 0.7384ms | 4.62x faster | 0.1074ms | 1.49x slower |
| has | 0.3534ms | 1.0116ms | 2.86x faster | 0.3451ms | 1.02x slower |
| delete | 0.004880ms | 0.004163ms | 1.17x slower | 0.0661ms | 13.55x faster |
| setMany(100) | 0.0582ms | 0.0379ms | 1.54x slower | 0.0524ms | 1.11x slower |

**SharedList vs Immutable.List vs Native Array**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| push | 0.7263ms | 1.1686ms | 1.61x faster | 0.0718ms | 10.12x slower |
| get | 0.0873ms | 0.0836ms | 1.04x slower | 0.0249ms | 3.51x slower |
| pop | 0.000603ms | 0.002460ms | 4.08x faster | 0.0370ms | 61.39x faster |
| forEach | 0.0405ms | 0.1472ms | 3.64x faster | 0.0266ms | 1.52x slower |

**SharedStack vs Immutable.Stack vs Native Array**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| push | 0.7890ms | 0.2243ms | 3.52x slower | 0.0730ms | 10.81x slower |
| peek | 0.1090ms | 0.1052ms | 1.04x slower | 0.0975ms | 1.12x slower |
| pop | 0.000543ms | 0.000795ms | 1.46x faster | 0.0181ms | 33.37x faster |

**SharedQueue vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| enqueue | 0.9544ms | 0.0404ms | 23.61x slower |
| peek | 0.1971ms | 0.0580ms | 3.40x slower |
| dequeue | 0.000384ms | 0.0374ms | 97.48x faster |
| enq+deq(100) | 0.008974ms | 0.0355ms | 3.96x faster |

**SharedLinkedList vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| prepend | 4.1996ms | 8.1014ms | 1.93x faster |
| append | 0.8105ms | 0.0360ms | 22.50x slower |
| get(0-99) | 0.003796ms | 0.000576ms | 6.59x slower |
| removeFirst | 0.002664ms | 0.0270ms | 10.15x faster |

**SharedDoublyLinkedList vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| prepend | 4.3444ms | 8.0960ms | 1.86x faster |
| append | 0.8733ms | 0.0353ms | 24.76x slower |
| get(front) | 0.002897ms | 0.000291ms | 9.96x slower |
| get(back) | 0.003081ms | 0.000291ms | 10.59x slower |
| removeFirst | 0.002609ms | 0.0287ms | 10.99x faster |
| removeLast | 0.000658ms | 0.0196ms | 29.75x faster |

**SharedOrderedMap vs Immutable.OrderedMap vs Native Map**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| set | 4.2981ms | 7.3838ms | 1.72x faster | 0.3910ms | 10.99x slower |
| get | 0.2788ms | 1.2519ms | 4.49x faster | 0.4055ms | 1.45x faster |
| has | 0.3689ms | 1.4479ms | 3.92x faster | 0.3799ms | 1.03x faster |
| delete | 0.004633ms | 0.007419ms | 1.60x faster | 0.0412ms | 8.89x faster |
| forEach | 1.1637ms | 0.1804ms | 6.45x slower | 0.0685ms | 17.00x slower |

**SharedSortedMap vs Native Map**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| set | 4.7073ms | 0.3853ms | 12.22x slower |
| get | 0.4457ms | 0.2349ms | 1.90x slower |
| has | 0.4320ms | 0.2246ms | 1.92x slower |
| delete | 0.004398ms | 0.0547ms | 12.44x faster |
| keys(sorted) | 1.6697ms | 0.6811ms | 2.45x slower |
