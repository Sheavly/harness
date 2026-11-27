import { channelEntrySchema } from '@sheavly/protocol/channel/channel.validator';
import type { z } from 'zod';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { readChannel } from '@sheavly/runtime/testing/stored-channels.fake';
import type { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import type { Harness } from '../host/host.types.js';

type MainEntry = z.infer<typeof channelEntrySchema>;

/**
 * Test-only: every entry of the main agent's stored channel, once what was told is written, each
 * read as the protocol serves it. Empty when the main agent has no node.
 */
export async function mainChannelOf(params: {
  store: MemoryConversationStore;
  id: ConversationId;
  harness: Harness;
}): Promise<MainEntry[]> {
  const { store, id, harness } = params;
  const channel = harness.sessions.nodeIdOf(harness.mainSession.id);

  await harness.nodeChannels?.flush();

  if (channel === undefined) return [];

  const entries = await readChannel({ store, id, channel });

  return entries.map((entry) => channelEntrySchema.parse(entry));
}

/**
 * Test-only: the loop events of a channel grouped by the run each belongs to: `before` holds those
 * that come ahead of the first `run_started`, and each run its start (`run_started:wake`) and the
 * events after it, up to the next start. The node's own entries (`opened`, `updated`, `closed`)
 * are left out: they are not the run's.
 */
export function runsOf(entries: readonly MainEntry[]) {
  const before: string[] = [];
  const runs: { start: string; events: string[] }[] = [];

  for (const line of outlineOf(entries)) {
    if (line.startsWith('run_started')) {
      runs.push({ start: line, events: [] });
    } else if (line.startsWith('event:')) {
      (runs.at(-1)?.events ?? before).push(line);
    }
  }

  return { before, runs };
}

/**
 * Test-only: a channel's entries as short lines to compare at a glance: the entry's type, with the
 * cause of a run's start and the type of a loop event after it (`run_started:wake`, `event:done`).
 */
export function outlineOf(entries: readonly MainEntry[]): string[] {
  return entries.map((entry) => {
    if (entry.type === 'run_started') return `run_started:${entry.cause}`;

    return entry.type === 'event' ? `event:${entry.event.type}` : entry.type;
  });
}
