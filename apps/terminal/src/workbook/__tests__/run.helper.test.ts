import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { fakeServer } from '@sheavly/client/testing/fake-server.fake';
import {
  approvalRequestSchema,
  approvalResponseSchema,
} from '@sheavly/protocol/approval/approval.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { connectBackend } from '../../client/backend.helper.js';
import { liveFeed, promptStarted } from '../../testing/live-feed.fake.js';
import { startedAnswer } from '../../chat/testing/prompt-answers.fake.js';
import { endsOnAbort } from '../../testing/remote-conversation.fake.js';
import {
  FAKE_CONVERSATION,
  FAKE_MAIN_SESSION,
  fakeConversationDetails,
  fakeRunRequest,
  useWorkbookRunEnvironment,
} from '../../testing/workbook-run.fake.js';
import { runWorkbook } from '../run.helper.js';
import { WorkbookStore } from '../store.service.js';

vi.mock('../../client/backend.helper.js', () => ({ connectBackend: vi.fn() }));
// Metadata is the only Git caller in a named run; never invoke real Git in these tests.
vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => '') }));

const id = FAKE_CONVERSATION;
const main = FAKE_MAIN_SESSION;
const request = fakeRunRequest('Check the fixture');
const environment = useWorkbookRunEnvironment();

async function setup(
  params: {
    mismatch?: boolean;
    command?: string;
    failMessages?: boolean;
    failStream?: boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'workbook-run-'));

  environment.keep(root);

  const store = new WorkbookStore(path.join(root, 'workbook'));
  const generatedWorkspace = store.runWorkspaceDir(request.name);
  const permissionFile = path.join(root, 'fake-home', 'permissions.json');
  const permissionBefore = '{"mode":"ask","allow":[]}\n';

  await mkdir(path.dirname(permissionFile), { recursive: true });
  await writeFile(permissionFile, permissionBefore);

  const promptSent = Promise.withResolvers<undefined>();
  const feed = liveFeed();
  const answered = Promise.withResolvers<undefined>();
  const streamEnded = Promise.withResolvers<undefined>();
  // The live feed ends with its own request, as on a real backend, not with the approvals stream.
  const liveEnded = Promise.withResolvers<undefined>();
  const responses: string[] = [];
  const sessionGrants = new Set<string>();
  let nodeExecutions = 0;
  let closed = 0;
  const server = fakeServer({
    startConversation: () => ({ id }),
    getConversation: () => fakeConversationDetails(params.mismatch ? root : generatedWorkspace),
    async *streamConversation({ body }) {
      if ((body as { approvals?: boolean }).approvals) {
        await promptSent.promise;
        yield {
          seq: 0,
          at: 0,
          sessionId: main,
          kind: 'approval',
          update: {
            type: 'approval_requested',
            request: approvalRequestSchema.parse({
              id: 'approval',
              callId: 'call',
              tool: 'run_command',
              command: params.command ?? 'node check.mjs',
              concerns: [
                { argument: params.command ?? 'node check.mjs', reason: 'is not allowed yet' },
              ],
              options: ['approve', 'allow_session', 'always_allow', 'skip'],
              keeps: ['node *'],
            }),
          },
        } satisfies StreamEntry;

        if (params.failStream) {
          await answered.promise;
          throw new Error('fake stream failure');
        }
      }

      if ((body as { approvals?: boolean }).approvals) {
        await streamEnded.promise;

        return;
      }

      // The saved raw stream gets nothing here; the live followers get every run.
      if ((body as { replay?: boolean }).replay) await liveEnded.promise;
      else yield* feed.follow();
    },
    async answerApproval({ body }) {
      const response = approvalResponseSchema.parse((body as { response: unknown }).response);

      responses.push(response.decision);
      if (response.decision === 'always_allow') await writeFile(permissionFile, 'persistent grant');
      if (response.decision === 'allow_session') sessionGrants.add('node');
      answered.resolve(undefined);
    },
    sendPrompt: ({ body }) => {
      feed.publish(promptStarted({ seq: 0, text: (body as { text: string }).text }));
      promptSent.resolve(undefined);

      void (async () => {
        await answered.promise;
        if (params.failStream) await streamEnded.promise;
        // The fake models the existing conversation-wide grant, shared with children, not a new store.
        if (sessionGrants.has('node')) nodeExecutions += 3;
        feed.publish({
          seq: 1,
          at: 0,
          sessionId: main,
          kind: 'event',
          event: {
            seq: 1,
            type: 'done',
            reason: 'completed',
            session: { id: main, rootId: main, depth: 1 },
          },
        });
      })();

      return startedAnswer();
    },
    getMessages: () =>
      params.failMessages
        ? { refuse: { status: 500, code: 'internal', message: 'messages failed' } }
        : { messages: [] },
    closeConversation: () => {
      closed++;
      streamEnded.resolve(undefined);
      liveEnded.resolve(undefined);
    },
    stopPrompt: () => undefined,
  });
  const stop = vi.fn(async () => undefined);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    // Streams end independently on a real backend: aborting the live feed must not end the
    // approvals stream, nor the other way round.
    const watchesApprovals = typeof init?.body === 'string' && init.body.includes('"approvals"');
    const ended = watchesApprovals ? streamEnded : liveEnded;

    init?.signal?.addEventListener('abort', () => ended.resolve(undefined), { once: true });

    return endsOnAbort({ response: await server.fetch(input, init), signal: init?.signal });
  };

  vi.mocked(connectBackend).mockResolvedValue({
    url: 'http://fake.test',
    token: 'fake',
    fetch,
    // A dropped stream is lost at once, so a failing fake stream fails the run without waiting.
    reconnect: { attempts: 0 },
    stop,
  });

  return {
    store,
    permissionFile,
    permissionBefore,
    responses,
    server,
    stop,
    closed: () => closed,
    nodeExecutions: () => nodeExecutions,
    sessionGrants,
  };
}

describe('check workbook run on fake backend', () => {
  it('answers through the typed API, reuses one session grant and never persists it', async () => {
    const fake = await setup();
    const result = await runWorkbook({
      store: fake.store,
      request,
      checkContext: { approvedCommands: ['node'] },
    });
    const meta = await fake.store.meta(result.id);

    expect(result.outcome).toBe('completed');
    expect(fake.responses).toEqual(['allow_session']);
    expect(fake.nodeExecutions()).toBe(3);
    expect(meta).toMatchObject({
      approvedCommands: ['node'],
      approvalScope: 'conversation-session',
      workspace: fake.store.runWorkspaceDir('fixture'),
      mainSession: 'main',
    });
    expect(await readFile(fake.permissionFile, 'utf8')).toBe(fake.permissionBefore);
    expect(fake.closed()).toBe(1);
    expect(fake.stop).toHaveBeenCalledOnce();
    const watcherIndex = fake.server.calls.findIndex(
      ({ name, call }) =>
        name === 'streamConversation' && (call.body as { approvals?: boolean }).approvals,
    );
    const promptIndex = fake.server.calls.findIndex(({ name }) => name === 'sendPrompt');

    expect(watcherIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeGreaterThan(watcherIndex);
  });

  it('a new attempt starts without the previous session grant', async () => {
    const first = await setup();

    await runWorkbook({
      store: first.store,
      request,
      checkContext: { approvedCommands: ['node'] },
    });

    const second = await setup();

    await runWorkbook({ store: second.store, request, checkContext: { approvedCommands: [] } });
    expect(second.responses).toEqual(['skip']);
    expect(second.nodeExecutions()).toBe(0);
    expect(second.sessionGrants.size).toBe(0);
    expect(await readFile(second.permissionFile, 'utf8')).toBe(second.permissionBefore);
  });

  it('denies mixed commands with no extra UI wait', async () => {
    const fake = await setup({ command: 'node check.mjs && find .' });

    await runWorkbook({ store: fake.store, request, checkContext: { approvedCommands: ['node'] } });
    expect(fake.responses).toEqual(['skip']);
    expect(fake.nodeExecutions()).toBe(0);
  });

  it('rejects the actual fixture mismatch before prompting or answering and closes everything', async () => {
    const fake = await setup({ mismatch: true });

    await expect(
      runWorkbook({ store: fake.store, request, checkContext: { approvedCommands: ['node'] } }),
    ).rejects.toThrow(/does not match/);
    expect(fake.server.calls.map(({ name }) => name)).toEqual([
      'startConversation',
      'getConversation',
      'closeConversation',
    ]);
    expect(fake.closed()).toBe(1);
    expect(fake.stop).toHaveBeenCalledOnce();
  });

  it('fails before any backend connection if BACKEND_URL selects an existing backend', async () => {
    const fake = await setup();

    vi.stubEnv('BACKEND_URL', 'http://existing.test');
    await expect(
      runWorkbook({ store: fake.store, request, checkContext: { approvedCommands: [] } }),
    ).rejects.toThrow(/own backend/);
    expect(connectBackend).not.toHaveBeenCalled();
    expect(fake.server.calls).toEqual([]);
    expect((await fake.store.state()).runCount).toBe(0);
  });

  it('saves the stream failure cause without allowing late prompt events to report success', async () => {
    const fake = await setup({ failStream: true });
    const result = await runWorkbook({
      store: fake.store,
      request,
      checkContext: { approvedCommands: ['node'] },
    });

    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('fake stream failure');
    expect((await fake.store.result(result.id))?.outcome).toBe('failed');
    expect(fake.closed()).toBe(1);
    expect(fake.stop).toHaveBeenCalledOnce();
  });

  it('closes the conversation/backend when final message retrieval fails', async () => {
    const fake = await setup({ failMessages: true });

    await expect(
      runWorkbook({ store: fake.store, request, checkContext: { approvedCommands: ['node'] } }),
    ).rejects.toThrow(/messages failed/);
    expect(fake.closed()).toBe(1);
    expect(fake.stop).toHaveBeenCalledOnce();
  });
});
