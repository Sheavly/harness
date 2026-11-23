import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { RecordingServer } from '@sheavly/backend/testing/recording-server.types';
import { setUpTestProfile } from '@sheavly/client/testing/test-profile.fake';
import { PROTOCOL_VERSION } from '@sheavly/protocol/version/protocol-version.constants';
import { PROTOCOL_MISMATCH_MESSAGES } from '@sheavly/protocol/version/version.constants';
import { useFinderScenarios } from '../../testing/finder-scenarios.fake.js';

// No input: a chat with no terminal reads its end at once, so one prompt runs and the chat ends.
const scenarios = useFinderScenarios();
const { cli, listeners } = scenarios;
const REPLY = 'pong from the fake model';

/** What `sheavly chat` ended with: its exit, and what it printed on each stream. */
async function chat(args: readonly string[] = []) {
  const made = await cli.startAndWaitForExit({}, ['chat', ...args]);

  return { exit: await made.exited, out: made.stdout(), err: made.stderr() };
}

/**
 * A model endpoint the test owns, on the OpenAI Responses route: every prompt is answered with
 * one line of streamed text, and the listener records what each prompt sent.
 */
async function fakeModel(): Promise<{ baseUrl: string; listener: RecordingServer }> {
  const stream = [
    { type: 'response.output_text.delta', delta: REPLY },
    { type: 'response.completed', response: {} },
  ];
  const listener = await listeners.start(() => ({
    status: 200,
    contentType: 'text/event-stream',
    body: stream.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  }));

  return { baseUrl: `${listener.url}/v1`, listener };
}

describe.skipIf(process.platform === 'win32')('sheavly chat finds the running server', () => {
  it('connects to the always-on server with no URL or token, and a prompt gets its reply', async () => {
    const server = await cli.start({}, ['serve']);
    const model = await fakeModel();

    await setUpTestProfile({
      backend: { url: server.url, token: cli.folders().token },
      definition: { model: 'fake', baseUrl: model.baseUrl },
    });

    const result = await chat(['say', 'hello']);

    expect(result.exit.code).toBe(0);
    expect(result.out).toContain(REPLY);
    expect(model.listener.everything()).toContain('say hello');
    expect(`${result.out}${result.err}`).not.toContain(cli.folders().token);
    // The chat only connected: the server it found is still running.
    expect((await fetch(new URL('/health', server.url))).ok).toBe(true);
  }, 90_000);

  it('with no server exits 1, says to run sheavly serve, and starts nothing', async () => {
    const result = await chat();

    expect(result.exit.code).toBe(1);
    expect(result.err).toContain('No running Sheavly server was found');
    expect(result.err).toContain('sheavly serve');
    expect(result.out).toBe('');
    expect(await readdir(cli.folders().xdg)).toEqual([]);
    expect(existsSync(cli.folders().home)).toBe(false);
  }, 60_000);

  it('treats the file a killed server left as no server, and contacts nothing', async () => {
    const server = await cli.start({}, ['serve']);

    await server.stop('SIGKILL');

    const result = await chat();

    expect(result.exit.code).toBe(1);
    expect(result.err).toContain('left over');
    expect(`${result.out}${result.err}`).not.toContain(cli.folders().token);
  }, 60_000);

  it('never contacts the address in a file whose lock is free', async () => {
    const listener = await scenarios.plantLeftOver();
    const result = await chat();

    expect(result.exit.code).toBe(1);
    expect(result.err).toContain('left over');
    expect(listener.requests()).toEqual([]);
  }, 60_000);

  it('stops before the token is sent when an impostor answers on the recorded address', async () => {
    const impostor = await scenarios.plantImpostor();
    const result = await chat();

    expect(result.exit.code).toBe(1);
    expect(result.err).toContain('nothing secret was sent');
    expect(`${result.out}${result.err}`).not.toContain(cli.folders().token);
    scenarios.expectNothingSecretSent(impostor);
  }, 60_000);

  it('says which side is older for a server of another protocol, and sends it no token', async () => {
    const other = '5.0.0';
    const server = await scenarios.plantOtherProtocol(other);
    const result = await chat();

    expect(result.exit.code).toBe(1);
    // This client is the older one: the server speaks a later major version.
    expect(result.err).toContain(
      PROTOCOL_MISMATCH_MESSAGES.clientOlder
        .replaceAll('{client}', PROTOCOL_VERSION)
        .replaceAll('{server}', other),
    );
    expect(`${result.out}${result.err}`).not.toContain(cli.folders().token);
    scenarios.expectNothingSecretSent(server);
  }, 60_000);
});
