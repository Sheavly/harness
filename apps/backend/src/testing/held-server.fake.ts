import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { InstanceId } from '@sheavly/protocol/handshake/handshake.types';
import { PROTOCOL_VERSION } from '@sheavly/protocol/version/protocol-version.constants';
import { publishDiscoveryFile } from '@sheavly/storage/discovery-file/publish-discovery-file.helper';
import { acquireServerLock } from '@sheavly/storage/server-lock/server-lock.helper';
import type { ServerLockResult } from '@sheavly/storage/server-lock/server-lock.types';
import { serverRuntimeDirectory } from '@sheavly/storage/server-runtime/server-runtime.helper';
import { newInstanceId } from '../instance/instance-id.helper.js';
import type { ServeFolders } from './serve-process.types.js';

/**
 * Test-only: a server that is not a server. It holds the lock of the test's home inside this
 * process and publishes a discovery file for whatever listens at `url`, so the finder meets a
 * held lock and a valid file with nothing behind them but the test's own listener. The lock is
 * released when the test ends.
 */
export function useHeldServer(folders: () => ServeFolders): {
  /**
   * The runtime folder, made private, with its lock left free: a file published there is left
   * over, and nothing may contact the address it names.
   */
  folder: () => Promise<string>;
  /** Takes the lock in the runtime folder (made private here) and returns the folder. */
  hold: () => Promise<string>;
  /** Publishes a valid file for `url` with the test's token and `instanceId` (a new one when unset). */
  publish: (params: { directory: string; url: string; instanceId?: InstanceId }) => Promise<void>;
} {
  const taken: ServerLockResult[] = [];
  const uid = process.getuid?.() ?? 0;

  afterEach(async () => {
    for (const result of taken.splice(0)) {
      if (result.status === 'acquired') await result.release();
    }
  });

  const folder = async () => {
    const { home, xdg } = folders();
    const runtime = await serverRuntimeDirectory({
      env: { XDG_RUNTIME_DIR: xdg },
      home,
      platform: 'linux',
      uid,
    });

    if (runtime.status !== 'ready') throw new Error(`the runtime folder is ${runtime.status}`);

    return runtime.directory;
  };

  return {
    folder,
    hold: async () => {
      const directory = await folder();
      const lock = await acquireServerLock({ home: folders().home, runtimeDir: directory });

      taken.push(lock);

      // Unheld, the test would meet a free lock instead and fail for another reason.
      if (lock.status !== 'acquired') {
        throw new Error(
          `the lock was not taken (${lock.status === 'unusable' ? lock.reason : lock.status})`,
        );
      }

      return directory;
    },
    publish: async ({ directory, url, instanceId = newInstanceId() }) => {
      const published = await publishDiscoveryFile({
        directory,
        uid,
        value: {
          formatVersion: 1,
          url,
          token: folders().token,
          instanceId,
          pid: process.pid,
          serverVersion: '1.0.0',
          protocolVersion: PROTOCOL_VERSION,
        },
      });

      if (published.status !== 'published') throw new Error(`not published: ${published.status}`);
    },
  };
}

/** Test-only: every path under `root` with its mtime and size, sorted: what a read must not change. */
export async function treeSnapshot(root: string): Promise<string[]> {
  const names = await readdir(root, { recursive: true });
  const lines = await Promise.all(
    names.map(async (name) => {
      const { mtimeMs, size } = await lstat(path.join(root, name));

      return [name, mtimeMs, size].join(' ');
    }),
  );

  return lines.sort();
}
