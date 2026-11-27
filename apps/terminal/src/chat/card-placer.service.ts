import type { CallId } from '@sheavly/protocol/message/message.types';
import type { ChatItem } from '../client/transcript.types.js';
import { callNamedBy, endsRun } from './card-placer.utils.js';
import { MAX_HELD_CARDS, MAX_SEEN_CALLS } from './chat.constants.js';

type CardItem = Extract<ChatItem, { type: 'agent' }>;

/** A card item that waits for the call that started its sub-agent. */
type Held = { call: CallId; item: CardItem };

/**
 * Decides when a sub-agent's card is drawn, so it stands where the main agent calls the tool that
 * started it. The tree's items and the main agent's come with no order between them, so a card can
 * arrive before its call: a card of a sub-agent of the main agent (depth 2) that names the call
 * that started it is held, with every later item about the same sub-agent, in order, until the
 * main agent shows the call (it starts, becomes a task, returns or was too large to store).
 * A card with no call, one of a deeper sub-agent (its call is in an agent's history this channel
 * does not carry) and one whose call was shown already are drawn at once. Nothing waits for ever:
 * at most `MAX_HELD_CARDS` items wait, the oldest giving way, and the run's end lets all go.
 *
 * Pure of I/O: `place` and `drain` give the items to draw now, in order.
 */
export class CardPlacer {
  /** The calls the main agent has shown, oldest first; a call seen is never waited for. */
  readonly #seen = new Set<CallId>();
  /** The items waiting, oldest first. */
  #held: Held[] = [];

  /**
   * Takes the next item of the feed, in the order the feed told it, and gives what is drawn now:
   * an item that waits for nothing as it is, with the cards its call lets go after it (a run's end
   * lets them go before it, so they are in the run).
   */
  place(item: ChatItem): ChatItem[] {
    if (item.type === 'agent') return this.#placeCard(item);

    const call = callNamedBy(item);

    if (call !== undefined) return [item, ...this.#see(call)];

    if (endsRun(item)) return [...this.drain(), item];

    return [item];
  }

  /** Lets go everything that waits, oldest first: a run is over, or nothing more will come. */
  drain(): ChatItem[] {
    const items = this.#held.map(({ item }) => item);

    this.#held = [];

    return items;
  }

  #placeCard(item: CardItem): ChatItem[] {
    const { agent } = item;
    const waiting = this.#held.find((held) => held.item.agent.id === agent.id);
    const call = waiting?.call ?? this.#callToWaitFor(agent);

    if (call === undefined) return [item];

    this.#held.push({ call, item });

    return this.#heldOver().map(({ item: over }) => over);
  }

  /** The call a new sub-agent's card waits for, if it must wait: one the main agent has not shown. */
  #callToWaitFor(agent: CardItem['agent']): CallId | undefined {
    if (agent.depth !== 2 || agent.spawnedBy === undefined) return undefined;

    return this.#seen.has(agent.spawnedBy) ? undefined : agent.spawnedBy;
  }

  /** Takes the oldest items off the wait while more than `MAX_HELD_CARDS` wait. */
  #heldOver(): Held[] {
    return this.#held.splice(0, Math.max(0, this.#held.length - MAX_HELD_CARDS));
  }

  /** Notes the main agent showed `call`, and lets go the cards that waited for it. */
  #see(call: CallId): ChatItem[] {
    this.#seen.add(call);

    const [oldest] = this.#seen;

    if (this.#seen.size > MAX_SEEN_CALLS && oldest !== undefined) this.#seen.delete(oldest);

    const ready = this.#held.filter((held) => held.call === call);

    this.#held = this.#held.filter((held) => held.call !== call);

    return ready.map(({ item }) => item);
  }
}
