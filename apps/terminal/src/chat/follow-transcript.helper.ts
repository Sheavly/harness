import type { RemoteConversation } from '../client/conversation.service.js';
import { TranscriptEndedError } from '../errors/transcript.errors.js';
import type { ChatSession } from './chat-session.service.js';

/**
 * Has `session` hear the conversation's transcript feed until `signal` aborts. Resolves once both
 * connections are accepted, so the first prompt is sent after it. A feed that fails, or ends while
 * the chat did not ask to stop, is lost: the session says so and ends the run going.
 */
export async function followTranscript(params: {
  conversation: Pick<RemoteConversation, 'watchTranscript'>;
  session: ChatSession;
  signal: AbortSignal;
}): Promise<void> {
  const { conversation, session, signal } = params;
  const feed = await conversation.watchTranscript({
    onItem: (item) => session.hear(item),
    signal,
  });

  void feed.ended.then(
    () => {
      if (!signal.aborted) session.lostFeed(new TranscriptEndedError());
    },
    (caughtError: unknown) => session.lostFeed(caughtError),
  );
}
