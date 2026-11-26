import type { Context } from 'hono';
import { ConversationsError } from '@sheavly/host/errors/conversations.errors';
import type { Conversations } from '@sheavly/host/conversations/conversations.service';
import { approvalIdSchema } from '@sheavly/protocol/approval/approval.validator';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { ApiHandlers, ConversationRouteName } from './api.types.js';
import { parseLastEventId } from './api.utils.js';
import { streamEntries } from './sse.helper.js';
import { streamSubscription } from './subscription-stream.helper.js';

/**
 * The conversation id in a route's path; routes without one (`/conversations`) never read it. An
 * id that isn't a conversation id's shape (a lowercase UUID) can name no conversation, so it
 * answers as one nothing has does: `not_found`, not an error of the server's.
 */
export function idOf(c: Context): ConversationId {
  const parsed = conversationIdSchema.safeParse(c.req.param('id'));

  if (!parsed.success) {
    throw new ConversationsError({
      reason: 'not_found',
      message: `No conversation ${c.req.param('id')}: a conversation id is a lowercase UUID`,
    });
  }

  return parsed.data;
}

/**
 * The node in a route's path, as the host judges it: a string that is not a node id's shape names
 * no node, so it answers as one nothing has does (`not_found`), which the host decides in one place.
 */
function nodeOf(c: Context): string {
  return c.req.param('node') ?? '';
}

/** Each conversation route's handler on `conversations`. */
export function apiHandlers(
  conversations: Conversations,
): Pick<ApiHandlers, ConversationRouteName> {
  return {
    listConversations: ({ c }) => c.json({ conversations: conversations.list() }),
    queryStoredConversations: async ({ c, body }) =>
      c.json({
        conversations: await conversations.listStored({
          search: body.search,
          workspace: body.workspace,
          profile: body.profile,
        }),
      }),
    reopenConversation: async ({ c, id }) => c.json({ id: await conversations.reopen(id) }),
    startConversation: async ({ c, body }) =>
      c.json(
        {
          id: await conversations.start({
            messages: body.messages,
            workspace: body.workspace,
            profile: body.profile,
            model: body.model,
            effort: body.effort,
          }),
        },
        201,
      ),
    getConversation: async ({ c, id }) => c.json(await conversations.details(id)),
    closeConversation: async ({ c, id }) => {
      await conversations.close(id);

      return c.body(null, 204);
    },
    switchModel: async ({ c, id, body }) => {
      await conversations.useModel({
        id,
        modelId: body.id,
        ...(body.effort && { effort: body.effort }),
      });

      return c.body(null, 204);
    },
    getMessages: ({ c, id }) => c.json({ messages: [...conversations.messages(id)] }),
    querySkills: async ({ c, id, body }) =>
      c.json({
        skills: await conversations.skills({ id, search: body.search, signal: c.req.raw.signal }),
      }),
    // Answered at once, never held open for a run: the prompt's entries go on the conversation's
    // stream, which a client follows, and a line sent while it is busy waits in its queue.
    sendPrompt: async ({ c, id, body }) => c.json(await conversations.submit({ id, prompt: body })),
    yieldPrompt: ({ c, id }) => c.json({ accepted: conversations.yieldPrompt(id) }),
    getQueue: async ({ c, id }) => c.json({ queued: await conversations.queue(id) }),
    setQueue: async ({ c, id, body }) => {
      await conversations.setQueue({ id, queued: body.queued });

      return c.body(null, 204);
    },
    stopPrompt: ({ c, id }) => {
      conversations.stop(id);

      return c.body(null, 204);
    },
    // The node is in the path, resolved inside the conversation the path names: another
    // conversation's node is `not_found` here, as one that never was.
    cancelNode: async ({ c, id }) => {
      await conversations.cancelNode({ id, node: nodeOf(c) });

      return c.body(null, 204);
    },
    messageNode: ({ c, id, body }) => {
      conversations.messageNode({ id, node: nodeOf(c), text: body.text });

      return c.body(null, 204);
    },
    answerApproval: ({ c, id, body }) => {
      conversations.answer({
        id,
        approval: approvalIdSchema.parse(c.req.param('approval')),
        response: body.response,
      });

      return c.body(null, 204);
    },
    streamConversation: ({ c, id, body }) => {
      const lastEventId = parseLastEventId(c.req.header('last-event-id'));

      return streamEntries({
        c,
        live: conversations.get(id),
        filter: {
          ...(body.session !== undefined && { sessionId: body.session }),
          ...(body.subtree !== undefined && { subtree: body.subtree }),
          // Resuming needs the entries since the one the client got, which only replay has.
          replay: body.replay === true || lastEventId !== undefined,
        },
        lastEventId,
        answersApprovals: body.approvals === true,
      });
    },
    getTree: async ({ c, id }) => c.json(await conversations.tree(id)),
    getUsage: async ({ c, id }) => c.json(await conversations.usage(id)),
    // A request that cannot be served is refused here, before a stream opens, as an HTTP failure.
    streamChannels: async ({ c, id, body }) => {
      const gone = c.req.raw.signal;

      try {
        const subscription = await conversations.subscribe({ id, request: body, signal: gone });

        return streamSubscription({ c, subscription });
      } catch (caughtError) {
        // The read stopped because the client left (it rejects with the signal's reason): nobody is
        // there to read an answer. Any other failure, even of a client that left, is still thrown
        // and logged.
        if (gone.aborted && caughtError === gone.reason) return c.body(null, 204);

        throw caughtError;
      }
    },
  };
}
