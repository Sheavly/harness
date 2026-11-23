// beforeShellExecution: the safety net under the /git skill. Denies a branch that isn't
// `<issue>-<kebab-name>` for one of the chat's issues, staging that isn't by name, `git push
// --force` without `--with-lease`, a `gh pr merge` that isn't a squash, `git cherry-pick` until the
// user allowed it in the chat, a `git commit` whose message breaks the format or would open an
// editor, a `gh issue create` without an `area/*` label, and the interactive forms of `gh stack`
// (stacked PRs themselves are allowed). People aren't checked: only agent shell commands pass
// through hooks.
import path from 'node:path';
import { chatWorkflow, linkFromToolCall } from './chat-links.utils.mjs';
import {
  checkBranch,
  checkCherryPick,
  checkIssueCreate,
  checkPrMerge,
  checkPush,
  checkStaging,
  ghNewBranches,
  gitNewBranches,
} from './git-guard.utils.mjs';
import { checkStack } from './stack-guard.utils.mjs';
import {
  checkCommitMessage,
  getBranchIssue,
  listAreaLabels,
  listScopes,
} from './git-workflow.utils.mjs';
import {
  currentBranch,
  PROJECT_ROOT,
  readHookInput,
  repoRoot,
  runGuard,
  sameRepo,
} from './hooks.utils.mjs';
import {
  commitDirectory,
  normalize,
  readCommitMessage,
  stripMessages,
  toSegments,
  withoutHeredocBodies,
} from './shell-parse.utils.mjs';

const QUOTED_PROSE = '__quoted__';
const COMMIT_FORMAT_FIX =
  'Fix the message (format and examples in .agents/skills/git/conventions.md); a reviewer reads the PR commit by commit, so each one needs it.';

// Quoted values with spaces (`-m "add export"`) are prose, not words: keeping them whole stops
// a message from being read as branch names. Single-word quotes (`"12-api"`) stay.
function readSegments(command) {
  const prose = withoutHeredocBodies(stripMessages(command)).replace(
    /"([^"]*)"|'([^']*)'/g,
    (match, double, single) => {
      const value = double ?? single;

      return value === '' || /\s/.test(value) ? QUOTED_PROSE : match;
    },
  );

  return toSegments(normalize(prose));
}

/** Why one command of a shell line breaks the workflow, or null. Collects the branches it creates. */
function checkSegment(params) {
  const { tokens, state, newBranches } = params;
  const [program = '', ...args] = tokens;
  const name = path.basename(program);

  if (name === 'git') {
    newBranches.push(...gitNewBranches(args));

    return (
      checkStaging(args) ??
      checkPush(args) ??
      checkCherryPick({ args, allowCherryPick: Boolean(state?.allowCherryPick) })
    );
  }

  if (name !== 'gh') return null;
  if (args[0] === 'stack') return checkStack({ args: args.slice(1), newBranches });
  newBranches.push(...ghNewBranches(args));

  if (args[0] === 'pr' && args[1] === 'merge') return checkPrMerge(args.slice(2));

  if (args[0] === 'issue' && args[1] === 'create') {
    return checkIssueCreate({ args: args.slice(2), areas: listAreaLabels(PROJECT_ROOT) });
  }

  return null;
}

/**
 * The checkout a commit's message is checked against: the one the command names (`git -C <dir>`,
 * a leading `cd`) when it is a worktree of the session's own repository, which has its own branch
 * and its own new packages and is where the commit lands; otherwise the session's checkout. A
 * repository the command made or points at is not believed, since it could carry any branch and
 * any packages. The command is read as text, like the message: a `cd` that is not first, `GIT_DIR`,
 * `--git-dir`, a second commit or text that only mentions `git -C` can still point it elsewhere,
 * so this is a net for the honest mistake, not a boundary; the PR's commit list is what a
 * reviewer reads.
 */
function commitCheckout(params) {
  const { command, cwd } = params;
  const session = repoRoot(cwd) ?? PROJECT_ROOT;
  const named = repoRoot(commitDirectory({ command, cwd }));

  return named && sameRepo(named, session) ? named : session;
}

/**
 * Why a `git commit` command's message would fail the format, or null. The scopes and the branch
 * are those of the checkout the commit is made in (`commitCheckout`), not always of the folder
 * the session started in: a worktree has its own.
 */
function checkCommitCommand(params) {
  const { command, cwd } = params;
  const read = readCommitMessage(command);

  if (!read || read.reused || read.file) return null;

  if (read.editor) {
    return '`git commit` without `-m` or `-F` opens an editor and hangs; pass the message with a heredoc (see the /git skill, commit.md).';
  }

  // A message built at run time (`$VAR`, `$(…)` other than a heredoc) can't be read here; the
  // PR's commit list shows it to the reviewer.
  if (/\$[({A-Za-z_]/.test(read.message)) return null;

  const root = commitCheckout({ command, cwd });
  const branch = currentBranch(root);
  const where = root === (repoRoot(cwd) ?? PROJECT_ROOT) ? '' : ` of ${root}`;
  const problems = checkCommitMessage({
    message: read.message,
    scopes: listScopes(root),
    issue: branch ? getBranchIssue(branch) : null,
    issueSource: `branch ${branch ?? '(detached)'}${where}`,
  });

  return problems.length > 0 ? `${problems.join(' ')} ${COMMIT_FORMAT_FIX}` : null;
}

function findViolation(input) {
  const command = input.command ?? '';

  // A subagent answers to the issues and approvals of the chat that started it.
  linkFromToolCall(input);
  const state = chatWorkflow(input.conversation_id);
  const newBranches = [];

  for (const tokens of readSegments(command)) {
    const problem = checkSegment({ tokens, state, newBranches });

    if (problem) return problem;
  }

  const commitProblem = checkCommitCommand({ command, cwd: input.cwd ?? PROJECT_ROOT });

  if (commitProblem) return commitProblem;

  return (
    newBranches
      .map((name) => checkBranch({ name, chatIssues: state.issues, noIssue: state.noIssue }))
      .find(Boolean) ?? null
  );
}

const DENIED = 'Blocked a git/gh command that breaks the git workflow';

await runGuard({
  guard: 'git workflow',
  check: async () => {
    const violation = findViolation(await readHookInput());

    if (!violation) return { permission: 'allow' };

    return {
      permission: 'deny',
      user_message: DENIED,
      agent_message: `${violation} The workflow is in the /git skill (.agents/skills/git/).`,
    };
  },
  deny: (reason) => ({ permission: 'deny', user_message: reason, agent_message: reason }),
});
