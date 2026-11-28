import type { StreamEvent } from '@sheavly/core/message/message.types';
import type { AgentEvent } from '@sheavly/protocol/event/event.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import type { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import type { PublishedItem } from '@sheavly/runtime/sessions/sessions.types';

/** One scripted model call: what it streams, then how it ends (by its own `done` chunk if not). */
export type ScriptedCall = {
  chunks: StreamEvent[];
  /** More chunks, streamed once `wait` has resolved: the model call is slow in the middle. */
  after?: { wait: Promise<undefined>; chunks: StreamEvent[] };
  /** `hangs` waits for the run's abort; `throws` fails the call with that error. */
  ends?: 'hangs' | { throws: Error };
};

/** Everything one run left: its events, the entries of the combined stream, and the items. */
export type ItemRun = {
  events: AgentEvent[];
  entries: StreamEntry[];
  items: PublishedItem[];
  /** `item:<type>` for each item told and `event:<type>` for each event, in the order heard. */
  log: string[];
  failure: unknown;
  sessions: SessionRegistry;
};
