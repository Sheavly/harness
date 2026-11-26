import type { InstanceId } from '@sheavly/protocol/handshake/handshake.types';
import type { ServerErrorCode } from '@sheavly/protocol/server/server.types';
import type {
  AnswerOf,
  EmptyRoute,
  ItemOf,
  JsonRoute,
  StreamRoute,
} from '../client/client.types.js';

/** Test-only: one request a recording `fetch` received, whole, for a test to look through. */
export type SentRequest = {
  url: string;
  method: string;
  headers: [string, string][];
  body: string;
};

/** Test-only: a real local HTTP server standing where the Sheavly server should be. */
export type Impostor = {
  url: string;
  /** How many requests reached it. */
  requestCount: () => number;
  close: () => Promise<void>;
};

/** Test-only: how a fake handshake server answers a nonce: a response, or a transport failure. */
export type HandshakeAnswer = (params: { nonce: string }) => Response | Promise<Response>;

/** Test-only: what a fake handshake server is: the token, instance and version it holds. */
export type HandshakeIdentity = {
  token: string;
  instanceId: InstanceId;
  protocolVersion: string;
};

/** Test-only: what a fake route was called with: its path params and its parsed body. */
export type FakeCall = { params: Record<string, string>; body: unknown };

/** Test-only: a refusal a fake route answers with, as a backend would. */
export type FakeRefusal = { refuse: { status: number; code: ServerErrorCode; message?: string } };

type Answer<T> = T | FakeRefusal | Promise<T | FakeRefusal>;

/** Test-only: how a fake answers each route it knows; one it doesn't know answers `not_found`. */
export type FakeHandlers = Partial<{
  [N in JsonRoute]: (call: FakeCall) => Answer<AnswerOf<N>>;
}> &
  Partial<Record<EmptyRoute, (call: FakeCall) => Answer<undefined>>> &
  Partial<{
    [N in StreamRoute]: (call: FakeCall) => AsyncIterable<ItemOf<N>> | FakeRefusal;
  }>;
