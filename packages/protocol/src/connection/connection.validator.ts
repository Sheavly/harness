import { z } from 'zod';
import { MAX_CONNECTION_ERROR_CHARS } from './connection.constants.js';

const error = z.string().max(MAX_CONNECTION_ERROR_CHARS);

/**
 * Where a model call stands when it cannot reach its provider. `offline`: this machine has no
 * connection, so the call waits for it. `provider_unreachable`: the connection works and the
 * provider does not answer (or fails), so the call is retried a few times and then reported.
 * `restored`: the call got through; it ends either state. Each state carries only its own fields.
 */
export const modelConnectionSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('offline'), error }),
  z.strictObject({
    state: z.literal('provider_unreachable'),
    error,
    /** The retry about to be made (1 is the first), out of `retries`. */
    attempt: z.number().int().positive(),
    retries: z.number().int().positive(),
  }),
  z.strictObject({ state: z.literal('restored') }),
]);
