import { describe, expect, it } from 'vitest';
import { MAX_TREE_NODES } from '@sheavly/protocol/node/node.constants';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { UsageView } from '@sheavly/protocol/usage/usage.types';
import { AnswerError, ChannelFailedError, RefusedError } from '../../errors/client.errors.js';
import {
  endedAs,
  usageEntry,
  usageFigures,
  usageOpened,
  usageSnapshot,
} from '../../testing/frames.fake.js';
import { DROP, served } from '../../testing/subscription-server.fake.js';
import type { FakeRefusal, ServedSubscription } from '../../testing/testing.types.js';
import { watchUsage } from '../watch-usage.helper.js';

const ID = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000ab');

const OVER = endedAs({ name: 'usage', reason: 'completed' });
/** The usage after the first call, the main agent's: where most of these start from. */
const MAIN_FIRST = usageSnapshot({ n: 1, total: 1, nodes: [{ node: 'main', calls: 1 }] });
const NOT_FOUND: FakeRefusal = { refuse: { status: 404, code: 'not_found' } };

/** Starts watching the usage `world` serves; it is told of changes through `onChange`, if given. */
function startWatch(params: {
  world: ServedSubscription;
  onChange?: (usage: UsageView) => void;
  signal?: AbortSignal;
}) {
  return watchUsage({
    client: params.world.client,
    id: ID,
    onChange: params.onChange ?? (() => undefined),
    signal: params.signal ?? new AbortController().signal,
  });
}

/** Watches the usage to its end, and answers what it ended with and each usage it was told of. */
async function watched(world: ServedSubscription) {
  const changes: UsageView[] = [];
  const watch = await startWatch({ world, onChange: (usage) => changes.push(usage) });

  await watch.ended;

  return { usage: watch.usage(), changes };
}

/** A usage as a test reads it: each node and its calls, and the total's. */
const summary = (usage: UsageView) => ({
  nodes: usage.nodes.map(({ node, calls }) => `${node} ${String(calls)}`),
  total: usage.total.calls,
});

describe('watchUsage', () => {
  it('is the snapshot with each entry folded in, and tells of each change but the channel’s opening', async () => {
    const world = served({
      connections: [
        [
          MAIN_FIRST,
          usageEntry({ n: 2, node: 'helper', calls: 1, total: 2 }),
          usageEntry({ n: 3, node: 'main', calls: 2, total: 3 }),
          // The channel's opening is not usage: this entry changes nothing.
          usageOpened,
          OVER,
        ],
      ],
    });

    const { usage, changes } = await watched(world);

    expect(summary(usage)).toEqual({ nodes: ['main 2', 'helper 1'], total: 3 });
    expect(changes.map(summary)).toEqual([
      { nodes: ['main 1'], total: 1 },
      { nodes: ['main 1', 'helper 1'], total: 2 },
      { nodes: ['main 2', 'helper 1'], total: 3 },
    ]);
    expect(usage.total).toEqual(usageFigures(3));
    expect(world.asked()).toEqual([{ subscriptions: [{ channel: 'usage', from: 'snapshot' }] }]);
  });

  it('is, after a reconnect, the usage a snapshot of that moment gives, resuming after the last entry', async () => {
    const resumed = served({
      connections: [
        [MAIN_FIRST, usageEntry({ n: 2, node: 'main', calls: 2, total: 2 }), DROP],
        [usageEntry({ n: 3, node: 'helper', calls: 1, total: 3 }), OVER],
      ],
    });
    // A watcher that connects after all of it, and starts from the snapshot.
    const fresh = served({
      connections: [
        [
          usageSnapshot({
            n: 3,
            total: 3,
            nodes: [
              { node: 'main', calls: 2 },
              { node: 'helper', calls: 1 },
            ],
          }),
          OVER,
        ],
      ],
    });

    const { usage } = await watched(resumed);

    expect(usage).toEqual((await watched(fresh)).usage);
    expect(resumed.asked()[1]).toEqual({ subscriptions: [{ channel: 'usage', from: 's2' }] });
  });

  it('counts an entry told twice once: an entry says what a node now is, and the client adds nothing up', async () => {
    const entry = usageEntry({ n: 2, node: 'main', calls: 2, total: 2 });
    const world = served({ connections: [[MAIN_FIRST, entry, entry, OVER]] });

    const { usage } = await watched(world);

    expect(summary(usage)).toEqual({ nodes: ['main 2'], total: 2 });
  });

  it('drops the records of the nodes an entry says are no longer kept, and takes the total, which covers them', async () => {
    const world = served({
      connections: [
        [
          usageSnapshot({
            n: 2,
            total: 2,
            nodes: [
              { node: 'main', calls: 1 },
              { node: 'old', calls: 1 },
            ],
          }),
          usageEntry({ n: 3, node: 'new', calls: 1, total: 3, evicted: ['old'] }),
          OVER,
        ],
      ],
    });

    const { usage } = await watched(world);

    expect(summary(usage)).toEqual({ nodes: ['main 1', 'new 1'], total: 3 });
  });

  it('asks again from the snapshot when the server no longer holds its position, and the usage it gives replaces its own', async () => {
    const world = served({
      connections: [
        [MAIN_FIRST, usageEntry({ n: 2, node: 'helper', calls: 1, total: 2 }), DROP],
        { refuse: { status: 422, code: 'cursor_out_of_range' } },
        [usageSnapshot({ n: 9, total: 5, nodes: [{ node: 'main', calls: 5 }] }), OVER],
      ],
    });

    const { usage } = await watched(world);

    // `helper` was in the usage it had, and is not in the one the server gives now.
    expect(summary(usage)).toEqual({ nodes: ['main 5'], total: 5 });
    expect(world.asked().map(({ subscriptions }) => subscriptions[0]?.from)).toEqual([
      'snapshot',
      's2',
      'snapshot',
    ]);
  });

  it('rejects `ended` when the usage channel ends failed (its conversation closed): nothing more will come', async () => {
    const world = served({
      connections: [[MAIN_FIRST, endedAs({ name: 'usage', reason: 'failed' })]],
    });

    await expect(watched(world)).rejects.toBeInstanceOf(ChannelFailedError);
    expect(world.asked()).toHaveLength(1);
  });

  it('refuses a server that sends more nodes than a snapshot may hold, keeps the usage it had and is not asked again', async () => {
    const more = Array.from({ length: MAX_TREE_NODES }, (_, index) =>
      usageEntry({ n: index + 2, node: `n-${String(index)}`, calls: 1, total: index + 2 }),
    );
    const world = served({ connections: [[MAIN_FIRST, ...more, OVER]] });
    const told: UsageView[] = [];
    const watch = await startWatch({ world, onChange: (usage) => told.push(usage) });

    await expect(watch.ended).rejects.toBeInstanceOf(AnswerError);
    // The 1,001st node was refused before it was kept or told of.
    expect(watch.usage().nodes).toHaveLength(MAX_TREE_NODES);
    expect(told.at(-1)?.nodes).toHaveLength(MAX_TREE_NODES);
    expect(world.asked()).toHaveLength(1);
  });

  it('rejects `ended` with a refusal that asking again would not change, and at once for the first connection', async () => {
    const later = served({ connections: [[MAIN_FIRST, DROP], NOT_FOUND] });
    const first = served({ connections: [NOT_FOUND] });

    await expect(watched(later)).rejects.toBeInstanceOf(RefusedError);
    await expect(watched(first)).rejects.toBeInstanceOf(RefusedError);
  });

  it('ends quietly when its signal aborts, with the usage it had', async () => {
    const world = served({ connections: [[MAIN_FIRST]] });
    const leave = new AbortController();
    const first = Promise.withResolvers<undefined>();
    const watch = await startWatch({
      world,
      onChange: () => first.resolve(undefined),
      signal: leave.signal,
    });

    await first.promise;
    leave.abort();
    await watch.ended;

    expect(summary(watch.usage())).toEqual({ nodes: ['main 1'], total: 1 });
  });
});
