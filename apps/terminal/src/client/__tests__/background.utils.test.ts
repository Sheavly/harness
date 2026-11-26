import { describe, expect, it } from 'vitest';
import { treeSnapshotSchema } from '@sheavly/protocol/tree/tree.validator';
import { MAIN_AGENT, childNode } from '../../testing/tree-feed.fake.js';
import { backgroundOf, sameBackground } from '../background.utils.js';

/** A tree the contract's schema accepts: the main agent and `nodes`. */
const treeOf = (...nodes: object[]) =>
  treeSnapshotSchema.parse({
    channel: 'tree',
    cursor: 's1',
    at: 1,
    type: 'snapshot',
    nodes: [MAIN_AGENT, ...nodes],
    approvals: [],
  });

describe('backgroundOf', () => {
  it('counts what runs under the main agent, by kind, and never the main agent', () => {
    expect(backgroundOf(treeOf())).toEqual({ tasks: 0, agents: 0, services: 0 });
    expect(
      backgroundOf(
        treeOf(
          childNode({ id: 'c1', kind: 'command' }),
          childNode({ id: 'c2', kind: 'command' }),
          childNode({ id: 's1', kind: 'service' }),
          childNode({ id: 'a1', kind: 'agent' }),
        ),
      ),
    ).toEqual({ tasks: 2, agents: 1, services: 1 });
  });

  it('does not count a node that ended', () => {
    expect(
      backgroundOf(
        treeOf(
          childNode({ id: 'c1', kind: 'command', state: 'completed' }),
          childNode({ id: 'a1', kind: 'agent', state: 'completed' }),
        ),
      ),
    ).toEqual({ tasks: 0, agents: 0, services: 0 });
  });
});

describe('sameBackground', () => {
  it('says whether two counts are the same', () => {
    const a = { tasks: 1, agents: 2, services: 3 };

    expect(sameBackground({ a, b: { ...a } })).toBe(true);
    expect(sameBackground({ a, b: { ...a, services: 0 } })).toBe(false);
  });
});
