import { describe, expect, it } from 'vitest';
import { ChannelFailedError, RefusedError } from '@sheavly/client/errors/client.errors';
import { agentNode, usageFigures } from '@sheavly/client/testing/frames.fake';
import { NoMainAgentError } from '../../errors/transcript.errors.js';
import { openOnFake } from '../../testing/remote-conversation.fake.js';
import { lostAgent, treeFeed, until } from '../../testing/tree-feed.fake.js';
import { usageFeed } from '../../testing/usage-feed.fake.js';
import type { MainUsage } from '../client.types.js';

const FILLED = { used: 120, cached: 60, window: 300_000 };
const FILLED_MORE = { used: 480, cached: 100, window: 300_000 };

/** A conversation whose usage is followed, with what `onChange` was told, in order. */
async function following(
  params: { usage?: ReturnType<typeof usageFeed>; tree?: ReturnType<typeof treeFeed> } = {},
) {
  const opened = await openOnFake(params);
  const stop = new AbortController();
  const told: MainUsage[] = [];
  const watch = await opened.conversation.watchUsage({
    onChange: (usage) => told.push(usage),
    signal: stop.signal,
  });

  return { ...opened, told, stop, watch };
}

/**
 * A reopened conversation: its tree holds the lost main agent of its earlier life and the live one,
 * and its usage is `usage`. It is followed until it has told once.
 */
async function reopenedWith(usage: Parameters<typeof usageFeed>[0]) {
  const tree = treeFeed([], [lostAgent('old'), agentNode({ id: 'main', state: 'running' })]);
  const followed = await following({ usage: usageFeed(usage), tree });

  await until(() => followed.told.length === 1);

  return followed;
}

describe('RemoteConversation: the usage it follows', () => {
  it('tells the total and the main agent’s context from the snapshot, then from each entry', async () => {
    const usage = usageFeed({ total: 1, nodes: [{ node: 'main', calls: 1, context: FILLED }] });
    const { told, usage: feed } = await following({ usage });

    await until(() => told.length === 1);
    feed.entry({ record: { node: 'main', calls: 2, context: FILLED_MORE }, total: 2 });
    await until(() => told.length === 2);

    expect(told).toEqual([
      { total: usageFigures(1), context: FILLED },
      { total: usageFigures(2), context: FILLED_MORE },
    ]);
  });

  it('gives no context while the main agent has no record, and takes it from its first entry', async () => {
    const { told, usage } = await following();

    await until(() => told.length === 1);
    usage.entry({ record: { node: 'main', calls: 1, context: FILLED }, total: 1 });
    await until(() => told.length === 2);

    expect(told).toEqual([
      { total: usageFigures(0), context: undefined },
      { total: usageFigures(1), context: FILLED },
    ]);
  });

  it('never takes the context of a node other than the main agent', async () => {
    const usage = usageFeed({
      total: 1,
      nodes: [{ node: 'helper', calls: 1, context: FILLED_MORE }],
    });
    const { told, usage: feed } = await following({ usage });

    await until(() => told.length === 1);
    feed.entry({ record: { node: 'helper', calls: 2, context: FILLED_MORE }, total: 2 });
    await until(() => told.length === 2);

    expect(told).toEqual([
      { total: usageFigures(1), context: undefined },
      { total: usageFigures(2), context: undefined },
    ]);
  });

  it('finds the main agent of a reopened conversation, not the lost one before it', async () => {
    const { told } = await reopenedWith({
      total: 2,
      nodes: [
        { node: 'old', calls: 1, context: FILLED_MORE },
        { node: 'main', calls: 1, context: FILLED },
      ],
    });

    expect(told).toEqual([{ total: usageFigures(2), context: FILLED }]);
  });

  it('shows a reopened conversation’s last measurement until its new main agent makes a call', async () => {
    // A reopen makes a new node for the main agent: the usage has the old one's record and none yet
    // for the new one.
    const { told, usage } = await reopenedWith({
      total: 1,
      nodes: [{ node: 'old', calls: 1, context: FILLED_MORE }],
    });

    usage.entry({ record: { node: 'main', calls: 1, context: FILLED }, total: 2 });
    await until(() => told.length === 2);

    expect(told).toEqual([
      { total: usageFigures(1), context: FILLED_MORE },
      { total: usageFigures(2), context: FILLED },
    ]);
  });

  it('never takes a sub-agent’s context for the main agent’s, whatever the lineage holds', async () => {
    const { told } = await reopenedWith({
      total: 1,
      nodes: [{ node: 'helper', calls: 1, context: FILLED_MORE }],
    });

    expect(told).toEqual([{ total: usageFigures(1), context: undefined }]);
  });

  it('rejects with NoMainAgentError when the tree holds no main agent, and opens no usage channel', async () => {
    const opened = await openOnFake({ tree: treeFeed([], [lostAgent('old')]) });

    await expect(
      opened.conversation.watchUsage({
        onChange: () => undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NoMainAgentError);
    expect(opened.server.calls.map(({ name }) => name)).not.toContain('streamChannels');
  });

  it('ends quietly when its signal aborts', async () => {
    const { stop, watch } = await following();

    stop.abort();

    await expect(watch.ended).resolves.toBeUndefined();
  });

  it('rejects `ended` when the usage channel fails, as it does when its conversation closes', async () => {
    const { usage, watch } = await following();

    usage.failed();

    await expect(watch.ended).rejects.toBeInstanceOf(ChannelFailedError);
  });

  it('rejects when the backend refuses the usage channel', async () => {
    const opened = await openOnFake({
      handlers: { streamChannels: () => ({ refuse: { status: 404, code: 'not_found' } }) },
    });

    await expect(
      opened.conversation.watchUsage({
        onChange: () => undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(RefusedError);
  });
});
