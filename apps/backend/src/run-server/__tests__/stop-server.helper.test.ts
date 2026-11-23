import { describe, expect, it } from 'vitest';
import { closeServer } from '../stop-server.helper.js';

/** Plain fakes that record the order in which a server is taken down. */
function fakes(closeAll: () => Promise<void> = () => Promise.resolve()) {
  const events: string[] = [];
  const built = {
    listening: {
      close: () => {
        events.push('stop listening');

        return undefined;
      },
    },
    conversations: {
      closeAll: () => {
        events.push('close conversations');

        return closeAll();
      },
    },
  };
  const presence = {
    remove: () => {
      events.push('remove file');

      return Promise.resolve();
    },
    release: () => {
      events.push('release lock');

      return Promise.resolve();
    },
  };

  return { events, built, presence };
}

describe('closeServer', () => {
  it('takes the server down in the order clients and a successor need: file, port, conversations, lock', async () => {
    const { events, built, presence } = fakes();

    await closeServer({ built, presence });

    expect(events).toEqual([
      'remove file',
      'stop listening',
      'close conversations',
      'release lock',
    ]);
  });

  it('releases the lock even when a conversation fails to close, and reports that failure', async () => {
    const stuck = new Error('a conversation would not close');
    const { events, built, presence } = fakes(() => Promise.reject(stuck));

    await expect(closeServer({ built, presence })).rejects.toBe(stuck);
    expect(events.at(-1)).toBe('release lock');
  });

  it('takes a server with no presence down too: nothing to remove, nothing to release', async () => {
    const { events, built } = fakes();

    await closeServer({ built, presence: undefined });

    expect(events).toEqual(['stop listening', 'close conversations']);
  });
});
