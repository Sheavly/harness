import { describe, expect, it } from 'vitest';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { startControlledTask } from '@sheavly/runtime/testing/controlled-task.fake';
import { ConversationsError } from '../../errors/conversations.errors.js';
import {
  blockedThenNext,
  say,
  scriptedConversations,
  stopWhenBlocked,
} from '../../testing/conversations.fake.js';
import type { Conversations } from '../conversations.service.js';

const CALL = callIdSchema.parse('call_1');

/** A conversation that has not run anything: what a command to a node reaches. */
async function started() {
  const { conversations } = scriptedConversations({ replies: [say('ok')] });
  const id = await conversations.start();
  const live = conversations.get(id);
  const mainNode = live.harness.sessions.nodeIdOf(live.harness.mainSession.id);

  if (!mainNode) throw new Error('the main agent has no node');

  return { conversations, id, live, mainNode };
}

type World = Awaited<ReturnType<typeof started>>;

/** A command or a service the main agent started, which runs until cancelled. */
function startWork(params: { world: World; kind: 'task' | 'service' }) {
  const { world, kind } = params;
  const work = startControlledTask({
    tasks: world.live.harness.tasks,
    sessionId: world.live.harness.mainSession.id,
    callId: CALL,
    backgroundKind: kind,
  });
  const node = world.live.harness.tasks.nodeIdOf(work.task.id);

  if (!node) throw new Error('the work has no node');

  return { ...work, node };
}

/** The reason a call is refused for, or undefined when it is not. */
async function refusalOf(run: () => unknown): Promise<string | undefined> {
  try {
    await run();
  } catch (caughtError) {
    if (caughtError instanceof ConversationsError) return caughtError.reason;

    throw caughtError;
  }

  return undefined;
}

describe('answering a prompt with ids', () => {
  it('names the main agent node and the message a started prompt became', async () => {
    const world = await started();
    const { conversations, id, live, mainNode } = world;
    const answer = await conversations.submit({ id, prompt: { text: 'hi' } });

    expect(answer).toMatchObject({ status: 'started', node: mainNode, queued: [] });
    // The message is the one the main session runs the prompt as.
    expect('messageId' in answer && answer.messageId).toBe(
      live.harness.sessions.messageOf(live.harness.mainSession.id),
    );
  });

  it('names the node and no message for a prompt that waits: it is a line of text until it starts', async () => {
    const { conversations } = scriptedConversations({ replies: blockedThenNext() });
    const id = await conversations.start();
    const first = await conversations.submit({ id, prompt: { text: 'wait' } });
    const second = await conversations.submit({ id, prompt: { text: 'later' } });

    expect(first).toMatchObject({ status: 'started' });
    expect(second).toMatchObject({ status: 'queued', queued: ['later'] });
    expect(second).not.toHaveProperty('messageId');
    expect(second.node).toBe(first.node);

    conversations.stop(id);
  });
});

describe('cancelling a node of a conversation', () => {
  it('kills a command and a service, and waits for them to exit', async () => {
    const world = await started();
    const command = startWork({ world, kind: 'task' });
    const service = startWork({ world, kind: 'service' });
    const { tasks } = world.live.harness;

    await world.conversations.cancelNode({ id: world.id, node: command.node });
    await world.conversations.cancelNode({ id: world.id, node: service.node });

    expect(tasks.get(command.task.id)?.status).toBe('cancelled');
    expect(tasks.get(service.task.id)?.status).toBe('cancelled');
  });

  it('stops a sub-agent through its task', async () => {
    const world = await started();
    const { sessions, mainSession, tasks } = world.live.harness;
    const child = sessions.startChild({
      parentId: mainSession.id,
      startedByCall: CALL,
      title: 'sub',
    });
    const task = tasks.start({
      command: 'sub-agent: sub',
      description: 'sub',
      callId: CALL,
      sessionId: mainSession.id,
      agentSessionId: child.id,
      backgroundKind: 'agent',
      run: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ exitCode: null }), { once: true });
        }),
    });
    const node = sessions.nodeIdOf(child.id);

    await world.conversations.cancelNode({ id: world.id, node: node ?? '' });

    expect(tasks.get(task.id)?.status).toBe('cancelled');
  });

  it('stops the main agent as the conversation’s stop does, keeping history valid', async () => {
    const { conversations } = scriptedConversations({ replies: blockedThenNext() });
    const id = await conversations.start();
    const live = conversations.get(id);
    const node = live.harness.sessions.nodeIdOf(live.harness.mainSession.id) ?? '';
    const stopped = await stopWhenBlocked({
      conversations,
      id,
      stop: () => conversations.cancelNode({ id, node }),
    });

    expect(stopped).toEqual({ last: 'done', roles: ['user', 'assistant', 'tool'] });
  });

  it('is refused for a node that has ended, one that is not there and one of another conversation, in that order of what is known', async () => {
    const world = await started();
    const other = await started();
    const command = startWork({ world, kind: 'task' });
    const foreign = startWork({ world: other, kind: 'task' });
    const cancel = (node: string) => () => world.conversations.cancelNode({ id: world.id, node });

    command.finish(0);
    await world.live.harness.tasks.nextSettled();

    expect(await refusalOf(cancel(command.node))).toBe('node_ended');
    expect(await refusalOf(cancel(foreign.node))).toBe('not_found');
    expect(await refusalOf(cancel('no-such-node'))).toBe('not_found');
    // Not an id's shape at all: as a node nothing has.
    expect(await refusalOf(cancel('Not A Node!'))).toBe('not_found');
  });

  it('is refused for a kind nothing can cancel', async () => {
    const world = await started();
    const node = world.live.harness.nodes.open({
      kind: 'notes.sync',
      title: 'Sync',
      parent: world.mainNode,
    }).id;

    expect(await refusalOf(() => world.conversations.cancelNode({ id: world.id, node }))).toBe(
      'bad_request',
    );
  });
});

describe('messaging a node of a conversation', () => {
  /** Messages the node, and what was refused for. */
  const message = (params: {
    conversations: Conversations;
    id: ConversationId;
    node: NodeId | string;
  }) => refusalOf(() => params.conversations.messageNode({ ...params, text: 'hello' }));

  it('queues the text for the main agent as the user', async () => {
    const world = await started();

    world.conversations.messageNode({ id: world.id, node: world.mainNode, text: 'steer left' });

    expect(
      world.live.harness.sessions.takeMessages(world.live.harness.mainSession.id),
    ).toMatchObject([{ from: 'user', content: 'steer left' }]);
  });

  it('refuses a sub-agent, a command and a service, and a node that is not there', async () => {
    const world = await started();
    const { sessions, mainSession } = world.live.harness;
    const child = sessions.startChild({
      parentId: mainSession.id,
      startedByCall: CALL,
      title: 'sub',
    });
    const command = startWork({ world, kind: 'task' });
    const service = startWork({ world, kind: 'service' });
    const { conversations, id } = world;

    expect(await message({ conversations, id, node: sessions.nodeIdOf(child.id) ?? '' })).toBe(
      'bad_request',
    );
    expect(await message({ conversations, id, node: command.node })).toBe('bad_request');
    expect(await message({ conversations, id, node: service.node })).toBe('bad_request');
    expect(await message({ conversations, id, node: 'no-such-node' })).toBe('not_found');
    // Nothing was queued for the sub-agent.
    expect(sessions.takeMessages(child.id)).toEqual([]);
  });

  it('refuses a node that has ended as ended', async () => {
    const world = await started();
    const command = startWork({ world, kind: 'task' });

    command.finish(0);
    await world.live.harness.tasks.nextSettled();

    expect(
      await message({ conversations: world.conversations, id: world.id, node: command.node }),
    ).toBe('node_ended');
  });
});

describe('what a closed conversation answers', () => {
  it('is not found for a command to any node of it', async () => {
    const world = await started();

    await world.conversations.close(world.id);

    expect(
      await refusalOf(() => world.conversations.cancelNode({ id: world.id, node: world.mainNode })),
    ).toBe('not_found');
  });
});
