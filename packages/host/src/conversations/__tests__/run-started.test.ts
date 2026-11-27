import { describe, expect, it } from 'vitest';
import { collect } from '@sheavly/testing/fetch/fake-fetch.fake';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import { say, scriptedConversations } from '../../testing/conversations.fake.js';
import { startGatedWork } from '../../testing/gated-work.fake.js';
import { mainChannelOf, runsOf } from '../../testing/main-channel.fake.js';

/**
 * The channel reads as one ordered log: no loop event comes ahead of the first `run_started`, and
 * each run (`starts`, in order) holds its own events and ends with its one `done`.
 */
function expectOrderedRuns(params: { entries: Parameters<typeof runsOf>[0]; starts: string[] }) {
  const { before, runs } = runsOf(params.entries);

  expect(before).toEqual([]);
  expect(runs.map((run) => run.start)).toEqual(params.starts);

  for (const run of runs) {
    expect(run.events.at(-1)).toBe('event:done');
    expect(run.events.filter((line) => line === 'event:done')).toHaveLength(1);
  }
}

/**
 * A kept conversation whose model answers each prompt in turn with `replies`; `ended.runs` counts
 * the runs of its main agent that have ended.
 */
async function keptConversation(replies: string[]) {
  const store = new MemoryConversationStore();
  const { conversations } = scriptedConversations({ store, replies: replies.map(say) });
  const id = await conversations.start();
  const { harness } = conversations.get(id);
  const ended = { runs: 0 };

  harness.sessions.subscribeEntries((entry) => {
    if (entry.kind === 'event' && entry.event.type === 'done') ended.runs += 1;
  });

  return { store, conversations, id, harness, ended };
}

describe('where a user’s prompt starts on the main agent’s channel', () => {
  it('is written for a prompt sent directly, with its text and the message it became, before the run’s events', async () => {
    const { store, conversations, id, harness } = await keptConversation(['one']);

    await collect((await conversations.send({ id, prompt: { text: 'first prompt' } })).events);

    const entries = await mainChannelOf({ store, id, harness });
    const started = entries.find((entry) => entry.type === 'run_started');

    expect(started).toMatchObject({
      type: 'run_started',
      cause: 'prompt',
      text: 'first prompt',
      messageId: harness.sessions.messageOf(harness.mainSession.id),
    });
    expectOrderedRuns({ entries, starts: ['run_started:prompt'] });
    expect(runsOf(entries).runs[0]?.events).toContain('event:text_delta');
  });

  it('is written for a prompt that starts at once through submit, with the message submit answered', async () => {
    const { store, conversations, id, harness, ended } = await keptConversation(['one']);
    const sent = await conversations.submit({ id, prompt: { text: 'start now' } });

    await until(() => ended.runs === 1);

    const entries = await mainChannelOf({ store, id, harness });

    expect(sent.status).toBe('started');
    expectOrderedRuns({ entries, starts: ['run_started:prompt'] });
    expect(entries.find((entry) => entry.type === 'run_started')).toMatchObject({
      text: 'start now',
      messageId: 'messageId' in sent ? sent.messageId : undefined,
    });
  });

  it('is written once for each prompt, a queued line included, each before its own run’s events', async () => {
    const { store, conversations, id, harness, ended } = await keptConversation(['one', 'two']);

    await conversations.submit({ id, prompt: { text: 'first' } });

    const second = await conversations.submit({ id, prompt: { text: 'second' } });

    await until(() => ended.runs === 2);

    const entries = await mainChannelOf({ store, id, harness });
    const starts = entries.filter((entry) => entry.type === 'run_started');

    expect(second.status).toBe('queued');
    expect(starts.map((entry) => ('text' in entry ? entry.text : undefined))).toEqual([
      'first',
      'second',
    ]);
    // The channel reads run_started, the run's events, done, and again for the next run.
    expectOrderedRuns({ entries, starts: ['run_started:prompt', 'run_started:prompt'] });
    // Each run answers its own user message.
    expect(new Set(starts.map((entry) => entry.messageId)).size).toBe(2);
  });
});

describe('where the run a conversation starts itself begins on the main agent’s channel', () => {
  it('reads run_started, events and done for the prompt, then again for the wake that delivers finished work', async () => {
    const { store, conversations, id, harness, ended } = await keptConversation([
      'one',
      'delivered',
    ]);
    const finish = startGatedWork(harness);

    await collect((await conversations.send({ id, prompt: { text: 'build it' } })).events);

    const prompted = harness.sessions.messageOf(harness.mainSession.id);

    finish.resolve(undefined);
    await until(() => ended.runs === 2);

    const entries = await mainChannelOf({ store, id, harness });
    const wake = entries.find((entry) => entry.type === 'run_started' && entry.cause === 'wake');

    expectOrderedRuns({ entries, starts: ['run_started:prompt', 'run_started:wake'] });
    expect(wake).toMatchObject({ messageId: prompted });
    expect(wake).not.toHaveProperty('text');
    // No gap: the entries are numbered one after another.
    expect(entries.map((entry) => entry.cursor)).toEqual(
      entries.map((_entry, index) => `s${String(index)}`),
    );
  });
});

describe('a conversation that keeps no channels', () => {
  it('runs its prompt as ever and writes no run start anywhere', async () => {
    const { conversations } = scriptedConversations({ replies: [say('one')] });
    const id = await conversations.start();
    const { harness } = conversations.get(id);
    const events = await collect(
      (await conversations.send({ id, prompt: { text: 'no store' } })).events,
    );

    expect(harness.nodeChannels).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'completed' });
  });
});
