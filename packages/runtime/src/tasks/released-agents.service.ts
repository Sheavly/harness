import type { SessionId } from '@sheavly/protocol/session/session.types';

/**
 * The sub-agent sessions of tasks that were released, until their owner takes them. A released
 * task leaves its sub-agent's session finished and nothing else would let it go, whether the task
 * was delivered or cancelled in silence, so the session that owns the task takes them and releases
 * each one with the session registry.
 */
export class ReleasedAgents {
  #released: { agent: SessionId; owner: SessionId | undefined }[] = [];

  add(params: { agent: SessionId; owner: SessionId | undefined }): void {
    this.#released.push(params);
  }

  /** What `owner` had released since it last asked, each once. */
  take(owner: SessionId): SessionId[] {
    const mine = this.#released.filter((released) => released.owner === owner);

    this.#released = this.#released.filter((released) => released.owner !== owner);

    return mine.map((released) => released.agent);
  }
}
