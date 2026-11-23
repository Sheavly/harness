import { chmod, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { verifyServer } from '@sheavly/client/client/verify.helper';
import { handshakeProof } from '@sheavly/protocol/handshake/handshake.utils';
import { PROTOCOL_VERSION } from '@sheavly/protocol/version/protocol-version.constants';
import { findRunningServer } from '@sheavly/storage/server-finder/server-finder.helper';
import { newInstanceId } from '../../instance/instance-id.helper.js';
import { useHeldServer } from '../../testing/held-server.fake.js';
import { expectOnlyHandshake } from '../../testing/handshake-only.fake.js';
import { useRecordingServers } from '../../testing/recording-server.fake.js';
import type { RecordingServer } from '../../testing/recording-server.types.js';
import { useServeProcesses } from '../../testing/serve-process.fake.js';

const places = useServeProcesses();
const held = useHeldServer(places.folders);
const listeners = useRecordingServers();
const OTHER_VERSION = '5.0.0';

function find(verify: typeof verifyServer) {
  const { home, xdg } = places.folders();

  return findRunningServer({
    home,
    env: { XDG_RUNTIME_DIR: xdg },
    uid: process.getuid?.() ?? 0,
    verify,
  });
}

/** Nothing the finder sent to a listener may carry the token, in any header or body. */
function expectNothingSecretSent(listener: RecordingServer) {
  expectOnlyHandshake({ listener, token: places.folders().token });
}

describe.skipIf(process.platform === 'win32')('an impostor on the recorded address', () => {
  it.each([
    ['answers 404 to everything', { status: 404 }, 'no-handshake'],
    [
      'answers 200 with something that is not the contract',
      { status: 200, body: '{}' },
      'wrong-server',
    ],
    [
      'answers with a proof of another token',
      {
        status: 200,
        body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, proof: 'A'.repeat(43) }),
      },
      'wrong-server',
    ],
  ] as const)(
    'that %s stops the finder before the token is sent',
    async (_name, answer, problem) => {
      const impostor = await listeners.start(() => answer);

      await held.publish({ directory: await held.hold(), url: impostor.url });

      const result = await find(vi.fn(verifyServer));

      expect(result.status).toBe('none');
      expect(result).toMatchObject({ reasons: [{ problem }, { problem: 'no-file' }] });
      expect(JSON.stringify(result)).not.toContain(places.folders().token);
      expectNothingSecretSent(impostor);
    },
    30_000,
  );
});

describe.skipIf(process.platform === 'win32')('a server with another protocol version', () => {
  it('is reported as a mismatch that says which side is older, and is sent no token', async () => {
    const { token } = places.folders();
    const instanceId = newInstanceId();
    const server = await listeners.start(async (request) => {
      const { nonce } = JSON.parse(request.body) as { nonce: string };

      return {
        status: 200,
        body: JSON.stringify({
          protocolVersion: OTHER_VERSION,
          proof: await handshakeProof({
            token,
            nonce,
            instanceId,
            protocolVersion: OTHER_VERSION,
          }),
        }),
      };
    });

    await held.publish({ directory: await held.hold(), url: server.url, instanceId });

    const result = await find(vi.fn(verifyServer));

    expect(result).toMatchObject({
      status: 'version_mismatch',
      older: 'client',
      client: PROTOCOL_VERSION,
      server: OTHER_VERSION,
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result).not.toHaveProperty('token');
    expectNothingSecretSent(server);
  }, 30_000);
});

describe.skipIf(process.platform === 'win32')('a planted discovery file', () => {
  async function planted(plant: (params: { directory: string; text: string }) => Promise<void>) {
    const impostor = await listeners.start(() => ({ status: 404 }));
    const directory = await held.hold();
    const text = JSON.stringify({
      formatVersion: 1,
      url: impostor.url,
      token: places.folders().token,
      instanceId: 'a-_'.repeat(14).concat('Z'),
      pid: process.pid,
      serverVersion: '1.0.0',
      protocolVersion: PROTOCOL_VERSION,
    });

    await plant({ directory, text });

    const verify = vi.fn(verifyServer);
    const result = await find(verify);

    expect(verify).not.toHaveBeenCalled();
    expect(impostor.requests()).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(places.folders().token);

    return result.status === 'none' ? result.reasons[0] : undefined;
  }

  it('that is a link is refused and named', async () => {
    const result = await planted(async ({ directory, text }) => {
      const target = path.join(places.folders().base, 'elsewhere.json');

      await writeFile(target, text, { mode: 0o600 });
      await symlink(target, path.join(directory, 'server.json'));
    });

    expect(result).toMatchObject({ problem: 'refused', refusal: 'link' });
  });

  it('that is open to group and others is refused and named', async () => {
    const result = await planted(async ({ directory, text }) => {
      const file = path.join(directory, 'server.json');

      await writeFile(file, text);
      await chmod(file, 0o644);
    });

    expect(result).toMatchObject({ problem: 'refused', refusal: 'too-open' });
  });

  it('in a folder that others can write to is refused and named', async () => {
    const result = await planted(async ({ directory, text }) => {
      const file = path.join(directory, 'server.json');

      await writeFile(file, text);
      await chmod(file, 0o600);
      await chmod(directory, 0o770);
    });

    expect(result).toMatchObject({ problem: 'refused', refusal: 'folder', detail: 'too-open' });
  });
});
