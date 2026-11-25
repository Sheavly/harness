import { describe, expect, it } from 'vitest';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { collect, requestSentBy } from '@sheavly/testing/fetch/fake-fetch.fake';
import { createDefaultRegistry } from '../../registry/default-registry.helper.js';
import { TEST_REQUEST } from '../../testing/request.constants.js';
import { bedrockAnthropicAdapter } from '../anthropic.adapter.js';
import { bedrockOpenaiAdapter } from '../openai.adapter.js';

const clock = useFixedClock(); // 2023-11-14T22:13:20Z
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const keyPair = { auth: 'access-key', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET };
const claude = {
  ...keyPair,
  region: 'us-east-1',
  model: 'us.anthropic.claude-sonnet-5-5',
  maxTokens: 64,
  request: TEST_REQUEST,
};
const gpt = {
  ...keyPair,
  region: 'us-east-1',
  model: 'us.openai.gpt-6-astra',
  request: TEST_REQUEST,
};

type Send = (overrides?: object) => ReturnType<typeof requestSentBy>;

const sendClaude: Send = (overrides = {}) =>
  requestSentBy({
    adapter: bedrockAnthropicAdapter,
    config: { ...claude, ...overrides },
    reply: [{ type: 'message_stop' }],
  });
const sendGpt: Send = (overrides = {}) =>
  requestSentBy({ adapter: bedrockOpenaiAdapter, config: { ...gpt, ...overrides } });

describe.each([
  ['bedrock-anthropic', sendClaude],
  ['bedrock-openai', sendGpt],
] as const)('%s signed in with an access key pair', (_kind, sent) => {
  it('signs the request for bedrock in its Region, and sends no API key', async () => {
    const request = await sent();

    expect(request?.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20231114\/us-east-1\/bedrock\/aws4_request, SignedHeaders=.*host.*x-amz-date.*, Signature=[0-9a-f]{64}$/,
    );
    expect(request?.headers['x-amz-date']).toBe('20231114T221320Z');
    expect(request?.headers).not.toHaveProperty('x-api-key');
    expect(request?.headers).not.toHaveProperty('x-amz-security-token');
  });

  it('signs every header it sends but the signature itself, so none can be added after', async () => {
    const request = await sent({ sessionToken: 'session-token-value' });
    const signedNames = /SignedHeaders=([^,]+),/.exec(request?.headers.authorization ?? '')?.[1];
    const sentNames = Object.keys(request?.headers ?? {}).filter(
      (name) => name !== 'authorization',
    );

    // `host` is signed too but is set by fetch, not by us.
    expect(signedNames?.split(';').filter((name) => name !== 'host')).toEqual(sentNames.sort());
  });

  it('signs for the Region the model names', async () => {
    const request = await sent({ region: 'eu-west-1' });

    expect(request?.headers.authorization).toContain('/20231114/eu-west-1/bedrock/aws4_request');
  });

  it('sends a session token with, and signs it, for temporary credentials', async () => {
    const request = await sent({ sessionToken: 'session-token-value' });

    expect(request?.headers['x-amz-security-token']).toBe('session-token-value');
    expect(request?.headers.authorization).toContain('x-amz-security-token');
  });

  it('never puts the secret key in what it sends', async () => {
    const request = await sent({ sessionToken: 'session-token-value' });
    const everything = JSON.stringify([request?.headers, request?.body, request?.url]);

    expect(everything).not.toContain(SECRET);
    expect(JSON.stringify(request?.body)).not.toContain('session-token-value');
  });
});

describe('signing in to Bedrock with an access key pair', () => {
  it('signs every attempt anew: a retry carries the time it is sent at', async () => {
    const dates: string[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      dates.push(new Headers(init?.headers).get('x-amz-date') ?? '');
      clock.advance(60_000);

      return dates.length === 1
        ? new Response('busy', { status: 503 })
        : new Response('data: {"type":"message_stop"}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
    }) as typeof globalThis.fetch;
    const provider = bedrockAnthropicAdapter.create({
      config: bedrockAnthropicAdapter.configSchema.parse({
        ...claude,
        request: { ...TEST_REQUEST, responseTimeoutMs: 1000, retries: 1 },
      }),
      deps: { fetch },
    });

    await collect(
      provider.stream({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: new AbortController().signal,
      }),
    );

    expect(dates).toEqual(['20231114T221320Z', '20231114T221420Z']);
  });

  it.each([
    ['an API key with no key given', { auth: 'api-key', apiKey: undefined }, 'apiKey'],
    ['an access key with no key id', { accessKeyId: undefined }, 'accessKeyId'],
    ['an access key with no secret', { secretAccessKey: undefined }, 'secretAccessKey'],
    ['both an API key and an access key pair', { apiKey: 'bk-key' }, 'apiKey'],
    [
      'an access key pair under API key credentials',
      { auth: 'api-key', apiKey: 'bk-key' },
      'accessKeyId',
    ],
    ['credentials that are not chosen', { auth: undefined }, 'auth'],
  ])('refuses %s, naming the field and never a secret', (_name, overrides, field) => {
    const parsed = bedrockAnthropicAdapter.configSchema.safeParse({ ...claude, ...overrides });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path[0])).toContain(field);
    expect(JSON.stringify(parsed.error?.issues)).not.toContain(SECRET);
    expect(JSON.stringify(parsed.error?.issues)).not.toContain('bk-key');
  });

  it.each([
    ['a secret key with a line break', { secretAccessKey: 'abc\ndef-SECRETVALUE' }],
    ['a secret key with a space', { secretAccessKey: 'abc def-SECRETVALUE' }],
    ['a session token with a line break', { sessionToken: 'tok\r\nx-evil: 1-SECRETVALUE' }],
    ['an access key ID with a control character', { accessKeyId: 'AKID\u0000-SECRETVALUE' }],
    ['an empty secret key', { secretAccessKey: '' }],
    ['a secret key that is not text', { secretAccessKey: 12_345 }],
  ])('refuses %s, naming the field and never what was entered', (_name, overrides) => {
    const parsed = bedrockAnthropicAdapter.configSchema.safeParse({ ...claude, ...overrides });

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).not.toContain('SECRETVALUE');
    expect(JSON.stringify(parsed.error?.issues)).not.toContain('12345');
  });

  it('marks all four credentials a secret, and lists them, for both adapters', () => {
    const described = createDefaultRegistry().describe();

    for (const kind of ['bedrock-anthropic', 'bedrock-openai']) {
      expect(described.find((adapter) => adapter.kind === kind)?.secrets, kind).toEqual([
        'apiKey',
        'accessKeyId',
        'secretAccessKey',
        'sessionToken',
      ]);
    }
  });

  it('accepts an API key with its own mode, which is what API-key models already use', () => {
    const { accessKeyId: _id, secretAccessKey: _secret, ...rest } = claude;

    expect(
      bedrockAnthropicAdapter.configSchema.safeParse({ ...rest, auth: 'api-key', apiKey: 'bk-key' })
        .success,
    ).toBe(true);
  });
});
