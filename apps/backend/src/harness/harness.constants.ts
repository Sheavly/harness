// What the backend picks for a run. The packages have no defaults of their own: the backend says
// how a model call is sent. Which model it uses is the user's, in their profile. A run has no
// turn limit unless `MAX_TURNS` sets one.

/**
 * How a model call is sent, unless the environment says otherwise: wait a minute for the response
 * to start (a reply then streams for as long as it takes), and retry twice before anything
 * streamed, 1s then 2s apart. A provider that stalls costs a minute, not Node's five. A call
 * that cannot reach its provider because this machine has no connection waits for it for up to an
 * hour of time awake (a sleeping computer's time does not count); `MODEL_OFFLINE_TIMEOUT_MS=0`
 * switches that off. `probeUrls`, unless `MODEL_PROBE_URLS` names others, are what such a call asks
 * to tell a lost connection from a provider that is down: any answer from one of them means the
 * internet is up. Neither is a model provider, and each is asked only after a call failed.
 */
export const REQUEST = {
  responseTimeoutMs: 60_000,
  retries: 2,
  retryDelayMs: 1000,
  offlineTimeoutMs: 3_600_000,
  probeUrls: ['https://www.gstatic.com/generate_204', 'https://1.1.1.1'],
};

/**
 * Where `npm run serve` listens when the environment says nothing: this machine only (the server
 * runs commands for whoever reaches it), on a port unlikely to be taken.
 */
export const SERVER = { host: '127.0.0.1', port: 4310 } as const;

/**
 * The arguments the server reads from its command line (`--trust`: trust the workspace's
 * `.sheavly/`); its other settings are environment variables. Anything else is refused.
 */
export const SERVER_ARGUMENTS: readonly string[] = ['--trust'];

/** The search backends `WEB_SEARCH_BACKENDS` can name, all usable without an API key. */
export const WEB_SEARCH_BACKEND_NAMES = [
  'tavily',
  'tinyfish',
  'exa',
  'parallel',
  'firecrawl',
  'wikipedia',
] as const;

/**
 * The order search backends are tried in unless `WEB_SEARCH_BACKENDS` says otherwise. Firecrawl is
 * left out because its keyless replies are large; Wikipedia comes last as it only covers itself.
 */
export const DEFAULT_WEB_SEARCH_BACKENDS = [
  'tavily',
  'tinyfish',
  'exa',
  'parallel',
  'wikipedia',
] as const;

/**
 * The most retries a policy allows (`requestPolicySchema`), so a bad `MODEL_RETRIES` is named
 * here rather than failing later as an invalid adapter config.
 */
export const MAX_RETRIES = 10;
