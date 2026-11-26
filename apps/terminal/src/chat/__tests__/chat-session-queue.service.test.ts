import { describe, expect, it } from 'vitest';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import { queuedAnswer } from '../testing/prompt-answers.fake.js';
import { statusOfRun } from '../../tui/screen-chat.helper.js';
import {
  backendStream,
  fakeChatConversation,
  hearAll,
  recordingChat,
  settle,
} from '../testing/chat-session.fake.js';

const CHILD = sessionIdSchema.parse('child');

/** A conversation that queues every line behind what runs, as a busy backend does. */
const queueing = () =>
  fakeChatConversation({ answer: (text) => Promise.resolve(queuedAnswer([text])) });

describe('ChatSession: the queue shown is the backend’s', () => {
  it('shows the lines its queue entries say wait, and none of what was typed until then', async () => {
    const stream = backendStream();
    const { session, queues } = recordingChat({ fake: queueing() });

    session.hear(stream.started('first'));
    session.submit('second');
    await settle();
    expect(queues).toEqual([[]]);

    session.hear(stream.changed(['second']));
    expect(session.queued).toEqual(['second']);

    hearAll({ session, entries: [stream.done(), stream.started('second')] });
    expect(session.queued).toEqual([]);
    expect(queues.at(-1)).toEqual([]);
  });

  it('shows restored lines as waiting and sends none of them by itself', async () => {
    const { session, fake, queues } = recordingChat();

    session.restoreQueued(['left over', 'also left']);
    await session.idle();

    expect(session.queued).toEqual(['left over', 'also left']);
    expect(queues.at(-1)).toEqual(['left over', 'also left']);
    expect(fake.submitted).toEqual([]);
  });

  it('drops the backend’s queue once, however many times the user leaves', async () => {
    const { session, fake } = recordingChat();

    await Promise.all([session.dropQueued(), session.dropQueued()]);

    expect(fake.queuesSet).toEqual([[]]);
  });
});

describe('ChatSession: idle', () => {
  it('is idle only once every line the backend accepted has run', async () => {
    const stream = backendStream();
    const { session } = recordingChat({ fake: queueing() });
    let idle = false;

    session.hear(stream.started('first'));
    session.submit('second');
    void session.idle().then(() => (idle = true));
    hearAll({ session, entries: [stream.changed(['second']), stream.done()] });
    await settle();
    // The first run ended, but the backend still owes the line queued behind it.
    expect(idle).toBe(false);

    hearAll({ session, entries: [stream.resumed(), stream.started('second'), stream.done()] });
    await settle();
    expect(idle).toBe(true);
  });

  it('is idle once a line the backend started at once has run, even if its answer came first', async () => {
    const stream = backendStream();
    const { session } = recordingChat();
    let idle = false;

    session.submit('hi');
    void session.idle().then(() => (idle = true));
    await settle();
    // Answered `started`, but its run has not been heard yet.
    expect(idle).toBe(false);

    hearAll({ session, entries: [stream.started('hi'), stream.done()] });
    await settle();
    expect(idle).toBe(true);
  });

  it('is idle once the lines it sent were taken out of the queue, as /exit does', async () => {
    const stream = backendStream();
    const { session } = recordingChat({ fake: queueing() });

    session.hear(stream.started('first'));
    session.submit('second');
    await settle();
    // The queue emptied by a client (this chat leaving, or another UI): no line is owed any more.
    hearAll({ session, entries: [stream.changed(['second']), stream.changed([]), stream.done()] });

    await session.idle();
  });

  it('is idle once a queued line the backend refused is gone', async () => {
    const stream = backendStream();
    const { session } = recordingChat({ fake: queueing() });

    session.hear(stream.started('first'));
    session.submit('/nope');
    await settle();
    hearAll({ session, entries: [stream.done(), stream.refused('/nope', 'No skill /nope')] });

    await session.idle();
  });
});

describe('ChatSession: run state', () => {
  it('tells the UI each run_state of the main session, in order, and none of a sub-agent', () => {
    const stream = backendStream();
    const { session, runStates } = recordingChat();

    hearAll({
      session,
      entries: [
        stream.started('go'),
        stream.runState('waiting', 2),
        stream.runState('waiting', 1, CHILD),
        stream.runState('waiting', 0),
        stream.runState('working', 0),
      ],
    });

    expect(runStates).toEqual([
      { state: 'waiting', groupedTasks: 2 },
      { state: 'waiting', groupedTasks: 0 },
      { state: 'working', groupedTasks: 0 },
    ]);
  });

  it('shows working, awaiting grouped tasks, or ready when none are grouped', () => {
    expect(statusOfRun({ state: 'working', groupedTasks: 0 })).toEqual({ state: 'working' });
    expect(statusOfRun({ state: 'waiting', groupedTasks: 2 })).toEqual({
      state: 'awaiting_tasks',
      awaitedTasks: 2,
      thinking: false,
    });
    expect(statusOfRun({ state: 'waiting', groupedTasks: 0 })).toEqual({
      state: 'ready',
      thinking: false,
    });
  });
});

describe('ChatSession: thinking and tools', () => {
  it('tells the UI each change of the main session’s thinking once, and none of a sub-agent’s', () => {
    const stream = backendStream();
    const { session, thinking } = recordingChat();

    hearAll({
      session,
      entries: [
        stream.thinking(true, CHILD),
        stream.thinking(true),
        stream.thinking(true),
        stream.thinking(false),
      ],
    });

    expect(thinking).toEqual([true, false]);
  });

  it('clears thinking when the stream is lost while the model was thinking', () => {
    const stream = backendStream();
    const { session, thinking } = recordingChat();

    hearAll({ session, entries: [stream.started('go'), stream.thinking(true)] });
    session.lostStream(new Error('gone'));

    expect(thinking).toEqual([true, false]);
  });

  const call = { id: callIdSchema.parse('1'), name: 'run_command', input: {} };

  it('tells the UI when a call starts and when it returns, and nothing in between', () => {
    const stream = backendStream();
    const { session, tools } = recordingChat();

    hearAll({
      session,
      entries: [
        stream.event({ seq: 0, type: 'tool_call_started', call, description: 'Build' }),
        stream.text('hi'),
        stream.event({
          seq: 0,
          type: 'tool_result',
          call,
          description: 'Build',
          message: { role: 'tool', toolCallId: call.id, content: 'ok', isError: false },
          durationMs: 1,
        }),
      ],
    });

    expect(tools).toEqual([['Build'], []]);
  });

  it('clears the running tools when the run ends before the call returned', () => {
    const stream = backendStream();
    const { session, tools } = recordingChat();

    hearAll({
      session,
      entries: [
        stream.started('go'),
        stream.event({ seq: 0, type: 'tool_call_started', call, description: 'Build' }),
        stream.done('failed'),
      ],
    });

    expect(tools).toEqual([['Build'], []]);
  });
});
