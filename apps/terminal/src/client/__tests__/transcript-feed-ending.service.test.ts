import { describe, expect, it } from 'vitest';
import { ChannelFailedError, RefusedError } from '@sheavly/client/errors/client.errors';
import { subscribeRequestSchema } from '@sheavly/protocol/subscription/subscription.validator';
import { nodeFeeds, routeChannels } from '../../testing/channels-feed.fake.js';
import { openOnFake } from '../../testing/remote-conversation.fake.js';
import { quiet, transcribing } from '../../testing/transcript.fake.js';
import { treeFeed, until } from '../../testing/tree-feed.fake.js';
import { NoMainAgentError } from '../../errors/transcript.errors.js';
import type { ChatItem } from '../transcript.types.js';

const DELTA = { seq: 1, type: 'text_delta', text: 'hi' };
const NOTICE = { type: 'storage_failed', fields: { error: 'disk full' } };

/** Tells both channels something, and waits: what is told after the feed ended must not arrive. */
async function tellBoth(world: Awaited<ReturnType<typeof transcribing>>) {
  world.tree.notice(NOTICE);
  world.channel.event({ event: DELTA });
  await quiet();
}

describe('RemoteConversation: how the transcript feed ends', () => {
  it('resolves only once the backend accepted both connections, so a prompt sent after it is not missed', async () => {
    const tree = treeFeed();
    const nodes = nodeFeeds();
    const main = nodes.of('main');
    const gate = Promise.withResolvers<undefined>();
    const opened = await openOnFake({
      tree,
      nodes,
      handlers: {
        streamChannels: async (call) => {
          // The main agent's channel is accepted late: the tree's already is.
          if (subscribeRequestSchema.parse(call.body).subscriptions[0]?.channel === 'main') {
            await gate.promise;
          }

          return routeChannels({ call, tree, nodes });
        },
      },
    });
    const items: ChatItem[] = [];
    let resolved = false;
    const watching = opened.conversation
      .watchTranscript({ onItem: (item) => items.push(item), signal: new AbortController().signal })
      .then((watch) => {
        resolved = true;

        return watch;
      });

    await until(
      () => opened.server.calls.filter(({ name }) => name === 'streamChannels').length === 2,
    );
    await quiet();

    expect(resolved).toBe(false);

    gate.resolve(undefined);
    await watching;
    main.event({ event: DELTA });
    await until(() => items.length === 1);

    expect(items).toHaveLength(1);
  });

  it('ends quietly when its signal aborts, and leaves neither connection open', async () => {
    const world = await transcribing();

    world.stop.abort();
    await expect(world.watch.ended).resolves.toBeUndefined();
    await tellBoth(world);

    expect(world.items).toEqual([]);
  });

  it('ends quietly for a caller that left before it connected: nothing is followed and nothing fails', async () => {
    const opened = await openOnFake({});
    const leave = new AbortController();
    const items: ChatItem[] = [];

    leave.abort();

    const watch = await opened.conversation.watchTranscript({
      onItem: (item) => items.push(item),
      signal: leave.signal,
    });

    await expect(watch.ended).resolves.toBeUndefined();
    expect(items).toEqual([]);
  });

  it('ends quietly when the main agent’s channel closes, and stops following the tree', async () => {
    const world = await transcribing();

    world.channel.closed();
    await expect(world.watch.ended).resolves.toBeUndefined();
    await tellBoth(world);

    expect(world.items).toEqual([]);
  });

  it('rejects `ended` when the main agent’s channel fails, and stops following the tree', async () => {
    const world = await transcribing();

    world.channel.failed();
    await expect(world.watch.ended).rejects.toBeInstanceOf(ChannelFailedError);
    await tellBoth(world);

    expect(world.items).toEqual([]);
  });

  it('rejects `ended` when the tree channel fails, as it does when the conversation closes, and stops following the main agent', async () => {
    const world = await transcribing();

    world.tree.failed();
    await expect(world.watch.ended).rejects.toBeInstanceOf(ChannelFailedError);
    await tellBoth(world);

    expect(world.items).toEqual([]);
  });

  it('rejects `ended` with what `onItem` throws for an item of the tree, and stops following both', async () => {
    const failure = new Error('the screen is gone');
    const world = await transcribing({
      onItem: () => {
        throw failure;
      },
    });

    world.tree.notice(NOTICE);
    await expect(world.watch.ended).rejects.toBe(failure);
    await tellBoth(world);

    expect(world.items).toHaveLength(1);
  });

  it('rejects `ended` with what `onItem` throws for an event of the main agent, and stops following the tree', async () => {
    const failure = new Error('the screen is gone');
    const world = await transcribing({
      onItem: () => {
        throw failure;
      },
    });

    world.channel.event({ event: DELTA });
    await expect(world.watch.ended).rejects.toBe(failure);
    await tellBoth(world);

    expect(world.items).toHaveLength(1);
  });

  it('rejects when the backend refuses the main agent’s channel, and stops following the tree', async () => {
    const opened = await openOnFake({});
    const items: ChatItem[] = [];

    // The backend has no channel for the main agent: `not_found`.
    await expect(
      opened.conversation.watchTranscript({
        onItem: (item) => items.push(item),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(RefusedError);

    opened.tree.notice(NOTICE);
    await quiet();

    expect(items).toEqual([]);
  });

  it('rejects when the tree holds no main agent', async () => {
    const opened = await openOnFake({ tree: treeFeed([], []) });

    await expect(
      opened.conversation.watchTranscript({
        onItem: () => undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NoMainAgentError);
  });
});
