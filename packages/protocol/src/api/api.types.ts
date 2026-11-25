import type { z } from 'zod';
import type { API_ROUTES } from './api.constants.js';

/** Every route of the API, by its name in `API_ROUTES`. */
export type RouteName = keyof typeof API_ROUTES;

/** A route's body as its schema parsed it; `never` for a route that takes none. */
export type RouteBody<N extends RouteName> = (typeof API_ROUTES)[N] extends { body: z.ZodType }
  ? z.output<(typeof API_ROUTES)[N]['body']>
  : never;

/**
 * What a route answers on success: JSON in `schema`, nothing (`204`), or a server-sent event
 * stream whose every frame's data is one `stream` value. A stream that a client resumes with the
 * `Last-Event-ID` header (each frame has an `id`) says so with `resumesWithLastEventId`; one whose
 * frames carry no `id` is resumed by what its request body says.
 */
export type ApiResponse =
  | { status: 200 | 201; schema: z.ZodType }
  | { status: 204 }
  | { status: 200; stream: z.ZodType; resumesWithLastEventId?: true };

/**
 * How a route's method follows from what it does, so no client or proxy guesses wrong: a read is
 * safe to retry, a change isn't. A read without input is `get`; a read with input is `query`,
 * its input a typed body (RFC 10008), never a query string or a `post`; a change is `post`,
 * `put` (setting a value: twice is once) or `delete`.
 */
type ApiEffect =
  | { effect: 'read'; method: 'get'; body?: never }
  | { effect: 'read'; method: 'query'; body: z.ZodType }
  | { effect: 'change'; method: 'post' | 'put' | 'delete'; body?: z.ZodType };

/**
 * One route of the harness's HTTP API: what a server implements and a client calls. `path` uses
 * OpenAPI's `{param}` form; its params are strings. A route needs the bearer token unless it is
 * `public`, and fails with a `ServerError` body.
 */
export type ApiRoute = ApiEffect & {
  path: string;
  summary: string;
  response: ApiResponse;
  /**
   * Absent: the route needs the bearer token. `true`: it answers without one. Only a route that
   * identifies the server may be public, and a public route has no path parameters.
   */
  public?: true;
};

/** The routes that answer without a token: those whose `public` is `true`. */
export type PublicRouteName = {
  [N in RouteName]: (typeof API_ROUTES)[N] extends { public: true } ? N : never;
}[RouteName];

/** The API as an OpenAPI 3.2 document: the routes, and the contract's schemas as components. */
export type OpenApiDocument = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, z.core.JSONSchema.BaseSchema>;
    securitySchemes: Record<string, unknown>;
  };
  security: Record<string, string[]>[];
};
