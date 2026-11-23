import { expect } from 'vitest';
import type { RecordingServer } from './recording-server.types.js';

/**
 * Test-only: what a finder may have sent to a listener on a recorded address. It was asked, and
 * asked the handshake only, with no token in any header or body and no `authorization` header.
 */
export function expectOnlyHandshake(params: { listener: RecordingServer; token: string }): void {
  const { listener, token } = params;

  expect(listener.requests().length).toBeGreaterThan(0);
  expect(listener.everything()).not.toContain(token);

  for (const request of listener.requests()) {
    expect(request.headers).not.toHaveProperty('authorization');
    expect(`${request.method} ${request.path}`).toBe('QUERY /handshake');
  }
}
