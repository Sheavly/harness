import { describe, expect, it, vi } from 'vitest';
import { NoServerError, ServerNotRunningError, UsageError } from '../../errors/cli.errors.js';
import { createSetupCommand } from '../setup.helper.js';
import type { StartPrivateServer } from '../setup.types.js';

const SERVER = { url: 'http://127.0.0.1:4310', token: 'a-token' };
const NOT_RUNNING = new ServerNotRunningError('No running Sheavly server was found.');
const MISMATCH = new NoServerError('The server speaks protocol 5.0.0; update this client.');

type Started = Awaited<ReturnType<StartPrivateServer>>;

/**
 * The command on fakes, with the order of what happened recorded: `find` answers each lookup in
 * turn (the last one again after that), `start` is what starting a server answers.
 */
function setup(
  params: {
    finds?: (() => Promise<typeof SERVER>)[];
    start?: Started;
    fails?: Error;
    closeFails?: Error;
    interactive?: boolean;
    warns?: string;
  } = {},
) {
  const events: string[] = [];
  const finds = params.finds ?? [() => Promise.resolve(SERVER)];
  let lookups = 0;
  const close = vi.fn(() => {
    events.push('closed');

    return params.closeFails === undefined ? Promise.resolve() : Promise.reject(params.closeFails);
  });
  const runSetup = vi.fn(() => {
    events.push('setup');

    return params.fails === undefined ? Promise.resolve() : Promise.reject(params.fails);
  });
  const findServer = vi.fn(() => {
    events.push('lookup');

    const find = finds[Math.min(lookups, finds.length - 1)];

    lookups += 1;

    return find ? find() : Promise.reject(new Error('no lookup scripted'));
  });
  const startServer = vi.fn<StartPrivateServer>(({ log }) => {
    events.push('start');

    if (params.warns) log(params.warns);

    return Promise.resolve(params.start ?? { status: 'started', url: SERVER.url, close });
  });
  const reportFailure = vi.fn<(caughtError: unknown) => void>();
  const out: string[] = [];
  const command = createSetupCommand({
    runSetup,
    findServer,
    startServer,
    interactive: params.interactive ?? true,
    reportFailure,
    streams: { out: (text) => out.push(text), err: () => undefined },
  });

  return { command, runSetup, findServer, startServer, reportFailure, close, events, out };
}

/** The command built from `scene` (see `setup`) and run once with no argument. */
async function ran(scene: Parameters<typeof setup>[0]) {
  const made = setup(scene);

  await made.command.run({ args: [], env: {} });

  return made;
}

/** The message of the one failure reported, which must be a `NoServerError`. */
function reportedMessage(reportFailure: ReturnType<typeof setup>['reportFailure']): string {
  const [failure] = reportFailure.mock.calls[0] ?? [];

  expect(failure).toBeInstanceOf(NoServerError);

  return failure instanceof Error ? failure.message : '';
}

describe('the setup command', () => {
  it('runs the terminal setup on the server it found, starts nothing and says what to run next', async () => {
    const { command, runSetup, findServer, startServer, close, reportFailure, out } = setup();
    const env = { WORKSPACE_ROOT: '/work' };

    await command.run({ args: [], env });

    expect(findServer).toHaveBeenCalledWith(env);
    expect(runSetup).toHaveBeenCalledWith({ env, server: SERVER });
    expect(startServer).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(out.join('')).toContain('Run `sheavly chat`');
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('ignores BACKEND_URL, unlike chat: a key goes only to a server the finder verified', async () => {
    const { command, runSetup, findServer } = setup();
    const env = { BACKEND_URL: 'http://127.0.0.1:9', BACKEND_TOKEN: 't' };

    await command.run({ args: [], env });

    expect(findServer).toHaveBeenCalledWith(env);
    expect(runSetup).toHaveBeenCalledWith({ env, server: SERVER });
  });

  it('starts a server for itself when none runs at all, runs the wizard on the one the lookup then verifies, and stops it after', async () => {
    const { command, runSetup, startServer, events, out, reportFailure } = setup({
      finds: [() => Promise.reject(NOT_RUNNING), () => Promise.resolve(SERVER)],
    });

    await command.run({ args: [], env: {} });

    expect(startServer).toHaveBeenCalledTimes(1);
    // Looked for first, started, looked for again (the key goes only to what the lookup proved),
    // and closed only once the wizard ended.
    expect(events).toEqual(['lookup', 'start', 'lookup', 'setup', 'closed']);
    expect(runSetup).toHaveBeenCalledWith({ env: {}, server: SERVER });
    // The server is gone now, so the line says a chat needs one that stays.
    expect(out.join('')).toContain('`sheavly serve`');
    expect(out.join('')).toContain('`sheavly service install`');
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('stops the server it started when the wizard fails or is cancelled, and reports that', async () => {
    const cancelled = new Error('Setup cancelled.');
    const { command, close, reportFailure, events, out } = setup({
      finds: [() => Promise.reject(NOT_RUNNING), () => Promise.resolve(SERVER)],
      fails: cancelled,
    });

    await command.run({ args: [], env: {} });

    expect(events).toEqual(['lookup', 'start', 'lookup', 'setup', 'closed']);
    expect(close).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledWith(cancelled);
    expect(out).toEqual([]);
  });

  it.each([
    [
      'with no terminal to ask in, and reports why there is no server as before',
      { finds: [() => Promise.reject(NOT_RUNNING)], interactive: false },
      NOT_RUNNING,
    ],
    [
      'for a server it cannot use, such as one of another protocol',
      { finds: [() => Promise.reject(MISMATCH)] },
      MISMATCH,
    ],
  ])('starts nothing %s', async (_name, scene, failure) => {
    const { startServer, runSetup, reportFailure } = await ran(scene);

    expect(startServer).not.toHaveBeenCalled();
    expect(runSetup).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith(failure);
  });

  it('says another server holds the lock when it is refused, runs no setup and has nothing to stop', async () => {
    const { runSetup, close, reportFailure, out } = await ran({
      finds: [() => Promise.reject(NOT_RUNNING)],
      start: { status: 'refused', message: 'Another Sheavly server is already running, pid 42.' },
    });

    const message = reportedMessage(reportFailure);

    expect(message).toContain('Another Sheavly server is already running, pid 42.');
    expect(message).toContain('run `sheavly setup` again');
    expect(runSetup).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it('stops a server it started that the lookup cannot use, sends it nothing, and says what the server warned about', async () => {
    const unreadable = new ServerNotRunningError('No discovery file in /run/user/1000/sheavly/x.');
    const { runSetup, close, reportFailure } = await ran({
      finds: [() => Promise.reject(NOT_RUNNING), () => Promise.reject(unreadable)],
      warns:
        'The server lock could not be taken (path-too-long), so this server runs without one\n',
    });

    const message = reportedMessage(reportFailure);

    expect(message).toContain('sent nothing to it and stopped it');
    expect(message).toContain('No discovery file in /run/user/1000/sheavly/x.');
    expect(message).toContain('path-too-long');
    expect(runSetup).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not use a server the lookup finds at another address than the one it started, and stops its own', async () => {
    const other = { url: 'http://127.0.0.1:5555', token: 'another-servers-token' };
    const { runSetup, close, reportFailure } = await ran({
      finds: [() => Promise.reject(NOT_RUNNING), () => Promise.resolve(other)],
    });

    expect(reportedMessage(reportFailure)).toContain(
      'found another server than the one it started',
    );
    expect(runSetup).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('says it could not stop a server it found unusable, without losing why it was unusable', async () => {
    const unreadable = new ServerNotRunningError('No discovery file in /run/user/1000/sheavly/x.');
    const { reportFailure } = await ran({
      finds: [() => Promise.reject(NOT_RUNNING), () => Promise.reject(unreadable)],
      closeFails: new Error('a conversation would not close'),
    });
    const message = reportedMessage(reportFailure);

    expect(message).toContain('No discovery file in /run/user/1000/sheavly/x.');
    expect(message).toContain(
      'It could not stop that server cleanly: a conversation would not close',
    );
  });

  it('reports a server that will not stop after a saved setup as the failure it is, and prints no success line', async () => {
    const stuck = new Error('a conversation would not close');
    const { reportFailure, out } = await ran({
      finds: [() => Promise.reject(NOT_RUNNING), () => Promise.resolve(SERVER)],
      closeFails: stuck,
    });

    expect(reportFailure).toHaveBeenCalledWith(stuck);
    expect(out).toEqual([]);
  });

  it('keeps the wizard’s failure, which decides the exit code, when the server will not stop either', async () => {
    const cancelled = new Error('Setup cancelled.');
    const { reportFailure, close } = await ran({
      finds: [() => Promise.reject(NOT_RUNNING), () => Promise.resolve(SERVER)],
      fails: cancelled,
      closeFails: new Error('a conversation would not close'),
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledWith(cancelled);
  });

  it('refuses an argument as a usage error and asks nothing', async () => {
    const { command, runSetup, findServer, startServer } = setup();

    await expect(command.run({ args: ['--profile', 'x'], env: {} })).rejects.toThrow(UsageError);
    expect(findServer).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
    expect(runSetup).not.toHaveBeenCalled();
  });

  it('is listed as setup, and its help says the key is not echoed, when it starts a server, and its exit codes', () => {
    const { name, help: shown } = setup().command;
    // The help wraps at 100 columns: read it as one line, so a phrase may span a break.
    const help = shown.replaceAll(/\s+/g, ' ');

    expect(name).toBe('setup');
    expect(help).toContain('Usage: sheavly setup');
    expect(help).toContain('without echo');
    expect(help).toContain('starts one for itself');
    expect(help).toContain('stops it when it ends');
    expect(help).toContain('ignores BACKEND_URL');
    expect(help).toContain('0 when the setup was saved, 130 when it was cancelled');
    expect(help).toContain('except when the process is killed outright (SIGKILL)');
  });
});
