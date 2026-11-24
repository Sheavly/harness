import { describe, expect, it } from 'vitest';
import { modelConnectionSchema } from '../connection.validator.js';

describe('a model connection report', () => {
  it('accepts each state with only the fields that state has', () => {
    expect(modelConnectionSchema.parse({ state: 'offline', error: 'ENOTFOUND' }).state).toBe(
      'offline',
    );
    expect(
      modelConnectionSchema.parse({
        state: 'provider_unreachable',
        error: 'HTTP 503',
        attempt: 1,
        retries: 2,
      }).state,
    ).toBe('provider_unreachable');
    expect(modelConnectionSchema.parse({ state: 'restored' })).toEqual({ state: 'restored' });
  });

  it('refuses a provider report with no retry count, and an unknown state', () => {
    expect(
      modelConnectionSchema.safeParse({ state: 'provider_unreachable', error: 'HTTP 503' }).success,
    ).toBe(false);
    expect(modelConnectionSchema.safeParse({ state: 'waiting' }).success).toBe(false);
  });

  it('refuses a retry that is not a positive whole number', () => {
    const report = { state: 'provider_unreachable', error: 'HTTP 503', retries: 2 };

    expect(modelConnectionSchema.safeParse({ ...report, attempt: 0 }).success).toBe(false);
    expect(modelConnectionSchema.safeParse({ ...report, attempt: 1.5 }).success).toBe(false);
  });
});
