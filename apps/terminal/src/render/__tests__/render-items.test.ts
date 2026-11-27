import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { callIdSchema, messageIdSchema } from '@sheavly/protocol/message/message.validator';
import { nodeIdSchema } from '@sheavly/protocol/node/node.validator';
import type { ChatItem, SubAgentCard } from '../../client/transcript.types.js';
import { scriptEntries, scriptItems } from '../../testing/run-script.fake.js';
import { batchOf, step } from '../../testing/steps.fake.js';
import { createChatLook } from '../chat-look.utils.js';
import { logLook } from '../log-look.utils.js';
import { Renderer } from '../render.service.js';
import type { Look } from '../render.types.js';

const MAIN = 'main';

type OmittedItem = Extract<ChatItem, { type: 'event_omitted' }>;

/** The text a renderer on `look` writes for `draw`, and the renderer itself. */
function drawn(params: { look: Look; draw: (renderer: Renderer) => void }) {
  let out = '';
  const renderer = new Renderer((text) => (out += text), params.look);

  params.draw(renderer);

  return { renderer, out: () => stripVTControlCharacters(out) };
}

const card = (overrides: Partial<SubAgentCard> = {}): SubAgentCard => ({
  id: nodeIdSchema.parse('worker'),
  title: 'Helper',
  depth: 2,
  parent: nodeIdSchema.parse('main'),
  root: nodeIdSchema.parse('main'),
  state: 'running',
  ...overrides,
});

describe.each([
  { name: 'chat', look: createChatLook() },
  { name: 'log', look: logLook },
])('Renderer: the same run from the stream and from the feed ($name look)', ({ look }) => {
  /** The one script, told through the two paths: the stream's entries and the feed's items. */
  const twoWays = () => ({
    fromStream: drawn({
      look,
      draw: (renderer) => {
        for (const entry of scriptEntries()) renderer.entry(entry, MAIN);
      },
    }),
    fromItems: drawn({
      look,
      draw: (renderer) => {
        for (const item of scriptItems()) renderer.item(item);
      },
    }),
  });

  it('writes exactly the same text for one scripted run, whichever way it is told', () => {
    const { fromStream, fromItems } = twoWays();

    expect(fromItems.out()).toBe(fromStream.out());
    // The script is no empty one: a card and the notices are in what both wrote.
    expect(fromItems.out()).toContain('Helper');
    expect(fromItems.out()).toContain('acme: Deploy finished');
    expect(fromItems.out()).toContain('disk full');
  });

  it('keeps the same changes and running tools whichever way it is told', () => {
    const { fromStream, fromItems } = twoWays();

    expect(fromItems.renderer.changes.edits).toHaveLength(1);
    expect(fromItems.renderer.changes.edits).toEqual(fromStream.renderer.changes.edits);
    expect(fromItems.renderer.running).toEqual(fromStream.renderer.running);
  });
});

describe('Renderer.item: an event too large to store', () => {
  const [build] = step('c1', 'Build');
  const [lint] = step('c2', 'Lint');
  const omitted = (call?: { name: string; id: string }): OmittedItem => ({
    type: 'event_omitted',
    eventType: 'tool_result',
    seq: 4,
    size: 90_000,
    ...(call && { call: { id: callIdSchema.parse(call.id), name: call.name } }),
  });
  const running = (renderer: Renderer) => renderer.running.map(({ id }) => id);

  function startedTwo(renderer: Renderer): void {
    for (const event of [build, lint, batchOf(build, lint)]) {
      renderer.item({ type: 'event', event });
    }
  }

  it('ends the running step of its call, and shows its held title with the line (chat)', () => {
    const { renderer, out } = drawn({ look: createChatLook(), draw: startedTwo });

    expect(running(renderer)).toEqual(['c1', 'c2']);
    renderer.item(omitted({ id: 'c1', name: 'run_command' }));

    expect(running(renderer)).toEqual(['c2']);
    expect(out()).toBe('⏺ Build  $ c1\n  ⎿ ⚠ the result of run_command was too large to show\n');
  });

  it('ends the running step of its call in the plain log too, naming the tool', () => {
    const { renderer, out } = drawn({ look: logLook, draw: startedTwo });

    renderer.item(omitted({ id: 'c2', name: 'run_command' }));

    expect(running(renderer)).toEqual(['c1']);
    expect(out()).toContain('the result of run_command was too large to store');
  });

  it('says only the event’s type when no call is named, and leaves the running tools as they are', () => {
    const { renderer, out } = drawn({ look: createChatLook(), draw: startedTwo });
    const before = renderer.running;

    renderer.item(omitted());

    expect(renderer.running).toBe(before);
    expect(out()).toContain('⚠ a tool_result event was too large to show');
  });

  it('does not call a call that started, or became a task, a result: it names the event’s type', () => {
    const { renderer, out } = drawn({ look: createChatLook(), draw: startedTwo });

    renderer.item({
      ...omitted({ id: 'c1', name: 'run_command' }),
      eventType: 'tool_call_started',
    });

    expect(out()).toContain('⚠ a tool_call_started event was too large to show');
    expect(out()).not.toContain('the result of');
  });

  it('leaves the running tools as they are for a call that does not run', () => {
    const { renderer } = drawn({ look: createChatLook(), draw: startedTwo });
    const before = renderer.running;

    renderer.item(omitted({ id: 'c9', name: 'read_file' }));

    expect(renderer.running).toBe(before);
  });

  it('escapes the tool name and the event type before they are written', () => {
    const named = drawn({
      look: createChatLook(),
      draw: (renderer) => renderer.item(omitted({ id: 'c1', name: 'a\u001b[2Jb' })),
    });
    const typed = drawn({
      look: createChatLook(),
      draw: (renderer) => renderer.item({ ...omitted(), eventType: 'x\u001b]0;t' }),
    });

    expect(named.out()).not.toContain('\u001b');
    expect(named.out()).toContain('a\\u001b[2Jb');
    expect(typed.out()).not.toContain('\u001b');
    expect(typed.out()).toContain('x\\u001b]0;t');
  });
});

describe('Renderer.item: a sub-agent card', () => {
  const agent = (params: { change: 'started' | 'status' | 'ended'; card: SubAgentCard }) =>
    ({ type: 'agent', change: params.change, agent: params.card }) satisfies ChatItem;

  it('draws a start, a status and an end, indented by depth', () => {
    const { out } = drawn({
      look: createChatLook(),
      draw: (renderer) => {
        renderer.item(agent({ change: 'started', card: card({ depth: 3 }) }));
        renderer.item(agent({ change: 'status', card: card({ depth: 3, status: 'reading' }) }));
        renderer.item(
          agent({
            change: 'ended',
            card: card({ depth: 3, state: 'completed', outcome: 'completed' }),
          }),
        );
      },
    });

    expect(out()).toBe(
      ['    ◆ Helper started', '      ◇ Helper: reading', '    ◆ Helper completed', ''].join('\n'),
    );
  });

  it('ends with the outcome a limit or a stop left, which the node’s state folds together', () => {
    const ended = (cardState: Partial<SubAgentCard>) =>
      drawn({
        look: createChatLook(),
        draw: (renderer) => renderer.item(agent({ change: 'ended', card: card(cardState) })),
      }).out();

    expect(ended({ state: 'failed', outcome: 'max_turns' })).toContain('max_turns');
    expect(ended({ state: 'cancelled', outcome: 'interrupted' })).toContain('interrupted');
    expect(ended({ state: 'failed' })).toContain('failed');
  });

  it('draws the plain log’s card with its ids, escaping the title', () => {
    const { out } = drawn({
      look: logLook,
      draw: (renderer) =>
        renderer.item(agent({ change: 'started', card: card({ title: 'He\u001b[2Jlp' }) })),
    });

    expect(out()).toContain('sub-agent "He\\u001b[2Jlp" [worker] started · depth 2');
    expect(out()).toContain('parent main · main main');
  });
});

describe('Renderer.item: notices', () => {
  const written = (item: ChatItem) => drawn({ look: logLook, draw: (r) => r.item(item) }).out();

  it('draws a storage failure and an extension’s event as their stream events are drawn', () => {
    expect(written({ type: 'storage_failed', error: 'disk full' })).toBe(
      '\n✗ chat could not be saved: disk full\n',
    );
    expect(
      written({
        type: 'extension_event',
        extension: 'acme',
        kind: 'acme.deploy',
        version: 1,
        data: { secret: 'DATA-ONLY-MARKER' },
        text: 'Deploy\nfinished',
      }),
    ).toBe('\n⬡ acme: Deploy finished\n');
  });

  it('leaves to the chat the items only it reads: a run’s start, the queue and a refused line', () => {
    const message = messageIdSchema.parse('00000000-0000-4000-8000-000000000001');
    const items: ChatItem[] = [
      { type: 'run_started', cause: 'prompt', messageId: message, text: 'hi' },
      { type: 'queue_changed', queued: ['a'] },
      { type: 'prompt_started', text: 'a', messageId: message, queued: [] },
      { type: 'prompt_refused', text: 'a', messageId: message, error: 'no', queued: [] },
    ];

    for (const item of items) expect(written(item)).toBe('');
  });
});
