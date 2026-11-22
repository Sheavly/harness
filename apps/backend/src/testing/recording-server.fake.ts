import { createServer, type Server } from 'node:http';
import { afterEach } from 'vitest';
import type { ReceivedRequest, RecordedAnswer, RecordingServer } from './recording-server.types.js';

/**
 * Test-only: starts plain `http` listeners on 127.0.0.1 (port chosen by the system) that record
 * every request they are sent and answer with `answer`, which sees the request. Every listener is
 * closed when the test ends.
 */
export function useRecordingServers(): {
  start: (
    answer: (request: ReceivedRequest) => RecordedAnswer | Promise<RecordedAnswer>,
  ) => Promise<RecordingServer>;
} {
  const open: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      open.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
  });

  return {
    start: async (answer) => {
      const requests: ReceivedRequest[] = [];
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];

        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const recorded: ReceivedRequest = {
            method: request.method ?? '',
            path: request.url ?? '',
            headers: { ...request.headers },
            body: Buffer.concat(chunks).toString('utf8'),
          };

          requests.push(recorded);
          void Promise.resolve(answer(recorded)).then(
            ({ status, body, contentType = 'application/json' }) => {
              response.writeHead(status, { 'content-type': contentType });
              response.end(body ?? '');
            },
          );
        });
      });

      open.push(server);
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });

      const address = server.address();

      if (address === null || typeof address === 'string') throw new Error('no TCP address');

      return {
        url: `http://127.0.0.1:${String(address.port)}`,
        requests: () => requests,
        everything: () => JSON.stringify(requests),
      };
    },
  };
}
