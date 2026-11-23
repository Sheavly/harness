import { describe, expect, it } from 'vitest';
import type { Provider } from '@sheavly/core/provider/provider.types';
import { streamAgent } from '@sheavly/loop/stream-agent/stream-agent.helper';
import { collect } from '@sheavly/testing/fetch/fake-fetch.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import { createHarness } from '../../host/host.helper.js';
import { createConversation } from '../conversation.helper.js';
import { CONVERSATION_RUN_TRANSITIONS } from '../conversation.constants.js';
import type { ConversationRunState } from '../conversation.types.js';
import { canMoveRun } from '../conversation.utils.js';

const STATES: ConversationRunState[] = ['idle', 'prompt', 'wake'];

/**
 * A conversation whose model answers at once, except the call numbered `held` (1-based), which
 * waits until `release`; with finite work that finishes when the test says.
 */
function heldConversation(held: number) {
  const gate = Promise.withResolvers<undefined>();
  const work = Promise.withResolvers<undefined>();
  let calls = 0;
  const provider: Provider = {
    async *stream() {
      calls += 1;
      if (calls === held) await gate.promise;
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const harness = createHarness({ title: 'Chat', provider });
  const conversation = createConversation({ harness, run: streamAgent, tools: [] });
  const startWork = () =>
    harness.tasks.start({
      command: 'build',
      description: 'Build',
      sessionId: harness.mainSession.id,
      run: async () => {
        await work.promise;

        return { exitCode: 0 };
      },
    });

  return {
    conversation,
    startWork,
    finishWork: () => work.resolve(undefined),
    release: () => gate.resolve(undefined),
  };
}

/** A conversation whose first prompt ended, and which work finishing then woke: held in its wake. */
async function wokenConversation() {
  const held = heldConversation(2);

  held.startWork();
  await collect(held.conversation.send('build'));
  held.finishWork();
  await until(() => held.conversation.state === 'wake');

  return held;
}

describe("a conversation's run", () => {
  it('starts only from idle, as a prompt or a wake, and every run ends idle', () => {
    const allowed = STATES.flatMap((from) =>
      STATES.filter((to) => canMoveRun({ from, to })).map((to) => `${from} -> ${to}`),
    );

    expect(allowed).toEqual(['idle -> prompt', 'idle -> wake', 'prompt -> idle', 'wake -> idle']);
    expect(CONVERSATION_RUN_TRANSITIONS.prompt).not.toContain('wake');
    expect(CONVERSATION_RUN_TRANSITIONS.wake).not.toContain('prompt');
  });

  it('is idle before the first prompt, a prompt while it runs, and idle once it ended', async () => {
    const { conversation, release } = heldConversation(1);

    expect(conversation.state).toBe('idle');

    const running = collect(conversation.send('hi'));

    await until(() => conversation.state === 'prompt');
    expect(conversation.running).toBe(true);
    release();
    await running;

    expect(conversation.state).toBe('idle');
    expect(conversation.running).toBe(false);
  });

  it('refuses a prompt while one runs, and leaves the one running alone', async () => {
    const { conversation, release } = heldConversation(1);
    const running = collect(conversation.send('first'));

    await until(() => conversation.state === 'prompt');
    expect(() => conversation.send('second')).toThrow(
      expect.objectContaining({ reason: 'session_running' }),
    );
    release();

    expect((await running).at(-1)).toMatchObject({ type: 'done', reason: 'completed' });
  });

  it('is a wake while a run it started itself for finished work goes, and refuses a prompt then', async () => {
    const { conversation, release } = await wokenConversation();

    expect(() => conversation.send('meanwhile')).toThrow(
      expect.objectContaining({ reason: 'session_running' }),
    );
    release();
    await until(() => conversation.state === 'idle');
  });

  it('ends a wake asked to settle, and is idle for the prompt that asked', async () => {
    const { conversation, release } = await wokenConversation();
    const settled = conversation.settleWake();

    release();
    await settled;

    expect(conversation.state).toBe('idle');
    expect((await collect(conversation.send('next'))).at(-1)).toMatchObject({
      type: 'done',
      reason: 'completed',
    });
  });

  it('is idle again after a stopped prompt, and after a close', async () => {
    const { conversation } = heldConversation(1);
    const running = collect(conversation.send('hi'));

    await until(() => conversation.state === 'prompt');
    expect(conversation.stop()).toBe(true);
    expect((await running).at(-1)).toMatchObject({ type: 'done', reason: 'interrupted' });
    expect(conversation.state).toBe('idle');

    await conversation.close();

    expect(conversation.state).toBe('idle');
    expect(() => conversation.send('after')).toThrow(
      expect.objectContaining({ reason: 'session_ended' }),
    );
  });
});
