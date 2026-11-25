export function runCommandPrompts(params: {
  backgroundEnabled: boolean;
  outputsEnabled?: boolean;
}): {
  description: string;
  command: string;
  cwd: string;
  background: string;
} {
  const { backgroundEnabled, outputsEnabled = false } = params;

  return {
    description:
      'Run a command in the workspace root (or in `cwd`: a folder of the workspace or of a sibling git worktree), without a shell. Chain commands with | && || and ;; ' +
      'redirects (> <), $variables, `backticks`, parentheses and & are not supported, and inside ' +
      "double quotes so is $ (use 'single quotes'; a backslash before other characters is literal, " +
      'so grep -E \'a\\|b\' src and grep -E "a\\|b" src both pass a\\|b). The user is asked before ' +
      'an unapproved base command runs. A session or workspace grant covers all its options and arguments, ' +
      'including paths outside the workspace, secret files, editing/execution options and npx downloads. ' +
      'Examples: find, sed, git diff, npm run test, npx eslint. Chained commands are approved independently. ' +
      'There is no shell glob expansion. If the user skips a command, do not run it again; do what they say.' +
      (outputsEnabled
        ? ' Output shown is a bounded preview: long output is cut in the middle. The complete output is stored and the result gives its output_ref; use read_output or search_output on it instead of rerunning the command.'
        : '') +
      (backgroundEnabled
        ? ' Set background: true for slow finite work, and use start_service for a persistent server or watcher. Do not poll background work.'
        : ''),
    command: 'The command to run, e.g. `git status`',
    cwd:
      'Folder to run in, absolute or relative to the workspace root (default: the root). ' +
      'It must be inside the workspace or a sibling git worktree of its repo.',
    background:
      'Return a task id immediately. Finite work keeps this prompt alive until its result is delivered, and you are woken then. ' +
      'Finish independent work, then end your turn without tool calls. Do not poll task_status or call await_tasks for one task.',
  };
}

/** Receives launch facts after the task has been started by runtime code. */
export function backgroundStartedPrompt(params: {
  taskId: string;
  command: string;
  /** Whether the work keeps the prompt alive (`isFiniteKind` of its kind); a service does not. */
  finite: boolean;
  outputLines?: readonly string[];
}): string {
  const { taskId, command, finite, outputLines = [] } = params;
  const started = [`Started background task ${taskId}: $ ${command}`, ...outputLines, ''].join(
    '\n',
  );

  if (finite) {
    return (
      started +
      'This finite task keeps this prompt alive until its result is delivered automatically, and you are woken then. Finish independent work, then end your turn without tool calls. Do not poll task_status, call await_tasks for it alone, or repeat the command. Use cancel_task to stop it.'
    );
  }

  return (
    started +
    'This service does not keep this prompt alive. Use task_status only to inspect readiness or diagnose a problem, not to wait for exit. Stop it with cancel_task when finished.'
  );
}
