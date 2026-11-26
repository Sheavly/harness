import { partsText } from '@sheavly/protocol/message/message.utils';
import type { PromptSent } from '@sheavly/protocol/node-command/node-command.types';
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
 * not start, and `StreamLostError` when the stream is lost. A waiting prompt is known by its text:
 * of two identical lines queued at once, the first to start is taken for the earlier one.
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
    const answer = await client.call('sendPrompt', { id, body: prompt, signal });
    const text = 'text' in prompt ? prompt.text : partsText(prompt.parts);

    yield* entriesOfRun({ entries, text, ahead: identicalAhead({ answer, text }) });
  } finally {
    following.abort();
  }
}

/** How many lines like `text` wait ahead of it: each starts before it, under the same text. */
function identicalAhead(params: { answer: PromptSent; text: string }): number {
  const { answer, text } = params;

  if (answer.status === 'started') return 0;

  // The queue after the send ends with this line itself.
  return answer.queued.slice(0, -1).filter((line) => line === text).length;
}

/** The entries from the start of the run of `text` (after `ahead` others like it) to its end. */
async function* entriesOfRun(params: {
  entries: AsyncIterable<StreamEntry>;
  text: string;
  ahead: number;
}): AsyncGenerator<StreamEntry> {
  const { entries, text } = params;
  let ahead = params.ahead;
  let started = false;

  for await (const entry of entries) {
    if (!started) {
      const start = startOf({ entry, text });

      if (start === 'other') continue;

      if (ahead > 0) {
        ahead -= 1;
        continue;
      }

      if (start !== 'started') throw new PromptRefusedError({ message: start.refused });
      started = true;
    }

    yield entry;
    if (runEnd(entry) !== undefined) return;
  }
}

/** Whether `entry` says a line of `text` started, or could not start (why), or is another entry. */
function startOf(params: {
  entry: StreamEntry;
  text: string;
}): 'other' | 'started' | { refused: string } {
  const { entry, text } = params;

  if (entry.kind !== 'queue' || entry.update.type === 'queue_changed') return 'other';
  if (entry.update.text !== text) return 'other';

  return entry.update.type === 'prompt_started' ? 'started' : { refused: entry.update.error };
}
