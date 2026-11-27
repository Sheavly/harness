import { describe, expect, it } from 'vitest';
import { RefusedError } from '@sheavly/client/errors/client.errors';
import { messageIdSchema } from '@sheavly/protocol/message/message.validator';
import { messageIdOf } from '../testing/feed-items.fake.js';
import {
  fakeChatConversation,
  hearAll,
  lineAnswer,
  recordingChat,
  settle,
} from '../testing/chat-session.fake.js';

const FIRST = messageIdOf(1);
const SECOND = messageIdOf(2);

describe('ChatSession: a prompt goes to the backend at once', () => {
  it('submits a prompt while a line of the user’s runs, and holds none of it locally', async () => {
    const { session, fake, items } = recordingChat();

    hearAll({
      session,
      items: [items.prompt({ messageId: FIRST, text: 'first' }), items.text('…')],
    });
    session.submit('second');
    await settle();

    expect(fake.submitted).toEqual(['second']);
    expect(session.queued).toEqual([]);
  });

  it('submits a prompt while a run the backend started itself goes', async () => {
    const { session, fake, items } = recordingChat();

    hearAll({ session, items: [items.wake(FIRST), items.text('The task finished.')] });
    session.submit('go');
    await settle();

    expect(fake.submitted).toEqual(['go']);
  });

  it('runs a command typed while a run goes at once, not after the run', async () => {
    const { session, told, output, items } = recordingChat();

    hearAll({
      session,
      items: [items.prompt({ messageId: FIRST, text: 'long job' }), items.text('working')],
    });
    session.submit('/help');
    await settle();

    expect(output()).toContain('Type a message and press Enter');
    expect(told).toEqual(['send long job', 'busy']);
  });

  it('prints a refused submit and goes on to the next line', async () => {
    const fake = fakeChatConversation({
      answer: ({ text, messageId }) =>
        text === 'bad'
          ? Promise.reject(
              new RefusedError({ status: 409, code: 'cannot_queue', message: 'The queue is full' }),
            )
          : Promise.resolve(lineAnswer({ status: 'started', messageId })),
    });
    const { session, output } = recordingChat({ fake });

    session.submit('bad');
    session.submit('good');
    await settle();

    expect(output()).toContain('✗ The queue is full');
    expect(fake.submitted).toEqual(['bad', 'good']);
  });

  it('prints a queued line the backend could not start, and goes on with the next', () => {
    const { session, told, output, items } = recordingChat();

    hearAll({
      session,
      items: [
        items.refused({
          text: '/nope x',
          error: 'No skill /nope',
          messageId: FIRST,
          queued: ['next'],
        }),
        items.started({ text: 'next', messageId: SECOND }),
        items.prompt({ messageId: SECOND, text: 'next' }),
      ],
    });

    expect(output()).toContain('✗ /nope x: No skill /nope');
    expect(told).toEqual(['send next', 'busy']);
  });
});

describe('ChatSession: a run, from the feed', () => {
  it('echoes a line only once the backend starts its run, from its run_started', async () => {
    const { session, told, items } = recordingChat();

    session.submit('hi');
    await settle();
    expect(told).toEqual([]);

    session.hear(items.prompt({ messageId: FIRST, text: 'hi' }));
    expect(told).toEqual(['send hi', 'busy']);
  });

  it('tells the end of a line once, after its output: the reply, then the turn, then ready', () => {
    const { session, told, output, items } = recordingChat();

    hearAll({
      session,
      items: [
        items.prompt({ messageId: FIRST, text: 'hi' }),
        items.text('the answer'),
        items.done(),
      ],
    });

    expect(output()).toContain('the answer');
    expect(told).toEqual(['send hi', 'busy', 'reply', 'end completed', 'ready']);
  });

  it.each(['interrupted', 'max_turns', 'max_tokens', 'failed'] as const)(
    'tells the UI a line ended %s, never as a completed reply',
    (reason) => {
      const { session, told, items } = recordingChat();

      hearAll({
        session,
        items: [
          items.prompt({ messageId: FIRST, text: 'hi' }),
          items.text('partial'),
          items.done(reason),
        ],
      });

      expect(told).toEqual(['send hi', 'busy', `end ${reason}`, 'ready']);
    },
  );

  it('rings no reply bell for a run the user stopped, even when it completed', () => {
    const { session, told, items } = recordingChat();

    session.hear(items.prompt({ messageId: FIRST, text: 'hi' }));
    session.stop();
    session.hear(items.done());

    expect(told).toEqual(['send hi', 'busy', 'end completed', 'ready']);
  });

  it('shows a run the backend started itself as busy, with no echo, turn end or reply', () => {
    const { session, told, output, items } = recordingChat();

    hearAll({
      session,
      items: [items.wake(FIRST), items.text('The task finished.'), items.done()],
    });

    expect(output()).toContain('The task finished.');
    expect(told).toEqual(['busy', 'ready']);
  });

  it('makes the line the backend starts right after its own run the user’s turn', () => {
    const { session, told, items } = recordingChat();

    hearAll({
      session,
      items: [
        items.wake(FIRST),
        items.done(),
        items.prompt({ messageId: SECOND, text: 'go' }),
        items.done(),
      ],
    });

    expect(told).toEqual(['busy', 'ready', 'send go', 'busy', 'reply', 'end completed', 'ready']);
  });

  it('ends a run whose done was lost as failed before the next run starts', () => {
    const { session, told, items } = recordingChat();

    hearAll({
      session,
      items: [
        items.prompt({ messageId: FIRST, text: 'one' }),
        items.text('partial'),
        items.prompt({ messageId: SECOND, text: 'two' }),
      ],
    });

    expect(told).toEqual(['send one', 'busy', 'end failed', 'ready', 'send two', 'busy']);
  });

  it('tells nothing for a done with no run going', () => {
    const { session, told, items } = recordingChat();

    session.hear(items.done());

    expect(told).toEqual([]);
  });

  it('ends the run going as failed when the live feed is lost, and says so', () => {
    const { session, told, output, items } = recordingChat();

    session.hear(items.prompt({ messageId: FIRST, text: 'hi' }));
    session.lostFeed(new Error('gone'));

    expect(output()).toContain('✗ lost the live feed: gone');
    expect(told).toEqual(['send hi', 'busy', 'end failed', 'ready']);
  });

  it('names the originating message of a failed main run, to find it in the error log', () => {
    const { session, output, items } = recordingChat();
    const id = messageIdSchema.parse('00000000-0000-4000-8000-0000000000aa');

    hearAll({
      session,
      items: [items.prompt({ messageId: FIRST, text: 'hi' }), items.failedRun('boom', id)],
    });

    expect(output()).toContain('boom');
    expect(output()).toContain(`message ${id}`);
  });
});

describe('ChatSession: Ctrl+C', () => {
  it('stops the run going, says stopping until it ends, then has nothing to stop', () => {
    const { session, fake, items } = recordingChat();

    session.hear(items.prompt({ messageId: FIRST, text: 'long job' }));

    expect(session.stop()).toBe('stopped');
    expect(session.stop()).toBe('stopping');
    expect(fake.stops()).toBe(1);

    session.hear(items.done('interrupted'));
    expect(session.stop()).toBe('idle');
  });

  it('stops a run the backend started itself', () => {
    const { session, fake, items } = recordingChat();

    session.hear(items.wake(FIRST));

    expect(session.stop()).toBe('stopped');
    expect(fake.stops()).toBe(1);
  });

  it('has nothing to stop when no run goes, and asks the backend nothing', () => {
    const { session, fake } = recordingChat();

    expect(session.stop()).toBe('idle');
    expect(fake.stops()).toBe(0);
  });

  it('leaves the lines waiting in the backend’s queue: they run after the stopped one', () => {
    const { session, fake, items } = recordingChat();

    hearAll({
      session,
      items: [items.prompt({ messageId: FIRST, text: 'long job' }), items.changed(['after'])],
    });
    session.stop();

    expect(fake.queuesSet).toEqual([]);
    expect(session.queued).toEqual(['after']);
  });
});
