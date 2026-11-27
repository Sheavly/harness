import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { lineChatDetails } from '../testing/line-chat.fake.js';
import type { RemoteConversation } from '../../client/conversation.service.js';
import { Renderer } from '../../render/render.service.js';
import { SAME_KEYPRESS_MS } from '../../render/render.constants.js';
import { runLineChat } from '../line-chat.helper.js';

const mocks = vi.hoisted(() => ({ input: vi.fn(), session: vi.fn() }));

vi.mock('node:readline/promises', () => ({ createInterface: mocks.input }));
vi.mock('../chat-session.service.js', () => ({ ChatSession: mocks.session }));

const clock = useFixedClock();
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.clearAllMocks();
});

/** Real readline over private streams, with the session's pending work controlled by the test. */
function lineChat(firstPrompt?: string) {
  const source = new PassThrough();
  const output = new PassThrough();
  const input = createInterface({ input: source, output });
  const pending = Promise.withResolvers<undefined>();
  const conversation = {
    watchTranscript: vi.fn(async () => ({ ended: new Promise<void>(() => undefined) })),
  };
  const session = {
    submit: vi.fn<(line: string) => void>(),
    idle: vi.fn(() => pending.promise),
    finishInput: vi.fn(),
    stop: vi.fn<() => 'idle' | 'stopped' | 'stopping'>(() => 'idle'),
  };
  const write = vi.fn();
  const forceQuit = vi.fn(async () => undefined);
  const processExit = vi.fn<(code: number) => void>();
  let exit: () => void = () => undefined;

  mocks.input.mockReturnValue(input);
  mocks.session.mockImplementation(function (params: { onExit: () => void }) {
    exit = params.onExit;

    return session;
  });
  cleanups.push(() => {
    input.close();
    source.destroy();
    output.destroy();
    pending.resolve(undefined);
  });

  const running = runLineChat({
    conversation: conversation as unknown as RemoteConversation,
    details: lineChatDetails,
    renderer: new Renderer(() => undefined),
    write,
    firstPrompt,
    forceQuit,
    exit: processExit,
  });

  return {
    source,
    input,
    pending,
    session,
    write,
    forceQuit,
    processExit,
    running,
    exit: () => exit(),
  };
}

describe('runLineChat', () => {
  it.each([undefined, 'initial'])(
    'submits new lines while work is active (first prompt: %s)',
    async (firstPrompt) => {
      const chat = lineChat(firstPrompt);
      const first = firstPrompt ?? 'initial';

      if (!firstPrompt) chat.source.write(`${first}\n`);
      await vi.waitFor(() => expect(chat.session.submit).toHaveBeenCalledWith(first));
      chat.source.write('follow-up\n/model next\n');
      await vi.waitFor(() =>
        expect(chat.session.submit.mock.calls).toEqual([[first], ['follow-up'], ['/model next']]),
      );
      expect(chat.session.idle).not.toHaveBeenCalled();

      chat.source.end();
      await vi.waitFor(() => expect(chat.session.idle).toHaveBeenCalledOnce());
      chat.pending.resolve(undefined);
      await chat.running;
    },
  );

  it('waits for submitted work at EOF rather than returning when input closes', async () => {
    const chat = lineChat();
    let finished = false;

    void chat.running.then(() => {
      finished = true;
    });
    chat.source.end('one\ntwo\n');
    await vi.waitFor(() => expect(chat.session.idle).toHaveBeenCalledOnce());
    expect(chat.session.submit.mock.calls).toEqual([['one'], ['two']]);
    expect(finished).toBe(false);
    chat.pending.resolve(undefined);
    await chat.running;
    expect(finished).toBe(true);
  });

  it('closes a pending input read when a queued /exit eventually runs', async () => {
    const chat = lineChat('active');
    const closed = vi.fn();

    chat.input.on('close', closed);
    chat.source.write('/exit\n');
    await vi.waitFor(() => expect(chat.session.submit).toHaveBeenCalledWith('/exit'));
    // A queued command can execute after the helper has already begun waiting for another line.
    chat.exit();
    await vi.waitFor(() => expect(chat.session.idle).toHaveBeenCalledOnce());
    expect(closed).toHaveBeenCalledOnce();
    chat.source.write('ignored\n');
    chat.pending.resolve(undefined);
    await chat.running;
    expect(chat.session.submit.mock.calls).toEqual([['active'], ['/exit']]);
  });

  it('stops on Ctrl+C, ignores a duplicate keypress, then force-quits on a deliberate second press', async () => {
    const chat = lineChat('active');

    chat.session.stop.mockReturnValueOnce('stopped').mockReturnValue('stopping');
    chat.input.emit('SIGINT');
    chat.input.emit('SIGINT');
    expect(chat.session.stop).toHaveBeenCalledOnce();
    expect(chat.write).toHaveBeenCalledWith(expect.stringContaining('Stopping'));
    expect(chat.forceQuit).not.toHaveBeenCalled();

    clock.advance(SAME_KEYPRESS_MS);
    chat.input.emit('SIGINT');
    expect(chat.forceQuit).toHaveBeenCalledOnce();
    expect(chat.write).toHaveBeenCalledWith('\n✗ Forced exit.\n');
    // The cleanup runs first, and only then does the process exit.
    expect(chat.processExit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(chat.processExit).toHaveBeenCalledWith(130));
    chat.source.end();
    chat.pending.resolve(undefined);
    await chat.running;
  });

  it('quits and closes input on Ctrl+C while idle', async () => {
    const chat = lineChat();
    const closed = vi.fn();

    chat.input.on('close', closed);
    chat.input.emit('SIGINT');
    chat.pending.resolve(undefined);
    await chat.running;
    expect(closed).toHaveBeenCalledOnce();
    expect(chat.forceQuit).not.toHaveBeenCalled();
  });

  it('closes readline even when pending session work rejects', async () => {
    const chat = lineChat();
    const close = vi.spyOn(chat.input, 'close');
    const failure = new Error('session failed');
    const rejected = expect(chat.running).rejects.toBe(failure);

    chat.source.end();
    await vi.waitFor(() => expect(chat.session.idle).toHaveBeenCalledOnce());
    close.mockClear();
    chat.pending.reject(failure);
    await rejected;
    expect(close).toHaveBeenCalledOnce();
  });
});
