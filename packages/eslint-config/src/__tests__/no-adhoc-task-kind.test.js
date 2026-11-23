import { afterAll, describe, expect, it } from 'vitest';
import { typedProject } from '../testing/typed-project.fake.js';

// `no-adhoc-task-kind` is type-aware, so it lints real files of a temp project that holds a
// `TaskKind` alias, like the protocol's, and the runtime's `tasks/work.utils.ts` beside its
// `tasks.service.ts`.
const RULE = 'harness/no-adhoc-task-kind';
const IMPORTS = "import type { TaskKind } from './kind';\n";

const project = typedProject({
  name: 'no-adhoc-task-kind',
  rule: RULE,
  include: ['src', 'packages', 'vendor'],
  options: { module: 'esnext', moduleResolution: 'bundler' },
  files: {
    'src/kind.ts': "export type TaskKind = 'task' | 'agent' | 'service';\n",
    // The node registry's kinds: the built-in three (`command`, not `task`) and an extension's.
    'src/node-kind.ts':
      "export type NodeKind = 'agent' | 'command' | 'service' | `${string}.${string}`;\nexport type BuiltInNodeKind = 'agent' | 'command' | 'service';\n",
    'src/tasks/tasks.service.ts': 'export class TaskRegistry {}\n',
  },
});
const findingsIn = (params) => project.lint(params);

const body = (code) =>
  `${IMPORTS}export function use(kind: TaskKind, maybe: TaskKind | undefined, text: string): unknown {\n${code}\n}\n`;

afterAll(project.remove);

describe('no-adhoc-task-kind: what it allows', () => {
  it('lets a kind be passed on, stored and printed', async () => {
    expect(
      await findingsIn({
        file: 'src/valid.ts',
        code: body('const held = kind;\nreturn [held, `${kind}`, { kind }];'),
      }),
    ).toEqual([]);
  });

  it('lets an ordinary string, and a literal that is not a kind, be compared', async () => {
    expect(
      await findingsIn({
        file: 'src/strings.ts',
        code: body("return [text === 'service', text !== 'task'];"),
      }),
    ).toEqual([]);
  });

  it('lets a kind be checked for presence, which is not a policy', async () => {
    expect(
      await findingsIn({
        file: 'src/presence.ts',
        code: body('return [maybe === undefined, maybe !== undefined, maybe == null];'),
      }),
    ).toEqual([]);
  });

  it('lets a node kind be compared: it is the node registry’s, not the task kind the rule guards', async () => {
    expect(
      await findingsIn({
        file: 'src/node-kinds.ts',
        code: "import type { BuiltInNodeKind, NodeKind } from './node-kind';\nexport function use(kind: NodeKind, built: BuiltInNodeKind): unknown {\n  return [kind === 'agent', kind !== 'service', built === 'command', built === 'agent'];\n}\n",
      }),
    ).toEqual([]);
  });

  it('lets a comparison of other things go through', async () => {
    expect(
      await findingsIn({
        file: 'src/numbers.ts',
        code: body('const count = text.length;\nreturn count === 0;'),
      }),
    ).toEqual([]);
  });

  it("lets the work.utils.ts beside the registry's tasks.service.ts compare: it is isFiniteKind", async () => {
    expect(
      await findingsIn({
        file: 'src/tasks/work.utils.ts',
        code: "import type { TaskKind } from '../kind';\nexport function isFiniteKind(kind: TaskKind): boolean {\n  return kind !== 'service';\n}\n",
      }),
    ).toEqual([]);
  });
});

describe('no-adhoc-task-kind: what it refuses', () => {
  it.each([
    ['equal to a kind', "return kind === 'service';"],
    ['not equal to a kind', "return kind !== 'task';"],
    ['loose equality', "return kind == 'agent';"],
    ['loose inequality', "return kind != 'service';"],
    ['the literal on the left', "return 'service' === kind;"],
    ['two kinds', 'const other: TaskKind = kind;\nreturn kind === other;'],
    ['a kind that may be missing', "return maybe === 'service';"],
    [
      'a switch',
      "switch (kind) {\n    case 'service':\n      return 1;\n    default:\n      return 2;\n  }",
    ],
  ])('refuses %s', async (name, code) => {
    expect(
      await findingsIn({
        file: `src/refused-${name.replaceAll(' ', '-')}.ts`,
        code: body(code),
      }),
    ).toEqual([RULE]);
  });

  it('refuses a kind made by z.infer, as the protocol makes it, and a renamed import', async () => {
    project.write(
      'src/inferred.ts',
      "type Infer<T> = T extends { _output: infer O } ? O : never;\ndeclare const schema: { _output: 'task' | 'agent' | 'service' };\nexport type TaskKind = Infer<typeof schema>;\n",
    );

    expect(
      await findingsIn({
        file: 'src/inferred-use.ts',
        code: "import type { TaskKind as Kind } from './inferred';\nexport function use(kind: Kind): boolean {\n  return kind === 'service';\n}\n",
      }),
    ).toEqual([RULE]);
  });

  it('refuses a kind narrowed to two of its values', async () => {
    expect(
      await findingsIn({
        file: 'src/narrowed.ts',
        code: body("if (kind === 'service') return 1;\nreturn kind === 'task';"),
      }),
    ).toEqual([RULE, RULE]);
  });

  it('refuses any union of two or more kind literals, a type of its own too', async () => {
    expect(
      await findingsIn({
        file: 'src/own-union.ts',
        code: "export function use(shown: 'task' | 'agent'): boolean {\n  return shown === 'agent';\n}\n",
      }),
    ).toEqual([RULE]);
  });

  it('refuses a union of kinds, however it is spelled', async () => {
    expect(
      await findingsIn({
        file: 'src/union.ts',
        code: "export function use(kind: 'task' | 'service'): boolean {\n  return kind === 'service';\n}\n",
      }),
    ).toEqual([RULE]);
  });

  it('refuses a work.utils.ts with no registry beside it', async () => {
    expect(
      await findingsIn({
        file: 'packages/tools/src/tasks/work.utils.ts',
        code: "import type { TaskKind } from '../../../../src/kind';\nexport function mine(kind: TaskKind): boolean {\n  return kind === 'service';\n}\n",
      }),
    ).toEqual([RULE]);
  });
});

describe('no-adhoc-task-kind: limits left to review', () => {
  it('does not see a kind widened to a string first', async () => {
    expect(
      await findingsIn({
        file: 'src/widened.ts',
        code: body("const name: string = kind;\nreturn name === 'service';"),
      }),
    ).toEqual([]);
  });

  it('does not see a lookup', async () => {
    expect(
      await findingsIn({
        file: 'src/lookup.ts',
        code: body("return new Set<string>(['service']).has(kind);"),
      }),
    ).toEqual([]);
  });
});
