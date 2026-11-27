import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { PROMPT_MESSAGE } from '../chat/testing/prompt-answers.fake.js';

/** Test-only: the main session a fake conversation's entries are about. */
const MAIN = sessionIdSchema.parse('main');

/**
 * Test-only: a conversation's live stream, as a backend sends it to everyone following: each
 * follower gets the entries published after `follow()` was called, in order, and its stream never
 * ends of its own (a conversation's stream is endless). A fake server's `streamConversation`
 * answers with `follow()`, and its `sendPrompt` publishes the run it starts.
 */
export function liveFeed<Item = StreamEntry>() {
  const followers = new Set<(item: Item) => void>();

  function follow(): AsyncGenerator<Item> {
    const waiting: Item[] = [];
    let wake: (() => void) | undefined;
    const push = (item: Item) => {
      waiting.push(item);
      wake?.();
    };

    // Subscribed now, not at the first pull: what is published between the two is kept, as a real
    // backend's connection keeps what it is sent from the moment it is accepted.
    followers.add(push);

    async function* read(): AsyncGenerator<Item> {
      try {
        while (true) {
          const [next] = waiting;

          if (waiting.length > 0) {
            waiting.shift();
            yield next as Item;
            continue;
          }

          await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        followers.delete(push);
      }
    }

    return read();
  }

  return {
    follow,
    /** Sends `items` to everyone following now. */
    publish: (...items: Item[]) => {
      for (const item of items) for (const push of followers) push(item);
    },
  };
}

/** Test-only: the backend's `prompt_started` for `text`, at `seq`, with `queued` still waiting. */
export function promptStarted(params: {
  seq: number;
  text: string;
  queued?: string[];
}): StreamEntry {
  const { seq, text, queued = [] } = params;

  return {
    seq,
    at: 0,
    sessionId: MAIN,
    kind: 'queue',
    update: { type: 'prompt_started', messageId: PROMPT_MESSAGE, text, queued },
  };
}
