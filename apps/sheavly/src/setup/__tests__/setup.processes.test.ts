import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startEmbeddedServer } from '@sheavly/backend/run-server/embedded-server.helper';
import { createClient } from '@sheavly/client/client/client.helper';
import { serverNameHash } from '@sheavly/storage/server-runtime/server-runtime.helper';
import { runTerminalSetup } from '@sheavly/terminal/setup/run-setup.helper';
import { findChatServer } from '../../chat/find-server.helper.js';
import { useFinderScenarios } from '../../testing/finder-scenarios.fake.js';
import { answerSetupByTitle } from '../../testing/setup-answers.fake.js';
import { createSetupCommand } from '../setup.helper.js';
import type { StartPrivateServer } from '../setup.types.js';

// No input: a chat with no terminal reads its end at once, so one prompt runs and the chat ends.
const scenarios = useFinderScenarios();
const { cli } = scenarios;
const KEY = 'sk-test-key-that-setup-must-never-print-0123456789';
const NEW = ['new', 'terminal-settings'];

/** The environment of the child processes, which the in-process setup reads the same way. */
function childEnv(): NodeJS.ProcessEnv {
  const { home, xdg, project, base } = cli.folders();

  // PATH and HOME for a server that starts in this process, as the child servers get them.
  return {
    PATH: process.env.PATH,
    HOME: base,
    SHEAVLY_HOME: home,
    XDG_RUNTIME_DIR: xdg,
    WORKSPACE_ROOT: project,
  };
}

/** A server start for a test that must not start one: a failure of the test, not of the command. */
const STARTS_NONE: StartPrivateServer = () =>
  Promise.reject(new Error('this test expects setup to start no server'));

/**
 * `sheavly setup` run in this process, on the server the finder finds, answered by `ui`, with
 * `extraEnv` added to the environment. `startServer` is the real embedded server for a test of a
 * first run, and starts none otherwise.
 */
async function setUp(
  ui: ReturnType<typeof answerSetupByTitle>['ui'],
  extraEnv: NodeJS.ProcessEnv = {},
  startServer: StartPrivateServer = STARTS_NONE,
) {
  const out: string[] = [];
  const reportFailure = vi.fn();
  const command = createSetupCommand({
    runSetup: (params) => runTerminalSetup({ ...params, ui }),
    findServer: findChatServer,
    startServer,
    interactive: true,
    reportFailure,
    streams: { out: (text) => out.push(text), err: (text) => out.push(text) },
  });

  await command.run({ args: [], env: { ...childEnv(), ...extraEnv } });

  return { out: out.join(''), reportFailure };
}

/** What is left in the runtime folder of the test's home: a server's lock and file. */
async function runtimeLeftovers(): Promise<string[]> {
  const { home, xdg } = cli.folders();

  return readdir(path.join(xdg, 'sheavly', await serverNameHash({ home })));
}

/** What a first setup answers: a new profile, a custom model at `baseUrl`, and the key. */
function firstSetup(baseUrl: string) {
  let edits = 0;

  return answerSetupByTitle({
    text: {
      'Model name or identifier': 'fake-model',
      // The address is not asked on the first pass (it has a default), so it is set by editing.
      baseUrl,
      'API key': KEY,
    },
    choices: {
      'Choose a profile for this workspace': 'new',
      'Choose a model': 'new',
      'What model do you want to add?': 'custom',
      'How do you want to host': 'openai',
      'fake-model ·': () => (edits++ === 0 ? 'edit' : 'start'),
    },
  });
}

/**
 * A first setup, then a check that the model's address is the test's own endpoint, before any
 * prompt is sent: a model left on its default address would send the key to the real provider.
 */
async function setUpFirst(params: {
  server: { url: string };
  model: { baseUrl: string };
  extraEnv?: NodeJS.ProcessEnv;
}) {
  const answers = firstSetup(params.model.baseUrl);
  const done = await setUp(answers.ui, params.extraEnv);
  const { profiles } = await createClient({
    url: params.server.url,
    token: cli.folders().token,
  }).call('getSetup', {});

  expect(profiles[0]?.models[0]?.definition.baseUrl).toBe(params.model.baseUrl);

  return { ...done, answers };
}

/** The files under the home that hold `text`, as paths from the home. */
async function filesHolding(text: string): Promise<string[]> {
  const { home } = cli.folders();
  const entries = await readdir(home, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const holding = await Promise.all(
    files.map(async ({ parentPath, name }) => {
      const file = path.join(parentPath, name);

      return (await readFile(file, 'utf8')).includes(text) ? path.relative(home, file) : undefined;
    }),
  );

  return holding.filter((file) => file !== undefined);
}

describe.skipIf(process.platform === 'win32')('sheavly setup, on a real server', () => {
  it('sets up a profile and model on a fresh home, then chat sends a prompt and gets its reply', async () => {
    const server = await cli.start({}, ['serve']);
    const model = await scenarios.fakeModel();
    const { out, reportFailure } = await setUpFirst({ server, model });

    expect(reportFailure).not.toHaveBeenCalled();
    expect(out).toContain('Run `sheavly chat`');

    const chat = await cli.startAndWaitForExit({}, ['chat', 'say', 'hello']);
    const result = { exit: await chat.exited, out: chat.stdout(), err: chat.stderr() };

    expect(result.exit.code).toBe(0);
    expect(result.out).toContain(model.reply);
    expect(model.listener.everything()).toContain('say hello');
    // The key reached the model's host, which is what it is for, and nothing else.
    expect(model.listener.everything()).toContain(KEY);
    expect((await fetch(new URL('/health', server.url))).ok).toBe(true);
  }, 120_000);

  it('asks for the key as a secret and never prints it, in any output of setup, chat or the server', async () => {
    const server = await cli.start({}, ['serve']);
    const model = await scenarios.fakeModel();
    const { out, answers } = await setUpFirst({ server, model });
    const chat = await cli.startAndWaitForExit({}, ['chat', 'say', 'hello']);

    await chat.exited;
    // The prompt went to the test's own endpoint, not to a real provider.
    expect(model.listener.everything()).toContain('say hello');
    // On disk the key is in one file, the credential store's, which sits directly in the profile's
    // folder: not in the profile, the model's settings, the config or a conversation.
    const holding = await filesHolding(KEY);

    expect(holding).toHaveLength(1);
    expect(holding[0]).toMatch(/^profiles\/[^/]+\/[^/]+$/);
    expect(holding[0]).not.toMatch(/profile\.json$/);

    const everyOutput = [
      out,
      answers.notices.join('\n'),
      answers.asked.map(({ title }) => title).join('\n'),
      chat.stdout(),
      chat.stderr(),
      server.stdout(),
      server.stderr(),
    ].join('\n');

    expect(answers.asked.filter(({ secret }) => secret).map(({ title }) => title)).toEqual([
      'API key',
    ]);
    expect(everyOutput).not.toContain(KEY);
    expect(everyOutput).not.toContain(cli.folders().token);
  }, 120_000);

  it('sends nothing to the address BACKEND_URL names, and sets up the server it found', async () => {
    const server = await cli.start({}, ['serve']);
    const model = await scenarios.fakeModel();
    const named = await scenarios.listeners.start(() => ({ status: 404 }));

    await setUpFirst({
      server,
      model,
      extraEnv: { BACKEND_URL: named.url, BACKEND_TOKEN: 'a-token-that-must-not-be-sent' },
    });

    // The profile exists on the verified server (setUpFirst read it back), and the address the
    // environment named saw no request at all: not the token, not the key.
    expect(named.requests()).toEqual([]);
  }, 120_000);

  it('keeps the existing profile and model when it is run again, unless the user adds one', async () => {
    const server = await cli.start({}, ['serve']);
    const model = await scenarios.fakeModel();

    await setUpFirst({ server, model });

    const client = createClient({ url: server.url, token: cli.folders().token });
    const before = await client.call('getSetup', {});
    const [existing] = before.profiles;
    const again = answerSetupByTitle({
      choices: {
        // The profile and the model that exist, not a new one: nothing asks for a key or an address.
        'Choose a profile for this workspace': (items) =>
          items.find(({ value }) => !NEW.includes(value))?.value ?? 'missing',
        'Choose a model': (items) => items.find(({ value }) => value !== 'new')?.value ?? 'missing',
        'fake-model ·': 'start',
      },
    });

    await setUp(again.ui);

    const after = await client.call('getSetup', {});

    expect(before.profiles).toHaveLength(1);
    expect(after.profiles).toEqual(before.profiles);
    expect(after.profiles[0]?.models).toHaveLength(1);
    expect(after.profiles[0]?.models[0]?.credential).toBe('set');
    expect(existing?.ready).toBe(true);
    expect(again.asked.filter(({ secret }) => secret)).toEqual([]);
  }, 120_000);
});

describe.skipIf(process.platform === 'win32')('the sheavly setup command line', () => {
  it('with no server exits 1, says how to start one, and starts and creates nothing', async () => {
    const made = await cli.startAndWaitForExit({}, ['setup']);
    const exit = await made.exited;

    expect(exit.code).toBe(1);
    expect(made.stderr()).toContain('No running Sheavly server was found');
    expect(made.stderr()).toContain('Start one with `sheavly serve`');
    expect(made.stdout()).toBe('');
    await scenarios.expectNothingCreated();
  }, 60_000);

  it('with a server but no terminal exits 1 and says it needs one, naming itself', async () => {
    await cli.start({}, ['serve']);

    const made = await cli.startAndWaitForExit({}, ['setup']);
    const exit = await made.exited;

    expect(exit.code).toBe(1);
    expect(made.stderr()).toBe(
      'Setup needs an interactive terminal. Run `sheavly setup` (or `sheavly chat --setup`) in a terminal first.\n',
    );
    expect(made.stdout()).toBe('');
  }, 90_000);

  it('refuses an argument with the usage exit code', async () => {
    const made = await cli.startAndWaitForExit({}, ['setup', '--profile', 'x']);
    const exit = await made.exited;

    expect(exit.code).toBe(2);
    expect(made.stderr()).toContain('"sheavly setup" takes no arguments');
  }, 60_000);
});

describe.skipIf(process.platform === 'win32')('sheavly setup with no server running', () => {
  it('sets up a profile on a clean home on a server of its own, and leaves no server, lock or file behind', async () => {
    const model = await scenarios.fakeModel();
    const answers = firstSetup(model.baseUrl);
    const { out, reportFailure } = await setUp(answers.ui, {}, startEmbeddedServer);

    expect(reportFailure).not.toHaveBeenCalled();
    // The server is gone, so the line says a chat needs one that stays.
    expect(out).toContain('`sheavly serve`');
    expect(await runtimeLeftovers()).toEqual([]);

    // The lock is free and the setup was saved: a server started now on the same home takes the
    // lock, and has the profile, the model and the key.
    const server = await cli.start({}, ['serve']);
    const { profiles } = await createClient({
      url: server.url,
      token: cli.folders().token,
    }).call('getSetup', {});

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.ready).toBe(true);
    expect(profiles[0]?.models[0]?.definition.baseUrl).toBe(model.baseUrl);
    expect(profiles[0]?.models[0]?.credential).toBe('set');
    // The key was asked as a secret, is in the credential store alone, and in no output.
    expect(answers.asked.filter(({ secret }) => secret).map(({ title }) => title)).toEqual([
      'API key',
    ]);
    expect(await filesHolding(KEY)).toHaveLength(1);
    expect([out, answers.notices.join('\n')].join('\n')).not.toContain(KEY);
  }, 120_000);

  it('sends nothing to the address BACKEND_URL names: the key goes only to the server it started', async () => {
    const model = await scenarios.fakeModel();
    const named = await scenarios.listeners.start(() => ({ status: 404 }));
    const { reportFailure } = await setUp(
      firstSetup(model.baseUrl).ui,
      { BACKEND_URL: named.url, BACKEND_TOKEN: 'a-token-that-must-not-be-sent' },
      startEmbeddedServer,
    );

    expect(reportFailure).not.toHaveBeenCalled();
    expect(named.requests()).toEqual([]);
  }, 120_000);

  it('stops the server it started when the wizard is cancelled, and leaves no lock or file', async () => {
    const answers = firstSetup('http://127.0.0.1:9/v1');
    const cancelling = {
      ...answers.ui,
      choose: () => Promise.reject(new Error('Setup cancelled.')),
    };
    const { out, reportFailure } = await setUp(cancelling, {}, startEmbeddedServer);

    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(out).toBe('');
    expect(await runtimeLeftovers()).toEqual([]);

    // Nothing holds the home: a server starts on it at once.
    const server = await cli.start({}, ['serve']);

    expect((await fetch(new URL('/health', server.url))).ok).toBe(true);
  }, 120_000);

  it('lets a setup that starts while another runs its wizard use that one’s server, and start none of its own', async () => {
    const model = await scenarios.fakeModel();
    const gate = Promise.withResolvers<undefined>();
    const first = firstSetup(model.baseUrl);
    // The first wizard waits at its first question until the second has run.
    const gated = {
      ...first.ui,
      choose: async (question: Parameters<typeof first.ui.choose>[0]) => {
        await gate.promise;

        return first.ui.choose(question);
      },
    };
    let asked = 0;
    const counting: StartPrivateServer = (params) => {
      asked += 1;

      return startEmbeddedServer(params);
    };
    const one = setUp(gated, {}, counting);

    try {
      // Once the first has published its file, a second setup finds and verifies that server.
      await vi.waitFor(async () => expect(await runtimeLeftovers()).toContain('server.json'), {
        timeout: 60_000,
      });

      const cancelsAtOnce = {
        ...answerSetupByTitle({}).ui,
        choose: () => Promise.reject(new Error('second setup reached its first question')),
      };
      const two = await setUp(cancelsAtOnce, {}, counting);

      // It got as far as asking, on the first's server, and was asked to start none.
      expect(two.reportFailure).toHaveBeenCalledTimes(1);
      expect((two.reportFailure.mock.calls[0] as [Error])[0].message).toBe(
        'second setup reached its first question',
      );
      expect(asked).toBe(1);
    } finally {
      gate.resolve(undefined);
    }

    const done = await one;

    expect(done.reportFailure).not.toHaveBeenCalled();
    expect(await runtimeLeftovers()).toEqual([]);
  }, 120_000);
});
