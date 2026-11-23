import { defineConfig } from 'eslint/config';
import { baseConfig, connectionConfinement, systemdConfinement } from '@sheavly/eslint-config';

export default defineConfig([
  ...baseConfig({
    tsconfigRootDir: import.meta.dirname,
    // The command line's entry point: a file without a kind.
    entryFiles: ['src/cli.ts'],
  }),
  // systemd's programs are run only behind `SystemTools`, which only cli.ts creates for real.
  ...systemdConfinement,
  // After it: the connection command repeats the real-tools restriction, since a rule set twice
  // for one file keeps only the later options.
  connectionConfinement,
]);
