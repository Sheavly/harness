import { baseConfig } from '@sheavly/eslint-config';

export default baseConfig({
  tsconfigRootDir: import.meta.dirname,
  // The command line's entry point: a file without a kind.
  entryFiles: ['src/cli.ts'],
});
