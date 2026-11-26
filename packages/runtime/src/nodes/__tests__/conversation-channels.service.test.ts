import { describe, expect, it, vi } from 'vitest';
import { StoreError } from '@sheavly/core/errors/store.errors';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { conversationId } from '../../testing/stored-conversation.fake.js';
import type { NodeError } from '../../errors/nodes.errors.js';
import { ConversationChannels } from '../conversation-channels.service.js';
import type { ConversationChannel } from '../nodes.types.js';
import { TreeChannelWriter } from '../tree-channel-writer.service.js';

/** A tree channel writer over a memory store: a real channel of the conversation itself. */
function realTree() {
  const store = new MemoryConversationStore();

  return new TreeChannelWriter({ log: store.channel({ id: conversationId, channel: 'tree' }) });
}

/** A channel that only counts what it is asked, and has failed with `failure` if it is given one. */
function counting(failure?: StoreError) {
  const calls = { flush: vi.fn(), stop: vi.fn() };
  const channel: ConversationChannel = {
    name: 'tree',
    failure,
    flush: () => {
      calls.flush();

      return Promise.resolve();
    },
    snapshot: () => Promise.reject(new Error('not asked for')),
    follow: () => () => undefined,
    writing: () => true,
    stop: () => {
      calls.stop();

      return Promise.resolve();
    },
  };

  return { channel, calls };
}

describe('the conversation’s own channels', () => {
  it('hold a real tree channel writer, which is one: it is found by its name', () => {
    const channels = new ConversationChannels();
    const tree = realTree();

    // Assigning it to the interface is the check that it is a conversation channel.
    const asChannel: ConversationChannel = tree;

    channels.add(asChannel);

    expect(channels.get('tree')).toBe(tree);
    expect(channels.get('tree')?.name).toBe('tree');
  });

  it('find none for a node’s id, a name that is not held, or a host that kept none', () => {
    const channels = new ConversationChannels();

    expect(channels.get('tree')).toBeUndefined();

    channels.add(counting().channel);

    expect(channels.get('agent-1')).toBeUndefined();
    expect(channels.get('')).toBeUndefined();
  });

  it('refuse a second channel of the same name: a channel has one writer', () => {
    const channels = new ConversationChannels();

    channels.add(counting().channel);

    expect(() => {
      channels.add(counting().channel);
    }).toThrow(expect.objectContaining({ reason: 'duplicate_channel' }) as NodeError);
  });

  it('list the failure of each channel that has failed, and none for one that has not', () => {
    const failed = new StoreError({ reason: 'failed', message: 'disk gone' });
    const withFailure = new ConversationChannels();
    const without = new ConversationChannels();

    withFailure.add(counting(failed).channel);
    without.add(counting().channel);

    expect(withFailure.failures).toEqual([failed]);
    expect(without.failures).toEqual([]);
  });

  it('flush the channels named, or all of them when none is named, and skip a name not held', async () => {
    const channels = new ConversationChannels();
    const { channel, calls } = counting();

    channels.add(channel);

    await channels.flush(['agent-1']);
    expect(calls.flush).not.toHaveBeenCalled();

    await channels.flush(['tree']);
    expect(calls.flush).toHaveBeenCalledTimes(1);

    await channels.flush();
    expect(calls.flush).toHaveBeenCalledTimes(2);
  });

  it('stop every channel', async () => {
    const channels = new ConversationChannels();
    const { channel, calls } = counting();

    channels.add(channel);
    await channels.stop();

    expect(calls.stop).toHaveBeenCalledTimes(1);
  });
});
