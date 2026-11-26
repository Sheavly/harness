import type { TreeView } from '@sheavly/protocol/tree/tree.types';
import type { Background } from './client.types.js';

/**
 * The background work `tree` shows as running: every node that is running and has a parent. The
 * node with no parent is the conversation's main agent, which is the conversation and not work in
 * the background of it. A sub-agent is an agent, a service a service, and any other kind (a
 * command, or one an extension adds) a task. An ended or idle node is not running.
 */
export function backgroundOf(tree: TreeView): Background {
  const counts: Background = { tasks: 0, agents: 0, services: 0 };

  for (const node of tree.nodes) {
    if (node.parent === undefined || node.state !== 'running') continue;

    if (node.kind === 'agent') counts.agents += 1;
    else if (node.kind === 'service') counts.services += 1;
    else counts.tasks += 1;
  }

  return counts;
}

/** Whether two counts say the same. */
export const sameBackground = (params: { a: Background; b: Background }): boolean =>
  params.a.tasks === params.b.tasks &&
  params.a.agents === params.b.agents &&
  params.a.services === params.b.services;
