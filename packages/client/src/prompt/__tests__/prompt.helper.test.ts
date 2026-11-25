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
        queue(2, { type: 'prompt_started', text: 'hi', queued: [] }),
        said(3, 'hello'),
        done(4),
        said(5, 'a later run'),
      ],
    });

    expect(await seqsOf(promptEntries({ client, id: ID, prompt: { text: 'hi' } }))).toEqual([
      2, 3, 4,
    ]);
  });

  it('waits for a queued prompt behind an identical line, and yields only its own run', async () => {
    const client = backend({
      answer: { status: 'queued', node: NODE, queued: ['same', 'same'] },
      entries: [
        queue(1, { type: 'prompt_started', text: 'same', queued: ['same'] }),
        done(2),
        queue(3, { type: 'prompt_started', text: 'same', queued: [] }),
        said(4, 'mine'),
        done(5),
      ],
    });

    expect(await seqsOf(promptEntries({ client, id: ID, prompt: { text: 'same' } }))).toEqual([
      3, 4, 5,
    ]);
  });

  it('throws PromptRefusedError for a queued prompt that could not start', async () => {
    const client = backend({
      answer: { status: 'queued', node: NODE, queued: ['/nope'] },
      entries: [
        queue(1, {
          type: 'prompt_refused',
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
