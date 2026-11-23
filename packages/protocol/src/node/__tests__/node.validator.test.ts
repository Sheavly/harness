import { describe, expect, it } from 'vitest';
import {
  MAX_EXTENSION_DATA_BYTES,
  MAX_EXTENSION_TEXT_CHARS,
} from '../../extension/extension.constants.js';
import { RUN_OUTCOMES, NODE_STATES, NODE_STATE_OF_OUTCOME } from '../../status/status.constants.js';
import {
  MAX_NODE_CALL_ID_CHARS,
  MAX_NODE_COMMAND_CHARS,
  MAX_NODE_DESCRIPTION_CHARS,
  MAX_NODE_ERROR_CHARS,
  MAX_NODE_ID_CHARS,
  MAX_NODE_OUTPUT_CHARS,
  MAX_NODE_REASON_CHARS,
  MAX_NODE_STATUS_CHARS,
  MAX_NODE_TITLE_CHARS,
  RESERVED_EXTENSION_NAMES,
} from '../node.constants.js';
import { nodeIdSchema, nodeInfoSchema } from '../node.validator.js';

const AGENT = {
  kind: 'agent',
  id: 'agent-1',
  title: 'Update ESLint rules',
  state: 'running',
  startedAt: 1,
};
const COMMAND = {
  kind: 'command',
  id: 't1',
  title: 'npm test',
  state: 'running',
  startedAt: 1,
  command: 'npm test',
  description: 'run the tests',
  output: '',
};
const SERVICE = { ...COMMAND, kind: 'service', id: 't2', title: 'dev server' };
const NOTES = {
  kind: 'notes.sync',
  id: 'n1',
  title: 'Sync notes',
  state: 'running',
  startedAt: 1,
  version: 1,
  data: { pending: 3 },
  text: 'Syncing 3 notes',
};

/** Whether `value` is a node. */
const accepts = (value: unknown) => nodeInfoSchema.safeParse(value).success;

describe('a node', () => {
  it.each([
    ['an agent', AGENT],
    ['a command', COMMAND],
    ['a service', SERVICE],
    ['a kind an extension adds', NOTES],
  ])('is %s, kept as it was written', (_name, node) => {
    expect(nodeInfoSchema.parse(node)).toEqual(node);
  });

  it('keeps the fallback text and data of a kind it does not know', () => {
    const unknown = {
      ...NOTES,
      kind: 'somebody-else.thing',
      text: 'Doing a thing',
      data: { n: 1 },
    };
    const parsed = nodeInfoSchema.parse(unknown);

    expect(parsed).toMatchObject({
      kind: 'somebody-else.thing',
      text: 'Doing a thing',
      data: { n: 1 },
    });
  });

  it('carries what links it to the node and the tool call that started it', () => {
    const child = {
      ...AGENT,
      id: 'agent-2',
      parent: 'agent-1',
      spawnedBy: 'call_1',
      status: 'editing core',
    };

    expect(nodeInfoSchema.parse(child)).toEqual(child);
  });

  it.each([
    ['a kind that is neither built in nor in a namespace', { ...NOTES, kind: 'process' }],
    ['a kind in capitals', { ...NOTES, kind: 'Notes.sync' }],
    ['an extension kind with no fallback text', { ...NOTES, text: undefined }],
    ['an extension kind with empty fallback text', { ...NOTES, text: '' }],
    [
      'an extension kind with fallback text over the cap',
      { ...NOTES, text: 'x'.repeat(MAX_EXTENSION_TEXT_CHARS + 1) },
    ],
    [
      'an extension kind with data over the cap',
      { ...NOTES, data: { blob: 'x'.repeat(MAX_EXTENSION_DATA_BYTES) } },
    ],
    ['an extension kind with a version that is not positive', { ...NOTES, version: 0 }],
    ['a state that does not exist', { ...AGENT, state: 'stopped' }],
    ['a command with no command', { ...COMMAND, command: undefined }],
    ['an agent that is missing its title', { ...AGENT, title: undefined }],
    ['a node that is its own parent', { ...AGENT, parent: 'agent-1' }],
    [
      'a node spawned by a call whose id is not one',
      { ...AGENT, parent: 'agent-0', spawnedBy: 'c'.repeat(MAX_NODE_CALL_ID_CHARS + 1) },
    ],
  ])('is not %s', (_name, node) => {
    expect(accepts(node)).toBe(false);
  });
});

describe('a kind an extension adds', () => {
  it.each(RESERVED_EXTENSION_NAMES)('cannot take %s, which is ours, as its extension', (name) => {
    expect(accepts({ ...NOTES, kind: `${name}.sync` })).toBe(false);
  });

  it('can take a name that only starts like ours', () => {
    expect(accepts({ ...NOTES, kind: 'agents.sync' })).toBe(true);
    expect(accepts({ ...NOTES, kind: 'tree-view.sync' })).toBe(true);
  });

  it('is refused, not thrown at, when its data cannot be serialized', () => {
    const cycle: { self?: unknown } = {};

    cycle.self = cycle;

    expect(accepts({ ...NOTES, data: cycle })).toBe(false);
  });
});

describe.each([
  ['command', MAX_NODE_COMMAND_CHARS],
  ['description', MAX_NODE_DESCRIPTION_CHARS],
  ['reason', MAX_NODE_REASON_CHARS],
  ['output', MAX_NODE_OUTPUT_CHARS],
  ['error', MAX_NODE_ERROR_CHARS],
])('the %s of a command node', (field, cap) => {
  const withText = (length: number) => ({ ...COMMAND, [field]: 'x'.repeat(length) });

  it('takes as much as its cap, so the largest the runtime keeps fits', () => {
    expect(accepts(withText(cap))).toBe(true);
  });

  it('is refused past its cap, so a snapshot cannot be made to carry a megabyte', () => {
    expect(accepts(withText(cap + 1))).toBe(false);
  });

  it('is capped on a service as well', () => {
    expect(accepts({ ...SERVICE, [field]: 'x'.repeat(cap + 1) })).toBe(false);
  });
});

describe('a node id', () => {
  it.each(['agent-1', 't1', '0f8fad5b-d9cb-469f-a165-70867728950e', 'a_b-c'])(
    'accepts %s',
    (id) => {
      expect(nodeIdSchema.safeParse(id).success).toBe(true);
    },
  );

  it.each([
    ['tree, the name of the tree channel', 'tree'],
    ['Tree, which would read as it', 'Tree'],
    ['capitals, which collide by case on some disks', 'A1'],
    ['an empty id', ''],
    ['a path', 'a/b'],
    ['a space', 'a b'],
    ['one that starts with a hyphen', '-a'],
    ['one over the cap', 'a'.repeat(MAX_NODE_ID_CHARS + 1)],
  ])('refuses %s', (_name, id) => {
    expect(nodeIdSchema.safeParse(id).success).toBe(false);
  });
});

describe.each([
  ['title', MAX_NODE_TITLE_CHARS],
  ['status', MAX_NODE_STATUS_CHARS],
])('a node %s', (field, cap) => {
  const withText = (text: string) => ({ ...AGENT, [field]: text });

  it.each(['Update ESLint rules', 'Édition 2', 'rocket 🚀', 'a'.repeat(cap)])(
    'accepts one line of text: %s',
    (text) => {
      expect(accepts(withText(text))).toBe(true);
    },
  );

  it.each([
    ['a newline', 'one\ntwo'],
    ['a tab', 'one\ttwo'],
    ['an escape sequence', 'ok\u001b[31mred'],
    ['a zero-width joiner', 'a\u200db'],
    ['a line separator', 'a\u2028b'],
    ['a lone surrogate, which is not text', 'a\ud800b'],
    ['a private-use character', 'a\ue000b'],
    ['an empty text', ''],
    ['text of spaces only', '   '],
    ['text of non-breaking spaces only', '\u00a0\u00a0'],
    ['a Hangul filler only, which draws as nothing', '\u3164'],
    ['a Braille blank only, which draws as nothing', '\u2800'],
    ['text over the cap', 'a'.repeat(cap + 1)],
  ])('refuses %s', (_name, text) => {
    expect(accepts(withText(text))).toBe(false);
  });

  it('does not take a title for an identity: look-alike letters are accepted', () => {
    // A Cyrillic "а" reads as a Latin "a": the schema cannot tell, so no front end trusts a title.
    expect(accepts(withText('\u0430dmin'))).toBe(true);
  });
});

describe('a node whose state and end disagree', () => {
  it.each([
    ['a command that is idle', { ...COMMAND, state: 'idle' }],
    ['a service that is idle', { ...SERVICE, state: 'idle' }],
    ['an extension kind that is idle', { ...NOTES, state: 'idle' }],
    ['a running node that has ended', { ...AGENT, endedAt: 2 }],
    ['an idle agent that has ended', { ...AGENT, state: 'idle', endedAt: 2 }],
    ['an ended command with no end time', { ...COMMAND, state: 'failed' }],
    ['a lost command with no end time', { ...COMMAND, state: 'lost' }],
  ])('is not %s', (_name, node) => {
    expect(accepts(node)).toBe(false);
  });

  it.each([
    ['an idle agent', { ...AGENT, state: 'idle', lastOutcome: 'completed' }],
    ['an ended command', { ...COMMAND, state: 'failed', endedAt: 2, exitCode: 1 }],
    ['a lost command', { ...COMMAND, state: 'lost', endedAt: 2 }],
    ['a lost extension node', { ...NOTES, state: 'lost', endedAt: 2 }],
  ])('accepts %s', (_name, node) => {
    expect(accepts(node)).toBe(true);
  });
});

describe('an agent that ended', () => {
  // The key is left out, not set to undefined: an optional field refuses an explicit undefined.
  const ended = (state: string, lastOutcome?: string) => ({
    ...AGENT,
    state,
    endedAt: 2,
    ...(lastOutcome !== undefined && { lastOutcome }),
  });

  it.each(RUN_OUTCOMES.map((outcome) => [outcome, NODE_STATE_OF_OUTCOME[outcome]] as const))(
    'a run that ended %s makes the node %s',
    (outcome, state) => {
      expect(accepts(ended(state, outcome))).toBe(true);

      for (const other of NODE_STATES.filter((candidate) => candidate !== state)) {
        expect(accepts(ended(other, outcome)), `${outcome} as ${other}`).toBe(other === 'lost');
      }
    },
  );

  it('needs the outcome of the run that ended it, unless the server was lost under it', () => {
    expect(accepts(ended('completed'))).toBe(false);
    expect(accepts(ended('failed'))).toBe(false);
    expect(accepts(ended('cancelled'))).toBe(false);
    expect(accepts(ended('lost'))).toBe(true);
  });
});
