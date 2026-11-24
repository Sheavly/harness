import { z } from 'zod';
import { defineTool } from '@sheavly/core/tool/tool.utils';
import { ToolCallError } from '@sheavly/core/errors/tool.errors';
import { attributeValue } from '@sheavly/core/text/text.utils';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { MessageAgentOptions } from './message-agent.types.js';
import { messageAgentPrompts } from './message-agent.prompt.js';

/**
 * `message_agent`: steers a running sub-agent without stopping it. The message waits in the
 * sub-agent's inbox and is added to its conversation at its next model call. Only the session
 * that started a sub-agent (or one above it) may message it; the registry refuses others.
 */
export function createMessageAgentTool({ sessions, children }: MessageAgentOptions) {
  return defineTool({
    name: 'message_agent',
    description: messageAgentPrompts.description,
    inputSchema: z.object({
      session: sessionIdSchema.min(1).describe(messageAgentPrompts.session),
      message: z.string().min(1).describe(messageAgentPrompts.message),
    }),
    execute: async ({ input: { session: id, message }, context }) => {
      if (!context.session) {
        throw new ToolCallError({
          reason: 'unavailable',
          message: 'message_agent only works inside an agent session',
        });
      }

      if (sessions.isReleased(id)) {
        throw new ToolCallError({
          reason: 'not_found',
          message: `Sub-agent session ${id} already finished and its report was delivered, so it was released and cannot be messaged. Start a new sub-agent for more work`,
        });
      }

      children.send({ id, content: message, from: context.session.id });
      const target = sessions.get(id);

      // The title is written by whoever started the sub-agent (an extension names its own), and it
      // sits inside quotes: one line, no tag, and no quote that could end the quoted title early.
      return `Sent to sub-agent "${attributeValue(target?.title ?? id)}" (session ${id}). It sees the message at its next step.`;
    },
  });
}
