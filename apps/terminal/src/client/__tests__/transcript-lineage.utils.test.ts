import { describe, expect, it } from 'vitest';
import { agentNode } from '@sheavly/client/testing/frames.fake';
import { nodeInfoSchema } from '@sheavly/protocol/node/node.validator';
import { childNode, lostAgent } from '../../testing/tree-feed.fake.js';
import { mainLineageOf } from '../transcript.utils.js';

const treeOf = (...nodes: object[]) => ({
  nodes: nodes.map((node) => nodeInfoSchema.parse(node)),
  approvals: [],
});

describe('mainLineageOf', () => {
  it('lists the main agent and the ones a reopened conversation had before it, oldest first', () => {
    const tree = treeOf(lostAgent('first'), lostAgent('second'), agentNode({ id: 'main' }));

    expect(mainLineageOf(tree)).toEqual(['first', 'second', 'main']);
  });

  it('leaves out the agents that have a parent, and commands and services', () => {
    const tree = treeOf(
      agentNode({ id: 'main' }),
      childNode({ id: 'helper', kind: 'agent' }),
      childNode({ id: 'build', kind: 'command' }),
      childNode({ id: 'dev', kind: 'service' }),
    );

    expect(mainLineageOf(tree)).toEqual(['main']);
  });

  it('is empty for a tree with no agent without a parent', () => {
    expect(mainLineageOf(treeOf())).toEqual([]);
  });
});
