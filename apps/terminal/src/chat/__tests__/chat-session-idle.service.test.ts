import { describe, expect, it } from 'vitest';
import type { MessageId } from '@sheavly/protocol/message/message.types';
import type { PromptSent } from '@sheavly/protocol/node-command/node-command.types';
import type { ChatItem } from '../../client/transcript.types.js';
import type { ChatSession } from '../chat-session.service.js';
import { messageIdOf } from '../testing/feed-items.fake.js';
import {
  fakeChatConversation,
  lineAnswer,
  recordingChat,
  settle,
} from '../testing/chat-session.fake.js';

/** The ids the fake conversation takes for the first and second line sent. */
const LINE_1 = messageIdOf(1);
const LINE_2 = messageIdOf(2);
/** A line another client sent. */
const OTHER = messageIdOf(900);

/** A conversation whose answers each wait until the test lets them go, as a slow backend's do. */
function slowBackend() {
  const waiting: PromiseWithResolvers<PromptSent>[] = [];
  const fake = fakeChatConversation({
    answer: () => {
      const answer = Promise.withResolvers<PromptSent>();

      waiting.push(answer);

      return answer.promise;
    },
  });

  return { fake, waiting };
}

/** A conversation that queues every line behind what runs, as a busy backend does. */
const queueing = () =>
  fakeChatConversation({
    answer: ({ text, messageId }) =>
      Promise.resolve(lineAnswer({ status: 'queued', messageId, queued: [text] })),
  });

/** Starts waiting for `session` to be idle; the answer is whether it has been, so far. */
function watchIdle(session: ChatSession): () => boolean {
  let idle = false;

  void session.idle().then(() => (idle = true));

  return () => idle;
}

describe('ChatSession.idle: every line the backend accepted is owed until its end', () => {
  it('waits for the run of a line the backend started at once, whose answer came first', async () => {
    const { session, items } = recordingChat();

    session.submit('hi');

    const idle = watchIdle(session);

    await settle();
    expect(idle()).toBe(false);

    session.hear(items.prompt({ messageId: LINE_1, text: 'hi' }));
    await settle();
    expect(idle()).toBe(false);

    session.hear(items.done());
    await settle();
    expect(idle()).toBe(true);
  });

  it('is idle when the run ended before the answer came: the notice was ahead of it', async () => {
    const { fake, waiting } = slowBackend();
    const { session, items } = recordingChat({ fake });

    session.submit('hi');
    await settle();

    const idle = watchIdle(session);

    session.hear(items.prompt({ messageId: LINE_1, text: 'hi' }));
    session.hear(items.done());
    waiting[0]?.resolve(lineAnswer({ status: 'started', messageId: LINE_1 }));
    await settle();

    expect(idle()).toBe(true);
  });

  it('is not idle while the line queued behind a run waits, and is once that line has run', async () => {
    const { session, items } = recordingChat({ fake: queueing() });

    session.hear(items.prompt({ messageId: OTHER, text: 'first' }));
    session.submit('second');
    await settle();

    const idle = watchIdle(session);

    session.hear(items.changed(['second']));
    session.hear(items.done());
    await settle();
    expect(idle()).toBe(false);

    session.hear(items.started({ text: 'second', messageId: LINE_1 }));
    session.hear(items.prompt({ messageId: LINE_1, text: 'second' }));
    session.hear(items.done());
    await settle();
    expect(idle()).toBe(true);
  });

  it('tells two identical lines queued at once apart by their ids: each is paid by its own run', async () => {
    const { session, items } = recordingChat({ fake: queueing() });

    session.submit('same');
    session.submit('same');
    await settle();

    const idle = watchIdle(session);

    session.hear(items.prompt({ messageId: LINE_1, text: 'same' }));
    session.hear(items.done());
    await settle();
    expect(idle()).toBe(false);

    session.hear(items.prompt({ messageId: LINE_2, text: 'same' }));
    session.hear(items.done());
    await settle();
    expect(idle()).toBe(true);
  });

  it('does not take another line’s run for its own', async () => {
    const { session, items } = recordingChat({ fake: queueing() });

    session.submit('mine');
    await settle();

    const idle = watchIdle(session);

    session.hear(items.prompt({ messageId: OTHER, text: 'someone else’s' }));
    session.hear(items.done());
    await settle();

    expect(idle()).toBe(false);
  });

  describe.each([
    {
      name: 'a refusal',
      notice: (items: ReturnType<typeof recordingChat>['items'], id: MessageId): ChatItem =>
        items.refused({ text: '/nope', error: 'No skill /nope', messageId: id }),
    },
    {
      name: 'an edit of the queue that dropped it',
      notice: (items: ReturnType<typeof recordingChat>['items'], id: MessageId): ChatItem =>
        items.changed([], [id]),
    },
  ])('a line paid by $name', ({ notice }) => {
    it.each([
      ['answer', 'notice'],
      ['notice', 'answer'],
    ])('is idle once it came, whether the %s or the %s was heard first', async (first) => {
      const { fake, waiting } = slowBackend();
      const { session, items } = recordingChat({ fake });

      session.submit('later');
      await settle();

      const idle = watchIdle(session);
      const answer = () => waiting[0]?.resolve(lineAnswer({ status: 'queued', messageId: LINE_1 }));
      const pay = () => session.hear(notice(items, LINE_1));

      if (first === 'answer') {
        answer();
        await settle();
        expect(idle()).toBe(false);
        pay();
      } else {
        pay();
        answer();
      }

      await settle();
      expect(idle()).toBe(true);
    });
  });

  it('is not paid by a wake run: its message is an earlier prompt’s, which it did not answer', async () => {
    const { session, items } = recordingChat({ fake: queueing() });

    session.submit('later');
    await settle();

    const idle = watchIdle(session);

    session.hear(items.wake(LINE_1));
    session.hear(items.done());
    await settle();
    expect(idle()).toBe(false);

    session.hear(items.prompt({ messageId: LINE_1, text: 'later' }));
    session.hear(items.done());
    await settle();
    expect(idle()).toBe(true);
  });

  it('is idle after a stop: the stopped run’s done pays its line', async () => {
    const { session, items } = recordingChat();

    session.submit('long job');
    await settle();

    const idle = watchIdle(session);

    session.hear(items.prompt({ messageId: LINE_1, text: 'long job' }));
    session.stop();
    session.hear(items.done('interrupted'));
    await settle();

    expect(idle()).toBe(true);
  });

  it('is idle once the feed is lost: nothing the backend owes can arrive', async () => {
    const { session } = recordingChat({ fake: queueing() });

    session.submit('later');
    await settle();

    const idle = watchIdle(session);

    await settle();
    expect(idle()).toBe(false);

    session.lostFeed(new Error('gone'));
    await settle();
    expect(idle()).toBe(true);
  });

  it('is idle at once when no line was sent and no run goes', async () => {
    const { session } = recordingChat();

    await session.idle();
  });

  it('waits for the run going, whoever started it', async () => {
    const { session, items } = recordingChat();

    session.hear(items.wake(OTHER));
    session.submit('/help');
    await settle();
    await expect(Promise.race([session.idle().then(() => 'idle'), settle()])).resolves.not.toBe(
      'idle',
    );

    session.hear(items.done());
    await session.idle();
  });
});
