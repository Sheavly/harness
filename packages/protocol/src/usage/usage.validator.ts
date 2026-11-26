import { z } from 'zod';
import { contextWindowSchema, modelIdSchema } from '../model/model.validator.js';

const count = z.number().int().nonnegative();
const dollars = z.number().nonnegative();

/** Input includes cache reads and writes; output includes reasoning tokens when the API does. */
export const tokenUsageSchema = z
  .object({
    inputTokens: count,
    outputTokens: count,
    cacheReadTokens: count,
    cacheWriteTokens: count,
  })
  .refine((usage) => usage.inputTokens >= usage.cacheReadTokens + usage.cacheWriteTokens);

/**
 * One model call. Null tokens mean the provider did not report usage, never zero usage. The
 * window is the size of the context the call ran against, left out when the model's is unknown.
 * `purpose` is left out for a turn's own call. `summary` marks the call that wrote a checkpoint:
 * it is billed like any other, but it says nothing about how full the conversation's context is.
 */
export const modelUsageSchema = z.object({
  tokens: tokenUsageSchema.nullable(),
  purpose: z.literal('summary').exactOptional(),
  modelId: modelIdSchema.exactOptional(),
  contextWindow: contextWindowSchema.exactOptional(),
  estimatedCostUsd: dollars.exactOptional(),
});

/**
 * How full an agent's context was at its last call that counts: `used` of the `window`, of which
 * `cached` came from the prompt cache. Each is left out when it is not known (the provider did not
 * report tokens, or the model's window is unknown). A call that wrote a summary is not one.
 */
export const contextFillSchema = z.object({
  used: count.exactOptional(),
  cached: count.exactOptional(),
  window: contextWindowSchema.exactOptional(),
});

/**
 * What model calls have used: how many, their tokens and estimated cost, the calls that reported no
 * usage or had no price, and whether some call is missing from it altogether (`incomplete`: a turn
 * that ended with no usage reported). One node's figures, or the sum of every node's.
 */
export const usageFiguresSchema = z.object({
  calls: count,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  estimatedCostUsd: dollars,
  missingUsageCalls: count,
  unpricedCalls: count,
  incomplete: z.boolean(),
});

/**
 * Latest main-session measurement, not billing totals; seq orders snapshots against live usage.
 * `cached` is how much of `used` the last call read from the prompt cache.
 */
export const contextUsageSchema = contextFillSchema.extend({
  throughSeq: z.number().int().min(-1),
});

/** The whole conversation's figures, with the stream entry they are counted through. */
export const usageTotalsSchema = usageFiguresSchema.extend({
  throughSeq: z.number().int().min(-1),
});
