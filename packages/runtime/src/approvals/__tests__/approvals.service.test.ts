import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { ApprovalListenerError } from '../../errors/approvals.errors.js';
import { numberedApprovals } from '../../testing/approvals.fake.js';
import { ApprovalRegistry } from '../approvals.service.js';
import { MAX_PENDING_APPROVALS } from '../approvals.constants.js';
import type { ApprovalUpdate } from '@sheavly/protocol/approval/approval.types';
import { approvalIdSchema } from '@sheavly/protocol/approval/approval.validator';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';

const a1 = approvalIdSchema.parse('a1');
const c1 = callIdSchema.parse('c1');
const s1 = sessionIdSchema.parse('s1');

const ask = (approvals: ApprovalRegistry, signal = new AbortController().signal) =>
  approvals.request({
    callId: c1,
    sessionId: s1,
    tool: 'run_command',
    command: 'ls ..',
    concerns: [{ argument: '..', reason: 'reaches outside the workspace' }],
    signal,
  });

function listen(approvals: ApprovalRegistry): ApprovalUpdate[] {
  const updates: ApprovalUpdate[] = [];

  approvals.subscribe((update) => updates.push(update));

  return updates;
}

describe('ApprovalRegistry', () => {
  it('announces a typed request and waits for the answer', async () => {
    const approvals = numberedApprovals();
    const updates = listen(approvals);
    const answer = ask(approvals);

    expect(updates).toEqual([
      {
        type: 'approval_requested',
        request: {
          id: 'a1',
          callId: 'c1',
          sessionId: 's1',
          tool: 'run_command',
          command: 'ls ..',
          concerns: [{ argument: '..', reason: 'reaches outside the workspace' }],
          options: ['approve', 'skip', 'skip_with_message'],
        },
      },
    ]);
    expect(approvals.pending().map((request) => request.id)).toEqual(['a1']);

    approvals.respond({ id: a1, response: { decision: 'skip_with_message', message: ' hi ' } });

    await expect(answer).resolves.toEqual({ decision: 'skip_with_message', message: 'hi' });
    expect(updates.at(-1)).toEqual({
      type: 'approval_resolved',
      id: 'a1',
      response: { decision: 'skip_with_message', message: 'hi' },
    });
    expect(approvals.pending()).toEqual([]);
  });

  it('drops a source a client sends, so only the registry can mark a hook’s answer', async () => {
    const approvals = numberedApprovals();

    listen(approvals);
    const answer = ask(approvals);

    approvals.respond({
      id: a1,
      response: { decision: 'skip_with_message', message: 'use ls', source: 'hook' },
    });

    await expect(answer).resolves.toEqual({ decision: 'skip_with_message', message: 'use ls' });
  });

  it('rejects at once when no one is listening', async () => {
    await expect(ask(numberedApprovals())).rejects.toThrow('No one is listening');
  });

  it('tells observers every update first, but an observer alone can’t answer', async () => {
    const approvals = numberedApprovals();
    const order: string[] = [];

    approvals.observe((update) => order.push(`observer:${update.type}`));
    await expect(ask(approvals)).rejects.toThrow('No one is listening');
    expect(approvals.listening).toBe(false);

    approvals.subscribe((update) => order.push(`listener:${update.type}`));
    // Left waiting on purpose: only the order its request was heard in matters here.
    void ask(approvals);

    expect(order).toEqual(['observer:approval_requested', 'listener:approval_requested']);
  });

  it('cancels a waiting request when its call is interrupted', async () => {
    const approvals = numberedApprovals();
    const updates = listen(approvals);
    const controller = new AbortController();
    const answer = ask(approvals, controller.signal);

    controller.abort();

    await expect(answer).rejects.toThrow();
    expect(updates.at(-1)).toEqual({ type: 'approval_cancelled', id: 'a1' });
    expect(() => approvals.respond({ id: a1, response: { decision: 'approve' } })).toThrow(
      'No approval is waiting with id a1',
    );
  });

  it('offers the options the caller names, and takes only those', async () => {
    const approvals = numberedApprovals();
    const updates = listen(approvals);

    const answer = approvals.request({
      callId: c1,
      tool: 'run_command',
      command: 'git log',
      concerns: [],
      options: ['approve', 'always_allow', 'skip'],
      keeps: ['git log'],
      signal: new AbortController().signal,
    });

    expect(approvals.pending()[0]).toMatchObject({
      options: ['approve', 'always_allow', 'skip'],
      keeps: ['git log'],
    });
    expect(updates[0]).toMatchObject({
      type: 'approval_requested',
      request: { keeps: ['git log'] },
    });

    expect(() =>
      approvals.respond({ id: a1, response: { decision: 'skip_with_message', message: 'no' } }),
    ).toThrow('not one of the options offered');
    expect(approvals.pending()).toHaveLength(1);

    approvals.respond({ id: a1, response: { decision: 'always_allow' } });
    await expect(answer).resolves.toEqual({ decision: 'always_allow' });
  });

  it('does not take always_allow for a request that did not offer it', () => {
    const approvals = numberedApprovals();

    listen(approvals);
    void ask(approvals);

    expect(() => approvals.respond({ id: a1, response: { decision: 'always_allow' } })).toThrow(
      expect.objectContaining({ reason: 'not_offered' }) as Error,
    );
    expect(approvals.pending()).toHaveLength(1);
  });

  it.each([
    { decision: 'yes' },
    { decision: 'skip_with_message' },
    { decision: 'skip_with_message', message: '   ' },
  ])('rejects a malformed answer (%o) and keeps waiting', (response) => {
    const approvals = numberedApprovals();

    listen(approvals);
    void ask(approvals);

    expect(() => approvals.respond({ id: a1, response })).toThrow(ZodError);
    expect(approvals.pending()).toHaveLength(1);
  });

  it('answers each request once', async () => {
    const approvals = numberedApprovals();

    listen(approvals);
    const answer = ask(approvals);

    approvals.respond({ id: a1, response: { decision: 'approve' } });
    await expect(answer).resolves.toEqual({ decision: 'approve' });
    expect(() => approvals.respond({ id: a1, response: { decision: 'skip' } })).toThrow();
  });

  it('a listener that throws fails the request loudly, after every other listener heard it', async () => {
    const approvals = numberedApprovals();

    approvals.subscribe(() => {
      throw new Error('UI bug');
    });
    const updates = listen(approvals);
    const failed = await ask(approvals).catch((caughtError: unknown) => caughtError);

    expect(failed).toBeInstanceOf(ApprovalListenerError);
    expect(failed).toMatchObject({ update: 'approval_requested' });
    expect((failed as Error).message).toContain('UI bug');
    // The listeners that heard it asked are told it is gone, so none keeps showing a dead request.
    expect(updates.map((update) => update.type)).toEqual([
      'approval_requested',
      'approval_cancelled',
    ]);
    expect(approvals.pending()).toEqual([]);
  });

  it('a listener that throws on an answer still resolves the call, then tells the responder', async () => {
    const approvals = numberedApprovals();
    const updates = listen(approvals);
    const answered = ask(approvals);

    approvals.subscribe(() => {
      throw new Error('UI bug');
    });

    expect(() => approvals.respond({ id: a1, response: { decision: 'approve' } })).toThrow(
      ApprovalListenerError,
    );
    await expect(answered).resolves.toEqual({ decision: 'approve' });
    expect(updates.map((update) => update.type)).toEqual([
      'approval_requested',
      'approval_resolved',
    ]);
  });

  it('a listener that throws on a cancel fails the call with that error', async () => {
    const approvals = numberedApprovals();

    listen(approvals);
    const controller = new AbortController();
    const interrupted = ask(approvals, controller.signal);

    approvals.subscribe(() => {
      throw new Error('UI bug');
    });
    controller.abort();

    await expect(interrupted).rejects.toBeInstanceOf(ApprovalListenerError);
    expect(approvals.pending()).toEqual([]);
  });

  it('every listener hears requested before resolved, even when an earlier one answers at once', async () => {
    const approvals = numberedApprovals();

    approvals.subscribe((update) => {
      if (update.type === 'approval_requested') {
        approvals.respond({ id: update.request.id, response: { decision: 'approve' } });
      }
    });
    const later = listen(approvals);

    await expect(ask(approvals)).resolves.toEqual({ decision: 'approve' });
    expect(later.map((update) => update.type)).toEqual(['approval_requested', 'approval_resolved']);
  });
});

/** The ids of the requests a registry is waiting on, after `count` were asked. */
function askedIds(params: { approvals: ApprovalRegistry; count: number }) {
  listen(params.approvals);

  for (let asked = 0; asked < params.count; asked++) void ask(params.approvals);

  return params.approvals.pending().map((request) => request.id);
}

describe('the ids a registry issues', () => {
  it('are unique, and a registry made later (a reopened conversation) never repeats one', () => {
    const first = askedIds({ approvals: new ApprovalRegistry(), count: 200 });
    const reopened = askedIds({ approvals: new ApprovalRegistry(), count: 200 });

    expect(new Set([...first, ...reopened]).size).toBe(400);
  });

  it('are random, not a counter a stale client could guess or a reopen could repeat', () => {
    const [id] = askedIds({ approvals: new ApprovalRegistry(), count: 1 });

    expect(id).toMatch(/^a-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  });

  it('cannot be answered by a stale client: another registry refuses an id it never issued', () => {
    const [stale] = askedIds({ approvals: new ApprovalRegistry(), count: 1 });
    const reopened = new ApprovalRegistry();

    listen(reopened);
    void ask(reopened);

    expect(stale).toBeDefined();
    expect(() =>
      reopened.respond({ id: approvalIdSchema.parse(stale), response: { decision: 'approve' } }),
    ).toThrow(expect.objectContaining({ reason: 'unknown_id' }) as Error);
    expect(reopened.pending()).toHaveLength(1);
  });
});

describe('how many approvals may wait', () => {
  it('refuses one past the bound, failing closed, and takes another once one is answered', async () => {
    const approvals = new ApprovalRegistry();
    const [first] = askedIds({ approvals, count: MAX_PENDING_APPROVALS });

    expect(approvals.pending()).toHaveLength(MAX_PENDING_APPROVALS);
    await expect(ask(approvals)).rejects.toMatchObject({ reason: 'too_many_pending' });
    expect(approvals.pending()).toHaveLength(MAX_PENDING_APPROVALS);

    approvals.respond({ id: approvalIdSchema.parse(first), response: { decision: 'approve' } });
    void ask(approvals);

    expect(approvals.pending()).toHaveLength(MAX_PENDING_APPROVALS);
  });
});
