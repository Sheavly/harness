import { describe, expect, it } from 'vitest';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import {
  MAX_NODE_DESCRIPTION_CHARS,
  MAX_NODE_OUTPUT_CHARS,
} from '@sheavly/protocol/node/node.constants';
import { treeChannelEntrySchema } from '@sheavly/protocol/tree/tree.validator';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { startControlledTask } from '../../testing/controlled-task.fake.js';
import { shapeOf } from '../../testing/stored-channels.fake.js';
import { treeConversation, treeEntriesOf } from '../../testing/tree-conversation.fake.js';
import { MAX_TREE_ENTRY_CHARS } from '../nodes.constants.js';

// What a command's or a service's entries on the tree channel carry when its texts are more than an
// entry holds: they are cut, never refused, because one entry the store refuses ends the channel.

const CALL = callIdSchema.parse('call_1');

useFixedClock();

/** The entry that closes a command that printed `output` and exited, once its task has settled. */
async function closedEntryOf(output: string) {
  const world = treeConversation();
  const { finish } = startControlledTask({
    tasks: world.tasks,
    sessionId: world.main.id,
    callId: CALL,
    backgroundKind: 'task',
    output,
  });

  finish(0);
  // The task settles a few ticks after `finish`.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  return (await treeEntriesOf(world)).find((each) => each.type === 'node_closed');
}

describe('a command that ends with output that costs more than an entry as JSON', () => {
  // Each control character is six characters as JSON, so what the registry keeps of an output (many
  // lines of up to a thousand characters, thirty thousand in all) is far over what a stored entry
  // may be, though it is within what the wire allows.
  const NOISE = `${'\u001b'.repeat(999)}\n`.repeat(50);

  it('is stored with the end of its output cut, and the tree goes on', async () => {
    const world = treeConversation();
    const { finish } = startControlledTask({
      tasks: world.tasks,
      sessionId: world.main.id,
      callId: CALL,
      backgroundKind: 'task',
      command: 'cat noise',
      output: `${NOISE}tail`,
    });

    finish(0);
    // The task settles a few ticks after `finish`.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // What comes after is stored too: one entry the store refused would have ended the channel.
    startControlledTask({
      tasks: world.tasks,
      sessionId: world.main.id,
      callId: CALL,
      backgroundKind: 'service',
    });

    const entries = await treeEntriesOf(world);
    const closed = entries.find((each) => each.type === 'node_closed');
    const output = (closed?.node as { output: string }).output;

    expect(shapeOf(entries)).toEqual([
      'opened s0',
      'node_opened s1',
      'node_opened s2',
      'node_closed s3',
      'node_opened s4',
    ]);
    expect(JSON.stringify(closed).length).toBeLessThanOrEqual(MAX_TREE_ENTRY_CHARS);
    // The most recent part is what is kept, and it is not all of it.
    expect(output.endsWith('tail')).toBe(true);
    expect(output.length).toBeLessThan(MAX_NODE_OUTPUT_CHARS);
    expect(world.treeFailures).toEqual([]);
    expect(world.tree.writing()).toBe(true);
  });

  it('is cut in its description too when that is what costs most: a task an extension starts may fill it', async () => {
    const world = treeConversation();

    // The description is at its cap (2,000) and the command is large, both of control characters:
    // together they are over what an entry carries, and the description costs most.
    startControlledTask({
      tasks: world.tasks,
      sessionId: world.main.id,
      callId: CALL,
      backgroundKind: 'service',
      command: '\u0001'.repeat(1_500),
      description: '\u0001'.repeat(MAX_NODE_DESCRIPTION_CHARS),
    });
    // What comes after is stored too: one entry the store refused would have ended the channel.
    startControlledTask({
      tasks: world.tasks,
      sessionId: world.main.id,
      callId: CALL,
      backgroundKind: 'service',
    });

    const entries = await treeEntriesOf(world);
    const opened = entries[2]?.node as { command: string; description: string };

    expect(JSON.stringify(entries[2]).length).toBeLessThanOrEqual(MAX_TREE_ENTRY_CHARS);
    expect(treeChannelEntrySchema.safeParse(entries[2]).success).toBe(true);
    expect(opened.description.length).toBeLessThan(MAX_NODE_DESCRIPTION_CHARS);
    expect(opened.description.length).toBeGreaterThan(0);
    // The command, which costs less, is whole.
    expect(opened.command).toHaveLength(1_500);
    expect(shapeOf(entries).at(-1)).toBe('node_opened s3');
    expect(world.treeFailures).toEqual([]);
  });

  it('is cut from its start between characters, and what it held that was not text is replaced', async () => {
    // An odd prefix, so a cut at half lands inside a two-unit character, and a lone surrogate in it.
    const closed = await closedEntryOf(`a${'😀'.repeat(14_999)}\ud800b`);
    const { output } = closed?.node as { output: string };

    expect(output.isWellFormed()).toBe(true);
    expect(output.endsWith('b')).toBe(true);
    expect(JSON.stringify(closed).isWellFormed()).toBe(true);
  });

  it('keeps all of an output that fits', async () => {
    expect((await closedEntryOf('all of it'))?.node).toMatchObject({ output: 'all of it' });
  });
});
