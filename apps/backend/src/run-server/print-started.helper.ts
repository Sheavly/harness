import type { AddressInfo } from 'node:net';
import type { Environment } from '@sheavly/core/environment/environment.types';
import { sheavlyHome } from '@sheavly/storage/home/home.helper';
import { SERVER } from '../harness/harness.constants.js';
import { portMovedNotice } from '../listen/port-notice.utils.js';
import type { ServerSettings } from './run-server.types.js';

/** What the user needs once the server listens: where their data is, and the token when made here. */
export function printStarted(params: {
  env: Environment;
  server: ServerSettings;
  token: string;
  address: AddressInfo;
}): void {
  const { env, server, token, address } = params;

  console.log(`→ profiles and models in ${sheavlyHome(env)}`);

  // Shown once, for the user to give their UI; never logged with a request.
  if (!server.token) console.log(`→ token (SERVER_TOKEN unset, so made for this run): ${token}`);

  console.log('→ Ctrl+C to stop');

  const moved = portMovedNotice({
    portIsDefault: server.portIsDefault,
    defaultPort: SERVER.port,
    port: address.port,
  });

  if (moved) console.log(moved);

  // Last, as the line a UI that started this process waits for: everything is ready by then.
  console.log(`→ listening on http://${server.host}:${String(address.port)}`);
}
