import type { AddressInfo } from 'node:net';
import type { Environment } from '@sheavly/core/environment/environment.types';
import { sheavlyHome } from '@sheavly/storage/home/home.helper';
import { SERVER } from '../harness/harness.constants.js';
import { portMovedNotice } from '../listen/port-notice.utils.js';
import type { ServerSettings } from './run-server.types.js';

/**
 * What the user needs once the server listens: where their data is, and the token when made here.
 * A made token is shown only when `toTerminal` says a person is reading: anywhere else (a service's
 * journal, a pipe, a log file) it would be kept in text others can read, so only the discovery file
 * holds it there.
 */
export function printStarted(params: {
  env: Environment;
  server: ServerSettings;
  token: string;
  address: AddressInfo;
  toTerminal: boolean;
}): void {
  const { env, server, token, address, toTerminal } = params;

  console.log(`→ profiles and models in ${sheavlyHome(env)}`);

  // Shown once, for the user to give their UI; never logged with a request.
  if (!server.token && toTerminal) {
    console.log(`→ token (SERVER_TOKEN unset, so made for this run): ${token}`);
  }

  if (!server.token && !toTerminal) {
    console.log('→ token made for this run, not shown: this output is not a terminal');
  }

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
