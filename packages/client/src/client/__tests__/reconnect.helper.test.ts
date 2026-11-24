import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { StreamLostError, RefusedError } from '../../errors/client.errors.js';
import { sseBody, taskEntry as entry } from '../../testing/sse-body.fake.js';
import { RECONNECT_MAX_MS } from '../reconnect.constants.js';
import { reconnectingEntries } from '../reconnect.helper.js';

/** A body that sends the entries of `seqs`, then ends cleanly or, with `dropWith`, fails. */
function body(params: { seqs: number[]; dropWith?: Error }) {
  const { seqs, dropWith } = params;

  return sseBody({ entries: seqs.map(entry), ...(dropWith && { dropWith }) });
}

/** Opens each connection from `steps` in turn; a step that is an Error is a failed open. */
function opener(steps: (ReadableStream<Uint8Array> | Error)[]) {
  const resumed: (number | undefined)[] = [];
  const open = ({ lastEventId }: { lastEventId: number | undefined }) => {
    resumed.push(lastEventId);

    const step = steps[resumed.length - 1];

    if (step === undefined) return Promise.reject(new Error('no more connections'));

    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  };

  return { open, resumed };
}

function waits() {
  const slept: number[] = [];

  const wait = ({ ms }: { ms: number }) => {
    slept.push(ms);

    return Promise.resolve();
  };

  return { slept, wait };
}

async function seqsOf(entries: AsyncIterable<{ seq: number }>) {
  const seen: number[] = [];

  for await (const each of entries) seen.push(each.seq);

  return seen;
}

describe('reconnectingEntries', () => {
  it('reconnects after a drop mid-run and hears each entry once, in order, with no gap', async () => {
    const { open, resumed } = opener([
      body({ seqs: [0, 1], dropWith: new TypeError('terminated') }),
      // A backend replaying from the id it was given may repeat the last entry: it is skipped.
      body({ seqs: [1, 2, 3] }),
    ]);
    const { wait, slept } = waits();

    const seen = await seqsOf(
      reconnectingEntries({ open, wait, signal: new AbortController().signal }),
    );

    expect(seen).toEqual([0, 1, 2, 3]);
    expect(resumed).toEqual([undefined, 1]);
    expect(slept).toEqual([250]);
  });

  it('ends when the stream ends cleanly, without reconnecting', async () => {
    const { open, resumed } = opener([body({ seqs: [0, 1] })]);

    const seen = await seqsOf(
      reconnectingEntries({ open, wait: waits().wait, signal: new AbortController().signal }),
    );

    expect(seen).toEqual([0, 1]);
    expect(resumed).toEqual([undefined]);
  });

  it('takes a clean end of an endless stream for a drop: the backend cut it', async () => {
    const stop = new AbortController();
    const { open, resumed } = opener([body({ seqs: [0, 1] }), body({ seqs: [2] })]);
    const seen: number[] = [];

    for await (const each of reconnectingEntries({
      open,
      wait: waits().wait,
      endless: true,
      signal: stop.signal,
    })) {
      seen.push(each.seq);
      if (each.seq === 2) stop.abort();
    }

    expect(seen).toEqual([0, 1, 2]);
    expect(resumed).toEqual([undefined, 1]);
  });

  it('gives up with a typed lost error that says where it stopped, backing off up to a cap', async () => {
    const down = new TypeError('fetch failed');
    const { open } = opener([
      body({ seqs: [0], dropWith: down }),
      ...Array.from({ length: 10 }, () => down),
    ]);
    const { wait, slept } = waits();
    const lost = await seqsOf(
      reconnectingEntries({ open, wait, attempts: 7, signal: new AbortController().signal }),
    ).catch((caughtError: unknown) => caughtError);

    expect(lost).toBeInstanceOf(StreamLostError);
    expect(lost).toMatchObject({ lastEventId: 0, attempts: 7, cause: down });
    expect(slept).toEqual([250, 500, 1000, 2000, 4000, RECONNECT_MAX_MS, RECONNECT_MAX_MS]);
  });

  it('keeps trying for as long as the budget lasts, however many attempts that takes', async () => {
    const down = new TypeError('fetch failed');
    const { open } = opener([...Array.from({ length: 200 }, () => down), body({ seqs: [0, 1] })]);
    const { wait, slept } = waits();
    const stream = reconnectingEntries({ open, wait, signal: new AbortController().signal });

    expect(await seqsOf(stream)).toEqual([0, 1]);
    expect(slept).toHaveLength(200);
    expect(slept.at(-1)).toBe(RECONNECT_MAX_MS);
  });

  it('gives up once the attempts have failed for the whole budget, saying how many it made', async () => {
    const down = new TypeError('fetch failed');
    const { open } = opener(Array.from({ length: 50 }, () => down));
    const { wait } = waits();
    // Every attempt costs 4 s of time awake; a budget of 10 s is spent at the third failure.
    let clock = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 4000));

    try {
      const lost = await seqsOf(
        reconnectingEntries({ open, wait, budgetMs: 10_000, signal: new AbortController().signal }),
      ).catch((caughtError: unknown) => caughtError);

      expect(lost).toBeInstanceOf(StreamLostError);
      expect(lost).toMatchObject({ attempts: 2, cause: down });
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves no abort listener on the signal for each wait it made, however many', async () => {
    const down = new TypeError('fetch failed');
    const { open } = opener([...Array.from({ length: 30 }, () => down), body({ seqs: [0] })]);
    const controller = new AbortController();

    vi.useFakeTimers();

    try {
      const reading = seqsOf(reconnectingEntries({ open, signal: controller.signal }));

      await vi.runAllTimersAsync();

      expect(await reading).toEqual([0]);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts only attempts in a row: an entry arriving starts the count again', async () => {
    const down = new TypeError('fetch failed');
    const { open } = opener([down, body({ seqs: [0], dropWith: down }), down, body({ seqs: [1] })]);
    const { wait, slept } = waits();

    const seen = await seqsOf(
      reconnectingEntries({ open, wait, attempts: 2, signal: new AbortController().signal }),
    );

    expect(seen).toEqual([0, 1]);
    // Without the reset the third failure would be the first past `attempts`, and give up.
    expect(slept).toEqual([250, 250, 500]);
  });

  it('counts a connection that stayed up as healthy: an idle stream cut now and then is not lost', async () => {
    const cut = () => body({ seqs: [], dropWith: new TypeError('cut') });
    const { open } = opener([cut(), cut(), cut(), body({ seqs: [0] })]);
    const { wait, slept } = waits();
    // Each connection stays up a minute before it is cut: stable, so no failure adds up.
    let clock = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 60_000));

    try {
      const seen = await seqsOf(
        reconnectingEntries({ open, wait, attempts: 1, signal: new AbortController().signal }),
      );

      expect(seen).toEqual([0]);
      expect(slept).toEqual([250, 250, 250]);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not count the time an open waited as a connection that stayed up', async () => {
    const down = new TypeError('no answer');
    const { open } = opener([down, down, down]);
    // Every attempt takes a minute to fail, but none had a stream open.
    let clock = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 60_000));

    try {
      await expect(
        seqsOf(
          reconnectingEntries({
            open,
            wait: waits().wait,
            attempts: 2,
            signal: new AbortController().signal,
          }),
        ),
      ).rejects.toBeInstanceOf(StreamLostError);
    } finally {
      spy.mockRestore();
    }
  });

  it('resumes after the head frame when the stream drops before any entry', async () => {
    const { open, resumed } = opener([
      sseBody({ entries: [], head: 41, dropWith: new TypeError('cut') }),
      body({ seqs: [42, 43] }),
    ]);

    const seen = await seqsOf(
      reconnectingEntries({ open, wait: waits().wait, signal: new AbortController().signal }),
    );

    // Nothing was received, yet the reconnect asks for what came after the head.
    expect(resumed).toEqual([undefined, 41]);
    expect(seen).toEqual([42, 43]);
  });

  it.each(['', '-5', '1e3', '0x10', '4 2'])(
    'ignores a head frame whose id (%j) is not a plain non-negative integer',
    async (id) => {
      const encoder = new TextEncoder();
      const odd = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`id: ${id}\n\n`));
          controller.error(new TypeError('cut'));
        },
      });
      const { open, resumed } = opener([odd, body({ seqs: [0] })]);

      await seqsOf(
        reconnectingEntries({ open, wait: waits().wait, signal: new AbortController().signal }),
      );

      // Not taken for a position: entry 0 is still delivered, with no id to resume after.
      expect(resumed).toEqual([undefined, undefined]);
    },
  );

  it('does not let a head frame move a stream that already has entries', async () => {
    const { open, resumed } = opener([
      body({ seqs: [10], dropWith: new TypeError('cut') }),
      sseBody({ entries: [], head: 99 }),
    ]);

    await seqsOf(
      reconnectingEntries({ open, wait: waits().wait, signal: new AbortController().signal }),
    );

    expect(resumed).toEqual([undefined, 10]);
  });

  it('does not retry a refusal: asking again gets the same answer', async () => {
    const refused = new RefusedError({ status: 404, code: 'not_found', message: 'gone' });
    const { open, resumed } = opener([refused]);

    await expect(
      seqsOf(
        reconnectingEntries({ open, wait: waits().wait, signal: new AbortController().signal }),
      ),
    ).rejects.toBe(refused);
    expect(resumed).toEqual([undefined]);
  });

  it('retries a backend that failed (5xx)', async () => {
    const failed = new RefusedError({ status: 503, code: undefined, message: 'down' });
    const { open } = opener([failed, body({ seqs: [0] })]);

    const seen = await seqsOf(
      reconnectingEntries({ open, wait: waits().wait, signal: new AbortController().signal }),
    );

    expect(seen).toEqual([0]);
  });

  it('ends quietly when stopped, even while waiting to reconnect', async () => {
    const stop = new AbortController();
    const { open } = opener([body({ seqs: [0], dropWith: new TypeError('terminated') })]);
    const wait = () => {
      stop.abort();

      return Promise.resolve();
    };

    const seen = await seqsOf(reconnectingEntries({ open, wait, signal: stop.signal }));

    expect(seen).toEqual([0]);
  });
});
