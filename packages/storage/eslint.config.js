import { defineConfig } from 'eslint/config';
import { baseConfig, storedFileReads } from '@sheavly/eslint-config';

export default defineConfig([
  ...baseConfig({ tsconfigRootDir: import.meta.dirname }),
  // Stored profiles and conversation indexes are read through the migration (`src/legacy-effort/`).
  storedFileReads,
  // The credential store is the one module that names the credentials file: it is where the file
  // is read, checked to be private and written. Nothing else in the repo may (`harness/no-credentials-file`).
  { files: ['src/credential-store/**'], rules: { 'harness/no-credentials-file': 'off' } },
  // The runtime folder reads the runtime-directory variable, and the discovery file module is the
  // one that names the file: where the server's lock and discovery file live is resolved only
  // here (`harness/no-discovery-path`).
  {
    // The finder's fake builds the folders and the environment of a server for its tests.
    files: ['src/server-runtime/**', 'src/discovery-file/**', 'src/server-finder/testing/**'],
    rules: { 'harness/no-discovery-path': 'off' },
  },
  // A bare `SerialQueue` orders one process only. These own a queue on purpose: the primitive
  // itself, the append-only logs (one writer per conversation, so no lock; a channel's log is one,
  // and reads nothing back to write) and the profile queue that orders a check with a delete, whose
  // config writes lock through the store.
  {
    files: [
      'src/serial-queue/locked-change.service.ts',
      'src/conversation-store/append-log.service.ts',
      'src/conversation-store/channel-file.service.ts',
      'src/profile-registry/profile-registry.service.ts',
    ],
    rules: { 'harness/no-raw-serial-queue': 'off' },
  },
  // These three modules are where files are written, so every store writes through them: an atomic
  // replace that is private and retried on Windows, an append for a stream, and the path checks.
  // Nothing else here (or anywhere) calls the file system's write functions
  // (`harness/no-direct-file-writes`).
  {
    // `output-store/` appends a command's output to its log as it arrives, privately, under a
    // folder it names by a UUID (`namedPath`): a stream too large for an atomic whole-file write.
    files: [
      'src/json-file/**',
      'src/jsonl-file/**',
      'src/safe-path/**',
      // The cross-process lock is a file made and removed on purpose, holding only a process id.
      'src/file-lock/**',
      // The one-server lock is a socket file made and removed on purpose, with a guard file beside
      // it for the short time a stale one is taken over; the runtime folder is created private.
      'src/server-lock/**',
      'src/server-runtime/**',
      // The discovery file is written and removed on purpose: private, flushed, never half-written,
      // with checks `writeJsonFile` has no place for (a planted link, the umask).
      'src/discovery-file/**',
      // The finder's fake makes the private folders a server publishes in, for its tests.
      'src/server-finder/testing/**',
      'src/output-store/output-store.service.ts',
      'src/output-store/output-writer.service.ts',
      'src/output-store/__tests__/**',
    ],
    rules: { 'harness/no-direct-file-writes': 'off' },
  },
]);
