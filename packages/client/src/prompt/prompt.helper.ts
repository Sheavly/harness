import type { MessageId } from '@sheavly/protocol/message/message.types';
import type { ConversationId, SendPromptRequest } from '@sheavly/protocol/server/server.types';
import { runEnd } from '@sheavly/protocol/status/run-end.utils';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import type { createClient } from '../client/client.helper.js';
import { followConversation } from '../client/follow.helper.js';
import { PromptRefusedError } from '../errors/client.errors.js';

/**
 * Sends `prompt` to conversation `id` and yields the entries of the run it starts, from its
 * `prompt_started` to the main session's end of that run (`runEnd`), whether it started at once or
 * waited in the conversation's queue first: the backend answers the send at once either way. The
 * stream is followed from before the send, so no entry of the run is missed; aborting `signal`
 * stops following, not the prompt.
 *
 * Throws the send's refusal (`RefusedError`), `PromptRefusedError` when the prompt waited and could
 * not start or was removed from the queue by an edit, and `StreamLostError` when the stream is
 * lost. The prompt is known by the `messageId` the send answered with, which the queue's updates
 * and its run carry: two identical lines queued at once are told apart.
 */
export async function* promptEntries(params: {
  client: ReturnType<typeof createClient>;
  id: ConversationId;
  prompt: SendPromptRequest;
  signal?: AbortSignal | undefined;
}): AsyncGenerator<StreamEntry> {
  const { client, id, prompt } = params;
  const following = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, following.signal])
    : following.signal;

  try {
    const entries = await followConversation({ client, id, body: {}, signal });
    const { messageId } = await client.call('sendPrompt', { id, body: prompt, signal });

    yield* entriesOfRun({ entries, messageId });
  } finally {
    following.abort();
  }
}

/** The entries from the start of the run of the line with `messageId` to its end. */
async function* entriesOfRun(params: {
  entries: AsyncIterable<StreamEntry>;
  messageId: MessageId;
}): AsyncGenerator<StreamEntry> {
  const { entries, messageId } = params;
  let started = false;

  for await (const entry of entries) {
    if (!started) {
      const start = startOf({ entry, messageId });

      if (start === 'other') continue;
      if (start !== 'started') throw new PromptRefusedError({ message: start.refused });
      started = true;
    }

    yield entry;
    if (runEnd(entry) !== undefined) return;
  }
}

/**
 * Whether `entry` says the line with `messageId` started, or could not start or was removed from
 * the queue (why), or is another entry.
 */
function startOf(params: {
  entry: StreamEntry;
  messageId: MessageId;
}): 'other' | 'started' | { refused: string } {
  const { entry, messageId } = params;

  if (entry.kind !== 'queue') return 'other';

  const { update } = entry;

  if (update.type === 'queue_changed') {
    return update.dropped?.includes(messageId)
      ? { refused: 'The line was removed from the queue before it started' }
      : 'other';
  }

  if (update.messageId !== messageId) return 'other';

  return update.type === 'prompt_started' ? 'started' : { refused: update.error };
}
