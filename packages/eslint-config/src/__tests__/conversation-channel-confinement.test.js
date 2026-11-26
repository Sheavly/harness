import path from 'node:path';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { conversationChannelConfinement } from '../conversation-channel-confinement.js';
import { sourceFilesUnder } from '../testing/source-files.fake.js';

const HOST = path.resolve(import.meta.dirname, '../../../host');
const IMPORTS = 'no-restricted-imports';
const eslint = new ESLint({ cwd: HOST });

/** The ids of the rules `code` breaks, linted with `conversationChannelConfinement`'s rules. */
function broken(code) {
  const messages = new Linter().verify(
    code,
    [
      {
        files: ['**/*.ts'],
        // The host's source is TypeScript: a type import is one of the forms that must be refused.
        languageOptions: { parser: tseslint.parser, sourceType: 'module', ecmaVersion: 'latest' },
        rules: conversationChannelConfinement.rules,
      },
    ],
    'subscription.ts',
  );

  return messages.map((message) => message.ruleId);
}

/**
 * The rule as the host's real config resolves it for `file`: its options when it is an error, else
 * 'off'. Comparing options, not only the level, catches a later block that replaces them.
 */
async function resolvedFor(file) {
  const config = await eslint.calculateConfigForFile(path.join(HOST, file));
  const [level, ...options] = config?.rules[IMPORTS] ?? [0];

  return level === 2 ? options : 'off';
}

const confined = conversationChannelConfinement.rules[IMPORTS].slice(1);

describe('conversationChannelConfinement', () => {
  it.each([
    "import { TreeChannelWriter } from '@sheavly/runtime/nodes/tree-channel-writer.service';",
    "import type { TreeChannelWriter } from '@sheavly/runtime/nodes/tree-channel-writer.service';",
    "import { TREE_CHANNEL_NAME } from '@sheavly/protocol/node/node.constants';",
    "import { MAX_TREE_NODES, TREE_CHANNEL_NAME } from '@sheavly/protocol/node/node.constants';",
  ])('rejects naming the tree: %s', (code) => {
    expect(broken(code)).toEqual([IMPORTS]);
  });

  it.each([
    "import type { ConversationChannels } from '@sheavly/runtime/nodes/conversation-channels.service';",
    "import { isConversationChannel } from '@sheavly/protocol/channel/channel.utils';",
    "import { MAX_TREE_NODES } from '@sheavly/protocol/node/node.constants';",
    "import { StoreError } from '@sheavly/core/errors/store.errors';",
  ])('accepts serving a channel through the family and what is not the tree’s name: %s', (code) => {
    expect(broken(code)).toEqual([]);
  });

  it('holds, with its own options, for every host subscription source file', async () => {
    const sources = sourceFilesUnder({ root: HOST, folder: 'src/subscriptions' }).filter((file) =>
      file.endsWith('.ts'),
    );

    expect(sources).toContain('src/subscriptions/subscription.service.ts');

    for (const file of sources) {
      expect(await resolvedFor(file), file).toEqual(confined);
    }
  });

  it('is off for the tests, which build the tree writer to exercise the family, and for the rest of the host', async () => {
    for (const file of [
      'src/subscriptions/__tests__/subscription-tree.test.ts',
      'src/conversations/lifecycle.helper.ts',
      'src/host/host.helper.ts',
    ]) {
      expect(await resolvedFor(file), file).toEqual('off');
    }
  });
});
