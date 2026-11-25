import type { ConversationDetails, ConversationId } from '@sheavly/protocol/server/server.types';
import type { LiveConversation } from './conversations.types.js';
import { summaryOf } from './conversations.utils.js';

/**
 * What live conversation `id`'s run is: its summary, the workspace, models and trust its app
 * reports (as they were when it was built), and the permission mode and working folder its
 * workspace has now, read each time since the user can change them while it runs.
 */
export async function detailsOf(params: {
  id: ConversationId;
  live: LiveConversation;
}): Promise<ConversationDetails> {
  const { id, live } = params;
  const { run } = live;
  const workingRoot = await run.workingRoot?.();

  return {
    ...summaryOf({ id, live }),
    ...run.details(),
    permissionMode: await run.permissionMode(),
    ...(workingRoot && { workingRoot }),
  };
}
