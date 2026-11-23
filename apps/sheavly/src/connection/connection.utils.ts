import type { ChatServer } from '../chat/chat.types.js';
import { ConnectionError } from '../errors/cli.errors.js';
import type { Connection } from './connection.types.js';

/**
 * A connection as one line of JSON ending in a newline, its fields in a fixed order. Only a
 * `discovery` connection has the versions: an `environment` one was never asked for them.
 */
export function renderConnection(connection: Connection): string {
  const { source, url, token } = connection;
  const fields =
    connection.source === 'discovery'
      ? {
          source,
          url,
          token,
          protocolVersion: connection.protocolVersion,
          serverVersion: connection.serverVersion,
        }
      : { source, url, token };

  return `${JSON.stringify(fields)}\n`;
}

/**
 * The server `BACKEND_URL` and `BACKEND_TOKEN` name, as given, or `undefined` when `BACKEND_URL`
 * is not set (empty counts as not set, as for `chat`; `BACKEND_TOKEN` alone is ignored). Throws a
 * `ConnectionError` for a `BACKEND_URL` that is not a plain http or https URL (no login in it) or
 * has no `BACKEND_TOKEN` to go with it: the message names the variable and never repeats a value.
 */
export function environmentConnection(env: NodeJS.ProcessEnv): ChatServer | undefined {
  const url = env.BACKEND_URL;

  if (url === undefined || url === '') return undefined;

  if (!isWebUrl(url)) {
    throw new ConnectionError(
      'BACKEND_URL is not a plain http or https URL (written out in full, with no login in it): fix it, or unset it.',
    );
  }

  const token = env.BACKEND_TOKEN;

  if (token === undefined || token === '') {
    throw new ConnectionError(
      'BACKEND_URL is set but BACKEND_TOKEN is not: set both, or unset BACKEND_URL to use the running server.',
    );
  }

  return { url, token };
}

/**
 * Whether `value` is an `http` or `https` URL written out in full (`http://host…`), as one word.
 * What is printed must mean the same to every reader: `URL` strips leading and trailing space and
 * drops tabs and line breaks inside, reads `http:host` as a host, and takes a backslash as a
 * slash, while other parsers do not; an invisible format character (a zero-width or bidi one)
 * hides what a person sees on a terminal. A login in the address (`http://127.0.0.1@evil.example`)
 * is refused for the same reason: a person reads the first host and a client connects to the
 * second, and the token is about to be sent there.
 */
function isWebUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /[\s\p{Cc}\p{Cf}\\]/u.test(value)) return false;

  // The authority is what lies between `//` and the first `/`, `?` or `#`: an `@` in it, empty
  // login or not, is a login. One in the path or the query is only text.
  const authority = value.slice(value.indexOf('//') + 2).split(/[/?#]/, 1)[0] ?? '';

  return !authority.includes('@') && URL.canParse(value);
}
