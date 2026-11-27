import type { createClient } from '@sheavly/client/client/client.helper';
import { followNode } from '@sheavly/client/nodes/follow-node.helper';
import { AnswerError } from '@sheavly/client/errors/client.errors';
import type { NodeChannelEntry } from '@sheavly/client/nodes/nodes.types';
import type { TreeEntryListener, WatchedTree } from '@sheavly/client/tree/tree.types';
import { watchTree } from '@sheavly/client/tree/watch-tree.helper';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { TreeView } from '@sheavly/protocol/tree/tree.types';
import { NoMainAgentError } from '../errors/transcript.errors.js';
import type { ChatItem } from './transcript.types.js';
import { itemOfAgentEntry, itemsOfTreeEntry, mainAgentOf } from './transcript.utils.js';

/** How a source of the feed ended: nothing when it ended quietly, or what it failed with. */
type Outcome = { failed: unknown } | undefined;

/** `promise`'s outcome as a value, so it can be raced and read later with no rejection left unhandled. */
const outcomeOf = (promise: Promise<void>): Promise<Outcome> =>
  promise.then(
    () => undefined,
    (caughtError: unknown) => ({ failed: caughtError }),
  );

/**
 * Opens `main`'s channel from now on, or answers nothing when the caller's `signal` aborted
 * meanwhile: the caller leaving is not a failure. A failed open ends the tree follower too, which
 * `stop` does.
 */
async function openMain(params: {
  client: ReturnType<typeof createClient>;
  id: ConversationId;
  main: NodeId;
  signal: AbortSignal;
  stop: AbortController;
}): Promise<AsyncGenerator<NodeChannelEntry> | undefined> {
  const { client, id, main, signal, stop } = params;

  try {
    return await followNode({
      client,
      id,
      node: main,
      from: 'now',
      signal: AbortSignal.any([signal, stop.signal]),
    });
  } catch (caughtError) {
    stop.abort();

    if (signal.aborted) return undefined;

    throw caughtError;
  }
}

/**
 * Opens the conversation's tree, or answers nothing when the caller's `signal` aborted while the
 * connection was being made (or before): the caller leaving is not a failure, and nothing is left
 * open (`both` is aborted, which stops what did start).
 */
async function openTree(params: {
  client: ReturnType<typeof createClient>;
  id: ConversationId;
  signal: AbortSignal;
  both: AbortSignal;
  onEntry: TreeEntryListener;
  onChange: (tree: TreeView) => void;
}): Promise<WatchedTree | undefined> {
  const { client, id, signal, both, onEntry, onChange } = params;

  try {
    return await watchTree({ client, id, signal: both, onEntry, onChange });
  } catch (caughtError) {
    if (signal.aborted) return undefined;

    throw caughtError;
  }
}

/** Tells `onItem` of each entry of the main agent's channel that shows, until the channel ends. */
async function tellMainEntries(params: {
  entries: AsyncGenerator<NodeChannelEntry>;
  onItem: (item: ChatItem) => void;
}): Promise<void> {
  const { entries, onItem } = params;

  for await (const entry of entries) {
    const item = itemOfAgentEntry(entry);

    if (item) onItem(item);
  }
}

/**
 * Settles when the first source does, with the other one ended: its failure when it failed, else
 * the other's (one that failed before it could be stopped), else nothing.
 */
async function endTogether(params: {
  tree: Promise<Outcome>;
  main: Promise<Outcome>;
  stop: AbortController;
}): Promise<void> {
  const { tree, main, stop } = params;
  const first = await Promise.race([tree, main]);

  stop.abort();

  const [fromTree, fromMain] = await Promise.all([tree, main]);
  const failure = first ?? fromTree ?? fromMain;

  if (failure) throw failure.failed;
}

/**
 * Follows what a chat shows of conversation `id` as typed items (`ChatItem`), from two channels:
 * the tree's (the conversation's notices and its sub-agents, from every entry the tree channel
 * holds after the snapshot) and the main agent's own (its loop events and where each run starts,
 * from now on). The main agent is the last agent in the tree with no parent that was not lost: a
 * reopened conversation holds its old one, `lost`, before the new one. A tree without one rejects
 * with `NoMainAgentError`, and one that sends an entry before a snapshot it could use rejects with
 * `AnswerError`, since no main agent can be told from it.
 *
 * Items of one channel come in the order it holds them; between the two no order is defined (a
 * cursor of one channel orders nothing against another's), so a reader matches a run's items by
 * message id. The tree's items can come before this resolves, while the main channel is being
 * opened; a run that starts in that moment is not seen on the main channel (its prompt is, on the
 * tree), so send the first prompt after this resolves.
 *
 * Resolves once the backend has accepted both connections. `ended` resolves when `signal` aborts
 * (also while the tree is being opened: then nothing is followed) and when either source ends (the
 * main channel's `closed`, the tree's end): the other is stopped then, so neither connection is
 * left open. It rejects with `ChannelFailedError` (a channel that ended `failed`, a closed
 * conversation), `RefusedError` or `AnswerError` as the client's followers do, and with what
 * `onItem` throws. It starts at once: attach a handler to it. It does not sanitize text: an item's
 * text is the backend's and the model's, and an entry that does not parse is dropped, as every
 * client follower drops it.
 */
export async function watchTranscript(params: {
  client: ReturnType<typeof createClient>;
  id: ConversationId;
  onItem: (item: ChatItem) => void;
  signal: AbortSignal;
}): Promise<{ ended: Promise<void> }> {
  const { client, id, onItem, signal } = params;
  // Aborted when either source ends, so the other does too.
  const stop = new AbortController();
  const both = AbortSignal.any([signal, stop.signal]);
  const snapshot = Promise.withResolvers<NodeId | undefined>();
  let snapshotSeen = false;
  const opened = await openTree({
    client,
    id,
    signal,
    both,
    onEntry: (told) => {
      // The snapshot comes first. An entry before any change means the snapshot was refused as off
      // the contract, and the tree it would have given is not known: no main agent is guessed.
      if (!snapshotSeen) {
        throw new AnswerError({
          route: 'streamChannels',
          cause: 'the tree channel sent an entry before a snapshot it could use',
        });
      }

      for (const item of itemsOfTreeEntry(told)) onItem(item);
    },
    onChange: (view) => {
      // The first change is the snapshot; a later one is ignored by an already settled promise.
      snapshotSeen = true;
      snapshot.resolve(mainAgentOf(view));
    },
  });

  // The caller left while the tree was being opened: nothing was followed, and that is no failure.
  if (!opened) return { ended: Promise.resolve() };

  const treeOutcome = outcomeOf(opened.ended);

  // A tree that ends before its snapshot has no main agent to wait for.
  void treeOutcome.then((outcome) =>
    outcome ? snapshot.reject(outcome.failed) : snapshot.resolve(undefined),
  );

  const main = await snapshot.promise;

  if (main === undefined) {
    stop.abort();

    if (signal.aborted) return { ended: Promise.resolve() };

    throw new NoMainAgentError();
  }

  const entries = await openMain({ client, id, main, signal, stop });

  if (!entries) return { ended: Promise.resolve() };

  return {
    ended: endTogether({
      tree: treeOutcome,
      main: outcomeOf(tellMainEntries({ entries, onItem })),
      stop,
    }),
  };
}
