import type { InboxMessage, SessionId, SessionInfo } from '@sheavly/protocol/session/session.types';
import { SessionError } from '../errors/sessions.errors.js';
import { abortableWait } from '../wait/abortable-wait.helper.js';
import { parseQueuedNotice } from './queued-notice.validator.js';
import { assertOpen } from './send-check.helper.js';
import {
  MAX_QUEUED_MESSAGE_CHARS,
  MAX_QUEUED_MESSAGES,
  MAX_QUEUED_NOTICES,
} from './sessions.constants.js';
import type { QueuedNotice } from './sessions.types.js';

/**
 * Each session's inbox: the messages queued for its next model call, and the loops waiting idle
 * (for tasks) that a new message should wake. Who may send what is the registry's to check.
 */
export class Inboxes {
  #messages = new Map<SessionId, InboxMessage[]>();
  #waiters = new Map<SessionId, (() => void)[]>();
  /** The outbox: extension notices for the loop to publish at its next turn. No one waits on it. */
  #notices = new Map<SessionId, QueuedNotice[]>();

  /**
   * Queues `notice` for `session`, oldest first; throws `session_ended` once it has ended,
   * `invalid_notice` when the protocol's schema refuses it (history reads it back, so a malformed
   * one never gets that far) and `outbox_full` when `MAX_QUEUED_NOTICES` are already waiting. It
   * wakes no one: a notice is not a reason to run.
   */
  addNotice(params: { session: SessionInfo; notice: QueuedNotice }): void {
    const { session } = params;

    assertOpen({ session, consequence: "it can't receive notices" });

    const notice = parseQueuedNotice({ id: session.id, notice: params.notice });
    const queued = this.#notices.get(session.id) ?? [];

    if (queued.length >= MAX_QUEUED_NOTICES) {
      throw new SessionError({
        reason: 'outbox_full',
        sessionId: session.id,
        message: `Session ${session.id} already has ${MAX_QUEUED_NOTICES} extension notices waiting for its next turn; this one was dropped`,
      });
    }

    queued.push(notice);
    this.#notices.set(session.id, queued);
  }

  /** Removes and returns the session's queued notices, oldest first. */
  takeNotices(id: SessionId): QueuedNotice[] {
    const notices = this.#notices.get(id) ?? [];

    this.#notices.delete(id);

    return notices;
  }

  /**
   * Queues `message` for `id`, oldest first, and wakes a loop waiting for one. Throws `inbox_full`
   * when `MAX_QUEUED_MESSAGES` messages already wait, or the new one would take them past
   * `MAX_QUEUED_MESSAGE_CHARS` characters: nothing is queued, and the sender is told, never
   * silently dropped. A message is always queued when none waits, however long: the bound is on what
   * piles up behind an agent that has not taken its messages, and one message is the sender's own
   * to size (the API's route caps it, a model's `message_agent` text is as long as it wrote).
   */
  add(params: { id: SessionId; message: InboxMessage }): void {
    const { id, message } = params;
    const queued = this.#messages.get(id) ?? [];
    const chars = queued.reduce((total, each) => total + each.content.length, 0);

    if (
      queued.length > 0 &&
      (queued.length >= MAX_QUEUED_MESSAGES ||
        chars + message.content.length > MAX_QUEUED_MESSAGE_CHARS)
    ) {
      throw new SessionError({
        reason: 'inbox_full',
        sessionId: id,
        message: `Session ${id} already has messages waiting for its next model call (up to ${String(MAX_QUEUED_MESSAGES)}, or ${String(MAX_QUEUED_MESSAGE_CHARS)} characters): this one was not queued`,
      });
    }

    queued.push(message);
    this.#messages.set(id, queued);
    this.wake(id);
  }

  /** Removes and returns the session's queued messages, oldest first. */
  take(id: SessionId): InboxMessage[] {
    const messages = this.#messages.get(id) ?? [];

    this.#messages.delete(id);

    return messages;
  }

  /** Drops the session's queued messages and wakes anyone waiting on it, for a released session. */
  forget(id: SessionId): void {
    this.#messages.delete(id);
    this.#notices.delete(id);
    this.wake(id);
  }

  has(id: SessionId): boolean {
    return (this.#messages.get(id)?.length ?? 0) > 0;
  }

  /**
   * Resolves when a message arrives for the session, or it is woken (it ended). When `signal`
   * aborts, the wait is dropped from the inbox and resolves too, so a caller that gives up on it
   * leaves nothing behind.
   */
  next(id: SessionId, signal?: AbortSignal): Promise<void> {
    return abortableWait({
      signal,
      register: (wake) => this.#waiters.set(id, [...(this.#waiters.get(id) ?? []), wake]),
      unregister: (wake) => this.#dropWaiter({ id, waiter: wake }),
    });
  }

  /** How many loops wait on the session's inbox. */
  waiting(id: SessionId): number {
    return this.#waiters.get(id)?.length ?? 0;
  }

  #dropWaiter(params: { id: SessionId; waiter: () => void }): void {
    const remaining = (this.#waiters.get(params.id) ?? []).filter((w) => w !== params.waiter);

    if (remaining.length === 0) this.#waiters.delete(params.id);
    else this.#waiters.set(params.id, remaining);
  }

  /** Wakes every loop waiting on the session's inbox. */
  wake(id: SessionId): void {
    const waiters = this.#waiters.get(id) ?? [];

    this.#waiters.delete(id);
    waiters.forEach((wake) => wake());
  }
}
