import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';

/** Test-only: the main session a fake conversation's entries are about. */
const MAIN = sessionIdSchema.parse('main');

/**
 * Test-only: a conversation's live stream, as a backend sends it to everyone following: each
 * follower gets the entries published after it opened, in order, and its stream never ends of
 * its own (a conversation's stream is endless). A fake server's `streamConversation` answers
 * with `follow()`, and its `sendPrompt` publishes the run it starts.
 */
export function liveFeed() {
  const followers = new Set<(entry: StreamEntry) => void>();

  async function* follow(): AsyncGenerator<StreamEntry> {
    const waiting: StreamEntry[] = [];
    let wake: (() => void) | undefined;
    const push = (entry: StreamEntry) => {
      waiting.push(entry);
      wake?.();
    };

    followers.add(push);

    try {
      while (true) {
        const next = waiting.shift();

        if (next) {
          yield next;
          continue;
        }

        await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      followers.delete(push);
    }
  }

  return {
    follow,
    /** Sends `entries` to everyone following now. */
    publish: (...entries: StreamEntry[]) => {
      for (const entry of entries) for (const push of followers) push(entry);
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
    update: { type: 'prompt_started', text, queued },
  };
}
