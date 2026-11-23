import { once } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { ONE_TCP_SEGMENT_BYTES } from './client-hello.constants.js';

const RECORD_HEADER_BYTES = 5;
// After the record header: handshake type and length (4), legacy version (2), random (32).
const SESSION_ID_AT = RECORD_HEADER_BYTES + 4 + 2 + 32;
const SUPPORTED_GROUPS = 10;
const KEY_SHARE = 51;
const ALPN = 16;

/** The record's full length once its header and body have arrived, otherwise undefined. */
function recordEnd(received: Buffer): number | undefined {
  if (received.length < RECORD_HEADER_BYTES) return undefined;

  const end = RECORD_HEADER_BYTES + received.readUInt16BE(3);

  return received.length >= end ? end : undefined;
}

async function firstRecord(socket: Socket): Promise<Buffer> {
  let received = Buffer.alloc(0);

  for await (const chunk of socket) {
    received = Buffer.concat([received, chunk as Buffer]);
    const end = recordEnd(received);

    if (end !== undefined) return received.subarray(0, end);
  }

  throw new Error('The client closed the connection before a whole TLS record arrived');
}

function groupList(body: Buffer): number[] {
  const groups: number[] = [];

  for (let at = 2; at < body.length; at += 2) groups.push(body.readUInt16BE(at));

  return groups;
}

function keyShareGroups(body: Buffer): number[] {
  const groups: number[] = [];

  for (let at = 2; at < body.length; at += 4 + body.readUInt16BE(at + 2)) {
    groups.push(body.readUInt16BE(at));
  }

  return groups;
}

function alpnProtocols(body: Buffer): string[] {
  const protocols: string[] = [];

  for (let at = 2; at < body.length; at += 1 + body.readUInt8(at)) {
    protocols.push(body.toString('latin1', at + 1, at + 1 + body.readUInt8(at)));
  }

  return protocols;
}

/** A ClientHello record's size, the groups it lists and sends a key share for, and its ALPN list. */
function parseClientHello(record: Buffer) {
  let at = SESSION_ID_AT;

  at += 1 + record.readUInt8(at); // session id
  at += 2 + record.readUInt16BE(at); // cipher suites
  at += 1 + record.readUInt8(at); // compression methods

  const extensionsEnd = at + 2 + record.readUInt16BE(at);
  let supportedGroups: number[] = [];
  let keyShares: number[] = [];
  let alpn: string[] = [];

  for (at += 2; at < extensionsEnd; at += 4 + record.readUInt16BE(at + 2)) {
    const type = record.readUInt16BE(at);
    const body = record.subarray(at + 4, at + 4 + record.readUInt16BE(at + 2));

    if (type === SUPPORTED_GROUPS) supportedGroups = groupList(body);
    if (type === KEY_SHARE) keyShares = keyShareGroups(body);
    if (type === ALPN) alpn = alpnProtocols(body);
  }

  return { bytes: record.length, supportedGroups, keyShares, alpn };
}

/** Test-only: the parts of a captured ClientHello the model fetch is about, to compare with `MODEL_FETCH_HELLO`. */
export function helloShape(hello: ReturnType<typeof parseClientHello>) {
  return { fitsOneSegment: hello.bytes < ONE_TCP_SEGMENT_BYTES, keyShares: hello.keyShares };
}

async function dropAfterHello(socket: Socket) {
  const record = await firstRecord(socket);

  socket.destroy();

  return parseClientHello(record);
}

type Outcome = { hello: ReturnType<typeof parseClientHello> } | { failure: unknown };

/**
 * Drops every connection once its ClientHello arrived; settles with the first connection's
 * outcome, or with a failure when the server closes before any arrived. It never rejects: a test
 * that only needs a call to stay local never reads it.
 */
function firstOutcome(params: { server: Server; sockets: Set<Socket> }) {
  const { server, sockets } = params;

  return new Promise<Outcome>((resolve) => {
    // Every connection, not just the first: a client that retries must not wait on one unread.
    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      dropAfterHello(socket).then(
        (hello) => resolve({ hello }),
        (caughtError: unknown) => resolve({ failure: caughtError }),
      );
    });
    // A later settle is ignored, so this only answers a capture nothing ever reached.
    server.once('close', () => {
      resolve({ failure: new Error('The capture closed before any ClientHello arrived') });
    });
  });
}

async function helloOf(outcome: Promise<Outcome>) {
  const settled = await outcome;

  if ('failure' in settled) {
    throw new Error('The ClientHello could not be read', { cause: settled.failure });
  }

  return settled.hello;
}

/**
 * Test-only: a TCP server on 127.0.0.1 that reads the TLS ClientHello of each connection to `url`
 * and then drops it, so the client's request fails. Reading `hello` waits for the first one, and
 * rejects if it could not be read or the capture closed first; a test that never reads it is not
 * failed by that. A client that never connects leaves a read waiting until the test times out.
 * `close()` drops any connection still open and stops the server.
 */
export async function captureClientHello() {
  const server = createServer();
  const sockets = new Set<Socket>();

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address() as AddressInfo;
  const outcome = firstOutcome({ server, sockets });

  return {
    url: `https://127.0.0.1:${String(port)}`,
    get hello() {
      return helloOf(outcome);
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}
