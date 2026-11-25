import type { OutputReader } from '@sheavly/core/output/output.types';
import { channelNameSchema } from '@sheavly/protocol/channel/channel.validator';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import type { OutputRef } from '@sheavly/protocol/output/output.types';
import { startControlledTask } from '@sheavly/runtime/testing/controlled-task.fake';
import { conversation, conversationId } from '@sheavly/runtime/testing/stored-conversation.fake';
import { MemoryOutputStore } from '@sheavly/testing/store/memory-output.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import { HeldBytes } from '../subscriptions/held-bytes.service.js';
import { Subscription } from '../subscriptions/subscription.service.js';

type World = ReturnType<typeof conversation>;

const CALL = callIdSchema.parse('call_1');

/** A read budget and a pool no test comes near, unless the test gives its own. */
const ROOMY = 100_000_000;

/**
 * Test-only: a conversation with one command running in it, whose output goes to a memory output
 * store. `print` is what the command writes, `finish` ends it as a command that exited 0 and waits
 * until its node's channel is closed in the store. `node` is the command's channel, and `ref` the
 * log its output is stored in.
 */
export async function runningCommand() {
  const world = conversation();
  const outputs = new MemoryOutputStore();
  const { task, print, finish } = startControlledTask({
    tasks: world.tasks,
    sessionId: world.main.id,
    callId: CALL,
    command: 'make',
    description: 'build',
    capture: await outputs.create(),
  });
  const node = world.tasks.nodeIdOf(task.id);
  const ref = task.outputLog?.ref;

  if (!node || !ref) throw new Error('the command has no node or no output log');

  await world.writer.flush();

  return {
    world,
    outputs,
    node,
    ref,
    print,
    finish: async () => {
      finish(0);
      await until(() => world.tasks.get(task.id)?.status === 'completed');
      await world.writer.flush();
    },
  };
}

/**
 * Test-only: opens a subscription to the output channel of `node` from `from`, reading the output
 * from `reader` and following the command through the conversation's task registry. `followers`,
 * when given, counts how many followers of the capture are registered (`active`), so a test can see
 * that every way a subscription ends lets go of it; `budget` is the request's read budget.
 */
export function openOutput(params: {
  world: World;
  node: string;
  ref: OutputRef | undefined;
  reader: OutputReader;
  from: string;
  pool?: HeldBytes;
  budget?: number;
  followers?: { active: number };
  signal?: AbortSignal;
}) {
  const { world, node, ref, reader, from, followers } = params;

  return Subscription.open({
    writer: world.writer,
    output: {
      reader,
      follow: (follow) => {
        const stop = world.tasks.followOutput(follow);

        if (!followers || !stop) return stop;

        followers.active += 1;

        let stopped = false;

        return () => {
          if (!stopped) followers.active -= 1;

          stopped = true;
          stop();
        };
      },
    },
    channels: [
      {
        channel: channelNameSchema.parse(node),
        from,
        kind: 'byte',
        log: world.store.channel({ id: conversationId, channel: node }),
        output: ref,
      },
    ],
    budget: { left: params.budget ?? ROOMY },
    pool: params.pool ?? new HeldBytes(ROOMY),
    signal: params.signal,
    onClose: () => undefined,
  });
}

/** Test-only: `reader` that counts the reads of output made through it (`reads.count`). */
export function countedReads(reader: OutputReader) {
  const reads = { count: 0 };
  const counted: OutputReader = {
    log: (ref) => reader.log(ref),
    search: (search) => reader.search(search),
    read: (read) => {
      reads.count += 1;

      return reader.read(read);
    },
  };

  return { reader: counted, reads };
}

/**
 * Test-only: `reader` with its reads held until `release`, so a test can write while a subscription
 * is reading the output. `reached` is settled once a read has begun.
 */
export function pausedReads(reader: OutputReader) {
  const reached = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  const held: OutputReader = {
    log: (ref) => reader.log(ref),
    search: (search) => reader.search(search),
    read: async (read) => {
      reached.resolve(undefined);
      await gate.promise;

      return reader.read(read);
    },
  };

  return { reader: held, reached: reached.promise, release: () => gate.resolve(undefined) };
}
