import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../client/transcript.types.js';
import { followTranscript } from '../follow-transcript.helper.js';
import { messageIdOf } from '../testing/feed-items.fake.js';
import { recordingChat, settle } from '../testing/chat-session.fake.js';

/**
 * A chat that follows a conversation whose feed the test drives: `tell` gives it an item, and
 * `ended` is how the feed ends. `stop` is the signal the chat followed it with.
 */
async function following() {
  const ended = Promise.withResolvers<undefined>();
  const stop = new AbortController();
  let tell: (item: ChatItem) => void = () => undefined;
  const conversation = {
    watchTranscript: (params: { onItem: (item: ChatItem) => void; signal: AbortSignal }) => {
      tell = params.onItem;

      return Promise.resolve({ ended: ended.promise });
    },
  };
  const chat = recordingChat();

  await followTranscript({ conversation, session: chat.session, signal: stop.signal });

  return { ...chat, ended, stop, tell: (item: ChatItem) => tell(item) };
}

describe('followTranscript', () => {
  it('has the session hear each item the feed tells, once the feed is accepted', async () => {
    const { output, told, items, tell } = await following();

    tell(items.prompt({ messageId: messageIdOf(1), text: 'hi' }));
    tell(items.text('the answer'));

    expect(output()).toContain('the answer');
    expect(told).toEqual(['send hi', 'busy']);
  });

  it('says the feed was lost, and ends the run going as failed, when the feed fails', async () => {
    const { output, told, items, tell, ended } = await following();

    tell(items.prompt({ messageId: messageIdOf(1), text: 'hi' }));
    ended.reject(new Error('channel failed'));
    await settle();

    expect(output()).toContain('✗ lost the live feed: channel failed');
    expect(told).toEqual(['send hi', 'busy', 'end failed', 'ready']);
  });

  it('says the conversation ended when the feed ends quietly and nobody asked it to stop', async () => {
    const { output, ended } = await following();

    ended.resolve(undefined);
    await settle();

    expect(output()).toContain('✗ lost the live feed: the conversation ended');
  });

  it('says nothing when the feed ends because the chat asked it to stop', async () => {
    const { output, ended, stop } = await following();

    stop.abort();
    ended.resolve(undefined);
    await settle();

    expect(output()).toBe('');
  });
});
