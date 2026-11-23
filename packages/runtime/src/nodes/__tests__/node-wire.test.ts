import {
  MAX_NODE_STATUS_CHARS,
  MAX_NODE_TITLE_CHARS,
  SINGLE_LINE_PATTERN,
} from '@sheavly/protocol/node/node.constants';
import { nodeInfoSchema } from '@sheavly/protocol/node/node.validator';
import { describe, expect, it } from 'vitest';
import { NodeRegistry } from '../node-registry.service.js';
import { HEAD_FACTOR, NOT_ONE_LINE, UNTITLED } from '../nodes.constants.js';
import { oneLineOf } from '../nodes.utils.js';

/** Titles and status reports a tool or a model can produce, none of them one line of text. */
const NASTY = [
  'two\nlines',
  'tab\there',
  'carriage\r\nreturn',
  'escape \u001b]52;c;data\u0007 sequence',
  'bidi \u202eoverride',
  'zero\u200bwidth',
  'line\u2028separator',
  '\ud800 lone surrogate',
  '\ue000 private use',
  'long '.repeat(200),
  '日本語のとても長いタイトル'.repeat(40),
];

describe('a text as a node’s title or status', () => {
  it.each([
    ['one line, kept as it is', 'Update ESLint rules', 'Update ESLint rules'],
    ['a newline, which becomes a space', 'two\nlines', 'two lines'],
    ['runs of space, which become one', 'a \t\n  b', 'a b'],
    ['control characters, which become spaces', 'a\u001bb', 'a b'],
    ['space at both ends, which goes', '  x  ', 'x'],
  ])('keeps %s', (_name, text, line) => {
    expect(oneLineOf({ text, max: 200 })).toBe(line);
  });

  it.each([
    ['nothing', ''],
    ['spaces', '   '],
    ['only newlines', '\n\n'],
    ['only what draws as nothing', '\u3164\u2800'],
  ])('is none for %s, so a caller picks what stands for it', (_name, text) => {
    expect(oneLineOf({ text, max: 200 })).toBeUndefined();
  });

  it('is cut to the cap in whole characters, and cut text that ends in space loses it', () => {
    expect(oneLineOf({ text: 'abcdef', max: 3 })).toBe('abc');
    expect(oneLineOf({ text: 'ab de', max: 3 })).toBe('ab');
    expect(oneLineOf({ text: '😀😀😀', max: 2 })).toBe('😀😀');
  });

  it('reads only the head of a huge input, so it costs no more than a long one', () => {
    const huge = `${'x'.repeat(100)}${'y'.repeat(20_000_000)}`;
    const started = performance.now();
    const line = oneLineOf({ text: huge, max: MAX_NODE_TITLE_CHARS });

    expect(line).toBe(huge.slice(0, MAX_NODE_TITLE_CHARS));
    // Linear in the head, not in the input: a 20 MB input is not a second of blocked CPU.
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('reads blank when the title opens with more blank than the head holds: the price of the bound', () => {
    const blanks = ' '.repeat(MAX_NODE_TITLE_CHARS * HEAD_FACTOR);

    expect(oneLineOf({ text: `${blanks}title`, max: MAX_NODE_TITLE_CHARS })).toBeUndefined();
    expect(oneLineOf({ text: `${blanks.slice(1)}title`, max: MAX_NODE_TITLE_CHARS })).toBe('t');
  });

  it.each(NASTY)('is always valid on the wire: %j', (text) => {
    const line = oneLineOf({ text, max: MAX_NODE_TITLE_CHARS });

    expect(line).toBeDefined();
    expect(line?.length).toBeLessThanOrEqual(MAX_NODE_TITLE_CHARS);
    expect(SINGLE_LINE_PATTERN.test(line ?? '')).toBe(true);
  });
});

describe('the characters a line may not hold', () => {
  it('are the ones the protocol refuses in a title, over the whole basic plane', () => {
    const disagreements = Array.from({ length: 0x10000 }, (_unused, code) =>
      String.fromCharCode(code),
    ).filter((character) => {
      const refused = !SINGLE_LINE_PATTERN.test(character);
      const replaced = character.replace(NOT_ONE_LINE, '') !== character;

      // Space is refused by neither; the rest of a title's rule is that it is not blank.
      return refused !== replaced;
    });

    expect(disagreements).toEqual([]);
  });
});

describe('what the registry holds', () => {
  it.each(NASTY)('is an agent node the protocol parses, whatever its title: %j', (title) => {
    const registry = new NodeRegistry();
    const node = registry.open({ kind: 'agent', title });

    registry.setStatus({ id: node.id, status: title });

    expect(nodeInfoSchema.safeParse(registry.get(node.id)).success).toBe(true);
    expect(registry.get(node.id)?.title.length).toBeLessThanOrEqual(MAX_NODE_TITLE_CHARS);
    expect(registry.get(node.id)?.status?.length ?? 0).toBeLessThanOrEqual(MAX_NODE_STATUS_CHARS);
  });

  it('gives a node with no title text a title of its own, so it still parses', () => {
    const registry = new NodeRegistry();
    const node = registry.open({ kind: 'agent', title: '\n\n' });

    expect(registry.get(node.id)?.title).toBe(UNTITLED);
    expect(nodeInfoSchema.safeParse(registry.get(node.id)).success).toBe(true);
  });

  it('keeps a command’s title one line too: it comes from a description a model wrote', () => {
    const registry = new NodeRegistry();
    const node = registry.open({ kind: 'command', title: 'run\nthe tests\u001b[31m' });

    expect(registry.get(node.id)?.title).toBe('run the tests [31m');
  });

  it('ignores a status report with nothing in it: the last one stands, and nothing is logged', () => {
    const registry = new NodeRegistry();
    const node = registry.open({ kind: 'agent', title: 'main' });

    registry.setStatus({ id: node.id, status: 'editing' });

    expect(registry.setStatus({ id: node.id, status: ' \n ' })).toBe(false);
    expect(registry.get(node.id)?.status).toBe('editing');
    expect(registry.channel(node.id).read(0)).toHaveLength(2);
  });

  it('shortens what it puts back from a stored conversation, as it does a new one', () => {
    const registry = new NodeRegistry();
    const node = registry.restore({
      kind: 'agent',
      title: `${'t'.repeat(500)}\nmore`,
      startedAt: 1,
      state: 'idle',
      status: 'a\nb',
    });

    expect(registry.get(node.id)?.title).toHaveLength(MAX_NODE_TITLE_CHARS);
    expect(registry.get(node.id)?.status).toBe('a b');
    expect(nodeInfoSchema.safeParse(registry.get(node.id)).success).toBe(true);
  });
});
