import type { treeFeed } from './tree-feed.fake.js';
import type { ChatItem } from '../client/transcript.types.js';
import { openOnFake } from './remote-conversation.fake.js';

/**
 * Test-only: a conversation on a fake backend whose transcript is followed: the tree channel
 * (`tree`, one main agent unless a test says what it holds) and the channel of the agent `main`
 * names, which the backend has. `items` are what `onItem` was told, in the order told.
 */
export async function transcribing(
  params: {
    tree?: ReturnType<typeof treeFeed>;
    main?: string;
    /** Told of each item after it is kept in `items`: a test makes it throw. */
    onItem?: (item: ChatItem) => void;
  } = {},
) {
  const { tree, main = 'main', onItem } = params;
  const opened = await openOnFake({ ...(tree && { tree }) });
  const channel = opened.nodes.of(main);
  const stop = new AbortController();
  const items: ChatItem[] = [];
  const watch = await opened.conversation.watchTranscript({
    onItem: (item) => {
      items.push(item);
      onItem?.(item);
    },
    signal: stop.signal,
  });

  return { ...opened, channel, stop, items, watch };
}

/** Test-only: waits a moment, for a test that says nothing more arrives in it. */
export const quiet = () => new Promise((resolve) => setTimeout(resolve, 40));
