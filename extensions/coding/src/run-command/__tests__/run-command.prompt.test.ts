import { describe, expect, it } from 'vitest';
import { backgroundStartedPrompt, runCommandPrompts } from '../run-command.prompt.js';

const baseDescription =
  'Run a command in the workspace root (or in `cwd`: a folder of the workspace or of a sibling git worktree), without a shell. Chain commands with | && || and ;; ' +
  'redirects (> <), $variables, `backticks`, parentheses and & are not supported, and inside ' +
  "double quotes so is $ (use 'single quotes'; a backslash before other characters is literal, " +
  'so grep -E \'a\\|b\' src and grep -E "a\\|b" src both pass a\\|b). The user is asked before ' +
  'an unapproved base command runs. A session or workspace grant covers all its options and arguments, ' +
  'including paths outside the workspace, secret files, editing/execution options and npx downloads. ' +
  'Examples: find, sed, git diff, npm run test, npx eslint. Chained commands are approved independently. ' +
  'There is no shell glob expansion. If the user skips a command, do not run it again; do what they say.';

const backgroundDescription =
  ' Set background: true for slow finite work, and use start_service for a persistent server or watcher. Do not poll background work.';

const inputPrompts = {
  command: 'The command to run, e.g. `git status`',
  cwd:
    'Folder to run in, absolute or relative to the workspace root (default: the root). ' +
    'It must be inside the workspace or a sibling git worktree of its repo.',
  background:
    'Return a task id immediately. Finite work keeps this prompt alive until its result is delivered, and you are woken then. ' +
    'Finish independent work, then end your turn without tool calls. Do not poll task_status or call await_tasks for one task.',
};

describe('run_command prompt output equivalence', () => {
  it.each([false, true])('preserves metadata with background enabled: %s', (backgroundEnabled) => {
    expect(runCommandPrompts({ backgroundEnabled })).toEqual({
      description: baseDescription + (backgroundEnabled ? backgroundDescription : ''),
      ...inputPrompts,
    });
  });

  it.each([
    [
      true,
      'This finite task keeps this prompt alive until its result is delivered automatically, and you are woken then. Finish independent work, then end your turn without tool calls. Do not poll task_status, call await_tasks for it alone, or repeat the command. Use cancel_task to stop it.',
    ],
    [
      false,
      'This service does not keep this prompt alive. Use task_status only to inspect readiness or diagnose a problem, not to wait for exit. Stop it with cancel_task when finished.',
    ],
  ] as const)('preserves the launch instructions verbatim (finite: %s)', (finite, guidance) => {
    expect(backgroundStartedPrompt({ taskId: 't7', command: 'echo "hello"', finite })).toBe(
      `Started background task t7: $ echo "hello"\n${guidance}`,
    );
  });
});
