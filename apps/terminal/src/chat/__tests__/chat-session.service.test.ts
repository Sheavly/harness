import { describe, expect, it } from 'vitest';
import type { EntryEvent } from '@sheavly/protocol/event/event.types';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { Renderer } from '../../render/render.service.js';
import { createPalette } from '../../theme/palette.utils.js';
import { THEMES } from '../../theme/theme.constants.js';
import { ChatSession } from '../chat-session.service.js';
import {
  DEEP,
  FAST,
  MAIN_SESSION as MAIN,
  fakeChatConversation,
  recordingChat,
  settle,
} from '../testing/chat-session.fake.js';

describe('ChatSession: file changes', () => {
  const keepTwo = (renderer: Renderer) => {
    renderer.changes.keep({ kind: 'file_change', path: 'a.ts', before: 'a\n', after: 'b\n' });
    renderer.changes.keep({ kind: 'file_change', path: 'c.ts', before: null, after: 'x\n' });
  };

  it('answers /changes without sending it, and lists the files changed', async () => {
    const { session, renderer, fake, output } = recordingChat();

    keepTwo(renderer);
    session.submit('/changes');
    await session.idle();

    expect(fake.submitted).toEqual([]);
    expect(output()).toContain('2 files, 2 edits');
  });

  it('shows the diff /changes names, a file’s with spaces in its path included', async () => {
    const { session, renderer, output } = recordingChat();

    renderer.changes.keep({
      kind: 'file_change',
      path: 'my docs/a.md',
      before: null,
      after: 'x\n',
    });
    session.submit('/changes my docs/a.md');
    await session.idle();

    expect(output()).toContain('my docs/a.md');
    expect(output()).toContain('+ x');
  });

  it('draws what /changes and /errors print in the palette it was given', () => {
    const renderer = new Renderer(() => undefined);
    const session = new ChatSession({
      conversation: fakeChatConversation().conversation,
      renderer,
      mainSession: MAIN,
      write: () => undefined,
      onExit: () => undefined,
      palette: createPalette(THEMES.colorblind),
    });

    keepTwo(renderer);
    renderer.failures.keep({ title: 'Run the tests', content: 'FAIL a\n  got 2' });

    // The first change adds a line and removes one: blue for added, yellow for removed.
    expect(session.describeChanges('1')).toContain('\u001b[94m+1');
    expect(session.describeChanges('1')).toContain('\u001b[33m−1');
    expect(session.describeFailures()).toContain('\u001b[33mFAIL a');
  });

  it('describes the latest change, or says there is none', () => {
    const { session, renderer } = recordingChat();

    expect(session.describeLatest()).toBe('No file changes in this chat yet.');

    keepTwo(renderer);
    expect(session.describeLatest()).toContain('c.ts');
    expect(session.describeLatest()).not.toContain('a.ts');
  });
});

describe('ChatSession: failures', () => {
  it('answers /errors without sending it: the list, then one failure in full', async () => {
    const { session, renderer, fake, output } = recordingChat();

    renderer.failures.keep({ title: 'Run the tests', content: 'FAIL a.test.ts\n  got 2' });
    session.submit('/errors');
    session.submit('/errors #1');
    await session.idle();

    expect(fake.submitted).toEqual([]);
    expect(output()).toContain('Failed steps in this chat');
    expect(output()).toContain('  got 2');
  });

  it('says so when no failure was kept', async () => {
    const { session, output } = recordingChat();

    session.submit('/errors');
    await session.idle();

    expect(output()).toContain('No failed steps with more to say');
  });

  it('expands whichever collapsed line came last', () => {
    const { session, renderer } = recordingChat();
    const callId = callIdSchema.parse('1');
    const step = { seq: 0, call: { id: callId, name: 'tool', input: {} }, durationMs: 1 };
    const failed: EntryEvent = {
      ...step,
      type: 'tool_result',
      description: 'failing step',
      message: { role: 'tool', toolCallId: callId, content: 'one\ntwo', isError: true },
    };
    const created: EntryEvent = {
      ...step,
      type: 'tool_result',
      description: 'creating step',
      message: { role: 'tool', toolCallId: callId, content: 'Created c.ts', isError: false },
      artifacts: [{ kind: 'file_change', path: 'c.ts', before: null, after: 'x\n' }],
    };

    renderer.event(failed);
    expect(session.describeLatest()).toContain('two');

    renderer.event(created);
    expect(session.describeLatest()).toContain('c.ts');
    expect(session.describeLatest()).not.toContain('two');
  });
});

describe('ChatSession: commands', () => {
  it('prints help, lists the models and switches by name or id', async () => {
    const { session, fake, output } = recordingChat();

    session.submit('/help');
    session.submit('/model');
    session.submit('/model Deep');
    await session.idle();

    expect(output()).toContain('Type a message and press Enter');
    expect(output()).toContain('● Fast');
    expect(output()).toContain('→ Deep: openai / gpt-deep');
    expect(fake.model()).toBe(DEEP);

    session.submit(`/model ${FAST}`);
    await session.idle();
    expect(fake.model()).toBe(FAST);
  });

  it('refuses a model it has not got, without switching', async () => {
    const { session, fake, output } = recordingChat();

    session.submit('/model Nope');
    await session.idle();

    expect(output()).toContain('Unknown model Nope');
    expect(fake.model()).toBe(FAST);
  });

  it('runs commands one after another in the order typed, so each sees the one before', async () => {
    const { session, fake, output } = recordingChat();

    for (const line of [
      '/effort high',
      '/model Deep',
      '/effort low',
      '/model Fast',
      '/effort',
      '/effort turbo',
    ]) {
      session.submit(line);
    }

    await session.idle();
    expect((await fake.conversation.details()).model.effort).toBe('high');
    expect(output()).toContain('→ Fast · high');
    expect(output()).toContain('→ Deep · low');
    expect(output()).toContain('Choose an effort: low, medium, high, extreme.');
    expect(fake.submitted).toEqual([]);
  });

  it('reports a command no skill has, instead of sending it, and starts no turn', async () => {
    const fake = fakeChatConversation({ skills: ['review'] });
    const { session, told, output } = recordingChat({ fake });

    session.submit('/nope do this');
    await session.idle();

    expect(output()).toContain('Unknown command /nope');
    expect(fake.submitted).toEqual([]);
    expect(told).toEqual([]);
  });

  it('sends a message that mentions a skill that exists', async () => {
    const fake = fakeChatConversation({ skills: ['review'] });
    const { session } = recordingChat({ fake });

    session.submit('please /review this');
    // Not `idle`: the backend started it, and owes its run.
    await settle();

    expect(fake.submitted).toEqual(['please /review this']);
  });

  it('leaves on /exit: tells the UI once, drops the backend’s queue, and handles nothing after', async () => {
    const { session, fake, told } = recordingChat();

    session.submit('/exit');
    session.submit('never sent');
    await session.idle();
    session.submit('also never sent');
    await session.idle();

    expect(told).toEqual(['exit']);
    expect(fake.submitted).toEqual([]);
    expect(fake.queuesSet).toEqual([[]]);
  });

  it('ignores an empty line', async () => {
    const { session, fake, output } = recordingChat();

    session.submit('   ');
    await session.idle();

    expect(fake.submitted).toEqual([]);
    expect(output()).toBe('');
  });
});
