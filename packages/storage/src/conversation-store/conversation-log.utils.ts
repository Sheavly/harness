import type { LogEntry } from '@sheavly/logger/logger/logger.types';
import { createLogEntry } from '@sheavly/logger/logger/logger.utils';
import type { ModelId } from '@sheavly/protocol/model/model.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { LOG_EVENT } from './conversation-store.constants.js';

/** Whether `event` is one of the failures `failureEntry` writes from the stream. */
export function isStreamFailureEvent(event: string | undefined): boolean {
  return Object.values<string>(LOG_EVENT).includes(event ?? '');
}

/**
 * The log entry for a failure the stream records, or `undefined` for any other entry: failure
 * metadata only, never a prompt, a tool input, a successful output or reasoning. It is made
 * the way every entry is (`createLogEntry`), with the stream entry's own time and `seq`, so
 * replaying the stream rebuilds the same line.
 */
export function failureEntry(params: {
  entry: StreamEntry;
  conversationId: ConversationId | undefined;
  modelId: ModelId | undefined;
}): LogEntry | undefined {
  const { entry, conversationId, modelId } = params;

  if (entry.kind !== 'event') return undefined;

  const { event } = entry;
  const fields = {
    seq: entry.seq,
    sessionId: entry.sessionId,
    messageId: entry.messageId,
    conversationId,
    modelId,
  };
  const make = (name: (typeof LOG_EVENT)[keyof typeof LOG_EVENT], more: object) =>
    createLogEntry({
      service: 'storage',
      level: 'error',
      event: name,
      time: entry.at,
      fields: { ...fields, ...more },
    });

  if (event.type === 'run_failed') {
    return make(LOG_EVENT.RUN_FAILED, { error: event.error, details: event.details });
  }

  if (event.type === 'hook_failed') {
    return make(LOG_EVENT.HOOK_FAILED, {
      error: event.error,
      hook: event.hook,
      handler: event.handler,
    });
  }

  if (event.type === 'tool_result' && event.message.role === 'tool' && event.message.isError) {
    return make(LOG_EVENT.TOOL_FAILED, {
      error: event.message.content,
      toolCallId: event.call.id,
      toolName: event.call.name,
    });
  }

  return undefined;
}
