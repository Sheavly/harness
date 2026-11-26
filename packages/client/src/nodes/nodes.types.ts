import type { z } from 'zod';
import type { channelEntrySchema } from '@sheavly/protocol/channel/channel.validator';

/**
 * An entry of one node's channel: it opening (`opened`), an agent's change (`updated`), an agent's
 * loop event (`event`: the event as the conversation's stream carries it, with its own `seq` and,
 * for streamed text, `lastSeq` when several deltas were stored as one; or `event_omitted`, in its
 * place, when it was too large to store), a command's or a service's output (`output`, a piece of
 * its text at a byte offset), and its end (`closed`). A reader that follows an agent by the
 * events' `seq` reads it from `event.seq` to `lastSeq`.
 */
export type NodeChannelEntry = z.infer<typeof channelEntrySchema>;
