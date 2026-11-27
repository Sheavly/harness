import { partsText } from '@sheavly/protocol/message/message.utils';
import type { SendPromptRequest } from '@sheavly/protocol/server/server.types';
import type { LiveConversation } from './conversations.types.js';

/** The text of a prompt as the user wrote it: its text, or the text of its parts. */
export function promptTextOf(prompt: SendPromptRequest): string {
  return 'text' in prompt ? prompt.text : partsText(prompt.parts);
}

/**
 * Says on the main agent's channel that the user's prompt `prompt` has started a run, so one
 * ordered channel reads the run from its start. Call it as the prompt starts: after the main
 * session has the prompt's message, and before any event of the run, which come only once they
 * are read. A conversation that keeps no channels, or a closed one, writes nothing.
 */
export function noteRunStartedByPrompt(params: {
  live: LiveConversation;
  prompt: SendPromptRequest;
}): void {
  const { harness } = params.live;
  const node = harness.sessions.nodeIdOf(harness.mainSession.id);
  const messageId = harness.sessions.messageOf(harness.mainSession.id);

  if (node === undefined || messageId === undefined) return;

  harness.nodeChannels?.noteRunStarted({
    node,
    cause: 'prompt',
    messageId,
    text: promptTextOf(params.prompt),
  });
}
