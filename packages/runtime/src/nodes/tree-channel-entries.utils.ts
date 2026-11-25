import type { ChannelEntry } from '@sheavly/core/store/store.types';
import type {
  ApprovalConcern,
  ApprovalId,
  ApprovalRequest,
  ApprovalResponse,
} from '@sheavly/protocol/approval/approval.types';
import { MAX_CHANNEL_ENTRY_CHARS } from '@sheavly/protocol/channel/channel.constants';
import type { MessageId } from '@sheavly/protocol/message/message.types';
import {
  MAX_NODE_COMMAND_CHARS,
  MAX_NODE_ERROR_CHARS,
  MAX_NODE_OUTPUT_CHARS,
  TREE_CHANNEL_NAME,
} from '@sheavly/protocol/node/node.constants';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import { MAX_QUEUED_LINE_CHARS } from '@sheavly/protocol/server/server.constants';
import type { TaskInfo } from '@sheavly/protocol/task/task.types';
import {
  agentNodeOf,
  fittedEntry,
  sequenceCursor,
  workNodeOf,
} from './node-channel-entries.utils.js';
import type { NodeRecord, TreeStamp } from './nodes.types.js';

/** What every entry of the tree channel has. */
const stamped = ({ position, at }: TreeStamp) => ({
  channel: TREE_CHANNEL_NAME,
  cursor: sequenceCursor(position),
  at,
});

/** The first entry of the tree channel: the conversation opened it. */
export function treeOpenedEntry(stamp: TreeStamp): ChannelEntry {
  return { ...stamped(stamp), type: 'opened' };
}

/** An agent opened, changed or closed: the node as it is now. */
export function agentNodeEntry(
  params: TreeStamp & {
    type: 'node_opened' | 'node_updated' | 'node_closed';
    node: NodeRecord;
  },
): ChannelEntry {
  return { ...stamped(params), type: params.type, node: agentNodeOf(params.node) };
}

/**
 * A command or a service opened or closed, from the node and the task that holds what the registry
 * does not. It opens with no output, and closes with the most recent part of it (the preview; the
 * complete output is its own channel's), the exit code and the error. Its command is cut to fit an
 * entry, like the one that opens its own channel.
 */
export function workNodeEntry(
  params: TreeStamp & { type: 'node_opened' | 'node_closed'; node: NodeRecord; task: TaskInfo },
): ChannelEntry {
  const { type, node, task } = params;
  const closed = type === 'node_closed';

  return fittedEntry({
    command: task.command.slice(0, MAX_NODE_COMMAND_CHARS),
    build: (command) => ({
      ...stamped(params),
      type,
      node: {
        ...workNodeOf({
          node,
          task,
          command,
          output: closed ? task.output.slice(-MAX_NODE_OUTPUT_CHARS) : '',
        }),
        ...(closed && task.exitCode !== undefined && { exitCode: task.exitCode }),
        ...(closed &&
          task.error !== undefined && { error: task.error.slice(0, MAX_NODE_ERROR_CHARS) }),
      },
    }),
  });
}

/** The concern a shortened command carries: it says what a client that shows only this must not do. */
function shortenedConcern(params: { kept: number; whole: number }): ApprovalConcern {
  return {
    argument: 'command',
    reason: `Only the first ${String(params.kept)} of ${String(params.whole)} characters of the command are in this entry: do not approve it from this text, read the whole command on the conversation's stream`,
  };
}

/**
 * A node's tool asks for approval. The request is the one the registry holds, with the whole
 * command, so a read-only subscriber sees what it would run. An entry holds at most
 * `MAX_CHANNEL_ENTRY_CHARS`, and a command has no bound of its own near that, so a command that does
 * not fit is cut, and the request then says so as a concern (the first thing a client shows): a
 * shortened command is never taken for the whole one. If it still does not fit with no command (its
 * concerns or its grants are that large), those are replaced by that one concern.
 */
export function approvalRequestedEntry(
  params: TreeStamp & { node: NodeId; request: ApprovalRequest },
): ChannelEntry {
  const { node, request } = params;
  const whole = request.command.length;
  const build = (command: string) => {
    const concerns =
      command.length < whole
        ? [...request.concerns, shortenedConcern({ kept: command.length, whole })]
        : request.concerns;

    return {
      ...stamped(params),
      type: 'approval_requested',
      node,
      request: { ...request, command, concerns },
    };
  };
  const fitted = fittedEntry({ command: request.command, build });

  if (JSON.stringify(fitted).length <= MAX_CHANNEL_ENTRY_CHARS) return fitted;

  const { keeps: _kept, ...bare } = request;

  return {
    ...stamped(params),
    type: 'approval_requested',
    node,
    request: { ...bare, command: '', concerns: [shortenedConcern({ kept: 0, whole })] },
  };
}

/** A waiting approval was answered. */
export function approvalResolvedEntry(
  params: TreeStamp & { node: NodeId; id: ApprovalId; response: ApprovalResponse },
): ChannelEntry {
  const { node, id, response } = params;

  return { ...stamped(params), type: 'approval_resolved', node, id, response };
}

/** A waiting approval was given up before anyone answered. */
export function approvalCancelledEntry(
  params: TreeStamp & { node: NodeId; id: ApprovalId },
): ChannelEntry {
  const { node, id } = params;

  return { ...stamped(params), type: 'approval_cancelled', node, id };
}

/**
 * `build(limit)` with each queued line cut to `limit` characters (never to none), the limit
 * halved from the longest a line may be until the entry fits. A queue holds up to
 * `MAX_QUEUED_CHARS` together, more than an entry, and a notice only has to show what waits.
 */
function fittedLines(build: (limit: number) => ChannelEntry): ChannelEntry {
  let limit = MAX_QUEUED_LINE_CHARS;
  let entry = build(limit);

  while (JSON.stringify(entry).length > MAX_CHANNEL_ENTRY_CHARS && limit > 1) {
    limit = Math.floor(limit / 2);
    entry = build(limit);
  }

  return entry;
}

/** The lines of `queued` cut to `limit` characters each. */
const cutLines = (params: { queued: readonly string[]; limit: number }) =>
  params.queued.map((line) => line.slice(0, params.limit));

/** The conversation's queue changed: a line joined it, or a client replaced the lines. */
export function queueChangedEntry(params: TreeStamp & { queued: readonly string[] }): ChannelEntry {
  return fittedLines((limit) => ({
    ...stamped(params),
    type: 'queue_changed',
    queued: cutLines({ queued: params.queued, limit }),
  }));
}

/** A queued line started as the conversation's next prompt, as the user message it became. */
export function promptStartedEntry(
  params: TreeStamp & { text: string; messageId: MessageId; queued: readonly string[] },
): ChannelEntry {
  return fittedLines((limit) => ({
    ...stamped(params),
    type: 'prompt_started',
    text: params.text.slice(0, limit),
    messageId: params.messageId,
    queued: cutLines({ queued: params.queued, limit }),
  }));
}

/** A queued line left the queue without starting, for the reason `error` gives. */
export function promptRefusedEntry(
  params: TreeStamp & { text: string; error: string; queued: readonly string[] },
): ChannelEntry {
  return fittedLines((limit) => ({
    ...stamped(params),
    type: 'prompt_refused',
    text: params.text.slice(0, limit),
    error: params.error.slice(0, MAX_NODE_ERROR_CHARS),
    queued: cutLines({ queued: params.queued, limit }),
  }));
}

/** The conversation could not be stored. Said once; it ends no run. */
export function storageFailedEntry(params: TreeStamp & { error: string }): ChannelEntry {
  return {
    ...stamped(params),
    type: 'storage_failed',
    error: params.error.slice(0, MAX_NODE_ERROR_CHARS),
  };
}
