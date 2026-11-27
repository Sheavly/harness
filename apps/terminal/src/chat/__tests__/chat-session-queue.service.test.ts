import { describe, expect, it } from 'vitest';
import { statusOfRun } from '../../tui/screen-chat.helper.js';
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

/** A conversation that queues every line behind what runs, as a busy backend does. */
const queueing = () =>
  fakeChatConversation({
    answer: ({ text, messageId }) =>
      Promise.resolve(lineAnswer({ status: 'queued', messageId, queued: [text] })),
  });

describe('ChatSession: the queue shown is the backend’s', () => {
  it('shows the lines its notices say wait, and none of what was typed until then', async () => {
    const { session, queues, items } = recordingChat({ fake: queueing() });

    session.hear(items.prompt({ messageId: FIRST, text: 'first' }));
    session.submit('second');
    await settle();
    expect(queues).toEqual([]);

    session.hear(items.changed(['second']));
    expect(session.queued).toEqual(['second']);

    hearAll({
      session,
      items: [
        items.done(),
        items.started({ text: 'second', messageId: SECOND }),
        items.prompt({ messageId: SECOND, text: 'second' }),
      ],
    });
    expect(session.queued).toEqual([]);
    expect(queues.at(-1)).toEqual([]);
  });

  it('takes the queue from a line that starts, one that is refused and one that changes it', () => {
    const { session, queues, items } = recordingChat();

    hearAll({
      session,
      items: [
        items.changed(['a', 'b', 'c']),
        items.started({ text: 'a', messageId: FIRST, queued: ['b', 'c'] }),
        items.refused({ text: 'b', error: 'no', messageId: SECOND, queued: ['c'] }),
      ],
    });

    expect(queues).toEqual([['a', 'b', 'c'], ['b', 'c'], ['c']]);
    expect(session.queued).toEqual(['c']);
  });

  it('prints a refusal as the line and why, escaped, in the order it is heard', () => {
    const { session, output, items } = recordingChat();

    session.hear(items.refused({ text: 'x\u001b[2J', error: 'bad\u0007', messageId: FIRST }));

    expect(output()).toBe('✗ x\\u001b[2J: bad\\u0007\n');
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

describe('ChatSession: run state', () => {
  it('tells the UI each run_state of the main agent, in order', () => {
    const { session, runStates, items } = recordingChat();

    hearAll({
      session,
      items: [
        items.prompt({ messageId: FIRST, text: 'go' }),
        items.runState('waiting', 2),
        items.runState('waiting', 0),
        items.runState('working', 0),
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
  it('tells the UI each change of the main agent’s thinking once', () => {
    const { session, thinking, items } = recordingChat();

    hearAll({
      session,
      items: [items.thinking(true), items.thinking(true), items.thinking(false)],
    });

    expect(thinking).toEqual([true, false]);
  });

  it('clears thinking when the feed is lost while the model was thinking', () => {
    const { session, thinking, items } = recordingChat();

    hearAll({
      session,
      items: [items.prompt({ messageId: FIRST, text: 'go' }), items.thinking(true)],
    });
    session.lostFeed(new Error('gone'));

    expect(thinking).toEqual([true, false]);
  });

  it('tells the UI when a call starts and when it returns, and nothing in between', () => {
    const { session, tools, items } = recordingChat();

    hearAll({
      session,
      items: [items.toolStarted('1', 'Build'), items.text('hi'), items.toolResult('1', 'Build')],
    });

    expect(tools).toEqual([['Build'], []]);
  });

  it('clears the running tools when the run ends before the call returned', () => {
    const { session, tools, items } = recordingChat();

    hearAll({
      session,
      items: [
        items.prompt({ messageId: FIRST, text: 'go' }),
        items.toolStarted('1', 'Build'),
        items.done('failed'),
      ],
    });

    expect(tools).toEqual([['Build'], []]);
  });

  it('clears the running tool of a result too large to store, which never comes as a result', () => {
    const { session, tools, output, items } = recordingChat();

    hearAll({
      session,
      items: [
        items.toolStarted('1', 'Build'),
        items.omitted({ eventType: 'tool_result', call: '1' }),
      ],
    });

    expect(tools).toEqual([['Build'], []]);
    expect(output()).toContain('the result of run_command was too large to store');
  });
});
