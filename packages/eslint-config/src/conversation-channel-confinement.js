// The host serves a conversation's own channels (the tree, and the ones added to the family) through
// `ConversationChannels`, by the name a request gives, and knows none of them by its own: a second
// channel is served by adding it to the family, not by another branch in the subscription code. So
// the host's subscription source imports neither the tree writer nor the tree's name. The host
// workspace spreads `conversationChannelConfinement` into its config. What only the tree has
// (the notices the host tells it, `GET /tree`) is reached through `Harness.treeChannel`, outside
// this folder.

const MESSAGE =
  "The host's subscription code serves a conversation's own channels by name through `ConversationChannels` (`harness.conversationChannels.get(name)`, `isConversationChannel`), and knows none by its own name: a channel added to the family is served with no change here. See 'The conversation's own channels' in packages/protocol/docs/wire-model.md.";

export const conversationChannelConfinement = {
  files: ['src/subscriptions/**/*.ts'],
  // Tests build the tree writer to exercise the family.
  ignores: ['src/subscriptions/**/__tests__/**'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          { name: '@sheavly/runtime/nodes/tree-channel-writer.service', message: MESSAGE },
          {
            name: '@sheavly/protocol/node/node.constants',
            importNames: ['TREE_CHANNEL_NAME'],
            message: MESSAGE,
          },
        ],
      },
    ],
  },
};
