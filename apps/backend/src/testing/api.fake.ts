import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StreamEvent } from '@sheavly/core/message/message.types';
import { defineTool } from '@sheavly/core/tool/tool.utils';
import type { ConversationStore } from '@sheavly/core/store/store.types';
import { createConversation } from '@sheavly/host/conversation/conversation.helper';
import { Conversations } from '@sheavly/host/conversations/conversations.service';
import { createHarness } from '@sheavly/host/host/host.helper';
import { reviewSkill } from '@sheavly/host/testing/skills.fake';
import { twoModelRun } from '@sheavly/host/testing/run.fake';
import { streamAgent } from '@sheavly/loop/stream-agent/stream-agent.helper';
import { blockTool } from '@sheavly/runtime/testing/block-tool.fake';
import { routedProvider } from '@sheavly/testing/provider/routed-provider.fake';
import type { Script } from '@sheavly/testing/provider/provider.types';
import { z } from 'zod';
import { readEntries } from '@sheavly/client/client/entries.helper';
import { runEnd } from '@sheavly/protocol/status/run-end.utils';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { createDefaultRegistry } from '@sheavly/providers/registry/default-registry.helper';
import { createApiApp } from '../api/api.helper.js';
import { parseRequestEnv } from '../harness/settings.validator.js';
import { LOG_EVENT } from '../logging/logging.constants.js';
import type { BackendLogs } from '../logging/logging.types.js';
import { silentLogs } from './logs.fake.js';
import { permissionStoreFor } from '../profiles/home.helper.js';
import { PermissionSetup } from '../profiles/permission-setup.service.js';
import { Profiles } from '../profiles/profiles.service.js';
import type { ProfileSetup } from '../profiles/setup.service.js';
import type { WorkspaceSetup } from '../profiles/workspace-setup.service.js';
import { memoryTrust } from '@sheavly/coding/testing/trust.fake';
import { TrustStore } from '@sheavly/coding/trust/trust.service';
import { TEST_INSTANCE_ID } from './identity.fake.js';
import { TEST_SERVER_VERSION, TEST_TOKEN } from './testing.constants.js';
import type { TestRequest } from './testing.types.js';

/** Test-only: a turn that answers with `text`. */
export const reply =
  (text: string): Script =>
  () =>
    [
      { type: 'text_delta', text },
      { type: 'done', stopReason: 'end_turn' },
    ] satisfies StreamEvent[];

/** Test-only: a tool that asks for approval before it runs, like run_command's risky arguments. */
function askingTool(approvals: ReturnType<typeof createHarness>['approvals']) {
  return defineTool({
    name: 'ask',
    description: 'Asks the user first',
    inputSchema: z.object({}),
    execute: async ({ context, signal }) =>
      (
        await approvals.request({
          callId: context.callId,
          sessionId: context.session?.id,
          tool: 'ask',
          command: 'rm -rf build',
          concerns: [],
          signal,
        })
      ).decision,
  });
}

/**
 * Test-only: the setup a test's API serves over `home`, a folder its test made and removes. Keys
 * and trust are accepted unless `remoteSetupAllowed` is false; `fetch` stands in for the network a
 * key check makes.
 */
export function testSetup(params: {
  home: string;
  remoteSetupAllowed?: boolean;
  fetch?: typeof globalThis.fetch;
}): ProfileSetup {
  const { home, remoteSetupAllowed = true, fetch } = params;
  const profiles = new Profiles({
    env: { SHEAVLY_HOME: home },
    ...(fetch && { adapters: createDefaultRegistry({ fetch }) }),
  });

  return profiles.setup({ request: parseRequestEnv({}), remoteSetupAllowed });
}

/**
 * Test-only: the folder routes a test's API serves, over `home` and with an in-memory trust store
 * (so no file is written). Trust is granted unless `remoteSetupAllowed` is false.
 */
function testWorkspaces(params: {
  home: string;
  remoteSetupAllowed?: boolean;
  trust?: TrustStore;
}): WorkspaceSetup {
  const { home, remoteSetupAllowed = true } = params;
  const trust =
    params.trust ??
    new TrustStore({ persistence: memoryTrust({ file: path.join(home, 'trust.json') }) });

  return new Profiles({ env: { SHEAVLY_HOME: home } }).workspaces({ trust, remoteSetupAllowed });
}

/**
 * Test-only: the backend's API on conversations of a scripted model, each prompt's first user
 * message picking its script (`routedProvider`), with a blocking and an asking tool. `request`
 * calls it in-process with the token, as a client would. With a `store`, the conversations are
 * kept in it, wired as the backend wires them. `setup` is what the setup routes serve; the
 * default, like the folder and permission routes, is over a folder that is never written, for a
 * test that doesn't use them.
 */
export function testApi(
  scripts: Record<string, Script[]>,
  store?: ConversationStore,
  setup: ProfileSetup = testSetup({ home: path.join(tmpdir(), `sheavly-unused-${randomUUID()}`) }),
  logs: BackendLogs = silentLogs(),
) {
  const unused = path.join(tmpdir(), `sheavly-unused-${randomUUID()}`);
  const workspaces = testWorkspaces({ home: unused });
  const permissions = new PermissionSetup({
    store: permissionStoreFor({ SHEAVLY_HOME: unused }),
    home: unused,
    env: process.env,
    remoteSetupAllowed: true,
  });
  const conversations = new Conversations({
    ...(store && { store }),
    onPromptFailure: ({ id, error }) =>
      logs.conversation(id).error(LOG_EVENT.PROMPT_FAILED, { error }),
    create: async ({ messages, storage }) => {
      const harness = createHarness({
        provider: routedProvider(scripts),
        title: 'Chat',
        ...(storage && { entries: storage.entries, resume: storage.resume }),
      });

      return {
        harness,
        conversation: createConversation({
          harness,
          run: streamAgent,
          tools: [blockTool, askingTool(harness.approvals)],
          messages: messages ?? [],
          ...(storage && {
            keepHistory: storage.keepHistory,
            resumed: storage.resume !== undefined,
          }),
        }),
        skills: reviewSkill,
        run: twoModelRun(),
      };
    },
  });
  const app = createApiApp({
    conversations,
    setup,
    workspaces,
    permissions,
    token: TEST_TOKEN,
    instanceId: TEST_INSTANCE_ID,
    serverVersion: TEST_SERVER_VERSION,
    logs,
  });
  const request = async (path: string, init: TestRequest = {}) =>
    app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });

  return {
    app,
    conversations,
    request,
    start: () => startConversation(request),
    runOf: (params: { id: string; text: string }) => runOf({ request, ...params }),
  };
}

/**
 * Test-only: sends `text` to conversation `id` through the API, as a client does, and yields the
 * frames of its run from the conversation's stream, opened before the send: from its
 * `prompt_started` to the main session's `done`. The send is answered at once; a refusal throws.
 */
async function* runOf(params: {
  request: (path: string, init?: TestRequest) => Promise<Response>;
  id: string;
  text: string;
}): AsyncGenerator<{ cursor: string; entry: StreamEntry }> {
  const { request, id, text } = params;
  const stream = await request(`/conversations/${id}/stream`, { method: 'QUERY', body: {} });
  const sent = await request(`/conversations/${id}/prompts`, { method: 'POST', body: { text } });

  if (!sent.ok) {
    await stream.body?.cancel();
    throw new Error(`sending failed: ${String(sent.status)} ${await sent.text()}`);
  }

  let started = false;

  try {
    for await (const frame of readEntries(stream.body)) {
      const { entry } = frame;

      started ||=
        entry.kind === 'queue' &&
        entry.update.type === 'prompt_started' &&
        entry.update.text === text;
      if (!started) continue;
      yield frame;
      if (runEnd(entry) !== undefined) return;
    }
  } finally {
    await stream.body?.cancel();
  }
}

/** Test-only: starts a conversation through the API, as a client does, and returns its id. */
async function startConversation(request: (path: string, init?: TestRequest) => Promise<Response>) {
  const response = await request('/conversations', { method: 'POST', body: {} });

  if (response.status !== 201) throw new Error(`starting failed: ${String(response.status)}`);

  return ((await response.json()) as { id: string }).id;
}
