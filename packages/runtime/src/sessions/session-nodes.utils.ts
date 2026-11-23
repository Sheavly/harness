import type {
  RunOutcome,
  SessionInfo,
  SessionState,
} from '@sheavly/protocol/session/session.types';
import { NODE_STATE_OF_OUTCOME } from '@sheavly/protocol/status/status.constants';
import type { NodeRecord, RestoredNode } from '../nodes/nodes.types.js';

/**
 * The state a session reports for its agent node. An open node is as it is; an ended one is how
 * its last run ended; a node the server was lost under reads as `interrupted`, the nearest
 * session state, since a session has no `lost`.
 */
export function sessionStateOf(node: NodeRecord): SessionState {
  if (node.state === 'running' || node.state === 'idle') return node.state;
  if (node.state === 'lost') return 'interrupted';

  return node.lastOutcome ?? (node.state === 'cancelled' ? 'interrupted' : node.state);
}

/** How a session's last run ended, as the node keeps it; a lost node's was cut off. */
export function sessionOutcomeOf(node: NodeRecord): RunOutcome | undefined {
  return node.state === 'lost' ? 'interrupted' : node.lastOutcome;
}

/**
 * What a node needs to be put back as `session` was: its state, end time and last outcome. An
 * ended session's state is how its last run ended, which is the outcome of its node, whose own
 * state is the one that outcome gives.
 */
export function restoredFieldsOf(
  session: SessionInfo,
): Pick<RestoredNode, 'state' | 'endedAt' | 'lastOutcome' | 'status'> {
  const status = session.status === undefined ? {} : { status: session.status };

  if (session.state === 'running' || session.state === 'idle') {
    return {
      state: session.state,
      ...(session.lastOutcome && { lastOutcome: session.lastOutcome }),
      ...status,
    };
  }

  return {
    state: NODE_STATE_OF_OUTCOME[session.state],
    endedAt: session.endedAt,
    lastOutcome: session.state,
    ...status,
  };
}
