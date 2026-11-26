import { describe, expect, it } from 'vitest';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { ChannelFailedError, RefusedError } from '../../errors/client.errors.js';
import {
  agentClosed,
  agentOpened,
  agentUpdated,
  commandClosed,
  commandOpened,
  endedAs,
  headAt,
  nodeIdOf,
  outputText,
} from '../../testing/frames.fake.js';
import { DROP, served } from '../../testing/subscription-server.fake.js';
import type { ServedSubscription } from '../../testing/testing.types.js';
import { followNode } from '../follow-node.helper.js';
import type { NodeChannelEntry } from '../nodes.types.js';

const ID = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000ab');

/** Follows `name`'s channel from `from` to its end, and answers every entry. */
async function followed(params: { world: ServedSubscription; name: string; from?: string }) {
  const entries = await followNode({
    client: params.world.client,
    id: ID,
    node: nodeIdOf(params.name),
    signal: new AbortController().signal,
    ...(params.from !== undefined && { from: params.from }),
  });
  const seen: NodeChannelEntry[] = [];

  for await (const entry of entries) seen.push(entry);

  return seen;
}

describe('followNode', () => {
  it('yields an agent’s entries from its start to its closed entry, and ends with the channel', async () => {
    const world = served({
      connections: [
        [
          agentOpened('main'),
          agentUpdated({ name: 'main', n: 1, status: 'reading' }),
          agentClosed({ name: 'main', n: 2 }),
          endedAs({ name: 'main', reason: 'completed' }),
        ],
      ],
    });

    const seen = await followed({ world, name: 'main' });

    expect(seen.map(({ type, cursor }) => `${type} ${cursor}`)).toEqual([
      'opened s0',
      'updated s1',
      'closed s2',
    ]);
    expect(world.asked()).toEqual([{ subscriptions: [{ channel: 'main', from: 'start' }] }]);
  });

  it('reads a command’s output across a dropped connection with no gap and no repeat, and then its end', async () => {
    const world = served({
      connections: [
        [commandOpened('build'), outputText({ name: 'build', offset: 0, text: 'hello' }), DROP],
        [
          outputText({ name: 'build', offset: 5, text: ' world' }),
          commandClosed({ name: 'build', bytes: 11 }),
          endedAs({ name: 'build', reason: 'completed' }),
        ],
      ],
    });

    const seen = await followed({ world, name: 'build' });

    const text = seen.flatMap((entry) => (entry.type === 'output' ? [entry.text] : []));

    expect(text.join('')).toBe('hello world');
    expect(seen.at(-1)).toMatchObject({ type: 'closed', output: { status: 'complete' } });
    // It resumed after the byte it had.
    expect(world.asked()[1]).toEqual({ subscriptions: [{ channel: 'build', from: 'b5' }] });
  });

  it('starts from the position it is given, and does not yield where the channel stood', async () => {
    const world = served({
      connections: [
        [
          headAt({ name: 'main', cursor: 's7' }),
          agentUpdated({ name: 'main', n: 8 }),
          agentClosed({ name: 'main', n: 9 }),
          endedAs({ name: 'main', reason: 'completed' }),
        ],
      ],
    });

    const seen = await followed({ world, name: 'main', from: 'now' });

    expect(seen.map(({ cursor }) => cursor)).toEqual(['s8', 's9']);
    expect(world.asked()[0]).toEqual({ subscriptions: [{ channel: 'main', from: 'now' }] });
  });

  it('throws when the channel ended failed: what was read is not all of it', async () => {
    const world = served({
      connections: [[agentOpened('main'), endedAs({ name: 'main', reason: 'failed' })]],
    });

    await expect(followed({ world, name: 'main' })).rejects.toBeInstanceOf(ChannelFailedError);
  });

  it('throws a refusal as it is: a node the conversation does not have', async () => {
    const world = served({ connections: [{ refuse: { status: 404, code: 'not_found' } }] });

    await expect(followed({ world, name: 'nobody' })).rejects.toBeInstanceOf(RefusedError);
  });
});
