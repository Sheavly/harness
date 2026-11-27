import { describe, expect, it } from 'vitest';
import { messageIdSchema } from '@sheavly/protocol/message/message.validator';
import type { PromptSent } from '@sheavly/protocol/node-command/node-command.types';
import { nodeIdSchema } from '@sheavly/protocol/node/node.validator';
import type { QueueUpdate } from '@sheavly/protocol/queue/queue.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { createClient } from '../../client/client.helper.js';
import { PromptRefusedError, RefusedError } from '../../errors/client.errors.js';
import { fakeServer } from '../../testing/fake-server.fake.js';
import type { FakeRefusal } from '../../testing/testing.types.js';
import { promptEntries } from '../prompt.helper.js';

const ID = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000ab');
const MAIN = sessionIdSchema.parse('main');
/** What a prompt's answer names: the agent that carries the run, and the message it became. */
const NODE = nodeIdSchema.parse('agent-1');
const MESSAGE = messageIdSchema.parse('00000000-0000-4000-8000-0000000000cd');
const SECOND = messageIdSchema.parse('00000000-0000-4000-8000-0000000000ce');
const at = { at: 1, sessionId: MAIN };

const queue = (seq: number, update: QueueUpdate): StreamEntry => ({
  seq,
  ...at,
  kind: 'queue',
  update,
});
const said = (seq: number, text: string): StreamEntry => ({
  seq,
  ...at,
  kind: 'event',
  event: { seq, type: 'text_delta', text },
});
const done = (seq: number): StreamEntry => ({
  seq,
  ...at,
  kind: 'event',
  event: { seq, type: 'done', reason: 'completed', session: { id: MAIN, rootId: MAIN, depth: 1 } },
});

/**
 * A backend whose conversation stream gives `entries` once the prompt is sent, then stays open,
 * and answers the send with `answer`.
 */
function backend(params: { answer: PromptSent | FakeRefusal; entries: StreamEntry[] }) {
  const sent = Promise.withResolvers<undefined>();
  const { fetch } = fakeServer({
    async *streamConversation() {
      await sent.promise;
      yield* params.entries;
      await new Promise(() => undefined);
    },
    sendPrompt: () => {
      sent.resolve(undefined);

      return params.answer;
    },
  });

  return createClient({ url: 'http://backend.test', token: 't', fetch });
}

async function seqsOf(entries: AsyncIterable<StreamEntry>): Promise<number[]> {
  const seqs: number[] = [];

  for await (const entry of entries) seqs.push(entry.seq);

  return seqs;
}

describe('promptEntries', () => {
  it('yields the run of a prompt that started at once, from its start to its end', async () => {
    const client = backend({
      answer: { status: 'started', node: NODE, messageId: MESSAGE, queued: [] },
      entries: [
        said(1, 'an earlier run'),
        queue(2, { type: 'prompt_started', messageId: MESSAGE, text: 'hi', queued: [] }),
        said(3, 'hello'),
        done(4),
        said(5, 'a later run'),
      ],
    });

    expect(await seqsOf(promptEntries({ client, id: ID, prompt: { text: 'hi' } }))).toEqual([
      2, 3, 4,
    ]);
  });

  it('waits for a queued prompt behind a run, and yields from the start that names its id', async () => {
    const client = backend({
      answer: { status: 'queued', node: NODE, messageId: MESSAGE, queued: ['next'] },
      entries: [
        said(1, 'the run before'),
        done(2),
        queue(3, { type: 'prompt_started', messageId: MESSAGE, text: 'next', queued: [] }),
        said(4, 'mine'),
        done(5),
      ],
    });

    expect(await seqsOf(promptEntries({ client, id: ID, prompt: { text: 'next' } }))).toEqual([
      3, 4, 5,
    ]);
  });

  it('tells two identical lines apart by id: the later one yields its own run, not the earlier one’s', async () => {
    const client = backend({
      answer: { status: 'queued', node: NODE, messageId: SECOND, queued: ['same', 'same'] },
      entries: [
        queue(1, { type: 'prompt_started', messageId: MESSAGE, text: 'same', queued: ['same'] }),
        said(2, 'the earlier line'),
        done(3),
        queue(4, { type: 'prompt_started', messageId: SECOND, text: 'same', queued: [] }),
        said(5, 'mine'),
        done(6),
      ],
    });

    expect(await seqsOf(promptEntries({ client, id: ID, prompt: { text: 'same' } }))).toEqual([
      4, 5, 6,
    ]);
  });

  it('yields the first of two identical lines when it is the one answered, and stops at its end', async () => {
    const client = backend({
      answer: { status: 'queued', node: NODE, messageId: MESSAGE, queued: ['same'] },
      entries: [
        queue(1, { type: 'prompt_started', messageId: MESSAGE, text: 'same', queued: ['same'] }),
        said(2, 'mine'),
        done(3),
        queue(4, { type: 'prompt_started', messageId: SECOND, text: 'same', queued: [] }),
        done(5),
      ],
    });

    expect(await seqsOf(promptEntries({ client, id: ID, prompt: { text: 'same' } }))).toEqual([
      1, 2, 3,
    ]);
  });

  it('throws PromptRefusedError for a queued prompt that could not start, and ignores another line’s refusal', async () => {
    const client = backend({
      answer: { status: 'queued', node: NODE, messageId: MESSAGE, queued: ['/nope'] },
      entries: [
        queue(1, {
          type: 'prompt_refused',
          messageId: SECOND,
          text: '/nope',
          error: 'Another line’s error',
          queued: [],
        }),
        queue(2, {
          type: 'prompt_refused',
          messageId: MESSAGE,
          text: '/nope',
          error: 'No skill is called nope',
          queued: [],
        }),
      ],
    });

    await expect(
      seqsOf(promptEntries({ client, id: ID, prompt: { text: '/nope' } })),
    ).rejects.toEqual(new PromptRefusedError({ message: 'No skill is called nope' }));
  });

  it('throws PromptRefusedError for a queued prompt an edit removed from the queue', async () => {
    const client = backend({
      answer: { status: 'queued', node: NODE, messageId: MESSAGE, queued: ['gone'] },
      entries: [
        queue(1, { type: 'queue_changed', queued: ['other'], dropped: [SECOND] }),
        queue(2, { type: 'queue_changed', queued: [], dropped: [MESSAGE] }),
      ],
    });

    await expect(
      seqsOf(promptEntries({ client, id: ID, prompt: { text: 'gone' } })),
    ).rejects.toEqual(
      new PromptRefusedError({ message: 'The line was removed from the queue before it started' }),
    );
  });

  it("throws the send's refusal, with the backend's code", async () => {
    const client = backend({
      answer: { refuse: { status: 409, code: 'cannot_queue' } },
      entries: [],
    });
    const sent = seqsOf(promptEntries({ client, id: ID, prompt: { text: 'x' } }));

    await expect(sent).rejects.toBeInstanceOf(RefusedError);
    await expect(sent).rejects.toMatchObject({ code: 'cannot_queue' });
  });
});
