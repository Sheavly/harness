import { describe, expect, it } from 'vitest';
import { doneReasonSchema } from '../../event/event.validator.js';
import { turnStopReasonSchema } from '../../message/message.validator.js';
import { runOutcomeSchema, sessionStateSchema } from '../../session/session.validator.js';
import { taskStatusSchema } from '../../task/task.validator.js';
import {
  NODE_STATES,
  RUN_OUTCOMES,
  SESSION_STATES,
  STATUS_TABLE,
  TASK_STATUSES,
} from '../status.constants.js';
import { canTransition, isConsistentSession, statusTableMarkdown } from '../status.utils.js';

const OPEN = ['running', 'idle'];

describe('the status table', () => {
  it('has a row for every state and only those', () => {
    expect(Object.keys(STATUS_TABLE.session)).toEqual([...SESSION_STATES]);
    expect(Object.keys(STATUS_TABLE.task)).toEqual([...TASK_STATUSES]);
    expect(Object.keys(STATUS_TABLE.node)).toEqual([...NODE_STATES]);
  });

  it('lists as moves of a node only states that exist', () => {
    for (const next of Object.values(STATUS_TABLE.node)) {
      for (const state of next) expect(NODE_STATES).toContain(state);
    }
  });

  it.each(NODE_STATES.flatMap((from) => NODE_STATES.map((to) => [from, to] as const)))(
    'node %s -> %s is allowed only as the table says',
    (from, to) => {
      const listed = (STATUS_TABLE.node[from] as readonly string[]).includes(to);

      expect(canTransition({ machine: 'node', from, to })).toBe(listed);
    },
  );

  it('lets a node end once: running and idle move on, a terminal state is final', () => {
    const terminal = ['completed', 'failed', 'cancelled', 'lost'];

    for (const state of NODE_STATES) {
      expect(STATUS_TABLE.node[state].length === 0).toBe(terminal.includes(state));
    }

    for (const from of terminal) {
      for (const to of NODE_STATES) {
        expect(canTransition({ machine: 'node', from: from as 'failed', to })).toBe(false);
      }
    }
  });

  it('lets an agent go idle and run again, and refuses to run again after ending', () => {
    expect(canTransition({ machine: 'node', from: 'running', to: 'idle' })).toBe(true);
    expect(canTransition({ machine: 'node', from: 'idle', to: 'running' })).toBe(true);
    expect(canTransition({ machine: 'node', from: 'failed', to: 'running' })).toBe(false);
    expect(canTransition({ machine: 'node', from: 'lost', to: 'running' })).toBe(false);
  });

  it('lists as moves only states that exist', () => {
    for (const next of Object.values(STATUS_TABLE.session)) {
      for (const state of next) expect(SESSION_STATES).toContain(state);
    }

    for (const next of Object.values(STATUS_TABLE.task)) {
      for (const state of next) expect(TASK_STATUSES).toContain(state);
    }
  });

  it.each(SESSION_STATES.flatMap((from) => SESSION_STATES.map((to) => [from, to] as const)))(
    'session %s -> %s is allowed only as the table says',
    (from, to) => {
      const listed = (STATUS_TABLE.session[from] as readonly string[]).includes(to);

      expect(canTransition({ machine: 'session', from, to })).toBe(listed);
    },
  );

  it.each(TASK_STATUSES.flatMap((from) => TASK_STATUSES.map((to) => [from, to] as const)))(
    'task %s -> %s is allowed only as the table says',
    (from, to) => {
      const listed = (STATUS_TABLE.task[from] as readonly string[]).includes(to);

      expect(canTransition({ machine: 'task', from, to })).toBe(listed);
    },
  );

  it('only lets an open session move on: an ended one is final', () => {
    for (const state of SESSION_STATES) {
      const final = STATUS_TABLE.session[state].length === 0;

      expect(final).toBe(!OPEN.includes(state));
    }

    expect(canTransition({ machine: 'session', from: 'idle', to: 'running' })).toBe(true);
    expect(canTransition({ machine: 'session', from: 'completed', to: 'running' })).toBe(false);
    expect(canTransition({ machine: 'task', from: 'completed', to: 'failed' })).toBe(false);
  });
});

describe('the enums derived from the table', () => {
  it('are the table, with nothing added or dropped', () => {
    expect(sessionStateSchema.options).toEqual([...SESSION_STATES]);
    expect(taskStatusSchema.options).toEqual([...TASK_STATUSES]);
    expect(runOutcomeSchema.options).toEqual([...RUN_OUTCOMES]);
    expect(doneReasonSchema.options).toEqual([...RUN_OUTCOMES]);
  });

  it('keep the run outcomes to the ended session states', () => {
    expect([...RUN_OUTCOMES]).toEqual(SESSION_STATES.filter((state) => !OPEN.includes(state)));
  });

  it('keep a turn reason separate: it is why a model call ended, not how a run did', () => {
    expect(turnStopReasonSchema.options).toContain('end_turn');
    expect(runOutcomeSchema.options).not.toContain('end_turn');
  });
});

describe('isConsistentSession', () => {
  it('accepts an open session with no end and an ended one with its own outcome', () => {
    expect(isConsistentSession({ state: 'running' })).toBe(true);
    expect(isConsistentSession({ state: 'idle', lastOutcome: 'failed' })).toBe(true);
    expect(isConsistentSession({ state: 'failed', lastOutcome: 'failed', endedAt: 3 })).toBe(true);
  });

  it('rejects an open session that has ended, and an ended one with another outcome', () => {
    expect(isConsistentSession({ state: 'running', endedAt: 3 })).toBe(false);
    expect(isConsistentSession({ state: 'idle', endedAt: 3 })).toBe(false);
    expect(isConsistentSession({ state: 'failed', lastOutcome: 'completed', endedAt: 3 })).toBe(
      false,
    );
  });

  it('rejects an ended session that lacks its end time or its last outcome', () => {
    expect(isConsistentSession({ state: 'failed', lastOutcome: 'failed' })).toBe(false);
    expect(isConsistentSession({ state: 'failed', endedAt: 3 })).toBe(false);
    expect(isConsistentSession({ state: 'completed' })).toBe(false);
  });
});

describe('the guide table', () => {
  it('has a row for every state of every machine', () => {
    const rows = statusTableMarkdown().split('\n').slice(2);

    expect(rows).toHaveLength(SESSION_STATES.length + TASK_STATUSES.length + NODE_STATES.length);
    expect(rows[0]).toBe(
      '| session | `running` | idle, completed, interrupted, max_turns, max_tokens, context_window_exceeded, failed |',
    );
  });
});
