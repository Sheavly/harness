import { describe, expect, it } from 'vitest';
import type { PromptSent } from '@sheavly/protocol/node-command/node-command.types';
import { Renderer } from '../../render/render.service.js';
import { nodeFeeds } from '../../testing/channels-feed.fake.js';
import { openOnFake } from '../../testing/remote-conversation.fake.js';
import { MAIN_AGENT, treeFeed, until } from '../../testing/tree-feed.fake.js';
import { ChatSession } from '../chat-session.service.js';
import { followTranscript } from '../follow-transcript.helper.js';
import { lineAnswer } from '../testing/chat-session.fake.js';
import { messageIdOf } from '../testing/feed-items.fake.js';

const MESSAGE = messageIdOf(7);
const MAIN_SESSION = { id: 'main', rootId: 'main', depth: 1 };
const LINE = 'hi';

/**
 * The chat on a real `RemoteConversation` and its transcript feed, over a fake backend that
 * answers a prompt and then tells its run on the tree and the main agent's channels.
 */
async function chatOnFeed(params: { answer: PromptSent }) {
  const tree = treeFeed();
  const nodes = nodeFeeds();
  const channel = nodes.of(MAIN_AGENT.id);
  const opened = await openOnFake({
    tree,
    nodes,
    handlers: {
      querySkills: () => ({ skills: [] }),
      sendPrompt: () => {
        tree.promptStarted({ text: LINE, messageId: MESSAGE });
        channel.runStarted({ cause: 'prompt', messageId: MESSAGE, text: LINE });
        channel.event({ event: { seq: 1, type: 'text_delta', text: 'Hello' }, messageId: MESSAGE });
        channel.event({
          event: { seq: 2, type: 'done', reason: 'completed', session: MAIN_SESSION },
          messageId: MESSAGE,
        });

        return params.answer;
      },
    },
  });
  const told: string[] = [];
  let written = '';
  const session = new ChatSession({
    conversation: opened.conversation,
    renderer: new Renderer((text) => (written += text)),
    write: (text) => (written += text),
    onSend: (text) => told.push(`send ${text}`),
    onTurnEnd: (outcome) => told.push(`end ${outcome}`),
    onExit: () => undefined,
  });
  const stop = new AbortController();

  await followTranscript({ conversation: opened.conversation, session, signal: stop.signal });

  return { session, told, stop, output: () => written };
}

describe('ChatSession on the conversation’s transcript feed', () => {
  it('shows a line’s run and is idle after it, over the real channels', async () => {
    const { session, told, stop, output } = await chatOnFeed({
      answer: lineAnswer({ status: 'started', messageId: MESSAGE }),
    });

    session.submit(LINE);
    await until(() => told.includes('end completed'));
    await session.idle();
    stop.abort();

    expect(told).toEqual(['send hi', 'end completed']);
    expect(output()).toContain('Hello');
  });
});
