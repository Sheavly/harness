import { describe, expect, it } from 'vitest';
import { UnknownArgumentError } from '../../errors/arguments.errors.js';
import { DEFAULT_WEB_SEARCH_BACKENDS, REQUEST, SERVER } from '../harness.constants.js';
import {
  parseCliSettings,
  parseRequestEnv,
  parseRunEnv,
  parseServerEnv,
} from '../settings.validator.js';

describe('parseCliSettings', () => {
  it('reads --trust, and no arguments as not trusting', () => {
    expect(parseCliSettings({ env: {}, args: [] }).trustWorkspace).toBe(false);
    expect(parseCliSettings({ env: {}, args: ['--trust'] }).trustWorkspace).toBe(true);
  });

  it('refuses an argument the server does not read, naming it and what it takes', () => {
    for (const args of [['--version'], ['--trust', '--port=1'], ['x'], ['--trust=false']]) {
      expect(() => parseCliSettings({ env: {}, args }), args.join(' ')).toThrow(
        UnknownArgumentError,
      );
    }

    expect(() => parseCliSettings({ env: {}, args: ['--trust', '--version'] })).toThrow(
      'Unknown argument "--version": the server takes --trust',
    );
  });

  it('names an option it refuses but never repeats a value or a bare word, which may be a secret', () => {
    const refusal = (argument: string) => {
      try {
        parseCliSettings({ env: {}, args: [argument] });
      } catch (caughtError) {
        return caughtError instanceof Error ? caughtError.message : String(caughtError);
      }

      return 'accepted';
    };
    const secret = 'sk-live-0123456789abcdefghij';

    expect(refusal(`--key=${secret}`)).toBe('Unknown argument "--key=…": the server takes --trust');
    expect(refusal(secret)).toBe(
      `Unknown argument of ${String(secret.length)} characters: the server takes --trust`,
    );
    expect(refusal('x'.repeat(100_000))).toBe(
      'Unknown argument of 100000 characters: the server takes --trust',
    );
    expect(refusal('--')).toBe('Unknown argument "--": the server takes --trust');
    expect(refusal('-h')).toBe('Unknown argument "-h": the server takes --trust');
  });
});

describe('parseServerEnv', () => {
  it('listens on localhost by default, and on a free port with SERVER_PORT=0', () => {
    expect(parseServerEnv({})).toEqual({
      host: SERVER.host,
      port: SERVER.port,
      portIsDefault: true,
      token: undefined,
      discovery: true,
      remoteSetupAllowed: true,
    });
    expect(parseServerEnv({ SERVER_PORT: '0' }).port).toBe(0);
  });

  it('publishes discovery by default, and only the exact word "false" turns it off', () => {
    const discovery = (env: Record<string, string>) => parseServerEnv(env).discovery;

    expect(discovery({})).toBe(true);
    expect(discovery({ SERVER_DISCOVERY: '' })).toBe(true);
    expect(discovery({ SERVER_DISCOVERY: 'true' })).toBe(true);
    expect(discovery({ SERVER_DISCOVERY: 'false' })).toBe(false);
    expect(() => parseServerEnv({ SERVER_DISCOVERY: 'off' })).toThrow();
  });

  it('calls the port a default only when SERVER_PORT is unset or empty, so an explicit one stays strict', () => {
    const isDefault = (env: Record<string, string>) => parseServerEnv(env).portIsDefault;

    expect(isDefault({})).toBe(true);
    expect(isDefault({ SERVER_PORT: '' })).toBe(true);
    expect(isDefault({ SERVER_PORT: '4310' })).toBe(false);
    expect(isDefault({ SERVER_PORT: '0' })).toBe(false);
  });

  it('refuses a short token and a port past the range', () => {
    expect(() => parseServerEnv({ SERVER_TOKEN: 'short' })).toThrow('at least 32');
    expect(() => parseServerEnv({ SERVER_PORT: '70000' })).toThrow();
  });

  it('takes setup that hands out access where only this machine can reach, and nowhere else unless opted in', () => {
    const takes = (env: Record<string, string>) => parseServerEnv(env).remoteSetupAllowed;

    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1']) {
      expect(takes({ SERVER_HOST: host }), host).toBe(true);
    }

    // Every interface, or a LAN address, or a name: a key must not travel there.
    for (const host of ['0.0.0.0', '::', '192.168.1.5', 'example.com', '127.0.0.1.evil.com']) {
      expect(takes({ SERVER_HOST: host }), host).toBe(false);
    }
  });

  it('lets a remote host take setup that hands out access only on the exact word "true"', () => {
    const env = { SERVER_HOST: '0.0.0.0' };

    expect(parseServerEnv({ ...env, SERVER_ALLOW_REMOTE_SETUP: 'true' }).remoteSetupAllowed).toBe(
      true,
    );

    for (const word of ['TRUE', '1', 'yes', 'false', '']) {
      expect(
        parseServerEnv({ ...env, SERVER_ALLOW_REMOTE_SETUP: word }).remoteSetupAllowed,
        word,
      ).toBe(false);
    }
  });
});

describe('parseRunEnv', () => {
  it('reads the run limits and files with their default switches', () => {
    expect(parseRunEnv({})).toEqual({
      maxTurns: undefined,
      modelCallsFile: undefined,
      exitWithParent: false,
      webFetch: true,
      webSearch: true,
      webSearchBackends: DEFAULT_WEB_SEARCH_BACKENDS,
      summary: true,
      contextWindow: undefined,
    });
    expect(
      parseRunEnv({
        MAX_TURNS: '5',
        MODEL_CALLS_FILE: '/tmp/calls.jsonl',
        SERVER_EXIT_WITH_PARENT: 'yes',
      }),
    ).toEqual({
      maxTurns: 5,
      modelCallsFile: '/tmp/calls.jsonl',
      exitWithParent: false,
      webFetch: true,
      webSearch: true,
      webSearchBackends: DEFAULT_WEB_SEARCH_BACKENDS,
      summary: true,
      contextWindow: undefined,
    });
    expect(parseRunEnv({ MAX_TURNS: '' }).maxTurns).toBeUndefined();
    expect(() => parseRunEnv({ MAX_TURNS: '0' })).toThrow();
  });

  it('enables web_fetch by default and validates an explicit switch', () => {
    expect(parseRunEnv({ WEB_FETCH: '' }).webFetch).toBe(true);
    expect(parseRunEnv({ WEB_FETCH: 'true' }).webFetch).toBe(true);
    expect(parseRunEnv({ WEB_FETCH: 'false' }).webFetch).toBe(false);

    for (const value of ['1', 'yes', 'FALSE']) {
      expect(() => parseRunEnv({ WEB_FETCH: value })).toThrow();
    }
  });
});

describe('WEB_SEARCH_BACKENDS', () => {
  it('defaults to the standard order and reads a comma-separated order', () => {
    expect(parseRunEnv({}).webSearchBackends).toEqual(DEFAULT_WEB_SEARCH_BACKENDS);
    expect(parseRunEnv({ WEB_SEARCH_BACKENDS: '' }).webSearchBackends).toEqual(
      DEFAULT_WEB_SEARCH_BACKENDS,
    );
    expect(parseRunEnv({ WEB_SEARCH_BACKENDS: 'exa, tinyfish' }).webSearchBackends).toEqual([
      'exa',
      'tinyfish',
    ]);
  });

  it('rejects unknown backend names', () => {
    expect(() => parseRunEnv({ WEB_SEARCH_BACKENDS: 'exa,bing' })).toThrow();
  });

  it('rejects a backend named twice, which would be queried twice with separate cooldowns', () => {
    expect(() => parseRunEnv({ WEB_SEARCH_BACKENDS: 'exa,tinyfish,exa' })).toThrow(
      'Name each WEB_SEARCH_BACKENDS entry once',
    );
  });
});

describe('WEB_SEARCH', () => {
  it('enables keyless search by default and accepts only explicit boolean switches', () => {
    expect(parseRunEnv({}).webSearch).toBe(true);
    expect(parseRunEnv({ WEB_SEARCH: '' }).webSearch).toBe(true);
    expect(parseRunEnv({ WEB_SEARCH: 'true' }).webSearch).toBe(true);
    expect(parseRunEnv({ WEB_SEARCH: 'false' }).webSearch).toBe(false);

    for (const value of ['1', 'yes', 'FALSE']) {
      expect(() => parseRunEnv({ WEB_SEARCH: value })).toThrow();
    }
  });
});

describe('SUMMARY', () => {
  it('summarizes long histories by default, and "false" turns it off', () => {
    expect(parseRunEnv({}).summary).toBe(true);
    expect(parseRunEnv({ SUMMARY: '' }).summary).toBe(true);
    expect(parseRunEnv({ SUMMARY: 'true' }).summary).toBe(true);
    expect(parseRunEnv({ SUMMARY: 'false' }).summary).toBe(false);

    for (const value of ['0', 'no', 'FALSE']) {
      expect(() => parseRunEnv({ SUMMARY: value })).toThrow();
    }
  });
});

describe('CONTEXT_WINDOW', () => {
  it('is each model’s own unless set, and takes a positive whole number of tokens', () => {
    expect(parseRunEnv({}).contextWindow).toBeUndefined();
    expect(parseRunEnv({ CONTEXT_WINDOW: '' }).contextWindow).toBeUndefined();
    expect(parseRunEnv({ CONTEXT_WINDOW: '24000' }).contextWindow).toBe(24_000);

    for (const value of ['0', '-5', '1.5', 'big', '10000001', '1e3', '0x10', ' 5']) {
      expect(() => parseRunEnv({ CONTEXT_WINDOW: value })).toThrow();
    }
  });
});

describe('parseRequestEnv', () => {
  it("defaults to the backend's policy, and reads each setting from env", () => {
    expect(parseRequestEnv({})).toEqual(REQUEST);
    expect(
      parseRequestEnv({
        MODEL_RESPONSE_TIMEOUT_MS: '5000',
        MODEL_RETRIES: '0',
        MODEL_RETRY_DELAY_MS: '',
      }),
    ).toEqual({ responseTimeoutMs: 5000, retries: 0, retryDelayMs: REQUEST.retryDelayMs });
  });

  it('rejects a value that is not a whole number, and a timeout of zero', () => {
    expect(() => parseRequestEnv({ MODEL_RETRIES: 'two' })).toThrow();
    expect(() => parseRequestEnv({ MODEL_RETRIES: '1.5' })).toThrow();
    expect(() => parseRequestEnv({ MODEL_RETRIES: '11' })).toThrow(
      'Set MODEL_RETRIES to at most 10',
    );
    expect(() => parseRequestEnv({ MODEL_RESPONSE_TIMEOUT_MS: '0' })).toThrow();
  });
});
