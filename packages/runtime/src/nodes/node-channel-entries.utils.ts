import type { ChannelEntry } from '@sheavly/core/store/store.types';
import {
  MAX_CHANNEL_ENTRY_CHARS,
  MAX_OMITTED_CALL_CHARS,
  TREE_ONLY_EVENT_TYPES,
} from '@sheavly/protocol/channel/channel.constants';
import type { RunStartCause } from '@sheavly/protocol/channel/channel.types';
import type { EntryEvent } from '@sheavly/protocol/event/event.types';
import type { MessageId } from '@sheavly/protocol/message/message.types';
import {
  MAX_NODE_COMMAND_CHARS,
  MAX_NODE_DESCRIPTION_CHARS,
  MAX_NODE_ERROR_CHARS,
  MAX_NODE_REASON_CHARS,
} from '@sheavly/protocol/node/node.constants';
import { MAX_QUEUED_LINE_CHARS } from '@sheavly/protocol/server/server.constants';
import type { TaskInfo } from '@sheavly/protocol/task/task.types';
import { MAX_BYTE_OFFSET } from './nodes.constants.js';
import type { NodeRecord } from './nodes.types.js';

/** The cursor of position `position` in a channel that numbers its entries. */
export const sequenceCursor = (position: number): string => `s${String(position)}`;

/**
 * The cursor for `offset` bytes into an output. Whole and within fifteen digits, whatever it was
 * given: an offset a reader could not read back would refuse the entry.
 */
export function byteCursor(offset: number): string {
  const whole = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;

  return `b${String(Math.min(whole, MAX_BYTE_OFFSET))}`;
}

/** An agent's node as its channel holds it: what the registry keeps of it is the whole of it. */
export const agentNodeOf = (node: NodeRecord) => ({ ...node, kind: 'agent' });

/**
 * `build(command)` with `command` cut in half until the entry it makes is at most
 * `MAX_CHANNEL_ENTRY_CHARS` of JSON, as a store requires: the one field of a node with no bound of
 * its own near that (`MAX_NODE_COMMAND_CHARS` is far above it). An entry that does not fit even with
 * no command is returned as it is, for the store to refuse.
 */
function fittedEntry(params: {
  command: string;
  build: (command: string) => ChannelEntry;
}): ChannelEntry {
  const { build } = params;
  let command = params.command;
  let entry = build(command);

  while (JSON.stringify(entry).length > MAX_CHANNEL_ENTRY_CHARS && command.length > 0) {
    command = command.slice(0, Math.floor(command.length / 2));
    entry = build(command);
  }

  return entry;
}

/**
 * A command's or a service's node as its entries hold it: the registry keeps only its title and
 * times, so the command, the description and the reason come from the task, and `output` is what
 * the entry says of it (empty when it opens, since the complete output is the output store's).
 */
export function workNodeOf(params: {
  node: NodeRecord;
  task: TaskInfo;
  command: string;
  output: string;
}) {
  const { node, task, command, output } = params;

  return {
    ...node,
    command,
    description: task.description.slice(0, MAX_NODE_DESCRIPTION_CHARS),
    output,
    ...(task.reason !== undefined && { reason: task.reason.slice(0, MAX_NODE_REASON_CHARS) }),
    ...(task.outputLog && { outputLog: task.outputLog }),
  };
}

/**
 * The entry that opens an agent's channel: the agent as it was. Its cursor is the start of a
 * numbered channel. A sub-agent's entry also says where its parent's channel stood, which the
 * writer adds when it writes the entry, from what the store holds then.
 */
export function openedAgentEntry(params: { node: NodeRecord; at: number }): ChannelEntry {
  const { node, at } = params;

  return {
    channel: node.id,
    cursor: sequenceCursor(0),
    at,
    type: 'opened',
    node: agentNodeOf(node),
  };
}

/**
 * The entry that opens a command's or a service's channel, which is counted in bytes of its output,
 * so it starts at 0. The registry keeps only a work node's title and times, so the command, the
 * description and the reason come from the task; its output starts empty, since the complete output
 * is the output store's and the node closes with its size.
 *
 * A stored entry is at most `MAX_CHANNEL_ENTRY_CHARS` of JSON, far under what a command can be
 * (`MAX_NODE_COMMAND_CHARS`), so a command that does not fit is shortened until it does: the one
 * field of the node with no bound of its own near that.
 */
export function openedWorkEntry(params: {
  node: NodeRecord;
  task: TaskInfo;
  at: number;
}): ChannelEntry {
  const { node, task, at } = params;

  return fittedEntry({
    command: task.command.slice(0, MAX_NODE_COMMAND_CHARS),
    build: (command) => ({
      channel: node.id,
      cursor: byteCursor(0),
      at,
      type: 'opened',
      node: workNodeOf({ node, task, command, output: '' }),
    }),
  });
}

/** A change to a live agent: the node as it is now. Only an agent's channel has them. */
export function updatedEntry(params: {
  node: NodeRecord;
  at: number;
  position: number;
}): ChannelEntry {
  const { node, at, position } = params;

  return {
    channel: node.id,
    cursor: sequenceCursor(position),
    at,
    type: 'updated',
    node: agentNodeOf(node),
  };
}

/**
 * How a task's output ended, for its channel's `closed` entry: `complete`, or `incomplete` with what
 * was lost. None for a task that kept no output, and for a log still `capturing`, which a task that
 * has ended never has (its log is closed before it settles).
 */
function outputEndOf(task: TaskInfo | undefined) {
  const log = task?.outputLog;

  if (!log || log.status === 'capturing') return undefined;

  return {
    status: log.status,
    ...(log.reason !== undefined && { reason: log.reason.slice(0, MAX_NODE_REASON_CHARS) }),
  };
}

/**
 * The entry that ends a node's channel: the state it ended in, and the detail the state does not
 * keep. An agent's last run's outcome, except for `lost`, which has none; a command's or a
 * service's exit code, error and how its output ended, from the task it was.
 */
export function closedEntry(params: {
  node: NodeRecord;
  at: number;
  cursor: string;
  task?: TaskInfo | undefined;
}): ChannelEntry {
  const { node, at, cursor, task } = params;
  const { state, lastOutcome } = node;
  const output = outputEndOf(task);

  return {
    channel: node.id,
    cursor,
    at,
    type: 'closed',
    state,
    ...(lastOutcome && state !== 'lost' && { outcome: lastOutcome }),
    ...(task?.exitCode !== undefined && { exitCode: task.exitCode }),
    ...(output && { output }),
    ...(task?.error !== undefined && { error: task.error.slice(0, MAX_NODE_ERROR_CHARS) }),
  };
}

/** Whether a loop event of `type` is the conversation's (the tree channel's) and not an agent's. */
export const isTreeOnlyEvent = (type: string): boolean =>
  (TREE_ONLY_EVENT_TYPES as readonly string[]).includes(type);

/**
 * The header of the one tool call an event carries (`tool_call_started`, `tool_result`,
 * `task_running`), for an `event_omitted` entry: its id and its tool name cut to
 * `MAX_OMITTED_CALL_CHARS`. None for an event of no call or of several (`tool_batch`), and for an id
 * that is empty, over that length or not well formed: a cut id would end the wrong call's step, so
 * it is never cut.
 */
function omittedCallOf(event: EntryEvent) {
  if (
    event.type !== 'tool_call_started' &&
    event.type !== 'tool_result' &&
    event.type !== 'task_running'
  ) {
    return undefined;
  }

  const { id, name } = event.call;

  if (id.length === 0 || id.length > MAX_OMITTED_CALL_CHARS || !id.isWellFormed()) {
    return undefined;
  }

  return { id, name: head({ text: name, length: MAX_OMITTED_CALL_CHARS }) };
}

/**
 * The entry that stores a loop event on its agent's channel: the event as the stream carried it,
 * with the originating `messageId` where there was one, and, for a text delta that merges the ones
 * after it, the `seq` of the last (`lastSeq`). A store keeps an entry of at most
 * `MAX_CHANNEL_ENTRY_CHARS` and refuses a longer one, which would leave the channel closed to every
 * entry after it, so an event that does not fit is stored as what says there was one (`event_omitted`:
 * its type, its `seq`, its size and the header of its call (`omittedCallOf`), never its content).
 * The combined stream still holds it whole.
 */
export function eventEntry(params: {
  channel: string;
  cursor: string;
  at: number;
  event: EntryEvent;
  messageId?: MessageId | undefined;
  lastSeq?: number | undefined;
}): ChannelEntry {
  const { channel, cursor, at, event, messageId, lastSeq } = params;
  const entry: ChannelEntry = {
    channel,
    cursor,
    at,
    type: 'event',
    event,
    ...(messageId !== undefined && { messageId }),
    ...(lastSeq !== undefined && { lastSeq }),
  };

  if (JSON.stringify(entry).length <= MAX_CHANNEL_ENTRY_CHARS) return entry;

  const call = omittedCallOf(event);

  return {
    channel,
    cursor,
    at,
    type: 'event_omitted',
    eventType: event.type,
    seq: event.seq,
    size: JSON.stringify(event).length,
    ...(messageId !== undefined && { messageId }),
    ...(call && { call }),
  };
}

/**
 * The first `length` characters of `text`, never ending inside a surrogate pair, and well formed
 * whatever `text` held (a lone surrogate in it is replaced): a lone surrogate is not text, and a
 * strict JSON reader refuses the escape it is written as.
 */
export function head(params: { text: string; length: number }): string {
  const { text, length } = params;
  const cut = text.slice(0, length);

  return (
    /[\uD800-\uDBFF]$/u.test(cut) && cut.length < text.length ? cut.slice(0, -1) : cut
  ).toWellFormed();
}

/**
 * The entry that says a run of an agent started: why (`cause`), and the user message it answers.
 * A prompt's entry also holds the prompt's `text`, cut as the tree channel's `prompt_started` cuts
 * it (to `MAX_QUEUED_LINE_CHARS`) and then halved until the entry is at most
 * `MAX_CHANNEL_ENTRY_CHARS` of JSON, as a store requires: control characters cost six characters
 * each as JSON, so a line of them does not fit. A wake has no text.
 */
export function runStartedEntry(params: {
  channel: string;
  cursor: string;
  at: number;
  cause: RunStartCause;
  messageId: MessageId;
  text?: string | undefined;
}): ChannelEntry {
  const { channel, cursor, at, cause, messageId } = params;
  const build = (text: string | undefined): ChannelEntry => ({
    channel,
    cursor,
    at,
    type: 'run_started',
    cause,
    messageId,
    ...(text !== undefined && { text }),
  });

  if (params.text === undefined) return build(undefined);

  let text = head({ text: params.text, length: MAX_QUEUED_LINE_CHARS });
  let entry = build(text);

  while (JSON.stringify(entry).length > MAX_CHANNEL_ENTRY_CHARS && text) {
    text = head({ text, length: Math.floor(text.length / 2) });
    entry = build(text);
  }

  return entry;
}

/**
 * The entry that ends the channel of a node the server stopped under: `lost`, with no outcome and
 * no exit code, since nobody saw it end. Its cursor is where the channel stood.
 */
export function lostEntry(params: { channel: string; cursor: string; at: number }): ChannelEntry {
  const { channel, cursor, at } = params;

  return { channel, cursor, at, type: 'closed', state: 'lost' };
}
