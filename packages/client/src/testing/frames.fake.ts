import { channelNameSchema } from '@sheavly/protocol/channel/channel.validator';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { subscribeFrameSchema } from '@sheavly/protocol/subscription/subscription.validator';

/**
 * Test-only: the frames of a subscribe stream, each parsed with the contract's schema, so a test
 * cannot send what the real server could not, and no id needs a cast.
 */

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
