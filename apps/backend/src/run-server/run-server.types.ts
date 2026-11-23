import type { AddressInfo } from 'node:net';
import type { ServerType } from '@hono/node-server';
import type { Environment } from '@sheavly/core/environment/environment.types';
import type { Conversations } from '@sheavly/host/conversations/conversations.service';
import type { InstanceId } from '@sheavly/protocol/handshake/handshake.types';
import type { ServerVersion } from '@sheavly/protocol/version/version.types';
import type { ServerPresence } from '@sheavly/storage/discovery-file/server-presence.service';
import type { parseServerEnv } from '../harness/settings.validator.js';
import type { BackendLogs } from '../logging/logging.types.js';

/**
 * What `runServer` reads instead of the process's own: the environment, the arguments after the
 * script (`--trust`), and how the process ends. Each defaults to the process's.
 */
export type RunServerParams = {
  env?: Environment;
  args?: readonly string[];
  exit?: (code: number) => never;
};

/** The server settings read from the environment: where it listens, its token, its mode. */
export type ServerSettings = ReturnType<typeof parseServerEnv>;

/**
 * What `startServer` ends with. `started`: the server listens, holds its lock (`presence` is
 * undefined when it is not discoverable or the lock was unavailable) and has published its file.
 * `refused`: another server holds the lock; nothing listens, nothing was written, and `message`
 * says whose it is, never with a token.
 */
export type StartOutcome =
  | {
      status: 'started';
      built: BuiltServer;
      presence: ServerPresence | undefined;
      address: AddressInfo;
    }
  | { status: 'refused'; message: string };

/** Everything built before the lock is taken: nothing here works, prints or listens yet. */
export type BuiltServer = {
  listening: ServerType;
  conversations: Conversations;
  logs: BackendLogs;
  token: string;
  instanceId: InstanceId;
  serverVersion: ServerVersion;
};
