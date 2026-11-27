// The terminal's chat and TUI read the conversation through the transcript feed
// (`RemoteConversation.watchTranscript`); the stream readers are for the workbook, the demo and
// replay. The terminal app spreads `transcriptFeedConfinement` into its config; its files are
// relative to that app, and tests and fakes are held to it too, so a test cannot drive the chat
// with the stream it no longer reads.

const MESSAGE =
  'The chat and the TUI read the transcript feed (`RemoteConversation.watchTranscript`), not the stream: the stream and its readers are for the workbook, the demo and replay.';

/** The stream readers and the stream's own types and helpers, by module. */
const STREAM_MODULES = [
  '@sheavly/client/client/follow.helper',
  '@sheavly/client/prompt/prompt.helper',
  '@sheavly/protocol/stream/stream.types',
  '@sheavly/protocol/status/run-end.utils',
];

export const transcriptFeedConfinement = {
  files: ['src/chat/**/*.{ts,tsx,js,mjs}', 'src/tui/**/*.{ts,tsx,js,mjs}'],
  rules: {
    'no-restricted-imports': [
      'error',
      { paths: STREAM_MODULES.map((name) => ({ name, message: MESSAGE })) },
    ],
  },
};
