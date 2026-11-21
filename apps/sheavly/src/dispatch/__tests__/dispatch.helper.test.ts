import { describe, expect, it, vi } from 'vitest';
import type { CliCommand } from '../../command/command.types.js';
import { UsageError } from '../../errors/cli.errors.js';
import { dispatch } from '../dispatch.helper.js';

/** A command that records what it was run with; `fails` makes it throw that. */
function fakeCommand(name: string, fails?: unknown) {
  // Typed as an Error only for the linter: a command may throw any value, and one test does.
  const run = vi.fn(() =>
    fails === undefined ? Promise.resolve() : Promise.reject(fails as Error),
  );
  const command: CliCommand = { name, summary: `does ${name}`, help: `help of ${name}\n`, run };

  return { command, run };
}

function setup(params: { commands: CliCommand[]; env?: NodeJS.ProcessEnv; argv: string[] }) {
  const out: string[] = [];
  const err: string[] = [];
  const result = dispatch({
    argv: params.argv,
    env: params.env ?? {},
    commands: params.commands,
    streams: { out: (text) => out.push(text), err: (text) => err.push(text) },
    readVersion: () => Promise.resolve('1.2.3'),
  });

  return { result, out: () => out.join(''), err: () => err.join('') };
}

describe('dispatch', () => {
  it('prints the version for --version', async () => {
    const run = setup({ commands: [], argv: ['--version'] });

    expect(await run.result).toBe(0);
    expect(run.out()).toBe('1.2.3\n');
  });

  it('lists the commands it was given, sorted, and nothing else, for --help and -h', async () => {
    const serve = fakeCommand('serve');
    const chat = fakeCommand('chat');

    for (const flag of ['--help', '-h']) {
      const run = setup({ commands: [serve.command, chat.command], argv: [flag] });

      expect(await run.result).toBe(0);
      expect(run.out()).toContain('  chat   does chat\n  serve  does serve\n');
      expect(run.out()).not.toContain('update');
    }
  });

  it('answers `<command> --help` with that command’s help and does not run it', async () => {
    const serve = fakeCommand('serve');
    const run = setup({ commands: [serve.command], argv: ['serve', '--help'] });

    expect(await run.result).toBe(0);
    expect(run.out()).toBe('help of serve\n');
    expect(serve.run).not.toHaveBeenCalled();
  });

  it('answers --help or -h anywhere after the command, an option value before it included, without running it', async () => {
    for (const args of [
      ['--trust', '--help'],
      ['--trust', '-h'],
      ['--profile', 'p', '--help'],
      ['--resume', 'abc', '-h'],
      ['what', 'does', 'ls', '-h', 'print'],
    ]) {
      const chat = fakeCommand('chat');
      const run = setup({ commands: [chat.command], argv: ['chat', ...args] });

      expect(await run.result, args.join(' ')).toBe(0);
      expect(run.out()).toBe('help of chat\n');
      expect(chat.run).not.toHaveBeenCalled();
    }
  });

  it('runs the named command with the arguments after it and the environment', async () => {
    const serve = fakeCommand('serve');
    const env = { A: '1' };
    const run = setup({ commands: [serve.command], argv: ['serve', '--trust', 'x'], env });

    expect(await run.result).toBe(0);
    expect(serve.run).toHaveBeenCalledWith({ args: ['--trust', 'x'], env });
  });

  it('names an unknown command, points to --help and exits 2', async () => {
    const run = setup({ commands: [fakeCommand('serve').command], argv: ['nope'] });

    expect(await run.result).toBe(2);
    expect(run.err()).toBe('Unknown command "nope". Run "sheavly --help" to see the commands.\n');
    expect(run.out()).toBe('');
  });

  it('calls an unknown flag an option, and a missing command a mistake, both with exit 2', async () => {
    const flag = setup({ commands: [], argv: ['--nope'] });
    const missing = setup({ commands: [], argv: [] });

    expect(await flag.result).toBe(2);
    expect(flag.err()).toContain('Unknown option "--nope"');
    expect(await missing.result).toBe(2);
    expect(missing.err()).toContain('Missing command');
  });

  it('reports a command that throws as one line and exit 1, with no stack', async () => {
    const broken = fakeCommand('broken', new Error('the disk is gone'));
    const run = setup({ commands: [broken.command], argv: ['broken'] });

    expect(await run.result).toBe(1);
    expect(run.err()).toBe('sheavly: the disk is gone\n');
  });

  it('puts a message printed over several lines on one', async () => {
    const issues = '[\n  {\n    "path": ["SERVER_TOKEN"],\n    "message": "too short"\n  }\n]';
    const broken = fakeCommand('broken', new Error(issues));
    const run = setup({ commands: [broken.command], argv: ['broken'] });

    expect(await run.result).toBe(1);
    expect(run.err()).toBe('sheavly: [ { "path": ["SERVER_TOKEN"], "message": "too short" } ]\n');
  });

  it('prints the stack of that error only with SHEAVLY_DEBUG set', async () => {
    const broken = fakeCommand('broken', new Error('the disk is gone'));
    const run = setup({
      commands: [broken.command],
      argv: ['broken'],
      env: { SHEAVLY_DEBUG: '1' },
    });

    expect(await run.result).toBe(1);
    expect(run.err()).toContain('Error: the disk is gone\n    at ');
  });

  it('treats a thrown value that is not an error as text, and a usage error from a command as exit 2', async () => {
    const text = setup({ commands: [fakeCommand('a', 'plain').command], argv: ['a'] });
    const usage = setup({
      commands: [fakeCommand('b', new UsageError('--x needs a value')).command],
      argv: ['b'],
    });

    expect(await text.result).toBe(1);
    expect(text.err()).toBe('sheavly: plain\n');
    expect(await usage.result).toBe(2);
    expect(usage.err()).toBe('--x needs a value\n');
  });
});
