import { describe, expect, it } from 'vitest';
import { MAX_OUTPUT_CHUNK_BYTES } from '@sheavly/protocol/channel/channel.constants';
import { conversationId } from '@sheavly/runtime/testing/stored-conversation.fake';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import {
  countedReads,
  openOutput,
  pausedReads,
  runningCommand,
} from '../../testing/output-world.fake.js';
import { plain, refusalOf, rest, take } from '../../testing/subscription-world.fake.js';
import { HeldBytes } from '../held-bytes.service.js';
import { outputRefOf } from '../subscription-read.helper.js';

// What bounds a command's output channel, and what it does at its limits.

const clock = useFixedClock();

type RunningCommand = Awaited<ReturnType<typeof runningCommand>>;

/** A subscription to the command's output from `from`. */
const subscribeTo = (command: RunningCommand, from: string) =>
  openOutput({ ...command, reader: command.outputs, from });

describe('a channel that is cut off while what was told during the history read is replayed', () => {
  it('gets no frame after its end, and the bytes it did not get are read from the store', async () => {
    const command = await runningCommand();
    const paused = pausedReads(command.outputs);
    const chunk = 'x'.repeat(MAX_OUTPUT_CHUNK_BYTES);

    // Something to read, so the read begins and waits; room for the first frames and not for more.
    command.print('seed');

    const pool = new HeldBytes(20_000);
    const opening = openOutput({ ...command, reader: paused.reader, from: 'start', pool });

    await paused.reached;
    // Five whole entries, told while the history is read: the second does not fit the pool.
    for (let each = 0; each < 5; each += 1) command.print(chunk);

    paused.release();

    const frames = (await opening).frames();

    await command.finish();

    // The end is the last frame: what was left of what was told is not sent behind it.
    expect(plain(await rest(frames))).toEqual(['opened b0', 'output b4', 'end:cut_off b4']);

    const resumed = await rest((await subscribeTo(command, 'b4')).frames());
    const text = resumed.flatMap((frame) => (frame.type === 'output' ? [frame.text] : []));

    expect(text.join('')).toBe(chunk.repeat(5));
  });
});

describe('letting go of the capture', () => {
  it('is done when the subscription is closed', async () => {
    const command = await runningCommand();
    const followers = { active: 0 };
    const subscription = await openOutput({
      ...command,
      reader: command.outputs,
      from: 'now',
      followers,
    });

    expect(followers.active).toBe(1);

    subscription.close();

    expect(followers.active).toBe(0);
  });

  it('is done when the command ends and its channel completes', async () => {
    const command = await runningCommand();
    const followers = { active: 0 };
    const frames = (
      await openOutput({ ...command, reader: command.outputs, from: 'now', followers })
    ).frames();

    command.print('x');
    await command.finish();
    await rest(frames);

    expect(followers.active).toBe(0);
  });

  it('is done when the consumer is cut off', async () => {
    const command = await runningCommand();
    const followers = { active: 0 };
    // Not even room for one entry of 16 KiB.
    const pool = new HeldBytes(MAX_OUTPUT_CHUNK_BYTES / 2);
    const frames = (
      await openOutput({ ...command, reader: command.outputs, from: 'now', pool, followers })
    ).frames();

    command.print('x'.repeat(MAX_OUTPUT_CHUNK_BYTES));

    expect(plain(await take(frames, 2))).toEqual(['head b0', 'end:cut_off b0']);
    expect(followers.active).toBe(0);
  });
});

describe('a read that cannot fit the request', () => {
  /** A `start` on 30,000 bytes of output with `budget` to read it in: what it said and what it read. */
  async function refusedStart(budget: number) {
    const command = await runningCommand();
    const counted = countedReads(command.outputs);
    const pool = new HeldBytes(1_000_000);

    command.print('x'.repeat(30_000));

    const refusal = await refusalOf(
      openOutput({ ...command, reader: counted.reader, from: 'start', pool, budget }),
    );

    // Whatever it held is given back: all of the pool is there to take again.
    expect(pool.take(1_000_000)).toBe(true);

    return { refusal, reads: counted.reads.count };
  }

  it('is refused before a byte of the output is read when even the cheapest text would not fit', async () => {
    // A third of 30,000 is over 5,000.
    expect(await refusedStart(5_000)).toMatchObject({
      refusal: { reason: 'bad_request' },
      reads: 0,
    });
  });

  it('is refused when what it reads outgrows the budget, after reading up to it', async () => {
    // One byte to a character of JSON: a third of it is under 20,000, so it is not refused up front.
    const { refusal, reads } = await refusedStart(20_000);

    expect(refusal).toMatchObject({ reason: 'bad_request' });
    expect(reads).toBeGreaterThan(0);
  });
});

describe('when what a finished command printed is said to have been', () => {
  it('is when it ended, never later than its closed entry, whenever it is read', async () => {
    const command = await runningCommand();

    command.print('done');
    await command.finish();
    clock.advance(60_000);

    const all = await rest((await subscribeTo(command, 'start')).frames());
    const output = all.find((frame) => frame.type === 'output');
    const closed = all.find((frame) => frame.type === 'closed');

    expect(output?.at).toBe(closed?.at);
  });
});

describe('which channels expose an output log', () => {
  it('is a command’s own channel, which names the log its node kept', async () => {
    const command = await runningCommand();
    const log = command.world.store.channel({ id: conversationId, channel: command.node });

    expect(await outputRefOf({ log, channel: command.node })).toBe(command.ref);
    // Not for a channel that is not the node's own.
    expect(await outputRefOf({ log, channel: 'another-channel' })).toBeUndefined();
  });

  it('is not an agent’s channel, nor a kind an extension adds, even one that carries a log', async () => {
    const command = await runningCommand();
    const agent = command.world.nodeOf(command.world.main.id);

    await command.world.writer.flush();

    const extension = command.world.store.channel({ id: conversationId, channel: 'notes1' });

    await extension.append({
      channel: 'notes1',
      cursor: 'b0',
      at: 1,
      type: 'opened',
      node: {
        id: 'notes1',
        kind: 'notes.sync',
        title: 'Sync',
        state: 'running',
        startedAt: 1,
        outputLog: { ref: command.ref, bytes: 0, status: 'capturing' },
      },
    });

    expect(
      await outputRefOf({
        log: command.world.store.channel({ id: conversationId, channel: agent }),
        channel: agent,
      }),
    ).toBeUndefined();
    expect(await outputRefOf({ log: extension, channel: 'notes1' })).toBeUndefined();
  });
});
