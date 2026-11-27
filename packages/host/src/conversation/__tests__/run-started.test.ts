import { describe, expect, it } from 'vitest';
import { streamAgent } from '@sheavly/loop/stream-agent/stream-agent.helper';
import { conversationId } from '@sheavly/runtime/testing/stored-conversation.fake';
import { routedProvider, say } from '@sheavly/testing/provider/routed-provider.fake';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import { createHarness } from '../../host/host.helper.js';
import { startGatedWork } from '../../testing/gated-work.fake.js';
import { mainChannelOf, outlineOf, runsOf } from '../../testing/main-channel.fake.js';
import { createConversation } from '../conversation.helper.js';
import type { ConversationOptions } from '../conversation.types.js';

/**
 * A conversation whose model answers the prompt `build`, then one wake, with finite work that runs
 * until `finish` is resolved: its end wakes the idle conversation. With a `store`, its node
 * channels are kept there. `ended.runs` counts the runs of the main agent that have ended.
 */
function conversationWithWake(
  params: {
    store?: MemoryConversationStore;
    caps?: Pick<ConversationOptions, 'maxConsecutiveWakes' | 'onWakeCapped'>;
  } = {},
) {
  const { store, caps } = params;
  const harness = createHarness({
    title: 'Build',
    provider: routedProvider({ build: [say('Waiting for the build.'), say('The build passed.')] }),
    ...(store && {
      channels: { log: (channel) => store.channel({ id: conversationId, channel }) },
    }),
  });
  const ended = { runs: 0 };

  harness.sessions.subscribeEntries((entry) => {
    if (entry.kind === 'event' && entry.event.type === 'done') ended.runs += 1;
  });
  const finish = startGatedWork(harness);
  const conversation = createConversation({ harness, run: streamAgent, tools: [], ...caps });

  return { harness, conversation, finish, ended };
}

/** Runs the prompt `build` to its end. */
async function runPrompt(conversation: ReturnType<typeof createConversation>) {
  for await (const _event of conversation.send('build'));
}

describe('where a wake starts on the main agent’s channel', () => {
  it('is written with the message the wake goes on from and no text, before the woken run’s events', async () => {
    const store = new MemoryConversationStore();
    const { harness, conversation, finish, ended } = conversationWithWake({ store });

    try {
      await runPrompt(conversation);

      const prompted = harness.sessions.messageOf(harness.mainSession.id);

      finish.resolve(undefined);
      await until(() => ended.runs === 2);

      const entries = await mainChannelOf({ store, id: conversationId, harness });
      const wake = entries.find((entry) => entry.type === 'run_started' && entry.cause === 'wake');

      const { before, runs } = runsOf(entries);

      // The conversation says only the wake's run starts itself: a prompt's start is the host's to
      // say. The run's own events all come after its start, and end with its done.
      expect(before.at(-1)).toBe('event:done');
      expect(runs.map((run) => run.start)).toEqual(['run_started:wake']);
      expect(runs[0]?.events.at(-1)).toBe('event:done');
      expect(runs[0]?.events.filter((line) => line === 'event:done')).toHaveLength(1);
      expect(prompted).toBeDefined();
      expect(wake).toMatchObject({ messageId: prompted });
      expect(wake).not.toHaveProperty('text');
    } finally {
      finish.resolve(undefined);
      await conversation.close();
    }
  });

  it('is not written for a wake that is refused: it never moves the run', async () => {
    const store = new MemoryConversationStore();
    const capped: number[] = [];
    const { harness, conversation, finish } = conversationWithWake({
      store,
      caps: { maxConsecutiveWakes: 0, onWakeCapped: (limit) => capped.push(limit) },
    });

    try {
      await runPrompt(conversation);
      finish.resolve(undefined);
      await until(() => capped.length === 1);

      const lines = outlineOf(await mainChannelOf({ store, id: conversationId, harness }));

      expect(lines.filter((line) => line.startsWith('run_started'))).toEqual([]);
      expect(lines.filter((line) => line === 'event:done')).toHaveLength(1);
      expect(conversation.running).toBe(false);
    } finally {
      finish.resolve(undefined);
      await conversation.close();
    }
  });

  it('is not written, and breaks nothing, in a conversation that keeps no channels', async () => {
    const { harness, conversation, finish, ended } = conversationWithWake();

    try {
      await runPrompt(conversation);
      finish.resolve(undefined);
      await until(() => ended.runs === 2);

      expect(harness.nodeChannels).toBeUndefined();
      expect(conversation.running).toBe(false);
    } finally {
      finish.resolve(undefined);
      await conversation.close();
    }
  });
});
