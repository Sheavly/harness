import { afterAll, describe, expect, it } from 'vitest';
import { typedProject } from '../testing/typed-project.fake.js';

// `no-direct-task-start` is type-aware, so it lints real files of a temp project that holds a
// `TaskRegistry` in `tasks/tasks.service.ts`, like the runtime's.
const RULE = 'harness/no-direct-task-start';
const IMPORTS =
  "import { TaskRegistry } from './tasks/tasks.service';\nimport { Other } from './other';\n";

const project = typedProject({
  name: 'no-direct-task-start',
  rule: RULE,
  include: ['src', 'packages', 'vendor'],
  options: { module: 'esnext', moduleResolution: 'bundler' },
  files: {
    'src/override.ts':
      "import { TaskRegistry } from './tasks/tasks.service';\nexport class Loud extends TaskRegistry {\n  override start(input: { command: string }): string {\n    return input.command;\n  }\n}\nexport class Deeper extends Loud {}\n",
    'src/tasks/tasks.service.ts':
      'export class TaskRegistry {\n  start(input: { command: string }): string {\n    return input.command;\n  }\n\n  list(): string[] {\n    return [];\n  }\n\n  readonly nodes = { open: (): number => 1 };\n}\n',
    'src/other.ts': 'export class Other {\n  start(): number {\n    return 1;\n  }\n}\n',
    'src/sub.ts':
      "import { TaskRegistry } from './tasks/tasks.service';\nexport class Sub extends TaskRegistry {}\n",
  },
});
const findingsIn = (params) => project.lint(params);

const body = (code) =>
  `${IMPORTS}export function use(tasks: TaskRegistry, other: Other, key: string): unknown {\n${code}\n}\n`;

/** `startWork` as the runtime writes it, importing the registry from `file`'s place. */
function starterCodeFor(file) {
  const up = '../'.repeat(file.split('/').length - 1);

  return `import { TaskRegistry } from '${up}src/tasks/tasks.service';\nexport function startWork(tasks: TaskRegistry): string {\n  return tasks.start({ command: 'x' });\n}\n`;
}

const STARTER_CODE = starterCodeFor('src/tasks/work.utils.ts');

afterAll(project.remove);

describe('no-direct-task-start: what it allows', () => {
  it('lets a registry be read, and another class start', async () => {
    expect(
      await findingsIn({
        file: 'src/valid.ts',
        code: body('return [tasks.list(), other.start()];'),
      }),
    ).toEqual([]);
  });

  it('lets a registry’s nodes be read: they are the node registry’s, and not start', async () => {
    expect(
      await findingsIn({
        file: 'src/nodes.ts',
        code: body('const { nodes } = tasks;\nreturn [nodes, tasks.nodes.open()];'),
      }),
    ).toEqual([]);
  });

  it("lets the work.utils.ts beside the registry's tasks.service.ts start work", async () => {
    expect(
      await findingsIn({
        file: 'src/tasks/work.utils.ts',
        code: STARTER_CODE,
      }),
    ).toEqual([]);
  });

  it.each([
    'packages/tools/src/tasks/work.utils.ts',
    'src/work.utils.ts',
    'vendor/packages/runtime/src/tasks/work.utils.ts',
  ])('refuses a work.utils.ts with no registry beside it: %s', async (file) => {
    expect(await findingsIn({ file, code: starterCodeFor(file) })).toEqual([RULE]);
  });
});

describe('no-direct-task-start: acceptance', () => {
  it('refuses a call on a registry, whatever it is named', async () => {
    expect(
      await findingsIn({
        file: 'src/call.ts',
        code: body("return tasks.start({ command: 'x' });"),
      }),
    ).toEqual([RULE]);
  });

  it.each([
    ['a subclass that overrides start', 'Loud', 'sub.start({ command: "x" })'],
    ['a class below an overriding one', 'Deeper', 'sub.start({ command: "x" })'],
  ])('refuses %s', async (name, type, call) => {
    expect(
      await findingsIn({
        file: `src/override-${type}.ts`,
        code: `import { ${type} } from './override';\nexport function use(sub: ${type}): string {\n  return ${call};\n}\n`,
      }),
    ).toEqual([RULE]);
  });

  it('refuses a registry reached through a subclass', async () => {
    expect(
      await findingsIn({
        file: 'src/subclass.ts',
        code: "import { Sub } from './sub';\nexport function use(sub: Sub): string {\n  return sub.start({ command: 'x' });\n}\n",
      }),
    ).toEqual([RULE]);
  });
});

describe('no-direct-task-start: bypasses', () => {
  it.each([
    ['an alias', 'const run = tasks.start;\nreturn run;'],
    ['destructuring', 'const { start } = tasks;\nreturn start;'],
    ['a renamed destructuring', 'const { start: begin } = tasks;\nreturn begin;'],
    ['a quoted destructuring key', "const { 'start': begin } = tasks;\nreturn begin;"],
    ['a rest element', 'const { ...rest } = tasks;\nreturn rest;'],
    ['a string key', "return tasks['start']({ command: 'x' });"],
    ['a computed literal key', "const name = 'start';\nreturn tasks[name]?.({ command: 'x' });"],
    ['a key from a variable', 'return tasks[key as keyof TaskRegistry];'],
    ['call', "return tasks.start.call(tasks, { command: 'x' });"],
    ['apply', "return tasks.start.apply(tasks, [{ command: 'x' }]);"],
    ['the prototype', "return TaskRegistry.prototype.start.call(tasks, { command: 'x' });"],
    ['a registry held in a variable', "const held = tasks;\nreturn held.start({ command: 'x' });"],
  ])('refuses %s', async (name, code) => {
    const findings = await findingsIn({
      file: `src/bypass-${name.replaceAll(' ', '-')}.ts`,
      code: body(code),
    });

    expect(findings).toContain(RULE);
  });

  it.each([
    ['an optional chain', 'maybe?.start({ command: "x" })'],
    ['a non-null assertion', 'maybe!.start({ command: "x" })'],
    ['a generic constrained to the registry', 'generic.start({ command: "x" })'],
    ['a union with another class', 'either.start({ command: "x" })'],
    ['an intersection', 'both.start({ command: "x" })'],
    ['a Pick of the registry', 'picked.start({ command: "x" })'],
  ])('refuses %s', async (name, call) => {
    const findings = await findingsIn({
      file: `src/shape-${name.replaceAll(' ', '-')}.ts`,
      code: `${IMPORTS}export function use<T extends TaskRegistry>(\n  maybe: TaskRegistry | undefined,\n  generic: T,\n  either: TaskRegistry | Other,\n  both: TaskRegistry & { extra: number },\n  picked: Pick<TaskRegistry, 'start'>,\n): unknown {\n  return ${call};\n}\n`,
    });

    expect(findings).toContain(RULE);
  });

  it('does not see a registry assigned to a structural type (left to review)', async () => {
    expect(
      await findingsIn({
        file: 'src/structural.ts',
        code: `${IMPORTS}export function use(tasks: TaskRegistry): string {\n  const starter: { start(input: { command: string }): string } = tasks;\n\n  return starter.start({ command: 'x' });\n}\n`,
      }),
    ).toEqual([]);
  });

  it('does not see a registry cast to another shape (left to review and no-unsafe-*)', async () => {
    expect(
      await findingsIn({
        file: 'src/cast.ts',
        code: body('return (tasks as unknown as Record<string, unknown>)[key];'),
      }),
    ).toEqual([]);
  });

  it('refuses a dynamic import of the registry', async () => {
    expect(
      await findingsIn({
        file: 'src/dynamic.ts',
        code: "export async function use(): Promise<string> {\n  const { TaskRegistry } = await import('./tasks/tasks.service');\n  return new TaskRegistry().start({ command: 'x' });\n}\n",
      }),
    ).toEqual([RULE]);
  });

  it('refuses a re-exported registry', async () => {
    project.write(
      'src/reexport.ts',
      "export { TaskRegistry as Registry } from './tasks/tasks.service';\n",
    );

    expect(
      await findingsIn({
        file: 'src/reexported.ts',
        code: "import { Registry } from './reexport';\nexport function use(tasks: Registry): string {\n  return tasks.start({ command: 'x' });\n}\n",
      }),
    ).toEqual([RULE]);
  });
});
