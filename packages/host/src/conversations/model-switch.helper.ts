import type { ModelEffort, ModelId } from '@sheavly/protocol/model/model.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { ConversationsError } from '../errors/conversations.errors.js';
import type { ConversationKeeper } from './keeper.service.js';
import type { LiveConversation } from './conversations.types.js';

/**
 * Switches `live`, conversation `id`, to the model `modelId` from its next model call. The main
 * session records it (`session_model`) and, when the conversation is kept, its index follows, so a
 * reopen finds the model last used. The keeper is looked up in `keepers` after the switch: a
 * conversation closed while it went on has none, and its index is left alone. Throws
 * `unknown_model` for a model the conversation does not have.
 */
export async function switchModel(params: {
  id: ConversationId;
  live: LiveConversation;
  keepers: ReadonlyMap<ConversationId, ConversationKeeper>;
  modelId: ModelId;
  effort?: ModelEffort | undefined;
}): Promise<void> {
  const { id, live, modelId } = params;

  if (!(await live.run.useModel(modelId, params.effort))) {
    throw new ConversationsError({
      reason: 'unknown_model',
      message: `No model with id ${modelId} in conversation ${id}; its details list the models`,
    });
  }

  const effort = live.run.details().model.effort ?? 'medium';

  live.harness.sessions.setModel({ id: live.harness.mainSession.id, modelId, effort });
  params.keepers.get(id)?.keepIndex({ modelId, effort });
}
