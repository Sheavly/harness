import { verifyServer } from '@sheavly/client/client/verify.helper';
import { findRunningServer } from '@sheavly/storage/server-finder/server-finder.helper';
import type { Finding } from './doctor.types.js';

/**
 * The state of the user's server, found as `chat` finds it without `BACKEND_URL` (it says when that
 * is set): through the discovery file, with the handshake proving the server holds the token before anything else is believed. It reports:
 * running and verified (with the protocol version the handshake proved), a server of another
 * protocol (which side is older), or none, with one reason per folder looked in (left over,
 * refused, no answer, not started). The token, the address and the file's text are never in a
 * line. Only reads and probes: a free lock is never contacted, and nothing is started or removed.
 */
export async function checkServer(params: {
  env: NodeJS.ProcessEnv;
  home: string;
  uid: number;
}): Promise<Finding> {
  const { env, home, uid } = params;
  const found = await findRunningServer({ home, env, uid, verify: verifyServer });
  // `chat` skips the discovery file for a set `BACKEND_URL`; doctor looks only at the file.
  const notes = env.BACKEND_URL
    ? ['  BACKEND_URL is set: `chat` connects to that server, which doctor does not check.']
    : [];

  if (found.status === 'found') {
    return {
      label: 'Server',
      ok: true,
      lines: [`running and verified (protocol ${found.protocolVersion})`, ...notes],
    };
  }

  if (found.status === 'version_mismatch') {
    return { label: 'Server', ok: false, lines: [found.message, ...notes] };
  }

  return {
    label: 'Server',
    ok: false,
    lines: [
      'none running',
      ...found.reasons.map(({ message }) => `  ${message}`),
      '  Start one with `sheavly serve`.',
      ...notes,
    ],
  };
}
