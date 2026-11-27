import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../client/transcript.types.js';
import { CardPlacer } from '../card-placer.service.js';
import { MAX_HELD_CARDS } from '../chat.constants.js';
import { feedItems } from '../testing/feed-items.fake.js';

type Items = ReturnType<typeof feedItems>;

/** A placer and the items to feed it; `card` is a sub-agent's card for the call `call`. */
function scene() {
  const items = feedItems();
  const placer = new CardPlacer();

  return {
    items,
    placer,
    card: (change: 'started' | 'status' | 'ended', call: string, node = 'worker') =>
      items.card(change, { node, spawnedBy: call }),
    /** What is drawn for each of `given`, one after the other. */
    place: (...given: ChatItem[]) => given.flatMap((item) => placer.place(item)),
  };
}

describe('CardPlacer: a card waits for the call that started its sub-agent', () => {
  it('holds a depth-2 card whose call the main agent has not shown, and draws it after the call', () => {
    const { items, card, place } = scene();
    const started = card('started', 'c1');
    const called = items.toolStarted('c1', 'Start a helper');

    expect(place(started)).toEqual([]);
    expect(place(called)).toEqual([called, started]);
  });

  it.each([
    ['becomes a task', (items: Items) => items.taskRunning('c1', 'Start a helper')],
    ['returns', (items: Items) => items.toolResult('c1', 'Start a helper')],
    [
      'was too large to store',
      (items: Items) => items.omitted({ eventType: 'tool_result', call: 'c1' }),
    ],
  ])('lets the card go when the call %s', (_name, make) => {
    const { items, card, place } = scene();
    const started = card('started', 'c1');
    const named = make(items);

    place(started);

    expect(place(named)).toEqual([named, started]);
  });

  it('holds the status and the end of the sub-agent behind its start, and lets all go in order', () => {
    const { items, card, place } = scene();
    const [started, status, ended] = [
      card('started', 'c1'),
      card('status', 'c1'),
      card('ended', 'c1'),
    ];
    const called = items.toolStarted('c1', 'Start a helper');

    expect(place(started, status, ended)).toEqual([]);
    expect(place(called)).toEqual([called, started, status, ended]);
  });

  it('draws what comes about the sub-agent after its call was shown at once', () => {
    const { items, card, place } = scene();
    const status = card('status', 'c1');

    place(card('started', 'c1'), items.toolStarted('c1', 'Start a helper'));

    expect(place(status)).toEqual([status]);
  });

  it('keeps the cards of one call apart from another call’s', () => {
    const { items, card, place } = scene();
    const [first, second] = [card('started', 'c1', 'a'), card('started', 'c2', 'b')];
    const calledSecond = items.toolStarted('c2', 'Start another');
    const calledFirst = items.toolStarted('c1', 'Start a helper');

    place(first, second);

    expect(place(calledSecond)).toEqual([calledSecond, second]);
    expect(place(calledFirst)).toEqual([calledFirst, first]);
  });
});

describe('CardPlacer: a card that waits for nothing is drawn at once', () => {
  it('draws a card with no call that started it', () => {
    const { items, place } = scene();
    const started = items.card('started');

    expect(place(started)).toEqual([started]);
  });

  it('draws a card of a deeper sub-agent, whose call is not on the main agent’s channel', () => {
    const { items, place } = scene();
    const started = items.card('started', { depth: 3, spawnedBy: 'c1' });

    expect(place(started)).toEqual([started]);
  });

  it('draws a card whose call the main agent showed before the card came', () => {
    const { items, card, place } = scene();
    const started = card('started', 'c1');

    place(items.toolStarted('c1', 'Start a helper'));

    expect(place(started)).toEqual([started]);
  });

  it('passes every other item through as it is, whatever is held', () => {
    const { items, card, place } = scene();
    const [text, notice] = [items.text('hi'), items.changed(['a'])];

    place(card('started', 'c1'));

    expect(place(text, notice)).toEqual([text, notice]);
    expect(place(items.toolStarted('c9', 'Other'))).toHaveLength(1);
  });
});

describe('CardPlacer: nothing waits for ever', () => {
  it('lets every held card go before the run’s done, so they are in the run', () => {
    const { items, card, place, placer } = scene();
    const [first, second] = [card('started', 'c1', 'a'), card('started', 'c2', 'b')];
    const done = items.done();

    place(first, second);

    expect(place(done)).toEqual([first, second, done]);
    expect(placer.drain()).toEqual([]);
  });

  it('lets the oldest go when more than the most wait', () => {
    const { card, place, placer } = scene();
    const cards = Array.from({ length: MAX_HELD_CARDS + 2 }, (_, index) =>
      card('started', `c${String(index)}`, `n${String(index)}`),
    );
    const given = cards.map((item) => place(item));

    expect(given.slice(0, MAX_HELD_CARDS).flat()).toEqual([]);
    expect(given[MAX_HELD_CARDS]).toEqual([cards[0]]);
    expect(given[MAX_HELD_CARDS + 1]).toEqual([cards[1]]);
    expect(placer.drain()).toEqual(cards.slice(2));
  });

  it('counts every held item of a sub-agent against the most, not only its start', () => {
    const { items, card, place, placer } = scene();
    const started = card('started', 'c1');
    const statuses = Array.from({ length: MAX_HELD_CARDS }, (_, index) =>
      items.card('status', { spawnedBy: 'c1', status: `step ${String(index)}` }),
    );
    const given = [started, ...statuses].map((item) => place(item));

    expect(given.at(-1)).toEqual([started]);
    expect(placer.drain()).toEqual(statuses);
  });

  it('lets go what is held when told, once, oldest first', () => {
    const { card, place, placer } = scene();
    const [first, second] = [card('started', 'c1', 'a'), card('started', 'c2', 'b')];

    place(first, second);

    expect(placer.drain()).toEqual([first, second]);
    expect(placer.drain()).toEqual([]);
  });
});
