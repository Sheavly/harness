import type { NodeCommandError } from '@sheavly/runtime/errors/node-commands.errors';
import type { ConversationsError } from '../errors/conversations.errors.js';

/**
 * How each way a command to a node is refused is told to a caller: a node that is not there is
 * `not_found`, one that has ended `node_ended`, and a command its kind cannot take `bad_request`.
 */
export const NODE_COMMAND_REFUSALS: Record<
  NodeCommandError['reason'],
  ConversationsError['reason']
> = {
  unknown_node: 'not_found',
  node_ended: 'node_ended',
  cannot_cancel: 'bad_request',
  cannot_message: 'bad_request',
  // The agent has not taken what is waiting for it: the sender tries again later, as for a full queue.
  inbox_full: 'cannot_queue',
};

/** What a tool call's result says when the process ended before the call returned. */
export const INTERRUPTED_CALL =
  'The conversation was interrupted before this tool finished, so it returned nothing. Check its effects before relying on it.';
