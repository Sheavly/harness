import { describe, expect, it } from 'vitest';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { NodeCommandError } from '../../errors/node-commands.errors.js';
import {
  MAX_QUEUED_MESSAGE_CHARS,
  MAX_QUEUED_MESSAGES,
} from '../../sessions/sessions.constants.js';
import type { StartTask } from '../../tasks/tasks.types.js';
import { startControlledTask } from '../../testing/controlled-task.fake.js';
import { conversation as baseConversation } from '../../testing/stored-conversation.fake.js';
import { NodeCommands } from '../node-commands.service.js';

const CALL = callIdSchema.parse('call_1');

/** A run that goes on until it is aborted, as a stopped command or a sub-agent does. */
const UNTIL_ABORTED: StartTask['run'] = ({ signal }) =>
  new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ exitCode: null }), { once: true });
  });

/** A conversation with a main agent and a sub-agent it started, and the commands to its nodes. */
function conversation(cancelWaitMs?: number) {
  const world = baseConversation();
  const { sessions, tasks, main } = world;
  const child = sessions.startChild({ parentId: main.id, startedByCall: CALL, title: 'sub' });

  return {
    sessions,
    tasks,
    main,
    child,
    mainNode: world.nodeOf(main.id),
    commands: new NodeCommands({ sessions, tasks, cancelWaitMs }),
  };
}

type World = ReturnType<typeof conversation>;

/** A running sub-agent: the work of its session, as `start_agent` starts it. */
function startSubAgent(world: World) {
  const task = world.tasks.start({
    command: 'sub-agent: sub',
    description: 'sub',
    callId: CALL,
    sessionId: world.main.id,
    agentSessionId: world.child.id,
    backgroundKind: 'agent',
    run: UNTIL_ABORTED,
  });
  const node = world.sessions.nodeIdOf(world.child.id);

  if (!node) throw new Error('the sub-agent has no node');

  return { task, node };
}

/** A command or a service the main agent started, which runs until it is cancelled or finishes. */
function startWork(params: { world: World; kind: 'task' | 'service' }) {
  const { world, kind } = params;
  const started = startControlledTask({
    tasks: world.tasks,
    sessionId: world.main.id,
    callId: CALL,
    backgroundKind: kind,
  });
  const node = world.tasks.nodeIdOf(started.task.id);

  if (!node) throw new Error('the work has no node');

  return { ...started, node };
}

/** A node an extension added, which nothing can cancel or message. */
function extensionNode(world: World) {
  return world.sessions.nodes.open({
    kind: 'notes.sync',
    title: 'Sync',
    parent: world.mainNode,
  }).id;
}

/** What `run` throws, as the error, or undefined when it does not throw. */
function refusalOf(run: () => unknown): NodeCommandError | undefined {
  try {
    run();
  } catch (caughtError) {
    if (caughtError instanceof NodeCommandError) return caughtError;

    throw caughtError;
  }

  return undefined;
}

/** A function that messages the main agent and answers what it was refused for, if it was. */
function messagingMain(world: World): (text: string) => string | undefined {
  return (text) =>
    refusalOf(() =>
      world.commands.message({
        nodeId: world.mainNode,
        target: world.commands.target(world.mainNode),
        text,
      }),
    )?.reason;
}

describe('what a command to a node reaches', () => {
  it('is the session for the main agent, and the session and task for a sub-agent', () => {
    const world = conversation();
    const sub = startSubAgent(world);

    expect(world.commands.target(world.mainNode)).toEqual({
      kind: 'main-agent',
      sessionId: world.main.id,
    });
    expect(world.commands.target(sub.node)).toEqual({
      kind: 'sub-agent',
      sessionId: world.child.id,
      taskId: sub.task.id,
    });
  });

  it('is the task for a command and for a service', () => {
    const world = conversation();
    const command = startWork({ world, kind: 'task' });
    const service = startWork({ world, kind: 'service' });

    expect(world.commands.target(command.node)).toEqual({ kind: 'work', taskId: command.task.id });
    expect(world.commands.target(service.node)).toEqual({ kind: 'work', taskId: service.task.id });
  });

  it('is nothing for a kind an extension adds, and for a sub-agent that no task runs', () => {
    const world = conversation();
    const node = extensionNode(world);
    const childNode = world.sessions.nodeIdOf(world.child.id);

    expect(world.commands.target(node)).toEqual({ kind: 'other', nodeKind: 'notes.sync' });
    expect(childNode && world.commands.target(childNode)).toEqual({
      kind: 'other',
      nodeKind: 'agent',
    });
  });

  it('refuses a node the conversation does not have as unknown, one of another conversation too', () => {
    const world = conversation();
    const elsewhere = conversation();
    const foreign = startWork({ world: elsewhere, kind: 'task' }).node;

    expect(refusalOf(() => world.commands.target(foreign))?.reason).toBe('unknown_node');
  });

  it('refuses a node that has ended as ended, not as unknown', async () => {
    const world = conversation();
    const command = startWork({ world, kind: 'task' });

    command.finish(0);
    await world.tasks.nextSettled();

    expect(refusalOf(() => world.commands.target(command.node))).toMatchObject({
      reason: 'node_ended',
      nodeId: command.node,
    });
  });

  it('refuses a node released once its end was reported as ended too: it was this conversation’s', async () => {
    const world = conversation();
    const command = startWork({ world, kind: 'task' });

    command.finish(0);
    await world.tasks.nextSettled();
    world.tasks.takeUnreported();

    expect(world.tasks.release(command.task.id)).toBe(true);
    // The registry no longer has the node, as one that never was.
    expect(world.sessions.nodes.get(command.node)).toBeUndefined();
    expect(refusalOf(() => world.commands.target(command.node))?.reason).toBe('node_ended');
  });
});

describe('cancelling a node', () => {
  it('kills a command and a service, and waits for them to exit', async () => {
    const world = conversation();
    const command = startWork({ world, kind: 'task' });
    const service = startWork({ world, kind: 'service' });

    for (const work of [command, service]) {
      const target = world.commands.target(work.node);

      await world.commands.cancel({ nodeId: work.node, target });
    }

    expect(world.tasks.get(command.task.id)?.status).toBe('cancelled');
    expect(world.tasks.get(service.task.id)?.status).toBe('cancelled');
    expect(world.sessions.nodes.get(command.node)?.state).toBe('cancelled');
  });

  it('stops a sub-agent through the task that runs it', async () => {
    const world = conversation();
    const sub = startSubAgent(world);

    await world.commands.cancel({ nodeId: sub.node, target: world.commands.target(sub.node) });

    expect(world.tasks.get(sub.task.id)?.status).toBe('cancelled');
  });

  it('answers once it has waited, the kill sent, for a process that cannot be killed and never ends its task', async () => {
    const world = conversation(20);
    const task = world.tasks.start({
      command: 'stuck',
      description: 'stuck',
      callId: CALL,
      sessionId: world.main.id,
      // Ignores the abort, as a process that left its group and holds its output open does.
      run: () => new Promise(() => undefined),
    });
    const node = world.tasks.nodeIdOf(task.id) ?? world.mainNode;

    await world.commands.cancel({ nodeId: node, target: world.commands.target(node) });

    // The answer came, though the task is still running: the node's channel says when it ends.
    expect(world.tasks.get(task.id)?.status).toBe('running');
  });

  it('says a sub-agent that no task runs has nothing to cancel', async () => {
    const world = conversation();
    const node = world.sessions.nodeIdOf(world.child.id) ?? world.mainNode;
    const target = world.commands.target(node);
    let refusal: unknown;

    try {
      await world.commands.cancel({ nodeId: node, target });
    } catch (caughtError) {
      refusal = caughtError;
    }

    expect(refusal).toBeInstanceOf(NodeCommandError);
    expect(refusal instanceof NodeCommandError && refusal.reason).toBe('cannot_cancel');
    expect(refusal instanceof NodeCommandError && refusal.message).toContain('nothing runs');
  });

  it('does not cancel the main agent, whose stop the conversation holds, nor a kind nothing can cancel', async () => {
    const world = conversation();
    const node = extensionNode(world);
    const refused = async (nodeId: typeof node) => {
      try {
        await world.commands.cancel({ nodeId, target: world.commands.target(nodeId) });
      } catch (caughtError) {
        return caughtError instanceof NodeCommandError ? caughtError.reason : 'other error';
      }

      return 'cancelled';
    };

    expect(await refused(world.mainNode)).toBe('cannot_cancel');
    expect(await refused(node)).toBe('cannot_cancel');
  });
});

describe('messaging a node', () => {
  it('queues the text for the main agent as the user', () => {
    const world = conversation();

    world.commands.message({
      nodeId: world.mainNode,
      target: world.commands.target(world.mainNode),
      text: 'steer left',
    });

    expect(world.sessions.takeMessages(world.main.id)).toMatchObject([
      { from: 'user', content: 'steer left' },
    ]);
  });

  it('refuses a message past what the inbox holds, in messages and in characters, queuing nothing more', () => {
    const world = conversation();
    const send = messagingMain(world);

    for (let each = 0; each < MAX_QUEUED_MESSAGES; each += 1) expect(send('x')).toBeUndefined();

    expect(send('one more')).toBe('inbox_full');
    expect(world.sessions.takeMessages(world.main.id)).toHaveLength(MAX_QUEUED_MESSAGES);

    // Taken: there is room again, but not for more characters than the inbox holds together.
    expect(send('y'.repeat(MAX_QUEUED_MESSAGE_CHARS))).toBeUndefined();
    expect(send('z')).toBe('inbox_full');
  });

  it('queues a lone message however long: the bound is on what piles up, not on one message', () => {
    const world = conversation();
    const send = messagingMain(world);

    // An agent's own message to a sub-agent has no cap but what the model wrote; it must not be
    // refused for ever, with an empty inbox, for being over what many messages may hold together.
    expect(send('l'.repeat(MAX_QUEUED_MESSAGE_CHARS + 1))).toBeUndefined();
    // Behind it, nothing more fits until it is taken.
    expect(send('x')).toBe('inbox_full');
    expect(world.sessions.takeMessages(world.main.id)).toHaveLength(1);
  });

  it('refuses a sub-agent, which only the agent that started it may message, and a node that is no agent', () => {
    const world = conversation();
    const sub = startSubAgent(world);
    const command = startWork({ world, kind: 'task' });
    const service = startWork({ world, kind: 'service' });
    const extension = extensionNode(world);
    const reasons = [sub.node, command.node, service.node, extension].map(
      (nodeId) =>
        refusalOf(() =>
          world.commands.message({
            nodeId,
            target: world.commands.target(nodeId),
            text: 'hello',
          }),
        )?.reason,
    );

    expect(reasons).toEqual(Array(4).fill('cannot_message'));
    // Nothing reached the sub-agent: the refusal is before anything is queued.
    expect(world.sessions.takeMessages(world.child.id)).toEqual([]);
  });
});
