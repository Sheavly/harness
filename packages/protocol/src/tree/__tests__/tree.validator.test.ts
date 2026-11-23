import { describe, expect, it } from 'vitest';
import { MAX_NODE_ERROR_CHARS, MAX_TREE_NODES } from '../../node/node.constants.js';
import { MAX_QUEUED_LINE_CHARS } from '../../server/server.constants.js';
import { treeChannelEntrySchema, treeSnapshotSchema } from '../tree.validator.js';

const MESSAGE_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const RUNNING = { kind: 'agent', id: 'agent-1', title: 'Main', state: 'running', startedAt: 1 };
const IDLE = { ...RUNNING, state: 'idle' };
const ENDED = {
  ...RUNNING,
  id: 'agent-2',
  parent: 'agent-1',
  state: 'completed',
  endedAt: 2,
  lastOutcome: 'completed',
};
const REQUEST = {
  id: 'a1',
  callId: 'call_1',
  tool: 'run_command',
  command: 'git push',
  concerns: [],
  options: ['approve', 'skip'],
};

/** An entry of the tree channel: `more` is what its type holds. */
const entry = (type: string, more: object = {}, cursor = 's3') => ({
  channel: 'tree',
  cursor,
  at: 5,
  type,
  ...more,
});
const accepts = (value: unknown) => treeChannelEntrySchema.safeParse(value).success;

describe('an entry of the tree channel', () => {
  it.each([
    ['the tree opening', entry('opened', {}, 's0')],
    ['the tree closing', entry('closed')],
    ['a node opening', entry('node_opened', { node: RUNNING })],
    ['an agent opening idle', entry('node_opened', { node: IDLE })],
    ['a node changing', entry('node_updated', { node: { ...RUNNING, status: 'editing core' } })],
    ['a node closing', entry('node_closed', { node: ENDED })],
    ['an approval asked for', entry('approval_requested', { node: 'agent-1', request: REQUEST })],
    [
      'an approval answered',
      entry('approval_resolved', { node: 'agent-1', id: 'a1', response: { decision: 'approve' } }),
    ],
    ['an approval given up', entry('approval_cancelled', { node: 'agent-1', id: 'a1' })],
    ['the queue changing', entry('queue_changed', { queued: ['one', 'two'] })],
    [
      'a queued line starting',
      entry('prompt_started', { text: 'go', messageId: MESSAGE_ID, queued: [] }),
    ],
    [
      'a queued line refused',
      entry('prompt_refused', { text: 'go', error: 'unknown skill', queued: [] }),
    ],
    ['a storage failure', entry('storage_failed', { error: 'disk full' })],
    [
      'an extension’s event',
      entry('extension_event', {
        extension: 'notes',
        kind: 'notes.sync',
        version: 1,
        data: { n: 1 },
        text: 'Synced',
      }),
    ],
  ])('accepts %s', (_name, value) => {
    expect(accepts(value)).toBe(true);
  });

  it.each([
    ['a node that opens ended', entry('node_opened', { node: ENDED })],
    ['a node that is updated after it ended', entry('node_updated', { node: ENDED })],
    ['a node that closes still running', entry('node_closed', { node: RUNNING })],
    ['a node that closes idle', entry('node_closed', { node: IDLE })],
    [
      'an entry of another channel',
      { ...entry('node_opened', { node: RUNNING }), channel: 'agent-1' },
    ],
    ['a byte offset in the tree channel', entry('node_opened', { node: RUNNING }, 'b3')],
    ['a type it does not have', entry('node_renamed', { node: RUNNING })],
    [
      'an approval asked by the tree',
      entry('approval_requested', { node: 'tree', request: REQUEST }),
    ],
    [
      'an approval answered with no response',
      entry('approval_resolved', { node: 'agent-1', id: 'a1' }),
    ],
    [
      'a queued line that starts with no message id',
      entry('prompt_started', { text: 'go', queued: [] }),
    ],
    [
      'a queued line that starts with a message id that is not one',
      entry('prompt_started', { text: 'go', messageId: 'm1', queued: [] }),
    ],
    [
      'a queue with a line over the cap',
      entry('queue_changed', { queued: ['x'.repeat(MAX_QUEUED_LINE_CHARS + 1)] }),
    ],
    ['a storage failure that says nothing', entry('storage_failed')],
    [
      'a storage failure with an error over the cap',
      entry('storage_failed', { error: 'x'.repeat(MAX_NODE_ERROR_CHARS + 1) }),
    ],
    [
      'a refused line with text over the cap',
      entry('prompt_refused', {
        text: 'x'.repeat(MAX_QUEUED_LINE_CHARS + 1),
        error: 'e',
        queued: [],
      }),
    ],
    [
      'a started line with text over the cap',
      entry('prompt_started', {
        text: 'x'.repeat(MAX_QUEUED_LINE_CHARS + 1),
        messageId: MESSAGE_ID,
        queued: [],
      }),
    ],
    [
      'an extension’s event that takes the name of a built-in kind',
      entry('extension_event', {
        extension: 'agent',
        kind: 'agent.sync',
        version: 1,
        data: {},
        text: 'x',
      }),
    ],
    [
      'an extension’s event that takes the name of the tree channel',
      entry('extension_event', {
        extension: 'tree',
        kind: 'tree.sync',
        version: 1,
        data: {},
        text: 'x',
      }),
    ],
    [
      'an extension’s event outside its namespace',
      entry('extension_event', {
        extension: 'notes',
        kind: 'other.sync',
        version: 1,
        data: {},
        text: 'x',
      }),
    ],
    [
      'an extension’s event with no fallback text',
      entry('extension_event', { extension: 'notes', kind: 'notes.sync', version: 1, data: {} }),
    ],
  ])('refuses %s', (_name, value) => {
    expect(accepts(value)).toBe(false);
  });
});

describe('a snapshot of the tree', () => {
  const snapshot = (more: object = {}) => ({
    channel: 'tree',
    cursor: 's41',
    at: 9,
    type: 'snapshot',
    nodes: [RUNNING, ENDED],
    approvals: [{ node: 'agent-1', request: REQUEST }],
    ...more,
  });
  const accepted = (value: unknown) => treeSnapshotSchema.safeParse(value).success;

  it.each([
    ['nodes, an ended one among them, and a waiting approval', snapshot()],
    ['a tree with nothing in it yet', snapshot({ nodes: [], approvals: [] })],
    ['nodes and nothing waiting', snapshot({ approvals: [] })],
    [
      'as many nodes as it may, in one chain',
      snapshot({
        nodes: Array.from({ length: MAX_TREE_NODES }, (_unused, index) => ({
          ...RUNNING,
          id: `n${String(index)}`,
          ...(index > 0 && { parent: `n${String(index - 1)}` }),
        })),
        approvals: [],
      }),
    ],
  ])('holds %s', (_name, value) => {
    expect(accepted(value)).toBe(true);
  });

  it.each([
    ['a node twice', snapshot({ nodes: [RUNNING, RUNNING] })],
    ['a node whose parent is not in it', snapshot({ nodes: [ENDED] })],
    [
      'an approval asked by a node that is not in it',
      snapshot({ approvals: [{ node: 'agent-9', request: REQUEST }] }),
    ],
    [
      'an approval twice',
      snapshot({
        approvals: [
          { node: 'agent-1', request: REQUEST },
          { node: 'agent-2', request: REQUEST },
        ],
      }),
    ],
    ['a node that is its own parent', snapshot({ nodes: [{ ...RUNNING, parent: 'agent-1' }] })],
    [
      'two nodes that are each other’s parent',
      snapshot({
        nodes: [
          { ...RUNNING, parent: 'agent-2' },
          { ...ENDED, parent: 'agent-1' },
        ],
      }),
    ],
    [
      'a chain of parents that returns to itself below a root',
      snapshot({
        nodes: [
          RUNNING,
          { ...ENDED, id: 'a', parent: 'b' },
          { ...ENDED, id: 'b', parent: 'c' },
          { ...ENDED, id: 'c', parent: 'a' },
        ],
      }),
    ],
    [
      'more nodes than a tree may hold',
      snapshot({
        nodes: Array.from({ length: MAX_TREE_NODES + 1 }, (_unused, index) => ({
          ...RUNNING,
          id: `n${String(index)}`,
        })),
        approvals: [],
      }),
    ],
    ['a byte offset to continue from', snapshot({ cursor: 'b41' })],
    ['a frame that is not a snapshot', snapshot({ type: 'node_opened' })],
    ['another channel', snapshot({ channel: 'agent-1' })],
  ])('is not %s', (_name, value) => {
    expect(accepted(value)).toBe(false);
  });
});
