import { describe, expect, it } from 'vitest';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { ChannelFailedError, RefusedError } from '../../errors/client.errors.js';
import {
  agentClosed,
  agentEvent,
  agentEventOmitted,
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

/** Serves `connections` of `main`'s channel in turn, follows it to its end, and answers both. */
async function followedMain(connections: Parameters<typeof served>[0]['connections']) {
  const world = served({ connections });

  return { world, seen: await followed({ world, name: 'main' }) };
}

/** Entries as `type cursor`, to compare what was yielded at a glance. */
const shape = (seen: NodeChannelEntry[]) => seen.map(({ type, cursor }) => `${type} ${cursor}`);

describe('followNode', () => {
  it('yields an agent’s entries from its start to its closed entry, and ends with the channel', async () => {
    const { world, seen } = await followedMain([
      [
        agentOpened('main'),
        agentUpdated({ name: 'main', n: 1, status: 'reading' }),
        agentClosed({ name: 'main', n: 2 }),
        endedAs({ name: 'main', reason: 'completed' }),
      ],
    ]);

    expect(shape(seen)).toEqual(['opened s0', 'updated s1', 'closed s2']);
    expect(world.asked()).toEqual([{ subscriptions: [{ channel: 'main', from: 'start' }] }]);
  });

  it('yields an agent’s run as its loop events, in the order they were stored, then its end', async () => {
    const { seen } = await followedMain([
      [
        agentOpened('main'),
        agentEvent({
          name: 'main',
          n: 1,
          event: { seq: 4, type: 'text_delta', text: 'Hello, world' },
          lastSeq: 6,
        }),
        agentEvent({
          name: 'main',
          n: 2,
          event: { seq: 7, type: 'turn_end', turn: 0, stopReason: 'end_turn' },
        }),
        agentEventOmitted({ name: 'main', n: 3, eventType: 'tool_result', seq: 8, size: 90_000 }),
        agentClosed({ name: 'main', n: 4 }),
        endedAs({ name: 'main', reason: 'completed' }),
      ],
    ]);

    expect(shape(seen)).toEqual([
      'opened s0',
      'event s1',
      'event s2',
      'event_omitted s3',
      'closed s4',
    ]);
    // The event as the stream carried it, with the seq range of the text it merged.
    expect(seen[1]).toMatchObject({
      event: { seq: 4, type: 'text_delta', text: 'Hello, world' },
      lastSeq: 6,
    });
    expect(seen[3]).toMatchObject({ eventType: 'tool_result', seq: 8, size: 90_000 });
  });

  it('resumes an agent’s events after the last one it had when the connection drops, with no gap and no repeat', async () => {
    const delta = (seq: number, text: string) => ({ seq, type: 'text_delta', text });
    const { world, seen } = await followedMain([
      [
        agentOpened('main'),
        agentEvent({ name: 'main', n: 1, event: delta(0, 'a') }),
        agentEvent({ name: 'main', n: 2, event: delta(1, 'b') }),
        DROP,
      ],
      [
        agentEvent({ name: 'main', n: 3, event: delta(2, 'c') }),
        agentClosed({ name: 'main', n: 4 }),
        endedAs({ name: 'main', reason: 'completed' }),
      ],
    ]);

    expect(seen.map(({ cursor }) => cursor)).toEqual(['s0', 's1', 's2', 's3', 's4']);
    // It asked again from the last entry it had, not from the start and not from the event's own seq.
    expect(world.asked()[1]).toEqual({ subscriptions: [{ channel: 'main', from: 's2' }] });
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
