import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { now } from '@sheavly/core/clock/clock.helper';
import { describe, expect, it, vi } from 'vitest';
import { fakeTerminal } from '../../testing/terminal.fake.js';
import { createPalette } from '../../theme/palette.utils.js';
import { THEMES } from '../../theme/theme.constants.js';
import { ChatScreen } from '../../tui/chat-screen.service.js';
import type { StatusInfo } from '../../tui/tui.types.js';
import { statusText } from '../../tui/view.utils.js';
import { approvalIdSchema } from '@sheavly/protocol/approval/approval.validator';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { ReactScreen } from '../react-screen.component.js';
import { ReactView } from '../react-view.service.js';
import { usageFigures } from '@sheavly/client/testing/frames.fake';

function open(rows = 24, interactive = false, columns = 80, reducedMotion = false) {
  const terminal = fakeTerminal(columns, rows);
  const stdout = Object.assign(new PassThrough(), { isTTY: interactive, columns, rows });
  const view = new ReactView({
    terminal,
    stdout,
    status: { state: 'ready', model: 'Fast', mode: 'ask', tasks: 0 },
    commands: ChatScreen.commands,
    cwd: process.cwd(),
    reducedMotion,
  });

  return { view, terminal, stdout };
}

/** A chat screen over `view`, whose answers go to `onAnswer`; the rest of what it calls does nothing. */
function screenOver(params: { view: ReactView; onAnswer?: () => void }): ChatScreen {
  return new ChatScreen({
    view: params.view,
    status: { state: 'ready', model: 'Fast', mode: 'ask', tasks: 0 },
    commands: ChatScreen.commands,
    cwd: process.cwd(),
    onSubmit: vi.fn(),
    onStop: () => 'idle',
    onAnswer: params.onAnswer ?? vi.fn(),
    onQuit: vi.fn(),
    onExpand: () => '',
  });
}

describe('ReactView', () => {
  it('draws the unfinished reply above the status line, never under it', () => {
    const { view } = open();

    view.setLive('streaming words');

    const drawn = stripVTControlCharacters(
      renderToString(createElement(ReactScreen, view.snapshot)),
    );
    const rows = drawn.split('\n');
    const reply = rows.findIndex((row) => row.includes('streaming words'));
    const status = rows.findIndex((row) => row.includes('ready'));

    expect(reply).toBeGreaterThanOrEqual(0);
    expect(reply).toBeLessThan(status);
  });

  it('starts once: a second start leaves the running instance, not a leaked one', () => {
    const { view, terminal } = open();
    const started = vi.spyOn(terminal, 'start');

    view.start();
    view.start();
    view.stop();

    expect(started).toHaveBeenCalledTimes(1);
    expect(terminal.stopped).toBe(true);
  });

  it.each([false, true])('uses output TTY status in CI: %s', async (interactive) => {
    vi.stubEnv('CI', 'true');

    const { view, stdout } = open(24, interactive);
    let output = '';

    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => (output += chunk));

    try {
      view.start();
      await vi.waitFor(() => expect(view.snapshot.editor.cursor).toBeDefined());

      if (interactive) {
        await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('ready'));
        expect(output).toContain('\u001b[?25h');

        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(output).toBe('');
      view.stop();
      expect(stripVTControlCharacters(output)).toContain('ready');
      expect(output).not.toContain('\u001b[?25h');
      expect(output).not.toContain('\u001b[2K');
    } finally {
      view.stop();
      vi.unstubAllEnvs();
    }
  });

  it.each([40, 120])(
    'draws context usage while preserving the stop hint at %s columns',
    async (columns) => {
      const { view, stdout } = open(24, true, columns, true);
      let output = '';

      stdout.setEncoding('utf8');
      stdout.on('data', (chunk: string) => (output += chunk));
      view.setStatus({
        state: 'working',
        model: 'Fast',
        mode: 'ask',
        tasks: 0,
        usage: { ...usageFigures(0), calls: 1, inputTokens: 12300, outputTokens: 456 },
        context: { used: 12756, window: 300000 },
      });
      view.start();

      try {
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(stripVTControlCharacters(output)).toContain('Ctrl+C to stop');
        expect(view.snapshot.status.usage?.inputTokens).toBe(12300);
        expect(view.snapshot.status.context?.used).toBe(12756);

        if (columns === 120) {
          expect(stripVTControlCharacters(output)).toContain('context 12.8k / 300K (4%)');
          expect(stripVTControlCharacters(output)).not.toContain('12.3k in');
        }
      } finally {
        view.stop();
      }
    },
  );
  it('keeps committed history unchanged while only the live tail changes', () => {
    const { view } = open();

    view.print('one');

    const line = view.snapshot.history[0];

    view.setLive('two');
    view.setLive('two three');

    expect(view.snapshot.history).toEqual([{ id: 0, text: 'one' }]);
    expect(view.snapshot.history[0]).toBe(line);
    expect(view.snapshot.live).toBe('two three');
  });

  it('publishes a new history array on append without mutating a previous frame', () => {
    const { view } = open();
    const previous = view.snapshot.history;

    view.print('next');

    expect(previous).toEqual([]);
    expect(view.snapshot.history).toEqual([{ id: 0, text: 'next' }]);
  });

  it('writes appended static lines exactly once through a mounted Ink renderer', async () => {
    const { view, stdout } = open(24, true);
    const chunks: string[] = [];

    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => chunks.push(chunk));
    view.start();

    try {
      for (const line of ['FIRST_COMMIT', 'SECOND_COMMIT', 'THIRD_COMMIT']) {
        view.print(line);
        view.requestRender();
        await new Promise((resolve) => setTimeout(resolve, 60));
      }

      view.setLive('live tail');
      view.requestRender();
      await new Promise((resolve) => setTimeout(resolve, 60));

      const output = chunks.join('');

      for (const line of ['FIRST_COMMIT', 'SECOND_COMMIT', 'THIRD_COMMIT']) {
        expect(output.split(line).length - 1).toBe(1);
      }

      expect(output).not.toContain('\u001b[3J');
      expect(output).not.toContain('\u001b[?1049h');
    } finally {
      view.stop();
    }
  });

  it.each([
    { text: 'hello', columns: 80, caret: 5 },
    { text: '界🙂', columns: 80, caret: 4 },
    { text: 'hello', columns: 4, caret: 2 },
  ])(
    'commits the caret with the typed text at $columns columns',
    async ({ text, columns, caret }) => {
      const { view, terminal, stdout } = open(24, true, columns);
      let output = '';

      stdout.setEncoding('utf8');
      stdout.on('data', (chunk: string) => (output += chunk));
      view.start();

      async function typeAndCheckCaret(data: string): Promise<void> {
        terminal.type(data);
        await new Promise((resolve) => setTimeout(resolve, 60));

        const columnMove = output.split('\u001b[?25h').at(-2)?.split('\u001b[').at(-1);

        expect(columnMove).toMatch(/^\d+G$/);
        expect(Number(columnMove?.slice(0, -1)) - 1).toBe(view.snapshot.editor.cursor?.x);
      }

      try {
        await new Promise((resolve) => setTimeout(resolve, 60));

        for (const character of text) {
          await typeAndCheckCaret(character);
        }

        expect(view.snapshot.editor.cursor?.x).toBe(caret);
        await typeAndCheckCaret('\u001b[D');
        await typeAndCheckCaret('\u007f');
      } finally {
        view.stop();
      }
    },
  );

  /** Mounts a view whose status says `state` with one tool begun `ago` ms ago; reads what it drew. */
  function showingTool(params: {
    state: 'working' | 'waiting';
    ago: number;
    reducedMotion?: boolean;
  }) {
    const { view, stdout } = open(24, true, 80, params.reducedMotion);
    let output = '';

    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => (output += chunk));
    view.setStatus({
      state: params.state,
      model: 'Fast',
      mode: 'ask',
      tasks: 0,
      tools: [
        {
          id: callIdSchema.parse('1'),
          description: 'Run the tests',
          startedAt: now() - params.ago,
        },
      ],
    });
    view.start();

    return { view, drawn: () => stripVTControlCharacters(output) };
  }

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('keeps a static working marker with reduced motion while elapsed times still advance', async () => {
    const { view, drawn } = showingTool({ state: 'working', ago: 5000, reducedMotion: true });

    try {
      await pause(150);
      expect(view.snapshot.reducedMotion).toBe(true);
      expect(drawn()).toContain('● working · 0s · Ctrl+C to stop · ⏺ Run the tests 5s');
      await pause(1100);
      // Incremental rendering writes only the changed suffix, keeping the static marker in place.
      expect(drawn()).toContain('1s · Ctrl+C to stop · ⏺ Run the tests 6s');
      expect(drawn()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠧⠇⠏]/u);
      view.setStatus({ state: 'waiting', model: 'Fast', mode: 'ask', tasks: 0 });
      view.requestRender();
      await pause(100);
      expect(view.snapshot.status.state).toBe('waiting');
      expect(drawn()).toContain('for you · Fast');
    } finally {
      view.stop();
    }
  });

  it('shows the running step with its time in the working indicator, and keeps counting', async () => {
    // 5.5 s ago: the shown second is 5 for half a second, then 6.
    const { view, drawn } = showingTool({ state: 'working', ago: 5500 });

    try {
      await pause(150);
      expect(drawn()).toContain('Ctrl+C to stop · ⏺ Run the tests 5s');
      await pause(700);
      expect(drawn()).toContain('Ctrl+C to stop · ⏺ Run the tests 6s');
    } finally {
      view.stop();
    }
  });

  it('draws the tools a ChatScreen is told about, and drops them when they return', async () => {
    const { view, stdout } = open(24, true);
    const screen = screenOver({ view });
    let output = '';

    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => (output += chunk));
    screen.start();

    try {
      screen.setStatus({
        state: 'working',
        tools: [{ id: callIdSchema.parse('1'), description: 'Run the tests', startedAt: now() }],
      });
      await pause(150);
      expect(stripVTControlCharacters(output)).toContain('⏺ Run the tests 0s');

      output = '';
      screen.setStatus({ tools: [] });
      await pause(250);
      expect(stripVTControlCharacters(output)).toContain('working');
      expect(output).not.toContain('Run the tests');
    } finally {
      screen.stop();
    }
  });

  it('hands the footer the colours of its palette, the default theme’s when it has none', () => {
    const { view: standard } = open();
    const themed = new ReactView({
      terminal: fakeTerminal(),
      stdout: new PassThrough(),
      status: { state: 'ready', model: 'Fast', mode: 'ask', tasks: 0 },
      commands: ChatScreen.commands,
      cwd: process.cwd(),
      palette: createPalette(THEMES.colorblind),
    });

    expect(standard.snapshot.colors).toEqual(THEMES.default);
    expect(themed.snapshot.colors).toEqual(THEMES.colorblind);
    expect(themed.palette.paint.status.error('x')).toBe('\u001b[33mx\u001b[39m');
  });

  it('shows no step when the prompt is not working, whatever it was told about', async () => {
    const { view, drawn } = showingTool({ state: 'waiting', ago: 0 });

    try {
      await pause(150);
      expect(drawn()).toContain('waiting for you');
      expect(drawn()).not.toContain('Run the tests');
    } finally {
      view.stop();
    }
  });

  /** A started view showing `status`, and what it has drawn so far without styling. */
  function showingStatus(status: StatusInfo) {
    const { view, stdout } = open(24, true, 120, true);
    let output = '';

    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => (output += chunk));
    view.setStatus(status);
    view.start();

    return { view, drawn: () => stripVTControlCharacters(output) };
  }

  it('shows the count of grouped tasks a held run waits on, with no stop hint', async () => {
    const { view, drawn } = showingStatus({
      state: 'awaiting_tasks',
      awaitedTasks: 2,
      model: 'Fast',
      mode: 'ask',
      tasks: 2,
    });

    try {
      await vi.waitFor(() => expect(drawn()).toContain('waiting on 2 tasks'));
      expect(drawn()).not.toContain('Ctrl+C to stop');
    } finally {
      view.stop();
    }
  });

  it('says what runs in the background, services included', async () => {
    const base = { state: 'ready', model: 'Fast', mode: 'ask' } as const;
    const { view, drawn } = showingStatus({ ...base, tasks: 0, services: 1 });

    try {
      await vi.waitFor(() => expect(drawn()).toContain('1 service running in background'));
      view.setStatus({ ...base, tasks: 2, services: 1 });
      await vi.waitFor(() =>
        expect(drawn()).toContain('2 tasks and 1 service running in background'),
      );
    } finally {
      view.stop();
    }
  });

  it.each([
    { tasks: 1, agents: 0, services: 0, said: '1 task running in background' },
    { tasks: 0, agents: 2, services: 0, said: '2 agents running in background' },
    { tasks: 2, agents: 1, services: 1, said: '2 tasks, 1 agent and 1 service running' },
  ])(
    'says the same about background work as the classic status line: $said',
    async ({ said, ...counts }) => {
      const info: StatusInfo = { state: 'ready', model: 'Fast', mode: 'ask', ...counts };
      const classic = stripVTControlCharacters(statusText({ info }));
      const { view, drawn } = showingStatus(info);

      try {
        await vi.waitFor(() => expect(drawn()).toContain(said));
        expect(classic).toContain(said);
      } finally {
        view.stop();
      }
    },
  );

  it('removes ANSI styling when NO_COLOR is set, including an empty value', () => {
    vi.stubEnv('NO_COLOR', '');

    try {
      const { view } = open();

      view.print('\u001b[31merror\u001b[0m');
      view.setLive('\u001b[32mlive\u001b[0m');
      expect(view.snapshot.history[0]?.text).toBe('error');
      expect(view.snapshot.live).toBe('live');
      expect(view.snapshot.editor.lines.join('')).not.toContain('\u001b');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not approve a clipped preview, but still allows Escape to skip', () => {
    const { view, terminal } = open(8);
    const onAnswer = vi.fn();
    const screen = screenOver({ view, onAnswer });

    screen.start();

    try {
      screen.ask({
        id: approvalIdSchema.parse('a1'),
        callId: callIdSchema.parse('c1'),
        tool: 'run_command',
        command: 'npm test',
        concerns: Array.from({ length: 20 }, () => ({ argument: 'test', reason: 'not allowed' })),
        options: ['approve', 'skip'],
      });
      terminal.type('1');
      terminal.type('\r');
      expect(onAnswer).not.toHaveBeenCalled();
      terminal.type('\u001b');
      expect(onAnswer).toHaveBeenCalledWith({ id: 'a1', response: { decision: 'skip' } });
    } finally {
      screen.stop();
    }
  });
});
