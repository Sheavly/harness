import type { createClient } from '@sheavly/client/client/client.helper';
import { watchUsage } from '@sheavly/client/usage/watch-usage.helper';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { ContextFill, UsageView } from '@sheavly/protocol/usage/usage.types';
import { NoMainAgentError } from '../errors/transcript.errors.js';
import type { MainUsage } from './client.types.js';
import { mainAgentOf, mainLineageOf } from './transcript.utils.js';

/**
 * How full the main agent's context was at its last call that counts: its own record's, or, for a
 * reopened conversation whose new main agent has not made a call yet, the last one of the main
 * agents before it (`lineage`, oldest first), which is what the history it goes on from filled.
 * None when none of them has a measurement.
 */
function lastContextOf(params: {
  nodes: UsageView['nodes'];
  lineage: readonly NodeId[];
}): ContextFill | undefined {
  const { nodes, lineage } = params;

  for (const id of lineage.toReversed()) {
    const context = nodes.find(({ node }) => node === id)?.context;

    if (context !== undefined) return context;
  }

  return undefined;
}

/**
 * Follows conversation `id`'s usage as a status line shows it: the whole conversation's figures,
 * and how full the main agent's context is. The main agent is found once, in the tree as it stands
 * (`getTree`); a sub-agent's context never stands in for it, and a reopened conversation shows the
 * last measurement of its earlier main agents until the new one makes a call (each reopen makes a
 * new node, with no record yet). The backend counts the usage and each `onChange` replaces what the
 * last one said.
 *
 * Throws `NoMainAgentError` for a tree without a main agent. Resolves once the backend has accepted
 * the connection; `ended` resolves when `signal` aborts and rejects as the client's `watchUsage`
 * does (a usage channel that failed, a refusal, and what `onChange` throws). Aborting `signal` also
 * ends the read of the tree.
 */
export async function watchMainUsage(params: {
  client: ReturnType<typeof createClient>;
  id: ConversationId;
  onChange: (usage: MainUsage) => void;
  signal: AbortSignal;
}): Promise<{ ended: Promise<void> }> {
  const { client, id, onChange, signal } = params;
  const tree = await client.call('getTree', { id, signal });

  if (mainAgentOf(tree) === undefined) throw new NoMainAgentError();

  const lineage = mainLineageOf(tree);
  const watch = await watchUsage({
    client,
    id,
    signal,
    onChange: ({ total, nodes }) => onChange({ total, context: lastContextOf({ nodes, lineage }) }),
  });

  return { ended: watch.ended };
}
