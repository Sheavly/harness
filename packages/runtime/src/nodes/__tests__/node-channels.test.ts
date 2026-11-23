import { modelIdSchema } from '@sheavly/protocol/model/model.validator';
import { nodeIdSchema } from '@sheavly/protocol/node/node.validator';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { describe, expect, it } from 'vitest';
import { ChannelLog } from '../channel-log.service.js';
import { NodeRegistry } from '../node-registry.service.js';
import { MAX_CHANNEL_ENTRIES } from '../nodes.constants.js';
import type { NodeEntry, NodeRecord } from '../nodes.types.js';

const clock = useFixedClock();

/** What a node's channel holds from its start, as `read(0)` does. */
function channelOf(params: { registry: NodeRegistry; id: NodeRecord['id'] }): NodeEntry[] {
  return params.registry.channel(params.id).read(0);
}

/** A registry with two commands in it, `a` and then `b`, both running. */
function twoCommands() {
  const registry = new NodeRegistry();

  return {
    registry,
    first: registry.open({ kind: 'command', title: 'a' }),
    second: registry.open({ kind: 'command', title: 'b' }),
  };
}

function refuses(act: () => unknown, reason: string): void {
  expect(act).toThrow(expect.objectContaining({ reason }));
}

/** The node an entry of a log of one node is about. */
const NODE: NodeRecord = {
  id: nodeIdSchema.parse('n'),
  kind: 'command',
  title: 'x',
  state: 'running',
  startedAt: 0,
};

describe('a listener on a channel', () => {
  it('that throws does not break the change that made the entry, nor the other listeners', async () => {
    const registry = new NodeRegistry();
    const node = registry.open({ kind: 'agent', title: 'main' });
    const heard: string[] = [];
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);

    process.on('uncaughtException', onUncaught);
    registry.tree.follow(() => {
      throw new Error('listener bug');
    }, 'now');
    registry.tree.follow((entry) => heard.push(entry.type), 'now');

    // The node ends and the entry is in both channels, whatever a follower does with it.
    expect(registry.endAgent({ id: node.id, outcome: 'completed' })).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    process.off('uncaughtException', onUncaught);

    expect(registry.get(node.id)?.state).toBe('completed');
    expect(channelOf({ registry, id: node.id }).map((entry) => entry.type)).toEqual([
      'opened',
      'closed',
    ]);
    expect(heard).toEqual(['closed']);
    // It still fails loudly, on its own, after the call.
    expect(uncaught).toHaveLength(1);
  });
});

describe('a status that is the one a node already has', () => {
  it('is not a change: it appends nothing and says so', () => {
    const registry = new NodeRegistry();
    const node = registry.open({ kind: 'agent', title: 'main' });

    expect(registry.setStatus({ id: node.id, status: 'reading' })).toBe(true);
    expect(registry.setStatus({ id: node.id, status: 'reading' })).toBe(false);
    expect(registry.setStatus({ id: node.id, status: 'reading\n' })).toBe(false);
    expect(channelOf({ registry, id: node.id }).map((entry) => entry.type)).toEqual([
      'opened',
      'updated',
    ]);
  });
});

describe('a node’s channel', () => {
  it('starts with opened, carries each change in order, and ends with closed', () => {
    const registry = new NodeRegistry();
    const node = registry.open({ kind: 'agent', title: 'main' });

    registry.setStatus({ id: node.id, status: 'reading' });
    registry.idle({ id: node.id, outcome: 'completed' });
    registry.resume(node.id);
    registry.endAgent({ id: node.id, outcome: 'completed' });

    const entries = registry.channel(node.id).read(0);

    expect(entries.map((entry) => entry.type)).toEqual([
      'opened',
      'updated',
      'updated',
      'updated',
      'closed',
    ]);
    expect(entries.map((entry) => entry.cursor)).toEqual([0, 1, 2, 3, 4]);
    expect(entries.map((entry) => entry.node.state)).toEqual([
      'running',
      'running',
      'idle',
      'running',
      'completed',
    ]);
  });

  it('keeps each entry as the node was then, not as it is now', () => {
    const registry = new NodeRegistry();
    const node = registry.open({ kind: 'agent', title: 'main' });

    registry.setStatus({ id: node.id, status: 'first' });
    registry.setStatus({ id: node.id, status: 'second' });

    const statuses = channelOf({ registry, id: node.id }).map((entry) => entry.node.status);

    expect(statuses).toEqual([undefined, 'first', 'second']);
  });

  it('is not shared: one node’s changes are not in another’s channel', () => {
    const { registry, first, second } = twoCommands();

    registry.endWork({ id: first.id, state: 'completed' });

    expect(registry.channel(first.id).read(0)).toHaveLength(2);
    expect(registry.channel(second.id).read(0)).toHaveLength(1);
  });

  it('is all in the tree channel, which numbers every node’s entries in one order', () => {
    const { registry, first, second } = twoCommands();

    registry.endWork({ id: second.id, state: 'failed' });
    registry.endWork({ id: first.id, state: 'completed' });

    const entries = registry.tree.read(0);

    expect(entries.map((entry) => entry.cursor)).toEqual([0, 1, 2, 3]);
    expect(entries.map((entry) => `${entry.type}:${entry.node.title}`)).toEqual([
      'opened:a',
      'opened:b',
      'closed:b',
      'closed:a',
    ]);
  });

  it('stamps each entry with the time it happened', () => {
    const registry = new NodeRegistry();
    const node = registry.open({ kind: 'command', title: 'a' });

    clock.advance(40);
    registry.endWork({ id: node.id, state: 'completed' });

    const times = channelOf({ registry, id: node.id }).map((entry) => entry.at);

    expect(times).toEqual([clock.at - 40, clock.at]);
  });

  it('does not log a change that changed nothing: the same model, or an ended node’s status', () => {
    const registry = new NodeRegistry();
    const node = registry.open({ kind: 'agent', title: 'main' });
    const model = {
      id: node.id,
      modelId: modelIdSchema.parse('4b1f9a52-3c5e-4a77-9d64-0e2b7f1c8a31'),
    };

    expect(registry.setModel(model)).toBe(true);
    expect(registry.setModel(model)).toBe(false);

    registry.endAgent({ id: node.id, outcome: 'completed' });

    expect(registry.setStatus({ id: node.id, status: 'late' })).toBe(false);
    expect(
      registry
        .channel(node.id)
        .read(0)
        .map((entry) => entry.type),
    ).toEqual(['opened', 'updated', 'closed']);
  });
});

describe('following a channel', () => {
  it('delivers what is there, then each new entry, until it is stopped', () => {
    const log = new ChannelLog();
    const heard: NodeEntry[] = [];

    log.append({ type: 'opened', node: NODE });

    const stop = log.follow((entry) => heard.push(entry));

    log.append({ type: 'updated', node: NODE });
    stop();
    log.append({ type: 'closed', node: NODE });

    expect(heard.map((entry) => entry.type)).toEqual(['opened', 'updated']);
  });

  it('starts at now with nothing that is already there, or at a position', () => {
    const log = new ChannelLog();

    for (const type of ['opened', 'updated', 'updated'] as const) log.append({ type, node: NODE });

    const fromNow: number[] = [];
    const fromOne: number[] = [];

    log.follow((entry) => fromNow.push(entry.cursor), 'now');
    log.follow((entry) => fromOne.push(entry.cursor), 1);
    log.append({ type: 'closed', node: NODE });

    expect(fromNow).toEqual([3]);
    expect(fromOne).toEqual([1, 2, 3]);
  });
});

describe('what a channel keeps', () => {
  it('keeps the newest entries, and says a position before them is gone', () => {
    const log = new ChannelLog();

    for (let count = 0; count < MAX_CHANNEL_ENTRIES + 5; count += 1) {
      log.append({ type: 'updated', node: NODE });
    }

    expect(log.next).toBe(MAX_CHANNEL_ENTRIES + 5);
    expect(log.read(5)).toHaveLength(MAX_CHANNEL_ENTRIES);
    expect(log.read(5)[0]?.cursor).toBe(5);
    refuses(() => log.read(4), 'cursor_out_of_range');
  });

  it.each([
    ['one past the end', 4],
    ['a negative position', -1],
    ['a position that is not a whole number', 1.5],
  ])('refuses %s, and never clamps it to the nearest', (_name, position) => {
    const log = new ChannelLog();

    for (let count = 0; count < 3; count += 1) log.append({ type: 'updated', node: NODE });

    refuses(() => log.read(position), 'cursor_out_of_range');
    refuses(() => log.follow(() => undefined, position), 'cursor_out_of_range');
  });

  it('can be read from its end: nothing yet', () => {
    const log = new ChannelLog();

    log.append({ type: 'opened', node: NODE });

    expect(log.read(1)).toEqual([]);
  });
});

describe('restoring nodes a stored conversation had', () => {
  const stored = { kind: 'agent', title: 'old', startedAt: 100 } as const;

  it('puts back an open node as it was, with its history of opening only', () => {
    const registry = new NodeRegistry();
    const node = registry.restore({ ...stored, state: 'idle', lastOutcome: 'completed' });

    expect(registry.get(node.id)).toMatchObject({
      state: 'idle',
      startedAt: 100,
      lastOutcome: 'completed',
    });
    expect(
      registry
        .channel(node.id)
        .read(0)
        .map((entry) => entry.type),
    ).toEqual(['opened']);
  });

  it('puts back an ended node with its end time, outcome and a closing entry', () => {
    const registry = new NodeRegistry();
    const node = registry.restore({
      ...stored,
      state: 'failed',
      endedAt: 200,
      lastOutcome: 'max_turns',
    });

    expect(registry.get(node.id)).toMatchObject({ state: 'failed', endedAt: 200 });
    expect(
      registry
        .channel(node.id)
        .read(0)
        .map((entry) => entry.type),
    ).toEqual(['opened', 'closed']);
  });

  it('closes a node that was open when the server stopped as lost, and only that', () => {
    const registry = new NodeRegistry();
    const open = registry.restore({ ...stored, state: 'running' });
    const done = registry.restore({
      ...stored,
      state: 'completed',
      endedAt: 5,
      lastOutcome: 'completed',
    });

    expect(registry.lose(open.id)).toBe(true);
    expect(registry.lose(done.id)).toBe(false);
    expect(registry.get(open.id)?.state).toBe('lost');
    expect(registry.get(done.id)?.state).toBe('completed');
  });

  it.each([
    ['an open node that has an end time', { state: 'running', endedAt: 9 }],
    ['an ended node with no end time', { state: 'completed', lastOutcome: 'completed' }],
    [
      'an ended agent whose outcome does not give its state',
      { state: 'completed', endedAt: 9, lastOutcome: 'failed' },
    ],
    ['an ended agent with no outcome', { state: 'failed', endedAt: 9 }],
  ] as const)('refuses %s', (_name, fields) => {
    const registry = new NodeRegistry();

    refuses(() => registry.restore({ ...stored, ...fields }), 'inconsistent_node');
    expect(registry.list()).toEqual([]);
  });

  it('refuses an idle node that is not an agent', () => {
    const registry = new NodeRegistry();

    refuses(
      () => registry.restore({ kind: 'command', title: 'x', startedAt: 1, state: 'idle' }),
      'inconsistent_node',
    );
  });
});
