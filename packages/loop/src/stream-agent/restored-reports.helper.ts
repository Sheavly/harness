import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import type { HarnessNotice } from '@sheavly/protocol/notice/notice.types';
import type { RunOutcome, SessionId, SessionInfo } from '@sheavly/protocol/session/session.types';

import { noticeEntries } from './notice-publish.helper.js';
import { RESTORED_REPORT_REASON } from './stream-agent.constants.js';
import { taskCompletionContext } from './task-context.utils.js';

type SubAgent = Extract<SessionInfo, { parentId: SessionId }>;

/**
 * The sub-agents of `main` that ended and whose report never reached `history`, as stored, oldest
 * first. A sub-agent is delivered when `history` has a notice that names its session: an
 * `agent-report`, or a `task-finished` of the task that ran it, alone or in a group.
 */
export function undeliveredAgents(params: {
  main: SessionId;
  sessions: readonly SessionInfo[];
  history: readonly HistoryMessage[];
}): SubAgent[] {
  const { main, sessions, history } = params;
  const delivered = deliveredIn(history);

  return sessions
    .filter((session): session is SubAgent => 'parentId' in session && session.parentId === main)
    .filter((agent) => !delivered.sessions.has(agent.id))
    .toSorted((first, second) => first.startedAt - second.startedAt);
}

/**
 * How a stored sub-agent's last run ended. One still open when the process ended was cut off: a
 * reopened conversation does not run it again.
 */
export function storedOutcome(agent: SubAgent): RunOutcome {
  if (agent.state === 'running' || agent.state === 'idle') return 'interrupted';

  return agent.state;
}

/**
 * The `agent-report` history entries a reopened conversation owes its main session, for the
 * sub-agents `undeliveredAgents` found, in that order and stamped `at`. `reports` holds the report
 * of each completed one that could be read back; a completed one with none (its history is
 * missing or unreadable) is `interrupted`, and any outcome but `completed` gets an empty report.
 * They carry no task id, since task ids restart when a conversation is reopened.
 */
export function restoredReportNotices(params: {
  agents: readonly SubAgent[];
  reports: ReadonlyMap<SessionId, string>;
  /** The conversation's history, for the completion context each report carries. */
  history: readonly HistoryMessage[];
  at: number;
}): HistoryMessage[] {
  const { agents, reports, history, at } = params;

  return agents.flatMap((agent) => {
    const read = reports.get(agent.id);
    const stored = storedOutcome(agent);
    // A completed sub-agent is only reported as one when its report was read back.
    const { outcome, report } =
      stored === 'completed' && read !== undefined
        ? { outcome: stored, report: read }
        : { outcome: stored === 'completed' ? 'interrupted' : stored, report: '' };
    // One still open when the process ended has no end time: it ended at its start, as far as is known.
    const endedAt = agent.endedAt ?? agent.startedAt;
    const notice: HarnessNotice = {
      kind: 'agent-report',
      // The card says how the sub-agent ended, not that it was open when the process did.
      agent: { ...agent, state: outcome, lastOutcome: outcome, endedAt },
      outcome,
      report,
      context: taskCompletionContext({
        reason: RESTORED_REPORT_REASON,
        startedAt: agent.startedAt,
        endedAt,
        history,
        callId: agent.startedByCall,
      }),
    };

    return noticeEntries({ notice, at });
  });
}

type Delivered = { sessions: Set<SessionId> };

/**
 * The sub-agent sessions history already tells the model about. A notice names its agent by
 * session, never by the tool call that started it: a provider repeats call ids (`call_0` in every
 * turn), so a call id says which of several sub-agents it was no better than which of several
 * tasks. A `task-finished` names the session its task ran (`TaskInfo.agentSessionId`), which a
 * conversation stored before that field existed does not carry: the failure of such a sub-agent is
 * told once more when the conversation is reopened.
 */
function deliveredIn(history: readonly HistoryMessage[]): Delivered {
  const delivered: Delivered = { sessions: new Set() };

  for (const message of history) {
    if (message.role !== 'notice') continue;

    const { notice } = message;

    for (const member of notice.kind === 'tasks-finished' ? notice.notices : [notice]) {
      noteDelivered({ notice: member, delivered });
    }
  }

  return delivered;
}

function noteDelivered(params: { notice: HarnessNotice; delivered: Delivered }): void {
  const { notice, delivered } = params;

  if (notice.kind === 'agent-report') {
    delivered.sessions.add(notice.agent.id);
  }

  if (notice.kind === 'task-finished' && notice.task.agentSessionId !== undefined) {
    delivered.sessions.add(notice.task.agentSessionId);
  }
}
