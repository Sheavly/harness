import { describe, expect, it } from 'vitest';
import { approvalIdSchema } from '@sheavly/protocol/approval/approval.validator';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import {
  FAKE_ID as ID,
  FAKE_MAIN as MAIN,
  doneAt,
  openOnFake,
  sentEntries,
  textAt,
} from '../../testing/remote-conversation.fake.js';
import { promptStarted } from '../../testing/live-feed.fake.js';
import { startedAnswer } from '../../chat/testing/prompt-answers.fake.js';

async function* entries(...list: StreamEntry[]): AsyncIterable<StreamEntry> {
  yield* list;
}

const asked = (seq: number, id: string): StreamEntry => ({
  seq,
  at: 0,
  sessionId: MAIN,
  kind: 'approval',
  update: {
    type: 'approval_requested',
    request: {
      id: approvalIdSchema.parse(id),
      callId: callIdSchema.parse('c1'),
      tool: 'run_command',
      command: 'npm test',
      concerns: [{ argument: 'npm test', reason: 'is not allowed yet' }],
      options: ['approve', 'always_allow', 'skip', 'skip_with_message'],
    },
  },
});

describe('RemoteConversation: approvals', () => {
  it('also delivers background-agent usage while no prompt is being sent', async () => {
    const usage: StreamEntry = {
      seq: 0,
      at: 0,
      sessionId: sessionIdSchema.parse('child'),
      kind: 'event',
      event: {
        seq: 0,
        type: 'usage',
        usage: {
          tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      },
    };
    const { conversation } = await openOnFake({
      handlers: { streamConversation: () => entries(usage) },
    });
    const heard: StreamEntry[] = [];
    const stop = new AbortController();
    const { ended } = await conversation.watchApprovals({
      onApproval: () => undefined,
      onUsage: (entry) => {
        heard.push(entry);
        stop.abort();
      },
      signal: stop.signal,
    });

    await ended;
    expect(heard).toEqual([usage]);
  });

  it('says it will answer, so a command waits instead of being refused, and hears each update', async () => {
    const { conversation, server } = await openOnFake({
      handlers: {
        streamConversation: () =>
          entries(asked(0, 'a1'), textAt(1, 'not an approval'), {
            seq: 2,
            at: 0,
            sessionId: MAIN,
            kind: 'approval',
            update: { type: 'approval_cancelled', id: approvalIdSchema.parse('a1') },
          }),
      },
    });
    const heard: string[] = [];
    const stop = new AbortController();
    const { ended } = await conversation.watchApprovals({
      onApproval: ({ update }) => {
        heard.push(update.type);
        if (heard.length === 2) stop.abort();
      },
      signal: stop.signal,
    });

    await ended;

    expect(heard).toEqual(['approval_requested', 'approval_cancelled']);
    // Replayed, so sub-agents already running are known by name when they ask.
    expect(server.calls.find(({ name }) => name === 'streamConversation')?.call.body).toEqual({
      approvals: true,
      replay: true,
    });
  });

  it('is connected by the time it resolves, so the first prompt is not refused', async () => {
    const order: string[] = [];
    const stop = new AbortController();
    const { conversation, feed } = await openOnFake({
      handlers: {
        sendPrompt: () => {
          order.push('prompt sent');
          feed.publish(promptStarted({ seq: 0, text: 'hi' }), doneAt(1));

          return startedAnswer();
        },
        async *streamConversation({ body }) {
          if (!(body as { approvals?: boolean }).approvals) {
            yield* feed.follow();

            return;
          }

          order.push('stream open');
          yield asked(0, 'a1');
          // Like the backend's, this stream has no end of its own: it stays until the client leaves.
          await new Promise((resolve) => stop.signal.addEventListener('abort', resolve));
        },
      },
    });

    const { ended } = await conversation.watchApprovals({
      onApproval: () => undefined,
      signal: stop.signal,
    });

    await sentEntries({ conversation });
    stop.abort();
    await ended;

    expect(order).toEqual(['stream open', 'prompt sent']);
  });

  it('ends quietly when it is stopped, and fails on any other error', async () => {
    const stop = new AbortController();
    const stopped = await openOnFake({
      handlers: {
        async *streamConversation() {
          yield asked(0, 'a1');
          stop.abort();
          throw new Error('connection reset by the abort');
        },
      },
    });
    const watching = await stopped.conversation.watchApprovals({
      onApproval: () => undefined,
      signal: stop.signal,
    });

    await expect(watching.ended).resolves.toBeUndefined();

    const failing = await openOnFake({
      handlers: {
        async *streamConversation() {
          yield asked(0, 'a1');
          throw new Error('backend went away');
        },
      },
    });
    const failed = await failing.conversation.watchApprovals({
      onApproval: () => undefined,
      signal: new AbortController().signal,
    });

    await expect(failed.ended).rejects.toThrow('backend went away');
  });

  it('answers an approval by its id with the decision', async () => {
    const { conversation, server } = await openOnFake({
      handlers: { answerApproval: () => undefined },
    });

    await conversation.answerApproval({
      approval: approvalIdSchema.parse('a1'),
      response: { decision: 'skip_with_message', message: 'use ls instead' },
    });

    expect(server.calls.find(({ name }) => name === 'answerApproval')?.call).toEqual({
      params: { id: ID, approval: 'a1' },
      body: { response: { decision: 'skip_with_message', message: 'use ls instead' } },
    });
  });

  it('lets the caller tell that someone else answered first', async () => {
    const { conversation } = await openOnFake({
      handlers: {
        answerApproval: () => ({ refuse: { status: 404, code: 'unknown_approval' } }),
      },
    });

    await expect(
      conversation.answerApproval({
        approval: approvalIdSchema.parse('a1'),
        response: { decision: 'approve' },
      }),
    ).rejects.toMatchObject({ name: 'RefusedError', code: 'unknown_approval' });
  });
});
