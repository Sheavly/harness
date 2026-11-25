import { z } from 'zod';
import { contextWindowSchema } from '@sheavly/protocol/model/model.validator';
import { isHostName } from '../api/request-origin.utils.js';
import { UnknownArgumentError } from '../errors/arguments.errors.js';
import {
  DEFAULT_WEB_SEARCH_BACKENDS,
  MAX_RETRIES,
  REQUEST,
  SERVER,
  SERVER_ARGUMENTS,
  WEB_SEARCH_BACKEND_NAMES,
} from './harness.constants.js';

/** An empty setting (`SERVER_HOST=`) means "not set". */
const optionalSetting = z
  .string()
  .optional()
  .transform((value) => (value === '' ? undefined : value));

/**
 * A comma-separated setting as a list: blanks around an entry and empty entries are dropped, and
 * every entry must satisfy `valid`, or the setting is refused with `message`. Unset is empty.
 */
const list = (params: { message: string; valid: (entry: string) => boolean }) =>
  optionalSetting
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    )
    .pipe(z.array(z.string().refine(params.valid, { error: params.message })));

/** A whole number of milliseconds or retries from env, or the default when it is unset. */
const count = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : Number(value)))
    .pipe(z.number().int().min(0));

/**
 * Whether `entry` is an http or https address a probe can ask, with no user name or password in
 * it (the provider's `requestPolicySchema` refuses the same).
 */
function isProbeUrl(entry: string): boolean {
  if (!URL.canParse(entry)) return false;

  const { protocol, username, password } = new URL(entry);

  return ['http:', 'https:'].includes(protocol) && username === '' && password === '';
}

/**
 * Whether `entry` is an origin and nothing more: `scheme://host`, with a port only when it is not
 * the scheme's own. No path, no user name, no trailing slash: that is how a browser sends one. No
 * `*` (an origin is listed whole, there are no wildcards) and no trailing dot on the host (a
 * browser never sends one), which would never match.
 */
const isOrigin = (entry: string): boolean =>
  URL.canParse(entry) &&
  ['http:', 'https:'].includes(new URL(entry).protocol) &&
  new URL(entry).origin === entry &&
  !entry.includes('*') &&
  !new URL(entry).hostname.endsWith('.');

/**
 * How the backend sends a model call: `MODEL_RESPONSE_TIMEOUT_MS`, `MODEL_RETRIES`,
 * `MODEL_RETRY_DELAY_MS` and `MODEL_OFFLINE_TIMEOUT_MS` (how long to wait for a lost connection,
 * 0 for never), each defaulting to `REQUEST`, and `MODEL_PROBE_URLS` (comma-separated addresses
 * that tell a lost connection from a provider that is down), defaulting to `REQUEST.probeUrls`.
 */
const requestEnvSchema = z.object({
  MODEL_RESPONSE_TIMEOUT_MS: count(REQUEST.responseTimeoutMs).pipe(z.number().positive()),
  MODEL_RETRIES: count(REQUEST.retries).pipe(
    z.number().max(MAX_RETRIES, `Set MODEL_RETRIES to at most ${String(MAX_RETRIES)}`),
  ),
  MODEL_RETRY_DELAY_MS: count(REQUEST.retryDelayMs),
  MODEL_OFFLINE_TIMEOUT_MS: count(REQUEST.offlineTimeoutMs),
  MODEL_PROBE_URLS: list({
    message:
      'Give each MODEL_PROBE_URLS entry as an http or https address, such as https://1.1.1.1',
    valid: isProbeUrl,
  }).pipe(
    // The provider's `requestPolicySchema` holds the same limit: every failed call asks them all.
    z.array(z.string()).max(5, 'Give at most 5 addresses in MODEL_PROBE_URLS'),
  ),
});

/** The request policy from `env`. */
export function parseRequestEnv(env: Record<string, string | undefined>) {
  const parsed = requestEnvSchema.parse(env);

  return {
    responseTimeoutMs: parsed.MODEL_RESPONSE_TIMEOUT_MS,
    retries: parsed.MODEL_RETRIES,
    retryDelayMs: parsed.MODEL_RETRY_DELAY_MS,
    offlineTimeoutMs: parsed.MODEL_OFFLINE_TIMEOUT_MS,
    // A copy: a caller that changes the list must not change the default for the next call.
    probeUrls:
      parsed.MODEL_PROBE_URLS.length > 0 ? parsed.MODEL_PROBE_URLS : [...REQUEST.probeUrls],
  };
}

/**
 * What `npm run serve` reads from the environment: where to listen and the token every request
 * must carry. It listens on 127.0.0.1 unless `SERVER_HOST` says otherwise (the server runs
 * commands for whoever reaches it), and generates a token when `SERVER_TOKEN` is unset.
 * `SERVER_PORT=0` picks a free port, as a UI that starts its own backend asks for.
 */
const serverEnvSchema = z.object({
  SERVER_HOST: optionalSetting.pipe(z.string().min(1).default(SERVER.host)),
  SERVER_PORT: count(SERVER.port).pipe(z.number().max(65_535)),
  SERVER_TOKEN: optionalSetting.pipe(
    z.string().min(32, 'Set SERVER_TOKEN to at least 32 characters, or leave it unset').optional(),
  ),
  /**
   * Only the exact string "true" lets the setup routes that hand out access (a model's key, a
   * workspace's trust) work over a network (put TLS in front).
   */
  SERVER_ALLOW_REMOTE_SETUP: optionalSetting,
  /** On unless "false": whether an always-on server takes the lock and writes its discovery file. */
  SERVER_DISCOVERY: optionalSetting.pipe(z.enum(['true', 'false']).default('true')),
  /**
   * The host names a remote server is reached by, besides this machine's and the one it is bound
   * to: comma-separated, each a name only (no scheme, port or path), such as `myhost.example`.
   */
  SERVER_ALLOWED_HOSTS: list({
    message:
      'Name each SERVER_ALLOWED_HOSTS entry as a host name only, with no scheme, port or path, such as myhost.example',
    valid: isHostName,
  }),
  /**
   * The web pages that may call the server: comma-separated, each an origin (`https://app.example`,
   * with a port when it is not the scheme's own, and no path). None by default.
   */
  SERVER_ALLOWED_ORIGINS: list({
    message:
      'Give each SERVER_ALLOWED_ORIGINS entry as an origin, such as https://app.example or http://localhost:5173, with no path',
    valid: isOrigin,
  }),
});

/**
 * Whether `host` (a bind address) only this machine can reach: `localhost`, `::1` or any
 * `127.x.x.x`. `0.0.0.0` and `::` listen on every interface, so they are not.
 */
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** The server settings from `env`. */
export function parseServerEnv(env: Record<string, string | undefined>) {
  const parsed = serverEnvSchema.parse(env);

  return {
    host: parsed.SERVER_HOST,
    port: parsed.SERVER_PORT,
    /** True when `SERVER_PORT` is unset or empty: the port was not asked for, so it may move. */
    portIsDefault: optionalSetting.parse(env.SERVER_PORT) === undefined,
    token: parsed.SERVER_TOKEN,
    /** The host names, besides this machine's and the bound one, a request may carry (`SERVER_ALLOWED_HOSTS`). */
    allowedHosts: parsed.SERVER_ALLOWED_HOSTS,
    /** The web origins that may call the server (`SERVER_ALLOWED_ORIGINS`); none by default. */
    allowedOrigins: parsed.SERVER_ALLOWED_ORIGINS,
    discovery: parsed.SERVER_DISCOVERY === 'true',
    /**
     * Whether the setup routes that hand out access (a model's key, a workspace's trust) may work:
     * on this machine, or opted into for a remote one.
     */
    remoteSetupAllowed:
      isLoopbackHost(parsed.SERVER_HOST) || parsed.SERVER_ALLOW_REMOTE_SETUP === 'true',
  };
}

/**
 * How the backend runs each conversation, from its environment: `MAX_TURNS` (no limit unless
 * set), `MODEL_CALLS_FILE` (each model call's full request appended there, one JSON line each),
 * `SERVER_EXIT_WITH_PARENT` (stop when stdin closes: the UI that started it is gone),
 * `SUMMARY` (summarize a long history when the context nears the window; on unless "false") and
 * `CONTEXT_WINDOW` (the window every model is told it has, instead of its file's: for a check
 * that must reach the summary trigger without a long run; unset means each model's own).
 */
const runEnvSchema = z.object({
  MAX_TURNS: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : Number(value)))
    .pipe(z.number().int().min(1).optional()),
  MODEL_CALLS_FILE: optionalSetting,
  SERVER_EXIT_WITH_PARENT: optionalSetting,
  WEB_FETCH: optionalSetting.pipe(z.enum(['true', 'false']).default('true')),
  WEB_SEARCH: optionalSetting.pipe(z.enum(['true', 'false']).default('true')),
  /** Comma-separated search backends in the order they are tried, e.g. `exa,tinyfish`. */
  WEB_SEARCH_BACKENDS: optionalSetting
    .transform((value) => value?.split(',').map((name) => name.trim()))
    .pipe(
      z
        .array(z.enum(WEB_SEARCH_BACKEND_NAMES))
        .min(1)
        .refine((names) => new Set(names).size === names.length, {
          error: 'Name each WEB_SEARCH_BACKENDS entry once',
        })
        .default([...DEFAULT_WEB_SEARCH_BACKENDS]),
    ),
  SUMMARY: optionalSetting.pipe(z.enum(['true', 'false']).default('true')),
  // Plain digits only: `Number()` would also take `1e3` and `0x10`, which a prompt's front matter
  // (the other way to set it) does not.
  CONTEXT_WINDOW: z
    .string()
    .regex(/^\d+$/, 'Set CONTEXT_WINDOW to a whole number of tokens, such as 40000')
    .or(z.literal(''))
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : Number(value)))
    .pipe(contextWindowSchema.optional()),
});

/** The run settings from `env`. Only the exact string "true" turns a switch on. */
export function parseRunEnv(env: Record<string, string | undefined>) {
  const parsed = runEnvSchema.parse(env);

  return {
    maxTurns: parsed.MAX_TURNS,
    modelCallsFile: parsed.MODEL_CALLS_FILE,
    exitWithParent: parsed.SERVER_EXIT_WITH_PARENT === 'true',
    webFetch: parsed.WEB_FETCH === 'true',
    webSearch: parsed.WEB_SEARCH === 'true',
    webSearchBackends: parsed.WEB_SEARCH_BACKENDS,
    summary: parsed.SUMMARY === 'true',
    contextWindow: parsed.CONTEXT_WINDOW,
  };
}

/**
 * What the backend reads from its command line and environment: `--trust`, and the settings that
 * shape a run. Throws `UnknownArgumentError` for an argument outside `SERVER_ARGUMENTS`.
 */
export function parseCliSettings(params: {
  env: Record<string, string | undefined>;
  args: readonly string[];
}) {
  const { env, args } = params;
  const unknown = args.find((arg) => !SERVER_ARGUMENTS.includes(arg));

  if (unknown !== undefined) {
    throw new UnknownArgumentError({ argument: unknown, known: SERVER_ARGUMENTS });
  }

  return {
    /** `--trust`: trust this workspace's `.sheavly/` hooks (remembered until `.sheavly/` changes). */
    trustWorkspace: args.includes('--trust'),
    workspaceRoot: optionalSetting.pipe(z.string().min(1).optional()).parse(env.WORKSPACE_ROOT),
    /** Only the exact string "true" turns these on. */
    showModelCalls: env.SHOW_MODEL_CALLS === 'true',
  };
}
