import { baseConfig, conversationChannelConfinement } from '@sheavly/eslint-config';

export default [
  ...baseConfig({ tsconfigRootDir: import.meta.dirname }),
  // The subscription code serves a conversation's own channels by name, through the family.
  conversationChannelConfinement,
];
