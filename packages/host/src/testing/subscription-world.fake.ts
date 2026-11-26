import type { ChannelFrom, ChannelLog } from '@sheavly/core/store/store.types';
import { channelNameSchema } from '@sheavly/protocol/channel/channel.validator';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { subscribeRequestSchema } from '@sheavly/protocol/subscription/subscription.validator';
import { conversation, conversationId } from '@sheavly/runtime/testing/stored-conversation.fake';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { HeldBytes } from '../subscriptions/held-bytes.service.js';
import { Subscription } from '../subscriptions/subscription.service.js';

type World = ReturnType<typeof conversation>;

/** Test-only: a request for one channel from `from`, as the contract parses it. */
export const requestOf = (channel: string, from = 'start') =>
  subscribeRequestSchema.parse({ subscriptions: [{ channel, from }] });

/**
 * Test-only: a request for the tree channel from `now` that claims to answer approvals, plus
 * `others` (`[name, from]`) channels, as the contract parses it.
 */
export const claimingApprovals = (others: [string, string][] = []) =>
  subscribeRequestSchema.parse({
    subscriptions: [
      { channel: 'tree', from: 'now' },
      ...others.map(([channel, from]) => ({ channel, from })),
    ],
    approvals: true,
  });

/** Test-only: what a promise that is refused rejects with, or undefined if it was not. */
export async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (caughtError) {
    return caughtError;
  }

  return undefined;
}

/** A read budget and a pool no test comes near. */
const BUDGET = 1_000_000;

/**
 * Test-only: opens a subscription to `channels` (`[name, from]`) of what `world` has stored, with
 * the roomy `BUDGET` and a pool of its own unless the test gives one.
 */
export function open(params: {
  world: World;
  channels: [string, string][];
  closed?: () => void;
  pool?: HeldBytes;
  signal?: AbortSignal;
}) {
  const { world, channels } = params;

  return Subscription.open({
    writer: world.writer,
    channels: channels.map(([name, from]) => ({
      channel: channelNameSchema.parse(name),
      from,
      kind: 'sequence',
      log: world.store.channel({ id: conversationId, channel: name }),
    })),
    budget: { left: BUDGET },
    pool: params.pool ?? new HeldBytes(BUDGET),
    signal: params.signal,
    onClose: params.closed ?? (() => undefined),
  });
}

/** Test-only: the next `count` frames, fewer if the frames end first. */
export async function take(frames: AsyncGenerator<SubscribeFrame>, count: number) {
  const taken: SubscribeFrame[] = [];

  for (let index = 0; index < count; index += 1) {
    const next = await frames.next();

    if (next.done) break;

    taken.push(next.value);
  }

  return taken;
}

/** Test-only: every frame until the frames end. */
export async function rest(frames: AsyncGenerator<SubscribeFrame>) {
  const all: SubscribeFrame[] = [];

  for await (const frame of frames) all.push(frame);

  return all;
}

/** Test-only: a frame as one line: its channel, then `type cursor`, or `end:reason cursor` for an end. */
export const line = (frame: SubscribeFrame) =>
  frame.type === 'end'
    ? `${frame.channel} end:${frame.reason} ${frame.cursor ?? '-'}`
    : `${frame.channel} ${frame.type} ${frame.cursor}`;

/** Test-only: the frames of a one-channel subscription without the channel, which only a test names. */
export const plain = (frames: SubscribeFrame[]) =>
  frames.map((frame) => line(frame).split(' ').slice(1).join(' '));

/** Test-only: the conversation's main agent: its channel is the node's id. */
export function agent() {
  const world = conversation();

  return { world, main: world.nodeOf(world.main.id) };
}

/** Test-only: the main agent after one change, stored: `opened s0`, `updated s1`. */
export async function idleAgent() {
  const { world, main } = agent();

  world.sessions.idle({ id: world.main.id, outcome: 'completed' });
  await world.writer.flush();

  return { world, main };
}

/** Test-only: resumes and ends the main agent (`updated s2`, `closed s3`), then reads `frames` to the end. */
export async function finishLife(params: { world: World; frames: AsyncGenerator<SubscribeFrame> }) {
  const { world, frames } = params;

  world.sessions.resume(world.main.id);
  world.sessions.end({ id: world.main.id, state: 'completed' });

  return plain(await rest(frames));
}

/** Test-only: the main agent's whole life: `opened s0`, `updated s1`, `updated s2`, `closed s3`. */
export async function wholeLife(world: World) {
  world.sessions.idle({ id: world.main.id, outcome: 'completed' });
  world.sessions.resume(world.main.id);
  world.sessions.end({ id: world.main.id, state: 'completed' });
  await world.writer.flush();
}

/** Test-only: starts a sub-agent of the main agent. */
export const spawn = (world: World) =>
  world.sessions.startChild({
    parentId: world.main.id,
    startedByCall: callIdSchema.parse('call_1'),
    title: 'Reader',
  });

/** Test-only: the main agent goes idle and runs again `cycles` times, two entries each, unawaited. */
export function churn(params: { world: World; cycles: number }) {
  for (let cycle = 0; cycle < params.cycles; cycle += 1) {
    params.world.sessions.idle({ id: params.world.main.id, outcome: 'completed' });
    params.world.sessions.resume(params.world.main.id);
  }
}

/**
 * Test-only: a subscription to the main agent's channel from its start whose read has begun and
 * waits (`store.release()` lets it go), on a store that takes the channel as it was `when` the read
 * began.
 */
export async function pausedStart(when: 'before' | 'after') {
  const store = new PausedReads(when);
  const world = conversation({ store });
  const main = world.nodeOf(world.main.id);

  await world.writer.flush();

  const opening = open({ world, channels: [[main, 'start']] });

  await store.reading.promise;

  return { store, world, opening };
}

/**
 * Test-only: a store whose channel reads wait once they have begun, so a test can write while one
 * is open. `before`: the read takes what the channel holds when it begins, so what is written while
 * it waits is not in it. `after`: it takes what the channel holds when it is let go, so that is in
 * it, and the writer told it too.
 */
export class PausedReads extends MemoryConversationStore {
  readonly reading = Promise.withResolvers<undefined>();
  readonly #go = Promise.withResolvers<undefined>();
  readonly #when: 'before' | 'after';

  constructor(when: 'before' | 'after') {
    super();
    this.#when = when;
  }

  release() {
    this.#go.resolve(undefined);
  }

  override channel(params: Parameters<MemoryConversationStore['channel']>[0]) {
    const log = super.channel(params);

    return {
      append: (entry: Parameters<ChannelLog['append']>[0]) => log.append(entry),
      head: () => log.head(),
      read: (from?: ChannelFrom) => this.#paused({ log, from }),
    };
  }

  async *#paused(params: { log: ChannelLog; from: ChannelFrom | undefined }) {
    const { log, from } = params;
    const held = async () => {
      const entries = [];

      for await (const entry of log.read(from)) entries.push(entry);

      return entries;
    };
    const before = this.#when === 'before' ? await held() : undefined;

    this.reading.resolve(undefined);
    await this.#go.promise;

    yield* before ?? (await held());
  }
}
