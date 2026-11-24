import { afterAll, describe, expect, it } from 'vitest';
import { typedProject } from '../testing/typed-project.fake.js';

// `no-unescaped-model-text` is type-aware, so it lints real files of a temp project whose
// `packages/protocol/src/{task,session,node}/` hold the types the rule reads a field's origin from.
const RULE = 'harness/no-unescaped-model-text';
const IMPORTS =
  "import type { TaskInfo } from '../packages/protocol/src/task/task.types';\nimport type { SessionInfo } from '../packages/protocol/src/session/session.types';\nimport type { NodeInfo } from '../packages/protocol/src/node/node.types';\nimport type { NodeRecord } from '../packages/runtime/src/nodes/nodes.types';\nimport { escapedLine, escapeTags } from './text';\n";

const project = typedProject({
  name: 'no-unescaped-model-text',
  rule: RULE,
  include: ['src', 'packages'],
  options: { module: 'esnext', moduleResolution: 'bundler' },
  files: {
    'packages/protocol/src/task/task.types.ts':
      "export type TaskInfo = {\n  id: string;\n  command: string;\n  description: string;\n  status: 'running' | 'completed' | 'failed';\n  error?: string;\n  output: string;\n};\n",
    'packages/protocol/src/session/session.types.ts':
      'export type SessionInfo = { id: string; title: string; status?: string };\n',
    'packages/protocol/src/node/node.types.ts':
      "export type NodeInfo = { id: string; title: string; state: 'running' | 'completed' };\n",
    'packages/runtime/src/nodes/nodes.types.ts':
      "export type NodeRecord = { id: string; title: string; status?: string; state: 'running' | 'completed' };\n",
    'src/text.ts':
      'export const escapedLine = (text: string): string => text;\nexport const escapeTags = (text: string): string => text;\n',
  },
});
const findingsIn = (params) => project.lint(params);

const body = (code) =>
  `${IMPORTS}export function use(task: TaskInfo, session: SessionInfo, node: NodeInfo, record: NodeRecord, other: { title: string; command: string }, input: { title: string }): string {\n${code}\n}\n`;

afterAll(project.remove);

describe('no-unescaped-model-text: what it allows', () => {
  it('lets a field be printed through the escaping helpers', async () => {
    expect(
      await findingsIn({
        file: 'src/escaped.ts',
        code: body(
          'return `[task ${task.id}] $ ${escapedLine(task.command)}\\n${escapeTags(task.output)} ${escapedLine(session.title)}`;',
        ),
      }),
    ).toEqual([]);
  });

  it('lets an enum the harness chose be printed as it is', async () => {
    expect(
      await findingsIn({
        file: 'src/enum.ts',
        code: body('return `${task.status} ${node.state}`;'),
      }),
    ).toEqual([]);
  });

  it('lets text that is not the protocol types’ be printed: a tool’s own input, a local shape', async () => {
    expect(
      await findingsIn({
        file: 'src/own.ts',
        code: body('return `${input.title} ${other.title} ${other.command}`;'),
      }),
    ).toEqual([]);
  });

  it('lets the guard side of && be written: it decides, and prints only when it is falsy', async () => {
    expect(
      await findingsIn({
        file: 'src/guard.ts',
        code: body(
          'return `${task.error && escapedLine(task.error)}` + (session.title && escapeTags(session.title));',
        ),
      }),
    ).toEqual([]);
  });

  it('lets an array of escaped fields be filtered and joined', async () => {
    expect(
      await findingsIn({
        file: 'src/join.ts',
        code: body(
          "return [escapedLine(task.command), task.error === undefined ? undefined : escapedLine(task.error)].filter(Boolean).join('\\n');",
        ),
      }),
    ).toEqual([]);
  });

  it('lets a joined array go through an escaper whole, as the task-finished notice does', async () => {
    expect(
      await findingsIn({
        file: 'src/joined-escaped.ts',
        code: body("return escapeTags([task.error, task.output].filter(Boolean).join('\\n'));"),
      }),
    ).toEqual([]);
  });

  it('lets an id and a body field not on the list be printed', async () => {
    expect(
      await findingsIn({
        file: 'src/ids.ts',
        code: body('return `${task.id} ${session.id} ${task.output}`;'),
      }),
    ).toEqual([]);
  });
});

describe('no-unescaped-model-text: acceptance', () => {
  it.each([
    ['a task’s command', 'return `$ ${task.command}`;'],
    ['a task’s description', 'return `${task.description}`;'],
    ['a task’s error', 'return `failed: ${task.error}`;'],
    ['a session’s title', 'return `Sent to "${session.title}"`;'],
    ['a session’s status, which may be absent', 'return `[status] ${session.status}`;'],
    ['a node’s title', 'return `${node.title}`;'],
    ['a field read through an optional chain', 'return `${session?.status}`;'],
    ['a field joined with +', "return '$ ' + task.command;"],
    ['a field on the right of +', "return task.command + ' done';"],
    // The form of the message_agent bug this rule is the guardrail for.
    ['a field with a fallback after ??', 'return `Sent to "${session?.title ?? task.id}"`;'],
    ['a field with a fallback before ??', "return `${session.status ?? ''}`;"],
    ['a field after ||', "return `${'x' || task.command}`;"],
    ['a field in one branch of a conditional', "return `${task.id ? task.error : ''}`;"],
    ['a field behind a non-null assertion', 'return `${session.status!}`;'],
    ['a field behind a type assertion', 'return `${task.command as string}`;'],
    ['a field appended with +=', "let text = '$ ';\ntext += task.command;\nreturn text;"],
    ['a field in an array joined', "return [task.command, 'x'].join('\\n');"],
    ['a field behind satisfies', 'return `${task.command satisfies string}`;'],
    ['a field on the right of &&', 'return `${task.id && task.command}`;'],
    [
      'a field in an array filtered before it is joined',
      "return [escapedLine(task.id), task.command].filter(Boolean).join('\\n');",
    ],
    ['a runtime node record’s title', 'return `${record.title}`;'],
    ['a runtime node record’s status', 'return `${record.status}`;'],
  ])('refuses %s printed as it is', async (_name, code) => {
    expect(await findingsIn({ file: 'src/bad.ts', code: body(code) })).toEqual([RULE]);
  });

  it('reports each unescaped field of one template', async () => {
    expect(
      await findingsIn({
        file: 'src/two.ts',
        code: body('return `${task.command} ${session.title}`;'),
      }),
    ).toEqual([RULE, RULE]);
  });
});

describe('no-unescaped-model-text: bypasses it does not see', () => {
  // Named so a reader knows what review and the hostile-title tests carry: the rule reads the
  // expression that is printed, and a call that is not an escaper hides a field from it.
  it.each([
    [
      'a field assigned to a variable first',
      'const command = task.command;\nreturn `$ ${command}`;',
    ],
    ['a field destructured first', 'const { command } = task;\nreturn `$ ${command}`;'],
    ['a field through String()', 'return `$ ${String(task.command)}`;'],
    ['a field through trim()', 'return `$ ${task.command.trim()}`;'],
    ['a field through concat()', "return ''.concat(task.command);"],
    ['a field read by a computed key', "return `$ ${task['command']}`;"],
    [
      'a field in an array mapped before it is joined',
      "return [task].map((entry) => entry.command).join('\\n');",
    ],
  ])('does not see %s', async (_name, code) => {
    expect(await findingsIn({ file: 'src/bypass.ts', code: body(code) })).toEqual([]);
  });
});
