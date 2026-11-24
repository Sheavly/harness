import { describe, expect, it } from 'vitest';
import type { SessionLifecycleUpdate } from '@sheavly/extension/run-services/run-services.types';
import { SESSION_INFO } from '@sheavly/extension/run-services/run-services.utils';
import { runSession } from '@sheavly/loop/stream-agent/stream-agent.helper';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import {
  calls,
  routedProvider,
  say,
  toolCall,
} from '@sheavly/testing/provider/routed-provider.fake';
import { createSubAgentTool } from '@sheavly/tools/sub-agent/sub-agent.tool';
import { createTaskTools } from '@sheavly/tools/tasks/tasks.tool';
import { registryScopes } from '@sheavly/tools/testing/registry-scopes.fake';
import { scopeRun } from '../../testing/scope-run.fake.js';

const reader = { name: 'reader', requires: [SESSION_INFO.name], grants: ['session:read'] };

describe('a release an extension is told of, from the run that makes it', () => {
  it('announces a sub-agent the loop released once its report was delivered, with its node gone', async () => {
    const run = scopeRun();
    const { sessions, tasks, nodes, mainSession } = run.harness;
    const heard: SessionLifecycleUpdate[] = [];
    const childNodes: NodeId[] = [];
    const nodeGoneWhenHeard: boolean[] = [];

    await run.activate([reader]);
    run
      .servicesOf('reader')
      .get(SESSION_INFO)
      .onLifecycle((update) => {
        heard.push(update);

        // The node is only readable while the session is live: take its id when it starts.
        const nodeId =
          update.type === 'session_started' && update.session.id !== mainSession.id
            ? sessions.nodeIdOf(update.session.id)
            : undefined;

        if (nodeId !== undefined) childNodes.push(nodeId);

        // What an extension may rely on when it hears the release: the node is already gone.
        const child = childNodes.at(0);

        if (update.type === 'session_released') {
          nodeGoneWhenHeard.push(child !== undefined && nodes.isReleased(child));
        }
      });

    const provider = routedProvider({
      Main: [
        calls(
          toolCall({
            id: 'm1',
            name: 'start_agent',
            input: { title: 'Researcher', task: 'Child' },
          }),
        ),
        () => [
          { type: 'text_delta', text: 'Read it.' },
          { type: 'done', stopReason: 'end_turn' },
        ],
      ],
      Child: [say('Findings')],
    });
    const tool = createSubAgentTool({
      scopes: registryScopes({ sessions, tasks, runAgent: runSession }),
      provider,
      tools: [],
    });

    await runSession({
      provider,
      tools: [tool, ...createTaskTools(tasks)],
      messages: [{ role: 'user', content: 'Main' }],
      tasks,
      session: { registry: sessions, ref: mainSession },
    });

    const released = heard.filter((update) => update.type === 'session_released');

    // The loop released the delivered sub-agent on its own, and the extension heard it once.
    expect(released).toHaveLength(1);
    expect(released[0]?.session).toMatchObject({ title: 'Researcher', state: 'completed' });
    // It is the release of the sub-agent's node: the node is gone and its id is never taken again.
    expect(childNodes).toHaveLength(1);
    // Announced after the node was released, not before: a listener never sees a live node for it.
    expect(nodeGoneWhenHeard).toEqual([true]);

    for (const nodeId of childNodes) {
      expect(nodes.get(nodeId)).toBeUndefined();
      expect(nodes.isReleased(nodeId)).toBe(true);
    }
  });
});
