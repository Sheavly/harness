import { NodeCommandError } from '@sheavly/runtime/errors/node-commands.errors';
import { NodeCommands } from '@sheavly/runtime/nodes/node-commands.service';
import type { NodeTarget } from '@sheavly/runtime/nodes/nodes.types';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import { nodeIdSchema } from '@sheavly/protocol/node/node.validator';
import { ConversationsError } from '../errors/conversations.errors.js';
import { NODE_COMMAND_REFUSALS } from './conversations.constants.js';
import type { LiveConversation } from './conversations.types.js';

/**
 * A node id from outside, as the conversation's: a string that is not an id's shape can name no
 * node, so it answers as one nothing has does (`not_found`, the same message), as an unknown id
 * does.
 */
function nodeIdOf(raw: string): NodeId {
  const parsed = nodeIdSchema.safeParse(raw);

  if (parsed.success) return parsed.data;

  throw new ConversationsError({
    reason: 'not_found',
    message: `No node ${raw} in this conversation`,
  });
}

/** What a failed command is told as: the reason the caller handles, and what the runtime said. */
function toConversationsError(error: unknown): unknown {
  if (!(error instanceof NodeCommandError)) return error;

  return new ConversationsError({
    reason: NODE_COMMAND_REFUSALS[error.reason],
    message: error.message,
    cause: error,
  });
}

/** Resolves `raw` in the conversation, before anything is done: what it is, or why it cannot be. */
function resolve(params: { live: LiveConversation; raw: string }): {
  commands: NodeCommands;
  nodeId: NodeId;
  target: NodeTarget;
} {
  const { harness } = params.live;
  const commands = new NodeCommands({ sessions: harness.sessions, tasks: harness.tasks });
  const nodeId = nodeIdOf(params.raw);

  try {
    return { commands, nodeId, target: commands.target(nodeId) };
  } catch (caughtError) {
    throw toConversationsError(caughtError);
  }
}

/**
 * Cancels node `node` of `live`: a command, a service or a sub-agent is killed and waited for, and
 * the main agent is stopped as the conversation's `stop` does (`stopMain`). `not_found` for a node
 * it does not have, `node_ended` for one that has ended, `bad_request` for a kind nothing cancels.
 */
export async function cancelNode(params: {
  live: LiveConversation;
  node: string;
  stopMain: () => void;
}): Promise<void> {
  const { commands, nodeId, target } = resolve({ live: params.live, raw: params.node });

  if (target.kind === 'main-agent') {
    params.stopMain();

    return;
  }

  try {
    await commands.cancel({ nodeId, target });
  } catch (caughtError) {
    throw toConversationsError(caughtError);
  }
}

/**
 * Sends `text` to node `node` of `live` as the user: the main agent takes it at its next model
 * call. Refused as `cancelNode` is, with `bad_request` for a node that is no agent, and for a
 * sub-agent, which only the agent that started it may message.
 */
export function messageNode(params: { live: LiveConversation; node: string; text: string }): void {
  const { commands, nodeId, target } = resolve({ live: params.live, raw: params.node });

  try {
    commands.message({ nodeId, target, text: params.text });
  } catch (caughtError) {
    throw toConversationsError(caughtError);
  }
}
