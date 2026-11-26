import { describe, expect, it } from 'vitest';
import { agentEventSchema } from '@sheavly/protocol/event/event.validator';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import { usageChannelEntrySchema } from '@sheavly/protocol/usage/usage-channel.validator';
import { applyUsageEntry, emptyUsage } from '@sheavly/protocol/usage/usage.utils';
import { shapeOf } from '../../testing/stored-channels.fake.js';
import {
  reopenedUsageConversation,
  usageConversation,
  usageEntriesOf,
} from '../../testing/usage-conversation.fake.js';

const CALL = callIdSchema.parse('call_1');
const TOKENS = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadTokens: 600,
  cacheWriteTokens: 100,
};

let seq = 0;

/** Publishes the event `body` as `session`'s, parsed with the protocol's schema as the loop's is. */
function publish(params: {
  world: ReturnType<typeof usageConversation>;
  session: SessionId;
  body: object;
}) {
  seq += 1;
  params.world.sessions.publish({
    sessionId: params.session,
    event: agentEventSchema.parse({ seq, ...params.body }),
  });
}

const used = (extra: object = {}) => ({
  type: 'usage',
  usage: { tokens: TOKENS, estimatedCostUsd: 0.01, contextWindow: 200_000, ...extra },
});
const turnEnd = { type: 'turn_end', turn: 0, stopReason: 'end_turn' };

/** The usage channel's entries, parsed: what a client of the channel reads. */
async function entries(world: ReturnType<typeof usageConversation>) {
  return (await usageEntriesOf(world)).map((entry) => usageChannelEntrySchema.parse(entry));
}

describe('a conversation’s usage channel', () => {
  it('opens, then tells each node’s usage and the total as they now are, as each call is reported', async () => {
    const made = usageConversation();
    const main = made.nodeOf(made.main.id);

    publish({ world: made, session: made.main.id, body: used() });
    publish({ world: made, session: made.main.id, body: used({ estimatedCostUsd: 0.03 }) });

    const stored = await entries(made);

    expect(shapeOf(stored)).toEqual(['opened s0', 'node_usage s1', 'node_usage s2']);
    expect(stored[2]).toMatchObject({
      type: 'node_usage',
      usage: {
        node: main,
        calls: 2,
        inputTokens: 2_000,
        cacheReadTokens: 1_200,
        cacheWriteTokens: 200,
        estimatedCostUsd: 0.04,
        context: { used: 1_200, cached: 600, window: 200_000 },
      },
      total: { calls: 2, estimatedCostUsd: 0.04 },
    });
  });

  it('keeps a sub-agent’s usage on its own node and in the total', async () => {
    const made = usageConversation();
    const child = made.sessions.startChild({
      parentId: made.main.id,
      startedByCall: CALL,
      title: 'Reader',
    });

    publish({ world: made, session: made.main.id, body: used() });
    publish({ world: made, session: child.id, body: used({ estimatedCostUsd: 0.05 }) });

    const snapshot = await made.usage.snapshot();

    expect(snapshot.cursor).toBe('s2');
    expect('nodes' in snapshot && snapshot.nodes.map(({ node }) => node)).toEqual([
      made.nodeOf(made.main.id),
      made.nodeOf(child.id),
    ]);
    expect(snapshot.total.calls).toBe(2);
    expect(snapshot.total.estimatedCostUsd).toBeCloseTo(0.06, 10);
  });

  it('gives a snapshot that is what folding every entry from the start gives', async () => {
    const made = usageConversation();

    publish({ world: made, session: made.main.id, body: used() });
    publish({ world: made, session: made.main.id, body: turnEnd });
    publish({ world: made, session: made.main.id, body: used() });

    const folded = (await entries(made)).reduce(
      (usage, entry) => applyUsageEntry({ usage, entry }),
      emptyUsage(),
    );
    const snapshot = await made.usage.snapshot();

    expect('nodes' in snapshot && { total: snapshot.total, nodes: snapshot.nodes }).toEqual(folded);
  });

  it('marks a node and the total incomplete when a turn ends with no usage reported', async () => {
    const made = usageConversation();

    publish({ world: made, session: made.main.id, body: turnEnd });

    const stored = await entries(made);

    expect(shapeOf(stored)).toEqual(['opened s0', 'node_usage s1']);
    expect(stored[1]).toMatchObject({
      usage: { node: made.nodeOf(made.main.id), calls: 0, incomplete: true },
      total: { incomplete: true },
    });
  });

  it('tells nothing for an event that is not usage or a turn’s end', async () => {
    const made = usageConversation();

    publish({ world: made, session: made.main.id, body: { type: 'text_delta', text: 'hi' } });
    publish({ world: made, session: made.main.id, body: used() });
    publish({ world: made, session: made.main.id, body: turnEnd });

    expect(shapeOf(await usageEntriesOf(made))).toEqual(['opened s0', 'node_usage s1']);
  });

  it('tells its followers each entry once it is stored', async () => {
    const made = usageConversation();
    const heard: string[] = [];

    made.usage.follow((event) => heard.push(event.type === 'stored' ? event.entry.type : 'failed'));
    publish({ world: made, session: made.main.id, body: used() });
    await made.usage.flush();

    expect(heard).toEqual(['opened', 'node_usage']);
  });

  it('is reported once and ends when the store fails, and the run goes on', async () => {
    const made = usageConversation();

    await made.usage.flush();
    made.store.failWith(new Error('disk gone'));
    publish({ world: made, session: made.main.id, body: used() });
    await made.usage.flush();
    publish({ world: made, session: made.main.id, body: used() });
    await made.usage.flush();

    expect(made.usageFailures).toHaveLength(1);
    expect(made.usage.writing()).toBe(false);
    await expect(made.usage.snapshot()).rejects.toBe(made.usage.failure);
  });
});

describe('a reopened conversation’s usage channel', () => {
  it('goes on from what was stored: it is not opened again, the earlier nodes keep their records and the total covers them', async () => {
    const first = usageConversation();
    const firstMain = first.nodeOf(first.main.id);

    publish({ world: first, session: first.main.id, body: used() });
    await first.usage.flush();

    const second = await reopenedUsageConversation(first.store);
    const secondMain = second.nodeOf(second.main.id);

    publish({ world: second, session: second.main.id, body: used({ estimatedCostUsd: 0.02 }) });

    const stored = await entries(second);
    const snapshot = await second.usage.snapshot();

    expect(shapeOf(stored)).toEqual(['opened s0', 'node_usage s1', 'node_usage s2']);
    expect(secondMain).not.toBe(firstMain);
    expect('nodes' in snapshot && snapshot.nodes.map(({ node, calls }) => [node, calls])).toEqual([
      [firstMain, 1],
      [secondMain, 1],
    ]);
    expect(snapshot).toMatchObject({ cursor: 's2', total: { calls: 2, estimatedCostUsd: 0.03 } });
  });

  it('opens a new channel for a conversation kept before it existed, and says it did not count what came before', async () => {
    // A store that holds no usage channel: the conversation was kept before there was one.
    const made = usageConversation({ reopened: true });

    // Before any call: the snapshot already says the figures are a lower bound.
    expect(await made.usage.snapshot()).toMatchObject({
      cursor: 's0',
      total: { calls: 0, incomplete: true },
    });

    publish({ world: made, session: made.main.id, body: used() });

    const stored = await entries(made);

    expect(shapeOf(stored)).toEqual(['opened s0', 'node_usage s1']);
    expect(stored[0]).toMatchObject({ type: 'opened', earlierUncounted: true });
    // What it counts from now is added to a total that stays a lower bound, in every entry.
    expect(stored[1]).toMatchObject({ total: { calls: 1, incomplete: true } });
  });

  it('keeps saying so after a later reopen: the channel is gone on from, not opened again', async () => {
    const first = usageConversation({ reopened: true });

    publish({ world: first, session: first.main.id, body: used() });
    await first.usage.flush();

    const second = await reopenedUsageConversation(first.store);

    publish({ world: second, session: second.main.id, body: used() });

    const stored = await entries(second);
    const snapshot = await second.usage.snapshot();

    expect(shapeOf(stored)).toEqual(['opened s0', 'node_usage s1', 'node_usage s2']);
    expect(snapshot).toMatchObject({ total: { calls: 2, incomplete: true } });
  });

  it('does not say it for a conversation that is new: it counts from its start', async () => {
    const made = usageConversation();

    publish({ world: made, session: made.main.id, body: used() });

    const stored = await entries(made);

    expect(stored[0]).not.toHaveProperty('earlierUncounted');
    expect(await made.usage.snapshot()).toMatchObject({ total: { incomplete: false } });
  });
});
