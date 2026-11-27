import { collapsedChange } from '../changes/changes-text.utils.js';
import { collapsedFailure } from '../failures/failures-text.utils.js';
import { defaultPalette } from '../theme/palette.utils.js';
import type { Palette } from '../theme/theme.types.js';
import type { Look } from './render.types.js';

/** Everything the chat look says except how it shows a file change or a failure. */
function stepsOf(palette: Palette): Omit<Look, 'fileChange' | 'failure'> {
  const { paint } = palette;

  return {
    // A blank line between the reply and the steps around it, in both directions.
    gap: ({ from, to, lineOpen }) => {
      if (from === undefined || from === to) return '';
      if (to === 'reply') return '\n';

      return lineOpen ? '\n\n' : '\n';
    },
    pairSteps: true,
    toolStarted: ({ description, command }) =>
      `${paint.text.accent('⏺')} ${description}${command ? paint.text.secondary(`  $ ${command}`) : ''}\n`,
    parallel: () => '',
    toolResult: ({ ok, label, detail, seconds }) => {
      if (!ok) {
        return `  ${paint.text.secondary('⎿')} ${paint.status.error(`✗ ${label}${detail}`)} ${paint.text.secondary(`· ${seconds}`)}\n`;
      }

      return `  ${paint.text.secondary('⎿')} ${paint.status.success('✓')} ${label}${detail} ${paint.text.secondary(`· ${seconds}`)}\n`;
    },
    tooLarge: ({ tool, eventType }) =>
      `  ${paint.text.secondary('⎿')} ${paint.status.warning(`⚠ ${tool === undefined ? `a ${eventType} event` : `the result of ${tool}`} was too large to show`)}\n`,
    taskRunning: ({ label, id }) =>
      `  ${paint.text.secondary('↻')} ${label}running in background as ${id}\n`,
    taskCompleted: ({ ok, id, status, exit, elapsed, command, output }) => {
      const mark = ok ? paint.status.success('✓') : paint.status.error('✗');
      const head = `${mark} ${id} ${status}${exit} ${paint.text.secondary(`· ${elapsed} · $ ${command}`)}\n`;

      return output ? `${head}  ${paint.text.secondary(`⎿ ${output}`)}\n` : head;
    },
    steer: (firstLine) => `${paint.status.warning('✉')} steer: ${firstLine}\n`,
    contextAdded: ({ hook, chars }) =>
      paint.text.secondary(`＋ ${hook} added context (${chars} chars)\n`),
    modelInputChanged: ({ hook, added, removed, edited }) =>
      paint.text.secondary(
        `± ${hook} changed this call's messages (+${added} −${removed} ~${edited})\n`,
      ),
    summaryStarted: () => paint.text.secondary('… Summarizing\n'),
    summaryDone: ({ tokensBefore, tokensAfter }) =>
      paint.text.secondary(`✓ Summarized chat (${tokensBefore} → ${tokensAfter} tokens)\n`),
    // The cause is stored in the stream and shown in the plain log, not here: a person in the chat
    // needs to know the chat carries on, not a model's internal error.
    summaryFailed: ({ cancelled }) =>
      cancelled
        ? ''
        : paint.text.secondary('… Could not shorten the conversation this time, carrying on\n'),
    runFailed: (error) => paint.status.error(`✗ Model run failed: ${error}\n`),
    hookFailed: ({ hook, handler, error }) =>
      paint.status.error(`✗ hook ${hook} failed in ${handler}: ${error}\n`),
    storageFailed: (error) =>
      paint.status.error(`✗ This chat could not be saved: ${error}\n  The next prompt retries.\n`),
    // The provider's error text is stored in the stream and shown in the plain log, not here.
    modelConnection: (connection) => {
      if (connection.state === 'restored') return paint.status.success('✓ Reconnected\n');

      if (connection.state === 'offline') {
        return paint.status.warning(
          '… Reconnecting… no internet connection, waiting for it to come back · Ctrl+C to stop\n',
        );
      }

      return paint.status.warning(
        `… The model provider is not responding, retrying (${connection.attempt}/${connection.retries})\n`,
      );
    },
    extensionEvent: ({ extension, text }) => paint.text.secondary(`⬡ ${extension}: ${text}\n`),
    turnEnd: () => '',
    awaitingTasks: (count) =>
      paint.text.secondary(`… waiting for ${count} background task(s) · Ctrl+C to stop\n`),
    done: ({ reason }) => {
      if (reason === 'interrupted') return paint.text.secondary('■ stopped\n');
      if (reason === 'max_turns') return paint.status.warning('⚠ stopped at the turn limit\n');

      if (reason === 'max_tokens') {
        return paint.status.warning(
          '⚠ stopped at the output-token limit; the reply is incomplete\n',
        );
      }

      if (reason === 'context_window_exceeded') {
        return paint.status.warning(
          '⚠ stopped at the context limit; reduce the conversation or start a new one\n',
        );
      }

      return '';
    },
    subAgentStarted: ({ indent, title }) =>
      `${indent}${paint.text.accent('◆')} ${title} ${paint.text.secondary('started')}\n`,
    subAgentStatus: ({ indent, title, status }) =>
      `${indent}  ${paint.text.secondary(`◇ ${title}: ${status}`)}\n`,
    subAgentMessage: ({ indent, title, content }) =>
      `${indent}  ${paint.text.secondary(`✉ ${title} got a message: ${content}`)}\n`,
    subAgentEnded: ({ indent, title, state }) =>
      `${indent}${paint.text.accent('◆')} ${title} ${state === 'completed' ? paint.status.success(state) : paint.status.warning(state)}\n`,
  };
}

/**
 * What a person reading a conversation wants: the reply as plain text, and what the run did
 * around it kept small and dim, one line per step. Counts, ids and the loop's bookkeeping, which
 * the log look prints, are left out; a problem (a failure, a limit) is shown in colour. A file
 * change, and a failure with more to say than its line, is one collapsed line each; `/changes`,
 * `/errors` and Ctrl+O show them in full. Coloured by `palette`, the default theme's if none.
 */
export function createChatLook(palette: Palette = defaultPalette): Look {
  return {
    ...stepsOf(palette),
    fileChange: (edit) => collapsedChange({ edit, palette }),
    failure: (failure) => collapsedFailure({ failure, palette }),
  };
}
