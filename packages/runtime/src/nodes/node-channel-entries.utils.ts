import type { ChannelEntry } from '@sheavly/core/store/store.types';
import { MAX_CHANNEL_ENTRY_CHARS } from '@sheavly/protocol/channel/channel.constants';
import {
  MAX_NODE_COMMAND_CHARS,
  MAX_NODE_DESCRIPTION_CHARS,
  MAX_NODE_ERROR_CHARS,
  MAX_NODE_REASON_CHARS,
} from '@sheavly/protocol/node/node.constants';
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
export function fittedEntry(params: {
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
 * The entry that ends a node's channel: the state it ended in, and the detail the state does not
 * keep. An agent's last run's outcome, except for `lost`, which has none; a command's or a
 * service's exit code and error, from the task it was.
 */
export function closedEntry(params: {
  node: NodeRecord;
  at: number;
  cursor: string;
  task?: TaskInfo | undefined;
}): ChannelEntry {
  const { node, at, cursor, task } = params;
  const { state, lastOutcome } = node;

  return {
    channel: node.id,
    cursor,
    at,
    type: 'closed',
    state,
    ...(lastOutcome && state !== 'lost' && { outcome: lastOutcome }),
    ...(task?.exitCode !== undefined && { exitCode: task.exitCode }),
    ...(task?.error !== undefined && { error: task.error.slice(0, MAX_NODE_ERROR_CHARS) }),
  };
}

/**
 * The entry that ends the channel of a node the server stopped under: `lost`, with no outcome and
 * no exit code, since nobody saw it end. Its cursor is where the channel stood.
 */
export function lostEntry(params: { channel: string; cursor: string; at: number }): ChannelEntry {
  const { channel, cursor, at } = params;

  return { channel, cursor, at, type: 'closed', state: 'lost' };
}
