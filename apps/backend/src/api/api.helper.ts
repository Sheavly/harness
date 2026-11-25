import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';
import { API_ROUTES } from '@sheavly/protocol/api/api.constants';
import type { ApiRoute, RouteName } from '@sheavly/protocol/api/api.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { LOG_EVENT } from '../logging/logging.constants.js';
import type { BackendLogs } from '../logging/logging.types.js';
import { MAX_BODY_BYTES, PUBLIC_MAX_BODY_BYTES } from './api.constants.js';
import type { ApiHandlers, ApiOptions } from './api.types.js';
import { honoPath, routeNamesByAccess, toApiFailure } from './api.utils.js';
import { validJson } from './api.validator.js';
import { apiHandlers, idOf } from './handlers.helper.js';
import { identityHandlers } from './identity-handlers.helper.js';
import { permissionHandlers } from './permission-handlers.helper.js';
import { allowedRequests, refusalOf } from './request-origin.utils.js';
import { setupHandlers } from './setup-handlers.helper.js';
import { workspaceHandlers } from './workspace-handlers.helper.js';

/** One route's handler as the app calls it: the table types each one, the app passes it through. */
type AnyHandler = (args: {
  c: Context;
  id: unknown;
  body: unknown;
}) => Response | Promise<Response>;

/** Whether `header` carries `token`, compared in constant time so its length and content don't leak. */
function carriesToken(params: { header: string | undefined; token: string }): boolean {
  const { header, token } = params;
  const given = /^Bearer\s+(\S+)$/.exec(header ?? '')?.[1];

  if (given === undefined) return false;

  const digest = (value: string) => createHash('sha256').update(value).digest();

  return timingSafeEqual(digest(given), digest(token));
}

/** A cap on the request body, answered as a `bad_request` before anything reads it. */
function limitBody(maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: () => {
      throw new HTTPException(400, { message: `The body is over ${String(maxSize)} bytes` });
    },
  });
}

/**
 * Registers route `name` on `app`: its method and path from the table, its body parsed first. A
 * public route has no token check before it, so it gets its own small body cap, ahead of parsing.
 */
function addRoute(params: { app: Hono; name: RouteName; handlers: ApiHandlers }): void {
  const { app, name, handlers } = params;
  const route: ApiRoute = API_ROUTES[name];
  // The table and `ApiHandlers` agree by name; here every handler is called the same way.
  const handle = handlers[name] as AnyHandler;
  const limit: MiddlewareHandler[] = route.public ? [limitBody(PUBLIC_MAX_BODY_BYTES)] : [];
  const parse: MiddlewareHandler[] = route.body ? [validJson(route.body)] : [];

  app.on(route.method.toUpperCase(), [honoPath(route.path)], ...limit, ...parse, (c) =>
    handle({
      c,
      // Only the conversation routes have an `:id`; the others read their params themselves.
      id: c.req.param('id') === undefined ? undefined : idOf(c),
      body: route.body ? c.req.valid('json' as never) : undefined,
    }),
  );
}

/**
 * The backend's HTTP API: every route of `API_ROUTES` (method, path and body schema from the
 * contract, its handler from `apiHandlers` and `setupHandlers`), behind a bearer token except the
 * routes the contract marks `public`, with request bodies capped and every failure answered as a
 * `ServerError`. A request whose `Host` is not one of the server's names, or that carries an
 * `Origin` not listed, is refused with `forbidden` before any route, public ones included
 * (`options.allowed`). It turns requests into calls on `conversations` and `setup` and adds no
 * behaviour of its own. `serve.ts` decides how to listen and closes the conversations when it
 * stops. It logs no request, only a failure it answers as `internal` (`logs`): a future request
 * log must leave out the handshake's body.
 */
export function createApiApp(options: ApiOptions): Hono {
  const { conversations, setup, workspaces, permissions, token, instanceId, serverVersion, logs } =
    options;
  const handlers: ApiHandlers = {
    ...identityHandlers({ token, instanceId, serverVersion }),
    ...apiHandlers(conversations),
    ...setupHandlers(setup),
    ...workspaceHandlers(workspaces),
    ...permissionHandlers(permissions),
  };
  const app = new Hono();
  const allowed = options.allowed ?? allowedRequests();

  // First of all, before the public routes: a rebinding page reaches those as if they were its own
  // (it sends its own name as `Host`), so the check cannot sit behind the token. A refused request
  // is told only that it is refused, and nothing else (a route, a header, a name) reaches it.
  app.use(
    createMiddleware(async (c, next) => {
      const refusal = refusalOf({
        host: c.req.header('host'),
        url: c.req.url,
        origin: c.req.header('origin'),
        allowed,
      });

      if (refusal !== undefined) throw new HTTPException(403, { message: refusal });

      await next();
    }),
  );

  // Order matters, do not move the guard: Hono runs handlers in registration order and a public
  // route answers without calling `next`, so only a request no public route matches (a private
  // route, an unknown path, an OPTIONS preflight, the wrong method) reaches the guard and its 401.
  const { publicNames, privateNames } = routeNamesByAccess();

  for (const name of publicNames) addRoute({ app, name, handlers });

  app
    .use(
      createMiddleware(async (c, next) => {
        if (!carriesToken({ header: c.req.header('authorization'), token })) {
          throw new HTTPException(401);
        }

        await next();
      }),
    )
    .use(limitBody(MAX_BODY_BYTES));

  for (const name of privateNames) addRoute({ app, name, handlers });

  return app
    .notFound((c) => c.json({ error: { code: 'not_found', message: 'No such route' } }, 404))
    .onError((error, c) => {
      const { status, code, message } = toApiFailure(error);

      // The client is told nothing of an internal failure, so the log must be: without it a bad
      // file or a broken store is a bare 500 nobody can trace.
      if (code === 'internal') logInternalFailure({ c, error, status, logs });

      return c.json({ error: { code, message } }, status);
    });
}

/**
 * Logs a failure the client is told only as `internal`, once: to the conversation's log when the
 * route has a conversation id, else the server's. The entry has the error's stack and cause
 * chain, which the logger redacts, and the route's pattern, never the URL or the body.
 */
function logInternalFailure(params: {
  c: Context;
  error: Error;
  status: number;
  logs: BackendLogs;
}): void {
  const { c, error, status, logs } = params;
  const id = conversationIdSchema.safeParse(c.req.param('id'));
  const logger = id.success ? logs.conversation(id.data) : logs.server;

  logger.error(LOG_EVENT.API_REQUEST_FAILED, {
    error,
    route: `${c.req.method} ${routePath(c, -1)}`,
    status,
  });
}
