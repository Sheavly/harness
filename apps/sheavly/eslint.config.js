import { defineConfig } from 'eslint/config';
import { baseConfig, systemdConfinement } from '@sheavly/eslint-config';

export default defineConfig([
  ...baseConfig({
    tsconfigRootDir: import.meta.dirname,
    // The command line's entry point: a file without a kind.
    entryFiles: ['src/cli.ts'],
  }),
  // systemd's programs are run only behind `SystemTools`, which only cli.ts creates for real.
  ...systemdConfinement,
]);
