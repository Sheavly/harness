import type { RunStartCause } from '@sheavly/protocol/channel/channel.types';
import type { EntryEvent } from '@sheavly/protocol/event/event.types';
import type { CallId, MessageId } from '@sheavly/protocol/message/message.types';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { RunOutcome } from '@sheavly/protocol/session/session.types';
import type { TreeChannelEntry, TreeView } from '@sheavly/protocol/tree/tree.types';

/** The entry of the tree channel of type `Type`. */
type TreeEntryOf<Type extends TreeChannelEntry['type']> = Extract<TreeChannelEntry, { type: Type }>;

/**
 * A sub-agent as a card shows it: who it is, how deep it sits (as a session's depth counts it: the
 * main agent is at depth 1, its child at 2) and the top of its parent chain, with what it says it
 * is doing and where it is in its life. `state` is the node's (an agent that hit its turn limit or
 * was interrupted has ended `failed` or `cancelled`); `outcome` is how its last run ended, which
 * keeps what `state` folds together (`max_turns`, `interrupted`, …), as the stream's session did.
 */
export type SubAgentCard = {
  id: NodeId;
  title: string;
  depth: number;
  parent: NodeId;
  root: NodeId;
  status?: string;
  state: TreeView['nodes'][number]['state'];
  outcome?: RunOutcome;
};

/**
 * One thing a chat shows, from the two channels it reads: the main agent's own (its loop events and
 * where each run starts) and the conversation's tree (the notices of the conversation and the
 * sub-agents). An agent's `updated`, `opened` and `closed` entries are not items: the tree tells
 * what happened to the agent. The text in an item is the backend's or the model's, as it came, and
 * is not safe to print as it is.
 *
 * Items of one channel come in the order the channel holds them; between the two channels no order
 * is defined (a cursor of one orders nothing against the other), so a chat matches a run's events
 * to its prompt by message id.
 */
export type ChatItem =
  /** A loop event of the main agent; a merged `text_delta` says the last `seq` it holds. */
  | { type: 'event'; event: EntryEvent; messageId?: MessageId; lastSeq?: number }
  /**
   * An event too large to be stored: which it was, its `seq` and how large (its JSON, in
   * characters). Its content is not on the channel, so a chat can say there was one and no more,
   * and, for an event of one tool call, which call it was (`call`: its id and tool name).
   */
  | {
      type: 'event_omitted';
      eventType: string;
      seq: number;
      size: number;
      messageId?: MessageId;
      call?: { id: CallId; name: string };
    }
  /** Where a run starts: why, the user message it answers and, for a prompt, its text. */
  | { type: 'run_started'; cause: RunStartCause; messageId: MessageId; text?: string }
  | ({ type: 'queue_changed' } & Pick<TreeEntryOf<'queue_changed'>, 'queued'>)
  | ({ type: 'prompt_started' } & Pick<
      TreeEntryOf<'prompt_started'>,
      'text' | 'messageId' | 'queued'
    >)
  | ({ type: 'prompt_refused' } & Pick<TreeEntryOf<'prompt_refused'>, 'text' | 'error' | 'queued'>)
  | ({ type: 'storage_failed' } & Pick<TreeEntryOf<'storage_failed'>, 'error'>)
  | ({ type: 'extension_event' } & Pick<
      TreeEntryOf<'extension_event'>,
      'extension' | 'kind' | 'version' | 'data' | 'text'
    >)
  /** A sub-agent of the main agent started, said something new it is doing, or ended. */
  | { type: 'agent'; change: 'started' | 'status' | 'ended'; agent: SubAgentCard };
