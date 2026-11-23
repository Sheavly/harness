import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@sheavly/logger/logger/logger.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { useTempFolders } from '@sheavly/testing/files/temp-folders.fake';
import { PlacedConversationStore } from '../placed-conversation-store.service.js';
import { Profiles } from '../profiles.service.js';

const folders = useTempFolders({ prefix: 'placed-log-sink-', names: ['app'] });
const ID = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000bb');
const ENTRY: LogEntry = {
  level: 'error',
  event: 'api.request_failed',
  time: 1,
  service: 'backend',
};

/** Profiles whose stores cannot be listed, as a broken home folder would. */
class UnreadableProfiles extends Profiles {
  override async everyStore(): Promise<never> {
    throw new Error('the profiles folder cannot be read');
  }
}

function placesOver(profiles: Profiles) {
  return new PlacedConversationStore({
    profiles,
    fallbackWorkspace: folders.app,
    onProblem: () => undefined,
  });
}

describe('a conversation’s log sink writes to the other sink', () => {
  it.each([
    ['when nothing kept the conversation', Profiles],
    ['not nowhere, when looking for the conversation fails', UnreadableProfiles],
  ])('%s', async (_name, Kind) => {
    const written: LogEntry[] = [];
    const profiles = new Kind({ env: { SHEAVLY_HOME: path.join(folders.base, 'home') } });
    const sink = placesOver(profiles).logSink({
      id: ID,
      otherwise: (entry) => void written.push(entry),
    });

    await sink(ENTRY);
    expect(written).toEqual([ENTRY]);
  });
});
