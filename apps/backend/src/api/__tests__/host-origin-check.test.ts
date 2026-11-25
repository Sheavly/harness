import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { describe, expect, it } from 'vitest';
import { API_ROUTES } from '@sheavly/protocol/api/api.constants';
import type { RouteName } from '@sheavly/protocol/api/api.types';
import { useTempFolders } from '@sheavly/testing/files/temp-folders.fake';
import { listenServer } from '../../listen/listen.helper.js';
import { testBackend } from '../../testing/backend.fake.js';
import { useOpenedServers } from '../../testing/opened-servers.fake.js';
import { TEST_TOKEN } from '../../testing/testing.constants.js';
import type { AllowedRequests } from '../api.types.js';
import { REFUSED_HOST_MESSAGE, REFUSED_ORIGIN_MESSAGE } from '../api.constants.js';
import { allowedRequests } from '../request-origin.utils.js';

// The check is the server's, so these talk to a listening server with raw requests: a `Host` and an
// `Origin` are headers a script sets and a browser or a rebinding page sends, and a test that only
// calls the app would hold neither as a real server builds them.

const folders = useTempFolders({ prefix: 'host-origin-', names: ['workspace'] });
const servers = useOpenedServers();

/** A server of the real backend's app, on a free port of loopback, answering `allowed`. */
async function listening(allowed: AllowedRequests = allowedRequests()): Promise<number> {
  const backend = testBackend({
    home: `${folders.base}/home`,
    workspace: `${folders.base}/workspace`,
    allowed,
  });
  const server = createAdaptorServer({ fetch: backend.app.fetch });

  servers.add(server);
  await listenServer({ server, host: '127.0.0.1', port: 0 });

  return (server.address() as AddressInfo).port;
}

/** What one request got back: its status and its body, parsed when it is JSON, else its text. */
type Answer = { status: number; body: unknown };

/** Sends one request with exactly `headers` (a `Host` of our own among them) to the server. */
function send(params: {
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
}): Promise<Answer> {
  const { port, method, path, headers } = params;
  const { promise, resolve, reject } = Promise.withResolvers<Answer>();
  const request = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (response) => {
    const chunks: Buffer[] = [];

    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const isJson = String(response.headers['content-type']).includes('json');

      resolve({
        status: response.statusCode ?? 0,
        body: isJson ? (JSON.parse(text) as unknown) : text,
      });
    });
  });

  request.on('error', reject);
  // A route that streams (an event stream) never ends when nothing refused it: fail the test then,
  // with that, and not after the test runner's own timeout.
  request.setTimeout(2000, () => request.destroy(new Error(`no answer to ${method} ${path}`)));
  // A GET with a body is refused by the server's request builder before any middleware runs.
  request.end(['GET', 'DELETE'].includes(method) ? undefined : '{}');

  return promise;
}

/** Every route of the contract as a request: its method and its path with each parameter filled. */
const routes = (Object.keys(API_ROUTES) as RouteName[]).map((name) => ({
  name,
  method: API_ROUTES[name].method.toUpperCase(),
  path: API_ROUTES[name].path.replace(/\{\w+\}/g, 'x'),
}));

const WITH_TOKEN = { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' };

const refused = (message: string) => ({ error: { code: 'forbidden', message } });

describe('a server on loopback', () => {
  it('refuses every route, public ones too, for a Host that is not its own, token or not', async () => {
    const port = await listening();
    const host = `evil.example:${String(port)}`;

    expect(routes.length).toBeGreaterThan(30);

    for (const { name, method, path } of routes) {
      for (const headers of [WITH_TOKEN, {}]) {
        const answer = await send({ port, method, path, headers: { ...headers, host } });

        expect({ name, ...answer }).toEqual({
          name,
          status: 403,
          body: refused(REFUSED_HOST_MESSAGE),
        });
      }
    }
  });

  it('refuses every route for a request that carries an Origin, a browser page being one', async () => {
    const port = await listening();

    for (const { name, method, path } of routes) {
      const headers = {
        ...WITH_TOKEN,
        host: `localhost:${String(port)}`,
        origin: 'https://evil.example',
      };
      const answer = await send({ port, method, path, headers });

      expect({ name, ...answer }).toEqual({
        name,
        status: 403,
        body: refused(REFUSED_ORIGIN_MESSAGE),
      });
    }
  });

  it('refuses a name that only looks like this machine, and a Host that is not a name', async () => {
    const port = await listening();

    for (const host of ['localhost.evil.example', '127.0.0.1.evil.example', '0.0.0.0', '[::2]']) {
      const answer = await send({ port, method: 'GET', path: '/health', headers: { host } });

      expect({ host, status: answer.status }).toEqual({ host, status: 403 });
    }

    // Not a host name at all: the server's own request builder rejects these with a 400 before the
    // check is reached, and the check refuses them too (see its unit test). Never answered.
    for (const host of ['user@localhost', 'localhost/x']) {
      const answer = await send({ port, method: 'GET', path: '/health', headers: { host } });

      expect({ host, refused: [400, 403].includes(answer.status) }).toEqual({
        host,
        refused: true,
      });
    }
  });

  it('refuses a request line that names another host than the Host header does', async () => {
    const port = await listening();
    const answer = await send({
      port,
      method: 'GET',
      path: 'http://evil.example/health',
      headers: { host: 'localhost' },
    });

    expect(answer.status).toBe(403);
  });

  it('still answers a plain local client: the public routes, and the token check for the rest', async () => {
    const port = await listening();
    const spellings = [
      '127.0.0.1',
      'localhost',
      'LOCALHOST',
      'localhost.',
      '[::1]',
      // A port the server is not on: an SSH forward sends the port it forwards.
      'localhost:1',
    ];

    for (const name of spellings) {
      const host = name.includes(':') && !name.startsWith('[') ? name : `${name}:${String(port)}`;
      const health = await send({ port, method: 'GET', path: '/health', headers: { host } });
      const messages = await send({
        port,
        method: 'GET',
        path: '/conversations/x/messages',
        headers: { host },
      });

      expect({ host, health: health.status, messages: messages.status }).toEqual({
        host,
        health: 200,
        messages: 401,
      });
    }

    // A client that sends the bare name, with no port, as HTTP/1.1 allows.
    const bare = await send({
      port,
      method: 'GET',
      path: '/health',
      headers: { host: 'localhost' },
    });

    expect(bare.status).toBe(200);
  });

  it('says only fixed text: nothing the request sent is in the answer', async () => {
    const port = await listening();
    const answer = await send({
      port,
      method: 'GET',
      path: '/health',
      headers: { host: 'secret-name.evil.example' },
    });

    expect(JSON.stringify(answer.body)).not.toMatch(/secret-name|evil/);
  });
});

describe('a server that lists its names and origins', () => {
  const allowed = allowedRequests({
    hosts: ['myhost.example'],
    origins: ['https://app.example', 'http://localhost:5173'],
  });

  it('answers a listed host name, with any port, and still refuses a name it does not list', async () => {
    const port = await listening(allowed);
    const get = (host: string) =>
      send({ port, method: 'GET', path: '/health', headers: { host } }).then((a) => a.status);

    expect(await get(`myhost.example:${String(port)}`)).toBe(200);
    expect(await get('MyHost.Example:9999')).toBe(200);
    expect(await get('other.example')).toBe(403);
    expect(await get('sub.myhost.example')).toBe(403);
  });

  it('answers a listed origin, and refuses any other, null and a look-alike included', async () => {
    const port = await listening(allowed);
    const get = (origin: string) =>
      send({
        port,
        method: 'GET',
        path: '/health',
        headers: { host: `localhost:${String(port)}`, origin },
      }).then((a) => a.status);

    expect(await get('https://app.example')).toBe(200);
    expect(await get('http://localhost:5173')).toBe(200);
    expect(await get('https://app.example:444')).toBe(403);
    expect(await get('http://app.example')).toBe(403);
    expect(await get('https://app.example.evil.example')).toBe(403);
    expect(await get('null')).toBe(403);
  });

  it('does not let a listed origin past a Host that is not listed', async () => {
    const port = await listening(allowed);
    const answer = await send({
      port,
      method: 'GET',
      path: '/health',
      headers: { host: 'evil.example', origin: 'https://app.example' },
    });

    expect(answer).toEqual({ status: 403, body: refused(REFUSED_HOST_MESSAGE) });
  });
});
