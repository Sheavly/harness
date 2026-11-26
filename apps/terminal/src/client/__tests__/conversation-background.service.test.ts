import { describe, expect, it } from 'vitest';
import { ChannelFailedError } from '@sheavly/client/errors/client.errors';
import { endedAs, treeSnapshot } from '@sheavly/client/testing/frames.fake';
import { openOnFake } from '../../testing/remote-conversation.fake.js';
import { MAIN_AGENT, childNode } from '../../testing/tree-feed.fake.js';
import type { Background } from '../client.types.js';

const NONE: Background = { tasks: 0, agents: 0, services: 0 };

/** A conversation whose background counts are followed, with what the listener was told. */
async function following() {
  const opened = await openOnFake({});
  const stop = new AbortController();
  const told: Background[] = [];
  const watch = await opened.conversation.watchBackground({
    listener: (counts) => told.push(counts),
    signal: stop.signal,
  });

  return { ...opened, told, stop, watch };
}

describe('RemoteConversation: the background work it counts', () => {
  it('counts nothing before it follows the tree, and the main agent never', async () => {
    const { conversation, told } = await following();

    expect(conversation.background).toEqual(NONE);
    expect(conversation.runningTasks).toBe(0);

    // The snapshot holds the main agent, running: it is the conversation, not work in the
    // background of it, so the listener is told nothing once the snapshot has been read.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(told).toEqual([]);
  });

  it('splits what runs into tasks, agents and services, and tells the listener of each change', async () => {
    const { conversation, told, tree } = await following();

    tree.opened(childNode({ id: 's1', kind: 'service' }));
    tree.opened(childNode({ id: 'c1', kind: 'command' }));
    tree.opened(childNode({ id: 'c2', kind: 'command' }));
    tree.opened(childNode({ id: 'a1', kind: 'agent' }));
    tree.closed(childNode({ id: 's1', kind: 'service', state: 'completed' }));
    await until(() => told.length === 5);

    expect(told).toEqual([
      { tasks: 0, agents: 0, services: 1 },
      { tasks: 1, agents: 0, services: 1 },
      { tasks: 2, agents: 0, services: 1 },
      { tasks: 2, agents: 1, services: 1 },
      { tasks: 2, agents: 1, services: 0 },
    ]);
    expect(conversation.background).toEqual({ tasks: 2, agents: 1, services: 0 });
    expect(conversation.runningTasks).toBe(3);
  });

  it('does not tell the listener of a change in the tree that leaves the counts as they were', async () => {
    const { told, tree } = await following();

    tree.opened(childNode({ id: 'c1', kind: 'command' }));
    // A command that ended is not running, and another one that ended before it began never was.
    tree.closed(childNode({ id: 'c1', kind: 'command', state: 'completed' }));
    tree.opened(childNode({ id: 'c2', kind: 'command' }));
    tree.closed(childNode({ id: 'c2', kind: 'command', state: 'completed' }));
    await until(() => told.length === 4);

    expect(told.map(({ tasks }) => tasks)).toEqual([1, 0, 1, 0]);
  });

  it('counts the work a snapshot already shows, for a conversation joined while it runs', async () => {
    const { conversation, told } = await openFollowingSnapshot();

    expect(told).toEqual([{ tasks: 1, agents: 0, services: 0 }]);
    expect(conversation.background).toEqual({ tasks: 1, agents: 0, services: 0 });
  });

  it('ends quietly when it is stopped, and says why when the tree channel fails', async () => {
    const stopped = await following();

    stopped.stop.abort();
    await expect(stopped.watch.ended).resolves.toBeUndefined();

    const failing = await openOnFake({
      handlers: {
        async *streamChannels() {
          yield treeSnapshot({ n: 1, nodes: [MAIN_AGENT] });
          yield endedAs({ name: 'tree', reason: 'failed' });
        },
      },
    });
    const watch = await failing.conversation.watchBackground({
      listener: () => undefined,
      signal: new AbortController().signal,
    });

    await expect(watch.ended).rejects.toBeInstanceOf(ChannelFailedError);
  });
});

/** A conversation whose tree already shows a command running when it is followed. */
async function openFollowingSnapshot() {
  const opened = await openOnFake({
    handlers: {
      async *streamChannels() {
        yield treeSnapshot({
          n: 4,
          nodes: [MAIN_AGENT, childNode({ id: 'c1', kind: 'command' })],
        });
        yield endedAs({ name: 'tree', reason: 'completed' });
      },
    },
  });
  const told: Background[] = [];
  const watch = await opened.conversation.watchBackground({
    listener: (counts) => told.push(counts),
    signal: new AbortController().signal,
  });

  await watch.ended;

  return { ...opened, told };
}

/** Waits until `check` holds, for the frames a fake server sends a moment after they are told. */
async function until(check: () => boolean) {
  for (let tries = 0; tries < 200 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
