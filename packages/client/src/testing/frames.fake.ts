import { channelNameSchema } from '@sheavly/protocol/channel/channel.validator';
import { nodeIdSchema } from '@sheavly/protocol/node/node.validator';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { subscribeFrameSchema } from '@sheavly/protocol/subscription/subscription.validator';

/**
 * Test-only: the frames of a subscribe stream, each parsed with the contract's schema, so a test
 * cannot send what the real server could not, and no id needs a cast.
 */

/** A node's id. */
export const nodeIdOf = (name: string) => nodeIdSchema.parse(name);

/** A channel's name: a node's id, or `tree`. */
export const channelOf = (name: string) => channelNameSchema.parse(name);

const frame = (raw: unknown): SubscribeFrame => subscribeFrameSchema.parse(raw);

/** An agent's channel opens: the node, running. Its cursor is `s0`. */
export const agentOpened = (name: string) =>
  frame({
    channel: name,
    cursor: 's0',
    at: 1,
    type: 'opened',
    node: { kind: 'agent', id: name, title: name, state: 'running', startedAt: 1 },
  });

/** An agent's channel after `n` entries: the node as it is, with `status` as what it is doing. */
export const agentUpdated = (params: { name: string; n: number; status?: string }) =>
  frame({
    channel: params.name,
    cursor: `s${String(params.n)}`,
    at: params.n,
    type: 'updated',
    node: {
      kind: 'agent',
      id: params.name,
      title: params.name,
      state: 'running',
      startedAt: 1,
      ...(params.status && { status: params.status }),
    },
  });

/**
 * An agent's loop event as its channel holds it, as entry `n`: the event as the stream carries it
 * (its own `seq`, which is not the channel's cursor), and, for a text delta that merged the ones
 * after it, `lastSeq`.
 */
export const agentEvent = (params: { name: string; n: number; event: object; lastSeq?: number }) =>
  frame({
    channel: params.name,
    cursor: `s${String(params.n)}`,
    at: params.n,
    type: 'event',
    event: params.event,
    ...(params.lastSeq !== undefined && { lastSeq: params.lastSeq }),
  });

/** An agent's channel after an event too large to store, as entry `n`: which it was, and how large. */
export const agentEventOmitted = (params: {
  name: string;
  n: number;
  eventType: string;
  seq: number;
  size: number;
}) =>
  frame({
    channel: params.name,
    cursor: `s${String(params.n)}`,
    at: params.n,
    type: 'event_omitted',
    eventType: params.eventType,
    seq: params.seq,
    size: params.size,
  });

/** A command's output: `text`, which starts at byte `offset` of it. */
export const outputText = (params: { name: string; offset: number; text: string }) =>
  frame({
    channel: params.name,
    cursor: `b${String(params.offset + new TextEncoder().encode(params.text).length)}`,
    at: 1,
    type: 'output',
    offset: params.offset,
    text: params.text,
  });

/** A command's channel closed after `bytes` of output: it carries the cursor of the output before it. */
export const commandClosed = (params: { name: string; bytes: number }) =>
  frame({
    channel: params.name,
    cursor: `b${String(params.bytes)}`,
    at: 2,
    type: 'closed',
    state: 'completed',
    exitCode: 0,
    output: { status: 'complete' },
  });

/** Where a channel stood when a subscription at `now` opened. */
export const headAt = (params: { name: string; cursor: string }) =>
  frame({ type: 'head', channel: params.name, cursor: params.cursor });

/** A channel ended: `completed` (nothing follows), `failed`, or `cut_off` (resume after `cursor`). */
export const endedAs = (params: {
  name: string;
  reason: 'completed' | 'cut_off' | 'failed';
  cursor?: string;
}) =>
  frame({
    type: 'end',
    channel: params.name,
    reason: params.reason,
    ...(params.cursor && { cursor: params.cursor }),
  });

/** A node as the tree carries it (not yet parsed): an agent, idle or running. */
export const agentNode = (params: { id: string; state?: 'idle' | 'running' }) => ({
  kind: 'agent',
  id: params.id,
  title: params.id,
  state: params.state ?? 'idle',
  startedAt: 1,
});

/** A node as the tree carries it (not yet parsed): a service, running or `cancelled`. */
export const serviceNode = (params: { id: string; state?: 'running' | 'cancelled' }) => ({
  kind: 'service',
  id: params.id,
  title: params.id,
  state: params.state ?? 'running',
  startedAt: 1,
  ...(params.state === 'cancelled' && { endedAt: 3 }),
  command: 'npm run dev',
  description: 'the dev server',
  output: '',
});

/** An approval request as the tree carries it (not yet parsed). */
export const approvalRequest = (id: string) => ({
  id,
  callId: 'call_1',
  tool: 'run_command',
  command: 'git push',
  concerns: [],
  options: ['approve', 'skip'],
});

/** The tree as it stands after the tree channel's entry `n`: its nodes and its waiting approvals. */
export const treeSnapshot = (params: {
  n: number;
  nodes: object[];
  approvals?: { node: string; request: object }[];
}) =>
  frame({
    channel: 'tree',
    cursor: `s${String(params.n)}`,
    at: params.n,
    type: 'snapshot',
    nodes: params.nodes,
    approvals: params.approvals ?? [],
  });

/** An agent's channel closes as entry `n`: it completed. */
export const agentClosed = (params: { name: string; n: number }) =>
  frame({
    channel: params.name,
    cursor: `s${String(params.n)}`,
    at: params.n,
    type: 'closed',
    state: 'completed',
    outcome: 'completed',
  });

/** A command's channel opens: the node, running. Its cursor is `b0`. */
export const commandOpened = (name: string) =>
  frame({
    channel: name,
    cursor: 'b0',
    at: 1,
    type: 'opened',
    node: serviceNode({ id: name }),
  });

/** The figures of `calls` calls (not yet parsed): every number follows from it, nothing is missing. */
export const usageFigures = (calls: number) => ({
  calls,
  inputTokens: calls * 100,
  outputTokens: calls * 10,
  cacheReadTokens: calls * 60,
  cacheWriteTokens: 0,
  estimatedCostUsd: calls / 100,
  missingUsageCalls: 0,
  unpricedCalls: 0,
  incomplete: false,
});

/** The usage as it stands after the usage channel's entry `n`: `total` calls, and each node's. */
export const usageSnapshot = (params: {
  n: number;
  total: number;
  nodes: { node: string; calls: number }[];
}) =>
  frame({
    channel: 'usage',
    cursor: `s${String(params.n)}`,
    at: params.n,
    type: 'snapshot',
    total: usageFigures(params.total),
    nodes: params.nodes.map(({ node, calls }) => ({ ...usageFigures(calls), node })),
  });

/**
 * An entry of the usage channel: number `n`, a node's usage as it now is (`calls`) and the total (`total`),
 * and the nodes whose records are no longer kept, left out when there are none.
 */
export const usageEntry = (params: {
  n: number;
  node: string;
  calls: number;
  total: number;
  evicted?: string[];
}) =>
  frame({
    channel: 'usage',
    cursor: `s${String(params.n)}`,
    at: params.n,
    type: 'node_usage',
    usage: { ...usageFigures(params.calls), node: params.node },
    total: usageFigures(params.total),
    ...(params.evicted && { evicted: params.evicted }),
  });

/** The usage channel's opening: entry 0. */
export const usageOpened = frame({ channel: 'usage', cursor: 's0', at: 0, type: 'opened' });

/** An entry of the tree channel: number `n`, `type`, and what that type holds besides. */
export const treeEntry = (params: { n: number; type: string; fields?: object }) =>
  frame({
    channel: 'tree',
    cursor: `s${String(params.n)}`,
    at: params.n,
    type: params.type,
    ...params.fields,
  });
