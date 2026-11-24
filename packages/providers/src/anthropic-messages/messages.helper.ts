import type { z } from 'zod';
import { defineAdapter } from '@sheavly/core/adapter/adapter.utils';
import type { Adapter } from '@sheavly/core/adapter/adapter.types';
import type { Provider } from '@sheavly/core/provider/provider.types';
import { sendRequest } from '../http/request.helper.js';
import { replaySource } from '../http/replay.utils.js';
import { ANTHROPIC_VERSION, MESSAGES_API, PROMPT_CACHE_CONTROL } from './messages.constants.js';
import { noticeBlocks, toMessagesApiMessages, withNotices } from './input.utils.js';
import { withCacheBreakpoint } from './cache-breakpoint.utils.js';
import type {
  MessagesAdapterConfig,
  MessagesEndpoint,
  MessagesProviderConfig,
} from './messages.types.js';
import { thinkingFor } from './thinking.utils.js';
import { messagesPrefix } from './prefix.utils.js';
import { messagesMaxTokens } from './output-tokens.utils.js';
import { readMessagesReply } from './messages-stream.helper.js';

/** A Provider for any backend that speaks the Anthropic Messages API. */
export function createMessagesProvider(config: MessagesProviderConfig): Provider {
  const { endpoint } = config;
  const maxTokens = messagesMaxTokens({ model: endpoint.model, maxTokens: config.maxTokens });
  const thinking = thinkingFor(config);

  return {
    async *stream({ instructions, messages, notices, tools, signal, effort, temperature }) {
      // Effort enables adaptive thinking; preserve its signed blocks across tool calls as well.
      const reasoningSource =
        effort || thinking?.type === 'enabled' || thinking?.type === 'adaptive'
          ? replaySource({
              protocol: 'messages',
              endpoint: endpoint.baseUrl,
              model: endpoint.model,
            })
          : undefined;
      const apiTools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
      const apiMessages = toMessagesApiMessages({
        messages,
        reasoningSource,
        instructions,
        tools: apiTools,
        onReplayDropped: config.onReplayDropped,
      });

      const sent = withNotices({ messages: apiMessages, notices });
      // The breakpoint goes on history only, so the prefix check above stays over what is sent.
      const body =
        config.promptCaching !== false && notices?.length
          ? withNotices({ messages: withCacheBreakpoint(apiMessages), notices })
          : sent;
      const response = yield* sendRequest({
        api: MESSAGES_API,
        fetch: config.fetch,
        url: new URL(`${endpoint.baseUrl}/messages`),
        policy: config.request,
        signal,
        sign: endpoint.sign,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': ANTHROPIC_VERSION,
            ...endpoint.headers,
          },
          body: JSON.stringify({
            model: endpoint.model,
            max_tokens: maxTokens,
            ...(instructions ? { system: instructions } : {}),
            messages: body,
            ...(tools.length > 0 && {
              tools: apiTools,
            }),
            ...(effort
              ? {
                  thinking: { type: 'adaptive' },
                  output_config: { effort: effort === 'extreme' ? 'max' : effort },
                }
              : thinking && { thinking }),
            // Thinking requires the default temperature, so a hint is sent only without it.
            ...(temperature !== undefined &&
              !effort &&
              (!thinking || thinking.type === 'disabled') && { temperature }),
            ...(config.promptCaching !== false && { cache_control: PROMPT_CACHE_CONTROL }),
            stream: true,
          }),
        },
      });

      // sendRequest guarantees a body for a started stream. The API binds a thinking signature to
      // everything sent before it, the notice included. The reply keeps those notice blocks next to
      // the prefix covering them, and the next request sends them again in the same place, so the
      // signature still matches and the thinking is replayed instead of dropped.
      yield* readMessagesReply({
        body: response.body as ReadableStream<Uint8Array>,
        reasoningSource,
        prefix: messagesPrefix({ instructions, tools: apiTools, messages: sent }),
        notices: noticeBlocks(notices),
        signal,
      });
    },
  };
}

/**
 * An adapter for a Messages backend. The backend only maps its validated config to an endpoint
 * (`toEndpoint`, pure); the protocol, streaming and thinking are shared.
 */
export function defineMessagesAdapter<TSchema extends z.ZodType<MessagesAdapterConfig>>(params: {
  kind: string;
  description: string;
  configSchema: TSchema;
  remoteField?: string;
  toEndpoint: (config: z.infer<TSchema>) => MessagesEndpoint;
}): Adapter<TSchema> {
  const { toEndpoint, ...adapter } = params;

  return defineAdapter({
    ...adapter,
    create: ({ config, deps }) =>
      createMessagesProvider({
        endpoint: toEndpoint(config),
        maxTokens: config.maxTokens,
        thinkingBudget: config.thinkingBudget,
        thinkingMode: config.thinkingMode,
        promptCaching: config.promptCaching,
        request: config.request,
        fetch: deps.fetch,
        onReplayDropped: deps.onReplayDropped,
      }),
  });
}
