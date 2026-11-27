import type { ChannelEntry } from '@sheavly/core/store/store.types';
import type {
  ApprovalConcern,
  ApprovalId,
  ApprovalRequest,
  ApprovalResponse,
} from '@sheavly/protocol/approval/approval.types';
import type { MessageId } from '@sheavly/protocol/message/message.types';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import {
  MAX_NODE_CALL_ID_CHARS,
  MAX_NODE_COMMAND_CHARS,
  MAX_NODE_DESCRIPTION_CHARS,
  MAX_NODE_ERROR_CHARS,
  MAX_NODE_OUTPUT_CHARS,
  MAX_NODE_REASON_CHARS,
  TREE_CHANNEL_NAME,
} from '@sheavly/protocol/node/node.constants';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import { MAX_QUEUED_LINE_CHARS } from '@sheavly/protocol/server/server.constants';
import type { TaskInfo } from '@sheavly/protocol/task/task.types';
import type { TreeView } from '@sheavly/protocol/tree/tree.types';
import { agentNodeOf, head, sequenceCursor, workNodeOf } from './node-channel-entries.utils.js';
import {
  CUT_APPROVAL_OPTIONS,
  MAX_CUT_TOOL_CHARS,
  MAX_TREE_ENTRY_CHARS,
} from './nodes.constants.js';
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
 * A node the stopped process left open, closed as `lost`: the node as the tree last had it, with
 * the time it was found. Nobody saw it end, so it keeps whatever outcome it had and gets no more. A
 * command or a service keeps what it had of its command and its output, cut again if the entry
 * would not fit with the end time: the node came from an entry that did, and a reopen that could not
 * write this one would fail on every reopen.
 */
export function lostNodeEntry(
  params: TreeStamp & { node: TreeView['nodes'][number] },
): ChannelEntry {
  const { node } = params;
  const lost = (cut: object): ChannelEntry => ({
    ...stamped(params),
    type: 'node_closed',
    node: { ...node, ...cut, state: 'lost', endedAt: params.at },
  });

  if (!('command' in node)) return lost({});

  return fittedWork({
    texts: {
      command: node.command,
      output: node.output,
      description: node.description,
      reason: node.reason ?? '',
      error: node.error ?? '',
    },
    build: ({ command, output, description, reason, error }) =>
      lost({
        command,
        output,
        description,
        ...(node.reason !== undefined && { reason }),
        ...(node.error !== undefined && { error }),
      }),
  });
}

/** The last characters of `text` from `from` on, never starting inside a surrogate pair, well formed. */
function tail(params: { text: string; from: number }): string {
  const { text, from } = params;
  const cut = text.slice(from);

  return (/^[\uDC00-\uDFFF]/u.test(cut) && from > 0 ? cut.slice(1) : cut).toWellFormed();
}

/**
 * `build(text)` with `text` cut from its end, halved each round, until the entry it makes is at
 * most `MAX_TREE_ENTRY_CHARS` of JSON. `text` is a command or a message: the one field with no bound
 * of its own near that. It starts from at most `MAX_TREE_ENTRY_CHARS` characters: JSON is never
 * shorter than the text it holds, so more cannot fit, and a 5 MB text is not measured again and
 * again. An entry that does not fit even with no text is returned as it is.
 */
function fittedText(params: { text: string; build: (text: string) => ChannelEntry }): ChannelEntry {
  const { build } = params;
  let text = head({ text: params.text, length: MAX_TREE_ENTRY_CHARS });
  let entry = build(text);

  while (JSON.stringify(entry).length > MAX_TREE_ENTRY_CHARS && text) {
    text = head({ text, length: Math.floor(text.length / 2) });
    entry = build(text);
  }

  return entry;
}

/** The texts of a command's or a service's node, each bounded by the wire and none by an entry. */
type WorkTexts = {
  command: string;
  output: string;
  description: string;
  reason: string;
  error: string;
};

/** The field of `texts` that costs most as JSON, or none when every one is empty. */
function costliest(texts: WorkTexts): keyof WorkTexts | undefined {
  const keys = (Object.keys(texts) as (keyof WorkTexts)[]).filter((key) => texts[key] !== '');
  const cost = (key: keyof WorkTexts) => JSON.stringify(texts[key]).length;

  return keys.reduce<keyof WorkTexts | undefined>(
    (most, key) => (most === undefined || cost(key) > cost(most) ? key : most),
    undefined,
  );
}

/**
 * `build` with the texts of a work node shortened until the entry it makes is at most
 * `MAX_TREE_ENTRY_CHARS` of JSON: each round the one that costs most as JSON is halved, the output
 * from its start (its most recent part is the part that is kept) and the others from their end.
 * Each is bounded by the wire (`MAX_NODE_COMMAND_CHARS`, `MAX_NODE_OUTPUT_CHARS`, the description,
 * reason and error caps) and not by what an entry of this channel carries: control characters cost
 * six characters each as JSON, so thirty thousand of them do not fit, and a task an extension starts
 * may fill the description and the error as well. An entry that does not fit with every text empty
 * is returned as it is, for the store to refuse.
 */
function fittedWork(params: {
  texts: WorkTexts;
  build: (texts: WorkTexts) => ChannelEntry;
}): ChannelEntry {
  const { build } = params;
  // At most `MAX_TREE_ENTRY_CHARS` of each, since more cannot fit (see `fittedText`): the output
  // keeps its end, the others their start.
  let texts: WorkTexts = {
    command: head({ text: params.texts.command, length: MAX_TREE_ENTRY_CHARS }),
    output: tail({
      text: params.texts.output,
      from: Math.max(0, params.texts.output.length - MAX_TREE_ENTRY_CHARS),
    }),
    description: head({ text: params.texts.description, length: MAX_TREE_ENTRY_CHARS }),
    reason: head({ text: params.texts.reason, length: MAX_TREE_ENTRY_CHARS }),
    error: head({ text: params.texts.error, length: MAX_TREE_ENTRY_CHARS }),
  };
  let entry = build(texts);

  for (let key = costliest(texts); key; key = costliest(texts)) {
    if (JSON.stringify(entry).length <= MAX_TREE_ENTRY_CHARS) break;

    const text = texts[key];

    texts = {
      ...texts,
      [key]:
        key === 'output'
          ? tail({ text, from: Math.ceil(text.length / 2) })
          : head({ text, length: Math.floor(text.length / 2) }),
    };
    entry = build(texts);
  }

  return entry;
}

/**
 * A command or a service opened or closed, from the node and the task that holds what the registry
 * does not. It opens with no output, and closes with the most recent part of it (the preview; the
 * complete output is its own channel's), the exit code and the error. The command and the output are
 * cut to fit an entry, as the entry that opens its own channel cuts the command.
 */
export function workNodeEntry(
  params: TreeStamp & { type: 'node_opened' | 'node_closed'; node: NodeRecord; task: TaskInfo },
): ChannelEntry {
  const { type, node, task } = params;
  const closed = type === 'node_closed';

  return fittedWork({
    texts: {
      command: head({ text: task.command, length: MAX_NODE_COMMAND_CHARS }),
      output: closed
        ? tail({ text: task.output, from: Math.max(0, task.output.length - MAX_NODE_OUTPUT_CHARS) })
        : '',
      description: head({ text: task.description, length: MAX_NODE_DESCRIPTION_CHARS }),
      reason: head({ text: task.reason ?? '', length: MAX_NODE_REASON_CHARS }),
      error: head({ text: task.error ?? '', length: MAX_NODE_ERROR_CHARS }),
    },
    build: ({ command, output, description, reason, error }) => ({
      ...stamped(params),
      type,
      node: {
        ...workNodeOf({
          node,
          task: { ...task, description, ...(task.reason !== undefined && { reason }) },
          command,
          output,
        }),
        ...(closed && task.exitCode !== undefined && { exitCode: task.exitCode }),
        ...(closed && task.error !== undefined && { error }),
      },
    }),
  });
}

/** The concern a shortened command carries: it says what a client that shows only this must not do. */
function shortenedConcern(params: {
  kept: number;
  whole: number;
  /** How many concerns the request had, when they were dropped to fit: they are said to be. */
  concerns?: number;
}): ApprovalConcern {
  const dropped =
    params.concerns === undefined
      ? ''
      : ` and its ${String(params.concerns)} concerns are left out`;

  return {
    argument: 'command',
    reason: `Only the first ${String(params.kept)} of ${String(params.whole)} characters of the command${dropped} are in this entry: do not approve it from this text, read the whole request on the conversation's stream`,
  };
}

/**
 * A node's tool asks for approval. The request is the one the registry holds, with the whole
 * command, so a read-only subscriber sees what it would run. An entry holds at most
 * `MAX_TREE_ENTRY_CHARS`, and a command has no bound of its own near that, so a command that does
 * not fit is cut, and the request then says so: its first concern says it was cut (the first thing a
 * client shows), and it offers only to skip it (no run, no grant, no `keeps`), so a client that
 * answers from this entry alone can never approve a text it was not shown. If it still does not fit
 * with no command (its concerns or its tool name are that large, which holds for an empty command
 * too), the concerns are replaced by one that says so and the tool name is cut: such a request is
 * always cut, whatever it held, and always fits.
 */
export function approvalRequestedEntry(
  params: TreeStamp & { node: NodeId; request: ApprovalRequest },
): ChannelEntry {
  const { node, request } = params;
  const whole = request.command.length;
  const { keeps: _kept, ...bare } = request;
  // The call id is a provider's string with no bound of its own, and this copy is for display: it is
  // cut to what a node keeps of the call that started it, like the rest.
  const callId = callIdSchema.parse(head({ text: request.callId, length: MAX_NODE_CALL_ID_CHARS }));
  const entryOf = (request: ApprovalRequest): ChannelEntry => ({
    ...stamped(params),
    type: 'approval_requested',
    node,
    request: { ...request, callId },
  });
  const build = (command: string) =>
    command.length < whole
      ? entryOf({
          ...bare,
          command,
          options: CUT_APPROVAL_OPTIONS,
          concerns: [shortenedConcern({ kept: command.length, whole }), ...request.concerns],
        })
      : entryOf(request);
  const fitted = fittedText({ text: request.command, build });

  if (JSON.stringify(fitted).length <= MAX_TREE_ENTRY_CHARS) return fitted;

  return entryOf({
    ...bare,
    tool: head({ text: bare.tool, length: MAX_CUT_TOOL_CHARS }),
    command: '',
    options: CUT_APPROVAL_OPTIONS,
    concerns: [shortenedConcern({ kept: 0, whole, concerns: request.concerns.length })],
  });
}

/**
 * A waiting approval was answered. A message that goes with the answer (`skip_with_message`) has no
 * bound of its own near what an entry holds, so one that does not fit is cut and ends in `…`: the
 * answer is the user's and the model got all of it, and the entry only has to say what was answered.
 */
export function approvalResolvedEntry(
  params: TreeStamp & { node: NodeId; id: ApprovalId; response: ApprovalResponse },
): ChannelEntry {
  const { node, id, response } = params;
  const build = (answer: ApprovalResponse): ChannelEntry => ({
    ...stamped(params),
    type: 'approval_resolved',
    node,
    id,
    response: answer,
  });

  if (response.decision !== 'skip_with_message') return build(response);

  const whole = response.message.length;

  return fittedText({
    text: response.message,
    build: (message) =>
      build({
        ...response,
        message: message.length < whole ? `${message}…` : message,
      }),
  });
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

  while (JSON.stringify(entry).length > MAX_TREE_ENTRY_CHARS && limit > 1) {
    limit = Math.floor(limit / 2);
    entry = build(limit);
  }

  return entry;
}

/** The lines of `queued` cut to `limit` characters each. */
const cutLines = (params: { queued: readonly string[]; limit: number }) =>
  params.queued.map((line) => {
    const cut = head({ text: line, length: params.limit });

    // A cut to one unit of a line that opens with a two-unit character leaves nothing: keep that one.
    return cut === '' ? (Array.from(line)[0] ?? '') : cut;
  });

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
    text: head({ text: params.text, length: limit }),
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
    text: head({ text: params.text, length: limit }),
    error: head({ text: params.error, length: MAX_NODE_ERROR_CHARS }),
    queued: cutLines({ queued: params.queued, limit }),
  }));
}

/** The conversation could not be stored. Said once; it ends no run. */
export function storageFailedEntry(params: TreeStamp & { error: string }): ChannelEntry {
  return {
    ...stamped(params),
    type: 'storage_failed',
    error: head({ text: params.error, length: MAX_NODE_ERROR_CHARS }),
  };
}
