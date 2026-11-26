import { channelEntrySchema } from '@sheavly/protocol/channel/channel.validator';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import type { createClient } from '../client/client.helper.js';
import { subscribeChannels } from '../client/subscribe.helper.js';
import { ChannelFailedError } from '../errors/client.errors.js';
import type { NodeChannelEntry } from './nodes.types.js';

/** The entries of `node`'s channel in `frames`, until the channel ends. */
async function* entriesOf(params: {
  frames: AsyncGenerator<SubscribeFrame>;
  node: NodeId;
}): AsyncGenerator<NodeChannelEntry> {
  const { frames, node } = params;

  for await (const frame of frames) {
    if (frame.type === 'end') {
      // A channel that failed is not a channel that is over: what was read is not all of it.
      if (frame.reason === 'failed') throw new ChannelFailedError({ channel: node });

      return;
    }

    const entry = channelEntrySchema.safeParse(frame);

    if (entry.success) yield entry.data;
  }
}

/**
 * Follows one node's channel in conversation `id`: its entries from `from` (`start` unless given; a
 * cursor to go on from where an earlier read stopped, `now`, or `tail:<n>`: the last entries of an
 * agent, the last bytes of a command's output), then each one as it is stored, to the node's
 * `closed` entry. A dropped connection resumes after the last entry (`subscribeChannels`), so none
 * is missed and none comes twice. The entries end after `closed`; they throw `ChannelFailedError`
 * when the channel ended `failed` and a refusal as it is (`not_found` for a node the conversation
 * does not have, `cursor_out_of_range` for a position its log no longer holds). Resolves once the
 * server has accepted the connection; ends quietly when `signal` aborts.
 */
export async function followNode(params: {
  client: ReturnType<typeof createClient>;
  id: ConversationId;
  node: NodeId;
  from?: string;
  signal: AbortSignal;
}): Promise<AsyncGenerator<NodeChannelEntry>> {
  const { client, id, node, from = 'start', signal } = params;
  const frames = await subscribeChannels({
    client,
    id,
    subscriptions: [{ channel: node, from }],
    signal,
  });

  return entriesOf({ frames, node });
}
