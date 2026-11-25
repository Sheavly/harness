import type { ServerType } from '@hono/node-server';
import { afterEach } from 'vitest';

/**
 * Test-only: the servers a test opens, each closed with its connections after the test, so a
 * failing one leaves no listener behind. Call it once in the test file, and `add` each server.
 */
export function useOpenedServers() {
  const opened: ServerType[] = [];

  afterEach(() => {
    for (const server of opened.splice(0)) {
      if ('closeAllConnections' in server) server.closeAllConnections();

      server.close();
    }
  });

  return { add: (server: ServerType): void => void opened.push(server) };
}
