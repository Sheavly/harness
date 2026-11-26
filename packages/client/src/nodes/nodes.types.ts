import type { z } from 'zod';
import type { channelEntrySchema } from '@sheavly/protocol/channel/channel.validator';

/**
 * An entry of one node's channel: it opening (`opened`), an agent's change (`updated`), a command's or
 * a service's output (`output`, a piece of its text at a byte offset), and its end (`closed`).
 */
export type NodeChannelEntry = z.infer<typeof channelEntrySchema>;
