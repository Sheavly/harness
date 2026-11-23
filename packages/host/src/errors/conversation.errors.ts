import type { ConversationRunState } from '../conversation/conversation.types.js';

/**
 * A conversation's run was asked to make a move `CONVERSATION_RUN_TRANSITIONS` does not have: a
 * bug in the conversation, never something a caller did, since each entry point checks first.
 */
export class ConversationRunError extends Error {
  override name = 'ConversationRunError';
  readonly from: ConversationRunState;
  readonly to: ConversationRunState;

  constructor(params: { from: ConversationRunState; to: ConversationRunState }) {
    const { from, to } = params;

    super(`A conversation's run cannot move from ${from} to ${to}`);
    this.from = from;
    this.to = to;
  }
}
