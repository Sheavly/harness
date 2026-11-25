import { now } from '@sheavly/core/clock/clock.helper';
import { readHistoryEntries } from '@sheavly/core/store/history-log.helper';
import type { ConversationStore } from '@sheavly/core/store/store.types';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import { TreeChannelWriter } from '@sheavly/runtime/nodes/tree-channel-writer.service';
import { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { ConversationsError } from '../errors/conversations.errors.js';
import type { StoredConversationState } from './conversations.types.js';
import { repairHistory } from './conversations.utils.js';
import { owedAgentReports } from './restored-reports.helper.js';

/**
 * Reads everything reopening conversation `id` needs from `store`. Throws `not_found` when the
 * store has no such conversation, and a `StoreError` when its entries have a gap.
 */
export async function readStoredConversation(params: {
  store: ConversationStore;
  id: ConversationId;
}): Promise<StoredConversationState> {
  const { store, id } = params;
  const stored = (await store.list()).find((conversation) => conversation.id === id);

  if (!stored) {
    throw new ConversationsError({
      reason: 'not_found',
      message: `No stored conversation ${id}: it was deleted, or never kept`,
    });
  }

  const logged = await readHistoryEntries(store.history({ id }));
  const at = now();
  const repaired = repairHistory({ messages: logged, at });

  assertRepairOnlyAppended({ id, logged, messages: repaired });

  const resume = await SessionRegistry.readStoredLog(store.entries(id));
  // After the repair placeholders, so the log stays append-only and the model gets them once.
  const owed = await owedAgentReports({ store, id, resume, history: repaired, at });
  // Where the tree channel stands and the tree it builds, for its writer to go on from. A channel
  // it cannot go on from is a failure in this value, not an error here: the conversation reopens.
  const resumedTree = await TreeChannelWriter.readStored({ store, id });

  return { stored, logged: logged.length, messages: [...repaired, ...owed], resume, resumedTree };
}

/**
 * Repair may only add entries after the logged ones, since the log is append-only and a
 * placeholder is written to it at the end. A call with no result that is followed by more history
 * would put one in the middle: that is a damaged or hand-edited log, refused rather than numbered
 * wrongly.
 */
function assertRepairOnlyAppended(params: {
  id: ConversationId;
  logged: readonly HistoryMessage[];
  messages: readonly HistoryMessage[];
}): void {
  const { id, logged, messages } = params;

  if (logged.every((entry, index) => messages[index] === entry)) return;

  throw new ConversationsError({
    reason: 'storage_failed',
    message: `The stored history of conversation ${id} has a tool call with no result before later entries, which cannot be repaired in an append-only log`,
  });
}
