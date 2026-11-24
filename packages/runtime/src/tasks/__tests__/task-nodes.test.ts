import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import type { TaskKind } from '@sheavly/protocol/task/task.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import { describe, expect, it } from 'vitest';
import { SessionRegistry } from '../../sessions/sessions.service.js';
import { startHeldTask } from '../../testing/held-task.fake.js';
import { TaskRegistry } from '../tasks.service.js';
import type { StartTask } from '../tasks.types.js';

const CALL = callIdSchema.parse('call_1');
const KINDS: TaskKind[] = ['task', 'service', 'agent'];
/** The node kind each kind of background work is. */
const NODE_KIND = { task: 'command', service: 'service', agent: 'agent' } as const;

/** A conversation: a main session, a sub-agent it started by `CALL`, and tasks that share nodes. */
function conversation() {
  const sessions = new SessionRegistry();
  const tasks = new TaskRegistry(sessions.nodeOwners);
  const main = sessions.startMain({ title: 'main', id: sessionIdSchema.parse('main') });
  const child = sessions.startChild({ parentId: main.id, startedByCall: CALL, title: 'sub' });

  return { sessions, tasks, main, child };
}

/** Starts work of `kind` owned by the main session, which runs until `finish` is called. */
function startWork(params: { world: ReturnType<typeof conversation>; kind: TaskKind }) {
  const { world, kind } = params;
  let finish: (exitCode: number | null) => void = () => undefined;
  const task = world.tasks.start({
    command: 'work',
    description: 'work',
    callId: CALL,
    sessionId: world.main.id,
    backgroundKind: kind,
    run: ({ signal }) =>
      new Promise((resolve) => {
        finish = (exitCode) => resolve({ exitCode });
        signal.addEventListener('abort', () => resolve({ exitCode: null }), { once: true });
      }),
  });

  return { task, finish: (exitCode: number | null) => finish(exitCode) };
}

function nodeOf(params: { world: ReturnType<typeof conversation>; id: string }) {
  return params.world.tasks.nodes.list().find((node) => node.title === params.id);
}

/**
 * Starts the work of a sub-agent, as `start_agent` does: `agent` is the session it runs
 * (`world.child` unless a test names another), running `run`.
 */
function startSubAgent(params: {
  world: ReturnType<typeof conversation>;
  run: StartTask['run'];
  agent?: SessionId;
}) {
  const { world, run, agent = world.child.id } = params;

  return world.tasks.start({
    command: 'sub-agent: sub',
    description: 'sub',
    callId: CALL,
    sessionId: world.main.id,
    agentSessionId: agent,
    backgroundKind: 'agent',
    run,
  });
}

/** How many nodes starting a sub-agent's work opens: none when it takes its session's own. */
function nodesOpenedBy(params: { world: ReturnType<typeof conversation>; agent?: SessionId }) {
  const { world, agent } = params;
  const before = world.tasks.nodes.list().length;

  startSubAgent({ world, run: () => new Promise(() => undefined), ...(agent && { agent }) });

  return world.tasks.nodes.list().length - before;
}

/** A run that goes on until it is aborted, as a stopped command does. */
const UNTIL_ABORTED: StartTask['run'] = ({ signal }) =>
  new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ exitCode: null }), { once: true });
  });

/** A sub-agent whose work finished and whose notice was taken: the state `release` accepts. */
async function reportedSubAgent(world: ReturnType<typeof conversation>) {
  const task = startSubAgent({ world, run: () => Promise.resolve({ exitCode: 0 }) });

  await world.tasks.nextSettled();
  world.tasks.takeUnreported();

  return task;
}

/** The node of work of `kind` that the main agent started: not the main agent's own node. */
function workNode(params: { world: ReturnType<typeof conversation>; kind: TaskKind }) {
  const { world, kind } = params;
  const mainNode = world.sessions.nodeIdOf(world.main.id);

  return world.tasks.nodes
    .list()
    .find((node) => node.kind === NODE_KIND[kind] && node.parent === mainNode);
}

describe.each(KINDS)('background work of kind %s', (kind) => {
  it('is a node of its kind, running, under the node of the session that owns it', () => {
    const world = conversation();

    startWork({ world, kind });

    // A sub-agent's task is the agent node its session already is: one node, not two.
    expect(workNode({ world, kind })).toMatchObject({
      kind: NODE_KIND[kind],
      state: 'running',
      parent: world.sessions.nodeIdOf(world.main.id),
    });
  });
});

/** The kinds whose node the task ends: a sub-agent's is its session's, and the session ends it. */
const ENDED_BY_THE_TASK = ['task', 'service'] as const;

describe.each(ENDED_BY_THE_TASK)('background work of kind %s', (kind) => {
  it.each([
    ['exit 0', 0, 'completed'],
    ['a non-zero exit', 1, 'failed'],
    ['no exit code, from a stop', null, 'failed'],
  ] as const)('ends with %s as %s, in the task and in its node', async (_name, code, state) => {
    const world = conversation();
    const { task, finish } = startWork({ world, kind });

    finish(code);
    await world.tasks.nextSettled();

    expect(world.tasks.get(task.id)?.status).toBe(state);
    expect(workNode({ world, kind })?.state).toBe(state);
  });

  it('ends cancelled when it is cancelled, in the task and in its node', async () => {
    const world = conversation();
    const { task } = startWork({ world, kind });

    await world.tasks.cancel(task.id);

    const node = workNode({ world, kind });

    expect(world.tasks.get(task.id)?.status).toBe('cancelled');
    expect(node?.state).toBe('cancelled');
    expect(node?.endedAt).toBeDefined();
  });
});

describe('a command or a service', () => {
  it.each(['task', 'service'] as const)(
    'is a node of its own, which a %s release removes with the task',
    async (kind) => {
      const world = conversation();
      const { task, finish } = startWork({ world, kind });
      const before = world.tasks.nodes.list().length;

      finish(0);
      await world.tasks.nextSettled();
      world.tasks.takeUnreported();

      expect(world.tasks.release(task.id)).toBe(true);
      expect(world.tasks.nodes.list().length).toBe(before - 1);
      expect(world.tasks.nodes.list().some((node) => node.kind === NODE_KIND[kind])).toBe(false);
    },
  );

  it('is not released while it runs: the task and its node stay', () => {
    const world = conversation();
    const { task } = startWork({ world, kind: 'task' });

    expect(world.tasks.release(task.id)).toBe(false);
    expect(world.tasks.nodes.list().some((node) => node.kind === 'command')).toBe(true);
  });

  it('survives its sub-agent’s session being released first, which takes its node with it', async () => {
    const world = conversation();
    const task = world.tasks.start({
      command: 'cmd',
      description: 'work',
      sessionId: world.child.id,
      run: () => Promise.resolve({ exitCode: 0 }),
    });

    await world.tasks.nextSettled();
    world.tasks.takeUnreported();
    world.sessions.end({ id: world.child.id, state: 'completed' });

    expect(world.sessions.releaseAgent(world.child.id)).toBe(true);
    expect(world.tasks.nodes.list().some((node) => node.kind === 'command')).toBe(false);
    expect(world.tasks.release(task.id)).toBe(true);
  });
});

describe('a sub-agent', () => {
  it('is the agent node its session is: one node, shared by the session and the task', () => {
    const world = conversation();
    const before = world.tasks.nodes.list().length;

    startSubAgent({ world, run: () => new Promise(() => undefined) });

    expect(world.tasks.nodes.list().length).toBe(before);
  });

  it('is ended by its session, with how its last run ended, whatever its task says', async () => {
    const world = conversation();
    const task = startSubAgent({ world, run: () => Promise.resolve({ exitCode: 1 }) });
    const updates: string[] = [];

    world.sessions.subscribe((update) => updates.push(update.type));

    // The run ends the session first, as the loop does before its task settles.
    world.sessions.end({ id: world.child.id, state: 'max_turns' });
    await world.tasks.nextSettled();

    expect(world.tasks.get(task.id)?.status).toBe('failed');
    expect(world.sessions.get(world.child.id)?.state).toBe('max_turns');
    expect(updates).toEqual(['session_ended']);
    expect(world.tasks.nodes.list().filter((node) => node.state === 'failed')).toHaveLength(1);
  });

  it('leaves its node to its session when the task settles first: the session still ends it', async () => {
    const world = conversation();
    const task = startSubAgent({ world, run: () => Promise.resolve({ exitCode: 0 }) });
    const updates: string[] = [];

    world.sessions.subscribe((update) => updates.push(update.type));
    await world.tasks.nextSettled();

    // Nothing ended the session, so it is still running, and so is its node: as before nodes, a
    // run that never reached the loop leaves its session to whoever owns it.
    expect(world.tasks.get(task.id)?.status).toBe('completed');
    expect(world.sessions.get(world.child.id)?.state).toBe('running');

    world.sessions.end({ id: world.child.id, state: 'completed' });

    expect(world.sessions.get(world.child.id)?.state).toBe('completed');
    expect(updates).toEqual(['session_ended']);
  });

  it('is never paired with a command that has the same tool call id: the provider’s ids repeat', async () => {
    const world = conversation();
    const command = world.tasks.start({
      command: 'cmd',
      description: 'work',
      callId: CALL,
      sessionId: world.main.id,
      run: () => new Promise(() => undefined),
    });
    const agent = startSubAgent({ world, run: () => Promise.resolve({ exitCode: 0 }) });

    // The agent task takes its own session's node, whatever else has its call id, and settles.
    await world.tasks.nextSettled();

    expect(world.tasks.get(agent.id)?.status).toBe('completed');
    expect(world.tasks.get(command.id)?.status).toBe('running');
    expect(world.tasks.nodes.list().filter((node) => node.kind === 'command')).toHaveLength(1);
    expect(world.tasks.nodes.list().find((node) => node.kind === 'command')?.state).toBe('running');
  });

  it('is paired with the session it runs, never with another that has the same tool call id', () => {
    const world = conversation();
    // A session an extension started under the same call id, before the real sub-agent's.
    const real = world.sessions.startChild({
      parentId: world.main.id,
      startedByCall: CALL,
      title: 'real',
    });
    const before = world.tasks.nodes.list().length;
    const task = startSubAgent({ world, agent: real.id, run: () => new Promise(() => undefined) });

    // No node was opened: the task took the real one, and the first child is left alone.
    expect(world.tasks.nodes.list().length).toBe(before);
    expect(task.agentSessionId).toBe(real.id);
    expect(world.tasks.get(task.id)?.agentSessionId).toBe(real.id);
  });

  it('takes a session once: a second task for it gets a node of its own', () => {
    const world = conversation();

    expect(nodesOpenedBy({ world })).toBe(0);
    expect(nodesOpenedBy({ world })).toBe(1);
  });

  it('is not paired with a session another session started: the node must be its own child', () => {
    const world = conversation();
    const other = world.sessions.startMain({ title: 'other', id: sessionIdSchema.parse('other') });
    const theirs = world.sessions.startChild({
      parentId: other.id,
      startedByCall: CALL,
      title: 'theirs',
    });

    expect(nodesOpenedBy({ world, agent: theirs.id })).toBe(1);
  });

  it('does not take the node of a session that has ended', () => {
    const world = conversation();

    world.sessions.end({ id: world.child.id, state: 'completed' });

    expect(nodesOpenedBy({ world })).toBe(1);
  });

  it('is not released by its task: its session owns the node', async () => {
    const world = conversation();
    const task = await reportedSubAgent(world);

    world.tasks.release(task.id);

    expect(world.sessions.get(world.child.id)).toBeDefined();
    expect(world.sessions.nodeIdOf(world.child.id)).toBeDefined();
  });

  it('can have its session released before its task is: neither throws', async () => {
    const world = conversation();
    const task = await reportedSubAgent(world);

    world.sessions.releaseAgent(world.child.id);

    expect(world.tasks.release(task.id)).toBe(true);
  });
});

describe('the sub-agent sessions of released tasks', () => {
  it('are handed to the session that owns the task, once, whether the task was delivered or cancelled in silence', async () => {
    const world = conversation();
    const silent = startSubAgent({ world, run: UNTIL_ABORTED });

    // Cancelled on request: never notified, so nothing delivers it, and the loop releases it silently.
    await world.tasks.cancel(silent.id);

    expect(world.tasks.get(silent.id)?.agentSessionId).toBe(world.child.id);
    expect(world.tasks.releaseFinished(world.main.id)).toBe(1);
    // The task is gone, and so is what it knew; the owner is handed the session to release.
    expect(world.tasks.get(silent.id)).toBeUndefined();
    expect(world.tasks.takeReleasedAgents(world.main.id)).toEqual([world.child.id]);
    expect(world.tasks.takeReleasedAgents(world.main.id)).toEqual([]);
  });

  it('are not handed to another session, and are kept for the owner', async () => {
    const world = conversation();
    const task = await reportedSubAgent(world);

    expect(world.tasks.release(task.id)).toBe(true);
    expect(world.tasks.takeReleasedAgents(sessionIdSchema.parse('someone-else'))).toEqual([]);
    expect(world.tasks.takeReleasedAgents(world.main.id)).toEqual([world.child.id]);
  });

  it('let the owner release an ended sub-agent whose task nobody was told about', async () => {
    const world = conversation();
    const task = startSubAgent({ world, run: UNTIL_ABORTED });

    await world.tasks.cancel(task.id);
    world.sessions.end({ id: world.child.id, state: 'interrupted' });
    world.tasks.releaseFinished(world.main.id);

    for (const agent of world.tasks.takeReleasedAgents(world.main.id)) {
      world.sessions.releaseAgent(agent);
    }

    expect(world.sessions.get(world.child.id)).toBeUndefined();
    expect(world.tasks.nodes.list().map((node) => node.kind)).toEqual(['agent']);
  });
});

describe('the node a task is', () => {
  it('is the one a command opens, and the session’s own for a sub-agent, until the task is released', async () => {
    const world = conversation();
    const agent = await reportedSubAgent(world);
    const command = startWork({ world, kind: 'task' });

    expect(world.tasks.nodeIdOf(agent.id)).toBe(world.sessions.nodeIdOf(world.child.id));
    expect(world.tasks.nodeIdOf(command.task.id)).toBe(nodeOf({ world, id: 'work' })?.id);
    expect(world.tasks.nodeIdOf(command.task.id)).not.toBe(world.sessions.nodeIdOf(world.main.id));

    world.tasks.release(agent.id);

    expect(world.tasks.nodeIdOf(agent.id)).toBeUndefined();
    command.finish(0);
  });
});

describe('the session a task runs', () => {
  it('is in the snapshot of sub-agent work only: a command that was told one runs none, and releases none', async () => {
    const world = conversation();
    const agent = startHeldTask({
      tasks: world.tasks,
      sessionId: world.main.id,
      agentSessionId: world.child.id,
      backgroundKind: 'agent',
    });
    const command = startHeldTask({
      tasks: world.tasks,
      sessionId: world.main.id,
      agentSessionId: world.child.id,
    });

    expect(agent.agentSessionId).toBe(world.child.id);
    expect(command).not.toHaveProperty('agentSessionId');
    expect(world.tasks.get(command.id)).not.toHaveProperty('agentSessionId');

    await world.tasks.cancelAll();
    world.tasks.releaseFinished(world.main.id);

    // The session is handed to its owner once, for the sub-agent's task and not for the command's.
    expect(world.tasks.takeReleasedAgents(world.main.id)).toEqual([world.child.id]);
  });
});

describe('an agent task with no session to share', () => {
  it('has an agent node of its own, which the task ends with how it settled', async () => {
    const world = conversation();

    // The session this task runs has ended, so it cannot be shared: the task has a node of its own.
    world.sessions.end({ id: world.child.id, state: 'completed' });

    const task = startSubAgent({ world, run: () => Promise.resolve({ exitCode: 1 }) });

    await world.tasks.nextSettled();

    expect(world.tasks.get(task.id)?.status).toBe('failed');
    expect(world.tasks.nodes.list().filter((node) => node.kind === 'agent')).toHaveLength(3);

    const sessionNode = world.sessions.nodeIdOf(world.child.id);
    const own = world.tasks.nodes
      .list()
      .find(
        (node) => node.kind === 'agent' && node.parent !== undefined && node.id !== sessionNode,
      );

    expect(own).toMatchObject({ state: 'failed' });
  });
});

describe('a run that throws before it returns a promise', () => {
  it('is a failed task, and its node ends failed rather than running for good', async () => {
    const world = conversation();
    const task = world.tasks.start({
      command: 'cmd',
      description: 'work',
      sessionId: world.main.id,
      run: () => {
        throw new Error('a work factory’s bug');
      },
    });

    await world.tasks.nextSettled();

    expect(world.tasks.get(task.id)).toMatchObject({
      status: 'failed',
      error: 'a work factory’s bug',
    });
    expect(workNode({ world, kind: 'task' })?.state).toBe('failed');
  });
});

describe('a task registry with no sessions', () => {
  it('has a node registry of its own, and its nodes sit at the root', async () => {
    const tasks = new TaskRegistry();
    const task = tasks.start({
      command: 'cmd',
      description: 'work',
      run: () => Promise.resolve({ exitCode: 0 }),
    });

    await tasks.nextSettled();

    const [node] = tasks.nodes.list();

    expect(tasks.nodes.list()).toHaveLength(1);
    expect(node).toMatchObject({ kind: 'command', state: 'completed' });
    expect(node?.parent).toBeUndefined();
    expect(tasks.get(task.id)?.status).toBe('completed');
  });
});

describe('the node of a task', () => {
  it('has a channel that opens and closes with the task', async () => {
    const world = conversation();
    const { finish } = startWork({ world, kind: 'task' });

    finish(0);
    await world.tasks.nextSettled();

    const node = world.tasks.nodes.list().find((each) => each.kind === 'command');
    const types = node
      ? world.tasks.nodes
          .channel(node.id)
          .read(0)
          .map((entry) => entry.type)
      : [];

    expect(types).toEqual(['opened', 'closed']);
    expect(nodeOf({ world, id: 'work' })?.state).toBe('completed');
  });
});
