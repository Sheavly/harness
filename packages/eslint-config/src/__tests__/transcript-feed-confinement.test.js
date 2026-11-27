import { beforeAll, describe, expect, it } from 'vitest';
import { transcriptFeedConfinement } from '../transcript-feed-confinement.js';
import { lintApp } from '../testing/app-lint.fake.js';

const terminal = lintApp({ app: 'terminal' });

// The program the lints run on is built once, here, so no test's limit pays for it.
beforeAll(() => terminal.warm('src/chat/start.helper.ts'), 180_000);

// The chat and the TUI, with their tests and fakes: a test of the chat must not drive it with the
// stream it no longer reads.
const CONFINED_FILES = [
  'src/chat/chat-session.service.ts',
  'src/chat/__tests__/chat-session-run.service.test.ts',
  'src/chat/testing/chat-session.fake.ts',
  'src/tui/chat-screen.service.ts',
  'src/tui/__tests__/chat-screen.service.test.ts',
];
// What reads the stream on purpose: rendering, the workbook, replay and the client itself.
const FREE_FILES = [
  'src/render/render.service.ts',
  'src/render/__tests__/render.service.test.ts',
  'src/workbook/run.helper.ts',
  'src/replay/summary.utils.ts',
  'src/replay/testing/stream.fake.ts',
  'src/client/conversation.service.ts',
  'src/client/__tests__/follow.test.ts',
];
const FORBIDDEN_IMPORTS = [
  "import { followConversation } from '@sheavly/client/client/follow.helper';\nvoid followConversation;\n",
  "import { promptEntries } from '@sheavly/client/prompt/prompt.helper';\nvoid promptEntries;\n",
  "import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';\nexport type Entry = StreamEntry;\n",
  "import { runEnd } from '@sheavly/protocol/status/run-end.utils';\nvoid runEnd;\n",
];

// The chat reads the transcript feed, so the stream readers and the stream's own types stay out of
// it. A static import and a re-export are seen, a type import included; an `import('…')`, a
// `createRequire` and a relative path into another package are not, and stay with review.
describe('the terminal chat and TUI', () => {
  it('are confined by one block, for the chat and TUI folders, tests and fakes included', () => {
    expect(transcriptFeedConfinement.files).toEqual([
      'src/chat/**/*.{ts,tsx,js,mjs}',
      'src/tui/**/*.{ts,tsx,js,mjs}',
    ]);
    expect(transcriptFeedConfinement.ignores).toBeUndefined();
    expect(transcriptFeedConfinement.rules['no-restricted-imports'][0]).toBe('error');
  });

  it.each(FORBIDDEN_IMPORTS)(
    'refuse %s in every chat and TUI file, with the reason',
    async (code) => {
      for (const file of CONFINED_FILES) {
        const messages = await terminal.reports({ code, file });

        expect(messages, file).toHaveLength(1);
        expect(messages[0].message, file).toContain('watchTranscript');
      }
    },
  );

  // Replay has its own rule against the client's modules, so only this block's message is told.
  it.each(FORBIDDEN_IMPORTS)('allow %s in the rest of the app', async (code) => {
    for (const file of FREE_FILES) {
      const messages = await terminal.reports({ code, file });

      expect(
        messages.filter(({ message }) => message.includes('watchTranscript')),
        file,
      ).toHaveLength(0);
    }
  });

  it('refuse a re-export of a stream reader', async () => {
    const code = "export { runEnd } from '@sheavly/protocol/status/run-end.utils';\n";
    const messages = await terminal.reports({ code, file: CONFINED_FILES[0] });

    expect(messages).toHaveLength(1);
  });

  it('let the chat import the rest of the client and of the protocol', async () => {
    const code = [
      "import type { QueueUpdate } from '@sheavly/protocol/queue/queue.types';",
      "import type { EntryEvent } from '@sheavly/protocol/event/event.types';",
      'export type Both = [QueueUpdate, EntryEvent];',
      '',
    ].join('\n');

    for (const file of CONFINED_FILES) {
      expect(await terminal.reports({ code, file }), file).toHaveLength(0);
    }
  });
});
