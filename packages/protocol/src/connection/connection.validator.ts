import { z } from 'zod';

/**
 * Where a model call stands when it cannot reach its provider. `offline`: this machine has no
 * connection, so the call waits for it. `provider_unreachable`: the connection works and the
 * provider does not answer (or fails), so the call is retried a few times and then reported.
 * `restored`: the call got through; it ends either state.
 */
export const modelConnectionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('offline'), error: z.string() }),
  z.object({
    state: z.literal('provider_unreachable'),
    error: z.string(),
    /** The retry about to be made (1 is the first), out of `retries`. */
    attempt: z.number().int().positive(),
    retries: z.number().int().positive(),
  }),
  z.object({ state: z.literal('restored') }),
]);
