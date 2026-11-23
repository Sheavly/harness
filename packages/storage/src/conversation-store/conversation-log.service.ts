import path from 'node:path';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { ModelId } from '@sheavly/protocol/model/model.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { appendJsonLine, readJsonLines, trimPartialLine } from '../jsonl-file/jsonl-file.helper.js';
import { LOG_FILE } from './conversation-store.constants.js';
import { failureEntry, isStreamFailureEvent } from './conversation-log.utils.js';
import { logLineSchema } from './log-line.validator.js';

/**
 * The part of a conversation's log that is a recoverable projection of its authoritative stream:
 * the failures it records, one entry each, called in stream order. The backend's own entries go to
 * the same file through `conversationLogSink`, so there is one log, not two.
 */
export class ConversationLog {
  readonly #file: string;
  readonly #conversationId: ConversationId | undefined;
  readonly #models = new Map<SessionId, ModelId>();
  #through = -1;

  constructor(params: { folder: string; conversationId?: ConversationId }) {
    this.#file = path.join(params.folder, LOG_FILE);
    this.#conversationId = params.conversationId;
  }

  async prepare(): Promise<void> {
    await trimPartialLine({ file: this.#file });
    this.#through = -1;
    this.#models.clear();

    // Only the stream's own failure events are the replay's: whatever else the backend logged,
    // `seq` field or not, says nothing of how far the stream has been written here.
    for await (const line of readJsonLines({ file: this.#file, schema: logLineSchema })) {
      if (line.seq !== undefined && isStreamFailureEvent(line.event)) {
        this.#through = Math.max(this.#through, line.seq);
      }
    }
  }

  /** Replaying the stream repairs a missing final log write without duplicating prior entries. */
  async observe(entry: StreamEntry): Promise<void> {
    if (entry.kind === 'update' && entry.update.session.modelId) {
      this.#models.set(entry.sessionId, entry.update.session.modelId);
    }

    if (entry.seq <= this.#through) return;

    const failure = failureEntry({
      entry,
      conversationId: this.#conversationId,
      modelId: this.#models.get(entry.sessionId),
    });

    if (!failure) return;

    await appendJsonLine({ file: this.#file, value: failure });
    this.#through = entry.seq;
  }
}
