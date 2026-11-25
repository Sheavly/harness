import type { Context } from 'hono';
import type { Conversations } from '@sheavly/host/conversations/conversations.service';
import type { PublicRouteName, RouteBody, RouteName } from '@sheavly/protocol/api/api.types';
import type { InstanceId } from '@sheavly/protocol/handshake/handshake.types';
import type { ServerVersion } from '@sheavly/protocol/version/version.types';
import type { ConversationId, ServerErrorCode } from '@sheavly/protocol/server/server.types';
import type { BackendLogs } from '../logging/logging.types.js';
import type { PermissionSetup } from '../profiles/permission-setup.service.js';
import type { ProfileSetup } from '../profiles/setup.service.js';
import type { WorkspaceSetup } from '../profiles/workspace-setup.service.js';

/**
 * The host names and browser origins the server answers (`allowedRequests`). Host names are
 * canonical (lower case, no trailing dot, an IPv6 literal in brackets) and carry no port: a client
 * reaching the server through a forwarded port sends the port it forwards, not the server's.
 */
export type AllowedRequests = {
  hosts: ReadonlySet<string>;
  origins: ReadonlySet<string>;
};

/** What the backend's API serves: the live conversations, and the token every request carries. */
export type ApiOptions = {
  /** The live conversations, built the backend's way (`new Conversations({ create })`). */
  conversations: Conversations;
  /** The profiles, models and keys a setup UI changes (`Profiles.setup`). */
  setup: ProfileSetup;
  /** Which profile each folder runs on, and which folders are trusted (`Profiles.workspaces`). */
  workspaces: WorkspaceSetup;
  /** What `run_command` may do in each folder (`PermissionSetup`). */
  permissions: PermissionSetup;
  /**
   * Every request must carry it (`Authorization: Bearer <token>`), except to the routes the
   * contract marks `public`. Never logged.
   */
  token: string;
  /**
   * Which `Host` names and `Origin`s a request may carry, checked before every route, public ones
   * included. Unset: this machine's names only, and no origin.
   */
  allowed?: AllowedRequests;
  /** This server start's id (`newInstanceId`). Never returned by any route: it only salts the handshake proof. */
  instanceId: InstanceId;
  /** The backend's own version, as `GET /health` reports it (`readServerVersion`). */
  serverVersion: ServerVersion;
  /**
   * Where a failure the API answers as `internal` is logged, once, with its stack and cause chain
   * and the conversation's id when the route has one. The client is told none of it.
   */
  logs: BackendLogs;
};

/** A failure, as the API answers it: an HTTP status and one of the protocol's codes. */
export type ApiFailure = {
  status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 507;
  code: ServerErrorCode;
  message: string;
};

/** What one route's handler gets: the request, its conversation id, and its parsed body. */
export type HandlerArgs<N extends RouteName> = {
  c: Context;
  id: ConversationId;
  body: RouteBody<N>;
};

/**
 * Every route's handler, by its name in `API_ROUTES`: one call on `conversations` or `setup` and
 * its result as the route answers it. A route without a handler, or a handler for no route, is a
 * type error.
 */
export type ApiHandlers = {
  [N in RouteName]: (args: HandlerArgs<N>) => Response | Promise<Response>;
};

/** The routes of the setup API: the profiles, their models and keys, and what is available. */
export type SetupRouteName =
  | 'getSetup'
  | 'setTerminalSettings'
  | 'listAdapters'
  | 'listModelCatalog'
  | 'getProfile'
  | 'putProfile'
  | 'deleteProfile'
  | 'queryModels'
  | 'getModel'
  | 'putModel'
  | 'deleteModel'
  | 'putCredential'
  | 'deleteCredential'
  | 'checkCredential'
  | 'setDefaultProfile';

/** The routes on folders: which profile each runs on, and which are trusted. */
export type WorkspaceRouteName =
  | 'queryWorkspaceProfile'
  | 'bindWorkspace'
  | 'unbindWorkspace'
  | 'queryTrustedWorkspaces'
  | 'trustWorkspace'
  | 'revokeWorkspace';

/** The routes on what `run_command` may do in a folder: its mode and the commands allowed. */
export type PermissionRouteName =
  'queryPermissions' | 'setPermissionMode' | 'allowCommand' | 'revokeCommand';

/**
 * The routes on the live conversations: all but the setup's, the folders' and the public ones,
 * which `identityHandlers` serves without any of the user's data.
 */
export type ConversationRouteName = Exclude<
  RouteName,
  SetupRouteName | WorkspaceRouteName | PermissionRouteName | PublicRouteName
>;
