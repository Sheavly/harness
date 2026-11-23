import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { promptEntries } from '@sheavly/client/prompt/prompt.helper';
import { modelIdSchema } from '@sheavly/protocol/model/model.validator';
import { fakeFetchSequence } from '@sheavly/testing/fetch/fake-fetch.fake';
import { useTempWorkspace } from '@sheavly/workspace/testing/temp-workspace.fake';
import { setUpProfile } from '../../profiles/testing/profiles.fake.js';
import { testBackend } from '../../testing/backend.fake.js';
import { untilSettled } from '../../testing/settled.fake.js';

const temp = useTempWorkspace({ prefix: 'served-tool-definitions-', perTest: true });
const modelId = modelIdSchema.parse('00000000-0000-4000-8000-000000000237');
const sharedNames = [
  'read_file',
  'glob',
  'grep',
  'write_file',
  'edit_file',
  'delete_file',
  'set_working_root',
  'read_skill',
  'web_fetch',
  'web_search',
  'run_command',
  'start_service',
  'read_output',
  'search_output',
  'task_status',
  'cancel_task',
  'await_tasks',
];
const protocols = [
  { adapter: 'openai', definition: { model: 'test' } },
  {
    adapter: 'azure-anthropic',
    definition: {
      deployment: 'test',
      baseUrl: 'https://model.test/anthropic',
      thinkingMode: 'disabled',
    },
  },
  {
    adapter: 'azure-chat',
    definition: { deployment: 'test', baseUrl: 'https://model.test/models' },
  },
];

type Action = { id: string; name: string; input: Record<string, unknown> };
const nesting: Record<string, Action> = {
  main: { id: 'start-child', name: 'start_agent', input: { title: 'Child', task: 'child' } },
  child: { id: 'start-leaf', name: 'start_agent', input: { title: 'Leaf', task: 'leaf' } },
};

function responsesReply(action?: Action): object[] {
  if (!action) return [{ type: 'response.output_text.delta', delta: 'finished' }];

  return [
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: action.id,
        name: action.name,
        arguments: JSON.stringify({ description: 'Start helper', ...action.input }),
      },
    },
  ];
}

function messagesReply(action?: Action): object[] {
  if (!action) {
    return [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'finished' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];
  }

  return [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: action.id, name: action.name, input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify({ description: 'Start helper', ...action.input }),
      },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
}

function chatReply(action?: Action): object[] {
  const delta = action
    ? {
        tool_calls: [
          {
            index: 0,
            id: action.id,
            type: 'function',
            function: {
              name: action.name,
              arguments: JSON.stringify({ description: 'Start helper', ...action.input }),
            },
          },
        ],
      }
    : { content: 'finished' };

  return [{ choices: [{ index: 0, delta, finish_reason: action ? 'tool_calls' : 'stop' }] }];
}

const messageSchema = z.looseObject({
  role: z.string().optional(),
  content: z
    .union([z.string(), z.array(z.looseObject({ text: z.string().optional() }))])
    .optional(),
});

function taskIn(body: Record<string, unknown>): string {
  const messages = z.array(messageSchema).parse(body.input ?? body.messages);
  const content = messages.find((message) => message.role === 'user')?.content;

  const text = typeof content === 'string' ? content : (content?.[0]?.text ?? '');

  // Messages combines adjacent user context into the first user turn. The script is its
  // leading text, not the appended telemetry or workspace instructions.
  return (
    ['main', 'child', 'leaf'].find((task) => text === task || text.startsWith(`${task}\n`)) ?? text
  );
}

/** Captures the adapter's serialized requests, not the pre-serialization provider callback. */
function nestedModel(adapter: string) {
  const requests: { task: string; body: Record<string, unknown> }[] = [];
  const started = new Set<string>();
  const reply = {
    openai: responsesReply,
    'azure-anthropic': messagesReply,
    'azure-chat': chatReply,
  }[adapter];

  if (!reply) throw new Error(`Unsupported test adapter ${adapter}`);

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(await new Request(input, init).text()) as Record<string, unknown>;
    const task = taskIn(body);
    const action = started.has(task) ? undefined : nesting[task];

    requests.push({ task, body });
    started.add(task);

    return fakeFetchSequence({ responses: [reply(action)], complete: adapter === 'openai' }).fetch(
      input,
      init,
    );
  };

  return { fetch, requests };
}

const parameterSchema = z.looseObject({ description: z.string().min(1) });
const schemaSchema = z.looseObject({
  type: z.literal('object'),
  properties: z.record(z.string(), parameterSchema),
  required: z.array(z.string()).min(1),
});
const definitionSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: schemaSchema,
});

function definitions(body: Record<string, unknown>, adapter: string) {
  const raw = z.array(z.record(z.string(), z.unknown())).parse(body.tools);

  return raw.map((tool) => {
    if (adapter === 'azure-chat') return definitionSchema.parse(tool.function);

    if (adapter === 'azure-anthropic') {
      return definitionSchema.parse({ ...tool, parameters: tool.input_schema });
    }

    return definitionSchema.parse(tool);
  });
}

function checkDefinitions(params: {
  body: Record<string, unknown>;
  adapter: string;
  depth: number;
  webSearch: boolean;
  webFetch: boolean;
}) {
  const { body, adapter, depth, webSearch, webFetch } = params;
  const tools = definitions(body, adapter);
  const names = tools.map((tool) => tool.name);
  const expected = sharedNames.filter(
    (name) => (webSearch || name !== 'web_search') && (webFetch || name !== 'web_fetch'),
  );

  // Only the main run searches the conversation's history; sub-agents get no history tools.
  if (depth === 1) expected.push('search_history', 'read_history_entry');
  if (depth > 1) expected.push('report_status');
  if (depth < 3) expected.push('start_agent', 'message_agent');

  expect(names.toSorted()).toEqual(expected.toSorted());
  expect(new Set(names).size).toBe(names.length);

  for (const tool of tools) {
    expect(() => z.fromJSONSchema(tool.parameters), tool.name).not.toThrow();
    expect(tool.parameters.required).toContain('description');
    expect(tool.parameters.required.every((name) => name in tool.parameters.properties)).toBe(true);
    expect(new Set(tool.parameters.required).size).toBe(tool.parameters.required.length);
  }

  const awaitTasks = tools.find((tool) => tool.name === 'await_tasks');

  expect(awaitTasks?.parameters.required).toEqual(
    expect.arrayContaining(['ids', 'reason', 'description']),
  );
  expect(awaitTasks?.parameters.properties.ids).toMatchObject({
    type: 'array',
    items: { type: 'string' },
    minItems: 1,
  });
  expect(awaitTasks?.parameters.properties.reason).toMatchObject({ type: 'string', minLength: 1 });
  expect(tools.find((tool) => tool.name === 'delete_file')?.parameters.required).toContain('path');
  expect(tools.find((tool) => tool.name === 'glob')?.parameters.required).toContain('pattern');
  expect(tools.find((tool) => tool.name === 'grep')?.parameters.required).toContain('pattern');
}

describe.each(protocols)('served $adapter tool definitions', ({ adapter, definition }) => {
  it.each([
    { webFetch: true, webSearch: true },
    { webFetch: false, webSearch: true },
    { webFetch: true, webSearch: false },
    { webFetch: false, webSearch: false },
  ])(
    'serializes every depth (web_fetch $webFetch, web_search $webSearch)',
    async ({ webFetch, webSearch }) => {
      const home = path.join(temp.base, 'home');
      const model = nestedModel(adapter);

      await setUpProfile({ home, models: [{ id: modelId, name: 'Test', adapter, definition }] });

      const backend = testBackend({
        home,
        workspace: temp.root,
        fetch: model.fetch,
        env: { WEB_SEARCH: String(webSearch), WEB_FETCH: String(webFetch) },
      });

      try {
        const { id } = await backend.client.call('startConversation', { body: {} });
        const entries = [];

        for await (const entry of promptEntries({
          client: backend.client,
          id,
          prompt: { text: 'main' },
        })) {
          entries.push(entry);
        }

        // The prompt ends when the main model finishes; the sub-agents it started run on.
        await untilSettled(backend.conversations.get(id));

        expect(JSON.stringify(entries)).not.toContain('run_failed');

        for (const [index, task] of ['main', 'child', 'leaf'].entries()) {
          const calls = model.requests.filter((request) => request.task === task);

          expect(calls.length, `${task} must actually make a model call`).toBeGreaterThan(0);

          for (const call of calls) {
            checkDefinitions({ body: call.body, adapter, depth: index + 1, webSearch, webFetch });
          }
        }
      } finally {
        await backend.conversations.closeAll();
      }
    },
  );
});
