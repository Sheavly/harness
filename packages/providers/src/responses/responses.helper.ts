import type { z } from 'zod';
import { defineAdapter } from '@sheavly/core/adapter/adapter.utils';
import type { Adapter } from '@sheavly/core/adapter/adapter.types';
import type { Provider } from '@sheavly/core/provider/provider.types';
import { formatHarnessNotice } from '@sheavly/core/notice/notice.utils';
import type {
  ResponsesAdapterConfig,
  ResponsesEndpoint,
  ResponsesProviderConfig,
} from './responses.types.js';
import { breakpointIndexes, toInputItems } from './input.utils.js';
import { EXPLICIT_CACHE_OPTIONS } from './responses.constants.js';
import { sendRequest } from '../http/request.helper.js';
import { replaySource } from '../http/replay.utils.js';
import { readResponsesReply } from './responses-stream.helper.js';

/** A Provider for any backend that speaks the OpenAI Responses API. */
export function createResponsesProvider(config: ResponsesProviderConfig): Provider {
  const { endpoint } = config;
  const reasoning = config.reasoning ?? true;
  /** Encrypted reasoning is only valid for the backend + model that produced it. */
  const source = replaySource({
    protocol: 'responses',
    endpoint: endpoint.baseUrl,
    model: endpoint.model,
  });
  const reasoningSource = reasoning ? source : undefined;

  return {
    async *stream({
      instructions,
      messages,
      notices = [],
      tools,
      signal,
      effort,
      temperature,
      cacheKey,
    }) {
      const marked = config.explicitCache ? breakpointIndexes(messages) : undefined;
      const url = new URL(`${endpoint.baseUrl}/responses`);

      for (const [key, value] of Object.entries(endpoint.query ?? {})) {
        url.searchParams.set(key, value);
      }

      const response = yield* sendRequest({
        api: 'Responses API',
        fetch: config.fetch,
        url,
        policy: config.request,
        signal,
        sign: endpoint.sign,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...endpoint.headers },
          body: JSON.stringify({
            model: endpoint.model,
            // The Responses API's system prompt; with `store: false` it is sent every call.
            ...(instructions ? { instructions } : {}),
            input: [
              ...messages.flatMap((message, index) =>
                toInputItems({
                  message,
                  reasoningSource,
                  onReplayDropped: config.onReplayDropped,
                  ...(marked && { cache: { marked: marked.has(index) } }),
                }),
              ),
              ...notices.map((notice) => ({ role: 'user', content: formatHarnessNotice(notice) })),
            ],
            tools: tools.map((tool) => ({
              type: 'function',
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            })),
            stream: true,
            store: false,
            // Routes calls of one session to the same cache; automatic caching does the rest.
            ...(cacheKey && { prompt_cache_key: cacheKey }),
            // Explicit-only: writes end at the marked history, never at a transient notice.
            ...(marked && { prompt_cache_options: EXPLICIT_CACHE_OPTIONS }),
            ...(reasoning ? { include: ['reasoning.encrypted_content'] } : {}),
            ...(effort && { reasoning: { effort: effort === 'extreme' ? 'xhigh' : effort } }),
            // Reasoning models reject a temperature, so a hint is sent only with reasoning off.
            ...(temperature !== undefined && !reasoning && !effort && { temperature }),
          }),
        },
      });

      // sendRequest guarantees a body for a started stream.
      yield* readResponsesReply({
        body: response.body as ReadableStream<Uint8Array>,
        reasoningSource,
        signal,
      });
    },
  };
}

/**
 * An adapter for a Responses backend. The backend only maps its validated config to an endpoint
 * (`toEndpoint`, pure); the protocol, streaming and reasoning are shared.
 */
export function defineResponsesAdapter<TSchema extends z.ZodType<ResponsesAdapterConfig>>(params: {
  kind: string;
  description: string;
  configSchema: TSchema;
  remoteField?: string;
  toEndpoint: (config: z.infer<TSchema>) => ResponsesEndpoint;
}): Adapter<TSchema> {
  const { toEndpoint, ...adapter } = params;

  return defineAdapter({
    ...adapter,
    create: ({ config, deps }) =>
      createResponsesProvider({
        endpoint: toEndpoint(config),
        reasoning: config.reasoning,
        request: config.request,
        explicitCache: config.explicitCache,
        fetch: deps.fetch,
        onReplayDropped: deps.onReplayDropped,
      }),
  });
}
