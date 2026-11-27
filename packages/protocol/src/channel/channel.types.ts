import type { CONVERSATION_CHANNEL_NAMES } from '../node/node.constants.js';
import type { RUN_START_CAUSES } from './channel.constants.js';

/** Why a run started: a user's prompt, or a wake that delivers finished background work. */
export type RunStartCause = (typeof RUN_START_CAUSES)[number];

/** What a cursor counts: the entries of a channel (`sequence`) or the bytes of its output (`byte`). */
export type CursorKind = 'sequence' | 'byte';

/** The name of one of the conversation's own channels, as opposed to a node's. */
export type ConversationChannelName = (typeof CONVERSATION_CHANNEL_NAMES)[number];

/** What a channel's log is checked by, whatever else an entry holds. */
export type ChannelHead = {
  channel: string;
  cursor: string;
  type: string;
};
