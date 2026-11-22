import type { CliCommand, Streams } from '../command/command.types.js';
import { UsageError } from '../errors/cli.errors.js';
import { DEBUG_ENV, FAILURE_EXIT, USAGE_EXIT } from './dispatch.constants.js';
import { renderHelp } from './help.utils.js';

/** What the user is told for a failure, and the exit code that goes with it. */
function report(params: {
  caughtError: unknown;
  env: NodeJS.ProcessEnv;
  streams: Streams;
}): number {
  const { caughtError, env, streams } = params;

  if (caughtError instanceof UsageError) {
    streams.err(`${caughtError.message}\n`);

    return USAGE_EXIT;
  }

  const debugging = env[DEBUG_ENV] !== undefined && env[DEBUG_ENV] !== '';
  const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
  const stack = caughtError instanceof Error ? caughtError.stack : undefined;
  // One line, even for a message printed over several (a settings error lists its issues).
  const line = message.trim().replaceAll(/\s*\n\s*/g, ' ');

  streams.err(`sheavly: ${debugging && stack ? stack : line}\n`);

  return FAILURE_EXIT;
}

/**
 * Whether the arguments after a command ask for its help: `--help` or `-h` anywhere among them.
 * It errs towards help, which runs nothing: stopping at the first word would also stop at an
 * option's value (`chat --profile <id> --help`) and send `--help` to a paid model as a message,
 * and knowing which options take a value is each command's, not the dispatcher's.
 */
function asksForHelp(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

/** Finds what `first` asks for, or says what it is not. */
function findCommand(params: { first: string; commands: readonly CliCommand[] }): CliCommand {
  const { first, commands } = params;
  const found = commands.find(({ name }) => name === first);

  if (found) return found;

  const what = first.startsWith('-') ? 'option' : 'command';

  throw new UsageError(`Unknown ${what} "${first}". Run "sheavly --help" to see the commands.`);
}

/**
 * Runs one command line and returns its exit code: 0, 2 for what was typed wrong (an unknown or
 * missing command), 1 for a command that failed. Never throws and prints no stack unless
 * `SHEAVLY_DEBUG` is set. The commands, the streams, the environment and how the version is read
 * are passed in, so a test runs it with fakes. A command that keeps the process alive (a server)
 * resolves like any other: the caller must not exit when this returns 0.
 */
export async function dispatch(params: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  commands: readonly CliCommand[];
  streams: Streams;
  readVersion: () => Promise<string>;
}): Promise<number> {
  const { argv, env, commands, streams, readVersion } = params;
  const [first, ...rest] = argv;

  try {
    if (first === undefined) {
      throw new UsageError('Missing command. Run "sheavly --help" to see the commands.');
    }

    if (first === '--version') {
      streams.out(`${await readVersion()}\n`);

      return 0;
    }

    if (first === '--help' || first === '-h') {
      streams.out(renderHelp(commands));

      return 0;
    }

    const command = findCommand({ first, commands });

    if (asksForHelp(rest)) {
      streams.out(command.help);

      return 0;
    }

    await command.run({ args: rest, env });

    return 0;
  } catch (caughtError) {
    return report({ caughtError, env, streams });
  }
}
