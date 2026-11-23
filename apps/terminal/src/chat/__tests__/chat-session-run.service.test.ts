import { describe, expect, it } from 'vitest';
import { RefusedError } from '@sheavly/client/errors/client.errors';
import { callIdSchema, messageIdSchema } from '@sheavly/protocol/message/message.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import {
  MAIN_SESSION as MAIN,
  backendStream,
  fakeChatConversation,
  hearAll,
  recordingChat,
  settle,
} from '../testing/chat-session.fake.js';

describe('ChatSession: a prompt goes to the backend at once', () => {
  it('submits a prompt while a line of the user’s runs, and holds none of it locally', async () => {
    const stream = backendStream();
    const { session, fake } = recordingChat();

    hearAll({ session, entries: [stream.resumed(), stream.started('first'), stream.text('…')] });
    session.submit('second');
    await settle();

    expect(fake.submitted).toEqual(['second']);
    expect(session.queued).toEqual([]);
  });

  it('submits a prompt while a run the backend started itself goes', async () => {
    const stream = backendStream();
    const { session, fake } = recordingChat();

    hearAll({ session, entries: [stream.resumed(), stream.text('The task finished.')] });
    session.submit('go');
    await settle();

    expect(fake.submitted).toEqual(['go']);
  });

  it('runs a command typed while a run goes at once, not after the run', async () => {
    const stream = backendStream();
    const { session, told, output } = recordingChat();

    hearAll({ session, entries: [stream.started('long job'), stream.text('working')] });
    session.submit('/help');
    await settle();

    expect(output()).toContain('Type a message and press Enter');
    expect(told).toEqual(['send long job', 'busy']);
  });

  it('prints a refused submit and goes on to the next line', async () => {
    const fake = fakeChatConversation({
      answer: (text) =>
        text === 'bad'
          ? Promise.reject(
              new RefusedError({ status: 409, code: 'cannot_queue', message: 'The queue is full' }),
            )
          : Promise.resolve({ status: 'started', queued: [] }),
    });
    const { session, output } = recordingChat({ fake });

    session.submit('bad');
    session.submit('good');
    await settle();

    expect(output()).toContain('✗ The queue is full');
    expect(fake.submitted).toEqual(['bad', 'good']);
  });

  it('prints a queued line the backend could not start, and goes on with the next', () => {
    const stream = backendStream();
    const { session, told, output } = recordingChat();

    hearAll({
      session,
      entries: [stream.refused('/nope x', 'No skill /nope', ['next']), stream.started('next')],
    });

    expect(output()).toContain('✗ /nope x: No skill /nope');
    expect(told).toEqual(['send next', 'busy']);
  });
});

describe('ChatSession: a run, from the stream', () => {
  it('echoes a line only once the backend starts it, from its prompt_started', async () => {
    const stream = backendStream();
    const { session, told } = recordingChat();

    session.submit('hi');
    await settle();
    expect(told).toEqual([]);

    hearAll({ session, entries: [stream.resumed(), stream.started('hi')] });
    expect(told).toEqual(['busy', 'send hi']);
  });

  it('tells the end of a line once, after its output: the reply, then the turn, then ready', () => {
    const stream = backendStream();
    const { session, told, output } = recordingChat();

    hearAll({
      session,
      entries: [stream.resumed(), stream.started('hi'), stream.text('the answer'), stream.done()],
    });

    expect(output()).toContain('the answer');
    expect(told).toEqual(['busy', 'send hi', 'reply', 'end completed', 'ready']);
  });

  it.each(['interrupted', 'max_turns', 'max_tokens', 'failed'] as const)(
    'tells the UI a line ended %s, never as a completed reply',
    (reason) => {
      const stream = backendStream();
      const { session, told } = recordingChat();

      hearAll({
        session,
        entries: [stream.started('hi'), stream.text('partial'), stream.done(reason)],
      });

      expect(told).toEqual(['send hi', 'busy', `end ${reason}`, 'ready']);
    },
  );

  it('does not take a sub-agent’s done for the end of the run', () => {
    const child = sessionIdSchema.parse('child');
    const stream = backendStream();
    const { session, told } = recordingChat();
    const childDone: StreamEntry = {
      seq: 5,
      at: 0,
      sessionId: child,
      kind: 'event',
      event: {
        seq: 0,
        type: 'done',
        reason: 'completed',
        session: {
          id: child,
          rootId: MAIN,
          parentId: MAIN,
          depth: 2,
          startedByCall: callIdSchema.parse('start-child'),
        },
      },
    };

    hearAll({ session, entries: [stream.started('hi'), childDone] });

    expect(told).toEqual(['send hi', 'busy']);
  });

  it('rings no reply bell for a run the user stopped, even when it completed', () => {
    const stream = backendStream();
    const { session, told } = recordingChat();

    session.hear(stream.started('hi'));
    session.stop();
    session.hear(stream.done());

    expect(told).toEqual(['send hi', 'busy', 'end completed', 'ready']);
  });

  it('shows a run the backend started itself as busy, with no echo, turn end or reply', () => {
    const stream = backendStream();
    const { session, told, output } = recordingChat();

    hearAll({
      session,
      entries: [stream.resumed(), stream.text('The task finished.'), stream.done()],
    });

    expect(output()).toContain('The task finished.');
    expect(told).toEqual(['busy', 'ready']);
  });

  it('makes the line the backend starts right after its own run the user’s turn', () => {
    const stream = backendStream();
    const { session, told } = recordingChat();

    hearAll({
      session,
      entries: [
        stream.resumed(),
        stream.done(),
        stream.idled(),
        stream.resumed(),
        stream.started('go'),
        stream.done(),
      ],
    });

    expect(told).toEqual(['busy', 'ready', 'busy', 'send go', 'reply', 'end completed', 'ready']);
  });

  it('shows each entry once by seq, so a replay neither restarts nor ends a run', () => {
    const stream = backendStream();
    const { session, told, output } = recordingChat();
    const entries = [stream.started('hi'), stream.text('once'), stream.done()];

    hearAll({ session, entries: [...entries, ...entries] });

    expect(output().split('once')).toHaveLength(2);
    expect(told).toEqual(['send hi', 'busy', 'reply', 'end completed', 'ready']);
  });

  it('tells nothing for an idle update with no run going', () => {
    const { session, told } = recordingChat();

    session.hear(backendStream().idled());

    expect(told).toEqual([]);
  });

  it('ends the run going as failed when the live stream is lost, and says so', () => {
    const { session, told, output } = recordingChat();

    session.hear(backendStream().started('hi'));
    session.lostStream(new Error('gone'));

    expect(output()).toContain('✗ lost the live stream: gone');
    expect(told).toEqual(['send hi', 'busy', 'end failed', 'ready']);
  });

  it('names the originating message of a failed main run, to find it in the error log', () => {
    const stream = backendStream();
    const { session, output } = recordingChat();
    const id = messageIdSchema.parse('00000000-0000-4000-8000-0000000000aa');
    const started = stream.started('hi');
    const failed = stream.event({
      seq: 0,
      type: 'run_failed',
      error: 'boom',
      session: { id: MAIN, rootId: MAIN, depth: 1 },
    });

    hearAll({ session, entries: [started, { ...failed, messageId: id }] });

    expect(output()).toContain('boom');
    expect(output()).toContain(`message ${id}`);
  });
});

describe('ChatSession: Ctrl+C', () => {
  it('stops the run going, says stopping until it ends, then has nothing to stop', () => {
    const stream = backendStream();
    const { session, fake } = recordingChat();

    session.hear(stream.started('long job'));

    expect(session.stop()).toBe('stopped');
    expect(session.stop()).toBe('stopping');
    expect(fake.stops()).toBe(1);

    session.hear(stream.done('interrupted'));
    expect(session.stop()).toBe('idle');
  });

  it('stops a run the backend started itself', () => {
    const { session, fake } = recordingChat();

    session.hear(backendStream().resumed());

    expect(session.stop()).toBe('stopped');
    expect(fake.stops()).toBe(1);
  });

  it('has nothing to stop when no run goes, and asks the backend nothing', () => {
    const { session, fake } = recordingChat();

    expect(session.stop()).toBe('idle');
    expect(fake.stops()).toBe(0);
  });

  it('leaves the lines waiting in the backend’s queue: they run after the stopped one', () => {
    const stream = backendStream();
    const { session, fake } = recordingChat();

    hearAll({ session, entries: [stream.started('long job'), stream.changed(['after'])] });
    session.stop();

    expect(fake.queuesSet).toEqual([]);
    expect(session.queued).toEqual(['after']);
  });
});
