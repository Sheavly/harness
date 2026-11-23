import { describe, expect, it } from 'vitest';
import { captureClientHello } from '../client-hello.fake.js';

describe('captureClientHello', () => {
  it('rejects a read of hello when it closes before any ClientHello arrived, instead of waiting', async () => {
    const capture = await captureClientHello();

    await capture.close();

    await expect(capture.hello).rejects.toMatchObject({
      cause: {
        message: expect.stringContaining('closed before any ClientHello arrived') as unknown,
      },
    });
  });
});
