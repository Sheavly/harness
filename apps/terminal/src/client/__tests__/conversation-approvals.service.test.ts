import { describe, expect, it } from 'vitest';
import { approvalIdSchema } from '@sheavly/protocol/approval/approval.validator';
import { ChannelFailedError } from '@sheavly/client/errors/client.errors';
import { approvalRequest, endedAs, treeSnapshot } from '@sheavly/client/testing/frames.fake';
import { startedAnswer } from '../../chat/testing/prompt-answers.fake.js';
import { FAKE_ID as ID, openOnFake } from '../../testing/remote-conversation.fake.js';
import { FAILED_TREE, MAIN_AGENT, childNode, until } from '../../testing/tree-feed.fake.js';
import type { AskedApproval } from '../client.types.js';

/** A conversation whose approvals are answered, with what the watcher was told. */
async function watching(params: { sub?: boolean } = {}) {
  const opened = await openOnFake({});
  const told: string[] = [];
  const asked: AskedApproval[] = [];
  const stop = new AbortController();
  const watch = await opened.conversation.watchApprovals({
    onApproval: (approval) => {
      asked.push(approval);
      told.push(`asked ${approval.request.id}`);
    },
    onGone: (id) => told.push(`gone ${id}`),
    signal: stop.signal,
  });

  if (params.sub) {
    opened.tree.opened(childNode({ id: 'sub', kind: 'agent', title: 'Update ESLint rules' }));
  }

  return { ...opened, told, asked, stop, watch };
}

describe('RemoteConversation: approvals', () => {
  it('says it will answer, so a command waits instead of being refused, and hears each approval asked and gone', async () => {
    const { server, tree, told } = await watching();

    tree.asked({ id: 'a1' });
    await until(() => told.length === 1);
    tree.answered({ id: 'a1' });
    await until(() => told.length === 2);

    expect(told).toEqual(['asked a1', 'gone a1']);
    // From the tree's snapshot, with the claim to answer approvals.
    expect(server.calls.find(({ name }) => name === 'streamChannels')?.call.body).toEqual({
      subscriptions: [{ channel: 'tree', from: 'snapshot' }],
      approvals: true,
    });
  });

  it('names a sub-agent that asks by its title, and leaves the main agent unnamed', async () => {
    const { tree, asked } = await watching({ sub: true });

    tree.asked({ id: 'a1' });
    tree.asked({ id: 'a2', node: 'sub' });
    await until(() => asked.length === 2);

    // The asker has a title and nothing else: no id of the node is shown or kept.
    expect(asked.map(({ request, asker }) => [request.id, asker])).toEqual([
      ['a1', undefined],
      ['a2', { title: 'Update ESLint rules' }],
    ]);
  });

  it('tells of an approval that already waits when it connects', async () => {
    const opened = await openOnFake({
      handlers: {
        async *streamChannels() {
          yield treeSnapshot({
            n: 3,
            nodes: [MAIN_AGENT],
            approvals: [{ node: 'main', request: approvalRequest('early') }],
          });
          yield endedAs({ name: 'tree', reason: 'completed' });
        },
      },
    });
    const asked: AskedApproval[] = [];
    const watch = await opened.conversation.watchApprovals({
      onApproval: (approval) => asked.push(approval),
      onGone: () => undefined,
      signal: new AbortController().signal,
    });

    await watch.ended;

    expect(asked.map(({ request }) => request.id)).toEqual(['early']);
  });

  it('is connected by the time it resolves, so the first prompt is not refused', async () => {
    const order: string[] = [];
    const { conversation, tree } = await openOnFake({
      handlers: {
        sendPrompt: () => {
          order.push('prompt sent');

          return startedAnswer();
        },
        streamChannels: () => {
          order.push('tree open');

          return tree.follow();
        },
      },
    });

    await conversation.watchApprovals({
      onApproval: () => undefined,
      onGone: () => undefined,
      signal: new AbortController().signal,
    });
    await conversation.submit('hi');

    expect(order).toEqual(['tree open', 'prompt sent']);
  });

  it('ends quietly when it is stopped, and fails when the tree channel does', async () => {
    const stopped = await watching();

    stopped.stop.abort();
    await expect(stopped.watch.ended).resolves.toBeUndefined();

    const failing = await openOnFake({ handlers: FAILED_TREE });
    const failed = await failing.conversation.watchApprovals({
      onApproval: () => undefined,
      onGone: () => undefined,
      signal: new AbortController().signal,
    });

    await expect(failed.ended).rejects.toBeInstanceOf(ChannelFailedError);
  });

  it('answers an approval by its id with the decision', async () => {
    const { conversation, server } = await openOnFake({
      handlers: { answerApproval: () => undefined },
    });

    await conversation.answerApproval({
      approval: approvalIdSchema.parse('a1'),
      response: { decision: 'skip_with_message', message: 'use ls instead' },
    });

    expect(server.calls.find(({ name }) => name === 'answerApproval')?.call).toEqual({
      params: { id: ID, approval: 'a1' },
      body: { response: { decision: 'skip_with_message', message: 'use ls instead' } },
    });
  });

  it('lets the caller tell that someone else answered first', async () => {
    const { conversation } = await openOnFake({
      handlers: {
        answerApproval: () => ({ refuse: { status: 404, code: 'unknown_approval' } }),
      },
    });

    await expect(
      conversation.answerApproval({
        approval: approvalIdSchema.parse('a1'),
        response: { decision: 'approve' },
      }),
    ).rejects.toMatchObject({ name: 'RefusedError', code: 'unknown_approval' });
  });
});
