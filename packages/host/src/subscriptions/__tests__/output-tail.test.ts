import { describe, expect, it } from 'vitest';
import type { ChannelEntry } from '@sheavly/core/store/store.types';
import { MAX_OUTPUT_CHUNK_BYTES } from '@sheavly/protocol/channel/channel.constants';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import { OutputTail } from '../output-tail.service.js';
import { MAX_EARLY_OUTPUT_BYTES, MAX_QUEUED_FRAMES } from '../subscriptions.constants.js';
import type { TailEnd } from '../subscriptions.types.js';

const clock = useFixedClock();

/** A tail whose entries and ends are kept; `refuse` is what `emit` answers, none for "queued". */
function tailOf(params: { delayMs?: number; refuse?: TailEnd } = {}) {
  const entries: ChannelEntry[] = [];
  const ended: TailEnd[] = [];
  const tail = new OutputTail({
    channel: 't1',
    delayMs: params.delayMs ?? 5,
    emit: (entry) => {
      entries.push(entry);

      return params.refuse;
    },
    onEnd: (reason) => ended.push(reason),
  });

  return { tail, entries, ended };
}

/** The entries as `offset:text`, which is all a join decides. */
const shown = (entries: ChannelEntry[]) =>
  entries.map((entry) => `${String(entry.offset)}:${String(entry.text)}`);

describe('joining what is told with the history that was read', () => {
  it('keeps what is told while the history is read, and sends only what starts where it ended', () => {
    const { tail, entries } = tailOf();

    tail.hear({ offset: 0, text: 'abcd' });
    tail.hear({ offset: 4, text: 'efgh' });
    tail.join(4);
    tail.flush();

    expect(shown(entries)).toEqual(['4:efgh']);
  });

  it('cuts a chunk that began inside the history, so only the bytes after it are sent', () => {
    const { tail, entries } = tailOf();

    tail.hear({ offset: 2, text: 'cdef' });
    tail.join(4);
    tail.flush();

    expect(shown(entries)).toEqual(['4:ef']);
    expect(entries[0]).toMatchObject({ cursor: 'b6' });
  });

  it('counts bytes, not characters, where it cuts', () => {
    const { tail, entries } = tailOf();

    // `é` is two bytes: the history ended after it, at byte 3.
    tail.hear({ offset: 1, text: 'éx' });
    tail.join(3);
    tail.flush();

    expect(shown(entries)).toEqual(['3:x']);
  });

  it('is cut off when a chunk starts after the end of what it holds: the client resumes and reads what lies between', () => {
    const { tail, entries, ended } = tailOf();

    tail.join(0);
    tail.hear({ offset: 5, text: 'x' });
    tail.flush();

    expect(ended).toEqual(['cut_off']);
    expect(entries).toEqual([]);
  });

  it('is cut off when more was told while the history was read than a subscription holds', () => {
    const { tail, entries, ended } = tailOf();

    for (let index = 0; index <= MAX_QUEUED_FRAMES; index += 1) {
      tail.hear({ offset: index, text: 'x' });
    }

    tail.join(0);

    expect(ended).toEqual(['cut_off']);
    expect(entries).toEqual([]);
  });

  it('is cut off when what was told while the history was read is more in bytes than it may keep, though few chunks', () => {
    const { tail, entries, ended } = tailOf();

    // One chunk of megabytes, as a command that writes in one go does.
    tail.hear({ offset: 0, text: 'x'.repeat(MAX_EARLY_OUTPUT_BYTES + 1) });
    tail.join(0);

    expect(ended).toEqual(['cut_off']);
    expect(entries).toEqual([]);
  });

  it('sends nothing after the end it reports while it replays what was told: a refused entry ends it for good', () => {
    const { tail, entries, ended } = tailOf({ refuse: 'cut_off' });
    const chunk = 'x'.repeat(MAX_OUTPUT_CHUNK_BYTES);

    // Five whole entries told while the history was read.
    for (let index = 0; index < 5; index += 1) {
      tail.hear({ offset: index * MAX_OUTPUT_CHUNK_BYTES, text: chunk });
    }

    tail.join(0);
    tail.flush();

    // The first is refused, and the other four are never offered: no frame follows the end.
    expect(ended).toEqual(['cut_off']);
    expect(entries).toHaveLength(1);
  });
});

describe('what it sends, and when', () => {
  it('sends what is told within the delay as one entry, once it has passed', async () => {
    const { tail, entries } = tailOf({ delayMs: 10 });

    tail.join(0);
    tail.hear({ offset: 0, text: 'a' });
    tail.hear({ offset: 1, text: 'b' });
    tail.hear({ offset: 2, text: 'c' });

    expect(entries).toEqual([]);

    await until(() => entries.length === 1);

    expect(shown(entries)).toEqual(['0:abc']);
    expect(tail.taken).toBe(3);
  });

  it('sends at once what is a whole entry, without waiting for the delay', () => {
    const { tail, entries } = tailOf({ delayMs: 60_000 });

    tail.join(0);
    tail.hear({ offset: 0, text: 'x'.repeat(MAX_OUTPUT_CHUNK_BYTES) });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ cursor: `b${String(MAX_OUTPUT_CHUNK_BYTES)}` });
  });

  it('sends what waits when asked to, before whatever comes next', () => {
    const { tail, entries } = tailOf({ delayMs: 60_000 });

    tail.join(0);
    tail.hear({ offset: 0, text: 'tail' });
    tail.flush();

    expect(shown(entries)).toEqual(['0:tail']);
  });

  it('keeps its entries to the cap and on character boundaries, with offsets that add up', () => {
    const { tail, entries } = tailOf();
    const text = '€'.repeat(6_000);

    tail.join(0);
    tail.hear({ offset: 0, text });

    expect(shown(entries).map((entry) => entry.split(':')[0])).toEqual(['0', '16383']);
    expect(entries.map((entry) => String(entry.text)).join('')).toBe(text);
  });

  it('keeps the offsets true to the stored bytes when the two halves of a pair are told apart: each is stored as a replacement character', () => {
    const { tail, entries } = tailOf();

    // The store holds each lone surrogate as U+FFFD, three bytes, so these are 3 + 3 + 1 bytes.
    tail.join(0);
    tail.hear({ offset: 0, text: '\uD83D' });
    tail.hear({ offset: 3, text: '\uDE00' });
    tail.hear({ offset: 6, text: 'a' });
    tail.flush();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ offset: 0, text: '\uFFFD\uFFFDa', cursor: 'b7' });
    expect(tail.taken).toBe(7);
  });

  it('stamps an entry with when its first bytes were told, not when it was sent', () => {
    const { tail, entries } = tailOf({ delayMs: 60_000 });
    const first = clock.at;

    tail.join(0);
    tail.hear({ offset: 0, text: 'a' });
    clock.advance(80);
    tail.hear({ offset: 1, text: 'b' });
    clock.advance(80);
    tail.flush();

    expect(entries[0]).toMatchObject({ text: 'ab', at: first });
  });

  it('stamps what was told while the history was read with when it was told, not when the history was joined', () => {
    const { tail, entries } = tailOf({ delayMs: 60_000 });
    const told = clock.at;

    tail.hear({ offset: 0, text: 'early' });
    // The history read goes on, and the command ends meanwhile: its closed entry is stamped now.
    clock.advance(1_000);
    tail.join(0);
    tail.flush();

    expect(entries[0]).toMatchObject({ text: 'early', at: told });
  });
});

describe('ending and stopping', () => {
  it('ends for the reason the consumer gave when it cannot take an entry, and says nothing more', () => {
    const { tail, entries, ended } = tailOf({ refuse: 'cut_off' });

    tail.join(0);
    tail.hear({ offset: 0, text: 'x'.repeat(MAX_OUTPUT_CHUNK_BYTES) });
    tail.hear({ offset: MAX_OUTPUT_CHUNK_BYTES, text: 'y'.repeat(MAX_OUTPUT_CHUNK_BYTES) });

    expect(ended).toEqual(['cut_off']);
    expect(entries).toHaveLength(1);
  });

  it('sends nothing once stopped, not even what waited, and its timer does not fire', async () => {
    const { tail, entries } = tailOf({ delayMs: 5 });

    tail.join(0);
    tail.hear({ offset: 0, text: 'waiting' });
    tail.stop();
    tail.hear({ offset: 7, text: 'late' });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(entries).toEqual([]);
  });

  it('is stopped by an end it reports, so its timer is not left running', async () => {
    const { tail, entries } = tailOf({ delayMs: 5 });

    tail.join(0);
    tail.hear({ offset: 0, text: 'x' });
    // A gap ends it while a timer waits.
    tail.hear({ offset: 9, text: 'y' });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(entries).toEqual([]);
  });
});
