**SharedMap vs Immutable.Map vs Native Map**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| set | 3.2604ms | 5.3907ms | 1.65x faster | 0.3353ms | 9.72x slower |
| get | 0.1718ms | 0.8070ms | 4.70x faster | 0.1233ms | 1.39x slower |
| has | 0.3404ms | 1.2106ms | 3.56x faster | 0.3246ms | 1.05x slower |
| delete | 0.006234ms | 0.005261ms | 1.18x slower | 0.1129ms | 18.11x faster |
| setMany(100) | 0.0678ms | 0.0464ms | 1.46x slower | 0.1278ms | 1.88x faster |

**SharedList vs Immutable.List vs Native Array**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| push | 0.6701ms | 1.3224ms | 1.97x faster | 0.0766ms | 8.75x slower |
| get | 0.1124ms | 0.1106ms | 1.02x slower | 0.0340ms | 3.31x slower |
| pop | 0.000587ms | 0.003076ms | 5.24x faster | 0.0463ms | 78.90x faster |
| forEach | 0.0341ms | 0.1783ms | 5.24x faster | 0.0278ms | 1.23x slower |

**SharedStack vs Immutable.Stack vs Native Array**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| push | 0.8257ms | 0.2916ms | 2.83x slower | 0.0754ms | 10.96x slower |
| peek | 0.0953ms | 0.0983ms | 1.03x faster | 0.0816ms | 1.17x slower |
| pop | 0.000604ms | 0.001259ms | 2.09x faster | 0.0415ms | 68.80x faster |

**SharedQueue vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| enqueue | 0.9763ms | 0.0507ms | 19.26x slower |
| peek | 0.1898ms | 0.0457ms | 4.15x slower |
| dequeue | 0.000517ms | 0.0625ms | 120.96x faster |
| enq+deq(100) | 0.0102ms | 0.0578ms | 5.64x faster |

**SharedLinkedList vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| prepend | 3.9761ms | 10.4225ms | 2.62x faster |
| append | 0.9630ms | 0.0449ms | 21.45x slower |
| get(0-99) | 0.007618ms | 0.000479ms | 15.90x slower |
| removeFirst | 0.002684ms | 0.0543ms | 20.22x faster |

**SharedDoublyLinkedList vs Native Array**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| prepend | 4.5043ms | 10.4163ms | 2.31x faster |
| append | 0.9870ms | 0.0457ms | 21.59x slower |
| get(front) | 0.004973ms | 0.000249ms | 19.94x slower |
| get(back) | 0.004381ms | 0.000259ms | 16.92x slower |
| removeFirst | 0.002613ms | 0.0569ms | 21.76x faster |
| removeLast | 0.000681ms | 0.0282ms | 41.44x faster |

**SharedOrderedMap vs Immutable.OrderedMap vs Native Map**
| Operation | Shared | Immutable | vs Imm | Native | vs Native |
|-----------|--------|-----------|--------|--------|-----------|
| set | 5.4975ms | 8.7273ms | 1.59x faster | 0.4423ms | 12.43x slower |
| get | 0.2544ms | 1.3444ms | 5.28x faster | 0.3744ms | 1.47x faster |
| has | 0.3639ms | 1.6234ms | 4.46x faster | 0.3558ms | 1.02x slower |
| delete | 0.005712ms | 0.008912ms | 1.56x faster | 0.1137ms | 19.90x faster |
| forEach | 1.2636ms | 0.2109ms | 5.99x slower | 0.0844ms | 14.97x slower |

**SharedSortedMap vs Native Map**
| Operation | Shared | Native | vs Native |
|-----------|--------|--------|-----------|
| set | 5.9214ms | 0.5894ms | 10.05x slower |
| get | 0.3756ms | 0.2086ms | 1.80x slower |
| has | 0.3828ms | 0.2036ms | 1.88x slower |
| delete | 0.005403ms | 0.1718ms | 31.79x faster |
| keys(sorted) | 2.3337ms | 0.9256ms | 2.52x slower |
