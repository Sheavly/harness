import { createServer as createHttp2Server } from 'node:http2';
import net from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { describe, expect, it } from 'vitest';
import { ServerAlreadyListeningError, UnsupportedServerError } from '../../errors/listen.errors.js';
import { testApi } from '../../testing/api.fake.js';
import { useOpenedServers } from '../../testing/opened-servers.fake.js';
import {
  CONNECTIONS_CHECK_INTERVAL_MS,
  HEADERS_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
} from '../listen.constants.js';
import { listenServer } from '../listen.helper.js';
import { configureServerTimeouts } from '../server-timeouts.helper.js';

const HOST = '127.0.0.1';
const SHORT = { requestTimeoutMs: 300, headersTimeoutMs: 200, checkIntervalMs: 20 };
const CLIENT_GIVES_UP_MS = 3000;
const servers = useOpenedServers();

async function startServer(params: {
  fetch: (request: Request) => Response | Promise<Response>;
  timeouts?: Omit<Parameters<typeof configureServerTimeouts>[0], 'server'>;
}): Promise<{ server: ServerType; port: number }> {
  const server = createAdaptorServer({ fetch: params.fetch });

  servers.add(server);
  configureServerTimeouts({ server, ...params.timeouts });
  await listenServer({ server, host: HOST, port: 0 });

  return { server, port: (server.address() as net.AddressInfo).port };
}

/** Sends `text` to the server, then nothing; gives what came back and how long it took to close. */
function sendThenStall(params: { port: number; text: string }): Promise<{
  answer: string;
  closedAfterMs: number;
}> {
  const { promise, resolve } = Promise.withResolvers<{ answer: string; closedAfterMs: number }>();
  const started = performance.now();
  const socket = net.connect(params.port, HOST, () => socket.write(params.text));
  let answer = '';

  socket.on('data', (chunk: Buffer) => (answer += chunk.toString('utf8')));
  socket.on('error', () => undefined);
  socket.on('close', () => resolve({ answer, closedAfterMs: performance.now() - started }));
  // A server that never cuts the connection ends the wait here, so the test fails instead of hanging.
  setTimeout(() => socket.destroy(), CLIENT_GIVES_UP_MS).unref();

  return promise;
}

const headOf = (length: number) =>
  `QUERY /handshake HTTP/1.1\r\nHost: ${HOST}\r\nContent-Type: application/json\r\nContent-Length: ${String(length)}\r\n\r\n`;

describe('configureServerTimeouts', () => {
  it('sets the request and headers timeouts and how often they are checked, from the constants', () => {
    const server = createAdaptorServer({ fetch: () => new Response('ok') });

    configureServerTimeouts({ server });

    expect(server).toMatchObject({
      requestTimeout: REQUEST_TIMEOUT_MS,
      headersTimeout: HEADERS_TIMEOUT_MS,
      connectionsCheckingInterval: CONNECTIONS_CHECK_INTERVAL_MS,
    });
    expect([REQUEST_TIMEOUT_MS, HEADERS_TIMEOUT_MS]).toEqual([30_000, 10_000]);
  });

  it('takes other values when asked', () => {
    const server = createAdaptorServer({ fetch: () => new Response('ok') });

    configureServerTimeouts({
      server,
      requestTimeoutMs: 5,
      headersTimeoutMs: 4,
      checkIntervalMs: 3,
    });

    expect(server).toMatchObject({
      requestTimeout: 5,
      headersTimeout: 4,
      connectionsCheckingInterval: 3,
    });
  });

  it('refuses a server that has no such options, loudly', () => {
    expect(() => configureServerTimeouts({ server: createHttp2Server() })).toThrow(
      UnsupportedServerError,
    );
  });

  it('refuses a server that already listens, where the check interval would not apply', async () => {
    const server = createAdaptorServer({ fetch: () => new Response('ok') });

    servers.add(server);
    await listenServer({ server, host: HOST, port: 0 });

    expect(() => configureServerTimeouts({ server })).toThrow(ServerAlreadyListeningError);
  });

  it('closes a connection whose request body stalls, instead of holding it open', async () => {
    const { app } = testApi({});
    const { port } = await startServer({ fetch: app.fetch, timeouts: SHORT });

    // The head promises 50 bytes of body and only 5 arrive.
    const { answer, closedAfterMs } = await sendThenStall({
      port,
      text: `${headOf(50)}{"non`,
    });

    expect(answer).toMatch(/^HTTP\/1\.1 408 /);
    expect(closedAfterMs).toBeLessThan(CLIENT_GIVES_UP_MS);
  });

  it('closes a connection whose headers never finish', async () => {
    const { app } = testApi({});
    const { port } = await startServer({ fetch: app.fetch, timeouts: SHORT });
    const { closedAfterMs } = await sendThenStall({
      port,
      text: `QUERY /handshake HTTP/1.1\r\nHost: ${HOST}\r\n`,
    });

    expect(closedAfterMs).toBeLessThan(CLIENT_GIVES_UP_MS);
  });

  it('does not cut a response that outlives the request timeout (an event stream)', async () => {
    const stream = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let beat = 0; beat < 5; beat++) {
              controller.enqueue(new TextEncoder().encode('data: beat\n\n'));
              await new Promise((resolve) => setTimeout(resolve, 200));
            }

            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    const { port } = await startServer({ fetch: stream, timeouts: SHORT });
    const started = performance.now();
    const text = await (await fetch(`http://${HOST}:${String(port)}/`)).text();

    expect(text.match(/beat/g)).toHaveLength(5);
    expect(performance.now() - started).toBeGreaterThan(SHORT.requestTimeoutMs);
  });
});
