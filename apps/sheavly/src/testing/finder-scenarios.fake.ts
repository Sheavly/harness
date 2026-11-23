import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { expectOnlyHandshake } from '@sheavly/backend/testing/handshake-only.fake';
import { useHeldServer } from '@sheavly/backend/testing/held-server.fake';
import { useRecordingServers } from '@sheavly/backend/testing/recording-server.fake';
import type { RecordingServer } from '@sheavly/backend/testing/recording-server.types';
import { useServeProcesses } from '@sheavly/backend/testing/serve-process.fake';
import { handshakeProof } from '@sheavly/protocol/handshake/handshake.utils';
import { instanceIdSchema } from '@sheavly/protocol/handshake/handshake.validator';

const CLI = path.join(import.meta.dirname, '..', 'cli.ts');

/**
 * Test-only: the real `sheavly` command line in a child process (its stdin ended, so a chat with
 * no terminal reads its end at once), and the states the server finder meets that a test plants
 * without a real server: a file whose server is gone, an impostor on the recorded address, and a
 * server of another protocol. Each returns the listener the file points at, so the test can show
 * nothing secret reached it. The folders, the held lock and the listeners are cleaned up when the
 * test ends; call it once at the top of a test file.
 */
export function useFinderScenarios() {
  const cli = useServeProcesses({ entry: [CLI], stdin: 'closed' });
  const held = useHeldServer(cli.folders);
  const listeners = useRecordingServers();

  return {
    cli,
    listeners,
    /** The runtime folder the finder reads, made private, for a test that plants its own file. */
    runtimeFolder: (): Promise<string> => held.folder(),
    /** A file in the runtime folder whose lock is free: left over, so nothing may contact it. */
    plantLeftOver: async (): Promise<RecordingServer> => {
      const listener = await listeners.start(() => ({ status: 404 }));

      await held.publish({ directory: await held.folder(), url: listener.url });

      return listener;
    },
    /** A held lock and a file for an address where something answers without a handshake. */
    plantImpostor: async (): Promise<RecordingServer> => {
      const impostor = await listeners.start(() => ({ status: 404 }));

      await held.publish({ directory: await held.hold(), url: impostor.url });

      return impostor;
    },
    /** A held lock and a file for a server that proves the token on protocol `version`. */
    plantOtherProtocol: async (version: string): Promise<RecordingServer> => {
      const { token } = cli.folders();
      const instanceId = instanceIdSchema.parse(randomBytes(32).toString('base64url'));
      const server = await listeners.start(async (request) => {
        const { nonce } = JSON.parse(request.body) as { nonce: string };
        const proof = await handshakeProof({
          token,
          nonce,
          instanceId,
          protocolVersion: version,
        });

        return { status: 200, body: JSON.stringify({ protocolVersion: version, proof }) };
      });

      await held.publish({ directory: await held.hold(), url: server.url, instanceId });

      return server;
    },
    /** Fails unless `listener` saw nothing but the handshake: the token was never sent to it. */
    expectNothingSecretSent: (listener: RecordingServer) => {
      expectOnlyHandshake({ listener, token: cli.folders().token });
    },
  };
}
