import type { ChatServer, VerifiedServer } from '../chat/chat.types.js';

/**
 * What `sheavly connection --json` prints. `discovery` is a server found through its discovery
 * file and proven by its handshake, with its versions. `environment` is `BACKEND_URL` and
 * `BACKEND_TOKEN` as given: nothing contacted, so nothing proven and no versions.
 */
export type Connection =
  ({ source: 'discovery' } & VerifiedServer) | ({ source: 'environment' } & ChatServer);
