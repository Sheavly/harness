import { describe, expect, it } from 'vitest';
import { MAX_RESOLVED_IDS } from '../chat.constants.js';
import { OwedMessages } from '../owed-messages.service.js';
import { messageIdOf } from '../testing/feed-items.fake.js';

describe('OwedMessages', () => {
  it('owes a line from its answer until it is settled', () => {
    const owed = new OwedMessages();

    expect(owed.none).toBe(true);
    owed.owe(messageIdOf(1));
    expect(owed.none).toBe(false);
    owed.settle(messageIdOf(1));
    expect(owed.none).toBe(true);
  });

  it('owes a line by its id: another line’s end pays nothing of it', () => {
    const owed = new OwedMessages();

    owed.owe(messageIdOf(1));
    owed.owe(messageIdOf(2));
    owed.settle(messageIdOf(2));
    expect(owed.none).toBe(false);
    owed.settle(messageIdOf(1));
    expect(owed.none).toBe(true);
  });

  it('does not owe a line whose notice came before its answer', () => {
    const owed = new OwedMessages();

    owed.settle(messageIdOf(1));
    owed.owe(messageIdOf(1));

    expect(owed.none).toBe(true);
  });

  it('forgets the oldest notices past the cap, so only the recent ones are ahead of their answer', () => {
    const owed = new OwedMessages();

    for (let n = 1; n <= MAX_RESOLVED_IDS + 1; n += 1) owed.settle(messageIdOf(n));

    owed.owe(messageIdOf(1));
    expect(owed.none).toBe(false);

    owed.clear();
    owed.owe(messageIdOf(MAX_RESOLVED_IDS + 1));
    expect(owed.none).toBe(true);
  });

  it('owes nothing once cleared', () => {
    const owed = new OwedMessages();

    owed.owe(messageIdOf(1));
    owed.clear();

    expect(owed.none).toBe(true);
  });
});
