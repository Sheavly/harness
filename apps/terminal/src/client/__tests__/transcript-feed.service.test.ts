import { describe, expect, it } from 'vitest';
import { agentNode } from '@sheavly/client/testing/frames.fake';
import { openOnFake } from '../../testing/remote-conversation.fake.js';
import { quiet, transcribing } from '../../testing/transcript.fake.js';
import { MAIN_AGENT, childNode, lostAgent, treeFeed, until } from '../../testing/tree-feed.fake.js';
import type { ChatItem } from '../transcript.types.js';

const MESSAGE = '00000000-0000-4000-8000-000000000001';

/** The text of the main agent's text deltas among `items`, in order. */
const texts = (items: ChatItem[]) =>
  items.flatMap((item) =>
    item.type === 'event' && item.event.type === 'text_delta' ? [item.event.text] : [],
  );

describe('RemoteConversation: the transcript feed', () => {
  it('tells of what both channels hold: the conversation’s notices and the main agent’s events', async () => {
    const { tree, channel, items } = await transcribing();

    tree.notice({ type: 'queue_changed', fields: { queued: ['next'] } });
    channel.event({ event: { seq: 1, type: 'text_delta', text: 'Hello' } });
    await until(() => items.length === 2);

    expect(items.map(({ type }) => type).sort()).toEqual(['event', 'queue_changed']);
    expect(items).toContainEqual({ type: 'queue_changed', queued: ['next'] });
  });

  it('tells of a prompt’s start on the tree and of its run on the main channel, each in its own order', async () => {
    const { tree, channel, items } = await transcribing();
    const delta = (seq: number, text: string) => ({ seq, type: 'text_delta', text });

    tree.promptStarted({ text: 'go', messageId: MESSAGE, queued: ['b'] });
    channel.runStarted({ cause: 'prompt', messageId: MESSAGE, text: 'go' });
    channel.event({ event: delta(1, 'Hel'), messageId: MESSAGE });
    channel.event({ event: delta(2, 'lo, world'), messageId: MESSAGE, lastSeq: 4 });
    channel.omitted({ eventType: 'tool_result', seq: 5, size: 90_000 });
    await until(() => items.length === 5);

    // Between the two channels no order is defined: each is checked on its own.
    expect(items.filter(({ type }) => type === 'prompt_started')).toEqual([
      { type: 'prompt_started', text: 'go', messageId: MESSAGE, queued: ['b'] },
    ]);
    expect(items.filter(({ type }) => type !== 'prompt_started')).toEqual([
      { type: 'run_started', cause: 'prompt', messageId: MESSAGE, text: 'go' },
      { type: 'event', event: delta(1, 'Hel'), messageId: MESSAGE },
      { type: 'event', event: delta(2, 'lo, world'), messageId: MESSAGE, lastSeq: 4 },
      { type: 'event_omitted', eventType: 'tool_result', seq: 5, size: 90_000 },
    ]);
  });

  it('tells of a sub-agent’s card as it starts, says what it does and ends, with its depth and top for a grandchild', async () => {
    const { tree, items } = await transcribing();
    const worker = childNode({ id: 'worker', kind: 'agent' });
    const helper = childNode({ id: 'helper', kind: 'agent', parent: 'worker' });

    tree.opened(worker);
    tree.opened(helper);
    tree.updated(childNode({ id: 'helper', kind: 'agent', parent: 'worker', status: 'reading' }));
    tree.closed(childNode({ id: 'helper', kind: 'agent', parent: 'worker', state: 'completed' }));
    await until(() => items.length === 4);

    expect(
      items.flatMap((item) =>
        item.type === 'agent'
          ? [[item.change, item.agent.id, item.agent.depth, item.agent.root, item.agent.state]]
          : [],
      ),
    ).toEqual([
      ['started', 'worker', 2, 'main', 'running'],
      ['started', 'helper', 3, 'main', 'running'],
      ['status', 'helper', 3, 'main', 'running'],
      ['ended', 'helper', 3, 'main', 'completed'],
    ]);
    expect(items[2]).toMatchObject({ agent: { status: 'reading', parent: 'worker' } });
  });

  it('gives no card for a command or a service, and none for the main agent', async () => {
    const { tree, items } = await transcribing();

    tree.opened(childNode({ id: 'build', kind: 'command' }));
    tree.opened(childNode({ id: 'dev', kind: 'service' }));
    tree.updated({ ...MAIN_AGENT, status: 'busy' });
    tree.closed(childNode({ id: 'build', kind: 'command', state: 'completed' }));
    // Told after them, so that the items told are all there are by the time it arrives.
    tree.notice({ type: 'storage_failed', fields: { error: 'disk full' } });
    await until(() => items.length === 1);
    await quiet();

    expect(items).toEqual([{ type: 'storage_failed', error: 'disk full' }]);
  });

  it('follows the last agent with no parent: a reopened conversation holds its old main agent, lost, before the new one', async () => {
    const tree = treeFeed([], [lostAgent('old'), agentNode({ id: 'new' })]);
    // The backend has a channel for `new` only: asking for `old`'s would be refused.
    const { channel, items } = await transcribing({ tree, main: 'new' });

    channel.event({ event: { seq: 1, type: 'text_delta', text: 'from the new one' } });
    await until(() => items.length === 1);

    expect(texts(items)).toEqual(['from the new one']);
  });

  it('tells only what the main agent’s channel holds after it is followed, as the stream was followed live', async () => {
    const opened = await openOnFake({});
    const channel = opened.nodes.of('main');
    const items: ChatItem[] = [];

    channel.event({ event: { seq: 1, type: 'text_delta', text: 'earlier' } });

    const stop = new AbortController();
    const watch = await opened.conversation.watchTranscript({
      onItem: (item) => items.push(item),
      signal: stop.signal,
    });

    channel.event({ event: { seq: 2, type: 'text_delta', text: 'later' } });
    await until(() => items.length === 1);
    await quiet();
    stop.abort();
    await watch.ended;

    expect(texts(items)).toEqual(['later']);
  });
});
