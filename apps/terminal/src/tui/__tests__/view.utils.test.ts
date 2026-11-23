import { describe, expect, it } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import type { ApprovalOption, ApprovalRequest } from '@sheavly/protocol/approval/approval.types';
import { approvalIdSchema } from '@sheavly/protocol/approval/approval.validator';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import { timestampSchema } from '@sheavly/protocol/time/time.validator';
import { createPalette } from '../../theme/palette.utils.js';
import { THEMES } from '../../theme/theme.constants.js';
import { ApprovalPrompt } from '../approval-prompt.service.js';
import type { StatusInfo } from '../tui.types.js';
import { approvalText, queueText, runningToolsText, statusText } from '../view.utils.js';

const plain = (text: string) => stripVTControlCharacters(text);
const statusOf = (info: StatusInfo) => statusText({ info });

const request = (id: string, options?: ApprovalOption[]): ApprovalRequest => ({
  id: approvalIdSchema.parse(id),
  callId: callIdSchema.parse('c1'),
  tool: 'run_command',
  command: 'git push origin main',
  concerns: [
    { argument: 'git push origin main', reason: 'is not allowed yet' },
    { argument: '../other', reason: 'reaches outside the workspace' },
  ],
  options: options ?? ['approve', 'always_allow', 'skip', 'skip_with_message'],
});

describe('approvalText', () => {
  it('escapes untrusted commands, concerns and grant hints without modifying the request', () => {
    const prompt = new ApprovalPrompt();
    const command = 'printf "a\r\u001b[2J\u001b]52;c;data\u0007"';
    const original = {
      ...request('unsafe'),
      command,
      concerns: [{ argument: '\u009b2J', reason: 'do not hide\n\u202ethis' }],
      keeps: ['\u001b[2J *'],
    };

    prompt.ask(original);
    const text = plain(approvalText({ prompt }));

    expect(text).toContain('\\u001b[2J');
    expect(text).toContain('\\u0007');
    expect(text).toContain('\\u009b2J');
    expect(text).toContain('do not hide\\n\\u202ethis');

    for (const control of ['\u001b', '\u0007', '\u009b', '\u202e']) {
      expect(text).not.toContain(control);
    }

    expect(prompt.current).toBe(original);
    expect(prompt.current?.command).toBe(command);
    prompt.pickNumber(4);
    prompt.confirm();
    expect(plain(approvalText({ prompt }))).toContain('Skip printf "a\\r\\u001b[2J');
  });

  it('names the sub-agent that asks, and never shows its session id', () => {
    const prompt = new ApprovalPrompt();
    const agent = {
      id: sessionIdSchema.parse('secret-session-id'),
      parentId: sessionIdSchema.parse('main'),
      startedByCall: callIdSchema.parse('c0'),
      rootId: sessionIdSchema.parse('main'),
      depth: 2,
      title: 'Update ESLint rules',
      state: 'running' as const,
      startedAt: timestampSchema.parse(1),
    };

    prompt.ask(request('a1'), agent);
    const text = plain(approvalText({ prompt }));

    expect(text).toContain('Update ESLint rules (sub-agent) wants to run git push origin main?');
    expect(text).not.toContain('secret-session-id');

    prompt.forget(approvalIdSchema.parse('a1'));
    prompt.ask(request('a2'));
    expect(prompt.currentAgent).toBeUndefined();
    expect(plain(approvalText({ prompt }))).toContain('Run git push origin main?');
  });

  it('escapes control and bidi characters in a sub-agent title, in both phases', () => {
    const prompt = new ApprovalPrompt();
    const agent = {
      id: sessionIdSchema.parse('s'),
      parentId: sessionIdSchema.parse('main'),
      startedByCall: callIdSchema.parse('c0'),
      rootId: sessionIdSchema.parse('main'),
      depth: 2,
      title: 'evil\u001b[2J\u001b]52;c;x\u0007\u202etitle',
      state: 'running' as const,
      startedAt: timestampSchema.parse(1),
    };

    prompt.ask(request('a1'), agent);

    const question = approvalText({ prompt });

    prompt.pickNumber(4);
    prompt.confirm();
    const skipping = approvalText({ prompt });

    for (const text of [question, skipping]) {
      // The prompt's own styling uses ESC, so look for what the title injected, not any ESC.
      for (const injected of ['\u001b[2J', '\u001b]52', '\u0007', '\u202e']) {
        expect(text).not.toContain(injected);
      }

      expect(plain(text)).toContain('evil\\u001b[2J');
    }

    expect(plain(skipping)).toContain('Skip git push origin main (evil');
  });

  it('is empty when nothing waits', () => {
    expect(approvalText({ prompt: new ApprovalPrompt() })).toBe('');
  });

  it('shows the command, why it is asked, every option numbered, and the keys', () => {
    const prompt = new ApprovalPrompt();

    prompt.ask(request('a1'));
    const text = plain(approvalText({ prompt }));

    expect(text).toContain('Run git push origin main?');
    expect(text).toContain('git push origin main: is not allowed yet');
    expect(text).toContain('../other: reaches outside the workspace');
    expect(text).toContain('1. Run it once');
    expect(text).toContain('2. Always allow');
    expect(text).toContain('3. Skip');
    expect(text).toContain('4. Skip, and say what to do instead');
    expect(text).toContain('↑↓ or 1-4 to choose · Enter to confirm · Esc to skip');
  });

  it('marks no choice until one is picked, then marks that one', () => {
    const prompt = new ApprovalPrompt();

    prompt.ask(request('a1'));
    expect(plain(approvalText({ prompt }))).not.toContain('→');

    prompt.move(1);
    prompt.move(1);

    const marked = plain(approvalText({ prompt }))
      .split('\n')
      .filter((line) => line.includes('→'));

    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('2. Always allow');
  });

  it('shows every effective base-command grant beside always allow before a choice is made', () => {
    const prompt = new ApprovalPrompt();

    prompt.ask({
      ...request('a1'),
      keeps: ['touch /workspace/file', 'git push *', 'npm run test *', 'ls -la src'],
    });

    const text = plain(approvalText({ prompt }));

    expect(text).toContain(
      '2. Always allow  keeps `touch *`, `git push *`, `npm run test *`, `ls *` allowed in this folder, for every agent',
    );
    expect(prompt.confirm()).toEqual({ kind: 'none' });
  });

  it('lists only the options a request offers, and numbers them 1 to N', () => {
    const prompt = new ApprovalPrompt();

    prompt.ask(request('a1', ['approve', 'skip']));
    const text = plain(approvalText({ prompt }));

    expect(text).not.toContain('Always allow');
    expect(text).toContain('2. Skip');
    expect(text).toContain('1-2 to choose');
  });

  it('says how many more wait behind the one shown', () => {
    const prompt = new ApprovalPrompt();

    prompt.ask(request('a1'));
    prompt.ask(request('a2'));
    prompt.ask(request('a3'));

    expect(plain(approvalText({ prompt }))).toContain('+2 more waiting');
  });

  it('asks for the message while one is being typed', () => {
    const prompt = new ApprovalPrompt();

    prompt.ask(request('a1'));
    prompt.pickNumber(4);
    prompt.confirm();
    const text = plain(approvalText({ prompt }));

    expect(text).toContain('Skip git push origin main');
    expect(text).toContain('Type what it should do instead');
    expect(text).not.toContain('1. Run it once');
  });
});

describe('queueText', () => {
  it('is empty when nothing waits', () => {
    expect(queueText({ queue: [] })).toBe('');
  });

  it('counts the lines waiting and shows each, cutting a long one', () => {
    const long = 'x'.repeat(60);
    const text = plain(queueText({ queue: ['one', long] }));

    expect(text).toContain('2 queued');
    expect(text).toContain('"one"');
    expect(text).toContain(`"${'x'.repeat(39)}…"`);
    expect(text).not.toContain('x'.repeat(41));
  });
});

describe('runningToolsText', () => {
  const tool = (description: string, startedAt: number) => ({
    id: callIdSchema.parse(description),
    description,
    startedAt,
  });

  it('says nothing when no tool runs', () => {
    expect(runningToolsText({ tools: [], at: 5000 })).toBeUndefined();
  });

  it('names the one step and how many whole seconds it has run', () => {
    const tools = [tool('Run the tests', 1000)];

    expect(runningToolsText({ tools, at: 1000 })).toBe('⏺ Run the tests 0s');
    expect(runningToolsText({ tools, at: 13_999 })).toBe('⏺ Run the tests 12s');
  });

  it('counts several steps and times the oldest', () => {
    const tools = [tool('Build', 2000), tool('Lint', 9000)];

    expect(runningToolsText({ tools, at: 14_000 })).toBe('⏺ 2 tools 12s');
  });

  it('cuts a long description to one line, without escape codes, and never shows a negative time', () => {
    const long = `\u001b[31mRun\u001b[0m\n${'x'.repeat(80)}`;
    const text = runningToolsText({ tools: [tool(long, 5000)], at: 1000 });

    expect(text).toBe(`⏺ Run ${'x'.repeat(36)}… 0s`);
  });
});

describe('statusText', () => {
  it.each([
    ['ready', '● ready'],
    ['working', '● working'],
    ['waiting', '● waiting for you'],
  ] as const)('says %s', (state, shown) => {
    expect(plain(statusOf({ state, model: 'Fast', mode: 'ask', tasks: 0 }))).toContain(shown);
  });

  it('says thinking... only while working; approvals and idle keep their words', () => {
    const base = { model: 'Fast', mode: 'ask', tasks: 0, thinking: true } as const;

    expect(plain(statusOf({ ...base, state: 'working' }))).toContain('● thinking...');
    expect(plain(statusOf({ ...base, state: 'waiting' }))).toContain('● waiting for you');
    expect(plain(statusOf({ ...base, state: 'ready' }))).toContain('● ready');
    expect(plain(statusOf({ ...base, thinking: false, state: 'working' }))).toContain('● working');
  });

  it('says how many grouped tasks a held run waits on, apart from waiting for you', () => {
    const base = { state: 'awaiting_tasks', model: 'Fast', mode: 'ask', tasks: 0 } as const;

    expect(plain(statusOf({ ...base, awaitedTasks: 2 }))).toContain('● waiting on 2 tasks ·');
    expect(plain(statusOf({ ...base, awaitedTasks: 1 }))).toContain('● waiting on 1 task ·');
    expect(plain(statusOf({ ...base, awaitedTasks: 1 }))).not.toContain('waiting for you');
  });

  it('says follow-ups are queued behind a held run only while the backend’s queue holds one', () => {
    const base = { state: 'awaiting_tasks', model: 'Fast', mode: 'ask', tasks: 0 } as const;

    expect(plain(statusOf({ ...base, awaitedTasks: 2 }))).not.toContain('follow-ups');
    expect(plain(statusOf({ ...base, awaitedTasks: 2, queued: 0 }))).not.toContain('follow-ups');
    expect(plain(statusOf({ ...base, awaitedTasks: 2, queued: 1 }))).toContain(
      '● waiting on 2 tasks · follow-ups are queued',
    );
  });

  it('names the model and the permission mode', () => {
    expect(plain(statusOf({ state: 'ready', model: 'Deep', mode: 'always_ask', tasks: 0 }))).toBe(
      '● ready · Deep · mode: always_ask · context ?',
    );
  });

  it('shows the working branch once, and nothing when there is none', () => {
    const base = { state: 'ready', model: 'Deep', mode: 'ask', tasks: 0 } as const;

    expect(plain(statusOf({ ...base, workingBranch: '238-agent-working-root' }))).toBe(
      '● ready · Deep · ⎇ 238-agent-working-root · mode: ask · context ?',
    );
    expect(plain(statusOf(base))).not.toContain('⎇');
  });

  it('counts background tasks only when some run', () => {
    expect(plain(statusOf({ state: 'ready', model: 'Fast', mode: 'ask', tasks: 2 }))).toContain(
      '2 tasks running in background',
    );
    expect(plain(statusOf({ state: 'ready', model: 'Fast', mode: 'ask', tasks: 0 }))).not.toContain(
      'background',
    );
  });

  it('says what runs in the background: tasks, agents and services, each only when some run', () => {
    const base = { state: 'ready', model: 'Fast', mode: 'ask' } as const;

    expect(plain(statusOf({ ...base, tasks: 2, agents: 1, services: 1 }))).toContain(
      '2 tasks, 1 agent and 1 service running in background',
    );
    expect(plain(statusOf({ ...base, tasks: 0, agents: 3, services: 0 }))).toContain(
      '3 agents running in background',
    );
    expect(plain(statusOf({ ...base, tasks: 1, services: 2 }))).toContain(
      '1 task and 2 services running in background',
    );
    expect(plain(statusOf({ ...base, tasks: 0, services: 1 }))).toContain(
      '1 service running in background',
    );
    expect(plain(statusOf({ ...base, tasks: 0, services: 1 }))).not.toContain('task');
    expect(plain(statusOf({ ...base, tasks: 0, services: 0 }))).not.toContain('background');
  });

  it('shows allow all in a colour of its own, since it asks about nothing', () => {
    const text = statusOf({ state: 'ready', model: 'Fast', mode: 'allow_all', tasks: 0 });

    expect(plain(text)).toContain('mode: allow all');
    expect(text).not.toBe(plain(text));
    expect(text).toContain('\u001b[31m');
  });

  it('takes its colours from the palette it is given', () => {
    const palette = createPalette(THEMES.colorblind);
    const info: StatusInfo = { state: 'ready', model: 'Fast', mode: 'allow_all', tasks: 0 };
    const text = statusText({ info, palette });

    // The error colour of this theme is yellow, and its success colour a bright blue.
    expect(text).toContain('\u001b[33mallow all');
    expect(text).toContain('\u001b[94m● ready');
    expect(text).not.toContain('\u001b[31m');
    expect(text).not.toContain('\u001b[32m');
  });
});
