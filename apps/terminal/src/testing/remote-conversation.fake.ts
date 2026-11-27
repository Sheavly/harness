import { fakeServer } from '@sheavly/client/testing/fake-server.fake';
import type { FakeHandlers } from '@sheavly/client/testing/testing.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { RemoteConversation } from '../client/conversation.service.js';
import { nodeFeeds, routeChannels } from './channels-feed.fake.js';
import { liveFeed, promptStarted } from './live-feed.fake.js';
import { treeFeed } from './tree-feed.fake.js';
import { startedAnswer } from '../chat/testing/prompt-answers.fake.js';

export const FAKE_ID = conversationIdSchema.parse('00000000-0000-4000-8000-000000000001');
export const FAKE_MAIN = sessionIdSchema.parse('main');
const SESSION = { id: FAKE_MAIN, rootId: FAKE_MAIN, depth: 1 as const };

/** Test-only: the main session's text at `seq`. */
export const textAt = (seq: number, value: string): StreamEntry => ({
  seq,
  at: 0,
  sessionId: FAKE_MAIN,
  kind: 'event',
  event: { seq, type: 'text_delta', text: value },
});

/** Test-only: the main run's `done` at `seq`. */
export const doneAt = (
  seq: number,
  reason: 'completed' | 'interrupted' | 'failed' = 'completed',
): StreamEntry => ({
  seq,
  at: 0,
  sessionId: FAKE_MAIN,
  kind: 'event',
  event: { seq, type: 'done', reason, session: SESSION },
});

/**
 * Test-only: a conversation on a fake backend answering the routes as `handlers` say. Its live
 * stream is `feed`, and each prompt sent starts the next of `runs` on it at once: its
 * `prompt_started` (at the seq before the run's first entry), then the run's entries.
 */
export async function openOnFake(params: {
  handlers?: FakeHandlers;
  runs?: StreamEntry[][];
  /** The tree channel the backend serves: one main agent unless a test says what it holds. */
  tree?: ReturnType<typeof treeFeed>;
  /** The agents' channels the backend serves, by the node's id; a node with none is `not_found`. */
  nodes?: ReturnType<typeof nodeFeeds>;
}) {
  const feed = liveFeed();
  const tree = params.tree ?? treeFeed();
  const nodes = params.nodes ?? nodeFeeds();
  const runs = [...(params.runs ?? [])];
  const server = fakeServer({
    startConversation: () => ({ id: FAKE_ID }),
    streamConversation: () => feed.follow(),
    streamChannels: (call) => routeChannels({ call, tree, nodes }),
    sendPrompt: ({ body }) => {
      const run = runs.shift() ?? [];
      const text = (body as { text: string }).text;

      feed.publish(promptStarted({ seq: (run[0]?.seq ?? 1) - 1, text }), ...run);

      return startedAnswer();
    },
    stopPrompt: () => undefined,
    ...params.handlers,
  });
  const conversation = await RemoteConversation.open({
    backend: {
      url: 'http://backend.test',
      token: 't',
      stop: async () => undefined,
      fetch: async (input, init) =>
        endsOnAbort({ response: await server.fetch(input, init), signal: init?.signal }),
      // A stream that drops is lost at once: a test's fake stream ends on purpose.
      reconnect: { attempts: 0 },
    },
  });

  return { conversation, server, feed, tree, nodes };
}

/**
 * Test-only: `response` whose body ends when the request's `signal` aborts, as a real fetch's
 * does: the fake server's streams know nothing of the request, and a live one never ends.
 */
export function endsOnAbort(params: {
  response: Response;
  signal: AbortSignal | null | undefined;
}): Response {
  const { response, signal } = params;

  if (!signal || !response.body) return response;

  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const aborted = new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve) =>
    signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), {
      once: true,
    }),
  );
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const read = await Promise.race([reader.read(), aborted]);

      if (read.done) controller.close();
      else controller.enqueue(read.value);
    },
  });

  return new Response(body, { status: response.status, headers: response.headers });
}

/** Test-only: every entry `send` yields for one prompt, to its end. */
export async function sentEntries(params: {
  conversation: RemoteConversation;
  text?: string;
  signal?: AbortSignal;
}): Promise<StreamEntry[]> {
  const { conversation, text = 'hi', signal } = params;
  const seen: StreamEntry[] = [];

  for await (const entry of conversation.send({ text, ...(signal && { signal }) })) {
    seen.push(entry);
  }

  return seen;
}
