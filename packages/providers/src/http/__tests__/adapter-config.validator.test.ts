import { describe, expect, it } from 'vitest';
import {
  apiKeySchema,
  baseUrlSchema,
  reasoningSchema,
  requestPolicySchema,
} from '../adapter-config.validator.js';

describe('adapter config schemas', () => {
  it('strips trailing slashes from a base URL', () => {
    expect(baseUrlSchema.parse('https://api.example.test/v1///')).toBe(
      'https://api.example.test/v1',
    );
  });

  it('rejects a base URL that is not a URL', () => {
    expect(baseUrlSchema.safeParse('api.example.test').success).toBe(false);
  });

  it('rejects an empty API key', () => {
    expect(apiKeySchema.safeParse('').success).toBe(false);
    expect(apiKeySchema.parse('sk-1')).toBe('sk-1');
  });

  it('takes reasoning as a boolean only', () => {
    expect(reasoningSchema.safeParse('true').success).toBe(false);
    expect(reasoningSchema.parse(false)).toBe(false);
  });
});

describe('the request policy’s probe addresses', () => {
  const policy = (probeUrls: string[]) =>
    requestPolicySchema.safeParse({
      responseTimeoutMs: 1000,
      retries: 0,
      retryDelayMs: 0,
      offlineTimeoutMs: 1000,
      probeUrls,
    }).success;

  it('take an http or https address, and none at all', () => {
    expect(policy([])).toBe(true);
    expect(policy(['https://1.1.1.1', 'http://probe.test/ping'])).toBe(true);
  });

  it.each(['file:///etc/passwd', 'data:text/plain,hi', 'ftp://probe.test', 'probe.test'])(
    'refuse %s, which a probe cannot ask',
    (address) => {
      expect(policy([address])).toBe(false);
    },
  );

  it.each(['https://user:secret@probe.test', 'https://user@probe.test'])(
    'refuse %s: an address with a user name or password',
    (address) => {
      expect(policy([address])).toBe(false);
    },
  );
});
