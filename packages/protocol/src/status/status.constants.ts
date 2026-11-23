/**
 * Where a session is: running a prompt, idle between prompts, or ended with how its last run
 * finished. A run is a session's `running` stretch, so a run's outcome is one of the ended states
 * (`RUN_OUTCOMES`), and a run's `done` carries the same one.
 */
export const SESSION_STATES = [
  'running',
  'idle',
  'completed',
  'interrupted',
  'max_turns',
  'max_tokens',
  'context_window_exceeded',
  'failed',
] as const;

/** How a run ends: every session state but the two that are still open. */
export const RUN_OUTCOMES = [
  'completed',
  'interrupted',
  'max_turns',
  'max_tokens',
  'context_window_exceeded',
  'failed',
] as const;

export const TASK_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;

/**
 * Where a node is: the one lifecycle of every kind of node (the root agent, a sub-agent, a command,
 * a service, a kind an extension adds). `running`; `idle` for an agent between prompts, open for
 * the next; and the terminal `completed`, `failed`, `cancelled` and `lost`. `lost` is written only
 * when a conversation is reopened, for a node the server stopped under, never to a live one.
 */
export const NODE_STATES = ['running', 'idle', 'completed', 'failed', 'cancelled', 'lost'] as const;

/** Why one turn ended: the model's reason, or `interrupted` when the run's signal aborted. */
export const TURN_STOP_REASONS = [
  'end_turn',
  'tool_use',
  'max_tokens',
  'context_window_exceeded',
  'interrupted',
] as const;

/** What a session snapshot is refused with when its state, last outcome and end disagree. */
export const INCONSISTENT_SESSION_MESSAGE =
  'An open session has no endedAt; an ended one has an endedAt and a lastOutcome equal to its state';

/**
 * The one table of what may follow what, for each machine that has states. A key is a state and
 * its value the states it may move to; a state with none is final. A running session moves to
 * `idle` (kept for the conversation's next prompt) or to an ended state; an idle one runs again or
 * ends. A node is the one lifecycle that replaces both the session and the task (the wire model:
 * `packages/protocol/docs/wire-model.md`); until the node registry exists the other two stand.
 * Restoring a stored conversation is not a move: it builds a session from what was stored.
 * `status.utils.test.ts` checks the keys against the lists above and every pair against this
 * table, and the state-machines guide prints it (`npm run schema -w @sheavly/protocol`).
 */
export const STATUS_TABLE = {
  session: {
    running: [
      'idle',
      'completed',
      'interrupted',
      'max_turns',
      'max_tokens',
      'context_window_exceeded',
      'failed',
    ],
    idle: [
      'running',
      'completed',
      'interrupted',
      'max_turns',
      'max_tokens',
      'context_window_exceeded',
      'failed',
    ],
    completed: [],
    interrupted: [],
    max_turns: [],
    max_tokens: [],
    context_window_exceeded: [],
    failed: [],
  },
  task: {
    running: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
  },
  /**
   * A node moves to a terminal state once, and a terminal state is final. `idle` is for agents
   * only, which the node schema holds (a table of states cannot say it). `lost` is listed as a
   * move from an open state because the repair at a reopen goes through the table, but a live
   * node never takes it: only a reopen writes it.
   */
  node: {
    running: ['idle', 'completed', 'failed', 'cancelled', 'lost'],
    idle: ['running', 'completed', 'failed', 'cancelled', 'lost'],
    completed: [],
    failed: [],
    cancelled: [],
    lost: [],
  },
} as const;
