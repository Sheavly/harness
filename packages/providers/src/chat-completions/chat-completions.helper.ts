import type { z } from 'zod';
import { defineAdapter } from '@sheavly/core/adapter/adapter.utils';
import type { Adapter } from '@sheavly/core/adapter/adapter.types';
import type { Provider } from '@sheavly/core/provider/provider.types';
import { sendRequest } from '../http/request.helper.js';
import { replaySource } from '../http/replay.utils.js';
import { chatRequestBody } from './request.utils.js';
import { readChatReply } from './chat-stream.helper.js';
import { chatMaxTokens } from './output-tokens.utils.js';
import type {
  ChatAdapterConfig,
  ChatEndpoint,
  ChatProviderConfig,
} from './chat-completions.types.js';

/** Native Chat Completions; it does not reuse Responses request, event or reasoning formats. */
export function createChatCompletionsProvider(config: ChatProviderConfig): Provider {
  const { endpoint, replayReasoning = false, thinkingMode, effortProfile = 'openai' } = config;
  const maxTokens = chatMaxTokens({ model: endpoint.model, maxTokens: config.maxTokens });
  const source = replaySource({ protocol: 'chat', endpoint: endpoint.url, model: endpoint.model });

  return {
    async *stream(request) {
      const url = new URL(endpoint.url);

      const response = yield* sendRequest({
        api: 'Chat Completions API',
        fetch: config.fetch,
        url,
        policy: config.request,
        signal: request.signal,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...endpoint.headers },
          body: JSON.stringify(
            chatRequestBody({
              request,
              endpoint,
              source,
              replayReasoning,
              maxTokens,
              thinkingMode,
              effortProfile,
              onReplayDropped: config.onReplayDropped,
            }),
          ),
        },
      });

      yield* readChatReply({
        body: response.body as ReadableStream<Uint8Array>,
        source,
        replayReasoning,
        signal: request.signal,
      });
    },
  };
}

/** Adapters own endpoint mapping; the native protocol owns serialization, streaming and replay. */
export function defineChatCompletionsAdapter<S extends z.ZodType<ChatAdapterConfig>>(params: {
  kind: string;
  description: string;
  configSchema: S;
  remoteField?: string;
  toEndpoint: (config: z.infer<S>) => ChatEndpoint;
}): Adapter<S> {
  const { toEndpoint, ...adapter } = params;

  return defineAdapter({
    ...adapter,
    create: ({ config, deps }) =>
      createChatCompletionsProvider({
        endpoint: toEndpoint(config),
        request: config.request,
        fetch: deps.fetch,
        onReplayDropped: deps.onReplayDropped,
        maxTokens: config.maxTokens,
        replayReasoning: config.replayReasoning,
        thinkingMode: config.thinkingMode,
        effortProfile: config.effortProfile,
      }),
  });
}
