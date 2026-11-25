import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
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

  return {
    add: (server: ServerType): void => void opened.push(server),
    /** Serves `fetch` on a free port of 127.0.0.1, closed with the others, and gives its URL. */
    listen: async (fetch: (request: Request) => Response | Promise<Response>): Promise<string> => {
      const server = serve({ fetch, hostname: '127.0.0.1', port: 0 });

      opened.push(server);
      await once(server, 'listening');

      return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    },
  };
}
