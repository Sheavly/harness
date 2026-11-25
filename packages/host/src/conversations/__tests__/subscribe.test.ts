import { describe, expect, it } from 'vitest';
import { readChannel } from '@sheavly/runtime/testing/stored-channels.fake';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { subscribeRequestSchema } from '@sheavly/protocol/subscription/subscription.validator';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { ConversationsError } from '../../errors/conversations.errors.js';
import { SubscriptionError } from '../../errors/subscription.errors.js';
import type { Subscription } from '../../subscriptions/subscription.service.js';
import {
  MAX_SUBSCRIPTION_CONNECTIONS,
  NO_SUCH_CHANNEL,
} from '../../subscriptions/subscriptions.constants.js';
import { say, scriptedConversations } from '../../testing/conversations.fake.js';
import { ranOnePrompt } from '../../testing/stored-conversation.fake.js';
import type { Conversations } from '../conversations.service.js';

/** A request for one channel from `from`, as the contract parses it. */
const requestOf = (channel: string, from = 'start') =>
  subscribeRequestSchema.parse({ subscriptions: [{ channel, from }] });

/** What a promise that is refused rejects with, or undefined if it was not. */
async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (caughtError) {
    return caughtError;
  }

  return undefined;
}

/** Asks for `from` once more than a conversation may hold connections, and gives each refusal. */
async function refusedOften(params: {
  conversations: Conversations;
  id: ConversationId;
  channel: string;
  from: string;
}) {
  const refusals: unknown[] = [];

  for (let attempt = 0; attempt <= MAX_SUBSCRIPTION_CONNECTIONS; attempt += 1) {
    const request = requestOf(params.channel, params.from);

    refusals.push(await refusalOf(params.conversations.subscribe({ id: params.id, request })));
  }

  return refusals;
}

/** Takes every place a conversation has to give, each a subscription at now, and gives them. */
async function fillPlaces(params: {
  conversations: Conversations;
  id: ConversationId;
  channel: string;
}) {
  const held: Subscription[] = [];

  for (let count = 0; count < MAX_SUBSCRIPTION_CONNECTIONS; count += 1) {
    const request = requestOf(params.channel, 'now');

    held.push(await params.conversations.subscribe({ id: params.id, request }));
  }

  return held;
}

/** Every frame until the subscription ends. */
async function drain(subscription: Subscription) {
  const all: SubscribeFrame[] = [];

  for await (const frame of subscription.frames()) all.push(frame);

  return all;
}

/** A frame as `type cursor`; an end frame has the reason in its type's place. */
const tag = (frame: SubscribeFrame) =>
  frame.type === 'end' ? `end:${frame.reason}` : `${frame.type} ${frame.cursor}`;

/**
 * A kept conversation that ran a prompt, and the name of its main agent's channel. `store` and
 * `conversations` are the ones it lives in, so another conversation can be started beside it.
 */
async function stored() {
  const store = new MemoryConversationStore();
  const { id, conversations } = await ranOnePrompt(store);

  await conversations.get(id).harness.nodeChannels?.flush();

  const [channel = ''] = await store.channels(id);

  return { store, id, conversations, channel };
}

describe('subscribing to a conversation’s channels', () => {
  it('serves what is stored, and ends with its channel when the conversation closes', async () => {
    const { store, id, conversations, channel } = await stored();
    const subscription = await conversations.subscribe({ id, request: requestOf(channel) });

    // Nothing has been read yet when the conversation closes, and its channel with it.
    await conversations.close(id);

    const heard = await drain(subscription);
    const entries = await readChannel({ store, id, channel });

    expect(entries.at(-1)?.type).toBe('closed');
    expect(heard.map(tag)).toEqual([
      ...entries.map((each) => `${each.type} ${each.cursor}`),
      'end:completed',
    ]);
    expect(heard.at(-1)).toMatchObject({ cursor: entries.at(-1)?.cursor });
  });

  it('says a conversation that has closed is not found', async () => {
    const { id, conversations, channel } = await stored();

    await conversations.close(id);

    expect(
      await refusalOf(conversations.subscribe({ id, request: requestOf(channel) })),
    ).toMatchObject({ reason: 'not_found' });
  });

  it('says a conversation that never was is not found', async () => {
    const { conversations, channel } = await stored();
    const never = conversationIdSchema.parse('00000000-0000-4000-8000-000000000000');
    const refusal = await refusalOf(
      conversations.subscribe({ id: never, request: requestOf(channel) }),
    );

    expect(refusal).toBeInstanceOf(ConversationsError);
    expect(refusal).toMatchObject({ reason: 'not_found' });
  });
});

describe('a channel the conversation does not have', () => {
  it('is told the same whether it is another conversation’s, unknown, or the tree', async () => {
    const { store, id, conversations } = await stored();
    const other = await conversations.start();

    await conversations.get(other).harness.nodeChannels?.flush();

    const [foreign = ''] = await store.channels(other);

    expect(foreign).not.toBe('');

    for (const name of [foreign, 'no-such-node', 'tree']) {
      const refusal = await refusalOf(conversations.subscribe({ id, request: requestOf(name) }));

      expect(refusal).toBeInstanceOf(ConversationsError);
      expect(refusal).toMatchObject({ reason: 'not_found', message: NO_SUCH_CHANNEL });
    }
  });

  it('is not found for a host that keeps nothing, whatever the name', async () => {
    const { conversations } = scriptedConversations({ replies: [say('one')] });
    const id = await conversations.start();
    const refusal = await refusalOf(conversations.subscribe({ id, request: requestOf('node-1') }));

    expect(refusal).toMatchObject({ reason: 'not_found', message: NO_SUCH_CHANNEL });
  });
});

describe('a request the conversation cannot serve', () => {
  it.each([
    ['a tail over what a numbered channel allows', 'tail:1001', 'bad_request'],
    ['a byte cursor on a numbered channel', 'b3', 'bad_request'],
    ['a cursor the channel does not hold', 's999', 'cursor_out_of_range'],
  ])('refuses %s as %s', async (_name, from, reason) => {
    const { id, conversations, channel } = await stored();
    const refusal = await refusalOf(
      conversations.subscribe({ id, request: requestOf(channel, from) }),
    );

    expect(refusal).toBeInstanceOf(SubscriptionError);
    expect(refusal).toMatchObject({ reason });
  });

  it('is held to the contract’s bounds even when it was built by hand, and takes no connection', async () => {
    const { id, conversations, channel } = await stored();
    const request = requestOf(channel);
    // The schema refuses a channel twice, and a tail of nothing: a caller that skipped it is refused here.
    const twice = { subscriptions: [...request.subscriptions, ...request.subscriptions] };
    const nothing = {
      subscriptions: [{ channel: requestOf(channel).subscriptions[0]!.channel, from: 'tail:0' }],
    };

    for (const refused of [twice, nothing]) {
      for (let attempt = 0; attempt <= MAX_SUBSCRIPTION_CONNECTIONS; attempt += 1) {
        await expect(conversations.subscribe({ id, request: refused })).rejects.toThrow();
      }
    }

    // None of them took a place: the conversation still serves a whole bound of them.
    for (const subscription of await fillPlaces({ conversations, id, channel })) {
      subscription.close();
    }
  });

  it('is stopped, and takes no connection, when the client has already gone', async () => {
    const { id, conversations, channel } = await stored();
    const leaving = AbortSignal.abort();

    for (let attempt = 0; attempt <= MAX_SUBSCRIPTION_CONNECTIONS; attempt += 1) {
      const refusal = await refusalOf(
        conversations.subscribe({ id, request: requestOf(channel), signal: leaving }),
      );

      expect(refusal).toMatchObject({ name: 'AbortError' });
    }

    for (const subscription of await fillPlaces({ conversations, id, channel })) {
      subscription.close();
    }
  });

  it('is refused for what it is when another subscription is open, and takes no connection', async () => {
    const { id, conversations, channel } = await stored();
    const open = await conversations.subscribe({ id, request: requestOf(channel, 'now') });

    // Refused while the history is read, which is after the subscription began to open.
    for (const refusal of await refusedOften({ conversations, id, channel, from: 's999' })) {
      expect(refusal).toBeInstanceOf(SubscriptionError);
      expect(refusal).toMatchObject({ reason: 'cursor_out_of_range' });
    }

    open.close();
  });
});

describe('the connections a conversation serves', () => {
  it('are bounded, and a request that is refused never takes one', async () => {
    const { id, conversations, channel } = await stored();
    const subscribe = () => conversations.subscribe({ id, request: requestOf(channel, 'now') });

    // Refused requests hold nothing, however many there are.
    for (const refusal of await refusedOften({ conversations, id, channel, from: 'tail:1001' })) {
      expect(refusal).toMatchObject({ reason: 'bad_request' });
    }

    const held = await fillPlaces({ conversations, id, channel });

    expect(await refusalOf(subscribe())).toMatchObject({ reason: 'too_many_subscriptions' });

    // One ends, and its place is free again, for one.
    held.pop()?.close();
    held.push(await subscribe());

    expect(await refusalOf(subscribe())).toMatchObject({ reason: 'too_many_subscriptions' });

    for (const subscription of held) subscription.close();

    expect(await refusalOf(subscribe())).toBeUndefined();
  });

  it('are counted for each conversation, not for the host', async () => {
    const { store, id, conversations, channel } = await stored();
    const other = await conversations.start();

    await conversations.get(other).harness.nodeChannels?.flush();

    const [otherChannel = ''] = await store.channels(other);
    const held = await fillPlaces({ conversations, id, channel });

    expect(
      await refusalOf(conversations.subscribe({ id, request: requestOf(channel, 'now') })),
    ).toMatchObject({ reason: 'too_many_subscriptions' });

    const beside = await conversations.subscribe({
      id: other,
      request: requestOf(otherChannel, 'now'),
    });

    beside.close();

    for (const subscription of held) subscription.close();
  });
});
