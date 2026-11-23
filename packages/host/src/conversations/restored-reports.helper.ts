import { StoreError } from '@sheavly/core/errors/store.errors';
import { readHistoryEntries } from '@sheavly/core/store/history-log.helper';
import type { ConversationStore } from '@sheavly/core/store/store.types';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import { isMainSession } from '@sheavly/protocol/session/session.utils';
import type { StoredLog } from '@sheavly/runtime/sessions/sessions.types';
import {
  restoredReportNotices,
  storedOutcome,
  undeliveredAgents,
} from '@sheavly/loop/stream-agent/restored-reports.helper';
import { finalReply } from '@sheavly/tools/sub-agent/sub-agent.utils';

/**
 * The `agent-report` entries a reopened conversation owes its main session: a sub-agent that
 * ended, or was cut off, before its report reached `history`. The report of a completed one is
 * read back from that sub-agent's stored history (`finalReply`, the same text its task returned),
 * so nothing new is stored; one whose history is empty or unreadable is reported `interrupted`.
 * Only direct children of the main session are owed: a deeper one reports to its own parent, whose
 * history is not restored. Appended after `history`, so it reaches the model once, at the next
 * prompt; a second reopen finds them in history and adds nothing.
 */
export async function owedAgentReports(params: {
  store: ConversationStore;
  id: ConversationId;
  resume: StoredLog;
  history: readonly HistoryMessage[];
  at: number;
}): Promise<HistoryMessage[]> {
  const { store, id, resume, history, at } = params;
  const main = resume.sessions.find(isMainSession);

  if (!main) return [];

  // The released ones too: a sub-agent is released as its notice enters the history, and a crash
  // can lose that write while keeping the release, which is exactly the report that is owed, for a
  // failed or limit-stopped one as much as for a completed one. Except one that ended interrupted:
  // a task cancelled on request (`cancel_task`) is released with no notice by design, and the model
  // was told by the cancel itself, so its absence from the history is not a report owed.
  const releasedWithNotice = (resume.released ?? []).filter(
    (session) => session.state !== 'interrupted',
  );
  const agents = undeliveredAgents({
    main: main.id,
    sessions: [...resume.sessions, ...releasedWithNotice],
    history,
  });
  const reports = new Map<SessionId, string>();

  for (const agent of agents) {
    if (storedOutcome(agent) !== 'completed') continue;

    const report = await storedReport({ store, id, session: agent.id });

    if (report !== undefined) reports.set(agent.id, report);
  }

  return restoredReportNotices({ agents, reports, history, at });
}

/**
 * A completed sub-agent's report from its stored history, or undefined when there is none to read:
 * the history is empty (a completed one holds at least its task) or the store failed on it. One
 * damaged sub-agent log must not stop the whole conversation from reopening. A `StoreError` cannot
 * tell a damaged log from a transient read fault, so the second also loses the report for good:
 * the `interrupted` notice is logged, and the next reopen finds it delivered.
 */
async function storedReport(params: {
  store: ConversationStore;
  id: ConversationId;
  session: SessionId;
}): Promise<string | undefined> {
  const { store, id, session } = params;

  try {
    const messages = await readHistoryEntries(store.history({ id, session }));

    return messages.length === 0 ? undefined : finalReply(messages);
  } catch (caughtError) {
    if (caughtError instanceof StoreError) return undefined;

    throw caughtError;
  }
}
