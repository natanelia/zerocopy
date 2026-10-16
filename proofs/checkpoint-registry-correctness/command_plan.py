"""Pure declarative plan for the bounded, correctness-only checkpoint gate."""

FOCUSED = ['redux-checkpoint.test.ts', 'checkpoint-descriptor-validation.test.ts']


def command_plan(bun, node, npm, baseline, candidate, output):
    commands = []
    # Both builds and type checks use their exact source arm, before test transplant.
    for arm, root in [('baseline', baseline), ('candidate', candidate)]:
        for script, wall in [('build:wasm', 120), ('build:browser', 60), ('build:types', 60),
                             ('typecheck', 60), ('typecheck:redux', 60)]:
            commands.append((arm + '-' + script.replace(':', '-'), [bun, 'run', script], root, wall))
    for arm, root in [('baseline', baseline), ('candidate', candidate)]:
        for runtime, prefix in [('node', [node]), ('bun', [bun, '--bun'])]:
            label = arm + '-focused-' + runtime
            commands.append((label, [*prefix, 'node_modules/vitest/vitest.mjs', 'run', *FOCUSED,
                             '--reporter=json', '--outputFile=' + str(output / (label + '.json'))], root, 120))
        commands.append((arm + '-full-bun', [bun, 'run', 'test'], root, 600))
        commands.append((arm + '-redux-proof', [node, 'proofs/redux-node.mjs'], root, 60))
    commands.extend([
        ('candidate-package-dry-run', [npm, 'pack', '--dry-run', '--ignore-scripts', '--json'], candidate, 60),
        ('candidate-package-consumer', [node, 'scripts/check-package.mjs'], candidate, 180),
    ])
    return commands
