import type { ConversationRunState } from './conversation.types.js';

/**
 * Where a conversation's run may move from each state: a run starts only from idle, as a prompt or
 * a wake, and every run ends idle, so a prompt never starts on top of a wake.
 */
export const CONVERSATION_RUN_TRANSITIONS: Readonly<
  Record<ConversationRunState, readonly ConversationRunState[]>
> = {
  idle: ['prompt', 'wake'],
  prompt: ['idle'],
  wake: ['idle'],
};

/**
 * After a run ended because the user queued a line, the conversation waits this long before it
 * wakes for finished work: the queued line normally arrives as the next prompt in that time and
 * delivers the notice itself. A line that is not a prompt (`/help`) leaves the notice to the wake.
 */
export const WAKE_AFTER_YIELD_MS = 1500;
