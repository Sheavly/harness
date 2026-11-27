import { describe, expect, it } from 'vitest';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import {
  NO_SKILLS,
  follow,
  heldConversations,
  idle,
  queueOf,
  runningFirst,
  stoppableSkills,
} from '../../testing/held-conversations.fake.js';
import type { Conversations } from '../conversations.service.js';
import type { ConversationSkills, PromptFailure } from '../conversations.types.js';

/** Starts finite work in conversation `id` that finishes at once, so the idle conversation wakes. */
function finishWork(params: { conversations: Conversations; id: ConversationId }) {
  const { harness } = params.conversations.get(params.id);

  harness.tasks.start({
    command: 'build',
    description: 'Build',
    sessionId: harness.mainSession.id,
    run: async () => ({ exitCode: 0 }),
  });
}

/**
 * A memory store whose queue writes wait while held (`hold`, then `release`); `holding` says one
 * is waiting. Everything else is the memory store's.
 */
function heldQueueStore() {
  let gate: PromiseWithResolvers<undefined> | undefined;
  let waiting = false;
  const store = new Proxy(new MemoryConversationStore(), {
    get(target, key) {
      if (key !== 'queue') {
        const value: unknown = Reflect.get(target, key);

        if (typeof value !== 'function') return value;

        return (value as (...args: unknown[]) => unknown).bind(target);
      }

      return (id: ConversationId) => {
        const document = target.queue(id);

        return {
          load: () => document.load(),
          update: async (change: Parameters<typeof document.update>[0]) => {
            if (gate) {
              waiting = true;
              await gate.promise;
            }

            return document.update(change);
          },
        };
      };
    },
  });

  return {
    store,
    hold: () => {
      gate = Promise.withResolvers<undefined>();
    },
    release: () => {
      gate?.resolve(undefined);
      gate = undefined;
    },
    holding: () => waiting,
  };
}

describe('submitting a prompt', () => {
  it('starts it at once when nothing runs, and says so before the model answers', async () => {
    const { conversations, prompts } = heldConversations();
    const id = await conversations.start();
    const entries = follow({ conversations, id });

    expect(await conversations.submit({ id, prompt: { text: 'hi' } })).toMatchObject({
      status: 'started',
      queued: [],
    });
    await idle({ conversations, id });

    expect(prompts).toEqual(['hi']);
    expect(queueOf(entries)).toEqual(['prompt_started hi []']);

    const started = entries.findIndex((entry) => entry.kind === 'queue');
    const answered = entries.findIndex((e) => e.kind === 'event' && e.event.type === 'text_delta');

    expect(started).toBeLessThan(answered);
  });

  it('queues a line sent while a prompt runs, answers at once, and starts it once that prompt ended', async () => {
    const { conversations, prompts, release, id, send } = await runningFirst();
    const entries = follow({ conversations, id });

    expect(await send('second')).toMatchObject({ status: 'queued', queued: ['second'] });
    expect(await conversations.queue(id)).toEqual(['second']);
    release(1);
    await until(() => prompts.length === 2);
    await idle({ conversations, id });

    expect(prompts).toEqual(['first', 'second']);
    expect(queueOf(entries)).toEqual(['queue_changed [second]', 'prompt_started second []']);
    expect(await conversations.queue(id)).toEqual([]);
  });

  it('answers at once while a run it started itself for finished work goes, and runs the line after it', async () => {
    const { conversations, prompts, release } = heldConversations({ held: [2] });
    const id = await conversations.start();

    await conversations.submit({ id, prompt: { text: 'build' } });
    await idle({ conversations, id });
    finishWork({ conversations, id });
    await until(() => conversations.get(id).conversation.state === 'wake' && prompts.length === 2);

    // Before, a send here waited for the woken run, past any client's patience.
    expect(await conversations.submit({ id, prompt: { text: 'meanwhile' } })).toMatchObject({
      status: 'queued',
      queued: ['meanwhile'],
    });
    expect(prompts).toHaveLength(2);
    release(2);
    await until(() => prompts.length === 3);

    expect(prompts.at(-1)).toBe('meanwhile');
  });

  it('runs every line queued behind one run once, in order', async () => {
    const { conversations, prompts, release, id, send } = await runningFirst();

    await send('second');
    await send('third');
    release(1);
    await until(() => prompts.length === 3);
    await idle({ conversations, id });

    expect(prompts).toEqual(['first', 'second', 'third']);
  });

  it('refuses at once a prompt that cannot wait, and leaves the queue as it was', async () => {
    const { conversations, release, id, send } = await runningFirst();

    await expect(
      conversations.submit({ id, prompt: { parts: [{ type: 'text', text: 'picked' }] } }),
    ).rejects.toMatchObject({ reason: 'cannot_queue' });
    await expect(send('x'.repeat(20_001))).rejects.toMatchObject({ reason: 'cannot_queue' });

    for (let n = 0; n < 100; n++) await send(`${n}`);

    await expect(send('one more')).rejects.toMatchObject({ reason: 'cannot_queue' });
    expect(await conversations.queue(id)).toHaveLength(100);
    await conversations.setQueue({ id, queued: [] });
    release(1);
  });

  it('reports a line that cannot start, and runs the one behind it', async () => {
    const { conversations, prompts, release, id, send } = await runningFirst();
    const entries = follow({ conversations, id });

    await send('/nope');
    await send('after');
    release(1);
    await until(() => prompts.length === 2);

    expect(prompts).toEqual(['first', 'after']);
    expect(queueOf(entries)).toContain('prompt_refused /nope [after]');
  });

  it('keeps the lines through a stop, and starts them after the stopped run', async () => {
    const { conversations, prompts, id, send } = await runningFirst();

    await send('next');
    conversations.stop(id);
    await until(() => prompts.length === 2);

    expect(prompts).toEqual(['first', 'next']);
  });

  it('starts the lines in the order a client set, and none it removed', async () => {
    const { conversations, prompts, release, id, send } = await runningFirst();

    await send('a');
    await send('b');
    await conversations.setQueue({ id, queued: ['b'] });
    release(1);
    await until(() => prompts.length === 2);
    await idle({ conversations, id });

    expect(prompts).toEqual(['first', 'b']);
  });
});

describe('submitting a prompt, at the edges', () => {
  it('queues a line sent while the queue is written for the line just started, never ahead of it', async () => {
    const held = heldQueueStore();
    const { conversations, prompts, release, id, send } = await runningFirst({ store: held.store });
    const entries = follow({ conversations, id });

    await send('second');
    held.hold();
    release(1);
    await until(() => held.holding() && conversations.get(id).conversation.state === 'idle');

    // The send writes the queue too, so it is answered once the held write goes through.
    const third = send('third');

    held.release();
    expect(await third).toMatchObject({ status: 'queued', queued: ['third'] });
    await until(() => prompts.length === 3);

    expect(prompts).toEqual(['first', 'second', 'third']);
    expect(queueOf(entries)).toEqual([
      'queue_changed [second]',
      'prompt_started second []',
      'queue_changed [third]',
      'prompt_started third []',
    ]);
  });

  it('tells, as a line starts, the lines sent while it prepared its skills', async () => {
    const prepared = Promise.withResolvers<undefined>();
    const skills: ConversationSkills = {
      ...NO_SKILLS,
      prepare: async ({ prompt }) => {
        if ('text' in prompt && prompt.text === 'slow') await prepared.promise;

        return NO_SKILLS.prepare({ prompt });
      },
    };
    const { conversations } = heldConversations({ skills });
    const id = await conversations.start();
    const entries = follow({ conversations, id });
    const first = conversations.submit({ id, prompt: { text: 'slow' } });

    await until(() => conversations.get(id).harness.sessions.nextSeq() > 0);
    expect(await conversations.submit({ id, prompt: { text: 'meanwhile' } })).toMatchObject({
      status: 'queued',
      queued: ['meanwhile'],
    });
    prepared.resolve(undefined);

    expect(await first).toMatchObject({ status: 'started', queued: ['meanwhile'] });
    expect(queueOf(entries)).toContain('prompt_started slow [meanwhile]');
  });

  it('keeps a queued line a stop reaches while it prepares its skills, parked until the next send', async () => {
    const failures: PromptFailure[] = [];
    const store = new MemoryConversationStore();
    const { skills, reached } = stoppableSkills({ text: 'second' });
    const held = await runningFirst({ store, skills, onPromptFailure: (f) => failures.push(f) });
    const { id } = held;
    const entries = follow({ conversations: held.conversations, id });

    await held.send('second');
    held.release(1);
    await reached;
    held.conversations.stop(id);
    await idle({ conversations: held.conversations, id });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await held.conversations.queue(id)).toEqual(['second']);
    expect(await store.queue(id).load()).toEqual({ queued: ['second'] });
    expect(queueOf(entries).some((line) => line.startsWith('prompt_refused'))).toBe(false);
    expect(failures).toEqual([]);
    expect(held.prompts).toEqual(['first']);
  });

  it('lets a reopen read the queue only once the closed queue has finished writing it', async () => {
    const held = heldQueueStore();
    const first = await runningFirst({ store: held.store });
    const { id } = first;

    await first.send('second');
    held.hold();
    first.release(1);
    // `second` has started and its write that takes it out of the queue is held.
    await until(() => held.holding());
    await first.conversations.close(id);

    const second = heldConversations({ store: held.store });
    const reopened = second.conversations.reopen(id);

    held.release();
    await reopened;

    expect(await second.conversations.queue(id)).toEqual([]);
    expect(await held.store.queue(id).load()).toEqual({ queued: [] });
  });

  it('tells followers a fixed text when a line fails to start unexpectedly, and the app the error', async () => {
    const failures: PromptFailure[] = [];
    const skills: ConversationSkills = {
      ...NO_SKILLS,
      prepare: async ({ prompt }) => {
        if ('text' in prompt && prompt.text === '/broken') {
          throw new Error("ENOENT: no such file, open '/home/someone/project/SKILL.md'");
        }

        return NO_SKILLS.prepare({ prompt });
      },
    };
    const held = await runningFirst({ skills, onPromptFailure: (f) => failures.push(f) });
    const { id } = held;
    const entries = follow({ conversations: held.conversations, id });

    await held.send('/broken');
    held.release(1);
    await until(() => queueOf(entries).some((line) => line.startsWith('prompt_refused')));

    expect(JSON.stringify(entries)).not.toContain('/home/someone');
    expect(queueOf(entries)).toContain('prompt_refused /broken []');
    expect(failures).toMatchObject([
      { id, error: { message: expect.stringContaining('ENOENT') as string } },
    ]);
  });

  it('starts no wake while a prompt prepares its skills, so the send is answered once it starts', async () => {
    const prepared = Promise.withResolvers<undefined>();
    const skills: ConversationSkills = {
      ...NO_SKILLS,
      prepare: async ({ prompt }) => {
        await prepared.promise;

        return NO_SKILLS.prepare({ prompt });
      },
    };
    const { conversations, prompts } = heldConversations({ skills });
    const id = await conversations.start();
    const first = conversations.submit({ id, prompt: { text: 'first' } });

    prepared.resolve(undefined);
    await first;
    await idle({ conversations, id });

    const slow = Promise.withResolvers<undefined>();

    skills.prepare = async ({ prompt }) => {
      await slow.promise;

      return NO_SKILLS.prepare({ prompt });
    };

    const answered = conversations.submit({ id, prompt: { text: 'second' } });

    finishWork({ conversations, id });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(conversations.get(id).conversation.state).toBe('idle');
    slow.resolve(undefined);
    expect(await answered).toMatchObject({ status: 'started', queued: [] });
    await until(() => prompts.length === 2);
  });
});

describe('a kept queue', () => {
  it('starts nothing once the conversation is closed, and keeps its lines', async () => {
    const store = new MemoryConversationStore();
    const { conversations, prompts, id, send } = await runningFirst({ store });

    await send('later');
    await conversations.close(id);

    expect(prompts).toEqual(['first']);
    expect(await store.queue(id).load()).toEqual({ queued: ['later'] });
  });

  it('parks the lines a reopen restored until the next line is sent, then runs them first', async () => {
    const store = new MemoryConversationStore();
    const first = await runningFirst({ store });
    const { id } = first;

    await first.send('kept');
    await first.conversations.close(id);

    const second = heldConversations({ store });

    await second.conversations.reopen(id);

    expect(await second.conversations.queue(id)).toEqual(['kept']);
    expect(second.prompts).toEqual([]);

    expect(await second.conversations.submit({ id, prompt: { text: 'new' } })).toMatchObject({
      status: 'queued',
    });
    await until(() => second.prompts.length === 2);

    expect(second.prompts).toEqual(['kept', 'new']);
  });
});
