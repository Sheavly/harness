import { describe, expect, it } from 'vitest';
import { answerWhileWaiting } from '@sheavly/client/approvals/approvals.helper';
import { watchTreeApprovals } from '@sheavly/client/approvals/watch-tree-approvals.helper';
import type { TreeApproval } from '@sheavly/client/approvals/approvals.types';
import { createClient } from '@sheavly/client/client/client.helper';
import { RefusedError } from '@sheavly/client/errors/client.errors';
import { followNode } from '@sheavly/client/nodes/follow-node.helper';
import type { NodeChannelEntry } from '@sheavly/client/nodes/nodes.types';
import { watchTree } from '@sheavly/client/tree/watch-tree.helper';
import { nodeIdSchema } from '@sheavly/protocol/node/node.validator';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { TreeView } from '@sheavly/protocol/tree/tree.types';
import { askUnheardApproval } from '@sheavly/runtime/testing/tree-actions.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import { cuttingFetch } from '../../testing/cutting-fetch.fake.js';
import { useOpenedServers } from '../../testing/opened-servers.fake.js';
import { servedCommand } from '../../testing/served-command.fake.js';
import { servedConversation } from '../../testing/served-conversation.fake.js';
import { TEST_TOKEN } from '../../testing/testing.constants.js';

// The client's subscription calls against the real routes, over HTTP: the tree kept live, one node
// followed, approvals answered through the tree channel, a connection cut, and what is refused.

const servers = useOpenedServers();

/** A tree as a test reads it: each node as `kind state`. */
const shape = (tree: TreeView) => tree.nodes.map(({ kind, state }) => `${kind} ${state}`);

/** The text of the output entries among `entries`, in order. */
const textOf = (entries: NodeChannelEntry[]) =>
  entries.flatMap((entry) => (entry.type === 'output' ? [entry.text] : [])).join('');

/** A client of the served conversation whose open streams `network.cut()` cuts, and that opens again at once. */
function cuttableClient(world: Awaited<ReturnType<typeof servedConversation>>) {
  const network = cuttingFetch();
  const client = createClient({
    url: world.url,
    token: TEST_TOKEN,
    fetch: network.fetch,
    reconnect: { wait: () => new Promise((resolve) => setTimeout(resolve, 0)) },
  });

  return { client, network };
}

/** Starts reading `node`'s channel through `client`: the entries read so far, and when it has ended. */
async function readingNode(params: {
  client: ReturnType<typeof createClient>;
  world: Awaited<ReturnType<typeof servedConversation>>;
  node: Parameters<typeof followNode>[0]['node'];
}) {
  const entries = await followNode({
    client: params.client,
    id: params.world.conversation,
    node: params.node,
    signal: new AbortController().signal,
  });
  const seen: NodeChannelEntry[] = [];
  const reading = (async () => {
    for await (const entry of entries) seen.push(entry);
  })();

  return { seen, reading };
}

describe('the tree, kept live through the client', () => {
  it('shows what exists, follows a service opening and being cancelled by node, and ends as GET /tree says', async () => {
    const world = await servedConversation({ servers });
    const stop = new AbortController();
    const changes: TreeView[] = [];
    const watch = await watchTree({
      client: world.client,
      id: world.conversation,
      onChange: (tree) => changes.push(tree),
      signal: stop.signal,
    });

    await until(() => shape(watch.tree()).length === 1);
    expect(shape(watch.tree())).toEqual(['agent idle']);

    const service = await servedCommand(world, 'service');

    await until(() => shape(watch.tree()).includes('service running'));

    // Cancelled through the typed call for the route, which the contract gives the client.
    await world.client.send('cancelNode', { id: world.id, node: service.node });
    await until(() => shape(watch.tree()).includes('service cancelled'));

    const snapshot = await world.client.call('getTree', { id: world.id });

    expect(watch.tree()).toEqual({ nodes: snapshot.nodes, approvals: snapshot.approvals });
    // Each change was told once: the snapshot, the service opening, the service ending.
    expect(changes.map((tree) => tree.nodes.length)).toEqual([1, 2, 2]);

    stop.abort();
    await watch.ended;
  });

  it('is, after the connection is cut, the tree that a client that connects now gets', async () => {
    const world = await servedConversation({ servers });
    const { client, network } = cuttableClient(world);
    const stop = new AbortController();
    const watch = await watchTree({
      client,
      id: world.conversation,
      onChange: () => undefined,
      signal: stop.signal,
    });

    await until(() => shape(watch.tree()).length === 1);

    // The first life of the connection ends, and a service opens and ends while it is down.
    network.cut();

    const service = await servedCommand(world, 'service');

    await world.client.send('cancelNode', { id: world.id, node: service.node });
    await until(() => shape(watch.tree()).includes('service cancelled'));

    const fresh = await world.client.call('getTree', { id: world.id });

    expect(watch.tree()).toEqual({ nodes: fresh.nodes, approvals: fresh.approvals });
    expect(network.opened()).toBe(2);

    stop.abort();
    await watch.ended;
  });
});

describe('a node, followed through the client', () => {
  it('gives a command’s output as it is written, to the end that says how it ended', async () => {
    const world = await servedConversation({ servers });
    const command = await servedCommand(world);

    command.print('building\n');

    const { seen, reading } = await readingNode({
      client: world.client,
      world,
      node: command.node,
    });

    await until(() => textOf(seen) === 'building\n');
    command.print('done\n');
    await command.finish();
    await reading;

    expect(textOf(seen)).toBe('building\ndone\n');
    expect(seen.map(({ type }) => type)).toEqual(['opened', 'output', 'output', 'closed']);
    expect(seen.at(-1)).toMatchObject({ type: 'closed', state: 'completed', exitCode: 0 });
  });

  it('goes on after the connection is cut with no gap and no repeat of what was written', async () => {
    const world = await servedConversation({ servers });
    const { client, network } = cuttableClient(world);
    const command = await servedCommand(world);

    command.print('one ');

    const { seen, reading } = await readingNode({ client, world, node: command.node });

    await until(() => textOf(seen) === 'one ');
    network.cut();
    command.print('two ');
    command.print('three');
    await command.finish();
    await reading;

    expect(textOf(seen)).toBe('one two three');
    expect(seen.at(-1)).toMatchObject({ type: 'closed', output: { status: 'complete' } });
    expect(network.opened()).toBe(2);
  });
});

describe('approvals, answered through the tree channel', () => {
  it('waits for an answer while the client is connected, tells of it with the node that asked, and is refused once it is gone', async () => {
    const world = await servedConversation({ servers });
    const stop = new AbortController();
    const told: TreeApproval[] = [];
    const gone: string[] = [];
    const watch = await watchTreeApprovals({
      client: world.client,
      id: world.conversation,
      onApproval: (approval) => told.push(approval),
      onGone: (approvalId) => gone.push(approvalId),
      signal: stop.signal,
    });

    expect(world.harness.approvals.listening).toBe(true);

    const waiting = askUnheardApproval(world.harness);

    await until(() => told.length === 1);
    expect(told[0]).toMatchObject({
      asker: { kind: 'agent' },
      request: { tool: 'run_command', command: 'git push' },
    });

    const [approval] = told;

    if (!approval) throw new Error('no approval was told of');

    await answerWhileWaiting(() =>
      world.client.send('answerApproval', {
        id: world.id,
        approval: approval.request.id,
        body: { response: { decision: 'approve' } },
      }),
    );
    await expect(waiting).resolves.toMatchObject({ decision: 'approve' });
    await until(() => gone.length === 1);
    expect(gone).toEqual([approval.request.id]);

    stop.abort();
    await watch.ended;
    await until(() => !world.harness.approvals.listening);

    await expect(askUnheardApproval(world.harness)).rejects.toMatchObject({
      reason: 'no_listener',
    });
  });
});

describe('what the client is refused', () => {
  /**
   * Follows `node` of conversation `id` from `from` to its end, through a client of its own, and
   * answers what it was refused with and how many requests it made: a refusal is not asked again.
   */
  async function refusedFollowing(params: {
    world: Awaited<ReturnType<typeof servedConversation>>;
    id?: string;
    node: string;
    from: string;
  }) {
    const network = cuttingFetch();
    const client = createClient({
      url: params.world.url,
      token: TEST_TOKEN,
      fetch: network.fetch,
      reconnect: { wait: () => new Promise((resolve) => setTimeout(resolve, 0)) },
    });
    let refusal: unknown;

    try {
      const entries = await followNode({
        client,
        id: conversationIdSchema.parse(params.id ?? params.world.id),
        node: nodeIdSchema.parse(params.node),
        from: params.from,
        signal: new AbortController().signal,
      });

      for await (const _entry of entries);
    } catch (caughtError) {
      refusal = caughtError;
    }

    return { refusal, requests: network.opened() };
  }

  it('is refused a position the log does not hold, as out of range, and does not ask again', async () => {
    const world = await servedConversation({ servers });
    const command = await servedCommand(world);
    const { refusal, requests } = await refusedFollowing({
      world,
      node: command.node,
      from: 'b99',
    });

    expect(refusal).toBeInstanceOf(RefusedError);
    expect(refusal).toMatchObject({ code: 'cursor_out_of_range' });
    expect(requests).toBe(1);

    await command.finish();
  });

  it('is refused a node the conversation does not have, and the node of another conversation, as not found', async () => {
    const world = await servedConversation({ servers });
    const command = await servedCommand(world);
    const missing = await refusedFollowing({ world, node: 'no-such-node', from: 'start' });
    const foreign = await refusedFollowing({
      world,
      id: '00000000-0000-4000-8000-000000000000',
      node: command.node,
      from: 'start',
    });

    expect(missing.refusal).toMatchObject({ status: 404, code: 'not_found' });
    expect(foreign.refusal).toMatchObject({ status: 404, code: 'not_found' });
    expect([missing.requests, foreign.requests]).toEqual([1, 1]);

    await command.finish();
  });
});
