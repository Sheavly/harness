import path from 'node:path';
import type { EntryStore } from '@sheavly/core/store/store.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { storedStreamEntrySchema } from '../legacy-effort/legacy-effort.validator.js';
import { AppendLog } from './append-log.service.js';
import { STREAM_FILE } from './conversation-store.constants.js';
import { ConversationLog } from './conversation-log.service.js';

/**
 * One conversation's stream file, `stream.jsonl`: an entry a line, in `seq` order with no gaps.
 *
 * `append` takes only the next `seq`, so a lost write can never be hidden by a later one. What the
 * next `seq` is comes from the file, counted once (the first time it is needed) after a line cut
 * off by a crash is trimmed, and is then kept: appends go one at a time through a queue, so it is
 * the file's. One process owns a conversation's stream; two writing the same file would each
 * count on their own and both think they were next.
 */
export class EntryFile implements EntryStore {
  readonly #log: AppendLog<StreamEntry>;

  constructor(params: { folder: string; conversationId?: ConversationId }) {
    const log = new ConversationLog(params);

    this.#log = new AppendLog({
      file: path.join(params.folder, STREAM_FILE),
      schema: storedStreamEntrySchema,
      noun: 'Stream',
      unit: 'entry',
      prepare: async () => log.prepare(),
      observe: async (entry) => log.observe(entry),
    });
  }

  async append(entry: StreamEntry): Promise<void> {
    await this.#log.append([entry]);
  }

  read(from = 0): AsyncGenerator<StreamEntry> {
    return this.#log.read(from);
  }

  /**
   * Forgets the count, once the stream's folder is deleted, so a conversation made again under the
   * same id starts from its first entry. Waits for appends already queued.
   */
  async forget(): Promise<void> {
    await this.#log.forget();
  }
}
