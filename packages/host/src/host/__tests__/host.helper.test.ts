import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineHook } from '@sheavly/core/hook/hook.utils';
import type { ProviderRequest } from '@sheavly/core/provider/provider.types';
import { defineTool } from '@sheavly/core/tool/tool.utils';
import { runAgent } from '@sheavly/loop/stream-agent/stream-agent.helper';
import { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import { approveEverything } from '@sheavly/runtime/testing/approvals.fake';
import { createTaskTools } from '@sheavly/tools/tasks/tasks.tool';
import {
  calls,
  routedProvider,
  say,
  toolCall,
} from '@sheavly/testing/provider/routed-provider.fake';
import { createHarness } from '../host.helper.js';

const extract = defineTool({
  name: 'extract',
  description: 'Pull the amount out of an invoice line',
  inputSchema: z.object({ line: z.string() }),
  execute: async ({ input: { line } }) => line.replace(/[^\d.]/g, ''),
});

/** The model calls the custom tool once, then answers. */
const provider = () =>
  routedProvider({
    'parse it': [
      calls(toolCall({ id: 'c1', name: 'extract', input: { line: 'Total: $42.50' } })),
      say('42.50'),
    ],
  });

// A run with no workspace must not look at the directory it runs in: this one has an AGENTS.md
// and `.sheavly/` hooks a coding UI could load.
let project: string;
let cwd: string;

beforeEach(async () => {
  cwd = process.cwd();
  project = await mkdtemp(path.join(tmpdir(), 'generic-harness-'));
  await writeFile(path.join(project, 'AGENTS.md'), 'AGENTS NOTE\n');
  await mkdir(path.join(project, '.sheavly'));
  await writeFile(path.join(project, '.sheavly', 'hooks.json'), '{ not json');
  process.chdir(project);
});

afterEach(async () => {
  process.chdir(cwd);
  await rm(project, { recursive: true, force: true });
});

describe('createHarness', () => {
  it('includes no tools or hooks: the UI composes them on its services', () => {
    const harness = createHarness({ provider: provider(), title: 'parse it' });

    expect(Object.keys(harness).sort()).toEqual([
      'approvals',
      'instructions',
      'mainSession',
      'nodes',
      'provider',
      'sessions',
      'systemPrompt',
      'tasks',
    ]);
  });

  it('shares one node registry between its sessions and its tasks, and carries it as nodes', async () => {
    const harness = createHarness({ provider: provider(), title: 'parse it' });
    const task = harness.tasks.start({
      command: 'cmd',
      description: 'work',
      sessionId: harness.mainSession.id,
      run: () => Promise.resolve({ exitCode: 0 }),
    });

    expect(harness.nodes).toBe(harness.sessions.nodes);
    expect(harness.tasks.nodes).toBe(harness.nodes);
    // The command is a node under the main session's node: one tree, whichever registry started it.
    expect(harness.nodes.list().map((node) => node.kind)).toEqual(['agent', 'command']);
    expect(harness.nodes.list()[1]?.parent).toBe(harness.sessions.nodeIdOf(harness.mainSession.id));

    await harness.tasks.cancel(task.id);
  });

  it('runs the tools and hooks a UI picked, and reads no AGENTS.md or .sheavly/', async () => {
    const requests: ProviderRequest[] = [];
    const seen: string[] = [];
    const note = defineHook({
      name: 'note',
      sessionStart: async () => {
        seen.push('start');
      },
    });
    const harness = createHarness({
      provider: provider(),
      title: 'parse it',
      onModelCall: (request) => requests.push(request),
    });

    const messages = await runAgent({
      provider: harness.provider,
      tools: [extract, ...createTaskTools(harness.tasks)],
      hooks: [note],
      messages: [{ role: 'user', content: 'parse it' }],
      tasks: harness.tasks,
      session: { registry: harness.sessions, ref: harness.mainSession },
    });

    expect(messages[2]).toMatchObject({ role: 'tool', toolCallId: 'c1', content: '42.50' });
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: '42.50' });
    expect(seen).toEqual(['start']);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.instructions === undefined)).toBe(true);
    expect(JSON.stringify(requests)).not.toContain('AGENTS NOTE');
  });

  it('keeps the provider’s context window, live, when it taps every model call', () => {
    const taps: ProviderRequest[] = [];
    const size = { tokens: 300_000 };
    const live = {
      ...provider(),
      get contextWindow() {
        return size.tokens;
      },
    };
    const tapped = createHarness({
      provider: live,
      title: 'parse it',
      onModelCall: (request) => taps.push(request),
    });

    expect(tapped.provider.contextWindow).toBe(300_000);
    size.tokens = 1_000_000;
    expect(tapped.provider.contextWindow).toBe(1_000_000);
  });

  it('uses the registries passed in', () => {
    const tasks = new TaskRegistry();

    expect(createHarness({ provider: provider(), title: 'parse it', tasks }).tasks).toBe(tasks);
  });

  it('puts every approval in the combined stream, between the events of the call that asked', async () => {
    const ask = defineTool({
      name: 'ask',
      description: 'Asks the user before it runs',
      inputSchema: z.object({}),
      execute: async ({ context, signal }) => {
        const response = await harness.approvals.request({
          callId: context.callId,
          sessionId: context.session?.id,
          tool: 'ask',
          command: 'rm -rf build',
          concerns: [],
          signal,
        });

        return response.decision;
      },
    });
    const harness = createHarness({
      provider: routedProvider({
        'do it': [calls(toolCall({ id: 'c1', name: 'ask', input: {} })), say('done')],
      }),
      title: 'do it',
    });
    const kinds: string[] = [];

    harness.sessions.subscribeEntries((entry) =>
      kinds.push(entry.kind === 'event' ? entry.event.type : `${entry.kind}:${entry.update.type}`),
    );
    approveEverything(harness.approvals);
    await runAgent({
      provider: harness.provider,
      tools: [ask],
      messages: [{ role: 'user', content: 'do it' }],
      tasks: harness.tasks,
      session: { registry: harness.sessions, ref: harness.mainSession },
    });

    const started = kinds.indexOf('tool_call_started');
    const requested = kinds.indexOf('approval:approval_requested');
    const resolved = kinds.indexOf('approval:approval_resolved');

    expect(started).toBeGreaterThan(-1);
    expect(requested).toBeGreaterThan(started);
    expect(resolved).toBeGreaterThan(requested);
    expect(kinds.indexOf('tool_result')).toBeGreaterThan(resolved);
  });
});
