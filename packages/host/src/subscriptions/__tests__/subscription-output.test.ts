import { describe, expect, it } from 'vitest';
import { MAX_OUTPUT_CHUNK_BYTES } from '@sheavly/protocol/channel/channel.constants';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { conversationId } from '@sheavly/runtime/testing/stored-conversation.fake';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { openOutput, pausedReads, runningCommand } from '../../testing/output-world.fake.js';
import { plain, refusalOf, rest, take } from '../../testing/subscription-world.fake.js';
import { HeldBytes } from '../held-bytes.service.js';

useFixedClock();

type RunningCommand = Awaited<ReturnType<typeof runningCommand>>;

/** A subscription to the command's output from `from`. */
const subscribeTo = (command: RunningCommand, from: string) =>
  openOutput({ ...command, reader: command.outputs, from });

/** The text and the offsets of the output entries among `frames`, in the order they came. */
function outputOf(frames: SubscribeFrame[]) {
  const entries = frames.flatMap((frame) =>
    frame.type === 'output' ? [{ offset: frame.offset, text: frame.text }] : [],
  );

  return { entries, text: entries.map((entry) => entry.text).join('') };
}

/** Whether each entry starts where the one before it ended, so the output has no gap and no repeat. */
const contiguous = (entries: { offset: number; text: string }[]) =>
  entries.every((entry, index) => {
    const before = entries[index - 1];

    return before === undefined || entry.offset === before.offset + Buffer.byteLength(before.text);
  });

describe('a command’s output on its channel', () => {
  it('is what is stored, then what comes, with the channel closed at its size: no gap and no repeat', async () => {
    const command = await runningCommand();

    command.print('one ');
    command.print('two ');

    const frames = (await subscribeTo(command, 'start')).frames();

    command.print('three');
    await command.finish();

    const all = await rest(frames);

    expect(plain(all)).toEqual([
      'opened b0',
      'output b8',
      'output b13',
      'closed b13',
      'end:completed b13',
    ]);
    expect(outputOf(all).text).toBe('one two three');
    expect(contiguous(outputOf(all).entries)).toBe(true);
  });

  it('serves a late subscriber of a command that has ended the whole output and how it ended', async () => {
    const command = await runningCommand();

    command.print('hello');
    await command.finish();

    const all = await rest((await subscribeTo(command, 'start')).frames());

    expect(plain(all)).toEqual(['opened b0', 'output b5', 'closed b5', 'end:completed b5']);
    expect(all.find((frame) => frame.type === 'closed')).toMatchObject({
      state: 'completed',
      exitCode: 0,
      output: { status: 'complete' },
    });
  });

  it('batches what is printed in a short while into one entry, sent without waiting for more', async () => {
    const command = await runningCommand();
    const frames = (await subscribeTo(command, 'now')).frames();

    await take(frames, 1);
    // One character at a time, as a progress bar does.
    for (const character of 'loading') command.print(character);

    const [entry] = await take(frames, 1);

    expect(entry).toMatchObject({ type: 'output', offset: 0, text: 'loading', cursor: 'b7' });
  });

  it('sends a chunk that fills an entry at once, and cuts a long one at 16 KiB', async () => {
    const command = await runningCommand();
    const frames = (await subscribeTo(command, 'now')).frames();

    await take(frames, 1);
    command.print('a'.repeat(MAX_OUTPUT_CHUNK_BYTES * 2 + 5));

    const sent = await take(frames, 3);

    expect(plain(sent)).toEqual(['output b16384', 'output b32768', 'output b32773']);
    expect(contiguous(outputOf(sent).entries)).toBe(true);
  });

  it('cuts between characters, in what is read from the store and in what is told', async () => {
    const command = await runningCommand();
    // Three bytes each: 16,384 is not a multiple of three, so a cut there is inside a character.
    const text = '€'.repeat(6_000);
    const live = (await subscribeTo(command, 'now')).frames();

    await take(live, 1);
    command.print(text);
    await command.finish();

    const told = outputOf(await rest(live));
    const read = outputOf(await rest((await subscribeTo(command, 'start')).frames()));

    expect(told.text).toBe(text);
    expect(read.text).toBe(text);
    expect(told.entries.map((entry) => entry.offset)).toEqual([0, 16_383]);
    expect(read.entries.map((entry) => entry.offset)).toEqual([0, 16_383]);
    expect(contiguous(told.entries) && contiguous(read.entries)).toBe(true);
  });
});

describe('the join of what is stored with what the command prints', () => {
  it('does not miss what is printed while the output is read, and does not repeat what the read held', async () => {
    const command = await runningCommand();
    const paused = pausedReads(command.outputs);

    command.print('abcd');

    const opening = openOutput({ ...command, reader: paused.reader, from: 'start' });

    await paused.reached;
    // Stored and told while the read waits: it is after what the read will hold.
    command.print('efgh');
    paused.release();

    const frames = (await opening).frames();

    await command.finish();

    const all = await rest(frames);

    expect(outputOf(all).text).toBe('abcdefgh');
    expect(outputOf(all).entries.map((entry) => entry.offset)).toEqual([0, 4]);
  });

  it('cuts a told chunk the read already held the start of, so the bytes it sends are exactly the ones after', async () => {
    const command = await runningCommand();
    const paused = pausedReads(command.outputs);

    command.print('abc');

    const opening = openOutput({ ...command, reader: paused.reader, from: 'start' });

    await paused.reached;
    // The read asks for three bytes and gets a whole character's room (four), so it holds `d` of
    // this chunk too, which is also told: only `ef` is new.
    command.print('def');
    paused.release();

    const frames = (await opening).frames();

    await command.finish();

    const all = await rest(frames);

    expect(outputOf(all).text).toBe('abcdef');
    expect(contiguous(outputOf(all).entries)).toBe(true);
  });
});

describe('where a request for the output starts', () => {
  it('is the last bytes, with the opened entry only when they reach the first', async () => {
    const command = await runningCommand();

    command.print('abcdefghij');

    const last = (await subscribeTo(command, 'tail:4')).frames();
    const all = (await subscribeTo(command, 'tail:100')).frames();

    expect(plain(await take(last, 1))).toEqual(['output b10']);
    expect(plain(await take(all, 2))).toEqual(['opened b0', 'output b10']);
    expect(outputOf(await take(last, 0)).text).toBe('');
  });

  it('is the bytes from a cursor, never the opened entry again, and one past the end is out of range', async () => {
    const command = await runningCommand();

    command.print('abcdefghij');

    const from = (await subscribeTo(command, 'b4')).frames();
    const [entry] = await take(from, 1);

    expect(entry).toMatchObject({ type: 'output', offset: 4, text: 'efghij', cursor: 'b10' });
    expect(await refusalOf(subscribeTo(command, 'b11'))).toMatchObject({
      reason: 'cursor_out_of_range',
    });
  });

  it('is only what comes, after the cursor where the output stands, at now', async () => {
    const command = await runningCommand();

    command.print('before');

    const frames = (await subscribeTo(command, 'now')).frames();

    command.print('after');
    await command.finish();

    expect(plain(await rest(frames))).toEqual([
      'head b6',
      'output b11',
      'closed b11',
      'end:completed b11',
    ]);
  });

  it('continues from the cursor of the last entry a client got, with nothing missed or repeated', async () => {
    const command = await runningCommand();

    command.print('abcdef');

    const first = await subscribeTo(command, 'start');
    const [, entry] = await take(first.frames(), 2);

    first.close();
    command.print('ghi');
    await command.finish();

    const resumed = await rest(
      (await subscribeTo(command, entry && 'cursor' in entry ? entry.cursor : 'b0')).frames(),
    );

    expect(plain(resumed)).toEqual(['output b9', 'closed b9', 'end:completed b9']);
    expect(outputOf(resumed).text).toBe('ghi');
  });
});

describe('a command whose output was not all kept', () => {
  it('says so on its closed entry, and what was served is the prefix that was kept', async () => {
    const command = await runningCommand();
    const frames = (await subscribeTo(command, 'start')).frames();

    command.print('abc');
    command.outputs.failAppends('the stored output reached its limit; later output was not kept');
    command.print('def');
    await command.finish();

    const all = await rest(frames);

    expect(outputOf(all).text).toBe('abc');
    expect(all.find((frame) => frame.type === 'closed')).toMatchObject({
      cursor: 'b3',
      output: {
        status: 'incomplete',
        reason: 'the stored output reached its limit; later output was not kept',
      },
    });
  });

  it('has the closed entry of a node that was lost stand where its output ends, not at 0', async () => {
    const command = await runningCommand();

    command.print('printed before the stop');

    // The stored channel as a stopped process leaves it: opened, and closed as lost with no size.
    await command.world.store
      .channel({ id: conversationId, channel: command.node })
      .append({ channel: command.node, cursor: 'b0', at: 9, type: 'closed', state: 'lost' });

    const all = await rest((await subscribeTo(command, 'start')).frames());

    expect(plain(all)).toEqual(['opened b0', 'output b23', 'closed b23', 'end:completed b23']);
  });
});

describe('a consumer that does not keep up', () => {
  it('is cut off with the cursor of the last frame it got, and continues from there with none missed', async () => {
    const command = await runningCommand();
    const chunk = 'x'.repeat(MAX_OUTPUT_CHUNK_BYTES);
    // Room for two entries of 16 KiB, not three.
    const pool = new HeldBytes(MAX_OUTPUT_CHUNK_BYTES * 2 + 1_000);
    const frames = (
      await openOutput({ ...command, reader: command.outputs, from: 'now', pool })
    ).frames();

    command.print(chunk);
    command.print(chunk);
    command.print(chunk);

    // What waited for the consumer is not sent to one that was cut off: it resumes from the head.
    expect(plain(await take(frames, 2))).toEqual(['head b0', 'end:cut_off b0']);

    await command.finish();

    const resumed = await rest((await subscribeTo(command, 'b0')).frames());

    expect(outputOf(resumed).text).toBe(chunk.repeat(3));
    expect(contiguous(outputOf(resumed).entries)).toBe(true);
    expect(plain(resumed).slice(-2)).toEqual(['closed b49152', 'end:completed b49152']);
  });
});

describe('closing a subscription', () => {
  it('stops following the command: what it prints after is told to nobody', async () => {
    const command = await runningCommand();
    const subscription = await subscribeTo(command, 'now');
    const frames = subscription.frames();

    await take(frames, 1);
    subscription.close();
    command.print('nobody hears this');
    await command.finish();

    expect(plain(await rest(frames))).toEqual([]);
  });
});
