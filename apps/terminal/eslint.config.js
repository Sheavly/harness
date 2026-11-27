import { defineConfig } from 'eslint/config';
import {
  baseConfig,
  connectBackendConfinement,
  replayConfinement,
  transcriptFeedConfinement,
} from '@sheavly/eslint-config';

export default defineConfig([
  // An app: baseConfig lets its source read env, print and use the terminal (it is in apps/).
  ...baseConfig({
    tsconfigRootDir: import.meta.dirname,
    // The CLI entry points: files without a kind.
    entryFiles: ['src/chat.ts', 'src/demo.ts', 'src/replay.ts', 'src/workbook/workbook.ts'],
  }),
  // Ctrl+C is `interruptOnCtrlC`'s: no entry point or helper listens for SIGINT itself.
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/**/__tests__/**'],
    rules: { 'harness/no-adhoc-ctrl-c': 'error' },
  },
  // The one place the listener is installed.
  {
    files: ['src/interrupt/interrupt.helper.ts'],
    rules: { 'harness/no-adhoc-ctrl-c': 'off' },
  },
  // The workbook is a developer tool: it records each run (events, transcript, results) and
  // prepares a scratch workspace in its own folder, and `saveRawStream` logs the SSE stream to a
  // file for the demo and the recorder. None of it is the user's data, which is
  // `@sheavly/storage`'s (`harness/no-direct-file-writes`).
  {
    files: [
      'src/client/raw-stream.helper.ts',
      'src/workbook/recorder.service.ts',
      'src/workbook/store.service.ts',
      'src/workbook/check.helper.ts',
    ],
    rules: { 'harness/no-direct-file-writes': 'off' },
  },
  // The code that starts the terminal's own backend never reads the discovery file or takes the
  // lock, so a development terminal cannot attach to a stable server.
  connectBackendConfinement,
  // The chat and the TUI read the transcript feed, never the stream: the stream readers are for the
  // workbook, the demo and replay.
  transcriptFeedConfinement,
  // Replay reads a stored stream and nothing else: no network, process, backend or model. Last,
  // so no block above or after can weaken it.
  replayConfinement,
]);
