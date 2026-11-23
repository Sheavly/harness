import { CONVERSATION_RUN_TRANSITIONS } from './conversation.constants.js';
import type { ConversationRunState } from './conversation.types.js';

/** Whether a conversation's run may move from `from` to `to` (`CONVERSATION_RUN_TRANSITIONS`). */
export function canMoveRun(params: { from: ConversationRunState; to: ConversationRunState }) {
  return CONVERSATION_RUN_TRANSITIONS[params.from].includes(params.to);
}
