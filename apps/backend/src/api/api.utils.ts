import { HTTPException } from 'hono/http-exception';
import { ConversationsError } from '@sheavly/host/errors/conversations.errors';
import { ApprovalRequestError } from '@sheavly/runtime/errors/approvals.errors';
import { SessionError } from '@sheavly/runtime/errors/sessions.errors';
import { API_ROUTES } from '@sheavly/protocol/api/api.constants';
import type { RouteName } from '@sheavly/protocol/api/api.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { SetupError } from '../errors/setup.errors.js';
import type { ApiFailure } from './api.types.js';

/** Each way a call on the live conversations fails, as the API answers it. */
const CONVERSATION_FAILURES: Record<ConversationsError['reason'], (message: string) => ApiFailure> =
  {
    not_found: (message) => ({ status: 404, code: 'not_found', message }),
    unknown_skill: (message) => ({ status: 422, code: 'unknown_skill', message }),
    unknown_model: (message) => ({ status: 422, code: 'unknown_model', message }),
    storage_failed: (message) => ({ status: 507, code: 'storage_failed', message }),
    // Not a server fault and not a bad request: the user has not set the backend up yet.
    not_set_up: (message) => ({ status: 409, code: 'not_set_up', message }),
    // The prompt cannot wait in the queue (skills picked as parts, too long, a full queue).
    cannot_queue: (message) => ({ status: 409, code: 'cannot_queue', message }),
  };

/**
 * Each way a setup call fails. What was sent is the caller's to fix (`bad_request`, not a plain
 * 400 of the body's shape: the body parsed, its meaning is what's wrong); a key where the backend
 * takes none is `forbidden`.
 */
const SETUP_FAILURES: Record<SetupError['reason'], (message: string) => ApiFailure> = {
  not_found: (message) => ({ status: 404, code: 'not_found', message }),
  invalid: (message) => ({ status: 422, code: 'bad_request', message }),
  forbidden: (message) => ({ status: 403, code: 'forbidden', message }),
};

/**
 * How the API answers `error`: the caller's mistakes by their protocol code, and anything else
 * as `internal`, without its message (it can hold paths or a provider's reply, never for a client).
 */
export function toApiFailure(error: unknown): ApiFailure {
  if (error instanceof HTTPException) {
    if (error.status === 401) {
      return { status: 401, code: 'unauthorized', message: 'A valid bearer token is required' };
    }

    // The request's host or origin is not one this server answers (`refusalOf`).
    if (error.status === 403) return { status: 403, code: 'forbidden', message: error.message };

    return { status: 400, code: 'bad_request', message: error.message };
  }

  if (error instanceof ConversationsError) {
    return CONVERSATION_FAILURES[error.reason](error.message);
  }

  if (error instanceof SetupError) return SETUP_FAILURES[error.reason](error.message);

  if (error instanceof SessionError && error.reason === 'session_running') {
    return { status: 409, code: 'session_running', message: error.message };
  }

  if (error instanceof SessionError && error.reason === 'session_ended') {
    return { status: 404, code: 'not_found', message: error.message };
  }

  // A decision the request did not offer is the caller's to fix and the approval still waits, so it
  // is not `unknown_approval`, which a UI forgives as "answered elsewhere".
  if (error instanceof ApprovalRequestError && error.reason === 'not_offered') {
    return { status: 400, code: 'bad_request', message: error.message };
  }

  if (error instanceof ApprovalRequestError) {
    return { status: 404, code: 'unknown_approval', message: error.message };
  }

  return { status: 500, code: 'internal', message: 'The server failed; see its log' };
}

/**
 * Whether a stream sends `entry`: after `lastEventId` (a client resuming, `Last-Event-ID` is the
 * last `seq` it got), and anything at all without one.
 */
export function isAfter(params: { entry: StreamEntry; lastEventId: number | undefined }): boolean {
  const { entry, lastEventId } = params;

  return lastEventId === undefined || entry.seq > lastEventId;
}

/** The `Last-Event-ID` header as an entry's `seq`, or undefined when absent or not a number. */
export function parseLastEventId(header: string | undefined): number | undefined {
  if (header === undefined || !/^\d+$/.test(header.trim())) return undefined;

  return Number(header.trim());
}

/**
 * Every route name of the contract, split by its `public` flag. A route is private unless the
 * contract says `public: true`, so a new route lands behind the bearer check without anyone
 * listing it here.
 */
export function routeNamesByAccess(): { publicNames: RouteName[]; privateNames: RouteName[] } {
  const names = Object.keys(API_ROUTES) as RouteName[];
  const isPublic = (name: RouteName) => 'public' in API_ROUTES[name];

  return {
    publicNames: names.filter((name) => isPublic(name)),
    privateNames: names.filter((name) => !isPublic(name)),
  };
}

/** An OpenAPI path (`/conversations/{id}`) as Hono writes it (`/conversations/:id`). */
export function honoPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ':$1');
}
