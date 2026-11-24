// A stored `profile.json`, conversation `index.json` and `stream.jsonl` are read through the
// schemas that also take the files written before "mode" became "effort" (`legacy-effort/` in
// `@sheavly/storage`); the plain protocol schemas reject those files, so a store that parsed with
// them would lose old data.
// A conversation's channel logs (`channels/<channel>.jsonl`) have no old form, but a log is read a
// line at a time through the one stored entry (`storedChannelEntrySchema`, taken from the
// protocol's schema once): `channelLogSchema` and `channelBoundarySchema` check a whole array of
// entries, which a log is never held as (a channel may hold 128 MiB), and a second schema of a line
// is a second definition of what a stored entry is.
// The storage package spreads `storedFileReads` into its config; its files are relative to it.

export const storedFileReads = {
  files: ['src/**/*.ts'],
  // The migration itself, the one module that derives the stored entry, and the tests may use the
  // plain schemas.
  ignores: [
    'src/legacy-effort/**',
    'src/conversation-store/channel-entry.validator.ts',
    'src/**/__tests__/**',
  ],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@sheavly/protocol/profile/profile.validator',
            importNames: ['profileSchema'],
            message:
              'Read a stored profile.json with storedProfileFileSchema (legacy-effort/legacy-effort.validator): profileSchema rejects files written before "mode" became "effort".',
          },
          {
            name: '@sheavly/protocol/store/store.validator',
            importNames: ['storedConversationSchema'],
            message:
              'Read a stored index.json with storedConversationIndexSchema (legacy-effort/legacy-effort.validator): storedConversationSchema rejects files written before "mode" became "effort".',
          },
          {
            name: '@sheavly/protocol/stream/stream.validator',
            importNames: ['streamEntrySchema'],
            message:
              'Read a stored stream.jsonl with storedStreamEntrySchema (legacy-effort/legacy-effort.validator): streamEntrySchema rejects lines written before "mode" became "effort".',
          },
          {
            name: '@sheavly/protocol/channel/channel.validator',
            importNames: ['channelLogSchema', 'channelBoundarySchema'],
            message:
              'Read a stored channel log a line at a time with storedChannelEntrySchema (conversation-store/channel-entry.validator): channelLogSchema and channelBoundarySchema check a whole array of entries or one type of them, and a channel log is never held whole.',
          },
        ],
      },
    ],
  },
};
