import { createSecureContext } from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';
import { ModelFetchError } from '../errors/providers.errors.js';
import { MODEL_TLS_GROUPS, UNKNOWN_TLS_GROUP_CODE } from './http.constants.js';

/**
 * `groups` when this process's OpenSSL knows every one of them, otherwise undefined, so the
 * caller keeps OpenSSL's default. OpenSSL before 3.5 (Node 24.0 to 24.4, or a system OpenSSL 3.0)
 * has no ML-KEM and refuses a list that names it; its default sends no ML-KEM share, so its
 * ClientHello fits in one segment anyway. Any other failure is thrown.
 */
export function offeredTlsGroups(groups: string): string | undefined {
  try {
    createSecureContext({ ecdhCurve: groups });
  } catch (caughtError) {
    // Only the refusal of the list itself means "unknown group"; anything else is a real fault.
    if ((caughtError as { code?: unknown }).code !== UNKNOWN_TLS_GROUP_CODE) throw caughtError;

    return undefined;
  }

  return groups;
}

/** A global `Request` input or `FormData` body, which undici's own `fetch` doesn't recognise. */
function refusedInput(params: {
  input: Parameters<typeof fetch>[0];
  init: RequestInit | undefined;
}) {
  const { input, init } = params;

  if (input instanceof Request) {
    return new ModelFetchError({
      reason: 'request_input',
      message: 'The model fetch takes a URL or a string, not a Request: pass its URL and init.',
    });
  }

  if (init?.body instanceof FormData) {
    return new ModelFetchError({
      reason: 'form_data_body',
      message: 'The model fetch takes a string or byte body, not FormData.',
    });
  }

  return undefined;
}

/**
 * The `fetch` model calls are sent with: undici's `fetch` over a connection pool that offers
 * `MODEL_TLS_GROUPS` (where OpenSSL knows them, see `offeredTlsGroups`), so the TLS ClientHello
 * fits in one TCP segment and endpoints that can't reassemble a split one still answer. HTTP/1.1
 * only, as Node 24's own `fetch` sends: undici 8 would offer HTTP/2 too. Each call makes its own
 * pool, held for as long as the returned function is. It takes a URL or string and a string or
 * byte body, as `sendRequest` sends; a `Request` or `FormData` rejects with a `ModelFetchError`.
 */
export function createModelFetch(): typeof fetch {
  const ecdhCurve = offeredTlsGroups(MODEL_TLS_GROUPS);
  const dispatcher = new Agent({
    allowH2: false,
    ...(ecdhCurve !== undefined && { connect: { ecdhCurve } }),
  });
  // undici's own fetch, never Node's global one: a dispatcher from the undici package is rejected
  // (UND_ERR_INVALID_ARG) by the copy bundled in Node whenever the two versions differ. The cast
  // is that same split in the types: the global `RequestInit` names the bundled `Dispatcher`.
  const send = undiciFetch as unknown as (
    input: Parameters<typeof fetch>[0],
    init: Omit<RequestInit, 'dispatcher'> & { dispatcher: Agent },
  ) => Promise<Response>;

  return async (input, init) => {
    const refused = refusedInput({ input, init });

    if (refused) throw refused;

    return send(input, { ...init, dispatcher });
  };
}
