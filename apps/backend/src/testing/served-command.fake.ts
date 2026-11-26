import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { startControlledTask } from '@sheavly/runtime/testing/controlled-task.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import type { servedConversation } from './served-conversation.fake.js';

type Served = Awaited<ReturnType<typeof servedConversation>>;

/**
 * Test-only: a command the main agent of `world` started and that goes on running, with its output
 * captured in the conversation's output store as `run_command`'s is. `node` is its channel, `print`
 * is what it writes, and `finish` ends it as a command that exited 0 and waits until its channel is
 * closed in the store. `kind` makes it a service instead; `task` is the registry's view of it.
 */
export async function servedCommand(world: Served, kind: 'task' | 'service' = 'task') {
  const { harness } = world;
  const { task, print, finish } = startControlledTask({
    tasks: harness.tasks,
    sessionId: harness.mainSession.id,
    callId: callIdSchema.parse('call_1'),
    backgroundKind: kind,
    command: 'make',
    description: 'build',
    capture: await world.store.outputs(world.conversation).create(),
  });
  const node = harness.tasks.nodeIdOf(task.id);

  if (!node) throw new Error('the command has no node');

  await harness.nodeChannels?.flush();

  return {
    node,
    taskId: task.id,
    print,
    finish: async () => {
      finish(0);
      // A conversation delivers a finished task and releases it at once, so it may already be gone.
      await until(() => harness.tasks.get(task.id)?.status !== 'running');
      await harness.nodeChannels?.flush();
    },
  };
}
