import { describe, expect, it } from 'vitest';
import { summaryMessageSchema } from '../../message/message.validator.js';
import {
  answerApprovalRequestSchema,
  conversationDetailsSchema,
  conversationsResponseSchema,
  messagesResponseSchema,
  yieldPromptResponseSchema,
  sendPromptRequestSchema,
  sendPromptResponseSchema,
  serverErrorSchema,
  skillsResponseSchema,
  startConversationRequestSchema,
  streamQuerySchema,
  switchModelRequestSchema,
  conversationIdSchema,
  queuedPromptsSchema,
} from '../server.validator.js';
import { MAX_QUEUED_CHARS, MAX_QUEUED_LINE_CHARS } from '../server.constants.js';

/** A model's id: a lowercase UUID, the only thing a switch is keyed by. */
const FAST = '4b1f9a52-3c5e-4a77-9d64-0e2b7f1c8a30';
/** A conversation's id: a lowercase UUID too. */
const CONVERSATION = '00000000-0000-4000-8000-0000000000ab';

describe('conversationIdSchema', () => {
  it('takes a lowercase UUID: it names a folder on disk and nothing else may', () => {
    expect(conversationIdSchema.parse(CONVERSATION)).toBe(CONVERSATION);
  });

  it('refuses anything that could name another path, or the same folder twice', () => {
    for (const bad of [
      '',
      'c1',
      'nope',
      '..',
      '../config',
      `${CONVERSATION}/..`,
      CONVERSATION.toUpperCase(),
      `${CONVERSATION} `,
      CONVERSATION.replaceAll('-', ''),
    ]) {
      expect(conversationIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('sendPromptRequestSchema', () => {
  it('takes text from a script, or parts from a UI', () => {
    expect(sendPromptRequestSchema.parse({ text: 'fix it /git' })).toEqual({ text: 'fix it /git' });

    const parts = [
      { type: 'text', text: 'please ' },
      { type: 'skill', name: 'review' },
    ];

    expect(sendPromptRequestSchema.parse({ parts })).toEqual({ parts });
  });

  it('refuses both at once, neither, an empty prompt, or a name no skill can have', () => {
    for (const body of [
      { text: 'a', parts: [{ type: 'text', text: 'a' }] },
      {},
      { text: '' },
      { parts: [] },
      { parts: [{ type: 'skill', name: 'Not A Name' }] },
      { parts: [{ type: 'chip', name: 'review' }] },
    ]) {
      expect(sendPromptRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('the other requests', () => {
  it('starts a conversation empty or from saved messages, with parts kept', () => {
    const messages = [
      { role: 'user', content: 'Run review… then', parts: [{ type: 'skill', name: 'review' }] },
    ];

    expect(startConversationRequestSchema.parse({})).toEqual({});
    expect(startConversationRequestSchema.parse({ messages })).toEqual({ messages });
  });

  it('starts a conversation on a reasoning effort, and refuses one that is not an effort', () => {
    expect(startConversationRequestSchema.parse({ effort: 'high' })).toEqual({ effort: 'high' });
    expect(startConversationRequestSchema.safeParse({ effort: 'max' }).success).toBe(false);
  });

  it('resumes from, and reads back, a history that holds a checkpoint', () => {
    const checkpoint = summaryMessageSchema.parse({
      at: 7,
      summarizer: 'rules',
      summarized: 12,
      kept: 3,
      covered: 1,
      sections: [{ id: 'state', title: 'Task state', body: 'Tests pass.' }],
      role: 'summary',
    });
    const messages = [{ role: 'user', content: 'continue' }, checkpoint];

    expect(startConversationRequestSchema.parse({ messages })).toEqual({ messages });
    expect(messagesResponseSchema.parse({ messages })).toEqual({ messages });
  });

  it('refuses a notice in the history a client starts from, but reads one back', () => {
    const notice = {
      role: 'notice',
      notice: {
        kind: 'task-finished',
        task: {
          id: 't1',
          kind: 'task',
          command: 'ls',
          description: 'list',
          status: 'completed',
          output: '',
          startedAt: 1,
        },
        context: { reason: 'list files', startedAt: 1, durationMs: 3, userMessagesSinceStart: 0 },
      },
      at: 4,
    };

    expect(startConversationRequestSchema.safeParse({ messages: [notice] }).success).toBe(false);
    expect(messagesResponseSchema.safeParse({ messages: [notice] }).success).toBe(true);
  });

  it('filters the stream by session, subtree and replay, each optional', () => {
    expect(streamQuerySchema.parse({})).toEqual({});
    expect(streamQuerySchema.parse({ session: 's1', subtree: true, replay: true })).toEqual({
      session: 's1',
      subtree: true,
      replay: true,
    });
    expect(streamQuerySchema.safeParse({ replay: 'yes' }).success).toBe(false);
  });

  it('answers an approval with a decision the approval registry takes', () => {
    expect(answerApprovalRequestSchema.parse({ response: { decision: 'approve' } })).toEqual({
      response: { decision: 'approve' },
    });
    expect(answerApprovalRequestSchema.safeParse({ response: { decision: 'maybe' } }).success).toBe(
      false,
    );
  });
});

describe('yieldPromptResponseSchema', () => {
  it('requires a boolean acceptance result, including false', () => {
    for (const accepted of [true, false]) {
      expect(yieldPromptResponseSchema.parse({ accepted })).toEqual({ accepted });
    }

    for (const body of [{}, { accepted: 'true' }, { accepted: 1 }, null]) {
      expect(yieldPromptResponseSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('sendPromptResponseSchema', () => {
  it('says whether the prompt started or waits, with the queue after it', () => {
    for (const answer of [
      { status: 'started', queued: [] },
      { status: 'queued', queued: ['first', 'second'] },
    ]) {
      expect(sendPromptResponseSchema.parse(answer)).toEqual(answer);
    }
  });

  it('rejects an answer without the queue, or with a status it does not define', () => {
    for (const body of [{ status: 'started' }, { status: 'running', queued: [] }, {}]) {
      expect(sendPromptResponseSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('the responses', () => {
  const model = { id: FAST, name: 'fast', adapter: 'openai', model: 'gpt-5-mini' };
  const details = {
    id: CONVERSATION,
    title: 'Chat',
    session: 's1',
    running: false,
    startedAt: 1,
    workspace: '/work',
    profile: '9d2c7e10-6a4b-4f38-b1e5-5c0a8d3f2b71',
    model,
    models: [model],
    projectTrust: 'untrusted',
    permissionMode: 'ask',
  };

  it('describes a conversation’s run, with the models it can switch to', () => {
    expect(conversationDetailsSchema.parse(details)).toEqual(details);
    expect(conversationDetailsSchema.safeParse({ ...details, projectTrust: 'maybe' }).success).toBe(
      false,
    );
    expect(
      conversationDetailsSchema.safeParse({ ...details, model: { ...model, id: undefined } })
        .success,
    ).toBe(false);
  });

  describe('ignoredSettings', () => {
    const entry = { layer: 'workspace', name: 'notes.mode', file: '/w/.sheavly/settings.json' };
    const accepts = (ignoredSettings: unknown) =>
      conversationDetailsSchema.safeParse({ ...details, ignoredSettings }).success;

    it('is optional, and carries a named entry or a whole-file problem', () => {
      expect(conversationDetailsSchema.parse(details)).not.toHaveProperty('ignoredSettings');
      expect(accepts([{ ...entry, reason: 'restricted' }])).toBe(true);
    });

    it.each([
      'too-large',
      'not-a-file',
      'link',
      'not-utf8',
      'unreadable',
      'not-json',
      'bad-shape',
      'trust-unavailable',
    ])('takes the whole-file cause %s', (reason) => {
      expect(accepts([{ layer: 'workspace', file: '/w/.sheavly/settings.json', reason }])).toBe(
        true,
      );
    });

    it('no longer takes the old whole-file reason invalid', () => {
      expect(
        accepts([{ layer: 'workspace', file: '/w/.sheavly/settings.json', reason: 'invalid' }]),
      ).toBe(false);
    });

    it('holds at most 20 entries and counts the rest in ignoredSettingsMore', () => {
      const many = (count: number) =>
        Array.from({ length: count }, () => ({ ...entry, reason: 'scope' }));
      const withMore = (ignoredSettingsMore: unknown) =>
        conversationDetailsSchema.safeParse({
          ...details,
          ignoredSettings: many(20),
          ignoredSettingsMore,
        }).success;

      expect(accepts(many(20))).toBe(true);
      expect(accepts(many(21))).toBe(false);
      expect(withMore(980)).toBe(true);
      expect(withMore(0)).toBe(false);
      expect(withMore(1.5)).toBe(false);
      expect(withMore('3')).toBe(false);
    });

    it('takes a path of 8192 characters and refuses a longer one', () => {
      const withFile = (file: string) =>
        accepts([{ layer: 'workspace', file, reason: 'not-json' }]);

      expect(withFile('x'.repeat(8192))).toBe(true);
      expect(withFile('x'.repeat(8193))).toBe(false);
    });

    it('refuses an unknown reason, a value, other text, an empty list or a name that is not one', () => {
      expect(accepts([{ ...entry, reason: 'because' }])).toBe(false);
      expect(accepts([{ ...entry, reason: 'scope', value: 'sk-secret' }])).toBe(false);
      expect(accepts([{ ...entry, reason: 'scope', message: 'text' }])).toBe(false);
      expect(accepts([{ ...entry, layer: 'global', reason: 'scope' }])).toBe(false);
      expect(accepts([{ ...entry, name: 'sk-secret-value', reason: 'scope' }])).toBe(false);
      expect(accepts([])).toBe(false);
    });
  });

  it('switches models by id: a name is a label, and never switches anything', () => {
    expect(switchModelRequestSchema.parse({ id: FAST })).toEqual({ id: FAST });
    expect(switchModelRequestSchema.safeParse({ name: 'fast' }).success).toBe(false);
    expect(switchModelRequestSchema.safeParse({ id: 'fast' }).success).toBe(false);
    expect(switchModelRequestSchema.safeParse({ id: FAST.toUpperCase() }).success).toBe(false);
    expect(switchModelRequestSchema.safeParse({ id: FAST, name: 'fast' }).data).toEqual({
      id: FAST,
    });
  });

  it('lists live conversations with what another UI needs to join one', () => {
    const summary = {
      id: CONVERSATION,
      title: 'Chat',
      session: 's1',
      running: true,
      startedAt: 1,
    };

    expect(conversationsResponseSchema.parse({ conversations: [summary] })).toEqual({
      conversations: [summary],
    });
    expect(
      conversationsResponseSchema.safeParse({ conversations: [{ ...summary, running: 'yes' }] })
        .success,
    ).toBe(false);
  });

  it('lists skills without their bodies', () => {
    const skill = { name: 'review', description: 'Reviews.', manualOnly: false, scope: 'project' };

    expect(skillsResponseSchema.parse({ skills: [skill] })).toEqual({ skills: [skill] });
    expect(
      skillsResponseSchema.safeParse({ skills: [{ ...skill, scope: 'elsewhere' }] }).success,
    ).toBe(false);
  });

  it('gives every failure a known code and a message', () => {
    const failure = { error: { code: 'session_running', message: 'A prompt is running.' } };

    expect(serverErrorSchema.parse(failure)).toEqual(failure);
    expect(serverErrorSchema.safeParse({ error: { code: 'oops', message: 'x' } }).success).toBe(
      false,
    );
  });
});

describe('queuedPromptsSchema', () => {
  const line = 'x'.repeat(MAX_QUEUED_LINE_CHARS);
  const lines = (count: number) => Array.from({ length: count }, () => line);

  it('takes lines up to the total a queue may hold, and refuses one more character', () => {
    const full = lines(MAX_QUEUED_CHARS / MAX_QUEUED_LINE_CHARS);

    expect(queuedPromptsSchema.safeParse({ queued: full }).success).toBe(true);
    expect(queuedPromptsSchema.safeParse({ queued: [...full, 'x'] }).success).toBe(false);
  });
});
