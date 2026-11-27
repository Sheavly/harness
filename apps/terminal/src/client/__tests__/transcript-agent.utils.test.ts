import { describe, expect, it } from 'vitest';
import {
  agentClosed,
  agentNode,
  serviceNode,
  agentEvent,
  agentEventOmitted,
  agentOpened,
  agentRunStarted,
  agentUpdated,
  commandOpened,
  outputText,
} from '@sheavly/client/testing/frames.fake';
import { channelEntrySchema } from '@sheavly/protocol/channel/channel.validator';
import { nodeInfoSchema } from '@sheavly/protocol/node/node.validator';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { itemOfAgentEntry, mainAgentOf } from '../transcript.utils.js';
import { lostAgent } from '../../testing/tree-feed.fake.js';

const MESSAGE = '00000000-0000-4000-8000-000000000001';

/** The item an agent's frame shows. */
const itemOf = (frame: SubscribeFrame) => itemOfAgentEntry(channelEntrySchema.parse(frame));

describe('itemOfAgentEntry', () => {
  it('shows a loop event as it is, with the message it answers', () => {
    const event = { seq: 4, type: 'text_delta', text: 'Hello' };

    expect(itemOf(agentEvent({ name: 'main', n: 1, event, messageId: MESSAGE }))).toEqual({
      type: 'event',
      event,
      messageId: MESSAGE,
    });
  });

  it('leaves out of an event what the entry does not have, and keeps the last seq of merged text', () => {
    const event = { seq: 4, type: 'text_delta', text: 'Hello, world' };

    const merged = itemOf(agentEvent({ name: 'main', n: 1, event, lastSeq: 6 }));

    expect(merged).toEqual({ type: 'event', event, lastSeq: 6 });
    expect(merged).not.toHaveProperty('messageId');
  });

  it('shows an event that was too large to store as what it was, its seq and how large', () => {
    expect(
      itemOf(
        agentEventOmitted({ name: 'main', n: 2, eventType: 'tool_result', seq: 8, size: 90_000 }),
      ),
    ).toEqual({ type: 'event_omitted', eventType: 'tool_result', seq: 8, size: 90_000 });
  });

  it('shows where a prompt’s run starts with the prompt’s text, and a wake’s without one', () => {
    const prompt = itemOf(
      agentRunStarted({ name: 'main', n: 1, cause: 'prompt', messageId: MESSAGE, text: 'go' }),
    );
    const wake = itemOf(agentRunStarted({ name: 'main', n: 2, cause: 'wake', messageId: MESSAGE }));

    expect(prompt).toEqual({
      type: 'run_started',
      cause: 'prompt',
      messageId: MESSAGE,
      text: 'go',
    });
    expect(wake).toEqual({ type: 'run_started', cause: 'wake', messageId: MESSAGE });
    expect(wake).not.toHaveProperty('text');
  });

  it('shows nothing for the agent opening, changing or closing, which the tree tells, or for output', () => {
    expect(itemOf(agentOpened('main'))).toBeUndefined();
    expect(itemOf(agentUpdated({ name: 'main', n: 1, status: 'reading' }))).toBeUndefined();
    expect(itemOf(agentClosed({ name: 'main', n: 2 }))).toBeUndefined();
    expect(itemOf(commandOpened('build'))).toBeUndefined();
    expect(itemOf(outputText({ name: 'build', offset: 0, text: 'hi' }))).toBeUndefined();
  });
});

describe('mainAgentOf', () => {
  const treeOf = (...nodes: object[]) => ({
    nodes: nodes.map((node) => nodeInfoSchema.parse(node)),
    approvals: [],
  });

  it('is the last agent with no parent: a reopened conversation holds its old one, lost, before the new one', () => {
    expect(mainAgentOf(treeOf(lostAgent('old'), agentNode({ id: 'new' })))).toBe('new');
  });

  it('is never a lost agent: a tree that holds only the lost one has none to follow', () => {
    expect(mainAgentOf(treeOf(lostAgent('old')))).toBeUndefined();
    expect(mainAgentOf(treeOf(agentNode({ id: 'new' }), lostAgent('old')))).toBe('new');
  });

  it('is none for a tree with no agent without a parent, and never a service', () => {
    expect(mainAgentOf(treeOf(serviceNode({ id: 'dev' })))).toBeUndefined();
    expect(mainAgentOf(treeOf())).toBeUndefined();
  });
});
