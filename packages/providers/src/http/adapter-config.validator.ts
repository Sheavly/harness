import { z } from 'zod';
import { FIELD_KIND } from './http.constants.js';

// Config pieces the built-in adapters share. Each adapter adds its own defaults.

/** A base URL, without trailing slashes. */
export const baseUrlSchema = z
  .url()
  .transform((url) => url.replace(/\/+$/, ''))
  .describe('The API’s address');

/** A key. A secret: it goes to the credentials, never into a model's file. */
export const apiKeySchema = z
  .string()
  .min(1)
  .meta({ [FIELD_KIND.secret]: true, title: 'API key' });

/** Keep encrypted reasoning across tool calls. See `ResponsesProviderConfig.reasoning`. */
export const reasoningSchema = z.boolean();

/**
 * Cache conversation history before transient notices with explicit breakpoints. On by default
 * (adapters default it to true); turn it off for models before GPT-5.6, which reject the request
 * fields. It is never guessed from a model or deployment name.
 */
export const explicitCacheSchema = z.boolean().meta({
  title: 'Explicit prompt cache',
  description: 'Cache history with explicit breakpoints (GPT-5.6 and later only)',
});

/**
 * How a call is sent: how long to wait for the response to start, how often to retry one that
 * failed before anything streamed, and how long to wait for a lost connection to come back.
 * Required, with no defaults: like the model, it is the
 * caller's choice. See `RequestPolicy`. Host-owned: a model's file doesn't hold it, the backend
 * supplies it.
 */
export const requestPolicySchema = z
  .object({
    responseTimeoutMs: z.number().int().positive(),
    retries: z.number().int().min(0).max(10),
    retryDelayMs: z.number().int().min(0),
    offlineTimeoutMs: z.number().int().min(0),
    probeUrls: z.array(z.url()),
  })
  .meta({ [FIELD_KIND.host]: true });
