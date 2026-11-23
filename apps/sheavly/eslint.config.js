import { defineConfig } from 'eslint/config';
import {
  baseConfig,
  connectionConfinement,
  serverStartConfinement,
  systemdConfinement,
} from '@sheavly/eslint-config';

export default defineConfig([
  ...baseConfig({
    tsconfigRootDir: import.meta.dirname,
    // The command line's entry point: a file without a kind.
    entryFiles: ['src/cli.ts'],
  }),
  // systemd's programs are run only behind `SystemTools`, which only cli.ts creates for real.
  ...systemdConfinement,
  // Only cli.ts imports the module that starts a server. It repeats the systemd restrictions it
  // sits over, since a rule set twice for one file keeps only the later options.
  ...serverStartConfinement,
  // Last: the connection command repeats the real-tools restriction for its folder, so its own
  // list (which already refuses the backend) wins there.
  connectionConfinement,
]);
