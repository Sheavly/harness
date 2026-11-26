import { describe, expect, it } from 'vitest';
import { serverErrorSchema } from '@sheavly/protocol/server/server.validator';
import { applyTreeEntry, emptyTree } from '@sheavly/protocol/tree/tree.utils';
import { treeChannelEntrySchema, treeSnapshotSchema } from '@sheavly/protocol/tree/tree.validator';
import { readChannel } from '@sheavly/runtime/testing/stored-channels.fake';
import {
  answerWaitingApproval,
  askMainApproval,
  askUnheardApproval,
  startRunningService,
  treeFollowedFrom,
  treeSummaryOf,
} from '@sheavly/runtime/testing/tree-actions.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import { reply, testApi } from '../../testing/api.fake.js';
import { useOpenedServers } from '../../testing/opened-servers.fake.js';
import { servedConversation } from '../../testing/served-conversation.fake.js';
import { framesOf } from '../../testing/subscription-frames.fake.js';

// The tree of a conversation over HTTP: the snapshot a client that connects late starts from, the
// tree followed through the subscribe route from that snapshot, and what the route refuses.

const servers = useOpenedServers();

type Served = Awaited<ReturnType<typeof servedConversation>>;

/** The tree the stored channel builds, folded entry by entry: what a client that replayed has. */
async function replayed(world: Served) {
  const entries = await readChannel({
    store: world.store,
    id: world.conversation,
    channel: 'tree',
  });

  return entries.reduce(
    (tree, entry) => applyTreeEntry({ tree, entry: treeChannelEntrySchema.parse(entry) }),
    emptyTree(),
  );
}

describe('the tree of a conversation, over HTTP', () => {
  it('shows a client that connects late what waits and what runs on, as the contract says and as a replay does', async () => {
    const world = await servedConversation({ servers });
    const waiting = askMainApproval(world.harness);

    startRunningService(world.harness);
    await world.harness.treeChannel?.flush();

    // Through the generated client, which parses the answer with the route's own schema.
    const snapshot = await world.client.call('getTree', { id: world.id });

    // What the client reads is what a replay of the stored channel gives, and is the contract's.
    expect(await replayed(world)).toEqual({ nodes: snapshot.nodes, approvals: snapshot.approvals });
    expect(treeSummaryOf(snapshot)).toEqual({
      nodes: ['agent idle', 'service running'],
      approvals: 1,
    });
    expect(snapshot.approvals[0]).toMatchObject({ request: { tool: 'run_command' } });
    expect(treeSnapshotSchema.safeParse(snapshot).success).toBe(true);

    // Answered: the approval is no longer waiting, which the next snapshot says.
    answerWaitingApproval(world.harness);
    await waiting;
    await world.harness.treeChannel?.flush();

    expect(treeSummaryOf(await world.client.call('getTree', { id: world.id })).approvals).toBe(0);
  });

  it('is followed through the subscribe route from the snapshot, as server-sent frames, to the same tree', async () => {
    const world = await servedConversation({ servers });
    const next = framesOf(
      await world.client.open('streamChannels', {
        id: world.id,
        body: { subscriptions: [{ channel: 'tree', from: 'snapshot' }] },
      }),
    );
    const first = await next();

    startRunningService(world.harness);

    const waiting = askMainApproval(world.harness);
    const service = await next();
    const approval = await next();

    // The tree as it stood travels as `snapshot`, what comes after it as `entry`.
    expect(first).toMatchObject({
      event: 'snapshot',
      frame: { type: 'snapshot', channel: 'tree' },
    });
    expect(service).toMatchObject({ event: 'entry', frame: { type: 'node_opened' } });
    expect(approval).toMatchObject({ event: 'entry', frame: { type: 'approval_requested' } });

    const followed = treeFollowedFrom({
      snapshot: first?.frame,
      entries: [service?.frame, approval?.frame],
    });

    expect(followed).toEqual(await replayed(world));

    answerWaitingApproval(world.harness);
    await waiting;
  });

  it('lets a client answer approvals through a subscription: one asked meanwhile waits, and is refused at once after it leaves', async () => {
    const world = await servedConversation({ servers });
    const { approvals } = world.harness;
    const leave = new AbortController();
    const next = framesOf(
      await world.client.open('streamChannels', {
        id: world.id,
        body: { subscriptions: [{ channel: 'tree', from: 'now' }], approvals: true },
        signal: leave.signal,
      }),
    );

    // The head frame says the subscription is open, which is when it counts.
    expect(await next()).toMatchObject({ event: 'head' });
    expect(approvals.listening).toBe(true);

    const waiting = askUnheardApproval(world.harness);
    const asked = approvals.pending()[0];

    if (!asked) throw new Error('the approval did not wait');

    // Answered through the route, as a client does.
    await world.client.send('answerApproval', {
      id: world.id,
      approval: asked.id,
      body: { response: { decision: 'approve' } },
    });
    await waiting;

    leave.abort();
    await until(() => !approvals.listening);

    await expect(askUnheardApproval(world.harness)).rejects.toMatchObject({
      reason: 'no_listener',
    });
  });

  it('is refused a claim to answer approvals without the tree, where an approval is seen, as a bad request', async () => {
    const world = await servedConversation({ servers });
    const response = await world.api.request(`/conversations/${world.id}/subscribe`, {
      method: 'QUERY',
      body: { subscriptions: [{ channel: 'agent-1', from: 'start' }], approvals: true },
    });

    expect(response.status).toBe(400);
    expect(serverErrorSchema.parse(await response.json()).error.code).toBe('bad_request');
    expect(world.harness.approvals.listening).toBe(false);
  });
});

describe('what the tree route refuses', () => {
  it('is not found for a conversation that is not there, one that was closed, and a host that keeps nothing', async () => {
    const world = await servedConversation({ servers });
    const keepsNothing = testApi({ go: [reply('done')] });
    const unkept = await keepsNothing.start();
    const answers = [
      await world.api.request('/conversations/00000000-0000-4000-8000-000000000000/tree'),
      await keepsNothing.request(`/conversations/${unkept}/tree`),
    ];

    await world.api.request(`/conversations/${world.id}`, { method: 'DELETE' });
    answers.push(await world.api.request(`/conversations/${world.id}/tree`));

    expect(answers.map(({ status }) => status)).toEqual([404, 404, 404]);
    expect(serverErrorSchema.parse(await answers[1]?.json()).error.code).toBe('not_found');
  });

  it('wants the token, as every route does', async () => {
    const world = await servedConversation({ servers });
    const response = await world.api.app.request(`/conversations/${world.id}/tree`);

    expect(response.status).toBe(401);
  });

  it('is 507 when the conversation’s tree channel could not be stored, saying so', async () => {
    const world = await servedConversation({ servers });
    const stored = await readChannel({
      store: world.store,
      id: world.conversation,
      channel: 'tree',
    });

    // A stored entry no client could read: a reopen cannot go on from the channel.
    await world.store.channel({ id: world.conversation, channel: 'tree' }).append({
      channel: 'tree',
      cursor: `s${String(stored.length)}`,
      at: 1,
      type: 'note',
    });

    const reopened = testApi({ go: [reply('done')] }, world.store);
    const reopen = await reopened.request(`/stored-conversations/${world.id}/reopen`, {
      method: 'POST',
    });
    const answer = await reopened.request(`/conversations/${world.id}/tree`);

    expect(reopen.status).toBe(200);
    expect(answer.status).toBe(507);
    expect(serverErrorSchema.parse(await answer.json()).error.code).toBe('storage_failed');
  });
});
