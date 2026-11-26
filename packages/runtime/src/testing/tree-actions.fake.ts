import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { TreeView } from '@sheavly/protocol/tree/tree.types';
import { applyTreeEntry } from '@sheavly/protocol/tree/tree.utils';
import { treeChannelEntrySchema, treeSnapshotSchema } from '@sheavly/protocol/tree/tree.validator';
import type { ApprovalRegistry } from '../approvals/approvals.service.js';
import type { TaskRegistry } from '../tasks/tasks.service.js';
import { startControlledTask } from './controlled-task.fake.js';

const CALL = callIdSchema.parse('call_1');

/**
 * Test-only: what a run's tests do that shows on its tree. They take the parts of a harness they
 * need, so a test of the host or of the backend passes the harness it has.
 */

/** A service the main agent started, which goes on running: a node on the tree. */
export const startRunningService = (run: { tasks: TaskRegistry; mainSession: { id: SessionId } }) =>
  startControlledTask({
    tasks: run.tasks,
    sessionId: run.mainSession.id,
    callId: CALL,
    backgroundKind: 'service',
    command: 'npm run dev',
    description: 'the dev server',
  });

/**
 * A tool of the main agent asks for approval, and waits for an answer only if someone listens: it
 * is refused at once (`no_listener`) when no one does, as a run's own tool is. Nothing is added
 * here, so a test shows what a connection that claims to answer makes of it.
 */
export const askUnheardApproval = (run: { approvals: ApprovalRegistry }) =>
  run.approvals.request({
    callId: CALL,
    tool: 'run_command',
    command: 'git push',
    concerns: [],
    signal: new AbortController().signal,
  });

/**
 * A tool of the main agent asks for approval and waits for an answer: an approval on the tree. A
 * listener is added, so the request waits instead of failing for want of one.
 */
export function askMainApproval(run: { approvals: ApprovalRegistry }) {
  run.approvals.subscribe(() => undefined);

  return askUnheardApproval(run);
}

/**
 * The tree a client ends with that starts from `snapshot` and folds each of `entries` after it, as
 * every client folds (`applyTreeEntry`). Both are parsed with the contract's schemas first, so a
 * frame that is not what the contract says fails the test instead of folding.
 */
export function treeFollowedFrom(params: {
  snapshot: unknown;
  entries: readonly unknown[];
}): TreeView {
  const start = treeSnapshotSchema.parse(params.snapshot);

  return params.entries.reduce<TreeView>(
    (tree, entry) => applyTreeEntry({ tree, entry: treeChannelEntrySchema.parse(entry) }),
    { nodes: start.nodes, approvals: start.approvals },
  );
}

/**
 * What a client that connects late shows of `snapshot`: each node as `kind state`, in order, and
 * how many approvals wait. A snapshot is large, and a test says what it must hold in a line.
 */
export const treeSummaryOf = (snapshot: TreeView) => ({
  nodes: snapshot.nodes.map(({ kind, state }) => `${kind} ${state}`),
  approvals: snapshot.approvals.length,
});

/** Answers the approval that waits longest, so nothing is left waiting when a test ends. */
export function answerWaitingApproval(run: { approvals: ApprovalRegistry }): void {
  const [waiting] = run.approvals.pending();

  if (!waiting) throw new Error('no approval is waiting');

  run.approvals.respond({ id: waiting.id, response: { decision: 'approve' } });
}
