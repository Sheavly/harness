import type { FileRead } from '@sheavly/coding/read-file/read-file.types';
import { COMMAND_TOOL_NAMES } from '@sheavly/coding/run-command/run-command.constants';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { FIRST_LINE_MAX } from './render.constants.js';
import type { ModelConnection } from '@sheavly/protocol/connection/connection.types';
import type { ToolCall } from '@sheavly/protocol/message/message.types';
import type { ConversationDetails } from '@sheavly/protocol/server/server.types';
import { plainTerminalText } from './terminal-text.utils.js';

/** Text squeezed onto one line, cut at `max` characters with an ellipsis. */
export function oneLine(params: { text: string; max: number }): string {
  const { text, max } = params;
  const flat = text.replace(/\s+/g, ' ').trim();

  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * The first non-empty line, cut at 100 characters. Escape codes (a command's colours) are dropped
 * first: cutting through one would leave its style on for everything printed after it.
 */
export function firstLine(text: string): string {
  const line =
    plainTerminalText(stripVTControlCharacters(text))
      .split('\n')
      .find((l) => l.trim()) ?? '';

  return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX)}…` : line;
}

/** A connection report whose error text, a provider's own words, is one plain line. */
export function terminalConnection(connection: ModelConnection): ModelConnection {
  if (connection.state === 'restored') return connection;

  return { ...connection, error: firstLine(connection.error) };
}

/**
 * A tool's own summary line, uncut (a path's length is its own, and the line count that follows it
 * must stay), with a note of how many more lines the result holds: a hook can append a report for
 * the model, and a person should see that there is more, not the whole of it.
 */
export function ownLine(text: string): string {
  const lines = plainTerminalText(stripVTControlCharacters(text))
    .split('\n')
    .filter((line) => line.trim());
  const [first = '', ...rest] = lines;

  return rest.length > 0 ? `${first} · +${rest.length} lines for the model` : first;
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Session ids are UUIDs; the first 8 characters are plenty to tell them apart on screen. */
export function shortId(id: string | undefined): string {
  return id ? id.slice(0, 8) : '-';
}

/** The shell command of a `run_command` or `start_service` call, to show next to it. */
export function commandOf(call: ToolCall): string | undefined {
  const input = z.object({ command: z.string() }).safeParse(call.input);
  const runsCommand = COMMAND_TOOL_NAMES.some((tool) => tool === call.name);

  return runsCommand && input.success ? plainTerminalText(input.data.command) : undefined;
}

/** "read src/a.ts" for a whole file; "read src/a.ts lines 10–40 (of 900)" for part of one. */
export function describeRead(read: FileRead): string {
  if (read.whole) return `read ${read.path}`;

  if (read.endLine < read.startLine) {
    return `read ${read.path}: nothing past line ${read.totalLines}`;
  }

  return `read ${read.path} lines ${read.startLine}–${read.endLine} (of ${read.totalLines})`;
}

/**
 * Why a workspace's `.sheavly/` hooks were skipped, from a conversation's details, for a front end
 * to print, or undefined when nothing was skipped.
 */
export function projectTrustNotice(trust: ConversationDetails['projectTrust']): string | undefined {
  if (trust === 'untrusted') {
    return '⚠ .sheavly/ hooks not loaded: this workspace is not trusted. They run code from the repo; review .sheavly/, then rerun with --trust.';
  }

  if (trust === 'changed') {
    return '⚠ .sheavly/ hooks not loaded: .sheavly/ changed since you trusted this workspace. Review the changes, then rerun with --trust.';
  }

  return undefined;
}
