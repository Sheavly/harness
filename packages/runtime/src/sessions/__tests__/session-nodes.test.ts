import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { SessionInfo } from '@sheavly/protocol/session/session.types';
import { describe, expect, it } from 'vitest';
import { NodeRegistry } from '../../nodes/node-registry.service.js';
import { SessionRegistry } from '../sessions.service.js';

const MAIN = sessionIdSchema.parse('main');
const CALL = callIdSchema.parse('call_1');

/** A registry with a main session and a sub-agent it started. */
function started() {
  const sessions = new SessionRegistry();
  const main = sessions.startMain({ title: 'main', id: MAIN });
  const child = sessions.startChild({ parentId: main.id, startedByCall: CALL, title: 'sub' });

  return { sessions, main, child };
}

function nodeOf(params: { sessions: SessionRegistry; id: SessionInfo['id'] }) {
  const nodeId = params.sessions.nodeIdOf(params.id);

  return nodeId === undefined ? undefined : params.sessions.nodes.get(nodeId);
}

describe('a session', () => {
  it('is an agent node of the registry, started under the node of its parent', () => {
    const { sessions, main, child } = started();
    const mainNode = nodeOf({ sessions, id: main.id });
    const childNode = nodeOf({ sessions, id: child.id });

    expect(mainNode).toMatchObject({ kind: 'agent', title: 'main', state: 'running' });
    expect(childNode).toMatchObject({
      kind: 'agent',
      title: 'sub',
      parent: mainNode?.id,
      spawnedBy: CALL,
    });
  });

  it('reads depth and root from the nodes above it', () => {
    const { sessions, main, child } = started();
    const grandchild = sessions.startChild({
      parentId: child.id,
      startedByCall: callIdSchema.parse('call_2'),
      title: 'deep',
    });

    expect([main, child, grandchild].map((ref) => sessions.get(ref.id)?.depth)).toEqual([1, 2, 3]);
    expect(sessions.get(grandchild.id)?.rootId).toBe(main.id);
  });

  it('moves with its node: running, idle, running again, ended', () => {
    const { sessions, child } = started();
    const node = () => nodeOf({ sessions, id: child.id });

    sessions.idle({ id: child.id, outcome: 'completed' });
    expect([sessions.get(child.id)?.state, node()?.state]).toEqual(['idle', 'idle']);

    sessions.resume(child.id);
    expect([sessions.get(child.id)?.state, node()?.state]).toEqual(['running', 'running']);

    sessions.end({ id: child.id, state: 'max_turns' });

    // A session reports how its last run ended; its node, the state that outcome gives.
    expect([sessions.get(child.id)?.state, node()?.state]).toEqual(['max_turns', 'failed']);
    expect(node()?.lastOutcome).toBe('max_turns');
  });

  it('keeps its status and model in the node, and tells the node’s channel', () => {
    const { sessions, child } = started();

    sessions.report({ id: child.id, status: 'editing' });
    sessions.end({ id: child.id, state: 'completed' });

    const node = nodeOf({ sessions, id: child.id });
    const entries = node ? sessions.nodes.channel(node.id).read(0) : [];

    expect(node?.status).toBe('editing');
    expect(entries.map((entry) => entry.type)).toEqual(['opened', 'updated', 'closed']);
  });

  it('is gone from the node registry once released, and its node id is released too', () => {
    const { sessions, child } = started();
    const nodeId = sessions.nodeIdOf(child.id);

    sessions.end({ id: child.id, state: 'completed' });
    sessions.release(child.id);

    expect(sessions.nodeIdOf(child.id)).toBeUndefined();
    expect(nodeId && sessions.nodes.isReleased(nodeId)).toBe(true);
    expect(sessions.get(child.id)).toBeUndefined();
  });

  it('shares its registry: a registry handed in holds the same nodes the sessions see', () => {
    const nodes = new NodeRegistry();
    const sessions = new SessionRegistry({ nodes });
    const main = sessions.startMain({ title: 'main', id: MAIN });

    expect(sessions.nodes).toBe(nodes);
    expect(nodes.list().map((node) => node.id)).toEqual([sessions.nodeIdOf(main.id)]);
  });

  it('is not seen as a session when the node registry holds other nodes too', () => {
    const nodes = new NodeRegistry();
    const sessions = new SessionRegistry({ nodes });

    nodes.open({ kind: 'command', title: 'tests' });
    sessions.startMain({ title: 'main', id: MAIN });

    expect(sessions.list().map((session) => session.title)).toEqual(['main']);
    expect(nodes.list()).toHaveLength(2);
  });
});
