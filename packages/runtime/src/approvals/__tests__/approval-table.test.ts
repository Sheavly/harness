import { describe, expect, it } from 'vitest';
import { ApprovalListenerError } from '../../errors/approvals.errors.js';
import { numberedApprovals } from '../../testing/approvals.fake.js';
import type { ApprovalRegistry } from '../approvals.service.js';
import { ApprovalStates } from '../approval-states.service.js';
import { APPROVAL_TABLE, SETTLED_KEPT } from '../approvals.constants.js';
import type { ApprovalUpdate } from '@sheavly/protocol/approval/approval.types';
import { approvalIdSchema } from '@sheavly/protocol/approval/approval.validator';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';

const a1 = approvalIdSchema.parse('a1');
const s1 = sessionIdSchema.parse('s1');
const s2 = sessionIdSchema.parse('s2');

const ask = (params: {
  approvals: ApprovalRegistry;
  sessionId?: typeof s1;
  signal?: AbortSignal;
}) =>
  params.approvals.request({
    callId: callIdSchema.parse('c1'),
    sessionId: params.sessionId ?? s1,
    tool: 'run_command',
    command: 'ls ..',
    concerns: [],
    signal: params.signal ?? new AbortController().signal,
  });

function listen(approvals: ApprovalRegistry): ApprovalUpdate[] {
  const updates: ApprovalUpdate[] = [];

  approvals.subscribe((update) => updates.push(update));

  return updates;
}

describe('the approval table', () => {
  it('lets a request move once, from requested only', () => {
    expect(APPROVAL_TABLE.requested).toEqual(['answered', 'cancelled', 'expired']);
    expect(APPROVAL_TABLE.answered).toEqual([]);
    expect(APPROVAL_TABLE.cancelled).toEqual([]);
    expect(APPROVAL_TABLE.expired).toEqual([]);
  });

  it('refuses every move out of a terminal state, and from an unknown id', () => {
    const states = new ApprovalStates();

    states.begin(a1);
    expect(states.move({ id: a1, to: 'answered' })).toBe(true);
    expect(states.move({ id: a1, to: 'cancelled' })).toBe(false);
    expect(states.move({ id: a1, to: 'answered' })).toBe(false);
    expect(states.get(a1)).toBe('answered');
    expect(states.move({ id: approvalIdSchema.parse('a9'), to: 'answered' })).toBe(false);
  });

  it('forgets the oldest settled approvals past the bound, never an open one', () => {
    const states = new ApprovalStates();
    const open = approvalIdSchema.parse('open');

    states.begin(open);

    for (let i = 0; i < SETTLED_KEPT + 5; i++) {
      const id = approvalIdSchema.parse(`b${i}`);

      states.begin(id);
      states.move({ id, to: 'answered' });
    }

    expect(states.get(open)).toBe('requested');
    expect(states.get(approvalIdSchema.parse('b0'))).toBeUndefined();
    expect(states.get(approvalIdSchema.parse(`b${SETTLED_KEPT + 4}`))).toBe('answered');
  });
});

describe('ApprovalRegistry states', () => {
  it('is requested while it waits, then answered', async () => {
    const approvals = numberedApprovals();

    listen(approvals);
    const answer = ask({ approvals });

    expect(approvals.state(a1)).toBe('requested');
    approvals.respond({ id: a1, response: { decision: 'approve' } });
    await answer;
    expect(approvals.state(a1)).toBe('answered');
  });

  it('refuses an answer after a cancel, and says it was cancelled', async () => {
    const approvals = numberedApprovals();
    const updates = listen(approvals);
    const controller = new AbortController();
    const answer = ask({ approvals, signal: controller.signal });

    controller.abort();
    await expect(answer).rejects.toThrow();

    expect(approvals.state(a1)).toBe('cancelled');
    expect(() => approvals.respond({ id: a1, response: { decision: 'approve' } })).toThrow(
      'No approval is waiting with id a1 (it is cancelled)',
    );
    expect(updates.map((update) => update.type)).toEqual([
      'approval_requested',
      'approval_cancelled',
    ]);
  });

  it('refuses a second answer and keeps the first', async () => {
    const approvals = numberedApprovals();
    const updates = listen(approvals);
    const answer = ask({ approvals });

    approvals.respond({ id: a1, response: { decision: 'approve' } });
    expect(() => approvals.respond({ id: a1, response: { decision: 'skip' } })).toThrow(
      '(it is answered)',
    );
    await expect(answer).resolves.toEqual({ decision: 'approve' });
    expect(updates.filter((update) => update.type === 'approval_resolved')).toHaveLength(1);
  });

  it('expires a request nobody can hear: no listener, or a listener that throws', async () => {
    const approvals = numberedApprovals();

    await expect(ask({ approvals })).rejects.toThrow('No one is listening');
    expect(approvals.state(a1)).toBe('expired');

    approvals.subscribe(() => {
      throw new Error('UI bug');
    });
    await expect(ask({ approvals })).rejects.toBeInstanceOf(ApprovalListenerError);
    expect(approvals.state(approvalIdSchema.parse('a2'))).toBe('expired');
  });

  it('cancels the waiting requests of a session that ended, and only those', async () => {
    const approvals = numberedApprovals();
    const updates = listen(approvals);
    const ended = ask({ approvals, sessionId: s1 });
    const other = ask({ approvals, sessionId: s2 });

    approvals.cancelSession(s1);

    await expect(ended).rejects.toMatchObject({ reason: 'session_ended' });
    expect(approvals.state(a1)).toBe('cancelled');
    expect(approvals.pending().map((request) => request.id)).toEqual(['a2']);
    expect(updates.at(-1)).toEqual({ type: 'approval_cancelled', id: 'a1' });

    approvals.respond({ id: approvalIdSchema.parse('a2'), response: { decision: 'approve' } });
    await expect(other).resolves.toEqual({ decision: 'approve' });
  });

  it('does not announce a request whose session ended while its screeners were still working', async () => {
    const approvals = numberedApprovals();
    const updates = listen(approvals);
    const screening = Promise.withResolvers<undefined>();

    approvals.screen(async () => {
      await screening.promise;

      return undefined;
    });

    const waiting = ask({ approvals, sessionId: s1 });

    approvals.cancelSession(s1);
    screening.resolve(undefined);

    await expect(waiting).rejects.toMatchObject({ reason: 'session_ended' });
    expect(approvals.state(a1)).toBe('cancelled');
    expect(updates).toEqual([]);
    expect(approvals.pending()).toEqual([]);
  });

  it('answers once for a screener that settles the request', async () => {
    const approvals = numberedApprovals();

    listen(approvals);
    approvals.screen(() => Promise.resolve({ decision: 'skip' }));

    await expect(ask({ approvals })).resolves.toEqual({ decision: 'skip', source: 'hook' });
    expect(approvals.state(a1)).toBe('answered');
  });
});
