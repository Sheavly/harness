import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import type { SessionMessage } from './sessions.types.js';

/** Children keep the originating message while their parent moves on to another prompt. */
export class MessageContexts {
  readonly #messages = new Map<SessionId, SessionMessage['messageId']>();

  constructor(initial: SessionMessage[] = []) {
    for (const { sessionId, messageId } of initial) this.#messages.set(sessionId, messageId);
  }

  set({ sessionId, messageId }: SessionMessage): void {
    this.#messages.set(sessionId, messageId);
  }

  /** The user message a session's activity is associated with now, if it has one. */
  get(id: SessionId): SessionMessage['messageId'] | undefined {
    return this.#messages.get(id);
  }

  /** Drops what is known about a session that was released. */
  forget(id: SessionId): void {
    this.#messages.delete(id);
  }

  inherit(params: { sessionId: SessionId; parentId: SessionId }): void {
    const messageId = this.#messages.get(params.parentId);

    if (messageId) this.#messages.set(params.sessionId, messageId);
  }

  annotate(entry: Omit<StreamEntry, 'at'>): Omit<StreamEntry, 'at'> {
    const messageId = this.#messages.get(entry.sessionId);

    return messageId ? { ...entry, messageId } : entry;
  }

  observe(entry: StreamEntry): void {
    if (entry.messageId) this.set({ sessionId: entry.sessionId, messageId: entry.messageId });
  }

  get snapshot(): SessionMessage[] {
    return [...this.#messages].map(([sessionId, messageId]) => ({ sessionId, messageId }));
  }
}
