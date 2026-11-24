import { API_ROUTES, LAST_EVENT_ID_HEADER } from '@sheavly/protocol/api/api.constants';
import type { RouteName } from '@sheavly/protocol/api/api.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import {
  AnswerError,
  AnswerTooLargeError,
  RedirectedError,
  RefusedError,
} from '../errors/client.errors.js';
import { readBoundedText } from './bounded-body.helper.js';
import type {
  AnswerOf,
  CallParams,
  ClientOptions,
  EmptyRoute,
  JsonRoute,
  PublicClientOptions,
  PublicJsonRoute,
  StreamRoute,
} from './client.types.js';
import { parseServerError } from './client.validator.js';
import { readEntries } from './entries.helper.js';
import { PUBLIC_ANSWER_MAX_BYTES } from './public-answer.constants.js';
import { REFUSAL_MAX_BYTES } from './refusal.constants.js';

/**
 * A client for a harness backend, built from the API's routes (`API_ROUTES`): one call per route,
 * its path params and body typed from the contract's schemas, and every JSON answer parsed with
 * the route's own schema, so ids keep their brands and a backend that drifted from the contract
 * fails loudly. A refused request throws `RefusedError` with the backend's code.
 */
export function createClient(options: ClientOptions) {
  const send = (params: { name: RouteName; call: Record<string, unknown> }) =>
    request({ options, ...params });

  return {
    /** How the streams followed through this client reconnect (`ClientOptions.reconnect`). */
    reconnect: options.reconnect ?? {},
    /** Calls a route that answers JSON, and returns its answer, parsed. */
    call<N extends JsonRoute>(name: N, call: CallParams<N>): Promise<AnswerOf<N>> {
      return callJson({ options, name, call });
    },
    /** Calls a route that answers nothing (`204`). */
    async send<N extends EmptyRoute>(name: N, call: CallParams<N>): Promise<void> {
      await send({ name, call });
    },
    /**
     * Opens a route's server-sent event stream: its body, raw, for a UI to save or read. The
     * caller ends it: read it to its end, cancel it, or pass a `signal` that aborts. A stream
     * dropped with none of these stays open until the server ends it.
     */
    async open<N extends StreamRoute>(
      name: N,
      call: CallParams<N>,
    ): Promise<ReadableStream<Uint8Array>> {
      const response = await send({ name, call });

      if (!response.body) throw new AnswerError({ route: name, cause: 'no body' });

      // Only the body leaves this function, and the caller may not read it for a while (a prompt
      // opens its stream, sends, and reads after). Node's fetch cancels the body of a response that
      // is collected while it is still unread and unlocked, which ends the stream with nothing
      // wrong on the wire: the reader sees a clean end and misses what the server sent. Piping it
      // locks the original body now; the pipe moves only as fast as the caller reads.
      return response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>());
    },
    /** A route's stream as entries, each parsed with the protocol's schema, to its end. */
    async *stream<N extends StreamRoute>(
      name: N,
      call: CallParams<N>,
    ): AsyncGenerator<StreamEntry> {
      for await (const { entry } of readEntries((await send({ name, call })).body)) yield entry;
    },
  };
}

/**
 * A client with no token, for the routes the contract marks `public` (health and the handshake):
 * it holds no token, so it can never send one. A private route name is a type error, and a
 * caller that gets past the types is refused at run time.
 */
export function createPublicClient(options: PublicClientOptions) {
  // Only the two fields are kept, so a token smuggled into `options` is dropped, not sent.
  const connection: PublicClientOptions = {
    url: options.url,
    ...(options.fetch && { fetch: options.fetch }),
  };

  return {
    /** Calls a public route that answers JSON, and returns its answer, parsed. */
    call<N extends PublicJsonRoute>(name: N, call: CallParams<N>): Promise<AnswerOf<N>> {
      if (!('public' in API_ROUTES[name])) {
        return Promise.reject(new TypeError(`${name} is not a public route`));
      }

      return callJson({ options: connection, name, call });
    },
  };
}

/** One call to a JSON route: the request, and its answer parsed with the route's schema. */
async function callJson<N extends JsonRoute>(params: {
  options: PublicClientOptions & { token?: string };
  name: N;
  call: CallParams<N>;
}): Promise<AnswerOf<N>> {
  const { options, name, call } = params;
  const response = await request({ options, name, call });
  const parsed = API_ROUTES[name].response.schema.safeParse(await readAnswer({ response, name }));

  if (!parsed.success) throw new AnswerError({ route: name, cause: parsed.error });

  return parsed.data as AnswerOf<N>;
}

/**
 * A JSON route's answer, parsed from text. A public route's answer is read through a bound: its
 * sender may be anything that listens on the address, so it is not buffered without limit.
 * A private route's answer comes from a server the caller already trusts with its token.
 */
async function readAnswer(params: { response: Response; name: JsonRoute }): Promise<unknown> {
  const { response, name } = params;

  if (!isPublic(name)) return response.json();

  return JSON.parse(
    await readBoundedText({ response, route: name, maxBytes: PUBLIC_ANSWER_MAX_BYTES }),
  );
}

function isPublic(name: RouteName): boolean {
  return 'public' in API_ROUTES[name];
}

/**
 * Fetches `url` for route `name`. A public route is never redirected: whatever answers the
 * address is the one asked, so a redirect to another host is `RedirectedError`, not an answer
 * about that host. A private route keeps `fetch`'s default (undici drops `Authorization` when a
 * redirect leaves the origin).
 */
async function fetchRoute(params: {
  options: PublicClientOptions;
  name: RouteName;
  url: URL;
  init: RequestInit;
}): Promise<Response> {
  const { options, name, url, init } = params;

  if (!isPublic(name)) return (options.fetch ?? fetch)(url, init);

  // `manual` hands the redirect answer back instead of failing, so it is recognised by what it
  // is, not by how a particular fetch words its error.
  const response = await (options.fetch ?? fetch)(url, { ...init, redirect: 'manual' });

  if (!isRedirect(response)) return response;

  // Discarded unread: whatever redirects is not asked for a body.
  await response.body?.cancel();

  throw new RedirectedError({ route: name });
}

/** A redirect as Node's fetch (a 3xx answer) or a browser's (`opaqueredirect`) reports it. */
function isRedirect(response: Response): boolean {
  return (
    response.type === 'opaqueredirect' ||
    response.redirected ||
    (response.status >= 300 && response.status <= 399)
  );
}

/**
 * One request to route `name`: its path filled in, its body as JSON, and the token as a header on
 * a private route only. A public route never gets it, so it can't reach a server that has not
 * proved it holds the token.
 */
async function request(params: {
  options: PublicClientOptions & { token?: string };
  name: RouteName;
  call: Record<string, unknown>;
}): Promise<Response> {
  const { options, name, call } = params;
  const route = API_ROUTES[name];
  const path = route.path.replace(/\{(\w+)\}/g, (_match, param: string) =>
    encodeURIComponent(String(call[param])),
  );
  const { signal, lastEventId, body } = call as {
    signal?: AbortSignal;
    lastEventId?: number;
    body?: unknown;
  };
  const response = await fetchRoute({
    options,
    name,
    url: new URL(path, options.url),
    init: {
      method: route.method.toUpperCase(),
      headers: {
        ...(!isPublic(name) && { authorization: `Bearer ${tokenFor(options)}` }),
        ...('body' in route && { 'content-type': 'application/json' }),
        ...(lastEventId !== undefined && { [LAST_EVENT_ID_HEADER]: String(lastEventId) }),
      },
      ...('body' in route && { body: JSON.stringify(body ?? {}) }),
      ...(signal && { signal }),
    },
  });

  if (response.ok) return response;

  const refused = parseServerError(await readRefusal({ response, name }));

  throw new RefusedError({
    status: response.status,
    code: refused?.error.code,
    message: refused?.error.message ?? `The backend answered ${String(response.status)}`,
  });
}

/**
 * The text of a refusal. A public route's is bounded like its answers and too much is an error; a
 * private route's is bounded too, but too much reads as no text, so the refusal keeps its status
 * and a fixed message instead of failing on what a hostile server sent.
 */
async function readRefusal(params: { response: Response; name: RouteName }): Promise<string> {
  const { response, name } = params;

  if (isPublic(name)) {
    return readBoundedText({ response, route: name, maxBytes: PUBLIC_ANSWER_MAX_BYTES });
  }

  try {
    return await readBoundedText({ response, route: name, maxBytes: REFUSAL_MAX_BYTES });
  } catch (caughtError) {
    // Only the bound is expected here; a body that fails to stream is not hidden.
    if (caughtError instanceof AnswerTooLargeError) return '';

    throw caughtError;
  }
}

/** The token a private route needs; a client with none can't call one. */
function tokenFor(options: { token?: string }): string {
  if (options.token === undefined) throw new TypeError('A private route needs a token');

  return options.token;
}
