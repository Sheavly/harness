import type { ServerType } from '@hono/node-server';
import type { Environment } from '@sheavly/core/environment/environment.types';
import type { Conversations } from '@sheavly/host/conversations/conversations.service';
import type { InstanceId } from '@sheavly/protocol/handshake/handshake.types';
import type { ServerVersion } from '@sheavly/protocol/version/version.types';
import type { parseServerEnv } from '../harness/settings.validator.js';

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

/** Everything built before the lock is taken: nothing here works, prints or listens yet. */
export type BuiltServer = {
  listening: ServerType;
  conversations: Conversations;
  token: string;
  instanceId: InstanceId;
  serverVersion: ServerVersion;
};
