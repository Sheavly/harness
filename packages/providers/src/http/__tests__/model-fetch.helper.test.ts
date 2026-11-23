import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { ONE_TCP_SEGMENT_BYTES, TLS_GROUP } from '../../testing/client-hello.constants.js';
import { captureClientHello } from '../../testing/client-hello.fake.js';
import { SELF_SIGNED_TLS } from '../../testing/self-signed.constants.js';
import { MODEL_TLS_GROUPS } from '../http.constants.js';
import { createModelFetch, offeredTlsGroups } from '../model-fetch.helper.js';

const captures: { close: () => Promise<void> }[] = [];
const servers: Server[] = [];

afterEach(async () => {
  const stopping = servers.splice(0);

  // A hung request holds its connection open, and `close` waits for every connection to end.
  for (const server of stopping) server.closeAllConnections();
  await Promise.all([
    ...captures.splice(0).map((capture) => capture.close()),
    ...stopping.map((server) => once(server.close(), 'close')),
  ]);
});

async function helloSentBy(send: typeof fetch) {
  const capture = await captureClientHello();

  captures.push(capture);
  // The capture drops the connection after the ClientHello, so the request itself fails.
  await expect(send(capture.url)).rejects.toThrow();

  return capture.hello;
}

/** An HTTP server on a free loopback port that answers with `handle`; its URL. */
async function serve(handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handle).listen(0, '127.0.0.1');

  servers.push(server);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return `http://127.0.0.1:${String(port)}`;
}

describe('offeredTlsGroups', () => {
  it('keeps a list this OpenSSL knows', () => {
    expect(offeredTlsGroups('X25519:P-256')).toBe('X25519:P-256');
  });

  it("falls back to OpenSSL's default for a list naming a group it doesn't know, as OpenSSL before 3.5 does ML-KEM", () => {
    expect(offeredTlsGroups('X25519:no-such-group')).toBeUndefined();
  });

  it('throws any other failure, so the fallback never hides a broken TLS setup', () => {
    expect(() => offeredTlsGroups(42 as unknown as string)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }),
    );
  });
});

describe('createModelFetch and certificates', () => {
  it('refuses a server whose certificate it cannot verify, as Node’s fetch does', async () => {
    const server = createHttpsServer(SELF_SIGNED_TLS, (_request, response) => response.end('ok'));

    servers.push(server.listen(0, '127.0.0.1'));
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    // The server itself works: a client that trusts its certificate completes the handshake.
    const trusting = tlsConnect({ host: '127.0.0.1', port, ca: SELF_SIGNED_TLS.cert });

    await once(trusting, 'secureConnect');
    trusting.destroy();

    await expect(createModelFetch()(`https://127.0.0.1:${String(port)}`)).rejects.toMatchObject({
      cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
    });
  });
});

describe('createModelFetch', () => {
  it('sends a TLS ClientHello that fits in one TCP segment', async () => {
    const hello = await helloSentBy(createModelFetch());

    expect(hello.bytes).toBeLessThan(ONE_TCP_SEGMENT_BYTES);
  });

  it('sends only an X25519 key share, never the large ML-KEM one', async () => {
    const hello = await helloSentBy(createModelFetch());

    expect(hello.keyShares).toEqual([TLS_GROUP.x25519]);
  });

  // Only where this OpenSSL has ML-KEM (3.5 on); before that it is never offered at all.
  it.skipIf(offeredTlsGroups(MODEL_TLS_GROUPS) === undefined)(
    'still lists X25519MLKEM768, so a server that prefers it can ask for it',
    async () => {
      const hello = await helloSentBy(createModelFetch());

      expect(hello.supportedGroups).toContain(TLS_GROUP.x25519Mlkem768);
      expect(hello.supportedGroups.indexOf(TLS_GROUP.x25519)).toBe(0);
    },
  );

  it('offers HTTP/1.1 only, as Node 24’s own fetch does, never HTTP/2', async () => {
    const hello = await helloSentBy(createModelFetch());

    expect(hello.alpn).toEqual(['http/1.1']);
  });

  it('refuses a Request input, which undici’s own fetch cannot read', async () => {
    await expect(createModelFetch()(new Request('https://127.0.0.1/'))).rejects.toMatchObject({
      name: 'ModelFetchError',
      reason: 'request_input',
    });
  });

  it('refuses a FormData body, which undici’s own fetch cannot read', async () => {
    const sent = createModelFetch()('https://127.0.0.1/', { method: 'POST', body: new FormData() });

    await expect(sent).rejects.toMatchObject({ name: 'ModelFetchError', reason: 'form_data_body' });
  });

  it('sends the method, headers and body, and streams the reply back', async () => {
    const url = await serve((request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write(`${request.method ?? ''} ${String(request.headers['x-probe'])} `);
      request.pipe(response);
    });

    const response = await createModelFetch()(url, {
      method: 'POST',
      headers: { 'x-probe': 'yes' },
      body: 'hello',
    });

    expect(response.ok).toBe(true);
    expect(await response.text()).toBe('POST yes hello');
  });

  it('stops waiting when the signal aborts', async () => {
    const url = await serve(() => {
      // Never answers: only the abort ends the request.
    });
    const controller = new AbortController();
    const sent = createModelFetch()(url, { signal: controller.signal });

    controller.abort();

    await expect(sent).rejects.toMatchObject({ name: 'AbortError' });
  });
});
