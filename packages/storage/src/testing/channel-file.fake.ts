import path from 'node:path';
import type { ChannelEntry, ChannelFrom } from '@sheavly/core/store/store.types';
import { ChannelFile } from '../conversation-store/channel-file.service.js';
import { ChannelQuota } from '../conversation-store/channel-quota.service.js';
import { DEFAULT_CHANNEL_LIMITS } from '../conversation-store/conversation-store.constants.js';

/** Test-only: an entry of `channel` at `cursor`, `opened` for the first of a channel and `updated` after. */
export const entry = (cursor: string, channel = 'main'): ChannelEntry => ({
  channel,
  type: cursor === 's0' || cursor === 'b0' ? 'opened' : 'updated',
  cursor,
  at: 1,
  node: { id: channel, title: 'Chat' },
});

/** Test-only: `count` entries of a numbered channel, s0 to s(count - 1). */
export const sequence = (count: number) =>
  Array.from({ length: count }, (_, n) => entry(`s${String(n)}`));

/** Test-only: the cursors `range(from, to)` names, from s(from) up to but not including s(to). */
export const range = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from) }, (_, n) => `s${String(from + n)}`);

/**
 * Test-only: a channel file in `folder` with an index block of `every` lines (small, so a few dozen
 * lines have several), and where its log and its index are. A new one each call, as a process that
 * starts is: it knows only what is on disk.
 */
export function channelFileIn(params: { folder: string; every: number; channel?: string }) {
  const { channel = 'main' } = params;
  const folder = path.join(params.folder, 'channels');

  return {
    path: path.join(folder, `${channel}.jsonl`),
    indexPath: path.join(folder, `${channel}.idx`),
    log: new ChannelFile({
      file: path.join(folder, `${channel}.jsonl`),
      markerFile: path.join(folder, `${channel}.full`),
      indexFile: path.join(folder, `${channel}.idx`),
      channel,
      quota: new ChannelQuota({ folder, limits: DEFAULT_CHANNEL_LIMITS }),
      indexEvery: params.every,
    }),
  };
}

/** Test-only: the cursors `log` reads back from `from`. */
export async function cursorsFrom(log: ChannelFile, from?: ChannelFrom) {
  const cursors: string[] = [];

  for await (const each of log.read(from)) cursors.push(each.cursor);

  return cursors;
}
