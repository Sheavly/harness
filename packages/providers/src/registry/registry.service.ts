import type { Adapter, AdapterDeps } from '@sheavly/core/adapter/adapter.types';
import type { Provider } from '@sheavly/core/provider/provider.types';
import { parseOrThrow } from '@sheavly/core/validation/validation.validator';
import type { AdapterDescription, KeyCheck } from '@sheavly/protocol/model/model.types';
import { AdapterError } from '../errors/providers.errors.js';
import { createModelFetch } from '../http/model-fetch.helper.js';
import { checkHostOf } from './check-message.utils.js';
import { checkProvider } from './check.helper.js';
import { definitionProblems } from './definition.utils.js';
import { describeAdapter, fieldsMarked } from './describe.utils.js';
import { CHECK_REQUEST } from './registry.constants.js';
import type { DefinitionProblem } from './registry.types.js';

export class AdapterRegistry {
  private readonly adapters = new Map<string, Adapter>();

  constructor(private readonly deps: AdapterDeps = { fetch: createModelFetch() }) {}

  register(adapter: Adapter): this {
    if (this.adapters.has(adapter.kind)) {
      throw new AdapterError({
        reason: 'duplicate',
        kind: adapter.kind,
        message: `Adapter already registered: ${adapter.kind}`,
      });
    }

    this.adapters.set(adapter.kind, adapter);

    return this;
  }

  kinds(): string[] {
    return [...this.adapters.keys()];
  }

  /** Validates `config` with the adapter's zod schema and builds a Provider. */
  create(kind: string, config: unknown): Provider {
    const adapter = this.#adapter(kind);
    const parsed = parseOrThrow({
      schema: adapter.configSchema,
      input: config,
      onInvalid: ({ details, error }) =>
        new AdapterError({
          reason: 'invalid_config',
          kind,
          message: `Invalid config for ${kind}:\n${details}`,
          cause: error,
        }),
    });

    return adapter.create({ config: parsed, deps: this.deps });
  }

  /**
   * Every adapter as a UI builds a form from it: its config as JSON Schema (without what the host
   * supplies, secrets marked), the names of its secrets, and the field that holds what the
   * provider calls the model. In the order they were registered.
   */
  describe(): AdapterDescription[] {
    return [...this.adapters.values()].map((adapter) =>
      describeAdapter({
        kind: adapter.kind,
        description: adapter.description,
        schema: adapter.configSchema,
        remoteField: adapter.remoteField,
      }),
    );
  }

  /** The names of adapter `kind`'s secret fields: they belong in credentials, not in a model's file. */
  secretFields(kind: string): string[] {
    return fieldsMarked({ schema: this.#adapter(kind).configSchema, kind: 'secret' });
  }

  /**
   * What is wrong with `definition` as a model of adapter `kind`, checked without its secret:
   * `host` supplies what the backend fills in (the request policy). Empty when it is fine. A
   * secret inside the definition is a problem of its own.
   */
  validateDefinition(params: {
    kind: string;
    definition: Record<string, unknown>;
    host: Record<string, unknown>;
  }): DefinitionProblem[] {
    const { kind, definition, host } = params;

    return definitionProblems({ schema: this.#adapter(kind).configSchema, definition, host });
  }

  /**
   * Whether `config` (the definition and the secret, without the request policy) reaches a model
   * that answers: one tiny call through the adapter's own provider, so the key, the endpoint and
   * the deployment are all tried. No retries, and it gives up after `responseTimeoutMs`. The
   * result carries a fixed message per status, never what the provider said. Rejects when
   * `signal` aborts, and for a `config` the adapter does not accept.
   */
  async check(params: {
    kind: string;
    config: Record<string, unknown>;
    signal?: AbortSignal | undefined;
    responseTimeoutMs?: number | undefined;
  }): Promise<KeyCheck> {
    const { kind, config, signal, responseTimeoutMs } = params;
    const provider = this.create(kind, { ...config, request: CHECK_REQUEST });

    return checkProvider({
      provider,
      signal,
      responseTimeoutMs,
      host: checkHostOf({ kind, config }),
    });
  }

  #adapter(kind: string): Adapter {
    const adapter = this.adapters.get(kind);

    if (!adapter) {
      throw new AdapterError({
        reason: 'unknown',
        kind,
        message: `Unknown adapter: ${kind} (available: ${this.kinds().join(', ') || 'none'})`,
      });
    }

    return adapter;
  }
}
