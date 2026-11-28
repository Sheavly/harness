import { describe, expect, it } from 'vitest';
import { OrderedQueue } from '../queue.service.js';

const later = <T>(value: T, ms: number) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

type Named = {
  name: string;
};
const item = (name: string): Named => ({ name });

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];

  for await (const value of iterable) out.push(value);

  return out;
}

describe('OrderedQueue', () => {
  it('releases an item with nothing ahead of it as it is enqueued, and tells onRelease', () => {
    const released: string[] = [];
    const queue = new OrderedQueue<Named>({
      onRelease: (next) => released.push(`${String(next.seq)}:${next.name}`),
    });

    queue.enqueue(item('first'));
    released.push('after enqueue'); // synchronous: `first` was already released

    expect(released).toEqual(['0:first', 'after enqueue']);
  });

  it('tells onRelease in release order, a pending item holding back the ones behind it', async () => {
    const released: string[] = [];
    const queue = new OrderedQueue<Named>({ onRelease: (next) => released.push(next.name) });

    queue.enqueue(later(item('slow'), 10));
    queue.enqueue(item('sync'));
    queue.close();
    await collect(queue);

    expect(released).toEqual(['slow', 'sync']);
  });

  it('fails the stream, never the producer, when onRelease throws, on either path', async () => {
    const broken = () => {
      throw new Error('observer broke');
    };
    const now = new OrderedQueue<Named>({ onRelease: broken });
    const queued = new OrderedQueue<Named>({ onRelease: broken });

    expect(() => now.enqueue(item('now'))).not.toThrow();
    queued.enqueue(later(item('slow'), 1));
    queued.enqueue(item('queued'));

    await expect(collect(now)).rejects.toThrow('observer broke');
    await expect(collect(queued)).rejects.toThrow('observer broke');
  });

  it('yields in enqueue order, not resolve order, with contiguous seq numbers', async () => {
    const queue = new OrderedQueue<Named>();

    queue.enqueue(later(item('slow'), 30));
    queue.enqueue(later(item('fast'), 1));
    queue.enqueue(item('sync'));
    queue.close();

    expect(await collect(queue)).toEqual([
      { seq: 0, name: 'slow' },
      { seq: 1, name: 'fast' },
      { seq: 2, name: 'sync' },
    ]);
  });

  it('holds plain items behind a pending one', async () => {
    const queue = new OrderedQueue<Named>();
    let release!: (value: Named) => void;

    queue.enqueue(new Promise<Named>((resolve) => (release = resolve)));
    queue.enqueue(item('after'));
    queue.close();

    const seen: string[] = [];
    const consumed = (async () => {
      for await (const value of queue) seen.push(value.name);
    })();

    await later(null, 10);
    expect(seen).toEqual([]); // still waiting on the first item

    release(item('first'));
    await consumed;
    expect(seen).toEqual(['first', 'after']);
  });

  it("yields items as they're released, before the queue is closed", async () => {
    const queue = new OrderedQueue<Named>();
    const iterator = queue[Symbol.asyncIterator]();

    queue.enqueue(item('a'));
    expect(await iterator.next()).toEqual({ done: false, value: { seq: 0, name: 'a' } });

    queue.enqueue(later(item('b'), 5));
    expect(await iterator.next()).toEqual({ done: false, value: { seq: 1, name: 'b' } });

    queue.close();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it('fail() ends the stream with the error, after already-enqueued items', async () => {
    const queue = new OrderedQueue<Named>();

    queue.enqueue(item('a'));
    queue.fail(new Error('boom'));

    const seen: string[] = [];

    await expect(
      (async () => {
        for await (const value of queue) seen.push(value.name);
      })(),
    ).rejects.toThrow('boom');
    expect(seen).toEqual(['a']);
  });

  it('a rejected item ends the stream with its error', async () => {
    const queue = new OrderedQueue<Named>();

    queue.enqueue(item('a'));
    queue.enqueue(Promise.reject(new Error('bad item')));
    queue.enqueue(item('never'));
    queue.close();

    await expect(collect(queue)).rejects.toThrow('bad item');
  });

  it('consumed() waits until the consumer has handled everything enqueued so far', async () => {
    const queue = new OrderedQueue<Named>();

    queue.enqueue(item('a'));
    queue.enqueue(item('b'));

    let handled = 0;
    let consumedResolved = false;

    void queue.consumed().then(() => (consumedResolved = true));

    const iterator = queue[Symbol.asyncIterator]();

    await iterator.next(); // got "a"; still being handled
    handled++;
    await later(null, 5);
    expect(consumedResolved).toBe(false);

    await iterator.next(); // done with "a", got "b"
    handled++;
    await later(null, 5);
    expect(consumedResolved).toBe(false); // "b" is still being handled

    const end = iterator.next(); // done with "b"

    await later(null, 5);
    expect(consumedResolved).toBe(true);
    expect(handled).toBe(2);

    queue.close();
    await end;
  });

  it('consumed() resolves if the consumer stops early', async () => {
    const queue = new OrderedQueue<Named>();

    queue.enqueue(item('a'));
    queue.enqueue(item('b'));

    for await (const _ of queue) break;
    await expect(queue.consumed()).resolves.toBeUndefined();
  });
});
