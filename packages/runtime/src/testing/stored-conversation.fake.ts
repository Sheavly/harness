import type { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelEntry } from '@sheavly/core/store/store.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { NodeChannelWriter } from '../nodes/node-channel-writer.service.js';
import { SessionRegistry } from '../sessions/sessions.service.js';
import { TaskRegistry } from '../tasks/tasks.service.js';
import { readChannel } from './stored-channels.fake.js';

/** Test-only: the id of the conversation `conversation` makes. */
export const conversationId = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000d1');

/**
 * Test-only: a conversation whose node channels are stored in a memory store, with a main agent
 * running. `attempts`, when given, hears each append the writer tries, as `type cursor`, whether the
 * store takes it or not: what the writer does is then told apart from what the store would refuse.
 */
export function conversation(
  params: { store?: MemoryConversationStore; attempts?: string[] | undefined } = {},
) {
  const store = params.store ?? new MemoryConversationStore();
  const sessions = new SessionRegistry();
  const tasks = new TaskRegistry(sessions.nodeOwners);
  const main = sessions.startMain({ title: 'Main', id: sessionIdSchema.parse('main') });
  const failures: StoreError[] = [];
  const writer = NodeChannelWriter.attach({
    nodes: sessions.nodes,
    tasks,
    storage: {
      log: (channel) => {
        const log = store.channel({ id: conversationId, channel });

        if (!params.attempts) return log;

        return {
          read: (from) => log.read(from),
          append: async (entry) => {
            params.attempts?.push(`${entry.type} ${entry.cursor}`);
            await log.append(entry);
          },
        };
      },
      onFailure: (failure) => failures.push(failure),
    },
  });
  const nodeOf = (session: typeof main.id) => {
    const node = sessions.nodeIdOf(session);

    if (!node) throw new Error('no node');

    return node;
  };

  return { store, sessions, tasks, main, writer, failures, nodeOf };
}

type World = ReturnType<typeof conversation>;

/** Test-only: every entry of channel `channel`, once the writes so far have landed. */
export async function entriesOf(params: {
  world: Pick<World, 'store' | 'writer'>;
  channel: string;
}): Promise<ChannelEntry[]> {
  await params.world.writer.flush();

  return readChannel({
    store: params.world.store,
    id: conversationId,
    channel: params.channel,
  });
}
