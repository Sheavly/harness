import { NODE_STATE_OF_OUTCOME } from '../status/status.constants.js';
import type { StateOf } from '../status/status.types.js';
import { RESERVED_EXTENSION_NAMES } from './node.constants.js';

/**
 * Whether `name` (an extension's name, or an `<extension>.<name>` it owns) starts with a name that
 * is ours: a built-in node kind or the tree channel.
 */
export function isReservedExtensionName(name: string): boolean {
  const extension = name.split('.')[0] ?? '';

  return (RESERVED_EXTENSION_NAMES as readonly string[]).includes(extension);
}

/** The part of a node `isConsistentNode` reads, whatever type its ids have. */
type NodeFacts<Id extends string> = {
  id: Id;
  parent?: Id | undefined;
  kind: string;
  state: StateOf<'node'>;
  endedAt?: number | undefined;
  lastOutcome?: keyof typeof NODE_STATE_OF_OUTCOME | undefined;
};

/**
 * Whether a node holds together: it is not its own parent, and its state, end time and last
 * outcome agree. An open node (running, or idle, which only an agent is) has not ended, and an
 * ended one has an end time. An agent that ended by completing, failing or being cancelled has the
 * last outcome that state comes from (`NODE_STATE_OF_OUTCOME`); one that was `lost` is not checked,
 * since the server stopped before its run could say how it ended, so any outcome it kept is
 * accepted. So cancelling an idle agent must set `lastOutcome` to `interrupted` as it closes the
 * node: the registry's to do, since this only checks the result.
 */
export function isConsistentNode<Id extends string>(node: NodeFacts<Id>): boolean {
  const { id, parent, kind, state, endedAt, lastOutcome } = node;
  const open = state === 'running' || state === 'idle';

  if (parent === id) return false;
  if (state === 'idle' && kind !== 'agent') return false;
  if (open !== (endedAt === undefined)) return false;
  if (kind !== 'agent' || open || state === 'lost') return true;

  return lastOutcome !== undefined && NODE_STATE_OF_OUTCOME[lastOutcome] === state;
}
