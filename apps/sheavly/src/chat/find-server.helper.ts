import { verifyServer } from '@sheavly/client/client/verify.helper';
import { sheavlyHome } from '@sheavly/storage/home/home.helper';
import { findRunningServer } from '@sheavly/storage/server-finder/server-finder.helper';
import { describeNone } from '@sheavly/storage/server-finder/server-finder.utils';
import { NoServerError, ServerNotRunningError } from '../errors/cli.errors.js';
import { START_SERVER_HINT } from './chat.constants.js';
import type { ChatServer, VerifiedServer } from './chat.types.js';

/**
 * The user's running server, found through the discovery file of the home `env` names and proven
 * by its handshake (`verifyServer`) before its token is handed on, with the versions the file and
 * the handshake gave. Throws `ServerNotRunningError` (a `NoServerError`) when there is none
 * (saying why for each folder it looked in, and to run `sheavly serve`) and a plain
 * `NoServerError` when it speaks another protocol (saying which side is older); neither message
 * holds the token. It never starts a server and never contacts one whose lock is free.
 */
export async function findVerifiedServer(env: NodeJS.ProcessEnv): Promise<VerifiedServer> {
  const found = await findRunningServer({
    home: sheavlyHome(env),
    env,
    uid: process.getuid?.() ?? 0,
    verify: verifyServer,
  });

  if (found.status === 'found') {
    return {
      url: found.url,
      token: found.token,
      serverVersion: found.serverVersion,
      protocolVersion: found.protocolVersion,
    };
  }

  if (found.status === 'version_mismatch') throw new NoServerError(found.message);

  throw new ServerNotRunningError([...describeNone(found), START_SERVER_HINT].join('\n'));
}

/**
 * `findVerifiedServer`, narrowed to where the server is and its token: all that `chat` and `setup`
 * pass on to the terminal, so nothing else of the lookup reaches it.
 */
export async function findChatServer(env: NodeJS.ProcessEnv): Promise<ChatServer> {
  const { url, token } = await findVerifiedServer(env);

  return { url, token };
}
