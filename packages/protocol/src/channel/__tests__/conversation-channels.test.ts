import { describe, expect, it } from 'vitest';
import { CONVERSATION_CHANNEL_NAMES, RESERVED_EXTENSION_NAMES } from '../../node/node.constants.js';
import { nodeIdSchema } from '../../node/node.validator.js';
import { conversationEntrySchema } from '../../subscription/subscription.utils.js';
import { subscribeRequestSchema } from '../../subscription/subscription.validator.js';
import { isConversationChannel, isWellFormedChannelLog } from '../channel.utils.js';
import { channelNameSchema } from '../channel.validator.js';

// What every channel of the conversation itself has, whichever it is: the list is the one place a
// new one is added, and each of these holds for it.

const request = (channel: string, from: string) =>
  subscribeRequestSchema.safeParse({ subscriptions: [{ channel, from }] }).success;

describe.each(CONVERSATION_CHANNEL_NAMES)('the conversation channel %s', (name) => {
  it('is one, and a node’s id is not', () => {
    expect(isConversationChannel(name)).toBe(true);
    expect(isConversationChannel('agent-1')).toBe(false);
  });

  it('is a channel name, and is refused as the id of a node, whose channel is named by it', () => {
    expect(channelNameSchema.safeParse(name).success).toBe(true);
    expect(nodeIdSchema.safeParse(name).success).toBe(false);
  });

  it('is a name an extension may not take', () => {
    expect([...RESERVED_EXTENSION_NAMES]).toContain(name);
  });

  it('has an entry schema that takes its own first entry and not another channel’s', () => {
    const schema = conversationEntrySchema(name);
    const opened = (channel: string) => ({ channel, cursor: 's0', at: 1, type: 'opened' });

    expect(schema.safeParse(opened(name)).success).toBe(true);
    expect(schema.safeParse(opened('agent-1')).success).toBe(false);
  });

  it('has a snapshot to start from, and is numbered: a byte cursor or an over-long tail is refused', () => {
    expect(request(name, 'snapshot')).toBe(true);
    expect(request(name, 's4')).toBe(true);
    expect(request(name, 'b4')).toBe(false);
    expect(request(name, 'tail:1001')).toBe(false);
  });

  it('is numbered in a stored log too: one that opens at a byte offset is not well formed', () => {
    expect(isWellFormedChannelLog([{ channel: name, cursor: 's0', type: 'opened' }])).toBe(true);
    expect(isWellFormedChannelLog([{ channel: name, cursor: 'b0', type: 'opened' }])).toBe(false);
  });
});

describe('a node’s channel', () => {
  it('has no snapshot: that is for the conversation’s own channels', () => {
    expect(request('agent-1', 'snapshot')).toBe(false);
    expect(request('agent-1', 'start')).toBe(true);
  });

  it('may be followed by a byte cursor, as a command’s output is', () => {
    expect(request('agent-1', 'b4')).toBe(true);
  });
});

describe('the reserved extension names', () => {
  it('hold every conversation channel and the built-in node kinds, and nothing else', () => {
    expect([...RESERVED_EXTENSION_NAMES].sort()).toEqual(
      ['agent', 'command', 'service', ...CONVERSATION_CHANNEL_NAMES].sort(),
    );
  });
});
