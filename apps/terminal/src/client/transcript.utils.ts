import type { NodeChannelEntry } from '@sheavly/client/nodes/nodes.types';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { TreeChannelEntry, TreeView } from '@sheavly/protocol/tree/tree.types';
import type { ChatItem, SubAgentCard } from './transcript.types.js';

type TreeNode = TreeView['nodes'][number];

/** An agent's node: the one kind that holds how its last run ended (`lastOutcome`). */
type AgentNode = Extract<TreeNode, { kind: 'agent' }>;

/**
 * Whether `node` is an agent. An extension's kind is `<extension>.<name>`, never a built-in name,
 * so the kind alone says it, though the type of the extension's node does not rule `agent` out.
 */
const isAgent = (node: TreeNode): node is AgentNode => node.kind === 'agent';

/** The entry of the tree channel that carries a node. */
type TreeNodeEntry = Extract<
  TreeChannelEntry,
  { type: 'node_opened' | 'node_updated' | 'node_closed' }
>;

/**
 * The main agent of `tree`: the last agent with no parent that was not lost. A conversation that
 * was reopened holds its old main agent (`lost`) and the new one after it, and the registry lists
 * nodes in the order they were created; a tree with only a lost one has no main agent to follow.
 */
export function mainAgentOf(tree: TreeView): NodeId | undefined {
  return tree.nodes.findLast(
    (node) => node.kind === 'agent' && node.parent === undefined && node.state !== 'lost',
  )?.id;
}

/**
 * Every agent with no parent in `tree`, oldest first: the main agent and the ones a reopened
 * conversation had before it, which are one conversation's main agent over time (each reopen makes
 * a new node for it). The registry lists nodes in the order they were created.
 */
export function mainLineageOf(tree: TreeView): NodeId[] {
  return tree.nodes
    .filter((node) => node.kind === 'agent' && node.parent === undefined)
    .map(({ id }) => id);
}

/**
 * The item an entry of an agent's channel shows, or none: the agent opening, changing and closing
 * are what the tree tells, and a command's output is not an agent's.
 */
export function itemOfAgentEntry(entry: NodeChannelEntry): ChatItem | undefined {
  switch (entry.type) {
    case 'event':
      return {
        type: 'event',
        event: entry.event,
        ...(entry.messageId !== undefined && { messageId: entry.messageId }),
        ...(entry.lastSeq !== undefined && { lastSeq: entry.lastSeq }),
      };
    case 'event_omitted':
      return {
        type: 'event_omitted',
        eventType: entry.eventType,
        seq: entry.seq,
        size: entry.size,
        ...(entry.messageId !== undefined && { messageId: entry.messageId }),
        ...(entry.call !== undefined && { call: entry.call }),
      };
    case 'run_started':
      return {
        type: 'run_started',
        cause: entry.cause,
        messageId: entry.messageId,
        ...(entry.text !== undefined && { text: entry.text }),
      };
    default:
      return undefined;
  }
}

/**
 * The ids from `parent` up to the top of its parent chain, `parent` first. The walk stops after as
 * many nodes as the tree holds, so a chain in a circle (a hostile server's) ends.
 */
function chainFrom(params: { parent: NodeId; tree: TreeView }): NodeId[] {
  const { parent, tree } = params;
  const parentOf = new Map(tree.nodes.map((node) => [node.id, node.parent]));
  const chain: NodeId[] = [];

  for (
    let next: NodeId | undefined = parent;
    next !== undefined && chain.length < tree.nodes.length;
    next = parentOf.get(next)
  ) {
    chain.push(next);
  }

  return chain;
}

/** The card of a sub-agent `node` (it has `parent`), placed by the parents in `tree`. */
function cardOf(params: { node: AgentNode; parent: NodeId; tree: TreeView }): SubAgentCard {
  const { node, parent, tree } = params;
  const chain = chainFrom({ parent, tree });

  return {
    id: node.id,
    title: node.title,
    // The stream's convention, which the Renderer indents by: the main agent is 1, its child 2.
    depth: chain.length + 1,
    parent,
    root: chain.at(-1) ?? parent,
    ...(node.status !== undefined && { status: node.status }),
    state: node.state,
    ...(node.lastOutcome !== undefined && { outcome: node.lastOutcome }),
  };
}

/** How a node entry changes the sub-agent, or none: an update that says nothing new is no change. */
function changeOf(params: {
  entry: TreeNodeEntry;
  before: TreeView;
}): Extract<ChatItem, { type: 'agent' }>['change'] | undefined {
  const { entry, before } = params;

  if (entry.type === 'node_opened') return 'started';

  if (entry.type === 'node_closed') return 'ended';

  const previous = before.nodes.find(({ id }) => id === entry.node.id);

  return previous?.status === entry.node.status ? undefined : 'status';
}

/** The card an entry that carries a node tells of: only a sub-agent has one, never a task. */
function agentItemsOf(params: {
  entry: TreeNodeEntry;
  before: TreeView;
  after: TreeView;
}): ChatItem[] {
  const { entry, before, after } = params;
  const { node } = entry;

  if (!isAgent(node) || node.parent === undefined) return [];

  const change = changeOf({ entry, before });

  if (change === undefined) return [];

  return [{ type: 'agent', change, agent: cardOf({ node, parent: node.parent, tree: after }) }];
}

/**
 * What an entry of the tree channel shows, given the tree before and after it: the conversation's
 * notices as they are, and a card for a sub-agent that starts, says what it is doing or ends. A
 * command or a service is a task, which the main agent's own events tell; the main agent is the
 * conversation itself; an approval has its own watcher. Those give no item.
 */
export function itemsOfTreeEntry(params: {
  entry: TreeChannelEntry;
  before: TreeView;
  after: TreeView;
}): ChatItem[] {
  const { entry, before, after } = params;

  switch (entry.type) {
    case 'queue_changed':
      return [{ type: 'queue_changed', queued: entry.queued }];
    case 'prompt_started':
      return [
        {
          type: 'prompt_started',
          text: entry.text,
          messageId: entry.messageId,
          queued: entry.queued,
        },
      ];
    case 'prompt_refused':
      return [
        { type: 'prompt_refused', text: entry.text, error: entry.error, queued: entry.queued },
      ];
    case 'storage_failed':
      return [{ type: 'storage_failed', error: entry.error }];
    case 'extension_event':
      return [
        {
          type: 'extension_event',
          extension: entry.extension,
          kind: entry.kind,
          version: entry.version,
          data: entry.data,
          text: entry.text,
        },
      ];
    case 'node_opened':
    case 'node_updated':
    case 'node_closed':
      return agentItemsOf({ entry, before, after });
    default:
      return [];
  }
}
