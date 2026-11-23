import { MAX_TREE_NODES } from '@sheavly/protocol/node/node.constants';
import { nodeIdSchema } from '@sheavly/protocol/node/node.validator';
import { describe, expect, it } from 'vitest';
import { NodeRegistry } from '../node-registry.service.js';

/** A main agent with a sub-agent and a command under it, and a command nobody started. */
function tree() {
  const registry = new NodeRegistry();
  const main = registry.open({ kind: 'agent', title: 'main' });
  const sub = registry.open({ kind: 'agent', parent: main.id, title: 'sub' });
  const command = registry.open({ kind: 'command', parent: main.id, title: 'tests' });
  const loose = registry.open({ kind: 'service', title: 'server' });

  return { registry, main, sub, command, loose };
}

function refuses(act: () => unknown, reason: string): void {
  expect(act).toThrow(expect.objectContaining({ reason }));
}

describe('a node registry', () => {
  it('mints ids the protocol accepts as node ids, and never the same one twice', () => {
    const registry = new NodeRegistry();
    const ids = Array.from({ length: 50 }, () => registry.open({ kind: 'command', title: 'x' }).id);

    for (const id of ids) expect(nodeIdSchema.safeParse(id).success).toBe(true);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('starts a node only under a node it has, so none floats free', () => {
    const { registry, main } = tree();

    registry.endAgent({ id: main.id, outcome: 'completed' });

    // An ended parent still has children it started; only an unknown one is refused.
    expect(registry.open({ kind: 'command', parent: main.id, title: 'late' }).parent).toBe(main.id);
    refuses(
      () => registry.open({ kind: 'command', parent: nodeIdSchema.parse('nobody'), title: 'x' }),
      'unknown_node',
    );
  });

  it('knows how deep a node is: the main agent is 1', () => {
    const { registry, main, sub } = tree();
    const grandchild = registry.open({ kind: 'agent', parent: sub.id, title: 'deep' });

    expect([main, sub, grandchild].map((node) => registry.depth(node.id))).toEqual([1, 2, 3]);
  });

  it('lists a node and its ancestors, the root last', () => {
    const { registry, main, sub } = tree();
    const grandchild = registry.open({ kind: 'agent', parent: sub.id, title: 'deep' });

    expect(registry.lineage(grandchild.id).map((node) => node.id)).toEqual([
      grandchild.id,
      sub.id,
      main.id,
    ]);
  });

  it('lists the nodes a node started directly', () => {
    const { registry, main, sub, command } = tree();

    expect(registry.children(main.id).map((node) => node.id)).toEqual([sub.id, command.id]);
    expect(registry.children(sub.id)).toEqual([]);
  });
});

describe('ownership', () => {
  it('shows a caller what it started and what nobody did, and no one else’s', () => {
    const { registry, main, sub, command, loose } = tree();
    const below = registry.open({ kind: 'command', parent: sub.id, title: 'below' });

    expect(registry.list(sub.id).map((node) => node.id)).toEqual([main.id, loose.id, below.id]);
    expect(registry.list(main.id).map((node) => node.id)).toEqual([
      main.id,
      sub.id,
      command.id,
      loose.id,
    ]);
  });

  it('shows the host, which names no caller, every node', () => {
    const { registry } = tree();

    expect(registry.list()).toHaveLength(4);
  });

  it('hands out copies: changing one does not change the registry', () => {
    const { registry, main } = tree();
    const copy = registry.get(main.id);

    if (copy) copy.title = 'changed';

    expect(registry.get(main.id)?.title).toBe('main');
    expect(registry.list().find((node) => node.id === main.id)?.title).toBe('main');
  });
});

describe('releasing finished nodes', () => {
  it('refuses a subtree with a node still open, and removes nothing', () => {
    const { registry, main, sub } = tree();

    registry.endAgent({ id: sub.id, outcome: 'completed' });

    refuses(() => registry.release(main.id), 'node_running');
    expect(registry.get(sub.id)).toBeDefined();
    expect(registry.list()).toHaveLength(4);
  });

  it('removes an ended node and what it started, and returns them as they last were', () => {
    const { registry, main, sub, command } = tree();

    registry.endAgent({ id: sub.id, outcome: 'completed' });
    registry.endWork({ id: command.id, state: 'failed' });
    registry.endAgent({ id: main.id, outcome: 'completed' });

    const released = registry.release(main.id);

    expect(released.map((node) => node.id).sort()).toEqual([main.id, sub.id, command.id].sort());
    expect(released.find((node) => node.id === sub.id)?.state).toBe('completed');
    expect(registry.list().map((node) => node.title)).toEqual(['server']);
  });

  it('reads a released node as released, which is not the same as one that never was', () => {
    const { registry, sub } = tree();

    registry.endAgent({ id: sub.id, outcome: 'completed' });
    registry.release(sub.id);

    expect(registry.isReleased(sub.id)).toBe(true);
    expect(registry.get(sub.id)).toBeUndefined();
    refuses(() => registry.channel(sub.id), 'node_released');
    refuses(() => registry.endAgent({ id: sub.id, outcome: 'failed' }), 'node_released');
    refuses(
      () => registry.endAgent({ id: nodeIdSchema.parse('nobody'), outcome: 'failed' }),
      'unknown_node',
    );
    expect(registry.isReleased(nodeIdSchema.parse('nobody'))).toBe(false);
  });

  it('refuses to start a node under one that was released', () => {
    const { registry, sub } = tree();

    registry.endAgent({ id: sub.id, outcome: 'completed' });
    registry.release(sub.id);

    refuses(
      () => registry.open({ kind: 'command', parent: sub.id, title: 'orphan' }),
      'node_released',
    );
  });
});

describe('how many nodes a registry holds', () => {
  it('refuses one past the bound the tree’s snapshot holds, and takes another once one is released', () => {
    const registry = new NodeRegistry();
    const first = registry.open({ kind: 'command', title: 'first' });

    for (let held = 1; held < MAX_TREE_NODES; held++) {
      registry.open({ kind: 'command', title: 'more' });
    }

    refuses(() => registry.open({ kind: 'command', title: 'one too many' }), 'too_many_nodes');
    expect(registry.list()).toHaveLength(MAX_TREE_NODES);

    registry.endWork({ id: first.id, state: 'completed' });
    registry.release(first.id);

    expect(registry.open({ kind: 'command', title: 'room again' }).title).toBe('room again');
    expect(registry.list()).toHaveLength(MAX_TREE_NODES);
  });

  it('counts the nodes put back from a stored conversation too', () => {
    const registry = new NodeRegistry();

    for (let held = 0; held < MAX_TREE_NODES; held++) {
      registry.restore({
        kind: 'command',
        title: 'old',
        startedAt: 1,
        state: 'completed',
        endedAt: 2,
      });
    }

    refuses(() => registry.open({ kind: 'command', title: 'new' }), 'too_many_nodes');
  });
});

describe('a snapshot of the tree', () => {
  it('holds every node, an ended one included, and where to read on from', () => {
    const { registry, command } = tree();

    registry.endWork({ id: command.id, state: 'cancelled' });

    const snapshot = registry.snapshot();

    expect(snapshot.nodes).toHaveLength(4);
    expect(snapshot.nodes.find((node) => node.id === command.id)?.state).toBe('cancelled');
    expect(snapshot.cursor).toBe(registry.tree.next);
  });

  it('continues without a gap or a repeat: the entries after it are the changes since', () => {
    const { registry, main } = tree();
    const { cursor } = registry.snapshot();

    registry.setStatus({ id: main.id, status: 'editing' });
    registry.endAgent({ id: main.id, outcome: 'completed' });

    expect(registry.tree.read(cursor).map((entry) => entry.type)).toEqual(['updated', 'closed']);
  });
});
