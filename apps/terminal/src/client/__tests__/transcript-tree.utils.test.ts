import { describe, expect, it } from 'vitest';
import { approvalRequest, treeEntry } from '@sheavly/client/testing/frames.fake';
import { nodeInfoSchema } from '@sheavly/protocol/node/node.validator';
import type { TreeView } from '@sheavly/protocol/tree/tree.types';
import { treeChannelEntrySchema } from '@sheavly/protocol/tree/tree.validator';
import { MAIN_AGENT, childNode } from '../../testing/tree-feed.fake.js';
import { itemsOfTreeEntry } from '../transcript.utils.js';

const MESSAGE = '00000000-0000-4000-8000-000000000001';

/** A tree holding `nodes`, as it stands. */
const viewOf = (...nodes: object[]): TreeView => ({
  nodes: nodes.map((node) => nodeInfoSchema.parse(node)),
  approvals: [],
});

/** What the entry of `type` shows, between the tree `before` and the tree `after` it. */
function shown(params: {
  type: string;
  fields?: object;
  before?: TreeView;
  after?: TreeView;
}): ReturnType<typeof itemsOfTreeEntry> {
  const { type, fields = {}, before = viewOf(MAIN_AGENT), after = before } = params;

  return itemsOfTreeEntry({
    entry: treeChannelEntrySchema.parse(treeEntry({ n: 2, type, fields })),
    before,
    after,
  });
}

/** A sub-agent entry of `type`: the tree before it is `before`, and the one after it holds the node. */
function agentEntry(params: {
  type: 'node_opened' | 'node_updated' | 'node_closed';
  node: ReturnType<typeof childNode>;
  parents?: object[];
  before?: object[];
}) {
  const { type, node, parents = [], before = [] } = params;

  return shown({
    type,
    fields: { node },
    before: viewOf(MAIN_AGENT, ...parents, ...before),
    after: viewOf(MAIN_AGENT, ...parents, node),
  });
}

describe('itemsOfTreeEntry: the conversation’s notices', () => {
  it('shows a queue change, a prompt that started and one that was refused as the entry says them', () => {
    expect(shown({ type: 'queue_changed', fields: { queued: ['next'] } })).toEqual([
      { type: 'queue_changed', queued: ['next'] },
    ]);
    expect(
      shown({ type: 'prompt_started', fields: { text: 'go', messageId: MESSAGE, queued: ['b'] } }),
    ).toEqual([{ type: 'prompt_started', text: 'go', messageId: MESSAGE, queued: ['b'] }]);
    expect(
      shown({ type: 'prompt_refused', fields: { text: 'rm', error: 'no skill', queued: [] } }),
    ).toEqual([{ type: 'prompt_refused', text: 'rm', error: 'no skill', queued: [] }]);
  });

  it('shows a storage failure, and an extension’s event with what it carries', () => {
    expect(shown({ type: 'storage_failed', fields: { error: 'disk full' } })).toEqual([
      { type: 'storage_failed', error: 'disk full' },
    ]);
    expect(
      shown({
        type: 'extension_event',
        fields: { extension: 'demo', kind: 'demo.note', version: 2, data: { a: 1 }, text: 'note' },
      }),
    ).toEqual([
      {
        type: 'extension_event',
        extension: 'demo',
        kind: 'demo.note',
        version: 2,
        data: { a: 1 },
        text: 'note',
      },
    ]);
  });

  it('shows nothing for the channel’s own opening and closing or for an approval, which has its own watcher', () => {
    expect(shown({ type: 'closed' })).toEqual([]);
    expect(
      shown({
        type: 'approval_requested',
        fields: { node: 'main', request: approvalRequest('a-1') },
      }),
    ).toEqual([]);
    expect(shown({ type: 'approval_cancelled', fields: { node: 'main', id: 'a-1' } })).toEqual([]);
  });
});

describe('itemsOfTreeEntry: sub-agent cards', () => {
  const worker = childNode({ id: 'worker', kind: 'agent' });

  it('shows a sub-agent that starts, one level under the main agent (depth 2, as a session counts it)', () => {
    expect(agentEntry({ type: 'node_opened', node: worker })).toEqual([
      {
        type: 'agent',
        change: 'started',
        agent: {
          id: 'worker',
          title: 'worker',
          depth: 2,
          parent: 'main',
          root: 'main',
          state: 'running',
        },
      },
    ]);
  });

  it('places a grandchild one level further down (depth 3), under the top of its parent chain', () => {
    const [item] = agentEntry({
      type: 'node_opened',
      node: childNode({ id: 'helper', kind: 'agent', parent: 'worker' }),
      parents: [worker],
    });

    expect(item).toMatchObject({
      change: 'started',
      agent: { depth: 3, parent: 'worker', root: 'main' },
    });
  });

  it('shows a sub-agent that says what it is doing now, and not one whose update says nothing new', () => {
    const reading = childNode({ id: 'worker', kind: 'agent', status: 'reading' });
    const [item] = agentEntry({ type: 'node_updated', node: reading, before: [worker] });

    expect(item).toMatchObject({ change: 'status', agent: { status: 'reading' } });
    expect(agentEntry({ type: 'node_updated', node: reading, before: [reading] })).toEqual([]);
    expect(agentEntry({ type: 'node_updated', node: worker, before: [worker] })).toEqual([]);
  });

  it('shows a sub-agent that ends, in the state it ended in', () => {
    const [item] = agentEntry({
      type: 'node_closed',
      node: childNode({ id: 'worker', kind: 'agent', state: 'completed' }),
      before: [worker],
    });

    expect(item).toMatchObject({ change: 'ended', agent: { id: 'worker', state: 'completed' } });
  });

  it('keeps how a sub-agent’s last run ended, which its state folds together: a turn limit is a failed agent that hit max_turns', () => {
    const [limit] = agentEntry({
      type: 'node_closed',
      node: childNode({ id: 'worker', kind: 'agent', state: 'failed', outcome: 'max_turns' }),
      before: [worker],
    });
    const [stopped] = agentEntry({
      type: 'node_closed',
      node: childNode({ id: 'worker', kind: 'agent', state: 'cancelled', outcome: 'interrupted' }),
      before: [worker],
    });

    expect(limit).toMatchObject({ agent: { state: 'failed', outcome: 'max_turns' } });
    expect(stopped).toMatchObject({ agent: { state: 'cancelled', outcome: 'interrupted' } });
  });

  it('shows no card for a command or a service, whose task the main agent’s events tell, or for the main agent', () => {
    for (const kind of ['command', 'service'] as const) {
      expect(agentEntry({ type: 'node_opened', node: childNode({ id: 'job', kind }) })).toEqual([]);
    }

    expect(shown({ type: 'node_opened', fields: { node: MAIN_AGENT } })).toEqual([]);
  });

  it('ends the walk up the parents in a tree whose parents are in a circle', () => {
    const [item] = shown({
      type: 'node_opened',
      fields: { node: childNode({ id: 'c', kind: 'agent', parent: 'a' }) },
      after: viewOf(
        childNode({ id: 'a', kind: 'agent', parent: 'b' }),
        childNode({ id: 'b', kind: 'agent', parent: 'a' }),
        childNode({ id: 'c', kind: 'agent', parent: 'a' }),
      ),
    });

    // Three nodes in the circle: the walk stops after three, so the depth is one more.
    expect(item).toMatchObject({ type: 'agent', agent: { depth: 4 } });
  });
});
