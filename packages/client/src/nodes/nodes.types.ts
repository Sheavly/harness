import type { z } from 'zod';
import type { channelEntrySchema } from '@sheavly/protocol/channel/channel.validator';

/**
 * An entry of one node's channel: it opening (`opened`), an agent's change (`updated`), where an
 * agent's run starts (`run_started`: why, the user message it answers and, for a prompt, its text),
 * an agent's loop event (`event`: the event as the conversation's stream carries it, with its own `seq` and,
 * for streamed text, `lastSeq` when several deltas were stored as one; or `event_omitted`, in its
 * place, when it was too large to store: its type, `seq` and size, and for an event of one tool call
 * the call's `id` and tool `name`, never its content), a command's or a service's output (`output`, a piece of
 * its text at a byte offset), and its end (`closed`). A reader that follows an agent by the
 * events' `seq` reads it from `event.seq` to `lastSeq`.
 */
export type NodeChannelEntry = z.infer<typeof channelEntrySchema>;
