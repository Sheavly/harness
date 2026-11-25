import { describe, expect, it } from 'vitest';
import type { StoredChunk } from '@sheavly/core/output/output.types';
import { MemoryOutputStore } from '@sheavly/testing/store/memory-output.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import { TaskRegistry } from '../tasks.service.js';

/**
 * A command that prints when the test says so and ends when it says so, with a capture in a
 * memory output store unless `captured` is false.
 */
async function command(params: { tasks: TaskRegistry; captured?: boolean }) {
  const capture = params.captured === false ? undefined : await new MemoryOutputStore().create();
  let print: (chunk: string) => void = () => undefined;
  let finish: () => void = () => undefined;
  const task = params.tasks.start({
    command: 'make',
    description: 'build',
    ...(capture && { capture }),
    run: ({ onOutput }) =>
      new Promise((resolve) => {
        print = onOutput;
        finish = () => resolve({ exitCode: 0 });
      }),
  });
  const nodeId = params.tasks.nodeIdOf(task.id);

  if (!nodeId) throw new Error('the task has no node');

  return { task, nodeId, print: (chunk: string) => print(chunk), finish: () => finish() };
}

describe('following the output of the command a node is', () => {
  it('tells each chunk once it is stored, with its offset, to a follower that asked by the node', async () => {
    const tasks = new TaskRegistry();
    const { nodeId, print, finish, task } = await command({ tasks });
    const told: StoredChunk[] = [];

    tasks.followOutput({ nodeId, listener: (chunk) => told.push(chunk) });
    print('héllo ');
    print('world');
    finish();
    await until(() => tasks.get(task.id)?.status === 'completed');

    expect(told).toEqual([
      { offset: 0, text: 'héllo ' },
      { offset: 7, text: 'world' },
    ]);
  });

  it('does not tell what was stored before the follower asked: the store has it', async () => {
    const tasks = new TaskRegistry();
    const { nodeId, print } = await command({ tasks });
    const told: string[] = [];

    print('before ');
    tasks.followOutput({ nodeId, listener: (chunk) => told.push(chunk.text) });
    print('after');

    expect(told).toEqual(['after']);
  });

  it('gives a stop, and a follower that stopped hears no more', async () => {
    const tasks = new TaskRegistry();
    const { nodeId, print } = await command({ tasks });
    const told: string[] = [];
    const stop = tasks.followOutput({ nodeId, listener: (chunk) => told.push(chunk.text) });

    print('one');
    stop?.();
    print('two');

    expect(told).toEqual(['one']);
  });

  it('is nothing to follow for a node that is not a task of this registry with a capture', async () => {
    const tasks = new TaskRegistry();
    const uncaptured = await command({ tasks, captured: false });
    const none = () => undefined;

    expect(tasks.followOutput({ nodeId: uncaptured.nodeId, listener: none })).toBeUndefined();
    expect(tasks.followOutput({ nodeId: nodeIdOfNobody(), listener: none })).toBeUndefined();
  });

  it('is nothing to follow once the task is released, and a follower of one that has ended hears nothing more', async () => {
    const tasks = new TaskRegistry();
    const { task, nodeId, finish } = await command({ tasks });

    finish();
    await until(() => tasks.get(task.id)?.status === 'completed');

    const told: string[] = [];
    const stop = tasks.followOutput({ nodeId, listener: (chunk) => told.push(chunk.text) });

    // Its capture is closed: there is a stop to give, and nothing will come.
    expect(stop).toBeTypeOf('function');
    expect(told).toEqual([]);

    // A task whose notice has not been delivered is not released: the loop takes it first.
    tasks.takeDeliveries();

    expect(tasks.release(task.id)).toBe(true);
    expect(tasks.followOutput({ nodeId, listener: () => undefined })).toBeUndefined();
  });
});

/** The id of a node no registry has. */
function nodeIdOfNobody() {
  return 'no-such-node' as never;
}
