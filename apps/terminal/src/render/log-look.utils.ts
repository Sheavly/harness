import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { Look } from './render.types.js';
import { shortId } from './render.utils.js';

const who = (params: { title: string; id: SessionId }) =>
  `"${params.title}" [${shortId(params.id)}]`;

/**
 * The plain, complete log of a run: every event, ids and counts included, no colour. The demo and
 * the workbook print it, and their saved runs and checks read it, so its text is kept as it is.
 */
export const logLook: Look = {
  // Each activity carries its own leading newline here; nothing is added between sections.
  gap: () => '',
  pairSteps: false,
  toolStarted: ({ description, command }) =>
    `\n⏺ ${description}${command ? `  $ ${command}` : ''}\n`,
  parallel: (count) => `  ⎿ ${count} tools in parallel\n`,
  toolResult: ({ ok, label, detail, seconds }) =>
    `    ${ok ? '✓' : '✗'} ${label}${detail} · ${seconds}\n`,
  // The saved runs and checks read this log, so a file change stays out of it.
  fileChange: () => '',
  failure: () => '',
  taskRunning: ({ label, id }) => `    ↻ ${label}running in background as ${id}\n`,
  taskCompleted: ({ ok, id, status, exit, elapsed, command, output }) =>
    `\n${ok ? '✓' : '✗'} ${id} ${status}${exit} · ${elapsed} · $ ${command}${
      output ? `\n  ⎿ ${output}\n` : '\n'
    }`,
  steer: (firstLine) => `\n✉ steer: ${firstLine}\n`,
  contextAdded: ({ hook, chars }) => `\n＋ ${hook} added context (${chars} chars)\n`,
  modelInputChanged: ({ hook, added, removed, edited }) =>
    `\n± ${hook} changed this call's messages (+${added} −${removed} ~${edited})\n`,
  summaryStarted: () => '\n… summarizing\n',
  summaryDone: ({ tokensBefore, tokensAfter }) =>
    `\n✓ summarized chat (${tokensBefore} → ${tokensAfter} tokens)\n`,
  summaryFailed: ({ error }) => `\n✗ couldn't summarize: ${error}\n`,
  runFailed: (error) => `\n✗ Model run failed: ${error}\n`,
  hookFailed: ({ hook, handler, error }) => `\n✗ hook ${hook} failed in ${handler}: ${error}\n`,
  storageFailed: (error) => `\n✗ chat could not be saved: ${error}\n`,
  modelConnection: (connection) => {
    if (connection.state === 'restored') return '\n✓ reconnected\n';

    if (connection.state === 'offline') {
      return `\n… reconnecting: no internet connection, waiting for it (${connection.error})\n`;
    }

    return `\n… provider not responding, retry ${connection.attempt}/${connection.retries} (${connection.error})\n`;
  },
  extensionEvent: ({ extension, text }) => `\n⬡ ${extension}: ${text}\n`,
  // A cut turn has no `model_connection` line of its own when the connection is back at once, and
  // the log is the complete record, so it says so; the chat look draws nothing for it.
  turnEnd: ({ stopReason }) => {
    if (stopReason === 'connection_lost') return '\n\n… connection lost mid-reply, continuing\n';

    return stopReason === 'tool_use' || stopReason === 'max_tokens'
      ? ''
      : `\n\n[stop: ${stopReason}]\n`;
  },
  awaitingTasks: (count) => `… waiting for ${count} background task(s) · Ctrl+C to stop\n`,
  done: ({ reason, events, reasoning }) =>
    `[${reason} · ${events} events · reasoning items kept: ${reasoning}]\n`,
  subAgentStarted: ({ indent, depth, parent, root, ...agent }) =>
    `\n${indent}◆ sub-agent ${who(agent)} started · depth ${depth} · parent ${shortId(parent)} · main ${shortId(root)}\n`,
  subAgentStatus: ({ indent, status, ...agent }) =>
    `${indent}  ◇ ${who(agent)} status: ${status}\n`,
  subAgentMessage: ({ indent, from, content, ...agent }) =>
    `${indent}  ✉ ${who(agent)} got a message from ${from}: ${content}\n`,
  subAgentEnded: ({ indent, state, ...agent }) => `${indent}◆ sub-agent ${who(agent)} ${state}\n`,
};
