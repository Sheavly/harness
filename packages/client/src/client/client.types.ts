import type { z } from 'zod';
import type { API_ROUTES } from '@sheavly/protocol/api/api.constants';
import type { PublicRouteName, RouteName } from '@sheavly/protocol/api/api.types';

type RouteOf<N extends RouteName> = (typeof API_ROUTES)[N];

/** The `{param}`s in a route's path, as an object of strings. */
type PathParams<P extends string> = P extends `${string}{${infer Param}}${infer Rest}`
  ? Record<Param, string> & PathParams<Rest>
  : unknown;

/** A route's body, as its schema accepts it; none when it takes none. */
type BodyOf<R> = R extends { body: z.ZodType } ? { body: z.input<R['body']> } : unknown;

/** What a call to route `N` takes: its path params and its body, each only when it has any. */
export type CallParams<N extends RouteName> = PathParams<RouteOf<N>['path']> &
  BodyOf<RouteOf<N>> & {
    signal?: AbortSignal;
    /** The last entry's `seq` a client got: a stream resumes right after it. */
    lastEventId?: number;
  };

/** The routes that answer JSON, and what each answers. */
export type JsonRoute = {
  [N in RouteName]: RouteOf<N>['response'] extends { schema: z.ZodType } ? N : never;
}[RouteName];

/** The routes that answer nothing (`204`). */
export type EmptyRoute = {
  [N in RouteName]: RouteOf<N>['response'] extends { status: 204 } ? N : never;
}[RouteName];

/** The routes that stream server-sent events. */
export type StreamRoute = {
  [N in RouteName]: RouteOf<N>['response'] extends { stream: z.ZodType } ? N : never;
}[RouteName];

/** What each frame of stream route `N` holds, parsed with the route's schema. */
export type ItemOf<N extends StreamRoute> = RouteOf<N>['response'] extends { stream: infer S }
  ? S extends z.ZodType
    ? z.output<S>
    : never
  : never;

/**
 * One frame of a server-sent event stream, as its lines said: the event name, the `id:` line
 * (`cursor`: a position in the stream, not an id of any kind) and the `data`, each absent when the
 * frame has no such line. A comment (a heartbeat) is no frame.
 */
export type SseFrame = {
  event: string | undefined;
  cursor: string | undefined;
  data: string | undefined;
};

/**
 * What a reconnecting stream has delivered so far, how many attempts in a row have failed since,
 * and when (by `performance.now()`) the first of them did.
 */
export type ReconnectProgress = {
  lastEventId: number | undefined;
  failures: number;
  failingSince: number | undefined;
};

/** What JSON route `N` answers, parsed with its schema (brands and all). */
export type AnswerOf<N extends JsonRoute> = RouteOf<N>['response'] extends { schema: infer S }
  ? S extends z.ZodType
    ? z.output<S>
    : never
  : never;

/** How a stream reconnects after a drop; the defaults are `reconnect.constants.ts`. */
export type ReconnectPolicy = {
  /** How many attempts in a row, without an entry arriving, before the stream is lost; none: only the budget. */
  attempts?: number;
  /** How long attempts in a row may fail before the stream is lost (`RECONNECT_BUDGET_MS` unless set). */
  budgetMs?: number;
  /** Replaces the wait between attempts, for a test that must not sleep. */
  wait?: (params: { ms: number; signal: AbortSignal }) => Promise<void>;
};

/** Where a client with no token reaches a backend, and how. */
export type PublicClientOptions = {
  url: string;
  /** Reaches the backend (the global `fetch` when unset): a test's fake, a proxy. */
  fetch?: typeof fetch;
};

/** Where a client reaches a backend, and how. */
export type ClientOptions = PublicClientOptions & {
  /** Sent as `Authorization: Bearer <token>` on every private route; never in a URL. */
  token: string;
  /** How the streams this client's helpers follow reconnect. */
  reconnect?: ReconnectPolicy;
};

/** The routes a client with no token may call: those the contract marks `public`, and answer JSON. */
export type PublicJsonRoute = Extract<PublicRouteName, JsonRoute>;
