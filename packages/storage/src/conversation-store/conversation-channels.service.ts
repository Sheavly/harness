import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ChannelLimits } from '@sheavly/core/store/store.types';
import { assertChannelName } from '@sheavly/core/store/store.utils';
import { channelNameSchema } from '@sheavly/protocol/channel/channel.validator';
import { isMissingPath } from '@sheavly/runtime/errors/errors.utils';
import { StorageFileError } from '../errors/storage.errors.js';
import { namedPath } from '../safe-path/safe-path.helper.js';
import { ChannelFile } from './channel-file.service.js';
import { ChannelQuota } from './channel-quota.service.js';
import {
  CHANNEL_FULL_SUFFIX,
  CHANNEL_INDEX_SUFFIX,
  CHANNEL_LOG_SUFFIX,
  CHANNELS_FOLDER,
} from './conversation-store.constants.js';

/**
 * One conversation's channel logs, `<conversation>/channels/<channel>.jsonl`, one file each,
 * all held to one `ChannelQuota`. A channel is named for a node id or is `tree`; those are the only
 * names that become a file, so no id or path from outside can name another one.
 */
export class ConversationChannels {
  readonly #folder: string;
  readonly #quota: ChannelQuota;
  readonly #files = new Map<string, ChannelFile>();

  /** `folder` is the conversation's own folder. */
  constructor(params: { folder: string; limits: ChannelLimits }) {
    this.#folder = path.join(params.folder, CHANNELS_FOLDER);
    this.#quota = new ChannelQuota({ folder: this.#folder, limits: params.limits });
  }

  /** The log of `channel`; throws a `StoreError` for a name that is not a node id or `tree`. */
  logOf(channel: string): ChannelFile {
    const known = this.#files.get(channel);

    if (known) return known;

    assertChannelName(channel);

    const named = (extension: string) =>
      namedPath({ folder: this.#folder, name: channel, extension, shape: channelNameSchema });
    const file = new ChannelFile({
      file: named(CHANNEL_LOG_SUFFIX),
      markerFile: named(CHANNEL_FULL_SUFFIX),
      indexFile: named(CHANNEL_INDEX_SUFFIX),
      channel,
      quota: this.#quota,
    });

    this.#files.set(channel, file);

    return file;
  }

  /**
   * The channels the folder holds: a regular file `<channel>.jsonl` whose name is a node id or
   * `tree`. Anything else in the folder (a marker, a link, a stray file) is not a channel the store
   * made. A conversation with no folder has none.
   */
  async names(): Promise<string[]> {
    let entries;

    try {
      entries = await readdir(this.#folder, { withFileTypes: true });
    } catch (caughtError) {
      if (isMissingPath(caughtError)) return [];
      throw new StorageFileError({ file: this.#folder, cause: caughtError });
    }

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(CHANNEL_LOG_SUFFIX))
      .map((entry) => entry.name.slice(0, -CHANNEL_LOG_SUFFIX.length))
      .filter((name) => channelNameSchema.safeParse(name).success);
  }

  /**
   * Forgets what every channel kept and the count, once the conversation's folder is deleted, so
   * one made again under the same id starts from nothing. The channels stay the same objects: a
   * caller that holds one and one made after share one queue, never two on one file. Waits for
   * appends already queued.
   */
  async forget(): Promise<void> {
    for (const file of this.#files.values()) await file.forget();

    this.#quota.forget();
  }
}
