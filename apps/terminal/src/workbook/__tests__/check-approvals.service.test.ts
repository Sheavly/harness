import { describe, expect, it, vi } from 'vitest';
import { RefusedError } from '@sheavly/client/errors/client.errors';
import type { ApprovalId } from '@sheavly/protocol/approval/approval.types';
import {
  approvalIdSchema,
  approvalRequestSchema,
} from '@sheavly/protocol/approval/approval.validator';
import type { AskedApproval } from '../../client/client.types.js';
import { CheckApprovals } from '../check-approvals.service.js';

function fakeConversation() {
  let hear: (asked: AskedApproval) => void = () => undefined;
  let gone: (id: ApprovalId) => void = () => undefined;
  const accepted = Promise.withResolvers<undefined>();
  const ended = Promise.withResolvers<undefined>();
  const controller = new AbortController();
  const watchApprovals = vi.fn(
    async (params: {
      onApproval: (asked: AskedApproval) => void;
      onGone: (id: ApprovalId) => void;
      signal: AbortSignal;
    }) => {
      hear = params.onApproval;
      gone = params.onGone;
      params.signal.addEventListener('abort', () => ended.resolve(undefined), { once: true });
      await accepted.promise;
      params.signal.throwIfAborted();

      return { ended: ended.promise };
    },
  );
  const answerApproval = vi.fn(async () => undefined);
  const verifyWorkspace = vi.fn(async () => undefined);
  const conversation = { watchApprovals, answerApproval };
  const watcher = new CheckApprovals({ conversation, approvedCommands: ['node'], verifyWorkspace });
  const request = approvalRequestSchema.parse({
    id: 'one',
    callId: 'call',
    command: 'node check.mjs',
    tool: 'run_command',
    concerns: [{ argument: 'node check.mjs', reason: 'is not allowed yet' }],
    keeps: ['node *'],
    options: ['approve', 'allow_session', 'always_allow', 'skip'],
  });
  const ask = (command = request.command) => hear({ request: { ...request, command } });

  return {
    watcher,
    accepted,
    ended,
    controller,
    conversation,
    verifyWorkspace,
    ask,
    gone: (id: ApprovalId) => gone(id),
  };
}

describe('check watcher lifecycle', () => {
  it('awaits accepted stream before prompting and drains responses/stream on success', async () => {
    const fake = fakeConversation();
    const operation = vi.fn(async () => {
      fake.ask();
      await vi.waitFor(() =>
        expect(fake.conversation.answerApproval).toHaveBeenCalledWith({
          approval: 'one',
          response: { decision: 'allow_session' },
        }),
      );

      return 'done';
    });
    const running = fake.watcher.run({ operation, signal: fake.controller.signal });

    await vi.waitFor(() => expect(fake.conversation.watchApprovals).toHaveBeenCalledOnce());
    expect(operation).not.toHaveBeenCalled();
    fake.accepted.resolve(undefined);
    await expect(running).resolves.toBe('done');
    expect(fake.verifyWorkspace).toHaveBeenCalledTimes(2);
    await expect(fake.ended.promise).resolves.toBeUndefined();
  });

  it('skips unauthorized requests promptly without an approval UI', async () => {
    const fake = fakeConversation();

    fake.accepted.resolve(undefined);
    await fake.watcher.run({
      signal: fake.controller.signal,
      operation: async () => {
        fake.ask('node a && find .');
        await vi.waitFor(() =>
          expect(fake.conversation.answerApproval).toHaveBeenCalledWith({
            approval: 'one',
            response: { decision: 'skip' },
          }),
        );
      },
    });
  });

  it.each(['end', 'error', 'answer-error'] as const)(
    'surfaces %s and aborts an active operation',
    async (kind) => {
      const fake = fakeConversation();
      let operationSignal: AbortSignal | undefined;
      const running = fake.watcher.run({
        signal: fake.controller.signal,
        operation: async (signal) => {
          operationSignal = signal;

          if (kind === 'answer-error') {
            fake.conversation.answerApproval.mockRejectedValue(new Error('response failed'));
            fake.ask();
          } else if (kind === 'end') {
            fake.ended.resolve(undefined);
          } else {
            fake.ended.reject(new Error('stream failed'));
          }

          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        },
      });

      fake.accepted.resolve(undefined);
      await expect(running).rejects.toThrow(/watcher failed/);
      expect(operationSignal?.aborted).toBe(true);
    },
  );

  it('closes the watcher when the operation fails', async () => {
    const fake = fakeConversation();

    fake.accepted.resolve(undefined);
    await expect(
      fake.watcher.run({
        signal: fake.controller.signal,
        operation: async () => {
          throw new Error('prompt failed');
        },
      }),
    ).rejects.toThrow('prompt failed');
    await expect(fake.ended.promise).resolves.toBeUndefined();
  });

  it('cancels before acceptance without starting a prompt', async () => {
    const fake = fakeConversation();
    const operation = vi.fn(async () => undefined);
    const running = fake.watcher.run({ operation, signal: fake.controller.signal });

    await vi.waitFor(() => expect(fake.conversation.watchApprovals).toHaveBeenCalledOnce());
    fake.controller.abort();
    fake.accepted.resolve(undefined);
    await expect(running).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not answer after verification fails or after cancellation', async () => {
    const fake = fakeConversation();

    fake.accepted.resolve(undefined);
    await expect(
      fake.watcher.run({
        signal: fake.controller.signal,
        operation: async (signal) => {
          fake.verifyWorkspace.mockRejectedValue(new Error('workspace changed'));
          fake.ask();
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        },
      }),
    ).rejects.toThrow(/watcher failed/);
    expect(fake.conversation.answerApproval).not.toHaveBeenCalled();
  });

  it('does not respond when cancellation arrives during workspace verification', async () => {
    const fake = fakeConversation();
    const verified = Promise.withResolvers<undefined>();

    fake.accepted.resolve(undefined);
    await fake.watcher.run({
      signal: fake.controller.signal,
      operation: async () => {
        fake.verifyWorkspace.mockImplementationOnce(() => verified.promise);
        fake.ask();
        fake.gone(approvalIdSchema.parse('one'));
        verified.resolve(undefined);
        await verified.promise;
        expect(fake.conversation.answerApproval).not.toHaveBeenCalled();
      },
    });
  });

  it('handles cancellation racing an answer and deduplicates replayed approvals', async () => {
    const fake = fakeConversation();

    fake.accepted.resolve(undefined);
    fake.conversation.answerApproval.mockRejectedValue(
      new RefusedError({ code: 'unknown_approval', message: 'gone', status: 404 }),
    );
    await fake.watcher.run({
      signal: fake.controller.signal,
      operation: async () => {
        fake.ask();
        fake.ask();
        await vi.waitFor(() => expect(fake.conversation.answerApproval).toHaveBeenCalledOnce());
      },
    });
  });
});
