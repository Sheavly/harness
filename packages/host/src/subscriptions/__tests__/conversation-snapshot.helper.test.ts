import { describe, expect, it } from 'vitest';
import { StoreError } from '@sheavly/core/errors/store.errors';
import { snapshotOfChannel } from '../conversation-snapshot.helper.js';

/** A channel whose view is `view`, or that rejects with `error`. */
const channel = (outcome: { view: string } | { error: Error }) => ({
  snapshot: () =>
    'view' in outcome ? Promise.resolve(outcome.view) : Promise.reject(outcome.error),
});

const refusalOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (caughtError) {
    return caughtError;
  }

  return undefined;
};

describe('the view of a conversation’s own channel', () => {
  it('is what its writer says it is, whichever channel it is', async () => {
    expect(await snapshotOfChannel({ channel: channel({ view: 'the tree' }), name: 'tree' })).toBe(
      'the tree',
    );
  });

  it.each(['tree', 'usage'])(
    'is not found for a conversation that keeps no %s, and says which',
    async (name) => {
      expect(await refusalOf(snapshotOfChannel({ channel: undefined, name }))).toMatchObject({
        reason: 'not_found',
        message: `This conversation keeps no ${name}: its host stores nothing`,
      });
    },
  );

  it.each(['tree', 'usage'])(
    'is refused as a storage failure when the %s could not be stored, with the cause',
    async (name) => {
      const cause = new StoreError({ reason: 'failed', message: 'disk gone' });
      const refusal = await refusalOf(
        snapshotOfChannel({ channel: channel({ error: cause }), name }),
      );

      expect(refusal).toMatchObject({
        reason: 'storage_failed',
        message: `The ${name} of this conversation could not be stored (disk gone), so it has no snapshot`,
        cause,
      });
    },
  );

  it('lets a failure that is not the store’s through as it is', async () => {
    const odd = new TypeError('a bug');

    expect(
      await refusalOf(snapshotOfChannel({ channel: channel({ error: odd }), name: 'tree' })),
    ).toBe(odd);
  });
});
