import { BRACKETED_HOST, WILDCARD_HOSTS } from '../discovery/discovery.constants.js';
import {
  HOST_HEADER,
  HOST_NAME,
  LOOPBACK_HOST_NAMES,
  REFUSED_HOST_MESSAGE,
  REFUSED_ORIGIN_MESSAGE,
} from './api.constants.js';
import type { AllowedRequests } from './api.types.js';

/**
 * Whether `value` is one host name or IP literal, with no scheme, port or path, written the way a
 * client's URL writes it: `10.1` becomes `10.0.0.1` there and would never match, so it is no name
 * to list.
 */
export function isHostName(value: string): boolean {
  if (!HOST_NAME.test(value) || !URL.canParse(`http://${value}`)) return false;

  return canonicalHostName(new URL(`http://${value}`).hostname) === canonicalHostName(value);
}

/**
 * The one spelling a host name is compared in: lower case, no trailing dot, and an IPv6 literal in
 * brackets, since that is how a `Host` header and a URL write it.
 */
export function canonicalHostName(name: string): string {
  const lower = name.toLowerCase().replace(/\.$/, '');

  return lower.includes(':') && !BRACKETED_HOST.test(lower) ? `[${lower}]` : lower;
}

/** The host name in a `Host` header's value, canonical, or undefined when it is not a host. */
export function hostNameOfHeader(value: string): string | undefined {
  const name = HOST_HEADER.exec(value.trim())?.[1];

  return name === undefined ? undefined : canonicalHostName(name);
}

/**
 * The name a server bound to `bound` goes by, when it has one: a host name or an address a client
 * can use. A wildcard address (`0.0.0.0`, `::`) listens everywhere and names no host, so a server on
 * one lists its names in `hosts`.
 */
function boundName(bound: string | undefined): string | undefined {
  if (bound === undefined) return undefined;

  const literal = bound.includes(':') && !BRACKETED_HOST.test(bound) ? `[${bound}]` : bound;

  if (!URL.canParse(`http://${literal}`)) return undefined;

  const { hostname } = new URL(`http://${literal}`);

  return WILDCARD_HOSTS.includes(hostname) ? undefined : canonicalHostName(hostname);
}

/**
 * What a server answers: this machine's names always (`localhost`, `127.0.0.1`, `[::1]`: a
 * rebinding page carries its own name, never these), the name it is bound to, and `hosts` (every
 * name a remote server is reached by). An origin is answered only when `origins` lists it: a
 * browser sends one, and the clients that talk to this server send none.
 */
export function allowedRequests(
  params: {
    bound?: string | undefined;
    hosts?: readonly string[];
    origins?: readonly string[];
  } = {},
): AllowedRequests {
  const { bound, hosts = [], origins = [] } = params;
  const bind = boundName(bound);

  return {
    hosts: new Set([
      ...LOOPBACK_HOST_NAMES,
      ...(bind === undefined ? [] : [bind]),
      ...hosts.map(canonicalHostName),
    ]),
    origins: new Set(origins),
  };
}

/**
 * Why a request is refused before any route sees it, or undefined when it may go on. Every host the
 * request names must be allowed: the `Host` header when there is one, and the host of the request's
 * URL (the server builds it from that header, or from the address it is bound to when a client sent
 * none, and an absolute request line overrides both). A `Host` that is not a host name is refused.
 * Any `Origin` is refused unless listed: no port is compared for hosts, since a forwarded port is
 * not the server's. The reasons are fixed text, so a refusal tells a page nothing it sent.
 */
export function refusalOf(params: {
  host: string | undefined;
  url: string;
  origin: string | undefined;
  allowed: AllowedRequests;
}): string | undefined {
  const { host, url, origin, allowed } = params;
  const named: (string | undefined)[] = [
    host === undefined ? [] : [hostNameOfHeader(host)],
    URL.canParse(url) ? [canonicalHostName(new URL(url).hostname)] : [undefined],
  ].flat();

  if (named.some((name) => name === undefined || !allowed.hosts.has(name))) {
    return REFUSED_HOST_MESSAGE;
  }

  if (origin === undefined || allowed.origins.has(origin)) return undefined;

  return REFUSED_ORIGIN_MESSAGE;
}
